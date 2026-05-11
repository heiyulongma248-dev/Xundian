// 寻典网页版 — pdf.js 抽文字层包装
// 由 app.js 在 parse_books_batch 流程里调用，把"PDF bytes → 每页原始文字"这一步
// 从 Pyodide pypdf 搬到 V8 原生 pdf.js，速度提升通常 10–100x。
//
// 进度回调和取消都在这里实现；上层 app.js 把进度事件转发给 window.onPyEvent，
// 这样原有 UI 完全不用改。
//
// 注意：pdf.js 内部会自动用 Web Worker（workerSrc 设过），所以 PDF 解析本身
// 不阻塞主线程。

'use strict';

(function setupPdfJsWorker() {
  // pdfjsLib 由 index.html 里的 <script> 加载到 window
  if (typeof window === 'undefined' || !window.pdfjsLib) return;
  // 同源加载 worker，避免依赖 CDN
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';
})();

/**
 * 把一个 PDF 的字节抽成 [{page: 1, text: "..."}, ...]
 *
 * @param {Uint8Array} pdfBytes - PDF 文件字节
 * @param {Object} opts
 *   onProgress(current, total): 每抽完几页调一次，给上层更新进度条
 *   isCancelled(): 返回 true 时立即中止，抛 PdfExtractCancelled
 *   progressEvery: 每多少页推一次进度（默认 5）
 * @returns {Promise<Array<{page: number, text: string}>>}
 */
async function extractPdfPages(pdfBytes, opts = {}) {
  if (!window.pdfjsLib) {
    throw new Error('pdf.js 未加载。请检查网络能否访问 cdn.jsdelivr.net。');
  }
  const onProgress = opts.onProgress || null;
  const isCancelled = opts.isCancelled || (() => false);
  const progressEvery = opts.progressEvery || 5;

  // 关键：pdf.js 在 worker 模式下用 transferable 传字节，会 detach 调用方的
  // Uint8Array.buffer。如果 pypdf 后备路径还想用同一份 bytes，会拿到一个被 detach
  // 的 buffer，抛 "Cannot perform %TypedArray%.prototype.values on a detached
  // or out-of-bounds ArrayBuffer"。所以这里给 pdf.js 一份拷贝，原 bytes 保留。
  const dataForPdfJs = (pdfBytes instanceof Uint8Array)
    ? new Uint8Array(pdfBytes)              // 拷贝 Uint8Array
    : new Uint8Array(pdfBytes.slice(0));    // ArrayBuffer 路径

  // getDocument 接受 Uint8Array / ArrayBuffer
  const loadingTask = window.pdfjsLib.getDocument({
    data: dataForPdfJs,
    // 关掉 pdf.js 自己的字体/Cmap 远程依赖 —— 大多数中文 PDF 都内嵌字体，
    // 没内嵌时也只影响字形显示，对文字层提取无影响
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (e) {
    throw new Error(`pdf.js 打不开 PDF：${(e && e.message) || e}`);
  }

  const total = pdf.numPages;
  const pages = new Array(total);

  for (let i = 1; i <= total; i++) {
    if (isCancelled()) {
      // 释放资源后抛
      try { await pdf.cleanup(); } catch (_) {}
      try { await pdf.destroy(); } catch (_) {}
      const err = new Error(`取消于第 ${i}/${total} 页`);
      err.name = 'PdfExtractCancelled';
      throw err;
    }
    let pageObj;
    try {
      pageObj = await pdf.getPage(i);
    } catch (e) {
      // 某一页坏 → 当空页对待，整体不中断
      pages[i - 1] = { page: i, text: '' };
      continue;
    }
    let content;
    try {
      content = await pageObj.getTextContent();
    } catch (e) {
      content = { items: [] };
    }
    // 把所有 text item 拼起来；hasEOL 处加换行，方便 Python 端
    // _resolve_book_pages 的正则（页眉 / 页尾）继续生效。
    const parts = [];
    for (const it of (content.items || [])) {
      if (!it) continue;
      const s = (it.str != null) ? String(it.str) : '';
      parts.push(s);
      if (it.hasEOL) parts.push('\n');
    }
    pages[i - 1] = { page: i, text: parts.join('') };

    // 释放页对象，避免长文档累积内存
    try { pageObj.cleanup(); } catch (_) {}

    if (onProgress && (i % progressEvery === 0 || i === total)) {
      try { onProgress(i, total); } catch (_) {}
    }
  }

  try { await pdf.cleanup(); } catch (_) {}
  try { await pdf.destroy(); } catch (_) {}

  return pages;
}

window.pdfExtract = { extractPdfPages };

// ---- 控制台诊断：检查某一本书某一页 pdf.js 实际抽出来的文字 ----
// 用法（浏览器控制台 F12）：
//   await debugPdfPage('胡适日记5 1928-1930.pdf', 33)
window.debugPdfPage = async function debugPdfPage(fileId, pageNum) {
  const b = await window.db.getBook(fileId);
  if (!b || !b.handle) {
    console.error('[debug] 找不到这本书：', fileId);
    return;
  }
  const bytes = await window.fs.readHandleBytes(b.handle);
  if (!bytes) { console.error('[debug] 读不到 PDF 字节'); return; }

  const pages = await window.pdfExtract.extractPdfPages(bytes, {
    onProgress: () => {},
    isCancelled: () => false,
    progressEvery: 999999,
  });
  const p = pages[pageNum - 1];
  if (!p) { console.error('[debug] 这本书没有第', pageNum, '页'); return; }

  const text = p.text || '';
  const flat = text.replace(/\s/g, '');
  const cjkRe = /[㐀-䶿一-鿿豈-﫿]/g;
  const cjk = flat.match(cjkRe) || [];
  // 统计各 Unicode 区段的字符数
  const buckets = {
    CJK_Unified: 0,            // 4E00-9FFF
    CJK_ExtA: 0,               // 3400-4DBF
    CJK_Compat: 0,             // F900-FAFF
    ASCII_letter_digit: 0,     // a-z A-Z 0-9
    ASCII_punct_space: 0,      // ASCII 标点空白
    CJK_punct: 0,              // 3000-303F、FF00-FFEF 等
    PUA: 0,                    // E000-F8FF
    Other: 0,
  };
  for (const ch of flat) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x4E00 && cp <= 0x9FFF) buckets.CJK_Unified++;
    else if (cp >= 0x3400 && cp <= 0x4DBF) buckets.CJK_ExtA++;
    else if (cp >= 0xF900 && cp <= 0xFAFF) buckets.CJK_Compat++;
    else if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) buckets.ASCII_letter_digit++;
    else if (cp >= 0x20 && cp < 0x7F) buckets.ASCII_punct_space++;
    else if ((cp >= 0x3000 && cp <= 0x303F) || (cp >= 0xFF00 && cp <= 0xFFEF)) buckets.CJK_punct++;
    else if (cp >= 0xE000 && cp <= 0xF8FF) buckets.PUA++;
    else buckets.Other++;
  }

  console.log('========', fileId, '· 第', pageNum, '页 ========');
  console.log('原始长度：', text.length, '；去空白后：', flat.length);
  console.log('CJK 字符（U+3400-9FFF + F900-FAFF）数 =', cjk.length,
              '占比', (cjk.length / Math.max(1, flat.length) * 100).toFixed(1) + '%');
  console.log('各区段分布：', buckets);
  console.log('前 200 字（原样）：');
  console.log(text.slice(0, 200));
  console.log('前 30 字的 Unicode 码点：');
  console.log(Array.from(text.slice(0, 30)).map((c) => c + '=U+' + c.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()).join(' '));
  return p;
};
