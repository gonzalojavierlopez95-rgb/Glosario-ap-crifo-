
const ADMIN_KEY = "Khazvel_apocrifo33";
const LIMITE_APORTES_DIARIO = 5;

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

    if (url.pathname === "/api/comunidad/palabras" && request.method === "GET") {
      return handlePalabras(request, env);
    }

    if (url.pathname === "/api/comunidad/estilos" && request.method === "GET") {
      return handleEstilos(request, env);
    }

    if (url.pathname === "/api/comunidad/stats" && request.method === "GET") {
      return handleStats(request, env);
    }

    // FASE 5 — votos y colecciones
    if (url.pathname === "/api/comunidad/votar" && request.method === "POST") {
      return handleVotar(request, env);
    }

    if (url.pathname === "/api/comunidad/coleccion" && request.method === "POST") {
      return handleColeccionAgregar(request, env);
    }

    if (url.pathname === "/api/comunidad/coleccion" && request.method === "DELETE") {
      return handleColeccionQuitar(request, env);
    }

    if (url.pathname === "/api/comunidad/coleccion" && request.method === "GET") {
      return handleColeccionListar(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

function checkAuth(request) {
  const key = request.headers.get("X-Admin-Key");
  return key === ADMIN_KEY;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// FASE 6 — Rate limiting con KV.
// Se limita por IP (no por "autor", porque ese campo es texto libre y
// cualquiera podría cambiarlo para esquivar el límite). La clave en KV
// incluye la fecha (YYYY-MM-DD), así que el contador arranca de cero
// solo automáticamente cada día sin tener que borrar nada a mano —
// el propio 'expirationTtl' hace que la entrada desaparezca sola a
// las 24hs.
async function chequearYRegistrarAporte(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "desconocida";
  const hoy = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rateKey = `aportes:${ip}:${hoy}`;

  const actual = parseInt(await env.KV.get(rateKey)) || 0;

  if (actual >= LIMITE_APORTES_DIARIO) {
    return { permitido: false };
  }

  await env.KV.put(rateKey, String(actual + 1), { expirationTtl: 86400 });
  return { permitido: true };
}

async function handleAportar(request, env) {
  try {
    const body = await request.json();
    const { palabra, significado, estilos, autor } = body;

    if (!palabra || !significado) {
      return json({ error: "Falta palabra o significado" }, 400);
    }

    const rate = await chequearYRegistrarAporte(request, env);
    if (!rate.permitido) {
      return json({
        error: `Llegaste al límite de ${LIMITE_APORTES_DIARIO} aportes por hoy. Probá de nuevo mañana.`
      }, 429);
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

    return json({ ok: true, id: wordId, estado: "pendiente" }, 201);

  } catch (err) {
    return json({ error: "Error al guardar el aporte", detalle: err.message }, 500);
  }
}

async function handlePendientes(request, env) {
  if (!checkAuth(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, palabra, significado, autor_id, fecha_creacion FROM words WHERE estado = 'pendiente' ORDER BY fecha_creacion DESC`
  ).all();

  return json({ pendientes: results });
}

async function handleModerar(request, env) {
  if (!checkAuth(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  try {
    const body = await request.json();
    const { id, accion } = body;

    if (!id || !["aprobar", "rechazar"].includes(accion)) {
      return json({ error: "Datos inválidos" }, 400);
    }

    const nuevoEstado = accion === "aprobar" ? "aprobado" : "rechazado";

    await env.DB.prepare(
      `UPDATE words SET estado = ? WHERE id = ?`
    ).bind(nuevoEstado, id).run();

    return json({ ok: true, id, estado: nuevoEstado });

  } catch (err) {
    return json({ error: "Error al moderar", detalle: err.message }, 500);
  }
}

// FASE 4 — Mostrar aportes aprobados en la app.
// GET /api/comunidad/palabras
//   sin parámetros   -> últimas palabras aprobadas (para "Tendencias")
//   ?estilo=<id>     -> palabras aprobadas que pertenecen a ese estilo
//   ?q=<texto>       -> busca por coincidencia en palabra o significado
// Los tres se pueden combinar (ej: ?estilo=3&q=luna).
async function handlePalabras(request, env) {
  try {
    const url = new URL(request.url);
    const estilo = url.searchParams.get("estilo");
    const q = (url.searchParams.get("q") || "").trim();
    const usuarioId = url.searchParams.get("usuario_id") || "";

    // FASE 5: se suma el conteo de votos (COUNT en vivo, sin columna
    // aparte) y si el usuario_id que pide la lista ya votó esta palabra,
    // para que la app pueda pintar el corazón lleno o vacío.
    let sql = `
      SELECT w.id, w.palabra, w.significado, w.autor_id, w.fecha_creacion,
             COUNT(DISTINCT v.id) AS votos,
             MAX(CASE WHEN v.usuario_id = ? THEN 1 ELSE 0 END) AS yo_vote
      FROM words w
      LEFT JOIN votes v ON v.word_id = w.id
    `;
    const condiciones = [`w.estado = 'aprobado'`];
    const binds = [usuarioId];

    if (estilo) {
      sql += ` JOIN word_styles ws ON ws.word_id = w.id `;
      condiciones.push(`ws.style_id = ?`);
      binds.push(estilo);
    }

    if (q) {
      condiciones.push(`(w.palabra LIKE ? OR w.significado LIKE ?)`);
      binds.push(`%${q}%`, `%${q}%`);
    }

    sql += ` WHERE ` + condiciones.join(" AND ");
    sql += ` GROUP BY w.id`;
    sql += ` ORDER BY w.fecha_creacion DESC LIMIT 50`;

    const stmt = env.DB.prepare(sql).bind(...binds);
    const { results } = await stmt.all();

    return json({ palabras: results });

  } catch (err) {
    return json({ error: "Error al buscar palabras", detalle: err.message }, 500);
  }
}

// GET /api/comunidad/estilos
// Devuelve todos los estilos cargados en D1, agrupados por categoria_padre
// (ej: 'Raíces', 'Época', 'Estilo', 'Apócrifo'), con la cantidad de palabras
// aprobadas que tiene cada uno (para marcar cuáles tienen contenido real
// y para armar el ranking de "Más aportadas"). Si todavía no cargaste
// estilos en la tabla 'styles', esto devuelve una lista vacía y la app
// lo maneja mostrando los acordeones sin contenido, sin romperse.
async function handleEstilos(request, env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT s.id, s.nombre, s.categoria_padre,
             COUNT(CASE WHEN w.estado = 'aprobado' THEN w.id END) AS aprobadas
      FROM styles s
      LEFT JOIN word_styles ws ON ws.style_id = s.id
      LEFT JOIN words w ON w.id = ws.word_id
      GROUP BY s.id, s.nombre, s.categoria_padre
      ORDER BY s.categoria_padre, s.nombre
    `).all();

    return json({ estilos: results });

  } catch (err) {
    return json({ error: "Error al buscar estilos", detalle: err.message }, 500);
  }
}

// GET /api/comunidad/stats
// Números reales para la barra de estadísticas de la Comunidad.
// "consultas" todavía no existe (llega en Fase 9), así que se
// devuelve en null y la app lo muestra como "—" sin inventar números.
async function handleStats(request, env) {
  try {
    const palabras = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM words WHERE estado = 'aprobado'`
    ).first();
    const aportes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM words`
    ).first();
    const votos = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM votes`
    ).first();

    return json({
      palabras: palabras.n,
      aportes: aportes.n,
      consultas: null,
      votos: votos.n
    });

  } catch (err) {
    return json({ error: "Error al buscar estadísticas", detalle: err.message }, 500);
  }
}

// FASE 5 — Votos y colecciones.
// No hay login, así que "usuario" es un id anónimo generado y guardado
// en el dispositivo (ver index.html). La tabla 'votes' tiene un UNIQUE
// (word_id, usuario_id) que impide el voto doble a nivel base de datos.

// POST /api/comunidad/votar { word_id, usuario_id }
// Toggle: si no había voto, lo crea. Si ya existía, lo saca.
async function handleVotar(request, env) {
  try {
    const body = await request.json();
    const { word_id, usuario_id } = body;

    if (!word_id || !usuario_id) {
      return json({ error: "Falta word_id o usuario_id" }, 400);
    }

    const existente = await env.DB.prepare(
      `SELECT id FROM votes WHERE word_id = ? AND usuario_id = ?`
    ).bind(word_id, usuario_id).first();

    if (existente) {
      await env.DB.prepare(`DELETE FROM votes WHERE id = ?`).bind(existente.id).run();
      return json({ ok: true, votado: false });
    }

    const fecha = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO votes (word_id, usuario_id, fecha) VALUES (?, ?, ?)`
    ).bind(word_id, usuario_id, fecha).run();

    return json({ ok: true, votado: true });

  } catch (err) {
    return json({ error: "Error al votar", detalle: err.message }, 500);
  }
}

// POST /api/comunidad/coleccion { usuario_id, style_id }
// Guarda un estilo como colección personal. INSERT OR IGNORE porque
// 'collections' tiene UNIQUE(usuario_id, style_id) — guardar dos veces
// no rompe nada, simplemente no duplica.
async function handleColeccionAgregar(request, env) {
  try {
    const body = await request.json();
    const { usuario_id, style_id } = body;

    if (!usuario_id || !style_id) {
      return json({ error: "Falta usuario_id o style_id" }, 400);
    }

    const fecha = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO collections (usuario_id, style_id, fecha) VALUES (?, ?, ?)`
    ).bind(usuario_id, style_id, fecha).run();

    return json({ ok: true }, 201);

  } catch (err) {
    return json({ error: "Error al guardar la colección", detalle: err.message }, 500);
  }
}

// DELETE /api/comunidad/coleccion { usuario_id, style_id }
async function handleColeccionQuitar(request, env) {
  try {
    const body = await request.json();
    const { usuario_id, style_id } = body;

    if (!usuario_id || !style_id) {
      return json({ error: "Falta usuario_id o style_id" }, 400);
    }

    await env.DB.prepare(
      `DELETE FROM collections WHERE usuario_id = ? AND style_id = ?`
    ).bind(usuario_id, style_id).run();

    return json({ ok: true });

  } catch (err) {
    return json({ error: "Error al quitar la colección", detalle: err.message }, 500);
  }
}

// GET /api/comunidad/coleccion?usuario_id=X
// Devuelve los estilos que ese usuario guardó como colección personal.
async function handleColeccionListar(request, env) {
  try {
    const url = new URL(request.url);
    const usuarioId = url.searchParams.get("usuario_id") || "";

    if (!usuarioId) {
      return json({ colecciones: [] });
    }

    const { results } = await env.DB.prepare(`
      SELECT s.id, s.nombre, s.categoria_padre
      FROM collections c
      JOIN styles s ON s.id = c.style_id
      WHERE c.usuario_id = ?
      ORDER BY s.categoria_padre, s.nombre
    `).bind(usuarioId).all();

    return json({ colecciones: results });

  } catch (err) {
    return json({ error: "Error al listar colecciones", detalle: err.message }, 500);
  }
}
