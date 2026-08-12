
const ADMIN_KEY = "Khazvel_apocrifo33";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/comunidad/aportar" && request.method === "POST") {
      return handleAportar(request, env);
    }

    if (url.pathname === "/api/comunidad/pendientes" && request.method === "GET") {
      return handlePendientes(request, env);
    }

    if (url.pathname === "/api/comunidad/moderar" && request.method === "PATCH") {
      return handleModerar(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

function checkAuth(request) {
  const key = request.headers.get("X-Admin-Key");
  return key === ADMIN_KEY;
}

async function handleAportar(request, env) {
  try {
    const body = await request.json();
    const { palabra, significado, estilos, autor } = body;

    if (!palabra || !significado) {
      return new Response(JSON.stringify({ error: "Falta palabra o significado" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const fecha = new Date().toISOString();
    const autorFinal = autor && autor.trim() ? autor.trim() : "anonimo";

    const result = await env.DB.prepare(
      `INSERT INTO words (palabra, significado, autor_id, estado, fecha_creacion) VALUES (?, ?, ?, 'pendiente', ?)`
    ).bind(palabra.trim(), significado.trim(), autorFinal, fecha).run();

    const wordId = result.meta.last_row_id;

    if (Array.isArray(estilos) && estilos.length > 0) {
      for (const styleId of estilos) {
        await env.DB.prepare(
          `INSERT INTO word_styles (word_id, style_id) VALUES (?, ?)`
        ).bind(wordId, styleId).run();
      }
    }

    return new Response(JSON.stringify({ ok: true, id: wordId, estado: "pendiente" }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Error al guardar el aporte", detalle: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

async function handlePendientes(request, env) {
  if (!checkAuth(request)) {
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, palabra, significado, autor_id, fecha_creacion FROM words WHERE estado = 'pendiente' ORDER BY fecha_creacion DESC`
  ).all();

  return new Response(JSON.stringify({ pendientes: results }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleModerar(request, env) {
  if (!checkAuth(request)) {
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await request.json();
    const { id, accion } = body;

    if (!id || !["aprobar", "rechazar"].includes(accion)) {
      return new Response(JSON.stringify({ error: "Datos inválidos" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const nuevoEstado = accion === "aprobar" ? "aprobado" : "rechazado";

    await env.DB.prepare(
      `UPDATE words SET estado = ? WHERE id = ?`
    ).bind(nuevoEstado, id).run();

    return new Response(JSON.stringify({ ok: true, id, estado: nuevoEstado }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Error al moderar", detalle: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
