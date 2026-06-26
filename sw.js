// v24 — push debug logging to IndexedDB
const CACHE_NAME = 'seraj-cache-v24';
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

function logPushToIDB(ts, rawData) {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('seraj-push-log', 1);
      req.onupgradeneeded = ev => ev.target.result.createObjectStore('logs', { autoIncrement: true });
      req.onsuccess = ev => {
        const tx = ev.target.result.transaction('logs', 'readwrite');
        tx.objectStore('logs').add({ ts, raw: String(rawData).slice(0, 200) });
        tx.oncomplete = resolve;
        tx.onerror   = resolve;
      };
      req.onerror = resolve;
    } catch(e) { resolve(); }
  });
}

self.addEventListener('push', (e) => {
  const ts      = new Date().toISOString();
  const rawText = e.data ? e.data.text() : '';

  let title = 'سراج';
  let body  = '';
  try {
    const parsed = JSON.parse(rawText);
    title = parsed.title || 'سراج';
    body  = parsed.body  || parsed.message || '';
  } catch(_) {
    body = rawText || 'تنبيه جديد من سراج';
  }

  e.waitUntil(
    Promise.all([
      logPushToIDB(ts, rawText),
      self.registration.showNotification(title, {
        body, icon: 'icon.png', badge: 'icon.png',
        vibrate: [200, 100, 200], dir: 'rtl'
      })
    ])
  );
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
