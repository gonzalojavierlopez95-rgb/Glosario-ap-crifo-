export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/comunidad/aportar" && request.method === "POST") {
      return handleAportar(request, env);
    }

    // Todo lo demás sigue funcionando igual que antes (tu app estática)
    return env.ASSETS.fetch(request);
  }
};

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
