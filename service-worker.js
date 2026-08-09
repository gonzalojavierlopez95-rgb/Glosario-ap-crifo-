const CACHE_NAME = 'glosario-apocrifo-cache-v21';
const FONTS_CACHE = 'glosario-apocrifo-fonts-v1';

/* --- app shell: HTML (con CSS/JS inline), manifest e iconos ---
   IMPORTANTE: cada archivo de esta lista tiene que existir con ese
   nombre exacto en el repo. Si uno solo falla, cache.addAll() aborta
   TODO el guardado en caché (es atómico) y la app queda sin caché
   real, sirviendo a veces versiones viejas/incompletas. */
const APP_SHELL = [
  './',
  './index.html',
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

  /* Navegaciones (entrar a la app, volver con la flechita, refrescar, etc.):
     SIEMPRE se resuelven contra la misma clave de caché ('./index.html'),
     sin importar si el navegador pidió './' o './index.html'.
     Esto evita que queden dos copias de la app desincronizadas: una
     actualizada (con sidebar, toggle, footer nuevos) y otra vieja,
     sirviéndose de forma intercambiable según cómo se disparó la navegación. */
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cachedResponse) => {
        const networkFetch = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', responseClone));
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || networkFetch;
      })
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
