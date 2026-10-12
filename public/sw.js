// Bite & Sip service worker: notifications, and an offline page.
// It deliberately does not cache the app itself, so a new deploy is never
// hidden behind a stale copy.
const OFFLINE = '/offline.html'
const CACHE = 'bitesip-offline-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/brand/logo-192.png'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)))
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Bite & Sip', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Bite & Sip'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: !!data.sticky,
      icon: '/brand/logo-192.png',
      badge: '/brand/badge-96.png',
      vibrate: data.sticky ? [400, 150, 400, 150, 400, 150, 600] : [250, 100, 250],
      timestamp: Date.now(),
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => w.url === url) || wins.find((w) => new URL(w.url).pathname.startsWith(new URL(url).pathname.split('/').slice(0, 2).join('/')))
      if (same) return same.focus().then((w) => (w && w.url !== url && 'navigate' in w ? w.navigate(url) : w))
      return self.clients.openWindow(url)
    }),
  )
})
