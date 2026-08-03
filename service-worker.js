const CACHE_NAME = 'glosario-apocrifo-cache-v7';
const FONTS_CACHE = 'glosario-apocrifo-fonts-v1';

/* --- app shell: HTML (con CSS/JS inline), manifest e iconos --- */
const APP_SHELL = [
  './',
  './index.html',
  './glosario_apocrifo_indice.html',
  './manifest.json',
  './icon-512.png'
];

/* --- instalación: precachea el shell nuevo y toma el control apenas está listo --- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {
        /* si alguno de los recursos no existe con ese nombre exacto,
           no rompemos la instalación */
      })
      .then(() => self.skipWaiting()) // activa esta versión sin esperar a que se cierren las pestañas viejas
  );
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

  /* HTML, CSS/JS inline, iconos e imágenes propias:
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
