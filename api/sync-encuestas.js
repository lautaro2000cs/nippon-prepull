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
  // devolvemos también el crudo para diagnóstico
  return { exportId, raw: txt };
}

// 3) Consulta el estado hasta que termine -> devuelve report_url
async function esperarReporte(token, exportId) {
  const MAX_INTENTOS = 40;   // 40 intentos
  const ESPERA_MS = 4000;    // cada 4s  => hasta ~2.5 min de espera

  // espera inicial: Wise necesita unos segundos para registrar el export
  // antes de que /status lo reconozca (si no, devuelve EXPORT_NOT_FOUND)
  await sleep(5000);

  for (let i = 0; i < MAX_INTENTOS; i++) {
    const res = await fetch(
      `${WISE_BASE}/analytics/export/${exportId}/status`,
      { method: "GET", headers: wiseHeaders(token) }
    );
    const txt = await res.text();

    // EXPORT_NOT_FOUND en los primeros intentos = todavía no se registró.
    // Lo toleramos y reintentamos (hasta ~40s). Si persiste, ahí sí falla.
    if (!res.ok) {
      if (txt.includes("EXPORT_NOT_FOUND") && i < 10) {
        await sleep(ESPERA_MS);
        continue;
      }
      throw new Error(`status falló (${res.status}) [intento ${i}]: ${txt}`);
    }

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

// 4) Descarga el archivo del reporte y lo convierte a filas.
// Wise entrega un ZIP que contiene el CSV adentro, así que primero
// detectamos el ZIP, extraemos el CSV y recién ahí parseamos.
async function descargarFilas(reportUrl) {
  const res = await fetch(reportUrl);
  if (!res.ok) throw new Error(`descarga falló (${res.status})`);

  // leemos como binario (puede ser ZIP)
  const buf = Buffer.from(await res.arrayBuffer());

  // firma de ZIP: los primeros 2 bytes son 'P' 'K' (0x50 0x4B)
  const esZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

  let texto;
  if (esZip) {
    texto = extraerCSVdeZip(buf);
  } else {
    texto = buf.toString("utf8");
  }

  const t = texto.trim();
  // ¿es JSON?
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j.rows)) return j.rows;
    return [];
  }
  // si no, es CSV
  return parseCSV(t);
}

// Extrae el primer archivo (el CSV) de un buffer ZIP, sin dependencias externas.
// Lee la estructura del ZIP y descomprime con zlib.inflateRaw (método deflate)
// o lo toma tal cual (método stored/sin compresión).
function extraerCSVdeZip(buf) {
  const zlib = require("zlib");
  let offset = 0;

  while (offset + 4 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    // 0x04034b50 = Local File Header (inicio de un archivo dentro del ZIP)
    if (sig !== 0x04034b50) break;

    const metodo = buf.readUInt16LE(offset + 8);       // 0=stored, 8=deflate
    const compSize = buf.readUInt32LE(offset + 18);    // tamaño comprimido
    const nameLen = buf.readUInt16LE(offset + 26);     // largo del nombre
    const extraLen = buf.readUInt16LE(offset + 28);    // largo del campo extra

    const nombre = buf.toString("utf8", offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    const comprimido = buf.subarray(dataStart, dataEnd);

    let contenido;
    if (metodo === 0) {
      contenido = comprimido;                          // sin compresión
    } else if (metodo === 8) {
      contenido = zlib.inflateRawSync(comprimido);     // deflate
    } else {
      // método desconocido: pasamos a la siguiente entrada
      offset = dataEnd;
      continue;
    }

    // nos quedamos con el primer archivo que parezca CSV (o el primero a secas)
    if (nombre.toLowerCase().endsWith(".csv") || !nombre.includes("/")) {
      return contenido.toString("utf8");
    }
    offset = dataEnd;
  }

  throw new Error("No se pudo extraer el CSV del ZIP de Wise.");
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

// Convierte un valor de celda a número 0-10, o null si no aplica (ej "S/D")
function aNota(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "" || /^s\/?d$/i.test(s)) return null; // "S/D" = sin dato
  const n = Number(s);
  return (!isNaN(n) && n >= 0 && n <= 10) ? n : null;
}

// Busca en la fila la columna cuyo NOMBRE contenga TODAS las palabras dadas
// (sin distinguir mayúsculas ni tildes) y devuelve su valor como nota.
function notaPorPalabras(fila, palabras) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [k, v] of Object.entries(fila)) {
    const nk = norm(k);
    if (palabras.every((p) => nk.includes(norm(p)))) {
      return aNota(v);
    }
  }
  return null;
}

// Extrae las notas de cada pregunta identificándolas por palabras clave únicas
// de su enunciado en el reporte de Wise.
function extraerPreguntas(fila) {
  return {
    // --- las 5 del promedio del asesor ---
    p_amabilidad:  notaPorPalabras(fila, ["amabilidad"]),
    p_atencion:    notaPorPalabras(fila, ["atencion", "solicitudes"]),
    p_puntualidad: notaPorPalabras(fila, ["puntualidad"]),
    p_explicacion: notaPorPalabras(fila, ["explicacion"]),
    p_limpieza:    notaPorPalabras(fila, ["limpieza"]),
    // --- otras preguntas (se muestran pero no cuentan al promedio) ---
    p_turnos:      notaPorPalabras(fila, ["facilidad", "turnos"]),
    p_espera:      notaPorPalabras(fila, ["tiempo", "espera"]),
    p_calidad:     notaPorPalabras(fila, ["calidad", "servicio", "prestado"]),
    p_recomienda:  notaPorPalabras(fila, ["recomiende"]),
  };
}

// Busca el comentario libre del cliente
function extraerComentario(fila) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [k, v] of Object.entries(fila)) {
    const nk = norm(k);
    if ((nk.includes("sugerencias") || nk.includes("comentario")) && String(v).trim() && String(v).trim() !== "S/D") {
      return String(v).trim();
    }
  }
  return null;
}

// Busca el campo "¿el vehículo quedó funcionando correctamente?" (SI/NO)
function extraerFunciono(fila) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [k, v] of Object.entries(fila)) {
    if (norm(k).includes("funcionando correctamente")) {
      const s = String(v).trim();
      return s || null;
    }
  }
  return null;
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

  // extraer cada pregunta a su columna
  const preguntas = extraerPreguntas(fila);

  // promedio del asesor = promedio de las 5 preguntas que le corresponden
  const cincoDelAsesor = [
    preguntas.p_amabilidad,
    preguntas.p_atencion,
    preguntas.p_puntualidad,
    preguntas.p_explicacion,
    preguntas.p_limpieza,
  ].filter((n) => n != null);
  const promedioAsesor = cincoDelAsesor.length
    ? Math.round((cincoDelAsesor.reduce((a, b) => a + b, 0) / cincoDelAsesor.length) * 100) / 100
    : null;

  // id estable Y único: usamos el id de Wise si existe, pero SIEMPRE le
  // anexamos el índice de fila para que nunca haya dos wise_id iguales en
  // el mismo lote (Postgres rechaza upsert con claves duplicadas).
  const base = (kId && fila[kId])
    ? String(fila[kId]).trim()
    : `${kDominio ? fila[kDominio] : ""}_${kFecha ? fila[kFecha] : ""}`.trim();
  const wiseId = `${base}#${idx}`;

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
    // las 9 preguntas en columnas separadas
    ...preguntas,
    // el promedio del asesor (5 preguntas) y el comentario
    promedio_asesor: promedioAsesor,
    comentario: extraerComentario(fila),
    funciono_ok: extraerFunciono(fila),
    // compatibilidad: mantenemos puntuacion_prom apuntando al nuevo promedio
    puntuacion_prom: promedioAsesor,
    puntuacion: promedioAsesor,
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

  // de-duplicar por wise_id (nos quedamos con la última ocurrencia).
  // Postgres rechaza el upsert si el mismo lote trae dos filas con la
  // misma clave, así que garantizamos unicidad acá también.
  const porId = new Map();
  for (const r of registros) porId.set(r.wise_id, r);
  registros = Array.from(porId.values());

  // limpieza en el objeto (byte nulo real y otros de control)
  registros = registros.map(limpiarNulos);

  // Serializamos y limpiamos el TEXTO final, cubriendo dos casos que
  // Postgres rechaza: el byte nulo real y la secuencia escapada "\u0000"
  // (que JSON.stringify puede generar y Postgres no acepta como texto).
  let payload = JSON.stringify(registros);
  payload = payload
    .replace(/\\u0000/g, "")   // literal escapado \u0000
    .replace(/\u0000/g, "");    // byte nulo real por las dudas

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
    body: payload,
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
    const { exportId, raw: exportRaw } = await iniciarExport(token);

    // modo diagnóstico: /api/sync-encuestas?key=...&debug=1
    // muestra qué devolvió Wise al iniciar el export, sin esperar el resto
    if (req.query.debug === "1") {
      return res.status(200).json({
        ok: true,
        modo: "debug",
        export_id_detectado: exportId,
        respuesta_cruda_del_export: exportRaw,
      });
    }

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
