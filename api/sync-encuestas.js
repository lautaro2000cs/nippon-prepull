// ============================================================
//  /api/sync-encuestas.js
//  Vercel Serverless Function (Node.js)
//
//  CLAVE DEL FUNCIONAMIENTO:
//  Wise procesa UNA exportación por vez. Si se le pide otra mientras hay una
//  en curso, la nueva queda en 0% y termina cancelada. Y generar el reporte
//  puede tardar más que el minuto que da Vercel.
//
//  Por eso este endpoint NO crea una exportación en cada llamada:
//   1) Si hay una exportación pendiente guardada -> consulta su estado.
//        · lista      -> la descarga, la guarda en Supabase y limpia el estado
//        · generando  -> responde fase:"generando" (NO pide otra)
//        · fallida    -> limpia el estado y recién ahí pide una nueva
//   2) Si no hay ninguna pendiente -> pide UNA, guarda su id y espera ~30s.
//
//  Consultar el estado es gratis; crear una exportación es lo caro.
//  Así ninguna exportación se pierde y nunca se piden dos seguidas.
//
//  Se dispara por el Vercel Cron (ver vercel.json) o con ?key=SECRETO.
//  Parámetros: ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD  (default: últimos 7 días)
//              ?fresh=1   fuerza una exportación nueva (descarta la pendiente)
// ============================================================

const crypto = require("crypto");
const WISE_BASE = "https://api.wcx.cloud/core/v1";
const REPORT_ID = process.env.WISE_REPORT_ID || "240426";
const CLAVE_ESTADO = "wise_last_export";

export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wiseHeaders(token) {
  const h = { "x-api-key": process.env.WISE_API_KEY, "Content-Type": "application/json" };
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}

// --- 1) Autenticación -> token JWT ---------------------------
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

// --- 2) Pide UNA exportación -> export_id --------------------
async function iniciarExport(token, dateFrom, dateTo) {
  const body = { columns: "all" };
  if (dateFrom && dateTo) body.filter = { date_from: dateFrom, date_to: dateTo };
  const res = await fetch(`${WISE_BASE}/analytics/export/${REPORT_ID}`, {
    method: "POST", headers: wiseHeaders(token), body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`export falló (${res.status}): ${txt}`);
  let data;
  try { data = JSON.parse(txt); }
  catch { throw new Error(`Wise respondió algo inesperado: ${txt.slice(0, 300)}`); }
  const exportId = data.export_id || data.id || data.exportId;
  if (!exportId) throw new Error("No se recibió export_id: " + txt);
  return exportId;
}

// --- 3) Consulta el estado (gratis, no crea nada) ------------
async function chequearEstado(token, exportId) {
  const res = await fetch(`${WISE_BASE}/analytics/export/${exportId}/status`,
    { method: "GET", headers: wiseHeaders(token) });
  const txt = await res.text();
  if (!res.ok) {
    if (txt.includes("EXPORT_NOT_FOUND")) return { listo: false, perdido: true, estado: "not_found" };
    throw new Error(`status falló (${res.status}): ${txt}`);
  }
  let data = {};
  try { data = JSON.parse(txt); } catch { /* ignoramos */ }
  const estado = String(data.status || "").toLowerCase();
  const url = data.report_url || data.url || data.download_url;
  if (["failed", "error", "cancelled", "canceled", "expired"].includes(estado)) {
    return { listo: false, perdido: true, estado };
  }
  if (url || ["done", "completed", "finished", "success", "ok", "ready", "available"].includes(estado)) {
    return { listo: true, estado, url };
  }
  return { listo: false, estado: estado || "processing" };
}

// --- 4) Descarga (ZIP->CSV o JSON) y convierte a filas -------
async function descargarFilas(reportUrl) {
  const res = await fetch(reportUrl);
  if (!res.ok) throw new Error(`descarga falló (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const esZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  const texto = esZip ? extraerCSVdeZip(buf) : buf.toString("utf8");
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
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
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
    if (nombre.toLowerCase().endsWith(".csv") || !nombre.includes("/")) return contenido.toString("utf8");
    offset = dataEnd;
  }
  throw new Error("No se pudo extraer el CSV del ZIP de Wise.");
}

function parseCSV(texto) {
  const lineas = texto.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lineas.length) return [];
  const parseLinea = (linea) => {
    const out = []; let cur = ""; let comillas = false;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (c === '"') {
        if (comillas && linea[i + 1] === '"') { cur += '"'; i++; }
        else comillas = !comillas;
      } else if ((c === "," || c === ";") && !comillas) { out.push(cur); cur = ""; }
      else cur += c;
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

// --- Detección automática de columnas ------------------------
const _norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function buscarClave(obj, terminos) {
  const claves = Object.keys(obj);
  for (const t of terminos) {
    const found = claves.find((k) => _norm(k).includes(t));
    if (found) return found;
  }
  return null;
}
function claveConPalabras(obj, palabras) {
  return Object.keys(obj).find((k) => {
    const nk = _norm(k);
    return palabras.every((p) => nk.includes(_norm(p)));
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
  for (const [k, v] of Object.entries(fila)) {
    const nk = _norm(k);
    if (palabras.every((p) => nk.includes(_norm(p)))) return aNota(v);
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
  for (const [k, v] of Object.entries(fila)) {
    const nk = _norm(k);
    if ((nk.includes("sugerencias") || nk.includes("comentario")) &&
        String(v).trim() && String(v).trim() !== "S/D") return String(v).trim();
  }
  return null;
}
function extraerFunciono(fila) {
  for (const [k, v] of Object.entries(fila)) {
    if (_norm(k).includes("funcionando correctamente")) {
      const s = String(v).trim();
      return s || null;
    }
  }
  return null;
}

function mapearFila(fila) {
  const kAsesor   = buscarClave(fila, ["agente", "asesor", "usuario", "user"]);
  const kSucursal = buscarClave(fila, ["sucursal", "branch"]);
  const kServicio = buscarClave(fila, ["servicio", "service"]);
  const kDominio  = buscarClave(fila, ["dominio", "patente", "domain"]);
  const kEmpresa  = buscarClave(fila, ["empresa", "telefono", "phone", "cliente", "nombre"]);
  const kTelefono = claveConPalabras(fila, ["contacto", "telefono"]) || buscarClave(fila, ["telefono", "phone", "celular"]);
  const claves = Object.keys(fila);
  const kNroOrden =
    claves.find(k => { const n = _norm(k); return n.includes("orden") && !n.includes("grupo") && (n.includes("n° orden") || n.includes("n orden") || n.includes("nro")); })
    || claves.find(k => { const n = _norm(k); return n.includes("contacto") && n.includes("orden") && !n.includes("grupo"); })
    || null;
  const kEncuesta = buscarClave(fila, ["encuesta", "survey"]);

  const kFechaResp  = claveConPalabras(fila, ["fecha", "respuesta"]) || claveConPalabras(fila, ["response", "date"]);
  const kFechaEnvio = claveConPalabras(fila, ["fecha", "envio"]) || claveConPalabras(fila, ["survey", "sent"]) || claveConPalabras(fila, ["fecha", "creado"]);
  const kFecha = kFechaEnvio || buscarClave(fila, ["fecha", "date", "survey_sent", "created"]);

  const preguntas = extraerPreguntas(fila);
  const cinco = [preguntas.p_amabilidad, preguntas.p_atencion, preguntas.p_puntualidad,
                 preguntas.p_explicacion, preguntas.p_limpieza].filter(n => n != null);
  const promedioAsesor = cinco.length
    ? Math.round((cinco.reduce((a, b) => a + b, 0) / cinco.length) * 100) / 100 : null;

  const ordenRaw = kNroOrden ? fila[kNroOrden] : null;
  const domRaw   = kDominio  ? fila[kDominio]  : null;
  const envioRaw = kFecha    ? fila[kFecha]    : null;
  const respRaw  = kFechaResp ? fila[kFechaResp] : null;
  const normId = (v) => String(v ?? "").trim().toLowerCase();

  const claveId = (ordenRaw && String(ordenRaw).trim())
    ? "ord|" + normId(ordenRaw)
    : "sin-orden|" + normId(domRaw) + "|" + normId(envioRaw) + "|" + normId(respRaw);
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
  if (typeof valor === "string") return valor.replace(/\u0000/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
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
    const nk = _norm(k);
    if (nk.includes("respondida") || nk.includes("responded") || nk === "is_responsed") {
      const s = String(v).trim().toLowerCase();
      return s === "si" || s === "sí" || s === "1" || s === "yes" || s === "true";
    }
  }
  if (registro.fecha_respuesta) return true;
  return registro.promedio_asesor != null;
}

// --- 5) Upsert a Supabase (merge por wise_id) ----------------
async function guardarEnSupabase(registros) {
  if (!registros.length) return { insertados: 0 };
  const ordenados = registros.slice().sort((a, b) => {
    const fa = a.fecha_respuesta || a.fecha || "";
    const fb = b.fecha_respuesta || b.fecha || "";
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  const porId = new Map();
  for (const r of ordenados) porId.set(r.wise_id, r);
  const finales = Array.from(porId.values()).map(limpiarNulos);

  const payload = JSON.stringify(finales).replace(/\\u0000/g, "").replace(/\u0000/g, "");
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/encuestas?on_conflict=wise_id`, {
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
  return { insertados: finales.length };
}

// --- Estado de la exportación en curso (tabla app_config) ----
async function leerEstado() {
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/app_config?clave=eq.${encodeURIComponent(CLAVE_ESTADO)}&select=valor`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!res.ok) return null;
    const arr = await res.json();
    const v = arr && arr[0] && arr[0].valor;
    return (v && v.export_id) ? v : null;
  } catch { return null; }
}

async function guardarEstado(valor) {
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_config?on_conflict=clave`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{
        clave: CLAVE_ESTADO, valor,
        actualizado_en: new Date().toISOString(),
        actualizado_por: "sync-encuestas",
      }]),
    });
    if (!res.ok) { console.warn("guardarEstado falló:", res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.warn("guardarEstado error:", e.message); return false; }
}

// Descarga + mapea + guarda, y devuelve el resumen
async function bajarYGuardar(reportUrl) {
  const filas = await descargarFilas(reportUrl);
  let registros = filas.map(mapearFila);
  const recibidas = registros.length;
  registros = registros.filter(esRespondida);
  const r = await guardarEnSupabase(registros);
  return {
    filas_recibidas: recibidas,
    respondidas: registros.length,
    registros_guardados: r.insertados,
  };
}

// ------------------------------------------------------------
//  Handler
// ------------------------------------------------------------
export default async function handler(req, res) {
  const esCron = req.headers["x-vercel-cron"] === "1";
  const keyOk = req.query.key && req.query.key === process.env.SYNC_SECRET;
  if (!esCron && !keyOk) return res.status(401).json({ ok: false, error: "No autorizado" });

  try {
    let dateFrom = req.query.date_from || null;
    let dateTo   = req.query.date_to   || null;
    if (!dateFrom || !dateTo) {
      const hoy = new Date();
      dateTo = hoy.toISOString().slice(0, 10);
      const hace7 = new Date(hoy);
      hace7.setDate(hace7.getDate() - 7);
      dateFrom = hace7.toISOString().slice(0, 10);
    }

    const forzar = req.query.fresh === "1";
    const token = await autenticar();

    // ===== PASO 1: ¿hay una exportación pendiente? ============
    let estado = forzar ? null : await leerEstado();
    if (forzar) await guardarEstado({});

    if (estado && estado.export_id) {
      const est = await chequearEstado(token, estado.export_id);

      if (est.listo && est.url) {
        const resumen = await bajarYGuardar(est.url);
        await guardarEstado({});                      // ya se descargó: liberamos
        return res.status(200).json({
          ok: true, fase: "listo", reanudada: true,
          rango_pedido: { date_from: estado.date_from, date_to: estado.date_to },
          ...resumen,
        });
      }

      if (!est.perdido) {
        // Sigue generando: NO pedimos otra, que quedaría cancelada.
        const seg = estado.ts ? Math.round((Date.now() - estado.ts) / 1000) : null;
        return res.status(200).json({
          ok: true, fase: "generando", export_id: estado.export_id,
          esperando_seg: seg, estado_wise: est.estado,
          rango_pedido: { date_from: estado.date_from, date_to: estado.date_to },
        });
      }

      // Se cayó / venció / la cancelaron: la soltamos y pedimos una nueva.
      await guardarEstado({});
      estado = null;
    }

    // ===== PASO 2: no hay pendiente -> pedimos UNA ============
    const exportId = await iniciarExport(token, dateFrom, dateTo);
    const guardado = await guardarEstado({
      export_id: exportId, date_from: dateFrom, date_to: dateTo, ts: Date.now(),
    });

    // Esperamos ~30s por si sale rápido (deja margen para descargar y guardar)
    await sleep(3000);
    for (let i = 0; i < 9; i++) {
      const est = await chequearEstado(token, exportId);
      if (est.perdido) break;
      if (est.listo && est.url) {
        const resumen = await bajarYGuardar(est.url);
        await guardarEstado({});
        return res.status(200).json({
          ok: true, fase: "listo",
          rango_pedido: { date_from: dateFrom, date_to: dateTo },
          ...resumen,
        });
      }
      await sleep(3000);
    }

    // Todavía generando: queda guardada y la próxima llamada la reanuda.
    return res.status(200).json({
      ok: true, fase: "generando", export_id: exportId,
      esperando_seg: 30, estado_guardado: guardado,
      rango_pedido: { date_from: dateFrom, date_to: dateTo },
    });

  } catch (err) {
    console.error("sync-encuestas error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
