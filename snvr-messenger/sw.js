const CACHE = "snvr-messenger-v2";
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(["/", "/index.html", "/manifest.json"]);
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var u = e.request.url;
  if (u.includes("/health") || u.includes(":3000") || e.request.method !== "GET") return;
  if (!u.match(/\.(html|js|css|png|jpg|json|ico)$/) && !u.endsWith("/") && !u.match(/\/index\.html?$/)) return;
  e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
});
