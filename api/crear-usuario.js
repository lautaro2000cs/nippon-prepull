// ============================================================================
//  NIPPON CAR — POST /api/crear-usuario   (versión SIN dependencias)
//  Usa fetch directo a la API de Supabase, así no necesita el paquete
//  @supabase/supabase-js (tu sync-encuestas.js tampoco lo usa).
//
//  Crea un usuario de punta a punta:
//    1) valida que quien llama sea ADMIN (por su token),
//    2) crea la cuenta en Supabase Auth con contraseña temporal,
//    3) crea/actualiza la fila en 'usuarios',
//    4) aplica permisos extra por persona,
//    5) devuelve la contraseña temporal.
//
//  Variables de entorno (ya existen por el endpoint de sync):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

function tempPass() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return "NIC-" + s;
}

function slugUsername(nombre, email) {
  const base = (email || "").split("@")[0].trim().toLowerCase();
  if (base) return base;
  return (nombre || "usuario").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: "Faltan variables de entorno de Supabase" });
  }

  try {
    // ---- 1) Autorización: validar token y que sea admin ------------------
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: "Falta el token de sesión" });

    const uRes = await fetch(`${URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + token },
    });
    if (!uRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const authUser = await uRes.json();
    const callerEmail = (authUser?.email || "").toLowerCase();
    if (!callerEmail) return res.status(401).json({ ok: false, error: "Sesión inválida" });

    const pRes = await fetch(
      `${URL}/rest/v1/usuarios?select=rol&email=ilike.${encodeURIComponent(callerEmail)}`,
      { headers: sbHeaders() }
    );
    const perfil = (await pRes.json())?.[0];
    if (!perfil || perfil.rol !== "admin") {
      return res.status(403).json({ ok: false, error: "Solo un administrador puede crear usuarios" });
    }

    // ---- 2) Datos del nuevo usuario --------------------------------------
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const nombre = (body.nombre || "").trim();
    const email = (body.email || "").trim().toLowerCase();
    const rol = (body.rol || "").trim();
    const sucursalFija = (body.sucursal_fija || "").trim() || null;
    const sucursalesAsignadas = (body.sucursales_asignadas || "").trim() || null;
    const asesorWise = (body.asesor_wise || "").trim() || null;
    const permisosExtra = Array.isArray(body.permisos_extra) ? body.permisos_extra : [];
    const reusarId = body.reusar_id || null; // id de una fila-agente a convertir en cuenta

    if (!nombre || !email || !rol) {
      return res.status(400).json({ ok: false, error: "Faltan datos: nombre, correo y rol son obligatorios" });
    }
    if (!email.includes("@")) {
      return res.status(400).json({ ok: false, error: "El correo no es válido" });
    }

    const rRes = await fetch(`${URL}/rest/v1/roles?select=id&id=eq.${encodeURIComponent(rol)}`, { headers: sbHeaders() });
    if (!((await rRes.json())?.length)) {
      return res.status(400).json({ ok: false, error: `El rol '${rol}' no existe` });
    }

    const username = slugUsername(nombre, email);
    const password = tempPass();

    // ---- 3) Crear cuenta en Auth (Admin API) -----------------------------
    const cRes = await fetch(`${URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { nombre, rol } }),
    });
    if (!cRes.ok) {
      const t = await cRes.text();
      return res.status(409).json({ ok: false, error: "No se pudo crear la cuenta (¿el correo ya existe?): " + t });
    }

    // ---- 4) Guardar el perfil en 'usuarios' ------------------------------
    // Si viene reusar_id (convertir una agente existente en cuenta), actualizamos
    // ESA fila. Si no, upsert por email (alta normal, sin duplicar).
    const fila = {
      username, nombre, email, rol,
      sucursal_fija: sucursalFija,
      sucursales_asignadas: sucursalesAsignadas,
      asesor_wise: asesorWise,
      debe_cambiar_password: true,
    };
    let upRes;
    if (reusarId) {
      upRes = await fetch(`${URL}/rest/v1/usuarios?id=eq.${encodeURIComponent(reusarId)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify(fila),
      });
    } else {
      upRes = await fetch(`${URL}/rest/v1/usuarios?on_conflict=email`, {
        method: "POST",
        headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(fila),
      });
    }
    if (!upRes.ok) {
      const t = await upRes.text();
      return res.status(500).json({ ok: false, error: "Cuenta creada, pero falló guardar el perfil: " + t });
    }

    // ---- 5) Permisos extra por persona -----------------------------------
    if (permisosExtra.length) {
      const rows = permisosExtra.map((p) => ({ username, permiso: p, efecto: "grant" }));
      await fetch(`${URL}/rest/v1/usuario_permiso?on_conflict=username,permiso`, {
        method: "POST",
        headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(rows),
      });
    }

    return res.status(200).json({
      ok: true,
      usuario: { username, nombre, email, rol },
      password_temporal: password,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Error inesperado" });
  }
}
