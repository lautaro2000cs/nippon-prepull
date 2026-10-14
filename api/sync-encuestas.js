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
  const headers = parseLinea(lineas[0]).map((h) => h.replace(/^\uFEFF/, "").trim());
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
//  Detección de columnas (misma lógica que el import manual del portal,
//  para que el sync automático y el import produzcan lo mismo)
// ------------------------------------------------------------
const _norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Una columna cuyo título es una pregunta no puede ser un campo de texto
const esPregunta = (h) => /[¿?]/.test(String(h));

// "[Sin Asignar]", "S/D", "-" son relleno, no datos reales
function esRelleno(v) {
  const s = _norm(v).trim();
  return !s || s === "s/d" || s === "sd" || s === "n/a" || s === "-" || s === "--" || /^\[.*\]$/.test(s);
}

function detectarColumnas(filas) {
  const headers = filas.length ? Object.keys(filas[0]) : [];
  const conDatos = (h) => filas.some((f) => !esRelleno(f[h]));
  const noPreg = headers.filter((h) => h && !esPregunta(h));
  const todas = headers.filter(Boolean);

  const elegir = (cands, grupos, exigirDatos) => {
    for (const g of grupos) {
      for (const h of cands) {
        const nh = _norm(h);
        if (g.every((t) => nh.includes(_norm(t)))) {
          if (exigirDatos && !conDatos(h)) continue;
          return h;
        }
      }
    }
    return null;
  };

  return {
    asesor:   elegir(noPreg, [["contacto", "agente"], ["agente"], ["asesor"], ["usuario", "nombre"], ["usuario"], ["user"]], true),
    sucursal: elegir(noPreg, [["sucursal"], ["branch"]], true),
    servicio: elegir(noPreg, [["servicio"], ["service"]], true),
    dominio:  elegir(noPreg, [["dominio"], ["patente"], ["domain"]], true),
    telefono: elegir(noPreg, [["contacto", "telefono"], ["telefono"], ["celular"], ["phone"]], true),
    empresa:  elegir(noPreg.filter((h) => !/telefono|phone/.test(_norm(h))),
                     [["contacto", "nombre"], ["empresa", "nombre"], ["cliente"], ["nombre"], ["empresa"]], true),
    encuesta: elegir(noPreg, [["encuesta"], ["survey"]], true),
    nroOrden: elegir(noPreg.filter((h) => !_norm(h).includes("grupo")),
                     [["n° orden"], ["n orden"], ["nro", "orden"], ["contacto", "orden"], ["orden"]], true),
    fechaEnvio: elegir(noPreg, [["fecha", "envio"], ["survey", "sent"], ["fecha", "creado"]], true),
    fechaResp:  elegir(noPreg, [["fecha", "respuesta"], ["response", "date"]], true),
    respondida: elegir(noPreg, [["respondida"], ["responded"]], true),

    p_amabilidad:  elegir(todas, [["amabilidad"]], false),
    p_atencion:    elegir(todas, [["atencion", "solicitudes"]], false),
    p_puntualidad: elegir(todas, [["puntualidad"]], false),
    p_explicacion: elegir(todas, [["explicacion"]], false),
    p_limpieza:    elegir(todas, [["limpieza"]], false),
    p_turnos:      elegir(todas, [["facilidad", "turnos"]], false),
    p_espera:      elegir(todas, [["tiempo", "espera"]], false),
    p_calidad:     elegir(todas, [["calidad", "servicio", "prestado"]], false),
    p_recomienda:  elegir(todas, [["recomiende"]], false),
    funciono:      elegir(todas, [["funcionando correctamente"]], false),
    comentario:    elegir(todas, [["sugerencias"], ["comentario"]], false),
  };
}

function aNota(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "" || /^s\/?d$/i.test(s)) return null;
  const n = Number(s);
  return (!isNaN(n) && n >= 0 && n <= 10) ? n : null;
}

const PREGUNTAS = ["p_amabilidad", "p_atencion", "p_puntualidad", "p_explicacion", "p_limpieza",
                   "p_turnos", "p_espera", "p_calidad", "p_recomienda"];

// Arma el registro SOLO con los campos que el reporte realmente trae:
// lo que no viene se omite y el upsert no lo pisa.
function armarRegistro(fila, d) {
  const val = (col) => (col ? String(fila[col] ?? "").trim() : "");
  const txt = (col) => { const v = val(col); return esRelleno(v) ? null : v; };
  const r = {};

  const orden = val(d.nroOrden);
  const dom   = val(d.dominio);
  const envio = val(d.fechaEnvio);
  const resp  = val(d.fechaResp);
  const nid   = (v) => String(v ?? "").trim().toLowerCase();

  const parseFecha = (v) => {
    if (!v) return null;
    const dd = new Date(String(v).replace(" ", "T"));
    return isNaN(dd.getTime()) ? null : dd.toISOString();
  };

  if (d.fechaEnvio) r.fecha = parseFecha(envio);
  if (d.fechaResp)  r.fecha_respuesta = parseFecha(resp);

  const claveId = orden ? "ord|" + nid(orden)
                        : "sin-orden|" + nid(dom) + "|" + nid(envio) + "|" + nid(resp);
  r.wise_id = "enc_" + crypto.createHash("md5").update(claveId).digest("hex");

  if (d.asesor)   r.asesor    = txt(d.asesor);
  if (d.sucursal) r.sucursal  = txt(d.sucursal);
  if (d.servicio) r.servicio  = txt(d.servicio);
  if (d.dominio)  r.dominio   = txt(d.dominio);
  if (d.telefono) r.telefono  = txt(d.telefono);
  if (d.nroOrden) r.nro_orden = txt(d.nroOrden);
  if (d.empresa)  r.empresa   = txt(d.empresa);
  if (d.encuesta) r.encuesta  = txt(d.encuesta);

  for (const p of PREGUNTAS) if (d[p]) r[p] = aNota(fila[d[p]]);

  if (d.funciono) r.funciono_ok = txt(d.funciono);
  if (d.comentario) {
    const c = val(d.comentario);
    r.comentario = (c && !esRelleno(c)) ? c : null;
  }

  const cinco = ["p_amabilidad", "p_atencion", "p_puntualidad", "p_explicacion", "p_limpieza"]
    .filter((p) => d[p]).map((p) => r[p]).filter((n) => n != null);
  if (cinco.length) {
    const prom = Math.round((cinco.reduce((a, b) => a + b, 0) / cinco.length) * 100) / 100;
    r.promedio_asesor = prom; r.puntuacion_prom = prom; r.puntuacion = prom;
  }

  r.raw = fila;
  r.sincronizado_en = new Date().toISOString();
  return r;
}

function esRespondida(fila, d, reg) {
  if (d.respondida) {
    const s = String(fila[d.respondida] ?? "").trim().toLowerCase();
    return s === "si" || s === "sí" || s === "1" || s === "yes" || s === "true";
  }
  if (reg.fecha_respuesta) return true;
  return reg.promedio_asesor != null;
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
  if (!filas.length) return { filas_recibidas: 0, respondidas: 0, registros_guardados: 0 };

  const det = detectarColumnas(filas);
  const pares = filas.map((f) => ({ f, r: armarRegistro(f, det) }));
  const registros = pares.filter((x) => esRespondida(x.f, det, x.r)).map((x) => x.r);
  const r = await guardarEnSupabase(registros);

  return {
    filas_recibidas: filas.length,
    respondidas: registros.length,
    registros_guardados: r.insertados,
    columnas_detectadas: {
      asesor: det.asesor, sucursal: det.sucursal, nro_orden: det.nroOrden,
      servicio: det.servicio, dominio: det.dominio, telefono: det.telefono,
    },
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
