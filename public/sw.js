const CACHE = "brewtracker-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/brewtracker.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))));
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(payload.title || "BrewTracker Pro", {
    body: payload.body || "Aplikācijā ir jauni darbi.",
    icon: "/icons/brewtracker.svg",
    badge: "/icons/brewtracker.svg",
    tag: payload.tag || "brewtracker-daily",
    requireInteraction: true,
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => "focus" in client);
    if (!existing) return self.clients.openWindow(targetUrl);
    return existing.navigate(targetUrl).then((client) => client.focus());
  }));
});
