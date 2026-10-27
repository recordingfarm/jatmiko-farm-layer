/* Jatmiko Farm Layer — Service Worker v5.0
 * - Halaman (HTML): jaringan dulu (maks 3 dtk), lalu cadangan dari cache → buka cepat walau sinyal jelek.
 * - CSS/JS/gambar/font/ikon: tampil dari cache seketika, diperbarui diam-diam di latar.
 * - Permintaan ke Apps Script (data) TIDAK pernah disentuh. */
const V = 'agl-v5.0';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (/(^|\.)script\.google\.com$|googleusercontent\.com$/.test(u.hostname)) return;
  const sama = u.origin === location.origin;
  const cdn = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)$/.test(u.hostname);
  if (!sama && !cdn) return;
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(V);
      const jaringan = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; });
      const batas = new Promise(res => setTimeout(() => res(null), 3000));
      try {
        const r = await Promise.race([jaringan, batas]);
        if (r) return r;
        const m = await c.match(req, { ignoreSearch: true }) || await c.match('index.html') || await c.match('./');
        return m || jaringan;
      } catch (err) {
        return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html')) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(V);
    const m = await c.match(req);
    const f = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => m);
    return m || f;
  })());
});
