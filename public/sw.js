/* RektBull service worker: shows risk monitor alerts as browser notifications, even with the site closed. */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'RektBull alert', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'RektBull alert', {
    body: data.body || '', tag: data.tag, data: { url: data.url || '/safety' }, icon: '/favicon.ico',
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/safety', self.location.origin);
  if (url.origin !== self.location.origin) return; // only ever opens RektBull itself
  event.waitUntil(self.clients.openWindow(url.href));
});
