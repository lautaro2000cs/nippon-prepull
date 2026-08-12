// ============================================================================
//  NIPPON CAR — POST /api/eliminar-usuario   (sin dependencias, con fetch)
//  Elimina un usuario de forma completa y segura:
//    1) valida que quien llama sea ADMIN (por su token),
//    2) no permite que un admin se borre a sí mismo,
//    3) borra la cuenta de Auth (si existe) y la fila de 'usuarios',
//    4) limpia sus overrides de permisos.
//
//  Body esperado: { id: "<uuid de la fila usuarios>" }
//
//  Variables de entorno (ya existen): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: "Faltan variables de entorno de Supabase" });
  }

  try {
    // ---- 1) Autorización: token válido y rol admin -----------------------
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
      return res.status(403).json({ ok: false, error: "Solo un administrador puede eliminar usuarios" });
    }

    // ---- 2) Datos del usuario a borrar -----------------------------------
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = (body.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Falta el id del usuario" });

    // traer la fila objetivo
    const tRes = await fetch(
      `${URL}/rest/v1/usuarios?select=id,username,nombre,email,rol&id=eq.${encodeURIComponent(id)}`,
      { headers: sbHeaders() }
    );
    const objetivo = (await tRes.json())?.[0];
    if (!objetivo) return res.status(404).json({ ok: false, error: "Ese usuario no existe" });

    // salvaguarda: no borrarse a sí mismo
    if ((objetivo.email || "").toLowerCase() === callerEmail) {
      return res.status(400).json({ ok: false, error: "No podés eliminar tu propia cuenta de admin" });
    }

    // ---- 3) Borrar de Auth (si tiene cuenta) -----------------------------
    if (objetivo.email) {
      const listRes = await fetch(
        `${URL}/auth/v1/admin/users?email=${encodeURIComponent(objetivo.email.toLowerCase())}`,
        { headers: sbHeaders() }
      );
      const listJson = await listRes.json();
      const authAcc = (listJson?.users || []).find(
        (u) => (u.email || "").toLowerCase() === objetivo.email.toLowerCase()
      );
      if (authAcc) {
        await fetch(`${URL}/auth/v1/admin/users/${authAcc.id}`, {
          method: "DELETE",
          headers: sbHeaders(),
        });
      }
    }

    // ---- 4) Borrar overrides de permisos y la fila -----------------------
    await fetch(`${URL}/rest/v1/usuario_permiso?username=eq.${encodeURIComponent(objetivo.username)}`, {
      method: "DELETE",
      headers: sbHeaders({ Prefer: "return=minimal" }),
    });
    const delRes = await fetch(`${URL}/rest/v1/usuarios?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: sbHeaders({ Prefer: "return=minimal" }),
    });
    if (!delRes.ok) {
      const t = await delRes.text();
      return res.status(500).json({ ok: false, error: "No se pudo borrar la fila: " + t });
    }

    return res.status(200).json({ ok: true, eliminado: { nombre: objetivo.nombre, email: objetivo.email } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Error inesperado" });
  }
}
