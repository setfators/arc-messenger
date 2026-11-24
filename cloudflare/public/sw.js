/* Service worker приложения «Arc».
   Кэширует оболочку, чтобы приложение открывалось с иконки даже при плохой сети.
   Сообщения и голос не кэшируются: они идут по WebSocket. */
const CACHE = 'arc-shell-v11';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/favicon.ico',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;

  const isDocument = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isDocument) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Кэшируем только удачные ответы: иначе одна ошибка сервера
          // подменит приложению страницу входа.
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});

/* Web Push: сервер присылает пустое сообщение, текст не передаём (экономит
   криптографию), поэтому показываем общее уведомление. Если приложение уже
   открыто на экране, уведомление не дублируем — там свои счётчики и звук. */
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        const visible = list.some((client) => client.visibilityState === 'visible');
        if (visible) return null;
        return self.registration.showNotification('Arc', {
          body: 'Новое сообщение',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'messenger-message',
          renotify: true,
          data: { url: '/' },
        });
      })
      .catch(() => {})
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          if (client.navigate) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return null;
    })
  );
});

