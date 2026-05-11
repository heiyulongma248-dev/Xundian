// 寻典网页版 — Service Worker（PWA 离线缓存）
//
// 策略：
//   - 自家资源（index.html / app.js / style.css / pysrc/*.py / icon）走 "stale-while-revalidate"
//   - Pyodide CDN 资源（jsdelivr 路径）走 "cache-first"，首次拉到后离线可用
//   - 其它请求 passthrough

'use strict';

const CACHE_NAME = 'xundian-v2';
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
  // 本地 vendor 的 CDN 依赖
  'lib/pdfjs/pdf.min.js',
  'lib/pdfjs/pdf.worker.min.js',
  'lib/pyodide/pyodide.js',
  'lib/pyodide/pyodide.asm.js',
  'lib/pyodide/pyodide.asm.wasm',
  'lib/pyodide/pyodide-lock.json',
  'lib/pyodide/python_stdlib.zip',
  'lib/pyodide/micropip-0.9.0-py3-none-any.whl',
  'lib/pyodide/packaging-24.2-py3-none-any.whl',
  'lib/pyodide/lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl',
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

  // 所有依赖现在都是同源（CDN 依赖已经 vendor 到 lib/）—— 走 stale-while-revalidate
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
