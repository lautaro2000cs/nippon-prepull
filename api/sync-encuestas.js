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
async function iniciarExport(token, dateFrom, dateTo) {
  // Body base: todas las columnas del reporte
  const body = { columns: "all" };
  // Si la web mandó un rango, lo pasamos como filtro (Wise filtra por
  // fecha de ENVÍO / survey_sent_date). Si no, el reporte usa su filtro propio.
  if (dateFrom && dateTo) {
    body.filter = { date_from: dateFrom, date_to: dateTo };
  }

  const res = await fetch(`${WISE_BASE}/analytics/export/${REPORT_ID}`, {
    method: "POST",
    headers: wiseHeaders(token),
    body: JSON.stringify(body),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`export falló (${res.status}): ${txt}`);

  // Wise a veces devuelve un error en texto plano (no JSON). Lo detectamos
  // para mostrar un mensaje claro en vez de "Unexpected token".
  let data;
  try {
    data = JSON.parse(txt);
  } catch (e) {
    throw new Error(`Wise respondió algo inesperado (no es JSON): ${txt.slice(0, 300)}`);
  }
  const exportId = data.export_id || data.id || data.exportId;
  if (!exportId) throw new Error("No se recibió export_id: " + txt);
  // devolvemos también el crudo para diagnóstico
  return { exportId, raw: txt };
}

// 3) Consulta el estado hasta que termine -> devuelve report_url
async function esperarReporte(token, exportId) {
  // OJO: Vercel (plan Hobby) corta la función a los 60s. Ajustamos la espera
  // para maximizar el tiempo útil dentro de ese límite.
  const MAX_INTENTOS = 16;   // 16 intentos
  const ESPERA_MS = 3000;    // cada 3s

  // espera inicial: Wise necesita unos segundos para registrar el export
  // antes de que /status lo reconozca (si no, devuelve EXPORT_NOT_FOUND)
  await sleep(3000);

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

// Busca una clave cuyo nombre contenga TODAS las palabras dadas
// (útil para distinguir "Fecha Respuesta" de "Fecha Envío").
function claveConPalabras(obj, palabras) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return Object.keys(obj).find((k) => {
    const nk = norm(k);
    return palabras.every((p) => nk.includes(norm(p)));
  }) || null;
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

// Detecta la columna del ID ÚNICO de la respuesta, evitando falsos positivos
// como "apellido" o "unidad" que contienen "id" solo como substring.
// Trata "id" como palabra suelta (por tokens) y reconoce nombres de id conocidos.
function detectarIdColumna(fila) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const claves = Object.keys(fila);
  // "id" como token independiente (o "#", "folio", "caso"...) => id válido
  const tokensId = ["id", "#", "folio", "ticket", "caso", "case"];
  for (const k of claves) {
    const tokens = norm(k).split(/[^a-z0-9#]+/).filter(Boolean);
    if (tokens.some((t) => tokensId.includes(t))) return k;
  }
  // nombres compactos conocidos (sin separadores): "idrespuesta", "surveyid"...
  const compactos = [
    "idrespuesta", "responseid", "idcaso", "casoid", "idencuesta", "surveyid",
    "idinteraccion", "interactionid", "idconversacion", "conversationid",
    "idticket", "idcontacto", "nrocaso", "numerocaso",
  ];
  for (const k of claves) {
    const compact = norm(k).replace(/[^a-z0-9]/g, "");
    if (compactos.some((c) => compact.includes(c))) return k;
  }
  return null;
}

// convierte una fila cruda de Wise en el registro que guardamos en Supabase
function mapearFila(fila, idx) {
  const kAsesor   = buscarClave(fila, ["agente", "asesor", "usuario", "user"]);
  const kSucursal = buscarClave(fila, ["sucursal", "branch"]);
  const kServicio = buscarClave(fila, ["servicio", "service"]);
  const kDominio  = buscarClave(fila, ["dominio", "patente", "domain"]);
  const kEmpresa  = buscarClave(fila, ["empresa", "telefono", "phone", "cliente", "nombre"]);
  const kEncuesta = buscarClave(fila, ["encuesta", "survey"]);
  const kId       = detectarIdColumna(fila);

  // Fechas: buscamos por separado la de RESPUESTA y la de ENVÍO.
  // (usamos claveConPalabras que exige TODAS las palabras en el nombre)
  const kFechaResp  = claveConPalabras(fila, ["fecha", "respuesta"])
                   || claveConPalabras(fila, ["response", "date"]);
  const kFechaEnvio = claveConPalabras(fila, ["fecha", "envio"])
                   || claveConPalabras(fila, ["survey", "sent"])
                   || claveConPalabras(fila, ["fecha", "creado"]);
  // 'fecha' general = la de envío si existe; si no, cualquier fecha
  const kFecha = kFechaEnvio || buscarClave(fila, ["fecha", "date", "survey_sent", "created"]);

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

  // id ESTABLE y único, SIN el índice de fila (que cambiaba en cada corrida y
  // rompía el upsert generando duplicados). Prioridad:
  //   1) el id real de la respuesta de Wise, si lo detectamos;
  //   2) si no hay, un hash de campos identificatorios ESTABLES de la fila
  //      (dominio + fechas + asesor + encuesta). Mismo contenido => mismo id
  //      en cada sincronización, así el upsert actualiza en vez de duplicar.
  // La de-duplicación dentro del lote (por wise_id) se hace en guardarEnSupabase,
  // por eso ya no necesitamos el "#idx" para evitar claves repetidas.
  const idReal = (kId && fila[kId] != null) ? String(fila[kId]).trim() : "";
  let wiseId;
  if (idReal) {
    wiseId = idReal;
  } else {
    const partes = [
      kDominio    ? fila[kDominio]    : "",
      kFechaResp  ? fila[kFechaResp]  : "",
      kFechaEnvio ? fila[kFechaEnvio] : "",
      kAsesor     ? fila[kAsesor]     : "",
      kEncuesta   ? fila[kEncuesta]   : "",
    ].map((x) => String(x || "").trim()).join("|");
    const hash = require("crypto").createHash("md5").update(partes).digest("hex").slice(0, 16);
    wiseId = `enc_${hash}`;
  }

  // parseo de fechas tolerante
  const parseFecha = (val) => {
    if (!val) return null;
    const d = new Date(String(val).replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d.toISOString();
  };
  const fecha          = parseFecha(kFecha       && fila[kFecha]);
  const fechaRespuesta = parseFecha(kFechaResp   && fila[kFechaResp]);

  return {
    wise_id: wiseId,
    fecha,
    fecha_respuesta: fechaRespuesta,
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

// ¿La encuesta fue respondida? Se fija en el campo "Respondida" (SI/NO) del
// raw, o si tiene fecha de respuesta, o si tiene alguna nota cargada.
function esRespondida(registro){
  const raw = registro.raw || {};
  // buscar campo "Respondida" en el raw
  for (const [k, v] of Object.entries(raw)) {
    const nk = k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (nk.includes("respondida") || nk.includes("responded") || nk === "is_responsed") {
      const s = String(v).trim().toLowerCase();
      return s === "si" || s === "sí" || s === "1" || s === "yes" || s === "true";
    }
  }
  // si no hay campo explícito: la damos por respondida si tiene fecha de
  // respuesta o al menos una nota de las 5 preguntas
  if (registro.fecha_respuesta) return true;
  return registro.promedio_asesor != null;
}

// 5) Upsert a Supabase vía REST (sin SDK, para mantener la función liviana).
// Sube en LOTES chicos para que un mes grande (ej. 700 encuestas) nunca genere
// un payload gigante que devuelva error. Como el wise_id es estable, subir de a
// tandas es seguro: si algo se corta, reintentar no duplica (upsert por wise_id).
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

  const url = `${process.env.SUPABASE_URL}/rest/v1/encuestas?on_conflict=wise_id`;
  const TAM_LOTE = 200; // ~200 filas por request: cómodo aunque cada una traiga su "raw"
  let insertados = 0;

  for (let i = 0; i < registros.length; i += TAM_LOTE) {
    const parte = registros.slice(i, i + TAM_LOTE);

    // Serializamos y limpiamos el TEXTO final, cubriendo dos casos que
    // Postgres rechaza: el byte nulo real y la secuencia escapada "\u0000"
    // (que JSON.stringify puede generar y Postgres no acepta como texto).
    let payload = JSON.stringify(parte)
      .replace(/\\u0000/g, "")   // literal escapado \u0000
      .replace(/\u0000/g, "");    // byte nulo real por las dudas

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
      const nroLote = Math.floor(i / TAM_LOTE) + 1;
      throw new Error(`Supabase upsert falló en el lote ${nroLote} (${res.status}): ${t}`);
    }
    insertados += parte.length;
  }
  return { insertados };
}

// ------------------------------------------------------------
//  Handler principal
// ------------------------------------------------------------

// Pedimos más tiempo de ejecución para meses grandes. En el plan Hobby de
// Vercel esto se recorta solo a 60s (no da error); en planes pagos da margen
// para que la generación del reporte en Wise + el upsert entren cómodos.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  // Protección: solo corre si viene del cron de Vercel o con el secreto correcto
  const esCron = req.headers["x-vercel-cron"] === "1";
  const keyOk = req.query.key && req.query.key === process.env.SYNC_SECRET;
  if (!esCron && !keyOk) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {
    // Rango de fechas. Formato yyyy-MM-dd.
    // Si vienen en la URL (date_from/date_to) se usan tal cual (sirve para
    // backfills puntuales, ej: recuperar el 3/8 con date_from=2026-08-01&date_to=2026-08-03).
    // Si no vienen (ej: cron), la ventana es el MES ACTUAL y DINÁMICO:
    // del día 1 del mes en curso hasta hoy. Como el sync es aditivo (upsert),
    // cada corrida re-cubre todo el mes sin perder lo ya guardado, y los meses
    // anteriores quedan intactos en Supabase (nunca se borran).
    let dateFrom = req.query.date_from || null;
    let dateTo   = req.query.date_to   || null;
    if (!dateFrom || !dateTo) {
      const hoy = new Date();
      dateTo = hoy.toISOString().slice(0, 10);
      const primeroDeMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      dateFrom = primeroDeMes.toISOString().slice(0, 10);
    }

    const token = await autenticar();
    const { exportId, raw: exportRaw } = await iniciarExport(token, dateFrom, dateTo);

    // modo diagnóstico: /api/sync-encuestas?key=...&debug=1
    // muestra qué devolvió Wise al iniciar el export, sin esperar el resto
    if (req.query.debug === "1") {
      return res.status(200).json({
        ok: true,
        modo: "debug",
        rango_pedido: { date_from: dateFrom, date_to: dateTo },
        export_id_detectado: exportId,
        respuesta_cruda_del_export: exportRaw,
      });
    }

    const reportUrl = await esperarReporte(token, exportId);
    const filas = await descargarFilas(reportUrl);

    // Mapear y quedarnos SOLO con las respondidas (descarta las no contestadas)
    let registros = filas.map(mapearFila);
    const antesDeFiltrar = registros.length;
    registros = registros.filter(esRespondida);

    const r = await guardarEnSupabase(registros);

    return res.status(200).json({
      ok: true,
      rango_pedido: { date_from: dateFrom, date_to: dateTo },
      filas_recibidas: antesDeFiltrar,
      respondidas: registros.length,
      registros_guardados: r.insertados,
      muestra: registros.slice(0, 2), // primeras 2 para verificar el mapeo
    });
  } catch (err) {
    console.error("sync-encuestas error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
