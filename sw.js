// v22 — only cache LOCAL files so install never fails due to CDN errors
const CACHE_NAME = 'seraj-cache-v22';
const LOCAL_ASSETS = ['index.html', 'manifest.json', 'icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(LOCAL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Only cache same-origin or successful CORS responses — never opaque responses
        if (response && response.status === 200 && response.type !== 'opaque') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy));
        }
        return response;
      }).catch(() => {});
    })
  );
});

self.addEventListener('push', (e) => {
  try {
    const data = e.data ? e.data.json() : {};
    const title = data.title || 'سراج';
    const body  = data.body  || data.message || '';
    e.waitUntil(
      self.registration.showNotification(title, {
        body, icon: 'icon.png', badge: 'icon.png',
        vibrate: [200, 100, 200], dir: 'rtl'
      })
    );
  } catch (err) {
    const text = e.data ? e.data.text() : 'تنبيه جديد من سراج';
    e.waitUntil(self.registration.showNotification('سراج', { body: text, icon: 'icon.png', dir: 'rtl' }));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
