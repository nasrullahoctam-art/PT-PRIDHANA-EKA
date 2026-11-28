/* Service worker PT. Pridhana Eka.
 * - Cangkang aplikasi (HTML, ikon, font, QR lib) di-cache agar terbuka cepat & tetap tampil saat offline.
 * - Permintaan ke Google Apps Script (data & upload) TIDAK PERNAH di-cache: selalu langsung ke jaringan.
 * Naikkan VERSION setiap mengganti index.html agar pengguna mendapat versi terbaru. */
const VERSION = 'pe-v14';
const SHELL = ['./', './index.html', './manifest.webmanifest', './logo.png', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // POST ke Apps Script tidak disentuh
  const url = new URL(req.url);
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // Halaman: coba jaringan dulu (agar update cepat), jatuh ke cache bila offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // Aset statis & CDN: dari cache dulu, perbarui di latar belakang
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
