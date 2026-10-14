// ============================================================
//  /api/sync-encuestas.js
//  Vercel Serverless Function (Node.js) — VERSIÓN SIMPLE (un solo tiro)
//
//  Flujo (igual que cuando funcionaba):
//   1) GET  /authenticate          -> token JWT (dura 1h)
//   2) POST /analytics/export/{id} -> inicia la exportación del reporte
//   3) GET  /analytics/export/{id}/status -> espera a que termine
//   4) descarga report_url (ZIP->CSV o JSON) con las encuestas
//   5) parsea, detecta columnas, y hace upsert en Supabase (por wise_id)
//
//  Se dispara por el Vercel Cron (ver vercel.json) o manualmente con ?key=SECRETO.
//  Rango por defecto: últimos 7 días (se puede pasar ?date_from=&date_to=).
// ============================================================

const crypto = require("crypto");
const WISE_BASE = "https://api.wcx.cloud/core/v1";
const REPORT_ID = process.env.WISE_REPORT_ID || "240327"; // reporte "Respuestas de Encuestas"

export const config = { maxDuration: 60 };

// --- helpers -------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wiseHeaders(token) {
  const h = {
    "x-api-key": process.env.WISE_API_KEY,
    "Content-Type": "application/json",
  };
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}

// 1) Autenticación -> token JWT
async function autenticar() {
  const url = `${WISE_BASE}/authenticate?user=${encodeURIComponent(process.env.WISE_USER)}`;
  const res = await fetch(url, { method: "GET", headers: wiseHeaders(null) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`authenticate falló (${res.status}): ${txt}`);
  let data = {};
  try { data = JSON.parse(txt); } catch { /* texto plano */ }
  const token = data.token || data.jwt || data.access_token || data.accessToken || txt.trim();
  if (!token) throw new Error("No se recibió token en /authenticate: " + txt);
  return token;
}

// 2) Inicia la exportación del reporte -> export_id
async function iniciarExport(token, dateFrom, dateTo) {
  const body = { columns: "all" };
  if (dateFrom && dateTo) body.filter = { date_from: dateFrom, date_to: dateTo };

  const res = await fetch(`${WISE_BASE}/analytics/export/${REPORT_ID}`, {
    method: "POST",
    headers: wiseHeaders(token),
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`export falló (${res.status}): ${txt}`);

  let data;
  try { data = JSON.parse(txt); }
  catch (e) { throw new Error(`Wise respondió algo inesperado (no es JSON): ${txt.slice(0, 300)}`); }
  const exportId = data.export_id || data.id || data.exportId;
  if (!exportId) throw new Error("No se recibió export_id: " + txt);
  return { exportId, raw: txt };
}

// Consulta UNA vez el estado del export.
async function chequearEstado(token, exportId) {
  const res = await fetch(`${WISE_BASE}/analytics/export/${exportId}/status`,
    { method: "GET", headers: wiseHeaders(token) });
  const txt = await res.text();
  if (!res.ok) {
    if (txt.includes("EXPORT_NOT_FOUND")) return { listo: false, notFound: true, estado: "not_found" };
    throw new Error(`status falló (${res.status}): ${txt}`);
  }
  const data = JSON.parse(txt);
  const estado = String(data.status || "").toLowerCase();
  const url = data.report_url || data.url || data.download_url;
  if (["failed", "error", "cancelled", "canceled", "expired"].includes(estado)) {
    return { listo: false, fallo: true, estado, raw: txt };
  }
  if (url || ["done", "completed", "finished", "success", "ok", "ready", "available"].includes(estado)) {
    return { listo: true, estado, url };
  }
  return { listo: false, estado: estado || "processing" };
}

// 3) Espera hasta que termine -> report_url (dentro del límite de 60s de Vercel)
async function esperarReporte(token, exportId) {
  const MAX_INTENTOS = 16;
  const ESPERA_MS = 3000;
  await sleep(3000); // Wise tarda unos segundos en registrar el export
  for (let i = 0; i < MAX_INTENTOS; i++) {
    const est = await chequearEstado(token, exportId);
    if (est.fallo) throw new Error("La exportación falló en Wise: " + (est.raw || est.estado));
    if (est.listo) {
      if (!est.url) throw new Error("Reporte terminado pero sin report_url.");
      return est.url;
    }
    await sleep(ESPERA_MS);
  }
  throw new Error("Timeout esperando la exportación de Wise.");
}

// 4) Descarga el archivo (ZIP->CSV o JSON) y lo convierte a filas.
async function descargarFilas(reportUrl) {
  const res = await fetch(reportUrl);
  if (!res.ok) throw new Error(`descarga falló (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const esZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  let texto = esZip ? extraerCSVdeZip(buf) : buf.toString("utf8");
  const t = texto.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j.rows)) return j.rows;
    return [];
  }
  return parseCSV(t);
}

function extraerCSVdeZip(buf) {
  const zlib = require("zlib");
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const metodo = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nombre = buf.toString("utf8", offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    const comprimido = buf.subarray(dataStart, dataEnd);
    let contenido;
    if (metodo === 0) contenido = comprimido;
    else if (metodo === 8) contenido = zlib.inflateRawSync(comprimido);
    else { offset = dataEnd; continue; }
    if (nombre.toLowerCase().endsWith(".csv") || !nombre.includes("/")) {
      return contenido.toString("utf8");
    }
    offset = dataEnd;
  }
  throw new Error("No se pudo extraer el CSV del ZIP de Wise.");
}

function parseCSV(texto) {
  const lineas = texto.split(/\r?\n/).filter((l) => l.length > 0);
  if (lineas.length === 0) return [];
  const parseLinea = (linea) => {
    const out = []; let cur = ""; let dentroComillas = false;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (c === '"') {
        if (dentroComillas && linea[i + 1] === '"') { cur += '"'; i++; }
        else dentroComillas = !dentroComillas;
      } else if ((c === "," || c === ";") && !dentroComillas) { out.push(cur); cur = ""; }
      else { cur += c; }
    }
    out.push(cur);
    return out;
  };
  const headers = parseLinea(lineas[0]).map((h) => h.trim());
  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    const celdas = parseLinea(lineas[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (celdas[idx] ?? "").trim(); });
    filas.push(obj);
  }
  return filas;
}

// ------------------------------------------------------------
//  Detección automática de campos (a prueba de renombres)
// ------------------------------------------------------------
function buscarClave(obj, terminos) {
  const claves = Object.keys(obj);
  for (const t of terminos) {
    const found = claves.find((k) =>
      k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(t));
    if (found) return found;
  }
  return null;
}
function claveConPalabras(obj, palabras) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return Object.keys(obj).find((k) => {
    const nk = norm(k);
    return palabras.every((p) => nk.includes(norm(p)));
  }) || null;
}
function aNota(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "" || /^s\/?d$/i.test(s)) return null;
  const n = Number(s);
  return (!isNaN(n) && n >= 0 && n <= 10) ? n : null;
}
function notaPorPalabras(fila, palabras) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [k, v] of Object.entries(fila)) {
    const nk = norm(k);
    if (palabras.every((p) => nk.includes(norm(p)))) return aNota(v);
  }
  return null;
}
function extraerPreguntas(fila) {
  return {
    p_amabilidad:  notaPorPalabras(fila, ["amabilidad"]),
    p_atencion:    notaPorPalabras(fila, ["atencion", "solicitudes"]),
    p_puntualidad: notaPorPalabras(fila, ["puntualidad"]),
    p_explicacion: notaPorPalabras(fila, ["explicacion"]),
    p_limpieza:    notaPorPalabras(fila, ["limpieza"]),
    p_turnos:      notaPorPalabras(fila, ["facilidad", "turnos"]),
    p_espera:      notaPorPalabras(fila, ["tiempo", "espera"]),
    p_calidad:     notaPorPalabras(fila, ["calidad", "servicio", "prestado"]),
    p_recomienda:  notaPorPalabras(fila, ["recomiende"]),
  };
}
function extraerComentario(fila) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [k, v] of Object.entries(fila)) {
    const nk = norm(k);
    if ((nk.includes("sugerencias") || nk.includes("comentario")) && String(v).trim() && String(v).trim() !== "S/D") {
      return String(v).trim();
    }
  }
  return null;
}
function extraerFunciono(fila) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [k, v] of Object.entries(fila)) {
    if (norm(k).includes("funcionando correctamente")) {
      const s = String(v).trim();
      return s || null;
    }
  }
  return null;
}

// convierte una fila cruda de Wise en el registro de Supabase
function mapearFila(fila) {
  const kAsesor   = buscarClave(fila, ["agente", "asesor", "usuario", "user"]);
  const kSucursal = buscarClave(fila, ["sucursal", "branch"]);
  const kServicio = buscarClave(fila, ["servicio", "service"]);
  const kDominio  = buscarClave(fila, ["dominio", "patente", "domain"]);
  const kEmpresa  = buscarClave(fila, ["empresa", "telefono", "phone", "cliente", "nombre"]);
  const kTelefono = claveConPalabras(fila, ["contacto", "telefono"]) || buscarClave(fila, ["telefono", "phone", "celular"]);
  const _claves = Object.keys(fila);
  const _norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const kNroOrden =
    _claves.find(k => { const n = _norm(k); return n.includes("orden") && !n.includes("grupo") && (n.includes("n° orden") || n.includes("n orden") || n.includes("nro")); })
    || _claves.find(k => { const n = _norm(k); return n.includes("contacto") && n.includes("orden") && !n.includes("grupo"); })
    || null;
  const kEncuesta = buscarClave(fila, ["encuesta", "survey"]);

  const kFechaResp  = claveConPalabras(fila, ["fecha", "respuesta"]) || claveConPalabras(fila, ["response", "date"]);
  const kFechaEnvio = claveConPalabras(fila, ["fecha", "envio"]) || claveConPalabras(fila, ["survey", "sent"]) || claveConPalabras(fila, ["fecha", "creado"]);
  const kFecha = kFechaEnvio || buscarClave(fila, ["fecha", "date", "survey_sent", "created"]);

  const preguntas = extraerPreguntas(fila);
  const cincoDelAsesor = [
    preguntas.p_amabilidad, preguntas.p_atencion, preguntas.p_puntualidad,
    preguntas.p_explicacion, preguntas.p_limpieza,
  ].filter((n) => n != null);
  const promedioAsesor = cincoDelAsesor.length
    ? Math.round((cincoDelAsesor.reduce((a, b) => a + b, 0) / cincoDelAsesor.length) * 100) / 100
    : null;

  const ordenRaw = kNroOrden ? fila[kNroOrden] : null;
  const domRaw   = kDominio  ? fila[kDominio]  : null;
  const envioRaw = kFecha    ? fila[kFecha]    : null;
  const respRaw  = kFechaResp ? fila[kFechaResp] : null;
  const normId = (v) => String(v ?? "").trim().toLowerCase();

  let claveId;
  if (ordenRaw && String(ordenRaw).trim()) claveId = "ord|" + normId(ordenRaw);
  else claveId = "sin-orden|" + normId(domRaw) + "|" + normId(envioRaw) + "|" + normId(respRaw);
  const wiseId = "enc_" + crypto.createHash("md5").update(claveId).digest("hex");

  const parseFecha = (val) => {
    if (!val) return null;
    const d = new Date(String(val).replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d.toISOString();
  };

  return {
    wise_id: wiseId,
    fecha: parseFecha(kFecha && fila[kFecha]),
    fecha_respuesta: parseFecha(kFechaResp && fila[kFechaResp]),
    asesor: kAsesor ? fila[kAsesor] : null,
    ...preguntas,
    promedio_asesor: promedioAsesor,
    comentario: extraerComentario(fila),
    funciono_ok: extraerFunciono(fila),
    puntuacion_prom: promedioAsesor,
    puntuacion: promedioAsesor,
    sucursal: kSucursal ? fila[kSucursal] : null,
    servicio: kServicio ? fila[kServicio] : null,
    dominio: kDominio ? fila[kDominio] : null,
    telefono: kTelefono ? fila[kTelefono] : null,
    nro_orden: kNroOrden ? fila[kNroOrden] : null,
    empresa: kEmpresa ? fila[kEmpresa] : null,
    encuesta: kEncuesta ? fila[kEncuesta] : null,
    raw: fila,
    sincronizado_en: new Date().toISOString(),
  };
}

function limpiarNulos(valor) {
  if (typeof valor === "string") {
    return valor.replace(/\u0000/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  }
  if (Array.isArray(valor)) return valor.map(limpiarNulos);
  if (valor && typeof valor === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = limpiarNulos(v);
    return out;
  }
  return valor;
}

function esRespondida(registro) {
  const raw = registro.raw || {};
  for (const [k, v] of Object.entries(raw)) {
    const nk = k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (nk.includes("respondida") || nk.includes("responded") || nk === "is_responsed") {
      const s = String(v).trim().toLowerCase();
      return s === "si" || s === "sí" || s === "1" || s === "yes" || s === "true";
    }
  }
  if (registro.fecha_respuesta) return true;
  return registro.promedio_asesor != null;
}

// 5) Upsert a Supabase vía REST (merge por wise_id)
async function guardarEnSupabase(registros) {
  if (registros.length === 0) return { insertados: 0 };
  const ordenados = registros.slice().sort((a, b) => {
    const fa = a.fecha_respuesta || a.fecha || "";
    const fb = b.fecha_respuesta || b.fecha || "";
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  const porId = new Map();
  for (const r of ordenados) porId.set(r.wise_id, r);
  registros = Array.from(porId.values()).map(limpiarNulos);

  let payload = JSON.stringify(registros).replace(/\\u0000/g, "").replace(/\u0000/g, "");
  const url = `${process.env.SUPABASE_URL}/rest/v1/encuestas?on_conflict=wise_id`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: payload,
  });
  if (!res.ok) throw new Error(`Supabase upsert falló (${res.status}): ${await res.text()}`);
  return { insertados: registros.length };
}

// ------------------------------------------------------------
//  Handler principal — UN SOLO TIRO
// ------------------------------------------------------------
export default async function handler(req, res) {
  const esCron = req.headers["x-vercel-cron"] === "1";
  const keyOk = req.query.key && req.query.key === process.env.SYNC_SECRET;
  if (!esCron && !keyOk) return res.status(401).json({ ok: false, error: "No autorizado" });

  try {
    // Rango por fecha de ENVÍO (yyyy-MM-dd). Default: últimos 7 días.
    let dateFrom = req.query.date_from || null;
    let dateTo   = req.query.date_to   || null;
    if (!dateFrom || !dateTo) {
      const hoy = new Date();
      dateTo = hoy.toISOString().slice(0, 10);
      const hace7 = new Date(hoy);
      hace7.setDate(hace7.getDate() - 7);
      dateFrom = hace7.toISOString().slice(0, 10);
    }

    const token = await autenticar();
    const { exportId, raw: exportRaw } = await iniciarExport(token, dateFrom, dateTo);

    // ?debug=1 -> muestra qué devolvió el export, sin esperar
    if (req.query.debug === "1") {
      return res.status(200).json({
        ok: true, modo: "debug",
        rango_pedido: { date_from: dateFrom, date_to: dateTo },
        export_id_detectado: exportId,
        respuesta_cruda_del_export: exportRaw,
      });
    }

    const reportUrl = await esperarReporte(token, exportId);
    const filas = await descargarFilas(reportUrl);

    // ?debug=cols -> lista las columnas detectadas
    if (req.query.debug === "cols") {
      const cols = filas.length ? Object.keys(filas[0]) : [];
      return res.status(200).json({ ok: true, modo: "debug-columnas", total_columnas: cols.length, columnas: cols });
    }

    let registros = filas.map(mapearFila);
    const antesDeFiltrar = registros.length;
    registros = registros.filter(esRespondida);
    const respondidasCrudas = registros.length;
    const idsUnicos = new Set(registros.map(r => r.wise_id)).size;

    const r = await guardarEnSupabase(registros);

    return res.status(200).json({
      ok: true,
      rango_pedido: { date_from: dateFrom, date_to: dateTo },
      filas_recibidas: antesDeFiltrar,
      respondidas: respondidasCrudas,
      ids_unicos: idsUnicos,
      registros_guardados: r.insertados,
      muestra: registros.slice(0, 2),
    });
  } catch (err) {
    console.error("sync-encuestas error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
