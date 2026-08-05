// ============================================================
//  /api/sync-encuestas.js
//  Vercel Serverless Function (Node.js)
//
//  Flujo:
//   1) POST /authenticate          -> obtiene token JWT (dura 1h)
//   2) POST /analytics/export/{id} -> inicia la exportación del reporte
//   3) GET  /analytics/export/{export_id}/status -> espera a que termine
//   4) descarga report_url (CSV o JSON) con las encuestas
//   5) parsea, detecta columnas de puntuación, y hace upsert en Supabase
//
//  Se dispara solo por el Vercel Cron (ver vercel.json) o manualmente
//  visitando /api/sync-encuestas?key=TU_SECRETO
// ============================================================

const WISE_BASE = "https://api.wcx.cloud/core/v1";
const REPORT_ID = process.env.WISE_REPORT_ID || "138189"; // reporte "Respuestas de Encuestas"

// --- helpers -------------------------------------------------

// pausa N ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// headers comunes: x-api-key SIEMPRE + Bearer cuando ya tenemos token
function wiseHeaders(token) {
  const h = {
    "x-api-key": process.env.WISE_API_KEY,
    "Content-Type": "application/json",
  };
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}

// 1) Autenticación -> devuelve el token JWT
// Según la doc de Wise CX: GET /authenticate?user=USUARIO
// con la cabecera x-api-key. NO lleva body.
async function autenticar() {
  const url = `${WISE_BASE}/authenticate?user=${encodeURIComponent(process.env.WISE_USER)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: wiseHeaders(null),
  });

  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`authenticate falló (${res.status}): ${txt}`);
  }
  let data = {};
  try { data = JSON.parse(txt); } catch { /* por si devuelve texto plano */ }

  // el token puede venir con distintos nombres según la versión
  const token =
    data.token || data.jwt || data.access_token || data.accessToken || txt.trim();
  if (!token) throw new Error("No se recibió token en /authenticate: " + txt);
  return token;
}

// 2) Inicia la exportación del reporte -> devuelve export_id
async function iniciarExport(token) {
  const res = await fetch(`${WISE_BASE}/analytics/export/${REPORT_ID}`, {
    method: "POST",
    headers: wiseHeaders(token),
    // "all" = todas las columnas configuradas en el reporte (incluye AGENTE
    // y las columnas de puntuación). Así no dependemos de nombres exactos.
    body: JSON.stringify({ columns: "all" }),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`export falló (${res.status}): ${txt}`);

  const data = JSON.parse(txt);
  const exportId = data.export_id || data.id || data.exportId;
  if (!exportId) throw new Error("No se recibió export_id: " + txt);
  return exportId;
}

// 3) Consulta el estado hasta que termine -> devuelve report_url
async function esperarReporte(token, exportId) {
  const MAX_INTENTOS = 30;   // 30 intentos
  const ESPERA_MS = 4000;    // cada 4s  => hasta ~2 min de espera

  for (let i = 0; i < MAX_INTENTOS; i++) {
    const res = await fetch(
      `${WISE_BASE}/analytics/export/${exportId}/status`,
      { method: "GET", headers: wiseHeaders(token) }
    );
    const txt = await res.text();
    if (!res.ok) throw new Error(`status falló (${res.status}): ${txt}`);

    const data = JSON.parse(txt);
    const estado = String(data.status || "").toLowerCase();
    const url = data.report_url || data.url || data.download_url;

    // estados "terminado" según distintas convenciones
    if (["done", "completed", "finished", "success", "ok"].includes(estado)) {
      if (!url) throw new Error("Reporte terminado pero sin report_url: " + txt);
      return url;
    }
    // estados de error
    if (["failed", "error"].includes(estado)) {
      throw new Error("La exportación falló en Wise: " + txt);
    }
    // sigue "processing"/"pending"/"running" -> esperar y reintentar
    await sleep(ESPERA_MS);
  }
  throw new Error("Timeout esperando la exportación de Wise.");
}

// 4) Descarga el archivo del reporte (CSV o JSON) y lo convierte a filas
async function descargarFilas(reportUrl) {
  const res = await fetch(reportUrl);
  const txt = await res.text();
  if (!res.ok) throw new Error(`descarga falló (${res.status})`);

  // ¿es JSON?
  const t = txt.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j.rows)) return j.rows;
    return [];
  }

  // si no, asumimos CSV
  return parseCSV(t);
}

// parser CSV simple pero que respeta comillas y comas internas
function parseCSV(texto) {
  const lineas = texto.split(/\r?\n/).filter((l) => l.length > 0);
  if (lineas.length === 0) return [];

  const parseLinea = (linea) => {
    const out = [];
    let cur = "";
    let dentroComillas = false;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (c === '"') {
        if (dentroComillas && linea[i + 1] === '"') { cur += '"'; i++; }
        else dentroComillas = !dentroComillas;
      } else if ((c === "," || c === ";") && !dentroComillas) {
        out.push(cur); cur = "";
      } else {
        cur += c;
      }
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

// busca la primera clave del objeto cuyo nombre "contenga" alguno de los términos
function buscarClave(obj, terminos) {
  const claves = Object.keys(obj);
  for (const t of terminos) {
    const found = claves.find((k) =>
      k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .includes(t)
    );
    if (found) return found;
  }
  return null;
}

// detecta TODAS las columnas cuyo valor sea una nota 0..10 (puntuaciones)
function columnasDePuntuacion(fila) {
  const cols = [];
  for (const [k, v] of Object.entries(fila)) {
    const n = Number(String(v).replace(",", "."));
    if (!isNaN(n) && n >= 0 && n <= 10 && String(v).trim() !== "") {
      // heurística: el nombre suele contener "calific", "punt", "nps",
      // "nota", "score", o el signo "¿". Si no, igual lo tomamos si es 0-10.
      cols.push(k);
    }
  }
  return cols;
}

// convierte una fila cruda de Wise en el registro que guardamos en Supabase
function mapearFila(fila, idx) {
  const kAsesor   = buscarClave(fila, ["agente", "asesor", "usuario", "user"]);
  const kFecha    = buscarClave(fila, ["fecha", "date", "survey_sent", "created"]);
  const kSucursal = buscarClave(fila, ["sucursal", "branch"]);
  const kServicio = buscarClave(fila, ["servicio", "service"]);
  const kDominio  = buscarClave(fila, ["dominio", "patente", "domain"]);
  const kEmpresa  = buscarClave(fila, ["empresa", "telefono", "phone", "cliente", "nombre"]);
  const kEncuesta = buscarClave(fila, ["encuesta", "survey"]);
  const kId       = buscarClave(fila, ["id", "caso", "case", "#"]);

  // puntuaciones
  const colsPunt = columnasDePuntuacion(fila);
  const nums = colsPunt
    .map((c) => Number(String(fila[c]).replace(",", ".")))
    .filter((n) => !isNaN(n));
  const puntuacion = nums.length ? nums[0] : null;
  const prom = nums.length
    ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
    : null;

  // id estable: usa el id de Wise si existe; si no, combina campos
  const wiseId = String(
    (kId && fila[kId]) ||
    `${kDominio ? fila[kDominio] : ""}_${kFecha ? fila[kFecha] : ""}_${idx}`
  ).trim();

  // parseo de fecha tolerante
  let fecha = null;
  if (kFecha && fila[kFecha]) {
    const d = new Date(fila[kFecha].replace(" ", "T"));
    if (!isNaN(d.getTime())) fecha = d.toISOString();
  }

  return {
    wise_id: wiseId,
    fecha,
    asesor:    kAsesor   ? fila[kAsesor]   : null,
    puntuacion,
    puntuacion_prom: prom,
    sucursal:  kSucursal ? fila[kSucursal] : null,
    servicio:  kServicio ? fila[kServicio] : null,
    dominio:   kDominio  ? fila[kDominio]  : null,
    empresa:   kEmpresa  ? fila[kEmpresa]  : null,
    encuesta:  kEncuesta ? fila[kEncuesta] : null,
    raw: fila,
    sincronizado_en: new Date().toISOString(),
  };
}

// Limpia recursivamente los caracteres nulos (\u0000) y otros de control
// que Postgres/Supabase no acepta guardar. Vienen del CSV de Wise.
function limpiarNulos(valor) {
  if (typeof valor === "string") {
    // elimina el carácter nulo y otros de control invisibles
    return valor.replace(/\u0000/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  }
  if (Array.isArray(valor)) {
    return valor.map(limpiarNulos);
  }
  if (valor && typeof valor === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = limpiarNulos(v);
    return out;
  }
  return valor;
}

// 5) Upsert a Supabase vía REST (sin SDK, para mantener la función liviana)
async function guardarEnSupabase(registros) {
  if (registros.length === 0) return { insertados: 0 };

  // limpiar caracteres nulos que Postgres rechaza
  registros = registros.map(limpiarNulos);

  const url = `${process.env.SUPABASE_URL}/rest/v1/encuestas?on_conflict=wise_id`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      // merge-duplicates = upsert: actualiza si ya existe ese wise_id
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(registros),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase upsert falló (${res.status}): ${t}`);
  }
  return { insertados: registros.length };
}

// ------------------------------------------------------------
//  Handler principal
// ------------------------------------------------------------
export default async function handler(req, res) {
  // Protección: solo corre si viene del cron de Vercel o con el secreto correcto
  const esCron = req.headers["x-vercel-cron"] === "1";
  const keyOk = req.query.key && req.query.key === process.env.SYNC_SECRET;
  if (!esCron && !keyOk) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {
    const token = await autenticar();
    const exportId = await iniciarExport(token);
    const reportUrl = await esperarReporte(token, exportId);
    const filas = await descargarFilas(reportUrl);
    const registros = filas.map(mapearFila);
    const r = await guardarEnSupabase(registros);

    return res.status(200).json({
      ok: true,
      filas_recibidas: filas.length,
      registros_guardados: r.insertados,
      muestra: registros.slice(0, 2), // primeras 2 para verificar el mapeo
    });
  } catch (err) {
    console.error("sync-encuestas error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
