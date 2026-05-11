// 寻典网页版 — Service Worker（PWA 离线缓存）
//
// 策略：
//   - 自家资源（index.html / app.js / style.css / pysrc/*.py / icon）走 "stale-while-revalidate"
//   - Pyodide CDN 资源（jsdelivr 路径）走 "cache-first"，首次拉到后离线可用
//   - 其它请求 passthrough

'use strict';

const CACHE_NAME = 'xundian-v1';
const SELF_ASSETS = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'icon.png',
  'py-bridge.js',
  'fs-bridge.js',
  'pdf-extract.js',
  'db.js',
  'manifest.json',
  'pysrc/__init__.py',
  'pysrc/extract_quotes.py',
  'pysrc/pdf_text.py',
  'pysrc/matcher.py',
  'pysrc/citation.py',
  'pysrc/render_report.py',
  'pysrc/web_api.py',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SELF_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pyodide & pdf.js CDN：cache-first（一旦缓存就不再回源，除非清缓存）
  if (url.hostname === 'cdn.jsdelivr.net' &&
      (url.pathname.includes('/pyodide/') || url.pathname.includes('pdfjs-dist'))) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // 自家资源：stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
