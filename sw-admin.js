// Service worker mínimo del Panel Apócrifo (admin).
// No cachea nada: el panel siempre debe mostrar datos frescos del servidor.
// Su único propósito es cumplir el requisito técnico de Chrome/Android
// para que "admin.html" se pueda instalar como app independiente.

const SW_VERSION = 'admin-sw-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fetch pass-through: deja que todo pase directo a la red, sin cachear.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
