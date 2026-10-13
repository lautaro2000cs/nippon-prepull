// ============================================================
//  /api/wise-webhook.js
//  Receptor de WEBHOOK de Wise CX (Vercel Serverless Function).
//
//  Wise empuja cada respuesta de encuesta a esta URL apenas el cliente
//  responde. NO usa el sistema de exportación de Wise -> no consume el cupo
//  y llega en tiempo real.
//
//  CONFIGURACIÓN EN WISE:
//    URL destino:  https://nippon-prepull.vercel.app/api/wise-webhook?key=TU_SYNC_SECRET
//    Método:       POST  (Content-Type: application/json)
//
//  Qué hace:
//   1) Valida la clave (?key= o header x-webhook-key).
//   2) Guarda el payload CRUDO en wise_webhook_raw (respaldo + calibración).
//   3) Intenta mapear la respuesta a la tabla 'encuestas' (best-effort, con
//      la misma lógica de detección por nombre de campo del sync). Si puede
//      identificar la respuesta (N° de orden / dominio+fechas), hace upsert.
//   4) Responde 200 rápido (los webhooks esperan un 2xx inmediato).
// ============================================================

const crypto = require("crypto");

export const config = { maxDuration: 30 };

// --- normalización / detección (misma idea que el sync) -----
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function aNota(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "" || /^s\/?d$/i.test(s)) return null;
  const n = Number(s);
  return (!isNaN(n) && n >= 0 && n <= 10) ? n : null;
}

// Aplana un objeto/payload anidado a pares { "ruta o pregunta": valor }.
// Maneja además arrays de respuestas tipo [{question/pregunta, answer/valor}].
function aplanar(obj, out, prefijo) {
  out = out || {};
  prefijo = prefijo || "";
  if (obj == null) return out;
  if (Array.isArray(obj)) {
    // ¿array de {pregunta, respuesta}?
    for (const it of obj) {
      if (it && typeof it === "object") {
        const q = it.question ?? it.pregunta ?? it.label ?? it.titulo ?? it.name ?? it.text ?? it.enunciado;
        const a = it.answer ?? it.respuesta ?? it.value ?? it.valor ?? it.score ?? it.puntaje ?? it.rating;
        if (q != null && a != null) { out[String(q)] = a; continue; }
      }
      aplanar(it, out, prefijo);
    }
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefijo ? prefijo + " " + k : k;
      if (v && typeof v === "object") aplanar(v, out, key);
      else out[key] = v;
    }
    return out;
  }
  return out;
}

function buscarClave(flat, terminos) {
  const claves = Object.keys(flat);
  for (const t of terminos) {
    const f = claves.find((k) => norm(k).includes(t));
    if (f) return f;
  }
  return null;
}
function claveConPalabras(flat, palabras) {
  return Object.keys(flat).find((k) => { const nk = norm(k); return palabras.every((p) => nk.includes(norm(p))); }) || null;
}
function notaPorPalabras(flat, palabras) {
  for (const [k, v] of Object.entries(flat)) {
    const nk = norm(k);
    if (palabras.every((p) => nk.includes(norm(p)))) return aNota(v);
  }
  return null;
}

function extraerPreguntas(flat) {
  return {
    p_amabilidad:  notaPorPalabras(flat, ["amabilidad"]),
    p_atencion:    notaPorPalabras(flat, ["atencion", "solicitudes"]),
    p_puntualidad: notaPorPalabras(flat, ["puntualidad"]),
    p_explicacion: notaPorPalabras(flat, ["explicacion"]),
    p_limpieza:    notaPorPalabras(flat, ["limpieza"]),
    p_turnos:      notaPorPalabras(flat, ["facilidad", "turnos"]),
    p_espera:      notaPorPalabras(flat, ["tiempo", "espera"]),
    p_calidad:     notaPorPalabras(flat, ["calidad", "servicio", "prestado"]),
    p_recomienda:  notaPorPalabras(flat, ["recomiende"]),
  };
}
function extraerComentario(flat) {
  for (const [k, v] of Object.entries(flat)) {
    const nk = norm(k);
    if ((nk.includes("sugerencias") || nk.includes("comentario")) && String(v).trim() && String(v).trim() !== "S/D") return String(v).trim();
  }
  return null;
}

// Mapea una respuesta (payload de webhook) a una fila de 'encuestas'.
// Devuelve null si no puede identificarla (sin orden ni dominio/fechas).
function mapearRespuesta(resp) {
  const flat = aplanar(resp, {});

  const kAsesor   = buscarClave(flat, ["agente", "asesor", "usuario", "user"]);
  const kSucursal = buscarClave(flat, ["sucursal", "branch"]);
  const kServicio = buscarClave(flat, ["servicio", "service"]);
  const kDominio  = buscarClave(flat, ["dominio", "patente", "domain"]);
  const kTelefono = claveConPalabras(flat, ["contacto", "telefono"]) || buscarClave(flat, ["telefono", "phone", "celular"]);
  const claves = Object.keys(flat);
  const kNroOrden =
    claves.find((k) => { const n = norm(k); return n.includes("orden") && !n.includes("grupo") && (n.includes("n° orden") || n.includes("n orden") || n.includes("nro")); })
    || claves.find((k) => { const n = norm(k); return n.includes("contacto") && n.includes("orden") && !n.includes("grupo"); })
    || null;
  const kEncuesta = buscarClave(flat, ["encuesta", "survey"]);
  const kFechaResp  = claveConPalabras(flat, ["fecha", "respuesta"]) || claveConPalabras(flat, ["response", "date"]);
  const kFechaEnvio = claveConPalabras(flat, ["fecha", "envio"]) || claveConPalabras(flat, ["survey", "sent"]) || claveConPalabras(flat, ["fecha", "creado"]);
  const kFecha = kFechaEnvio || buscarClave(flat, ["fecha", "date", "survey_sent", "created"]);

  const preguntas = extraerPreguntas(flat);
  const cinco = [preguntas.p_amabilidad, preguntas.p_atencion, preguntas.p_puntualidad, preguntas.p_explicacion, preguntas.p_limpieza].filter((n) => n != null);
  const promedio = cinco.length ? Math.round((cinco.reduce((a, b) => a + b, 0) / cinco.length) * 100) / 100 : null;

  const normId = (v) => String(v ?? "").trim().toLowerCase();
  const ordenRaw = kNroOrden ? flat[kNroOrden] : null;
  const domRaw   = kDominio ? flat[kDominio] : null;
  const envioRaw = kFecha ? flat[kFecha] : null;
  const respRaw  = kFechaResp ? flat[kFechaResp] : null;

  // identificación mínima: con orden, o con dominio+fechas
  let claveId;
  if (ordenRaw && String(ordenRaw).trim()) claveId = "ord|" + normId(ordenRaw);
  else if ((domRaw && String(domRaw).trim()) || respRaw) claveId = "sin-orden|" + normId(domRaw) + "|" + normId(envioRaw) + "|" + normId(respRaw);
  else return null;  // no se puede identificar -> solo queda el raw

  const wiseId = "enc_" + crypto.createHash("md5").update(claveId).digest("hex");

  const parseFecha = (val) => { if (!val) return null; const d = new Date(String(val).replace(" ", "T")); return isNaN(d.getTime()) ? null : d.toISOString(); };

  const row = {
    wise_id: wiseId,
    fecha: parseFecha(envioRaw),
    fecha_respuesta: parseFecha(respRaw),
    asesor: kAsesor ? flat[kAsesor] : null,
    ...preguntas,
    promedio_asesor: promedio,
    comentario: extraerComentario(flat),
    puntuacion_prom: promedio,
    puntuacion: promedio,
    sucursal: kSucursal ? flat[kSucursal] : null,
    servicio: kServicio ? flat[kServicio] : null,
    dominio: kDominio ? flat[kDominio] : null,
    telefono: kTelefono ? flat[kTelefono] : null,
    nro_orden: kNroOrden ? flat[kNroOrden] : null,
    encuesta: kEncuesta ? flat[kEncuesta] : null,
    raw: resp,
    sincronizado_en: new Date().toISOString(),
  };
  return row;
}

// --- Supabase REST ------------------------------------------
async function sbInsert(tabla, filas, onConflict) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${tabla}` + (onConflict ? `?on_conflict=${onConflict}` : "");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      Prefer: (onConflict ? "resolution=merge-duplicates," : "") + "return=minimal",
    },
    body: JSON.stringify(filas),
  });
  if (!res.ok) throw new Error(`${tabla} ${res.status}: ${await res.text()}`);
}

// --- Handler -------------------------------------------------
export default async function handler(req, res) {
  // Verificación simple (GET): algunos paneles hacen un ping antes de activar.
  if (req.method === "GET") return res.status(200).json({ ok: true, listo: "webhook activo" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });

  // Seguridad: clave por query o header.
  const key = req.query.key || req.headers["x-webhook-key"];
  if (!key || key !== process.env.SYNC_SECRET) return res.status(401).json({ ok: false, error: "No autorizado" });

  try {
    // Body: Vercel ya parsea JSON. Soportamos objeto, array, o envoltorios comunes.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = { texto: body }; } }
    let items = [];
    if (Array.isArray(body)) items = body;
    else if (Array.isArray(body?.data)) items = body.data;
    else if (Array.isArray(body?.responses)) items = body.responses;
    else if (Array.isArray(body?.results)) items = body.results;
    else if (body?.response) items = [body.response];
    else if (body) items = [body];

    const rawRows = [];
    const encRows = [];
    for (const it of items) {
      let mapped = null;
      try { mapped = mapearRespuesta(it); } catch (e) { /* seguimos con el raw */ }
      if (mapped) encRows.push(mapped);
      rawRows.push({ payload: it, mapeado: !!mapped, wise_id: mapped ? mapped.wise_id : null });
    }

    // Siempre guardamos el crudo (respaldo + calibración del mapeo).
    if (rawRows.length) { try { await sbInsert("wise_webhook_raw", rawRows); } catch (e) { console.warn("raw:", e.message); } }
    // Y las que pudimos mapear, a 'encuestas' (upsert por wise_id).
    if (encRows.length) await sbInsert("encuestas", encRows, "wise_id");

    return res.status(200).json({ ok: true, recibidas: items.length, mapeadas: encRows.length });
  } catch (err) {
    console.error("wise-webhook error:", err);
    // Igual devolvemos 200 para que Wise no reintente en loop; el raw queda guardado.
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }
}
