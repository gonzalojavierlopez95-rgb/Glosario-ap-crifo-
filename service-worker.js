const CACHE_NAME = 'glosario-apocrifo-cache-v32';
const FONTS_CACHE = 'glosario-apocrifo-fonts-v1';

/* --- app shell: HTML (con CSS/JS inline), manifest e iconos ---
   IMPORTANTE: cada archivo de esta lista tiene que existir con ese
   nombre exacto en el repo. A diferencia de antes, ahora cada archivo
   se cachea por separado: si uno falla, los demás igual quedan
   guardados (antes, con cache.addAll, un solo error tiraba abajo
   TODO el cacheo y la app quedaba sin caché real). */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './offline.html'
];

/* --- fuentes de Google que usa la app: se precargan desde el arranque
   para que funcionen offline aunque el usuario nunca haya tenido
   conexión mientras usaba la app (agregá/quitá URLs si cambian las
   fuentes que usás en el HTML). --- */
const FONT_URLS = [
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=UnifrakturMaguntia&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap'
];

/* --- instalación: precachea el shell nuevo, precarga fuentes,
   y toma el control apenas está listo --- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Cachea cada archivo del app shell por separado (más resistente a fallos)
      const shellCache = await caches.open(CACHE_NAME);
      await Promise.all(
        APP_SHELL.map((url) =>
          shellCache.add(url).catch((err) => {
            console.warn('[SW] No se pudo cachear (se ignora, sigue el resto):', url, err);
          })
        )
      );

      // Precarga las fuentes de Google en su propia caché persistente
      if (FONT_URLS.length > 0) {
        const fontsCache = await caches.open(FONTS_CACHE);
        await Promise.all(
          FONT_URLS.map((url) =>
            fontsCache.add(url).catch((err) => {
              console.warn('[SW] No se pudo precargar fuente (se ignora):', url, err);
            })
          )
        );
      }

      // OJO: acá NO se llama a skipWaiting() automáticamente.
      // Esta versión nueva se queda "esperando" (waiting) hasta que el
      // usuario toque el botón "Actualizar" en el menú ⋮ (ver mensaje
      // SKIP_WAITING más abajo). Así el usuario decide cuándo aplicar
      // la actualización, en vez de que la app se recargue sola.
    })()
  );
});

/* --- mensaje desde la página: el usuario tocó "Actualizar" en el menú ⋮ ---
   Recién ahí esta versión nueva pasa de "esperando" a activarse. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* --- activación: limpia caches viejos, toma control de todas las pestañas
       y les avisa que hay una versión nueva activa --- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== FONTS_CACHE) // preserva la cache de fuentes
          .map((key) => caches.delete(key))
      );

      await self.clients.claim(); // pasa a controlar las pestañas ya abiertas, sin recargar manualmente

      // avisa a todas las pestañas abiertas (para que puedan recargarse solas)
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clientsList.forEach((client) => client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_NAME }));
    })()
  );
});

function esRecursoDeFuente(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

/* --- fetch --- */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  /* Pedidos a la API (votar, palabras, colecciones, stats, etc.): nunca
     se cachean. Siempre van directo al servidor, porque son datos que
     cambian todo el tiempo (por ejemplo, si vos ya votaste una palabra
     o no). Si se cachean, el usuario ve datos viejos aunque el servidor
     ya tenga los nuevos. */
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  /* Fuentes de Google: cache-first persistente, no se borra entre versiones */
  if (esRecursoDeFuente(url)) {
    event.respondWith(
      caches.open(FONTS_CACHE).then((cache) =>
        cache.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          return fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                cache.put(event.request, networkResponse.clone());
              }
              return networkResponse;
            })
            .catch(() => cachedResponse);
        })
      )
    );
    return;
  }

  /* Navegaciones (entrar a la app, volver con la flechita, refrescar, etc.):
     red primero, caché como respaldo. Antes esto era al revés (caché
     primero, red en segundo plano) — eso hacía que SIEMPRE se viera la
     versión guardada, y la nueva recién aparecía en la SEGUNDA entrada
     a la app. Ahora se intenta traer la versión más fresca del servidor
     de entrada; solo si no hay conexión (o el pedido falla) se cae a la
     copia guardada, y si tampoco hay nada guardado, a './offline.html'.

     SIEMPRE se resuelve contra la misma clave de caché ('./index.html'),
     sin importar si el navegador pidió './' o './index.html', para no
     tener dos copias desincronizadas dando vueltas. */
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', responseClone));
          }
          return networkResponse;
        })
        .catch(() =>
          caches.match('./index.html').then((cachedResponse) => cachedResponse || caches.match('./offline.html'))
        )
    );
    return;
  }

  /* Resto de recursos propios (manifest, iconos, etc.):
     cache-first con actualización en segundo plano */
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const networkFetch = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || networkFetch;
    })
  );
});
