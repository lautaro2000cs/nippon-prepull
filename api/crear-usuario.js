// ============================================================================
//  NIPPON CAR — POST /api/crear-usuario
//  Crea un usuario de punta a punta:
//    1) valida que quien llama sea un ADMIN autenticado (por su token),
//    2) crea la cuenta en Supabase Auth con una contraseña temporal,
//    3) crea/actualiza la fila en la tabla 'usuarios' (rol, sucursal, etc.),
//    4) devuelve la contraseña temporal para entregársela a la persona.
//
//  Variables de entorno necesarias (ya deberías tener las dos primeras):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY   (llave de administrador; NUNCA va al front)
//
//  Seguridad: el front manda el token del admin en el header Authorization.
//  El endpoint verifica ese token contra Supabase y comprueba que su rol sea
//  'admin' ANTES de crear nada. Sin token de admin válido -> 401/403.
// ============================================================================

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Cliente admin (saltea RLS). Solo se usa en el servidor.
const admin = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Genera una contraseña temporal fuerte y legible
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
    // ---- 1) Autorización: ¿quién llama es admin? --------------------------
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: "Falta el token de sesión" });

    // valida el token y obtiene el usuario de Auth
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ ok: false, error: "Sesión inválida" });
    }
    const callerEmail = (userData.user.email || "").toLowerCase();

    // comprueba que ese email tenga rol admin en la tabla usuarios
    const { data: perfilCaller } = await admin
      .from("usuarios").select("rol").ilike("email", callerEmail).maybeSingle();
    if (!perfilCaller || perfilCaller.rol !== "admin") {
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

    if (!nombre || !email || !rol) {
      return res.status(400).json({ ok: false, error: "Faltan datos: nombre, correo y rol son obligatorios" });
    }
    if (!email.includes("@")) {
      return res.status(400).json({ ok: false, error: "El correo no es válido" });
    }

    // valida que el rol exista en el catálogo
    const { data: rolRow } = await admin.from("roles").select("id").eq("id", rol).maybeSingle();
    if (!rolRow) return res.status(400).json({ ok: false, error: `El rol '${rol}' no existe` });

    const username = slugUsername(nombre, email);

    // ---- 3) Crear la cuenta en Auth --------------------------------------
    const password = tempPass();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nombre, rol },
    });
    if (createErr) {
      // caso típico: el correo ya existe en Auth
      return res.status(409).json({ ok: false, error: "No se pudo crear la cuenta: " + createErr.message });
    }

    // ---- 4) Crear/actualizar la fila en 'usuarios' -----------------------
    const fila = {
      username, nombre, email, rol,
      sucursal_fija: sucursalFija,
      sucursales_asignadas: sucursalesAsignadas,
      asesor_wise: asesorWise,
      debe_cambiar_password: true,
    };
    // upsert por email para no duplicar si ya había una fila
    const { error: upErr } = await admin
      .from("usuarios").upsert(fila, { onConflict: "email" });
    if (upErr) {
      return res.status(500).json({ ok: false, error: "Cuenta creada, pero falló guardar el perfil: " + upErr.message });
    }

    // ---- 5) Permisos extra por persona (overrides) -----------------------
    if (permisosExtra.length) {
      const rows = permisosExtra.map((p) => ({ username, permiso: p, efecto: "grant" }));
      await admin.from("usuario_permiso").upsert(rows, { onConflict: "username,permiso" });
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
