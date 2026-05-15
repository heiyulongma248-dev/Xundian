// 寻典网页版 — 前端逻辑
// 与桌面版的差异都集中在 callApi() 这一个分发器里。其余 UI 逻辑保持 1:1。
//
// 通信模型：
//   - 「书架/文件夹/设置」等 CRUD → IndexedDB（window.db / window.dbHelpers）
//   - 「文件挑选 / 读 bytes / PDF 跳页 / 下载」→ File System Access API（window.fs）
//   - 「抽引文 / 解析 PDF / 匹配 / 导出 docx」→ Pyodide（window.py）

'use strict';

// =========================================================
// 工具函数
// =========================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setStatus(text, progress = null) {
  $('#status-text').textContent = text || '就绪';
  const pBar = $('#status-progress');
  const fill = $('#progress-fill');
  if (progress === null) {
    pBar.classList.add('hidden');
    fill.style.width = '0';
  } else {
    pBar.classList.remove('hidden');
    fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

const BUSY_SELECTORS = [
  '#btn-add-book', '#btn-pick-docx', '#btn-export-report',
  '#btn-lookup', '#btn-settings',
  '.book-card .btn-tiny',
  '.result-card .btn-tiny',
  '.alt-cand-card .btn-tiny',
];

let _busyDepth = 0;
function setBusy(busy) {
  if (busy) _busyDepth += 1;
  else _busyDepth = Math.max(0, _busyDepth - 1);
  const isBusy = _busyDepth > 0;
  for (const sel of BUSY_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      el.disabled = isBusy;
      el.classList.toggle('busy', isBusy);
    });
  }
  document.body.classList.toggle('is-busy', isBusy);
}

async function withBusy(fn) {
  setBusy(true);
  try { return await fn(); } finally { setBusy(false); }
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function friendlyError(method, errType, errMsg) {
  errType = errType || '';
  errMsg = errMsg || '';

  if (errType === 'FileNotFoundError' || errMsg.includes('PDF 文件不见了')) {
    return 'PDF 文件丢了。可能被移动或删除了，请到书架移除该书后重新添加。';
  }
  if (errMsg.includes('未授权')) {
    return '需要在浏览器弹窗里点「允许」才能读这本 PDF。';
  }
  if (errType === 'KeyError') {
    return '操作的对象已不存在。请刷新书架后重试。';
  }
  if (errType === 'ValueError' && errMsg.includes('已存在同名书')) {
    return '书架里已经有同名书了。请先移除旧的，或换文件名再添加。';
  }
  if (errMsg.includes('extract_text') || errMsg.includes('pypdf')) {
    return '这本 PDF 无法读取文字内容，可能是纯图片扫描件。当前版本不带 OCR，请先用其他工具加上文字层再添加。';
  }
  if (errMsg.includes('还没扫描过')) {
    return '请先在「文档扫描」中扫描一份 docx，再来导出核对表。';
  }
  return `操作"${method}"失败：${errMsg || '未知错误'}`;
}

// 同桌面版接口的统一调度器：app.js 大部分代码不动，只重写这一函数
async function callApi(method, ...args) {
  try {
    const fn = API_DISPATCH[method];
    if (!fn) throw new Error(`后端方法不存在：${method}`);
    const result = await fn(...args);
    return result;
  } catch (e) {
    const friendly = friendlyError(method, e && e.name, (e && e.message) || String(e));
    setStatus(friendly.length > 60 ? friendly.slice(0, 60) + '…' : friendly);
    showAlert(friendly, '操作失败');
    throw e;
  }
}

// 简易模态框（与桌面版一致）
function showModal({ title, bodyHtml, onOk, okText = '确定', cancelText = '取消', hideCancel = false, modalClass = '' }) {
  return new Promise((resolve) => {
    const modalEl = document.querySelector('#modal-overlay .modal');
    if (modalEl) {
      modalEl.classList.remove('scope-modal');
      if (modalClass) modalEl.classList.add(modalClass);
    }
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-ok').textContent = okText;
    $('#modal-cancel').textContent = cancelText;
    $('#modal-cancel').classList.toggle('hidden', !!hideCancel);
    $('#modal-overlay').classList.remove('hidden');
    const close = (val) => {
      $('#modal-overlay').classList.add('hidden');
      $('#modal-ok').onclick = null;
      $('#modal-cancel').onclick = null;
      if (modalEl) modalEl.classList.remove('scope-modal');
      resolve(val);
    };
    $('#modal-ok').onclick = async () => {
      const result = onOk ? await onOk() : true;
      if (result !== false) close(result || true);
    };
    $('#modal-cancel').onclick = () => close(null);
  });
}

function showAlert(message, title = '提示') {
  return showModal({
    title,
    bodyHtml: `<div style="line-height:1.7;">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`,
    okText: '知道了',
    hideCancel: true,
  });
}

function showConfirm(message, title = '请确认') {
  return showModal({
    title,
    bodyHtml: `<div style="line-height:1.7;">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`,
    okText: '确定',
    cancelText: '取消',
  }).then((v) => v !== null);
}

// =========================================================
// API 分发：所有原 pywebview 方法都走这张表
// =========================================================
//
// 注意：以下每个函数的「入参 / 出参」都保持和桌面版 api.py 同名方法完全一致，
// 这样上层 UI 代码（renderBookList / scan / lookup / settings）可以原样复用。

const DEFAULT_SETTINGS = { threshold: 0.85, ctx_weight: 0.10, top_k: 3 };

// 暂存的 docx bytes（由 pick_docx_file 装入，scan_document 取用）
let _stagedDocx = null; // { name, bytes }

// 解析取消标志（pdf.js 抽文字时由 pdf-extract.js 轮询）
let _parseCancelled = false;

// 让 JS 端直接发"原本由 Python 推过来"的事件 —— 这样 UI 完全不必改
function _emitPyEvent(kind, payload) {
  if (typeof window.onPyEvent === 'function') {
    try { window.onPyEvent(kind, payload || {}); } catch (_) {}
  }
}

const API_DISPATCH = {
  // —— 设置 ——
  async get_settings() {
    const cur = (await window.db.getSettings()) || { ...DEFAULT_SETTINGS };
    return { ok: true, settings: cur };
  },

  async update_settings(patch) {
    const cur = (await window.db.getSettings()) || { ...DEFAULT_SETTINGS };
    const next = { ...cur, ...patch };
    await window.db.putSettings(next);
    // 同步给 Python 端
    try { await window.py.call('set_settings', next); } catch (_) {}
    return { ok: true, settings: next };
  },

  // —— 文件挑选 ——
  async pick_pdf_file() {
    const handles = await window.fs.pickPdfFiles({ multiple: false });
    return { ok: true, path: handles[0] ? handles[0].name : null, handle: handles[0] || null };
  },

  async pick_pdf_files() {
    const handles = await window.fs.pickPdfFiles({ multiple: true });
    return {
      ok: true,
      paths: handles.map((h) => h.name),
      handles, // 内部传递；renderBookList 不用，下游 add_book_quick 会顺着 paths 拿到
    };
  },

  async pick_docx_file() {
    const handle = await window.fs.pickDocxFile();
    if (!handle) return { ok: true, path: null };
    const bytes = await window.fs.readHandleBytes(handle);
    _stagedDocx = { name: handle.name, bytes };
    return { ok: true, path: handle.name };
  },

  async pick_save_path(defaultName) {
    // 网页版无法在保存前选路径——直接返回一个"伪路径"占位，真正保存由 export_report 触发
    return { ok: true, path: defaultName || '引文核对表.docx' };
  },

  // —— 书架 ——
  async list_books() {
    const books = await window.dbHelpers.getBooksForUI();
    return { ok: true, books };
  },

  async add_book(pdfPathOrHandle, meta) {
    // 桌面版传 pdf_path（字符串）；网页版必须传 handle。
    // app.js 里不直接调这个（用 add_book_quick 的批量路径），但保留兼容。
    if (!pdfPathOrHandle || typeof pdfPathOrHandle === 'string') {
      throw new Error('网页版 add_book 需要 FileSystemFileHandle，而不是字符串路径。');
    }
    const handle = pdfPathOrHandle;
    const fileId = handle.name;
    const existing = await window.db.getBook(fileId);
    if (existing) throw new Error(`已存在同名书：${fileId}`);
    const m = meta || {};
    const book = {
      file_id: fileId,
      handle,
      author: m.author || 'XX',
      title: m.title || fileId.replace(/\.pdf$/i, ''),
      doc_type: m.doc_type || 'M',
      place: m.place || 'XX',
      publisher: m.publisher || 'XX出版社',
      year: m.year || '0000',
      folder: m.folder || null,
    };
    await window.db.putBook(book);
    return { ok: true, book };
  },

  // 内部：从 _pendingHandles 里按 path（即 handle.name）找到对应 handle 并入库
  async add_book_quick(pdfPath) {
    const handle = _pendingHandles.get(pdfPath);
    if (!handle) throw new Error(`找不到挑选的 PDF 文件句柄：${pdfPath}`);
    const fileId = handle.name;
    const existing = await window.db.getBook(fileId);
    if (existing) {
      return { ok: true, skipped: true, reason: `已存在同名书：${fileId}` };
    }
    const book = {
      file_id: fileId,
      handle,
      author: 'XX',
      title: fileId.replace(/\.pdf$/i, ''),
      doc_type: 'M',
      place: 'XX',
      publisher: 'XX出版社',
      year: '0000',
      folder: null,
    };
    await window.db.putBook(book);
    return { ok: true, skipped: false, book: await window.dbHelpers.getBooksForUI().then((all) => all.find((b) => b.file_id === fileId)) };
  },

  async update_book(fileId, metaPatch) {
    const b = await window.db.getBook(fileId);
    if (!b) throw new Error(`找不到书：${fileId}`);
    for (const k of ['author', 'title', 'doc_type', 'place', 'publisher', 'year']) {
      if (metaPatch[k] !== undefined) b[k] = metaPatch[k];
    }
    if ('folder' in metaPatch) {
      const f = (metaPatch.folder || '').trim() || null;
      b.folder = f;
      if (f) await window.db.putFolder(f);
    }
    await window.db.putBook(b);
    return { ok: true, book: b };
  },

  async remove_book(fileId) {
    await window.db.deleteBook(fileId);
    return { ok: true, removed: true };
  },

  // —— 文件夹 ——
  async list_folders() {
    const [folders, books] = await Promise.all([
      window.db.listFolders(),
      window.db.listBooks(),
    ]);
    const counts = {};
    let ungrouped = 0;
    for (const b of books) {
      if (b.folder) counts[b.folder] = (counts[b.folder] || 0) + 1;
      else ungrouped += 1;
    }
    const arr = folders
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((name) => ({ name, count: counts[name] || 0 }));
    return { ok: true, folders: arr, ungrouped };
  },

  async create_folder(name) {
    const n = (name || '').trim();
    if (!n) throw new Error('文件夹名不能为空');
    const all = await window.db.listFolders();
    if (all.some((f) => f.name === n)) throw new Error(`已存在同名文件夹：${n}`);
    await window.db.putFolder(n);
    return { ok: true, name: n };
  },

  async rename_folder(oldName, newName) {
    const o = (oldName || '').trim();
    const n = (newName || '').trim();
    if (!o || !n) throw new Error('文件夹名不能为空');
    const all = await window.db.listFolders();
    if (!all.some((f) => f.name === o)) throw new Error(`找不到文件夹：${o}`);
    if (n !== o && all.some((f) => f.name === n)) throw new Error(`已存在同名文件夹：${n}`);
    await window.db.renameFolder(o, n);
    return { ok: true, name: n };
  },

  async delete_folder(name) {
    const n = (name || '').trim();
    if (!n) throw new Error('文件夹名不能为空');
    const affected = await window.db.deleteFolder(n);
    return { ok: true, affected };
  },

  async update_book_folders(fileIds, folder) {
    const affected = await window.db.updateBookFolders(fileIds || [], folder || null);
    return { ok: true, affected };
  },

  // —— 解析 ——
  async clear_book_caches(fileIds) {
    const cleared = await window.db.clearCaches(fileIds || []);
    return { ok: true, cleared };
  },

  async reparse_book(fileId) {
    await window.db.deleteCache(fileId);
    return await API_DISPATCH.parse_books_batch([fileId]);
  },

  async parse_book(fileId) {
    return await API_DISPATCH.parse_books_batch([fileId]);
  },

  // 网页版批量解析：JS 主导整个流程。pdf.js 在 V8 里抽文字（速度 10-100x），
  // Python 只负责语言无关的"后处理"（is_low_quality + 书内页码识别）。
  async parse_books_batch(fileIds) {
    if (!fileIds || !fileIds.length) return { ok: true, results: [] };

    // 先确保权限（一次性弹一波 prompt）
    const handles = [];
    for (const fid of fileIds) {
      const b = await window.db.getBook(fid);
      if (b && b.handle) handles.push(b.handle);
    }
    try { await window.fs.ensureReadPermissions(handles); } catch (_) {}

    // 重置取消标志（JS 端自己管，不必再去叫 Python）
    _parseCancelled = false;

    const total = fileIds.length;
    const results = [];
    let done = 0, cancelled = 0, failed = 0, skipped = 0;

    _emitPyEvent('batch_start', { total, file_ids: fileIds });

    for (let i = 0; i < fileIds.length; i++) {
      const fid = fileIds[i];

      if (_parseCancelled) {
        results.push({ file_id: fid, status: 'skipped' });
        skipped += 1;
        _emitPyEvent('book_cancelled', { file_id: fid, reason: 'skipped' });
        continue;
      }

      _emitPyEvent('book_start', { file_id: fid, index: i + 1, total });

      // 1. 取 PDF bytes
      let bytes = null;
      try {
        const b = await window.db.getBook(fid);
        if (!b || !b.handle) throw new Error('PDF 文件不在书架（或权限丢失）');
        bytes = await window.fs.readHandleBytes(b.handle);
        if (!bytes) throw new Error('无法读取 PDF 字节');
      } catch (e) {
        console.error(`[parse] ${fid} 读 bytes 失败：`, e);
        const msg = '读 PDF 失败：' + String(e.message || e);
        results.push({ file_id: fid, status: 'failed', error: msg });
        failed += 1;
        _emitPyEvent('book_failed', { file_id: fid, error: msg });
        continue;
      }

      // 2. pdf.js 抽文字（页级进度 + 取消检查）
      //    抛错也不直接 fail，留给 pypdf 兜底
      let rawPages = [];
      let pdfJsThrew = null;
      try {
        rawPages = await window.pdfExtract.extractPdfPages(bytes, {
          onProgress: (cur, totalPages) => {
            _emitPyEvent('book_progress', { file_id: fid, current: cur, total: totalPages });
          },
          isCancelled: () => _parseCancelled,
          progressEvery: 5,
        });
      } catch (e) {
        if (e && e.name === 'PdfExtractCancelled') {
          results.push({ file_id: fid, status: 'cancelled' });
          cancelled += 1;
          _emitPyEvent('book_cancelled', { file_id: fid, reason: 'aborted' });
          continue;
        }
        // 不直接判失败，记下来；下一步走 pypdf 兜底
        console.warn(`[parse] ${fid} pdf.js 失败，将尝试 pypdf 兜底：`, e);
        pdfJsThrew = e;
        rawPages = [];
      }

      // 3. 判断 pdf.js 是否抽空 —— OCR 扫描 PDF（Type 3 字体 / 不可见文字层）
      //    pdf.js 常常拿不到任何东西。这时回退到 pypdf 在 Pyodide 里跑。
      const totalChars = rawPages.reduce((s, p) => s + ((p.text || '').length), 0);
      const avgChars = rawPages.length ? totalChars / rawPages.length : 0;
      // 抽空（< 5 字/页）OR pdf.js 抛错 → 都走 pypdf 后备
      const needFallback = (avgChars < 5) || (pdfJsThrew !== null);

      let final;
      if (needFallback) {
        // 抽空 → pypdf 后备路径
        setStatus(`${fid}：pdf.js 抽不到文字（可能是 OCR 扫描件），改用 pypdf（较慢）…`);
        _emitPyEvent('book_progress', { file_id: fid, current: 0, total: rawPages.length || 1 });
        try {
          final = await window.py.call('extract_with_pypdf', bytes, fid);
        } catch (e) {
          if (e && String(e.message || e).includes('取消')) {
            results.push({ file_id: fid, status: 'cancelled' });
            cancelled += 1;
            _emitPyEvent('book_cancelled', { file_id: fid, reason: 'aborted' });
            bytes = null;
            continue;
          }
          console.error(`[parse] ${fid} pypdf 后备失败：`, e);
          const msg = 'pypdf 错误：' + String(e.message || e);
          results.push({ file_id: fid, status: 'failed', error: msg });
          failed += 1;
          _emitPyEvent('book_failed', { file_id: fid, error: msg });
          bytes = null;
          continue;
        }
        bytes = null;
      } else {
        // 释放 PDF bytes（大文件，越早 GC 越好）
        bytes = null;
        // 走 finalize_pages：is_low_quality + 书内页码识别（毫秒级）
        try {
          final = await window.py.call('finalize_pages', rawPages);
        } catch (e) {
          console.error(`[parse] ${fid} finalize_pages 失败：`, e);
          const msg = 'finalize 错误：' + String(e.message || e);
          results.push({ file_id: fid, status: 'failed', error: msg });
          failed += 1;
          _emitPyEvent('book_failed', { file_id: fid, error: msg });
          continue;
        }
      }

      const pageCount = final.page_count || 0;
      const lowQ = final.low_quality_pages || 0;

      // 4. 写 IndexedDB 缓存
      try {
        await window.db.putCache({
          file_id: fid,
          pages: final.pages || [],
          page_count: pageCount,
          low_quality_pages: lowQ,
          signature: null,
        });
      } catch (e) {
        // 缓存写入失败不致命；继续
        console.warn(`[parse] ${fid} 写缓存失败：`, e);
      }

      results.push({
        file_id: fid, status: 'done',
        page_count: pageCount,
        low_quality_pages: lowQ,
      });
      done += 1;
      _emitPyEvent('book_done', {
        file_id: fid,
        page_count: pageCount,
        low_quality_pages: lowQ,
      });
    }

    _emitPyEvent('batch_done', { total, done, cancelled, failed, skipped });
    _parseCancelled = false;
    return { ok: true, results, done, cancelled, failed, skipped };
  },

  async cancel_parsing() {
    // 主路径：JS 标志位，立即生效
    _parseCancelled = true;
    // pypdf 后备路径：Python 端也读它自己的 _cancel_flag
    try { window.py.callSync('cancel_parsing'); } catch (_) {}
    return { ok: true, cancelled: true };
  },

  // —— 文档扫描 / 单句查询 ——
  async scan_document(_path, scope) {
    if (!_stagedDocx || !_stagedDocx.bytes) {
      throw new Error('没有暂存的 docx；请先点「选择 docx 文件」。');
    }
    const fileIds = await _resolveScopeToFileIds(scope);
    const booksData = await window.dbHelpers.getBooksPagesData(fileIds);
    const booksMeta = await window.dbHelpers.getBooksMeta();
    // 缓存给 renderResultCard 用：当 Python 没返回 candidate.citation（例如 SW
    // 还在用旧版 pysrc 缓存）时，JS 端能根据 book_file 自己拼一条 fallback。
    _lastBooksMeta = booksMeta || {};
    const { id: formatId, template: formatTemplate } = await _resolveActiveFormatPayload();
    const result = await window.py.call(
      'scan_document',
      _stagedDocx.bytes,
      booksData,
      booksMeta,
      _stagedDocx.name,
      formatId,
      formatTemplate,
    );
    return { ok: true, ...(result || {}) };
  },

  async lookup_quote(quote, ctxBefore, ctxAfter, scope) {
    const fileIds = await _resolveScopeToFileIds(scope);
    const booksData = await window.dbHelpers.getBooksPagesData(fileIds);
    const booksMeta = await window.dbHelpers.getBooksMeta();
    _lastBooksMeta = booksMeta || {};
    const { id: formatId, template: formatTemplate } = await _resolveActiveFormatPayload();
    const result = await window.py.call(
      'lookup_quote',
      quote,
      ctxBefore || '',
      ctxAfter || '',
      booksData,
      booksMeta,
      formatId,
      formatTemplate,
    );
    return { ok: true, ...(result || {}) };
  },

  // —— 打开 PDF —— 关键：在网页版用 blob URL 新 tab 打开 ——
  async open_pdf_at_page(fileId, pdfPage) {
    const b = await window.db.getBook(fileId);
    if (!b || !b.handle) throw new Error(`找不到 PDF：${fileId}`);
    const r = await window.fs.openPdfAtPage(b.handle, parseInt(pdfPage, 10));
    return { ok: true, opened: true, url: r.url, via: 'browser' };
  },

  // —— 导出 ——
  async export_report(suggestedName) {
    const { id: formatId, template: formatTemplate } = await _resolveActiveFormatPayload();
    const bytes = await window.py.call('export_report_bytes', formatId, formatTemplate);
    if (!bytes) throw new Error('导出失败：Python 没返回字节流');
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const r = await window.fs.downloadBytes(arr, suggestedName || '引文核对表.docx');
    if (r && r.cancelled) return { ok: true, saved_to: null, cancelled: true };
    return { ok: true, saved_to: r.name || (suggestedName || '引文核对表.docx') };
  },

  // —— 杂项 ——
  async get_data_dir_path() {
    return { ok: true, path: '浏览器本地存储（IndexedDB）' };
  },
  async open_data_dir() {
    showAlert(
      '网页版的数据保存在浏览器内置存储（IndexedDB）里，不是磁盘上的文件夹。\n' +
      '要清空或备份请在浏览器开发者工具的「应用 / Application」里操作。',
      '网页版数据位置',
    );
    return { ok: true };
  },
  async get_about_info() {
    const info = {
      app_name: '寻典',
      version: '1.0.0-web',
      python_version: 'Pyodide / WebAssembly',
      data_dir: '浏览器本地存储（IndexedDB）',
      deps: {
        Pyodide: window.py.ready ? '已加载' : '加载中',
        'File System Access API': window.fs.isSupported() ? '可用' : '不可用',
        IndexedDB: 'indexedDB' in window ? '可用' : '不可用',
      },
    };
    return { ok: true, info };
  },
};

// pick_pdf_files 返回的 handles → file_id 字符串 → handle 映射
const _pendingHandles = new Map();

// 把 scope（含 folders / file_ids / include_ungrouped）展开成 file_id 列表
async function _resolveScopeToFileIds(scope) {
  const allBooks = await window.db.listBooks();
  if (!scope) return allBooks.map((b) => b.file_id);
  const folders = new Set(scope.folders || []);
  const ids = new Set(scope.file_ids || []);
  const inclU = !!scope.include_ungrouped;
  const keep = new Set();
  for (const b of allBooks) {
    if (b.folder && folders.has(b.folder)) keep.add(b.file_id);
    else if (!b.folder && inclU) keep.add(b.file_id);
    else if (ids.has(b.file_id)) keep.add(b.file_id);
  }
  return Array.from(keep);
}

// =========================================================
// Python → JS 事件总线
// =========================================================
window.onPyEvent = (kind, payload) => {
  // payload 可能是 Pyodide 的 PyProxy / Map / Object，统一成普通对象
  if (payload && typeof payload.toJs === 'function') {
    payload = payload.toJs({ dict_converter: Object.fromEntries });
  }
  if (payload instanceof Map) {
    payload = Object.fromEntries(payload);
  }
  switch (kind) {
    case 'parse_start':
      setStatus(`解析中：${payload.file_id}…`, 0); break;
    case 'parse_progress':
      setStatus(
        `解析中：${payload.file_id}（${payload.current}/${payload.total}）`,
        (payload.current / payload.total) * 100,
      );
      break;
    case 'parse_done':
      setStatus(`完成：${payload.file_id} · ${payload.page_count} 页`, null); break;

    case 'batch_start': onBatchStart(payload); break;
    case 'book_start': onBookStart(payload); break;
    case 'book_progress': onBookProgress(payload); break;
    case 'book_done': onBookDone(payload); break;
    case 'book_cancelled': onBookCancelled(payload); break;
    case 'book_failed': onBookFailed(payload); break;
    case 'batch_done': onBatchDone(payload); break;

    case 'scan_start': setStatus(`扫描中：${payload.docx}…`); break;
    case 'scan_total': onScanTotal(payload); break;
    case 'scan_phase': onScanPhase(payload); break;
    case 'scan_match': onScanMatch(payload); break;
    case 'scan_done': onScanDone(payload); break;
  }
};

// —— 以下区段与桌面版保持一致 —— //
// =========================================================
// 扫描事件处理
// =========================================================

function onScanTotal(payload) {
  const total = payload.total;
  lastScanResults = [];

  const summary = $('#scan-summary');
  summary.classList.remove('hidden');
  if (total === 0) {
    summary.textContent = '本文档中没有找到任何 "" 引文。';
  } else {
    summary.textContent = `共 ${total} 条引文 · 已查找 0/${total}`;
  }

  $('#scan-results').innerHTML = '';
  $('#scan-actions').classList.add('hidden');
  setStatus(`找到 ${total} 条引文，准备开始查询…`, 0);
}

function onScanPhase(payload) {
  const labels = {
    loading_books: '加载书架数据…',
    precomputing: '预处理书目文本…',
  };
  setStatus(labels[payload.phase] || payload.phase);
}

function onScanMatch(payload) {
  const { current, total, hits, lows, miss, result } = payload;
  lastScanResults.push(result);

  const card = renderResultCard(result);
  $('#scan-results').appendChild(card);

  const summary = $('#scan-summary');
  summary.textContent =
    `已查找 ${current}/${total} · 命中 ${hits} · 低置信度 ${lows} · 未找到 ${miss}`;
  setStatus(`扫描中 ${current}/${total}`, (current / total) * 100);
}

function onScanDone(payload) {
  const { total, hits, lows, miss } = payload;

  const summary = $('#scan-summary');
  summary.textContent =
    `共 ${total} 条引文 · 自动命中 ${hits} · 置信度偏低 ${lows} · 未找到 ${miss}`;

  $('#scan-actions').classList.toggle('hidden', total === 0);
  setStatus(`扫描完成 · ${total} 条`, null);

  // 首次渲染时通过 rerenderAllCitations 修正用户格式 chip 名（避免显示 user_xxx）
  rerenderAllCitations();

  if (total > 0) {
    setTimeout(() => {
      showAlert(
        `共 ${total} 条引文\n` +
        `  ✓ 顺利找到：${hits}\n` +
        `  ⚠ 置信度偏低：${lows}\n` +
        `  ✗ 未找到：${miss}\n\n` +
        `点击下方「💾 导出核对表 docx」可保存完整核对表。`,
        '扫描完成',
      );
    }, 100);
  }
}

// =========================================================
// Tab 切换
// =========================================================
function switchTab(target) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
  if (target === 'library') refreshBookList();
  if (target === 'formats') renderFormatList();
}

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

async function ensureLibraryNotEmpty() {
  const res = await callApi('list_books');
  const books = (res.books || []).filter((b) => b.exists);
  if (books.length > 0) return true;
  await showModal({
    title: '📚 书架还是空的',
    bodyHtml: `
      <p>需要先添加 PDF 书籍，才能查找引文出处。</p>
      <p style="color:#888;font-size:13px;">点下方「去添加书籍」会切到书架页签，再点 [+ 添加书籍] 选 PDF 即可。</p>
    `,
    okText: '去添加书籍',
    cancelText: '取消',
  });
  switchTab('library');
  return false;
}

// =========================================================
// 书架
// =========================================================
const collapsedFolders = new Set();

function _renderBookCard(b) {
  const card = document.createElement('div');
  card.className = 'book-card';
  if (multiselectActive && selectedBookIds.has(b.file_id)) {
    card.classList.add('ms-selected');
  }
  if (!multiselectActive && b.exists) {
    card.draggable = true;
    card.dataset.fileId = b.file_id;
  }

  let badge;
  if (!b.exists) {
    badge = '<span class="status-badge error">PDF 文件丢失</span>';
  } else if (!b.parsed) {
    badge = '<span class="status-badge pending">待解析</span>';
  } else if (b.low_quality_pages / Math.max(1, b.page_count) > 0.1) {
    badge = `<span class="status-badge warn">部分低质 ${b.low_quality_pages}/${b.page_count}</span>`;
  } else {
    badge = `<span class="status-badge ok">${b.page_count} 页</span>`;
  }

  const needsMeta = (b.author === 'XX' || b.year === '0000' || b.publisher === 'XX出版社');
  const metaWarn = needsMeta ? '<span class="status-badge warn">出版信息待补</span>' : '';
  const checkboxHtml = multiselectActive
    ? `<input type="checkbox" class="ms-checkbox" ${selectedBookIds.has(b.file_id) ? 'checked' : ''} ${!b.exists ? 'disabled' : ''} />`
    : '';

  card.innerHTML = `
    ${checkboxHtml}
    <div class="card-main">
      <div class="info">
        <div class="title">${escapeHtml(b.title)} ${badge} ${metaWarn}</div>
        <div class="meta">${escapeHtml(b.author)} · ${escapeHtml(b.publisher)} · ${escapeHtml(b.year)}</div>
        <div class="stat dim">${escapeHtml(b.pdf_path)}</div>
      </div>
      <div class="actions">
        ${b.exists ? `<button class="btn-tiny" data-act="move" title="移到文件夹">📁 移动</button>` : ''}
        <button class="btn-tiny" data-act="edit" title="编辑书籍信息">✏ 编辑</button>
        ${!b.parsed && b.exists ? `<button class="btn-tiny" data-act="parse" title="解析这本 PDF">⚙ 解析</button>` : ''}
        ${b.parsed && b.exists ? `<button class="btn-tiny" data-act="reparse" title="清除缓存后重新解析">🔄 重新解析</button>` : ''}
        <button class="btn-tiny" data-act="remove" title="从书架移除（不删 PDF 文件）">🗑 移除</button>
      </div>
    </div>
  `;

  if (multiselectActive) {
    const cb = card.querySelector('.ms-checkbox');
    card.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
      if (cb && !cb.disabled) {
        cb.checked = !cb.checked;
        onBookCheckChange(b.file_id, cb.checked, card);
      }
    });
    if (cb) {
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      cb.addEventListener('change', () => onBookCheckChange(b.file_id, cb.checked, card));
    }
  } else {
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onBookAction(btn.dataset.act, b);
      });
    });
    card.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', b.file_id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
  }
  return card;
}

function _renderFolderSection({ name, books, isUngrouped }) {
  const section = document.createElement('div');
  section.className = 'folder-section' + (isUngrouped ? ' ungrouped' : '');
  if (collapsedFolders.has(name === null ? '__ungrouped__' : name)) {
    section.classList.add('collapsed');
  }

  const header = document.createElement('div');
  header.className = 'folder-header';

  const arrow = '<span class="folder-arrow">▼</span>';
  const icon = isUngrouped
    ? '<span class="folder-icon">📂</span>'
    : '<span class="folder-icon">📁</span>';
  const displayName = isUngrouped ? '未分组' : name;
  const actions = isUngrouped ? '' : `
    <div class="folder-actions">
      <button class="btn-tiny" data-folder-act="rename">重命名</button>
      <button class="btn-tiny btn-tiny-danger" data-folder-act="delete">删除</button>
    </div>
  `;

  header.innerHTML = `
    ${arrow}
    ${icon}
    <span class="folder-name">${escapeHtml(displayName)}</span>
    <span class="folder-count">(${books.length} 本)</span>
    ${actions}
  `;
  section.appendChild(header);

  header.addEventListener('click', (e) => {
    if (e.target.closest('.folder-actions')) return;
    const key = name === null ? '__ungrouped__' : name;
    if (collapsedFolders.has(key)) collapsedFolders.delete(key);
    else collapsedFolders.add(key);
    section.classList.toggle('collapsed');
  });

  if (!isUngrouped) {
    header.querySelectorAll('[data-folder-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.dataset.folderAct === 'rename') {
          await renameFolderInteractive(name);
        } else if (btn.dataset.folderAct === 'delete') {
          await deleteFolderInteractive(name);
        }
      });
    });
  }

  const targetFolder = isUngrouped ? null : name;
  section.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.types || !ev.dataTransfer.types.includes('text/plain')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    section.classList.add('drop-target');
  });
  section.addEventListener('dragleave', (ev) => {
    if (!section.contains(ev.relatedTarget)) {
      section.classList.remove('drop-target');
    }
  });
  section.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    section.classList.remove('drop-target');
    const fileId = ev.dataTransfer.getData('text/plain');
    if (!fileId) return;
    const draggedBook = (window._lastBookList || []).find((b) => b.file_id === fileId);
    if (draggedBook && draggedBook.folder === targetFolder) return;
    try {
      await callApi('update_book_folders', [fileId], targetFolder);
      setStatus(`已移到「${isUngrouped ? '未分组' : name}」`);
      refreshBookList();
    } catch (_) {}
  });

  const body = document.createElement('div');
  body.className = 'folder-body';
  if (books.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty-msg';
    empty.textContent = '（暂无书籍。把书拖到这里，或在多选模式下批量移入。）';
    body.appendChild(empty);
  } else {
    for (const b of books) {
      body.appendChild(_renderBookCard(b));
    }
  }
  section.appendChild(body);
  return section;
}

async function refreshBookList() {
  const [booksRes, foldersRes] = await Promise.all([
    callApi('list_books'),
    callApi('list_folders'),
  ]);
  const books = booksRes.books || [];
  const folders = (foldersRes.folders || []).map((f) => f.name);
  window._lastBookList = books;
  window._lastFolders = folders;

  const container = $('#book-list');
  const empty = $('#book-empty');
  container.innerHTML = '';
  if (!books.length && !folders.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const byFolder = new Map();
  for (const f of folders) byFolder.set(f, []);
  const ungrouped = [];
  for (const b of books) {
    if (b.folder && byFolder.has(b.folder)) byFolder.get(b.folder).push(b);
    else if (b.folder) ungrouped.push(b);
    else ungrouped.push(b);
  }

  const sortedFolders = Array.from(byFolder.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const fname of sortedFolders) {
    container.appendChild(_renderFolderSection({
      name: fname,
      books: byFolder.get(fname),
      isUngrouped: false,
    }));
  }
  if (ungrouped.length > 0) {
    container.appendChild(_renderFolderSection({
      name: null,
      books: ungrouped,
      isUngrouped: true,
    }));
  }

  if (multiselectActive) updateMultiselectToolbar();
}

async function onBookAction(act, book) {
  if (act === 'parse') {
    await withBusy(async () => {
      openParseModal([book.file_id]);
      await callApi('parse_books_batch', [book.file_id]);
    });
  } else if (act === 'reparse') {
    if (!(await showConfirm(
      `重新解析「${book.title}」会清除现有缓存并重抽，需要等几十秒到几分钟。\n通常仅在缓存损坏或抽取逻辑升级时用得到。\n\n确定继续吗？`,
      '重新解析',
    ))) return;
    await withBusy(async () => {
      await callApi('clear_book_caches', [book.file_id]);
      openParseModal([book.file_id]);
      await callApi('parse_books_batch', [book.file_id]);
    });
  } else if (act === 'move') {
    await moveBookInteractive(book);
  } else if (act === 'edit') {
    await editBookMeta(book);
  } else if (act === 'remove') {
    if (!(await showConfirm(`确定从书架移除「${book.title}」？\n（不会删除你电脑上的 PDF）`, '移除书籍'))) return;
    await withBusy(async () => {
      await callApi('remove_book', book.file_id);
      refreshBookList();
    });
  }
}

function _folderSelectHtml(currentFolder, idPrefix = 'm') {
  const folders = window._lastFolders || [];
  const opts = ['<option value="">（未分组）</option>'];
  for (const f of folders) {
    const sel = (f === currentFolder) ? ' selected' : '';
    opts.push(`<option value="${escapeHtml(f)}"${sel}>${escapeHtml(f)}</option>`);
  }
  opts.push('<option value="__new__">+ 新建文件夹…</option>');
  return `<select id="${idPrefix}-folder">${opts.join('')}</select>`;
}

// =========================================================
// 智能识别书目信息（编辑模态用）
// =========================================================
//
// 仿电商解析地址的"剥洋葱"策略：
//   1. 先抓强锚点（年份 / [M] 类型标签 / 出版社后缀）
//   2. 字典查表（知名出版社→所在城市、常见出版地）
//   3. 关键字驱动（著/编/译 前面是作者；《》内是书名）
//   4. GB/T 7714 规整解析（如检测到 [M]：第一段=作者, 末段=书名）
//   5. 兜底：去掉已识别部分，按"作者在前书名在后"的中文文献惯例分段

// 常见出版地城市表
const _CITIES = [
  // 直辖市 / 主要城市
  '北京', '上海', '广州', '深圳', '杭州', '南京', '武汉', '西安', '成都', '重庆',
  '天津', '沈阳', '大连', '长春', '哈尔滨', '长沙', '济南', '青岛', '郑州', '福州',
  '厦门', '昆明', '贵阳', '兰州', '太原', '石家庄', '合肥', '南昌', '南宁', '海口',
  '香港', '澳门', '台北', '北平', '桂林', '苏州', '无锡', '宁波', '温州',
  '银川', '西宁', '呼和浩特', '拉萨',
  // 省名 — 实务中常见用 省 作为 place（尤其老式或简化引用）
  '安徽', '江苏', '浙江', '山东', '河北', '河南', '湖北', '湖南',
  '福建', '江西', '广东', '广西', '海南', '四川', '贵州', '云南',
  '陕西', '甘肃', '青海', '山西', '辽宁', '吉林', '黑龙江', '台湾',
  '内蒙古', '新疆', '宁夏', '西藏',
];

// 知名出版社 → 出版地映射（命中即直接给出 place，无需再扫前文）
const _PUBLISHER_TO_CITY = {
  '商务印书馆': '北京', '中华书局': '北京', '三联书店': '北京',
  '生活·读书·新知三联书店': '北京',
  '人民出版社': '北京', '人民文学出版社': '北京', '人民教育出版社': '北京',
  '法律出版社': '北京', '高等教育出版社': '北京',
  '中国社会科学出版社': '北京', '社会科学文献出版社': '北京', '中央编译出版社': '北京',
  '北京大学出版社': '北京', '清华大学出版社': '北京', '中国人民大学出版社': '北京',
  '北京师范大学出版社': '北京', '北京出版社': '北京', '文物出版社': '北京',
  '中国青年出版社': '北京', '中国大百科全书出版社': '北京', '故宫出版社': '北京',
  '上海人民出版社': '上海', '上海古籍出版社': '上海', '上海译文出版社': '上海',
  '上海文艺出版社': '上海', '上海辞书出版社': '上海',
  '复旦大学出版社': '上海', '同济大学出版社': '上海', '华东师范大学出版社': '上海',
  '上海交通大学出版社': '上海',
  '江苏人民出版社': '南京', '江苏古籍出版社': '南京', '凤凰出版社': '南京',
  '南京大学出版社': '南京', '南京师范大学出版社': '南京', '东南大学出版社': '南京',
  '译林出版社': '南京',
  '浙江大学出版社': '杭州', '浙江人民出版社': '杭州', '浙江古籍出版社': '杭州',
  '浙江文艺出版社': '杭州',
  '安徽教育出版社': '合肥', '安徽人民出版社': '合肥', '安徽文艺出版社': '合肥',
  '黄山书社': '合肥',
  '巴蜀书社': '成都', '四川人民出版社': '成都', '四川大学出版社': '成都',
  '武汉大学出版社': '武汉', '华中科技大学出版社': '武汉', '长江文艺出版社': '武汉',
  '中山大学出版社': '广州', '广东人民出版社': '广州', '花城出版社': '广州',
  '广西师范大学出版社': '桂林', '漓江出版社': '桂林',
  '山东人民出版社': '济南', '齐鲁书社': '济南', '山东大学出版社': '济南',
  '福建人民出版社': '福州', '厦门大学出版社': '厦门',
  '湖南人民出版社': '长沙', '岳麓书社': '长沙',
  '西安交通大学出版社': '西安', '陕西人民出版社': '西安', '陕西师范大学出版社': '西安',
  '三秦出版社': '西安',
  '天津人民出版社': '天津', '南开大学出版社': '天津',
  '河南人民出版社': '郑州', '中州古籍出版社': '郑州',
  '河北人民出版社': '石家庄', '河北教育出版社': '石家庄',
  '辽宁人民出版社': '沈阳', '吉林大学出版社': '长春',
  '黑龙江人民出版社': '哈尔滨', '云南人民出版社': '昆明',
  '贵州人民出版社': '贵阳', '海南出版社': '海口',
};

// 判断 s 中 idx 位置是否在 () / （） 内（向前扫；遇到换行算结束作用域）
function _inParens(s, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const c = s[i];
    if (c === '(' || c === '（') return true;
    if (c === ')' || c === '）') return false;
    if (c === '\n') return false;
  }
  return false;
}

function parseBookMetadata(input) {
  const out = {
    title: '', author: '', publisher: '', year: '', place: '', doc_type: '',
    // 新增 4 字段（默认空串）
    role: '', country: '', translator: '', edition: '',
    _meta: {
      strippedSecondaries: [],  // [{name, role}]
      strippedEditions: [],     // ["第2版", ...]
      yearCandidates: [],       // [{value, idx, score}]
      yearChosen: null,         // {value, idx, score} or null
      yearLowConfidence: false,
    },
  };
  if (!input || typeof input !== 'string') return out;

  // 1. 归一化：全角数字字母 → 半角，统一空白
  let s = input.trim();
  s = s.replace(/[０-９Ａ-ｚ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/　/g, ' ').replace(/[ \t]+/g, ' ');

  // 2. 强信号：文献类型 [M]/[J]/[N]/[D]/[P]/[C]/[R]/[S]
  const typeMatch = s.match(/\[([MJNDPCRS])\]/i);
  let docTypeTextInS = null;
  if (typeMatch) {
    out.doc_type = typeMatch[1].toUpperCase();
    docTypeTextInS = typeMatch[0];
  }

  // 2.5 国别前缀检测：[日] / [美] / ［日］ / 〔日〕 在 author 位置出现
  //     护栏：不能是已识别的文献类型标签（[M]/[J]/...），后面跟字符必须是 CJK / Latin（看着像作者名开头）
  {
    const countryRe = /[\[［〔]\s*([^\]］〕\s]{1,8})\s*[\]］〕]/g;
    let cm;
    while ((cm = countryRe.exec(s)) !== null) {
      const inner = cm[1];
      // 排除：单个英文文献类型字符
      if (/^[MJNDPCRS]$/i.test(inner)) continue;
      // 后字必须是 CJK 或 Latin（确保接的是作者名，不是其他括号注释）
      const afterCh = s[cm.index + cm[0].length];
      if (!afterCh || !/[一-鿿A-Za-z·]/.test(afterCh)) continue;
      out.country = inner;
      break;
    }
  }

  // 3. 强信号：出版社（中文后缀）— 同时记下结束位置，给年份评分用
  //    三层试探，从最稳到最贪：
  //      3a. 锚定正则（前面有分隔符 / 字符串起点）—— 最可靠
  //      3b. 已知出版社名查表 —— 无空格输入也能切对
  //      3c. 非锚定正则 —— 兜底，可能 over-match
  let publisherEndIdx = -1;
  const pubSuffixGroup =
    '(?:出版社|书局|书社|印书馆|书店|出版集团|出版公司|出版有限公司|出版股份有限公司|大学出版社)';

  // 3a. 锚定（真分隔符 + 出版社）—— 不允许 ^ 锚定，避免无空格输入把整串吞进
  //     publisher。string-start 的情形让 3b 已知表负责。
  {
    const anchoredRe = new RegExp(
      `[\\s,，.。、;；:：]([一-鿿]{2,15}${pubSuffixGroup})`
    );
    const m = s.match(anchoredRe);
    if (m) {
      out.publisher = m[1];
      publisherEndIdx = m.index + m[0].length;
    }
  }

  // 3b. 查已知出版社名表（无锚定也命中）—— 选最长的避免 "中国" 错抓 "中国人民出版社" 之类
  if (!out.publisher) {
    let bestKnown = null;
    for (const knownPub of Object.keys(_PUBLISHER_TO_CITY)) {
      const idx = s.indexOf(knownPub);
      if (idx >= 0 && (!bestKnown || knownPub.length > bestKnown.value.length)) {
        bestKnown = { value: knownPub, idx };
      }
    }
    if (bestKnown) {
      out.publisher = bestKnown.value;
      publisherEndIdx = bestKnown.idx + bestKnown.value.length;
    }
  }

  // 3c. 非锚定（兜底）
  if (!out.publisher) {
    const freeRe = new RegExp(`[一-鿿]{2,15}${pubSuffixGroup}`);
    const pubMatch = s.match(freeRe);
    if (pubMatch) {
      out.publisher = pubMatch[0];
      publisherEndIdx = pubMatch.index + pubMatch[0].length;
    } else {
      const enPub = s.match(/[A-Z][A-Za-z&\s]+(?:Press|Publishing|Publishers|Books)/);
      if (enPub) {
        out.publisher = enPub[0].trim();
        publisherEndIdx = enPub.index + enPub[0].length;
      }
    }
  }

  // 4. 年份评分：每个候选打分，挑分数最高的（平分则取位置最靠后的）
  //    - 在 () 或 （） 内：-100（书名里的年份范围）
  //    - 紧贴中英文字母（且后字不是 "年"）：-50（像是书名的一部分，比如 "请回答1998" / "Friends1994"）
  //    - 在出版社后 ≤20 字符：+50（典型 GB/T 7714 末尾出版年）
  //    - 在出版社后 ≤50 字符：+20
  //    - 在出版社之前：-20
  {
    const yearRe = /(?:19|20)\d{2}/g;
    const candidates = [];
    let ym;
    while ((ym = yearRe.exec(s)) !== null) {
      const idx = ym.index;
      const val = ym[0];
      let score = 100;

      if (_inParens(s, idx)) score -= 100;

      const beforeCh = s[idx - 1];
      const afterCh = s[idx + val.length];
      // 包含中文 (一-鿿) 与英文字母 (A-Za-z)；后字若为"年"则不算紧贴
      if (beforeCh && /[一-鿿A-Za-z]/.test(beforeCh)) score -= 50;
      if (afterCh && /[一-鿿A-Za-z]/.test(afterCh) && afterCh !== '年') score -= 50;

      if (publisherEndIdx >= 0) {
        if (idx > publisherEndIdx) {
          const dist = idx - publisherEndIdx;
          if (dist <= 20) score += 50;
          else if (dist <= 50) score += 20;
        } else {
          score -= 20;
        }
      }

      candidates.push({ value: val, idx, score });
    }
    out._meta.yearCandidates = candidates.slice();
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score || b.idx - a.idx);
      const chosen = candidates[0];
      out._meta.yearChosen = chosen;
      out.year = chosen.value;
      if (chosen.score < 50) out._meta.yearLowConfidence = true;
    }
  }

  // 5. 出版地：用户在原文里显式写的 city/province 优先；
  //    出版社映射 (_PUBLISHER_TO_CITY) 只作兜底。
  //    用分隔符护栏匹配，避免 "安徽出版社" 被抠出 place="安徽"。
  {
    const _escapeRe = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const _hasStandaloneCity = (text, city) =>
      new RegExp(`(^|[\\s,，.。、;；:：])${_escapeRe(city)}(?=[\\s,，.。、;；:：]|$)`).test(text);

    // 先在原文里找显式 token —— 排除出版社那一段
    if (out.publisher) {
      const pubIdx = s.indexOf(out.publisher);
      const beforeScope = s.slice(0, pubIdx);
      const afterScope = s.slice(pubIdx + out.publisher.length);
      for (const city of _CITIES) {
        if (_hasStandaloneCity(beforeScope, city) || _hasStandaloneCity(afterScope, city)) {
          out.place = city;
          break;
        }
      }
    } else {
      for (const city of _CITIES) {
        if (_hasStandaloneCity(s, city)) {
          out.place = city;
          break;
        }
      }
    }
    // 兜底：知名出版社映射（用户没显式写 place 时才用）
    if (!out.place && out.publisher && _PUBLISHER_TO_CITY[out.publisher]) {
      out.place = _PUBLISHER_TO_CITY[out.publisher];
    }
  }

  // 6a. 剥离次要贡献者（任意位置）— 形式 ①：name + 逗号 + role
  //    名字部分可含逗号（让"耿云志，欧阳哲生，整理"整段一起剥）；
  //    "编" 用负向预查避免吃掉 编著/编译/编辑/编校/编选 这类复合主作者标记。
  const SECONDARY_ROLES = '整理|编辑|编校|校点|校注|注释|校译|审定|审校|标点|点校|选注';
  const secondaryRe1 = new RegExp(
    `([^.。;；\\n\\[\\]【】]{2,50})\\s*[,，]\\s*(${SECONDARY_ROLES}|编(?!著|译|辑|校|选))(?=[\\s.。;；\\n,，、)\\]】]|$)`,
    'g'
  );
  let workingS = s.replace(secondaryRe1, (match, name, role) => {
    out._meta.strippedSecondaries.push({ name: name.trim(), role });
    return ' ';
  });

  // 6b. 剥离次要贡献者 — 形式 ②：name + role（无逗号）
  //    用于用户偷懒不打标点的稀疏输入，比如 "胡适 请回答1998 曹伯言整理 合肥 ..."
  //    护栏更严：
  //    - 名字必须 2-5 字 CJK（典型人名长度）
  //    - 前面必须有空白/分隔符（不在字符串开头，避免误剥首位作者）
  //    - 后面必须有空白/分隔符（避免 "胡适整理日记" 这种连贯字符串被误割）
  const secondaryRe2 = new RegExp(
    `([\\s,，.。、;；])([一-鿿]{2,5})(${SECONDARY_ROLES})(?=[\\s,，.。、;；)\\]】]|$)`,
    'g'
  );
  workingS = workingS.replace(secondaryRe2, (match, leading, name, role) => {
    out._meta.strippedSecondaries.push({ name, role });
    return leading + ' ';
  });

  // 7. 剥离版本标记（第N版 / 修订版 / 增订版 / 新版 / 再版 / 影印本 / 影印版）
  //    暴露第一处给 out.edition：数字版次抽数字（"第2版"→"2"）；其他关键词原样
  workingS = workingS.replace(
    /(第\s*(\d+)\s*版|修订版|增订版|新版|再版|影印本|影印版)/g,
    (m, _whole, num) => {
      out._meta.strippedEditions.push(m);
      if (!out.edition) {
        if (num) out.edition = num;
        else if (/修订/.test(m)) out.edition = '修订';
        else if (/增订/.test(m)) out.edition = '增订';
        else if (/新版/.test(m)) out.edition = '新版';
        else if (/再版/.test(m)) out.edition = '再版';
        else if (/影印/.test(m)) out.edition = '影印';
      }
      return ' ';
    }
  );

  // 8. 书名：优先 《》/「」/﹝﹞
  const quotedMatch = s.match(/《([^》]+)》|「([^」]+)」|﹝([^﹞]+)﹞/);
  if (quotedMatch) {
    out.title = (quotedMatch[1] || quotedMatch[2] || quotedMatch[3]).trim();
  }

  // 9. GB/T 7714 解析：检测到 [M]，按"句级分隔符"切段
  //    末段（含 [M]）= 书名，第一段 = 作者
  //    关键改动：分隔符只用 .。;；\n —— 不再用 :,，：、，避免把
  //    "胡适全集：第23卷" 在 : 处截断丢前半段
  if (docTypeTextInS) {
    const dtReInWorking = /\[([MJNDPCRS])\]/i;
    const dtInWorking = workingS.match(dtReInWorking);
    if (dtInWorking) {
      const segs = workingS
        .split(/[.。;；\n]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const titleSegIdx = segs.findIndex((x) => dtReInWorking.test(x));
      if (titleSegIdx >= 0) {
        if (!out.title) {
          out.title = segs[titleSegIdx].replace(/\[[MJNDPCRS]\]/gi, '').trim();
        }
        if (!out.author && titleSegIdx >= 1) {
          let cand = segs[0].trim();
          // 剥常见前缀：序号 "[1]"、标签 "参考文献:" / "引用:" 等
          cand = cand.replace(/^\[\d+\]\s*/, '');
          cand = cand.replace(
            /^(参考文献|引文|引用|附录|文献|参考资料|资料来源|出处)\s*[:：]\s*/, ''
          );
          // 去掉作者末尾残留的主作者标记
          cand = cand.replace(/[\s]*(编著|编译|主编|选编|主译|笔录|执笔|著|编|译|撰)[\s]*$/, '').trim();
          // 验证：长度合理、不含出版机构后缀、不是书名
          if (cand && cand.length >= 2 && cand.length <= 50 &&
              !/(出版社|书局|印书馆|书店)/.test(cand) &&
              !cand.includes('《') &&
              cand !== out.title) {
            out.author = cand;
          }
        }
        // 作者和书名挤在同一段（用 , 而非 . 分隔）：拆首个逗号
        //   例: "胡适, 胡适日记[M]." → segs[0] = "胡适, 胡适日记[M]"
        //   只在首个逗号前的字段「像作者名」（CJK / Latin / · / [国籍]）才剥
        if (!out.author && titleSegIdx === 0) {
          const seg = segs[0];
          const commaIdx = seg.search(/[,，]/);
          if (commaIdx > 0) {
            const candAuthor = seg.slice(0, commaIdx).trim();
            const candTitle = seg.slice(commaIdx + 1).replace(/\[[MJNDPCRS]\]/gi, '').trim();
            // candAuthor 必须长得像人名：CJK / Latin / 中点 / 空白 / [国籍] 前缀
            const looksLikeAuthor =
              /^(?:\[[^\]]{1,8}\]\s*)?[一-鿿A-Za-z·\s]{2,30}$/.test(candAuthor) &&
              !/(出版社|书局|印书馆|书店)/.test(candAuthor);
            if (looksLikeAuthor && candTitle.length >= 1) {
              out.author = candAuthor;
              out.title = candTitle;
            }
          }
        }
      }
    }
  }

  // 10. 主作者关键字兜底（只用 PRIMARY 标记，不含 整理/编辑 等次要角色）
  //     适用于没有 [M] 的输入，比如 "胡适 著. 胡适日记..."
  //     注：cand 保留 marker 末尾（如 "任继愈主编"），由后续 12.5 步骤统一剥离并写入 out.role
  if (!out.author) {
    const PRIMARY = /(编著|编译|选编|主译|主编|著|译|撰)(?![一-鿿])/g;
    let lastMarker = null;
    let mm;
    while ((mm = PRIMARY.exec(workingS)) !== null) lastMarker = mm;
    if (lastMarker) {
      const markerEnd = lastMarker.index + lastMarker[0].length;
      const before = workingS.slice(0, markerEnd);
      const strongSepRe = /[.。;；\n]/g;
      let lastSep = -1;
      let sm;
      // 只在 marker 之前找分隔符，避免把 marker 本身切掉
      const beforeMarker = workingS.slice(0, lastMarker.index);
      while ((sm = strongSepRe.exec(beforeMarker)) !== null) lastSep = sm.index;
      let cand = before.slice(lastSep + 1).trim();
      cand = cand.replace(/[,，]\s*$/, '').trim();
      if (cand && cand.length >= 2 && cand.length <= 50 &&
          !/(出版社|书局|印书馆|书店)/.test(cand) &&
          !cand.includes('《') &&
          cand !== out.title) {
        out.author = cand;
      }
    }
  }

  // 11. 标签法兜底（"作者:" / "书名:"）
  if (!out.author) {
    const lab = workingS.match(/(?:作者|编者|编著者)\s*[:：]\s*([^\s,，.。、；;:：\n\r]{2,50})/);
    if (lab) out.author = lab[1].trim();
  }
  if (!out.title) {
    const lab = workingS.match(/(?:书名|题名|标题|题目)\s*[:：]\s*([^\n\r\[\]【】]{1,80})/);
    if (lab) out.title = lab[1].trim();
  }

  // 12. 终极兜底：剥已识别字段后剩下的最长片段
  if (!out.title || !out.author) {
    // 用上下文护栏剥已识别字段，避免书名里恰好含同字（"南京大屠杀史" 里的"南京"）
    // 被错剥。要求前后是空白/标点/字符串边界。
    const escapeRe = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripWord = (text, word) => {
      if (!word) return text;
      const re = new RegExp(`(^|[\\s,，.。、;；:：])${escapeRe(word)}(?=[\\s,，.。、;；:：]|$)`, 'g');
      return text.replace(re, '$1 ');
    };

    // 年份的剥离需要特殊处理：除了"2003"本身，还要能吞掉常见后缀
    // （年/年版/年初版/年首版/年出版/年印/月）—— 否则 "2003年出版" 会被当成书名。
    const stripYear = (text, year) => {
      if (!year) return text;
      const re = new RegExp(
        `(^|[\\s,，.。、;；:：])${escapeRe(year)}\\s*(?:年\\s*(?:出版|初版|首版|新版|再版|版|印|月)?)?(?=[\\s,，.。、;；:：]|$)`,
        'g'
      );
      return text.replace(re, '$1 ');
    };

    let scratch = workingS;
    scratch = stripWord(scratch, out.publisher);
    scratch = stripYear(scratch, out.year);
    scratch = stripWord(scratch, out.place);
    scratch = stripWord(scratch, out.author);
    scratch = stripWord(scratch, out.title);
    if (out.doc_type) scratch = scratch.replace(/\[[MJNDPCRS]\]/gi, ' ');
    // 步骤 8 已经从 《》 / 「」/ ﹝﹞ 抽出 title；这里把这些括号连内容一起从 scratch 抠掉，
    // 否则 "黄仁宇：《万历十五年》（）..." 这种残留会被当 author。
    scratch = scratch.replace(/《[^》]*》|「[^」]*」|﹝[^﹞]*﹞/g, ' ');
    // 步骤 7 把 "第N版"/"修订版" 等替成空格，但留下 "（  ）" 这种空壳；清掉
    scratch = scratch.replace(/（\s*）|\(\s*\)/g, ' ');

    // 先按句级分隔符切；如果只切出 1 段且段内有空白，再按空白细分
    // —— 处理 "胡适 请回答1998 ..." 这种无标点的稀疏输入
    let segs = scratch
      .split(/[.。;；\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (segs.length === 1 && /\s/.test(segs[0])) {
      segs = segs[0].split(/\s+/).map((x) => x.trim()).filter(Boolean);
    }

    const filtered = segs.filter((x) => {
      if (x.length < 2) return false;
      if (/^\d+$/.test(x)) return false;
      if (/^[\d\-\sxX]+$/.test(x)) return false;
      if (/^(著|编|译|主编|主译|选编|编著|编译|撰|笔录|执笔|等)$/.test(x)) return false;
      if (!/[一-鿿A-Za-z]/.test(x)) return false;
      return true;
    });

    // 取 author/title 的启发：
    //   - 1 token：当书名
    //   - 2 token：第一个=作者，第二个=书名
    //   - 3+ token：第一个=作者；剩下里挑「最长」当书名（书名一般比地名/省名长）
    //     —— 解决 "胡适 胡适全集 安徽" 这种残留把 "安徽" 当成书名的 bug
    if (!out.title && filtered.length >= 1) {
      if (filtered.length >= 3) {
        const rest = filtered.slice(1);
        rest.sort((a, b) => b.length - a.length);
        out.title = rest[0];
      } else {
        out.title = filtered[filtered.length - 1];
      }
    }
    if (!out.author && filtered.length >= 2) {
      const first = filtered[0];
      if (first !== out.title && first.length <= 50) {
        out.author = first;
      }
    }
  }

  // 12.5 暴露 role：检测 author 末尾的责任方式 marker，剥下来写到 out.role
  //      只在 author 已确定时做。"著"/"撰" 归一化为空。
  //      注意：若 author marker 是"译"，本人就是译者；保留 author 即可（不写到 translator）。
  let authorIsTranslator = false;
  if (out.author) {
    // 先剥掉 author 开头的国别前缀（与 step 2.5 检测到的 country 对应）
    if (out.country) {
      const countryStripRe = /^[\[［〔]\s*[^\]］〕]{1,8}\s*[\]］〕]\s*/;
      out.author = out.author.replace(countryStripRe, '').trim();
    }
    const roleRe = /(编著|编译|主编|选编|编辑|编校|编)$/;
    const rm = out.author.match(roleRe);
    if (rm) {
      out.author = out.author.slice(0, -rm[1].length).trim();
      out.role = rm[1];
    } else {
      const omitRe = /(著|撰)$/;
      const om = out.author.match(omitRe);
      if (om) {
        out.author = out.author.slice(0, -om[1].length).trim();
        out.role = '';
      } else {
        // 末尾是"译/主译"？整本书的主要责任人就是译者
        const trRe = /(主译|译)$/;
        const tm = out.author.match(trRe);
        if (tm) {
          authorIsTranslator = true;
        }
      }
    }
  }

  // 12.6 译者检测："X译" 段。若 author 自己就是译者（12.5 已标），不重复设置
  if (!authorIsTranslator && !out.translator) {
    // 候选：靠近书名后、出版社前的"...译"
    //   X 部分：CJK 名字（含人名连缀的"、"），2-30 字
    const translatorRe = /([一-鿿]{2,30}(?:、[一-鿿]{2,30})*)\s*译(?![一-鿿])/g;
    let tm;
    while ((tm = translatorRe.exec(s)) !== null) {
      const cand = tm[1];
      // 不能恰好等于已识别的 author（避免 author=译者 那种 12.5 已处理的场景重新踩进来）
      if (cand && cand !== out.author) {
        out.translator = cand;
        break;
      }
    }
  }

  // 13. 收尾清理：只去首尾空白和小标点（不动各类括号）
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string' && out[k]) {
      out[k] = out[k].replace(/^[\s,，.。、；;:：]+|[\s,，.。、；;:：]+$/g, '').trim();
    }
  }

  return out;
}

async function editBookMeta(book) {
  const result = await showModal({
    title: '编辑书籍信息',
    bodyHtml: `
      <div class="smart-parse-block">
        <div class="smart-parse-title">📝 智能识别（可选 · 自动填充下方各栏）</div>
        <div class="smart-parse-hint">
          把书的全部信息一股脑粘贴到这里，按"识别"自动拆出作者、书名、出版社等。
          <br><span class="dim">示例：<code>胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001.</code></span>
        </div>
        <textarea id="m-smart-input" rows="3" placeholder="把整段书目信息贴进来..."></textarea>
        <div class="smart-parse-actions">
          <button class="btn-secondary" id="m-smart-btn" type="button">✨ 识别并填写</button>
          <span id="m-smart-status" class="smart-parse-status"></span>
        </div>
      </div>

      <label>作者</label><input id="m-author" value="${escapeHtml(book.author)}" />
      <label>责任方式 <span class="hint-inline">（著/编/主编/译/整理，"著"自动省略）</span></label>
        <input id="m-role" value="${escapeHtml(book.role || '')}" placeholder="可留空" />
      <label>国别 <span class="hint-inline">（如"日""美"，留空则不输出 [国别] 前缀）</span></label>
        <input id="m-country" value="${escapeHtml(book.country || '')}" placeholder="可留空" />
      <label>书名</label><input id="m-title" value="${escapeHtml(book.title)}" />
      <label>译者 <span class="hint-inline">（如"谭汝谦、林启彦"）</span></label>
        <input id="m-translator" value="${escapeHtml(book.translator || '')}" placeholder="可留空" />
      <label>版次 <span class="hint-inline">（如填"2"渲染为"(第2版)"）</span></label>
        <input id="m-edition" value="${escapeHtml(book.edition || '')}" placeholder="可留空" />
      <label>文献类型（M=专著, J=期刊, N=报纸）</label>
        <input id="m-doctype" value="${escapeHtml(book.doc_type)}" />
      <label>出版地</label><input id="m-place" value="${escapeHtml(book.place)}" />
      <label>出版社</label><input id="m-pub" value="${escapeHtml(book.publisher)}" />
      <label>出版年</label><input id="m-year" value="${escapeHtml(book.year)}" />
      <label>文件夹</label>${_folderSelectHtml(book.folder || '', 'm')}
    `,
    onOk: async () => {
      let folder = $('#m-folder').value;
      if (folder === '__new__') {
        const name = prompt('新文件夹名：');
        if (!name || !name.trim()) return false;
        folder = name.trim();
        await callApi('create_folder', folder);
      }
      return {
        author: $('#m-author').value.trim(),
        role: $('#m-role').value.trim(),
        country: $('#m-country').value.trim(),
        title: $('#m-title').value.trim(),
        translator: $('#m-translator').value.trim(),
        edition: $('#m-edition').value.trim(),
        doc_type: $('#m-doctype').value.trim() || 'M',
        place: $('#m-place').value.trim(),
        publisher: $('#m-pub').value.trim(),
        year: $('#m-year').value.trim(),
        folder: folder || null,
      };
    },
  });
  if (result) {
    await callApi('update_book', book.file_id, result);
    refreshBookList();
  }
}

// 把 FileSystemFileHandle[] 导入书架的完整流程（选文件夹 / 注册 / 批量解析）。
// 被两处复用：① 「+ 添加书籍」按钮 ② 全局拖拽 drop。
// 调用方需自己保证已经在 withBusy() 里（除了 ensureLibraryNotEmpty 这种例外）。
async function importPdfHandles(handles, opts = {}) {
  const nonPdfSkipped = opts.nonPdfSkipped || 0;
  const sourceLabel = opts.sourceLabel || '';  // "拖入"/"" — 仅影响起始 status 文案

  if (!handles || handles.length === 0) {
    if (nonPdfSkipped > 0) {
      await showAlert(
        `没有找到 PDF 文件（已忽略 ${nonPdfSkipped} 个非 PDF 文件）。`,
        '没有可导入的 PDF',
      );
    }
    return;
  }

  // 一次性量超大时多问一句
  if (handles.length > 50) {
    if (!(await showConfirm(
      `即将一次性添加 ${handles.length} 本 PDF（每本首次解析需要 10-60 秒）。\n确定继续？`,
      '大批量导入',
    ))) return;
  }

  // 把 handle 暂存到 _pendingHandles，供 add_book_quick 读
  const paths = handles.map((h) => h.name);
  _pendingHandles.clear();
  for (let i = 0; i < paths.length; i++) {
    _pendingHandles.set(paths[i], handles[i]);
  }

  // 刷一下文件夹下拉
  try {
    const fr = await callApi('list_folders');
    window._lastFolders = (fr.folders || []).map((f) => f.name);
  } catch (_) {}

  // 选目标文件夹
  const titlePrefix = sourceLabel ? `${sourceLabel}` : '导入';
  const result = await showModal({
    title: `${titlePrefix}到哪个文件夹？（${paths.length} 本${nonPdfSkipped > 0 ? `，已忽略 ${nonPdfSkipped} 个非 PDF` : ''}）`,
    bodyHtml: `
      <p class="dim" style="font-size:12px;">本次新增书籍：${paths.map(escapeHtml).join('、')}</p>
      <label>放入文件夹</label>${_folderSelectHtml('', 'add')}
      <p class="dim" style="font-size:11px;margin-top:8px;">书的元信息（作者/出版社等）随后可在书架卡片点「编辑」补全。</p>
    `,
    okText: '继续导入',
    onOk: async () => {
      let f = $('#add-folder').value;
      if (f === '__new__') {
        const name = prompt('新文件夹名：');
        if (!name || !name.trim()) return false;
        f = name.trim();
        await callApi('create_folder', f);
      }
      return { folder: f || null };
    },
  });
  if (result === null || typeof result !== 'object') return;
  const targetFolder = result.folder;

  // 注册
  const added = [];
  const skipped = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    setStatus(`登记中 ${i + 1}/${paths.length}：${p}`);
    try {
      const r = await callApi('add_book_quick', p);
      if (r.skipped) {
        skipped.push({ filename: p, reason: r.reason });
      } else if (r.book) {
        added.push(r.book);
      }
    } catch (e) {
      // callApi 已经 showAlert 了，这里再列一行让用户看到
      skipped.push({ filename: p, reason: String(e.message || e) });
    }
  }

  if (targetFolder && added.length > 0) {
    await callApi('update_book_folders', added.map((b) => b.file_id), targetFolder);
  }
  refreshBookList();

  if (skipped.length) {
    const lines = skipped.map((s) => `· ${s.filename}（${s.reason}）`).join('\n');
    await showAlert(
      `本次添加 ${added.length} 本，跳过 ${skipped.length} 本：\n\n${lines}`,
      '导入结果',
    );
  }

  if (added.length > 0) {
    const ids = added.map((b) => b.file_id);
    openParseModal(ids);
    await callApi('parse_books_batch', ids);
    await showAlert(
      `已添加 ${added.length} 本书并完成解析（或被取消的部分需稍后重试）。\n\n` +
      `出版社、年份等出版信息留空，可在书架卡片点「编辑」补全。`,
      '导入完成',
    );
  }
  setStatus(`批量导入完成 · 新增 ${added.length} 本，跳过 ${skipped.length} 本`);
}

$('#btn-add-book').addEventListener('click', () => withBusy(async () => {
  // 网页版必须在 click 上下文里调 showOpenFilePicker
  const picked = await callApi('pick_pdf_files');
  const handles = picked.handles || [];
  if (handles.length === 0) return;
  await importPdfHandles(handles);
}));

// =========================================================
// 文档扫描
// =========================================================
let lastScanResults = [];

// 最近一次 scan / lookup 时拿到的 books_meta，给 renderResultCard 当 fallback：
// 当 Python 端没返回 candidate.citation（例如 service-worker 还在用旧版 pysrc
// 缓存）时，JS 端能直接按 book_file 拼一条 GB/T 7714 风格的"出处建议"。
let _lastBooksMeta = {};

// 每张已渲染卡片的元数据缓存。chip 切换 / 单卡重渲染时按 cardId 查回
// meta + 页码字段，无需重新解析整个结果树。页面刷新即清空。
const _cardMetaMap = new Map();

// chip 点击：弹出格式下拉菜单；点空白处关菜单。
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.fmt-chip');
  if (chip) {
    e.preventDefault();
    e.stopPropagation();
    showFmtChipMenu(chip);
    return;
  }
  // 点 chip 之外的地方关闭已开的菜单
  document.querySelectorAll('.fmt-chip-menu').forEach(el => el.remove());
});

// "📋 复制脚注"按钮代理：从 DOM 取 chip 当前渲染出来的脚注文本。
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-copy-citation');
  if (!btn) return;
  const cardId = btn.dataset.cardId;
  const textEl = document.querySelector(`.cand-citation-text[data-card-id="${cardId}"]`);
  if (!textEl) return;
  try {
    await navigator.clipboard.writeText(textEl.textContent);
    setStatus('脚注已复制到剪贴板');
  } catch (err) {
    showAlert('复制到剪贴板失败：' + err, '复制失败');
  }
});

async function showFmtChipMenu(chip) {
  document.querySelectorAll('.fmt-chip-menu').forEach(el => el.remove());
  const cardId = chip.dataset.cardId;
  const currentFmt = chip.dataset.currentFmt;
  const all = await window.xdFormats.listAllFormats();
  const builtins = all.filter(f => f.category === 'builtin');
  const users = all.filter(f => f.category === 'user');

  const renderItems = (arr) => arr.map(f =>
    `<div class="item${f.id === currentFmt ? ' active' : ''}" data-fmt-id="${escapeHtml(f.id)}">
       ${f.id === currentFmt ? '✓ ' : '　 '}${escapeHtml(f.name)}
     </div>`
  ).join('');

  let html = renderItems(builtins);
  if (users.length) html += '<div class="divider"></div>' + renderItems(users);
  html += '<div class="divider"></div>'
       + '<div class="item" data-fmt-id="__manage__">＋ 管理格式…</div>';

  const menu = document.createElement('div');
  menu.className = 'fmt-chip-menu';
  menu.innerHTML = html;
  const rect = chip.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const newFmtId = item.dataset.fmtId;
    if (newFmtId === '__manage__') {
      const tab = document.querySelector('.tab-btn[data-tab="formats"]');
      if (tab) tab.click();
    } else {
      applyCardFormatOverride(cardId, newFmtId);
    }
    menu.remove();
  });
}

async function applyCardFormatOverride(cardId, formatId) {
  const cardData = _cardMetaMap.get(cardId);
  if (!cardData) return;
  const fmt = await window.xdFormats.getFormatById(formatId);
  if (!fmt) return;
  let newCitation;
  try {
    newCitation = window.xdFormats.renderCitation({
      template: fmt.template,
      meta: cardData.meta,
      book_page: cardData.book_page,
      book_page_end: cardData.book_page_end,
      pdf_page: cardData.pdf_page,
    });
  } catch (err) {
    console.error(err); return;
  }
  const chip = document.querySelector(`.fmt-chip[data-card-id="${cardId}"]`);
  if (chip) { chip.dataset.currentFmt = formatId; chip.textContent = `📐 ${fmt.name} ▾`; }
  const textEl = document.querySelector(`.cand-citation-text[data-card-id="${cardId}"]`);
  if (textEl) textEl.textContent = newCitation;
}

// 客户端版的 format_citation —— 必须和 pysrc/citation.py 一致
function _formatCitationJs(meta, bookFile, bookPage, pdfPage) {
  const m = meta || {};
  const author = m.author || 'XX';
  const title = m.title || (bookFile || '').replace(/\.pdf$/i, '') || 'XX';
  const doc_type = m.doc_type || 'M';
  const place = m.place || 'XX';
  const publisher = m.publisher || 'XX出版社';
  const year = m.year || '0000';
  let pagePart;
  if (bookPage != null) pagePart = String(bookPage);
  else if (pdfPage != null) pagePart = `PDF第${pdfPage}页（书内页码待标定）`;
  else pagePart = '页码待补';
  return `${author}. ${title}[${doc_type}]. ${place}: ${publisher}, ${year}: ${pagePart}.`;
}

function renderResultCard(item) {
  const statusMap = {
    hit:  { label: '✓ 自动命中',     color: '#1e823b', cls: 'ok' },
    low:  { label: '⚠ 置信度偏低',   color: '#b78612', cls: 'warn' },
    miss: { label: '✗ 未命中',        color: '#c0392b', cls: 'error' },
  };
  const st = statusMap[item.status];

  const card = document.createElement('div');
  card.className = 'result-card';

  const activeFormatId = window.xdFormats.getActiveFormatId();
  const activeFormatName = (window.xdFormats.BUILTIN_FORMATS.find(f => f.id === activeFormatId) || {}).name || activeFormatId;

  const headerHtml = `
    <div class="header">
      <span class="status-badge ${st.cls}">${st.label}</span>
      <span>[${item.quote_id || '—'}] 引文</span>
    </div>
    <div class="quote">${escapeHtml(item.text)}</div>
  `;

  // 主命中（best）信息，用作主卡片 chip / 复制按钮所属的 card 元数据。
  // 主卡片的"出处（建议）"行原本只有 item.citation，没有 book_file/page，
  // 这些值要从 best 取。如果 item 没有 candidates，主卡片就不挂 chip
  // （没法本地重渲染），保持旧的静态展示。
  const best = (item.candidates && item.candidates.length > 0) ? item.candidates[0] : null;
  const mainCardId = `card-${item.quote_id || 'q'}-main`;

  let citationHtml;
  if (best) {
    _cardMetaMap.set(mainCardId, {
      meta: _lastBooksMeta[best.book_file] || {},
      book_page: best.book_page,
      book_page_end: best.book_page_end,
      pdf_page: best.pdf_page,
      book_file: best.book_file,
    });
    citationHtml = `
      <div class="citation" data-card-id="${mainCardId}">
        <span class="cand-citation-label" data-card-id="${mainCardId}">
          <b>出处（建议）：</b><button class="fmt-chip" data-card-id="${mainCardId}" data-current-fmt="${escapeHtml(activeFormatId)}" type="button">📐 ${escapeHtml(activeFormatName)} ▾</button>
        </span>
        <span class="cand-citation-text" data-card-id="${mainCardId}">${escapeHtml(item.citation)}</span>
      </div>
    `;
  } else {
    citationHtml = `
      <div class="citation"><b>出处（建议）：</b>${escapeHtml(item.citation)}</div>
    `;
  }

  let contextHtml = '';
  if (item.context_before || item.context_after) {
    contextHtml = `
      <div class="ctx-label"><b>原文上下文：</b></div>
      <div class="ctx-text">……${escapeHtml(item.context_before)}<mark>${escapeHtml(item.text)}</mark>${escapeHtml(item.context_after)}……</div>
    `;
  }

  let bestHtml = '';
  if (best) {
    const bp = best.book_page != null ? `书内 p${best.book_page}${best.is_cross_page ? `–${best.book_page_end}` : ''}` : '书内页码未识别';
    const cross = best.is_cross_page ? '<span class="cross-page-tag">跨页</span> ' : '';
    bestHtml = `
      <div class="ctx-label" style="margin-top:8px;"><b>命中位置：</b></div>
      <div class="ctx-text">${cross}${escapeHtml(best.book_file)} · PDF p${best.pdf_page}${best.is_cross_page ? `–${best.pdf_page_end}` : ''} · ${bp}</div>
      <div class="scores">主分 ${best.score.toFixed(2)} · 语境分 ${best.ctx_score.toFixed(2)} · 综合 ${best.final_score.toFixed(2)}</div>
      <div class="ctx-label"><b>书中片段：</b></div>
      <div class="snippet">……${escapeHtml(best.snippet_before)}<span class="highlight">${escapeHtml(item.text)}</span>${escapeHtml(best.snippet_after)}……</div>
      <div class="actions">
        <button class="btn-tiny btn-copy-citation" data-card-id="${mainCardId}" type="button">📋 复制脚注</button>
        <button class="btn-tiny" data-act="open-pdf" data-file="${escapeHtml(best.book_file)}" data-page="${best.pdf_page}">📖 在 PDF 中查看</button>
      </div>
    `;
  } else {
    bestHtml = `
      <div class="ctx-label" style="margin-top:8px;color:#c0392b;"><b>未在书架中找到。</b></div>
      <div class="dim" style="font-size:12px;">可能源自其他文献，或书架里某本 OCR 文字层有缺失。</div>
    `;
  }

  let altHtml = '';
  if (item.candidates && item.candidates.length > 1) {
    const others = item.candidates.slice(1);
    altHtml = `
      <div class="alt-cands">
        <div class="alt-title">其他疑似候选（${others.length} 条，供人工对照）：</div>
        ${others.map((c, i) => {
          const candIdx = i + 1;  // others[0] = candidate index 1（候选 2）
          const cardId = `card-${item.quote_id || 'q'}-${candIdx}`;
          const bp = c.book_page != null ? `书内 p${c.book_page}${c.is_cross_page ? `–${c.book_page_end}` : ''}` : '书内页码未识别';
          const cross = c.is_cross_page ? '<span class="cross-page-tag">跨页</span> ' : '';
          // Python 端理应给每个候选附带 citation；如果没有（例如 SW 还在用
          // 旧版 pysrc 缓存），JS 端用 _lastBooksMeta 做客户端 fallback，
          // 保证候选卡片永远和主命中一样有"出处（建议）"和"复制脚注"。
          const candCitation = c.citation
            || _formatCitationJs(_lastBooksMeta[c.book_file], c.book_file, c.book_page, c.pdf_page);
          _cardMetaMap.set(cardId, {
            meta: _lastBooksMeta[c.book_file] || {},
            book_page: c.book_page,
            book_page_end: c.book_page_end,
            pdf_page: c.pdf_page,
            book_file: c.book_file,
          });
          return `
            <div class="alt-cand-card">
              <div class="alt-cand-header"><b>候选 ${i + 2}</b></div>
              <div class="citation" style="margin-top:6px;" data-card-id="${cardId}">
                <span class="cand-citation-label" data-card-id="${cardId}">
                  <b>出处（建议）：</b><button class="fmt-chip" data-card-id="${cardId}" data-current-fmt="${escapeHtml(activeFormatId)}" type="button">📐 ${escapeHtml(activeFormatName)} ▾</button>
                </span>
                <span class="cand-citation-text" data-card-id="${cardId}">${escapeHtml(candCitation)}</span>
              </div>
              <div class="ctx-label" style="margin-top:8px;"><b>命中位置：</b></div>
              <div class="ctx-text">${cross}${escapeHtml(c.book_file)} · PDF p${c.pdf_page}${c.is_cross_page ? `–${c.pdf_page_end}` : ''} · ${bp}</div>
              <div class="scores">主分 ${c.score.toFixed(2)} · 语境分 ${c.ctx_score.toFixed(2)} · 综合 ${c.final_score.toFixed(2)}</div>
              <div class="ctx-label"><b>书中片段：</b></div>
              <div class="snippet">……${escapeHtml(c.snippet_before)}<span class="highlight">${escapeHtml(item.text)}</span>${escapeHtml(c.snippet_after)}……</div>
              <div class="actions">
                <button class="btn-tiny btn-copy-citation" data-card-id="${cardId}" type="button">📋 复制脚注</button>
                <button class="btn-tiny" data-act="open-pdf" data-file="${escapeHtml(c.book_file)}" data-page="${c.pdf_page}">📖 在 PDF 中查看</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  card.innerHTML = headerHtml + citationHtml + contextHtml + bestHtml + altHtml;

  // open-pdf 还是绑在 data-act 上；copy 改走顶层 .btn-copy-citation 代理，
  // 以便随 chip 状态读取 DOM 文本。
  card.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      if (act === 'open-pdf') {
        const r = await callApi('open_pdf_at_page', btn.dataset.file, parseInt(btn.dataset.page));
        if (r && r.warning) {
          showAlert(r.warning, '提示');
        }
      }
    });
  });

  return card;
}

async function runScan(docxPath) {
  $('#scan-current-file').textContent = docxPath;
  const res = await callApi('scan_document', docxPath, scanScope);
  if (lastScanResults.length === 0 && res.quotes && res.quotes.length > 0) {
    lastScanResults = res.quotes;
    const container = $('#scan-results');
    container.innerHTML = '';
    for (const item of res.quotes) {
      container.appendChild(renderResultCard(item));
    }
  }
}

$('#btn-pick-docx').addEventListener('click', () => withBusy(async () => {
  if (!(await ensureLibraryNotEmpty())) return;
  const picked = await callApi('pick_docx_file');
  if (!picked.path) return;
  await runScan(picked.path);
}));

$('#btn-copy-all-citations').addEventListener('click', async () => {
  if (!lastScanResults.length) {
    showAlert('当前没有扫描结果。请先扫描一份 docx。', '尚未扫描');
    return;
  }
  const hits = lastScanResults.filter((q) => q.status === 'hit');
  if (!hits.length) {
    showAlert('扫描结果中没有"自动命中"的引文。\n（置信度偏低或未找到的条目需要人工核对，未自动加入复制范围。）', '没有可复制的脚注');
    return;
  }
  const lines = hits.map((q) => `[${q.quote_id}] ${q.citation}`);
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`已复制 ${hits.length} 条脚注到剪贴板`);
    showAlert(
      `已复制 ${hits.length} 条自动命中的脚注到剪贴板，可直接粘贴到 Word。\n\n` +
      `（${lastScanResults.length - hits.length} 条置信度偏低/未找到，需人工核对。）`,
      '复制成功',
    );
  } catch (e) {
    showAlert('复制到剪贴板失败：' + e, '复制失败');
  }
});

$('#btn-export-report').addEventListener('click', () => withBusy(async () => {
  if (!lastScanResults.length) {
    showAlert('当前没有扫描结果可导出。请先在「文档扫描」中选一份 docx 完成扫描。', '尚未扫描');
    return;
  }
  const r = await callApi('export_report', '引文核对表.docx');
  if (r.cancelled) return;
  setStatus(`已导出：${r.saved_to}`);
  showAlert('核对表已导出。\n\n（如果浏览器没自动下载，可能被弹窗拦截器拦下了，请检查浏览器右上角。）', '导出成功');
}));

// scan-dropzone 的悬停高亮（仅 UI 反馈）；真正的 drop 处理已统一到全局 router
const dz = $('#scan-dropzone');
['dragenter', 'dragover'].forEach((ev) => {
  dz.addEventListener(ev, (e) => {
    if (!_isFileDrag(e)) return;
    e.preventDefault();
    dz.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  dz.addEventListener(ev, () => { dz.classList.remove('dragover'); });
});

// =========================================================
// 单句查询
// =========================================================
async function runLookup() {
  await withBusy(async () => {
    if (!(await ensureLibraryNotEmpty())) return;
    const quote = $('#lookup-quote').value.trim();
    if (!quote) { showAlert('请输入要查询的引文。'); return; }
    const ctx = $('#lookup-ctx').value.trim();
    setStatus('查询中…');
    const res = await callApi('lookup_quote', quote, ctx, ctx, lookupScope);
    const item = res.quote;
    const container = $('#lookup-results');
    container.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'lookup-header';
    header.innerHTML = `<span class="dim" style="font-size:12px;">查询：</span><b>「${escapeHtml(quote)}」</b>`;
    container.appendChild(header);
    container.appendChild(renderResultCard(item));
    // 首次渲染时通过 rerenderAllCitations 修正用户格式 chip 名（避免显示 user_xxx）
    await rerenderAllCitations();
    setStatus('查询完成');
  });
}

$('#btn-lookup').addEventListener('click', runLookup);
$('#lookup-quote').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runLookup(); }
});
$('#lookup-ctx').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runLookup(); }
});

function bindClearButton(inputId, clearBtnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(clearBtnId);
  const wrap = input && input.parentElement;
  if (!input || !btn || !wrap) return;
  const sync = () => { wrap.classList.toggle('has-value', !!input.value); };
  input.addEventListener('input', sync);
  btn.addEventListener('click', () => { input.value = ''; sync(); input.focus(); });
  sync();
}
bindClearButton('lookup-quote', 'btn-clear-quote');
bindClearButton('lookup-ctx', 'btn-clear-ctx');

// =========================================================
// 设置
// =========================================================
async function openSettings() {
  const [sRes, aRes] = await Promise.all([
    callApi('get_settings'),
    callApi('get_about_info'),
  ]);
  const cur = sRes.settings || DEFAULT_SETTINGS;
  const info = aRes.info || {};

  const depsHtml = Object.entries(info.deps || {})
    .map(([k, v]) => `<div><span class="key">${escapeHtml(k)}：</span>${escapeHtml(v)}</div>`)
    .join('');

  const bodyHtml = `
    <div class="settings-row">
      <label>匹配相似度阈值</label>
      <div class="desc">越高越严格（少误报，但易漏）；越低越宽松（多召回，但可能误报）。默认 0.85。</div>
      <input type="range" id="set-threshold" min="0.50" max="1.00" step="0.01" value="${cur.threshold}" />
      <span class="value-display" id="set-threshold-val">${Number(cur.threshold).toFixed(2)}</span>
    </div>
    <div class="settings-row">
      <label>语境分权重</label>
      <div class="desc">多本书都命中同一句时，前后文相似度的影响力。默认 0.10（仅在打平时起作用）。</div>
      <input type="range" id="set-ctxw" min="0.00" max="0.50" step="0.01" value="${cur.ctx_weight}" />
      <span class="value-display" id="set-ctxw-val">${Number(cur.ctx_weight).toFixed(2)}</span>
    </div>
    <div class="settings-row">
      <label>每条最多列出候选数</label>
      <div class="desc">每条引文最多展示几条候选（含推荐项）。默认 3。</div>
      <input type="range" id="set-topk" min="1" max="10" step="1" value="${cur.top_k}" />
      <span class="value-display" id="set-topk-val">${cur.top_k}</span>
    </div>
    <div class="settings-section">
      <h4>数据</h4>
      <div style="font-size:12px;color:#666;margin-bottom:8px;">
        ${escapeHtml(info.data_dir || '')}
      </div>
      <button class="btn-secondary" id="btn-open-data-dir" type="button">📂 数据位置说明</button>
      <button class="btn-tiny" id="btn-reset-defaults" type="button" style="margin-left:8px;">恢复默认</button>
    </div>
    <div class="settings-section">
      <h4>关于</h4>
      <div class="about-table">
        <div><span class="key">应用：</span>${escapeHtml(info.app_name || '寻典')} ${escapeHtml(info.version || '')}</div>
        <div><span class="key">运行时：</span>${escapeHtml(info.python_version || '')}</div>
        <div><span class="key">数据：</span>${escapeHtml(info.data_dir || '')}</div>
        ${depsHtml}
      </div>
    </div>
  `;

  const result = await showModal({
    title: '⚙ 设置',
    bodyHtml,
    okText: '保存',
    onOk: () => ({
      threshold: parseFloat($('#set-threshold').value),
      ctx_weight: parseFloat($('#set-ctxw').value),
      top_k: parseInt($('#set-topk').value, 10),
    }),
  });

  if (!result) return;
  await callApi('update_settings', result);
  setStatus(`设置已保存：阈值 ${result.threshold} · 语境权重 ${result.ctx_weight} · top-${result.top_k}`);
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'set-threshold') {
    $('#set-threshold-val').textContent = Number(e.target.value).toFixed(2);
  } else if (e.target.id === 'set-ctxw') {
    $('#set-ctxw-val').textContent = Number(e.target.value).toFixed(2);
  } else if (e.target.id === 'set-topk') {
    $('#set-topk-val').textContent = e.target.value;
  }
});

// 编辑书本模态里的「智能识别」按钮（用 event delegation 是因为模态 HTML 动态注入）
document.addEventListener('click', (e) => {
  if (!(e.target && e.target.id === 'm-smart-btn')) return;
  e.preventDefault();
  const input = $('#m-smart-input');
  if (!input) return;
  const text = (input.value || '').trim();
  if (!text) {
    showAlert('请先在上面的文本框里贴入书的信息。', '没有可识别内容');
    return;
  }
  const parsed = parseBookMetadata(text);

  // 把识别结果填到对应 input；总是覆盖（用户已确认想用智能识别）
  // 10 个字段：6 个原字段 + 4 个新字段（role/country/translator/edition）
  const fieldMap = [
    ['m-author', 'author'],
    ['m-role', 'role'],
    ['m-country', 'country'],
    ['m-title', 'title'],
    ['m-translator', 'translator'],
    ['m-edition', 'edition'],
    ['m-doctype', 'doc_type'],
    ['m-place', 'place'],
    ['m-pub', 'publisher'],
    ['m-year', 'year'],
  ];
  let recognizedCount = 0;
  for (const [domId, key] of fieldMap) {
    const el = $('#' + domId);
    if (!el) continue;
    const val = parsed[key];
    if (val) {
      // 识别到了：填入 + 黄色短暂高亮
      el.value = val;
      el.classList.remove('smart-flash');
      void el.offsetWidth;  // 强制 reflow 触发动画重放
      el.classList.add('smart-flash');
      setTimeout(() => el.classList.remove('smart-flash'), 2000);
      recognizedCount += 1;
    } else {
      // 没识别到：清空对应字段，避免之前残留值误导用户（用户要"总是覆盖"）
      // doc_type 用默认 M（专著），其它都留空让用户决定
      el.value = (key === 'doc_type') ? 'M' : '';
    }
  }

  const statusEl = $('#m-smart-status');
  if (recognizedCount === 0) {
    if (statusEl) {
      statusEl.innerHTML = '<div class="smart-parse-status-line err">未识别到任何字段</div>';
    }
    showAlert(
      '未能从输入中识别出任何字段。\n\n请检查输入格式（参考下方示例），或直接手动填写下方各栏。',
      '识别失败',
    );
  } else if (statusEl) {
    const lines = [];
    lines.push(`<div class="smart-parse-status-line ok">已识别 ${recognizedCount}/${fieldMap.length} 个字段</div>`);

    // 已忽略的次要贡献者
    const sec = parsed._meta && parsed._meta.strippedSecondaries || [];
    if (sec.length > 0) {
      const desc = sec.map((r) => `${escapeHtml(r.name)}（${escapeHtml(r.role)}）`).join('、');
      lines.push(`<div class="smart-parse-status-line">已忽略次要贡献者: ${desc}</div>`);
    }

    // 已忽略的版本标记
    const ed = parsed._meta && parsed._meta.strippedEditions || [];
    if (ed.length > 0) {
      lines.push(`<div class="smart-parse-status-line">已忽略版本标记: ${ed.map(escapeHtml).join('、')}</div>`);
    }

    // 多个年份候选 —— 只在还有"竞争性"候选时显示（被强惩罚的不算）
    const yc = parsed._meta && parsed._meta.yearCandidates || [];
    const chosen = parsed._meta && parsed._meta.yearChosen;
    if (chosen && yc.length > 1) {
      const others = yc
        .filter((c) => c.value !== chosen.value && c.score > 30)
        .map((c) => c.value);
      if (others.length > 0) {
        lines.push(`<div class="smart-parse-status-line">出版年 ${escapeHtml(chosen.value)}（另有候选: ${others.map(escapeHtml).join(', ')}）</div>`);
      }
    }

    // 低置信度警告
    if (parsed._meta && parsed._meta.yearLowConfidence) {
      lines.push(`<div class="smart-parse-status-line warn">⚠ 出版年识别不确定，请核对</div>`);
    }

    statusEl.innerHTML = lines.join('');
  }
});

document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'btn-open-data-dir') {
    e.preventDefault();
    await callApi('open_data_dir');
  } else if (e.target && e.target.id === 'btn-reset-defaults') {
    e.preventDefault();
    if (await showConfirm('确定要把所有设置恢复为默认值吗？', '恢复默认')) {
      $('#set-threshold').value = DEFAULT_SETTINGS.threshold;
      $('#set-threshold-val').textContent = DEFAULT_SETTINGS.threshold.toFixed(2);
      $('#set-ctxw').value = DEFAULT_SETTINGS.ctx_weight;
      $('#set-ctxw-val').textContent = DEFAULT_SETTINGS.ctx_weight.toFixed(2);
      $('#set-topk').value = DEFAULT_SETTINGS.top_k;
      $('#set-topk-val').textContent = DEFAULT_SETTINGS.top_k;
    }
  }
});

$('#btn-settings').addEventListener('click', openSettings);

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'btn-welcome-add') {
    $('#btn-add-book').click();
  }
});

// =========================================================
// 解析进度模态
// =========================================================
let parseRows = {};
let parseFinished = false;

function shortName(name) {
  if (!name) return '';
  if (name.length <= 40) return name;
  return name.slice(0, 25) + '…' + name.slice(-12);
}

function makeParseRow(file_id) {
  const row = document.createElement('div');
  row.className = 'parse-row';
  row.dataset.fileId = file_id;
  row.innerHTML = `
    <span class="parse-icon">⌛</span>
    <span class="parse-name" title="${escapeHtml(file_id)}">${escapeHtml(shortName(file_id))}</span>
    <div class="parse-progress-bar"><div class="parse-progress-fill" style="width:0"></div></div>
    <span class="parse-pages">等待中</span>
  `;
  return row;
}

function setRowState(file_id, { state, icon, pages, fillPct }) {
  const row = parseRows[file_id];
  if (!row) return;
  if (state) {
    row.classList.remove('in-progress', 'done', 'cancelled', 'failed');
    row.classList.add(state);
  }
  if (icon) row.querySelector('.parse-icon').textContent = icon;
  if (pages !== undefined) row.querySelector('.parse-pages').textContent = pages;
  if (fillPct !== undefined) {
    row.querySelector('.parse-progress-fill').style.width = `${fillPct}%`;
  }
}

function openParseModal(file_ids) {
  parseRows = {};
  parseFinished = false;
  $('#parse-modal-title').textContent = `正在解析书籍（共 ${file_ids.length} 本）`;
  $('#parse-summary').textContent = '准备中…';
  const list = $('#parse-list');
  list.innerHTML = '';
  for (const fid of file_ids) {
    const row = makeParseRow(fid);
    parseRows[fid] = row;
    list.appendChild(row);
  }
  $('#btn-cancel-parse').classList.remove('hidden');
  $('#btn-cancel-parse').disabled = false;
  $('#btn-cancel-parse').textContent = '取消解析';
  $('#btn-parse-done').classList.add('hidden');
  $('#parse-modal-overlay').classList.remove('hidden');
}

function closeParseModal() {
  $('#parse-modal-overlay').classList.add('hidden');
  parseRows = {};
}

function onBatchStart(p) {
  $('#parse-summary').textContent = `开始解析（共 ${p.total} 本）`;
}

function onBookStart(p) {
  setRowState(p.file_id, { state: 'in-progress', icon: '⏳', pages: '解析中…', fillPct: 0 });
}

function onBookProgress(p) {
  const pct = (p.current / p.total) * 100;
  setRowState(p.file_id, { pages: `${p.current}/${p.total}`, fillPct: pct });
}

function onBookDone(p) {
  setRowState(p.file_id, { state: 'done', icon: '✓', pages: `${p.page_count} 页`, fillPct: 100 });
}

function onBookCancelled(p) {
  setRowState(p.file_id, {
    state: 'cancelled',
    icon: p.reason === 'skipped' ? '⏭' : '🚫',
    pages: p.reason === 'skipped' ? '已跳过' : '已取消',
    fillPct: 100,
  });
}

function onBookFailed(p) {
  // 把错误简短化显示在行尾，hover 可看全文
  const err = (p && p.error) ? String(p.error) : '失败';
  const short = err.length > 60 ? err.slice(0, 60) + '…' : err;
  const row = parseRows[p.file_id];
  if (row) {
    const pagesEl = row.querySelector('.parse-pages');
    if (pagesEl) {
      pagesEl.textContent = short;
      pagesEl.title = err;  // 完整错误放 tooltip
      pagesEl.style.color = '#c0392b';
    }
  }
  setRowState(p.file_id, { state: 'failed', icon: '✗', fillPct: 100 });
}

function onBatchDone(p) {
  parseFinished = true;
  const parts = [];
  if (p.done) parts.push(`✓ 完成 ${p.done}`);
  if (p.cancelled) parts.push(`🚫 取消 ${p.cancelled}`);
  if (p.failed) parts.push(`✗ 失败 ${p.failed}`);
  if (p.skipped) parts.push(`⏭ 跳过 ${p.skipped}`);
  $('#parse-summary').textContent = parts.join(' · ') || '完成';

  $('#btn-cancel-parse').classList.add('hidden');
  $('#btn-parse-done').classList.remove('hidden');
  $('#btn-parse-done').focus();

  refreshBookList();
}

$('#btn-cancel-parse').addEventListener('click', async () => {
  if (parseFinished) return;
  $('#btn-cancel-parse').disabled = true;
  $('#btn-cancel-parse').textContent = '正在取消…';
  await callApi('cancel_parsing');
});

$('#btn-parse-done').addEventListener('click', () => { closeParseModal(); });

// =========================================================
// 多选 / 批量操作
// =========================================================
let multiselectActive = false;
let selectedBookIds = new Set();

function toggleMultiselect() {
  multiselectActive = !multiselectActive;
  selectedBookIds.clear();
  document.body.classList.toggle('multiselect-active', multiselectActive);
  $('#multiselect-toolbar').classList.toggle('hidden', !multiselectActive);
  $('#btn-toggle-multiselect').textContent = multiselectActive ? '✕ 退出多选' : '☑ 多选';
  refreshBookList();
}

function updateMultiselectToolbar() {
  $('#ms-count-num').textContent = selectedBookIds.size;
  const allBooks = window._lastBookList || [];
  const selectedBooks = allBooks.filter((b) => selectedBookIds.has(b.file_id));
  const hasUnparsed = selectedBooks.some((b) => !b.parsed && b.exists);
  const hasParsed = selectedBooks.some((b) => b.parsed && b.exists);
  $('#ms-batch-parse').classList.toggle('hidden', !hasUnparsed);
  $('#ms-batch-reparse').classList.toggle('hidden', !hasParsed);
  const noneSelected = selectedBookIds.size === 0;
  $('#ms-clear').disabled = noneSelected;
  $('#ms-batch-parse').disabled = noneSelected;
  $('#ms-batch-reparse').disabled = noneSelected;
  $('#ms-batch-remove').disabled = noneSelected;
}

function onBookCheckChange(file_id, checked, bookCardEl) {
  if (checked) selectedBookIds.add(file_id);
  else selectedBookIds.delete(file_id);
  if (bookCardEl) bookCardEl.classList.toggle('ms-selected', checked);
  updateMultiselectToolbar();
}

$('#btn-toggle-multiselect').addEventListener('click', toggleMultiselect);

$('#ms-select-all').addEventListener('click', () => {
  const all = window._lastBookList || [];
  for (const b of all) {
    if (b.exists) selectedBookIds.add(b.file_id);
  }
  refreshBookList();
});

$('#ms-clear').addEventListener('click', () => {
  selectedBookIds.clear();
  refreshBookList();
});

$('#ms-batch-parse').addEventListener('click', () => withBusy(async () => {
  const all = window._lastBookList || [];
  const targets = all
    .filter((b) => selectedBookIds.has(b.file_id) && !b.parsed && b.exists)
    .map((b) => b.file_id);
  if (!targets.length) return;
  openParseModal(targets);
  await callApi('parse_books_batch', targets);
}));

$('#ms-batch-reparse').addEventListener('click', () => withBusy(async () => {
  const all = window._lastBookList || [];
  const targets = all
    .filter((b) => selectedBookIds.has(b.file_id) && b.parsed && b.exists)
    .map((b) => b.file_id);
  if (!targets.length) return;
  if (!(await showConfirm(
    `重新解析将清除选中 ${targets.length} 本的现有缓存，重新抽一次文字。\n确定继续？`,
    '批量重新解析',
  ))) return;
  await callApi('clear_book_caches', targets);
  openParseModal(targets);
  await callApi('parse_books_batch', targets);
}));

$('#ms-batch-remove').addEventListener('click', () => withBusy(async () => {
  const all = window._lastBookList || [];
  const targets = all.filter((b) => selectedBookIds.has(b.file_id));
  if (!targets.length) return;
  const list = targets.map((b) => `· ${b.title || b.file_id}`).join('\n');
  if (!(await showConfirm(
    `确定从书架移除以下 ${targets.length} 本？\n（不会删除你电脑上的 PDF 文件）\n\n${list}`,
    '批量移除',
  ))) return;
  for (const b of targets) {
    await callApi('remove_book', b.file_id).catch(() => {});
  }
  selectedBookIds.clear();
  refreshBookList();
  setStatus(`已移除 ${targets.length} 本`);
}));

$('#ms-batch-move').addEventListener('click', async () => {
  const all = window._lastBookList || [];
  const targets = all.filter((b) => selectedBookIds.has(b.file_id));
  if (!targets.length) return;

  try {
    const fr = await callApi('list_folders');
    window._lastFolders = (fr.folders || []).map((f) => f.name);
  } catch (_) {}

  const result = await showModal({
    title: `移到文件夹（${targets.length} 本）`,
    bodyHtml: `
      <p class="dim" style="font-size:12px;">${targets.map((b) => escapeHtml(b.title || b.file_id)).join('、')}</p>
      <label>目标文件夹</label>${_folderSelectHtml('', 'mv')}
    `,
    okText: '移动',
    onOk: async () => {
      let f = $('#mv-folder').value;
      if (f === '__new__') {
        const name = prompt('新文件夹名：');
        if (!name || !name.trim()) return false;
        f = name.trim();
        await callApi('create_folder', f);
      }
      return { folder: f || null };
    },
  });
  if (result === null || typeof result !== 'object') return;
  const targetFolder = result.folder;
  await callApi('update_book_folders', targets.map((b) => b.file_id), targetFolder);
  selectedBookIds.clear();
  refreshBookList();
  setStatus(`已移动 ${targets.length} 本到 ${targetFolder || '未分组'}`);
});

// —— 新建文件夹 ——
$('#btn-new-folder').addEventListener('click', async () => {
  const name = prompt('新文件夹名：');
  if (!name || !name.trim()) return;
  try {
    await callApi('create_folder', name.trim());
    refreshBookList();
    setStatus(`已新建文件夹：${name.trim()}`);
  } catch (_) {}
});

async function renameFolderInteractive(oldName) {
  const newName = prompt(`重命名文件夹「${oldName}」为：`, oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;
  try {
    await callApi('rename_folder', oldName, newName.trim());
    refreshBookList();
    setStatus(`已重命名：${oldName} → ${newName.trim()}`);
  } catch (_) {}
}

async function moveBookInteractive(book) {
  try {
    const fr = await callApi('list_folders');
    window._lastFolders = (fr.folders || []).map((f) => f.name);
  } catch (_) {}
  const result = await showModal({
    title: `移动「${book.title}」到`,
    bodyHtml: `
      <p class="dim" style="font-size:12px;">当前所在：${book.folder ? '📁 ' + escapeHtml(book.folder) : '未分组'}</p>
      <label>目标文件夹</label>${_folderSelectHtml(book.folder || '', 'mv1')}
    `,
    okText: '移动',
    onOk: async () => {
      let f = $('#mv1-folder').value;
      if (f === '__new__') {
        const name = prompt('新文件夹名：');
        if (!name || !name.trim()) return false;
        f = name.trim();
        await callApi('create_folder', f);
      }
      return { folder: f || null };
    },
  });
  if (result === null || typeof result !== 'object') return;
  const targetFolder = result.folder;
  await callApi('update_book_folders', [book.file_id], targetFolder);
  refreshBookList();
  setStatus(`已移到「${targetFolder || '未分组'}」`);
}

async function deleteFolderInteractive(name) {
  if (!(await showConfirm(
    `确定删除文件夹「${name}」？\n该文件夹里的书会自动移到「未分组」（书本身不删）。`,
    '删除文件夹',
  ))) return;
  try {
    const r = await callApi('delete_folder', name);
    refreshBookList();
    setStatus(`已删除文件夹「${name}」，${r.affected} 本书移到未分组`);
  } catch (_) {}
}

// =========================================================
// 查找范围（扫描 / 单句查询共用）
// =========================================================
let scanScope = null;
let lookupScope = null;

function _scopeSummary(scope) {
  if (!scope) return '全部书架';
  const allBooks = window._lastBookList || [];
  const folders = new Set(scope.folders || []);
  const ids = new Set(scope.file_ids || []);
  let count = 0;
  for (const b of allBooks) {
    if (b.folder && folders.has(b.folder)) count++;
    else if (!b.folder && scope.include_ungrouped) count++;
    else if (ids.has(b.file_id)) count++;
  }
  const parts = [];
  if (folders.size) parts.push(...Array.from(folders).map((f) => `📁 ${f}`));
  if (scope.include_ungrouped) parts.push('未分组');
  if (ids.size) parts.push(`+ ${ids.size} 本独立选中`);
  return `${parts.join('、') || '（自定义）'} （${count} 本）`;
}

function updateScopeSummaries() {
  $('#scan-scope-summary').textContent = _scopeSummary(scanScope);
  $('#lookup-scope-summary').textContent = _scopeSummary(lookupScope);
}

async function openScopeModal(currentScope) {
  const [foldersRes, booksRes] = await Promise.all([
    callApi('list_folders'),
    callApi('list_books'),
  ]);
  const folders = foldersRes.folders || [];
  const books = (booksRes.books || []).filter((b) => b.exists);

  const checkedIds = new Set();
  if (!currentScope) {
    for (const b of books) checkedIds.add(b.file_id);
  } else {
    const scopeFolders = new Set(currentScope.folders || []);
    const scopeFileIds = new Set(currentScope.file_ids || []);
    const scopeUngrouped = !!currentScope.include_ungrouped;
    for (const b of books) {
      if (b.folder && scopeFolders.has(b.folder)) checkedIds.add(b.file_id);
      else if (!b.folder && scopeUngrouped) checkedIds.add(b.file_id);
      else if (scopeFileIds.has(b.file_id)) checkedIds.add(b.file_id);
    }
  }
  function _allChecked(arr) { return arr.length > 0 && arr.every((b) => checkedIds.has(b.file_id)); }
  const folderCheckedInit = new Map();
  for (const f of folders) {
    folderCheckedInit.set(f.name, _allChecked(books.filter((b) => b.folder === f.name)));
  }
  const ungroupedBooks0 = books.filter((b) => !b.folder);
  const checkedUngrouped = _allChecked(ungroupedBooks0);

  const treeRows = [];
  const allBooksChecked = books.length > 0 && books.every((b) => checkedIds.has(b.file_id));
  treeRows.push(`
    <div class="scope-all-row">
      <label>
        <input type="checkbox" id="scope-all" ${allBooksChecked ? 'checked' : ''} />
        全部书架
      </label>
    </div>
  `);

  function _renderBookRow(b) {
    return `
      <label class="scope-book-row">
        <input type="checkbox" class="scope-book-cb" data-id="${escapeHtml(b.file_id)}" ${checkedIds.has(b.file_id) ? 'checked' : ''} />
        <span class="book-name">${escapeHtml(b.title || b.file_id)}</span>
      </label>
    `;
  }

  function _renderScopeFolderSection(opts) {
    const { name, isUngrouped, booksInFolder, checked } = opts;
    const dataAttr = isUngrouped ? 'data-folder="__ungrouped__"' : `data-folder="${escapeHtml(name)}"`;
    const cbAttrs = isUngrouped
      ? `id="scope-ungrouped-cb"`
      : `class="scope-folder-cb" data-folder="${escapeHtml(name)}"`;
    const icon = isUngrouped ? '📂' : '📁';
    const displayName = isUngrouped ? '未分组' : name;
    return `
      <div class="scope-folder-section ${isUngrouped ? 'ungrouped' : ''}" ${dataAttr}>
        <div class="scope-folder-header">
          <span class="folder-arrow">▼</span>
          <input type="checkbox" ${cbAttrs} ${checked ? 'checked' : ''} />
          <span class="folder-icon">${icon}</span>
          <span class="folder-name">${escapeHtml(displayName)}</span>
          <span class="folder-count">(${booksInFolder.length} 本)</span>
        </div>
        <div class="scope-folder-body">
          ${booksInFolder.length === 0
            ? `<div class="dim" style="padding:6px 10px;font-size:12px;font-style:italic;">（暂无书籍）</div>`
            : booksInFolder.map(_renderBookRow).join('')}
        </div>
      </div>
    `;
  }

  for (const f of folders) {
    const booksInFolder = books.filter((b) => b.folder === f.name);
    treeRows.push(_renderScopeFolderSection({
      name: f.name,
      isUngrouped: false,
      booksInFolder,
      checked: folderCheckedInit.get(f.name),
    }));
  }

  const ungroupedBooks = books.filter((b) => !b.folder);
  if (ungroupedBooks.length > 0) {
    treeRows.push(_renderScopeFolderSection({
      name: null,
      isUngrouped: true,
      booksInFolder: ungroupedBooks,
      checked: checkedUngrouped,
    }));
  }

  const modalPromise = showModal({
    title: '选择查找范围',
    modalClass: 'scope-modal',
    bodyHtml: `
      <div class="scope-tree">${treeRows.join('')}</div>
      <p class="dim" style="font-size:11px;margin-top:12px;">
        勾选文件夹会带上里面所有书；也可单独勾选书。<br>
        部分勾选时父级显示"半选"标记。
      </p>
    `,
    okText: '确定',
    onOk: () => {
      const allCb = $('#scope-all');
      if (allCb && allCb.checked) return { __all__: true };
      const sel = { folders: [], file_ids: [], include_ungrouped: false };
      $$('.scope-folder-cb').forEach((cb) => { if (cb.checked) sel.folders.push(cb.dataset.folder); });
      const ungroupedCb = $('#scope-ungrouped-cb');
      if (ungroupedCb && ungroupedCb.checked) sel.include_ungrouped = true;
      $$('.scope-book-cb').forEach((cb) => {
        if (cb.checked) {
          const folder = books.find((b) => b.file_id === cb.dataset.id)?.folder;
          if (folder && sel.folders.includes(folder)) return;
          if (!folder && sel.include_ungrouped) return;
          sel.file_ids.push(cb.dataset.id);
        }
      });
      if (!sel.folders.length && !sel.file_ids.length && !sel.include_ungrouped) {
        showAlert('请至少勾选一项作为查找范围。');
        return false;
      }
      return sel;
    },
  });
  _syncScopeParents();
  const result = await modalPromise;

  if (result === null) return null;
  if (result.__all__) return null;
  return result;
}

function _syncScopeParents() {
  $$('.scope-folder-section').forEach((section) => {
    const headerCb = section.querySelector('.scope-folder-cb, #scope-ungrouped-cb');
    if (!headerCb) return;
    const bookCbs = Array.from(section.querySelectorAll('.scope-book-cb'));
    if (bookCbs.length === 0) { headerCb.indeterminate = false; return; }
    const all = bookCbs.every((cb) => cb.checked);
    const some = bookCbs.some((cb) => cb.checked);
    headerCb.checked = all;
    headerCb.indeterminate = some && !all;
  });
  const allCb = $('#scope-all');
  if (allCb) {
    const allBooks = $$('.scope-book-cb');
    if (allBooks.length === 0) {
      allCb.checked = false;
      allCb.indeterminate = false;
    } else {
      const all = allBooks.every((cb) => cb.checked);
      const some = allBooks.some((cb) => cb.checked);
      allCb.checked = all;
      allCb.indeterminate = some && !all;
    }
  }
}

document.addEventListener('change', (e) => {
  if (!e.target) return;
  if (e.target.id === 'scope-all') {
    const checked = e.target.checked;
    e.target.indeterminate = false;
    $$('.scope-book-cb').forEach((cb) => { cb.checked = checked; cb.indeterminate = false; });
    $$('.scope-folder-cb').forEach((cb) => { cb.checked = checked; cb.indeterminate = false; });
    const u = $('#scope-ungrouped-cb'); if (u) { u.checked = checked; u.indeterminate = false; }
  } else if (e.target.classList && e.target.classList.contains('scope-folder-cb')) {
    e.target.indeterminate = false;
    const section = e.target.closest('.scope-folder-section');
    if (section) section.querySelectorAll('.scope-book-cb').forEach((cb) => { cb.checked = e.target.checked; });
    _syncScopeParents();
  } else if (e.target.id === 'scope-ungrouped-cb') {
    e.target.indeterminate = false;
    const section = e.target.closest('.scope-folder-section');
    if (section) section.querySelectorAll('.scope-book-cb').forEach((cb) => { cb.checked = e.target.checked; });
    _syncScopeParents();
  } else if (e.target.classList && e.target.classList.contains('scope-book-cb')) {
    _syncScopeParents();
  }
});

document.addEventListener('click', (e) => {
  const header = e.target.closest && e.target.closest('.scope-folder-header');
  if (!header) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
  const section = header.parentElement;
  if (section && section.classList.contains('scope-folder-section')) {
    section.classList.toggle('collapsed');
  }
});

$('#scan-scope-edit').addEventListener('click', async () => {
  const r = await openScopeModal(scanScope);
  if (r !== undefined) { scanScope = r; updateScopeSummaries(); }
});

$('#lookup-scope-edit').addEventListener('click', async () => {
  const r = await openScopeModal(lookupScope);
  if (r !== undefined) { lookupScope = r; updateScopeSummaries(); }
});

// =========================================================
// 全局拖拽 drop 路由
// =========================================================
//
// 用户可以从文件管理器拖任意东西进来，规则：
//   - 拖 PDF (单个 / 多个 / 整个文件夹递归)  → 加入书架（自动切到 📚 tab）
//   - 拖 docx                                  → 文档扫描（自动切到 📄 tab）
//   - 其它文件类型自动忽略，末尾在弹窗里汇总告知
//
// 关键技术：用 dataTransferItem.getAsFileSystemHandle()（Chromium 86+）拿到
// 真正的 FileSystemFileHandle / FileSystemDirectoryHandle，而不是一次性的
// File 对象。这样 PDF 仍然只是"被记住位置"，不进入 IndexedDB 字节存储。

function _isFileDrag(e) {
  // 区分"用户拖外部文件进窗口" vs "应用内拖书卡片"（后者只有 'text/plain' 类型）
  return e.dataTransfer && e.dataTransfer.types &&
         Array.from(e.dataTransfer.types).indexOf('Files') !== -1;
}

let _dragDepth = 0;

function _showDropOverlay() { $('#drop-overlay').classList.remove('hidden'); }
function _hideDropOverlay() { $('#drop-overlay').classList.add('hidden'); _dragDepth = 0; }

// 递归找文件夹里的 PDF（也顺便数掉非 PDF 文件用于"已忽略 N 个"提示）
async function _collectPdfsFromDirectory(dirHandle, maxFiles = 500) {
  const pdfs = [];
  let skipped = 0;
  async function walk(dir) {
    if (pdfs.length >= maxFiles) return;
    for await (const [name, entry] of dir.entries()) {
      if (pdfs.length >= maxFiles) return;
      if (entry.kind === 'file') {
        if (name.toLowerCase().endsWith('.pdf')) pdfs.push(entry);
        else skipped += 1;
      } else if (entry.kind === 'directory') {
        await walk(entry);
      }
    }
  }
  try { await walk(dirHandle); } catch (_) { /* 权限/读取错误，吞掉 */ }
  return { pdfs, skipped, truncated: pdfs.length >= maxFiles };
}

async function _handleGlobalDrop(dataTransfer) {
  const pdfs = [];
  const docxs = [];
  let otherSkipped = 0;
  let anyTruncated = false;

  // 关键修复：dataTransfer.items 在第一次 await 之后会被浏览器作废（Chromium
  // 规范行为，是已知陷阱）。所以必须**在 await 之前**先把所有 item.getAsFileSystemHandle()
  // 的 Promise 同步抓出来，最后再 Promise.all。
  // 之前的写法在循环里逐个 await，导致第二本之后的 item 全部失效，
  // 表现为"明明拖了 N 本只识别出 1 本"。
  const handlePromises = [];
  for (const item of (dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    try {
      handlePromises.push(
        Promise.resolve(item.getAsFileSystemHandle()).catch(() => null)
      );
    } catch (_) {
      handlePromises.push(Promise.resolve(null));
    }
  }
  const handles = await Promise.all(handlePromises);

  for (const handle of handles) {
    if (!handle) continue;
    if (handle.kind === 'file') {
      const n = handle.name.toLowerCase();
      if (n.endsWith('.pdf')) pdfs.push(handle);
      else if (n.endsWith('.docx')) docxs.push(handle);
      else otherSkipped += 1;
    } else if (handle.kind === 'directory') {
      const r = await _collectPdfsFromDirectory(handle);
      pdfs.push(...r.pdfs);
      otherSkipped += r.skipped;
      if (r.truncated) anyTruncated = true;
    }
  }

  if (anyTruncated) {
    await showAlert(
      '拖入的目录里 PDF 数量超过 500，本次只导入前 500 本。\n' +
      '建议把文件夹分组后分批拖入。',
      '拖入数量过多',
    );
  }

  if (pdfs.length === 0 && docxs.length === 0) {
    await showAlert(
      otherSkipped > 0
        ? `没找到 PDF 或 docx（已忽略 ${otherSkipped} 个其它文件）。`
        : '没识别到可用文件。寻典支持拖 PDF（加书架）或 docx（用来扫描）。',
      '没有可用文件',
    );
    return;
  }

  // 优先级：有 PDF / 文件夹 → 走加入书架（docx 一并算"已忽略"统计）
  if (pdfs.length > 0) {
    switchTab('library');
    await withBusy(async () => {
      await importPdfHandles(pdfs, {
        nonPdfSkipped: otherSkipped + docxs.length,
        sourceLabel: '拖入',
      });
    });
    return;
  }

  // 仅 docx：触发文档扫描
  if (docxs.length > 0) {
    if (docxs.length > 1) {
      await showAlert(
        `检测到 ${docxs.length} 个 docx，只会扫描第一个：${docxs[0].name}。\n` +
        `如需扫描其它，请拖完这次后再拖。`,
        '一次只能扫描一个 docx',
      );
    }
    switchTab('scan');
    await withBusy(async () => {
      if (!(await ensureLibraryNotEmpty())) return;
      let file;
      try { file = await docxs[0].getFile(); }
      catch (e) {
        await showAlert(`无法读取 docx 文件：${e.message || e}`, '读取失败');
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      _stagedDocx = { name: file.name, bytes };
      await runScan(file.name);
    });
  }
}

// 给 window 注册全局 dragenter/dragover/dragleave/drop
window.addEventListener('dragenter', (e) => {
  if (!_isFileDrag(e)) return;
  e.preventDefault();
  _dragDepth += 1;
  _showDropOverlay();
});
window.addEventListener('dragover', (e) => {
  if (!_isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!_isFileDrag(e)) return;
  _dragDepth -= 1;
  if (_dragDepth <= 0) _hideDropOverlay();
});
window.addEventListener('drop', (e) => {
  if (!_isFileDrag(e)) return;
  e.preventDefault();
  const dt = e.dataTransfer;
  _hideDropOverlay();
  // 防止重复触发（应用内 drag 的 drop 已经在元素的 handler 里处理过了）
  _handleGlobalDrop(dt).catch((err) => {
    console.error('[drop] 处理出错：', err);
    showAlert(`处理拖入文件出错：${err.message || err}`, '出错');
  });
});

// =========================================================
// 启动
// =========================================================

function _showBootError(message) {
  const el = $('#boot-error');
  if (!el) { alert(message); return; }
  el.textContent = message;
  el.classList.remove('hidden');
}

function _updateBootPhase(phase, detail) {
  const phaseEl = $('#boot-phase');
  const fill = $('#boot-fill');
  const phaseMap = {
    loading_pyodide: ['下载 Pyodide…（首次需 5–15 秒）', 15],
    init_pyodide: ['初始化 Python 解释器…', 35],
    install_packages: ['安装依赖（python-docx, pypdf）…', 55],
    install_optional: ['尝试安装可选包…', 75],
    mount_sources: ['加载寻典核心模块…', 85],
    import_api: ['启动 API…', 95],
    ready: ['就绪', 100],
  };
  const [label, pct] = phaseMap[phase] || [detail || phase, 50];
  if (phaseEl) phaseEl.textContent = label;
  if (fill) fill.style.width = `${pct}%`;
}

// =========================================================
// 全局格式选择器
// =========================================================

async function renderFormatList() {
  const all = await window.xdFormats.listAllFormats();
  const builtinHtml = all.filter(f => f.category === 'builtin').map(f => {
    const isDefault = f.id === window.xdFormats.DEFAULT_FORMAT_ID;
    const isModified = window.xdFormats.isModifiedBuiltin(f);
    return `
      <div class="fmt-item" data-fmt-id="${escapeHtml(f.id)}">
        <div>
          <span class="fmt-item-name">${escapeHtml(f.name)}</span>
          ${isDefault ? '<span class="fmt-item-default">★ 默认</span>' : ''}
          ${isModified ? '<span class="fmt-item-modified">●已修改</span>' : ''}
        </div>
        <div class="fmt-item-actions">
          <button class="btn-tiny" data-action="edit">编辑</button>
          <button class="btn-tiny" data-action="clone">基于此新建</button>
          ${isModified ? '<button class="btn-tiny" data-action="reset">重置</button>' : ''}
        </div>
      </div>`;
  }).join('');

  const userHtml = all.filter(f => f.category === 'user').map(f => {
    return `
      <div class="fmt-item" data-fmt-id="${escapeHtml(f.id)}">
        <div>
          <span class="fmt-item-name">${escapeHtml(f.name)}</span>
          ${f.parent_id ? `<span class="fmt-item-meta">克隆自 ${escapeHtml((window.xdFormats.BUILTIN_FORMATS.find(b => b.id === f.parent_id) || {}).name || f.parent_id)}</span>` : ''}
        </div>
        <div class="fmt-item-actions">
          <button class="btn-tiny" data-action="edit">编辑</button>
          <button class="btn-tiny" data-action="export">导出 JSON</button>
          <button class="btn-tiny" data-action="delete">删除</button>
        </div>
      </div>`;
  }).join('');

  document.getElementById('fmt-list-builtin-items').innerHTML = builtinHtml;
  document.getElementById('fmt-list-user-items').innerHTML = userHtml
    || '<div class="hint" style="padding:12px;">还没有自定义格式 — 用上面三个按钮新建。</div>';
}

// 模板编辑器 modal
//   options: { mode: 'edit'|'create-blank'|'clone', initialFormat: {name, template, parent_id?} }
//   returns Promise that resolves to { name, template, parent_id? } on save, or null on cancel
async function openTemplateEditor(options) {
  const initial = options.initialFormat || { name: '', template: '', parent_id: null };
  // 字段定义：英文 key、中文标签、tooltip
  const FIELD_DEFS = [
    { key: 'author',     label: '作者',     hint: '作者' },
    { key: 'role',       label: '责任方式', hint: '主编/编/译…（"著"自动省略）' },
    { key: 'country',    label: '国别',     hint: '如"日""美"' },
    { key: 'title',      label: '书名',     hint: '书名' },
    { key: 'translator', label: '译者',     hint: '译者（含多人，"、"分隔）' },
    { key: 'edition',    label: '版次',     hint: '如"2"渲染为"(第2版)"' },
    { key: 'doc_type',   label: '文献类型', hint: 'M=专著 / J=期刊 / N=报纸' },
    { key: 'place',      label: '出版地',   hint: '出版地' },
    { key: 'publisher',  label: '出版社',   hint: '出版社' },
    { key: 'year',       label: '出版年',   hint: '出版年（如 2001）' },
    { key: 'page',       label: '页码',     hint: '引文页（运行时由匹配结果决定）' },
  ];
  // 可选段插入默认值：常见组合
  const OPT_DEFAULTS = {
    role:       ['', ''],
    country:    ['[', ']'],
    translator: ['', '译，'],
    edition:    ['（第', '版）'],
  };
  // 按钮：必填字段（直接渲染为 {field}）
  const requiredButtonsHtml = FIELD_DEFS.map(({ key, label, hint }) =>
    `<button class="tpl-insert-btn tpl-insert-btn--req" data-kind="req" data-field="${key}" draggable="true" type="button" title="点击或拖入：{${key}} — ${escapeHtml(hint)}">${escapeHtml(label)}</button>`
  ).join('');
  // 按钮：可选段（带默认 prefix/suffix）
  const optionalFields = ['role', 'country', 'translator', 'edition'];
  const optionalButtonsHtml = optionalFields.map(key => {
    const def = FIELD_DEFS.find(d => d.key === key);
    const [pre, suf] = OPT_DEFAULTS[key] || ['', ''];
    return `<button class="tpl-insert-btn tpl-insert-btn--opt" data-kind="opt" data-field="${key}" data-prefix="${escapeHtml(pre)}" data-suffix="${escapeHtml(suf)}" draggable="true" type="button" title="点击或拖入可选段 {?${key} ${pre}{}${suf}} — 空则整段消失">?${escapeHtml(def.label)}</button>`;
  }).join('');

  const sampleBooks = [
    {
      label: '★ 全字段示例（11 个占位符都有值）',
      meta: { author: '罗杰·谢泼德', role: '编', country: '美', translator: '张洪明', edition: '修订', title: '心理表征', doc_type: 'M', place: '上海', publisher: '上海人民出版社', year: '2005' },
      book_page: 102, book_page_end: 105, pdf_page: null,
    },
    {
      label: '中文专著（任继愈主编《中国哲学发展史》）',
      meta: { author: '任继愈', role: '主编', country: '', translator: '', edition: '', title: '中国哲学发展史（先秦卷）', doc_type: 'M', place: '北京', publisher: '人民出版社', year: '1983' },
      book_page: 25, book_page_end: null, pdf_page: null,
    },
    {
      label: '译著（实藤惠秀《中国人留学日本史》）',
      meta: { author: '实藤惠秀', role: '', country: '日', translator: '谭汝谦、林启彦', edition: '', title: '中国人留学日本史', doc_type: 'M', place: '香港', publisher: '中文大学出版社', year: '1982' },
      book_page: 11, book_page_end: 12, pdf_page: null,
    },
    {
      label: '带版次（黄仁宇《万历十五年》第2版）',
      meta: { author: '黄仁宇', role: '著', country: '', translator: '', edition: '2', title: '万历十五年', doc_type: 'M', place: '北京', publisher: '中华书局', year: '2007' },
      book_page: 1, book_page_end: null, pdf_page: null,
    },
  ];

  const bodyHtml = `
    <div class="tpl-intro">
      <div class="tpl-intro-title">📐 这是什么</div>
      <div class="tpl-intro-body">
        在下面的"模板"框里写引文长什么样。<strong>把作者、书名等可变部分写成
        <span class="tpl-token tpl-token-req tpl-token--demo">作者</span>
        <span class="tpl-token tpl-token-req tpl-token--demo">书名</span>
        这样的占位</strong>，运行时会被每本书的元数据替换。
        其他字符（点号、冒号、《》、年、第…页 等）<strong>原样输出</strong>。
      </div>
      <div class="tpl-intro-example">
        <span class="tpl-intro-tag">模板</span>
        <span class="tpl-intro-tpl">
          <span class="tpl-token tpl-token-req tpl-token--demo">作者</span>.
          <span class="tpl-token tpl-token-req tpl-token--demo">书名</span>[<span class="tpl-token tpl-token-req tpl-token--demo">文献类型</span>].
          <span class="tpl-token tpl-token-req tpl-token--demo">出版地</span>:
          <span class="tpl-token tpl-token-req tpl-token--demo">出版社</span>,
          <span class="tpl-token tpl-token-req tpl-token--demo">出版年</span>:
          <span class="tpl-token tpl-token-req tpl-token--demo">页码</span>.
        </span>
        <span class="tpl-intro-tag tpl-intro-tag--out">输出</span>
        <span class="tpl-intro-rendered">任继愈. 中国哲学发展史[M]. 北京: 人民出版社, 1983: 25.</span>
      </div>
      <div class="tpl-intro-hints">
        <button class="btn-tiny" id="tpl-fill-gbt" type="button">↩ 用 GB/T 7714 模板填充</button>
        <button class="btn-tiny" id="tpl-fill-humanities" type="button">↩ 用历史研究模板填充</button>
        <button class="btn-tiny" id="tpl-fill-law" type="button">↩ 用法学手册模板填充</button>
      </div>
    </div>

    <label>名称 <span class="hint-inline">（自己起一个，方便日后选择）</span></label>
    <input id="tpl-name" value="${escapeHtml(initial.name)}" placeholder="例：我的人文社科改良版" />

    <label>模板 <span class="hint-inline">（点击或拖入下方"字段"按钮添加占位；普通文字直接键盘输入；删除占位按一次 Backspace 即可）</span></label>
    <div id="tpl-template" class="tpl-editor" contenteditable="true" spellcheck="false" data-placeholder="点下方"作者""书名"等按钮开始，或者拖到这里"></div>

    <div class="tpl-section">
      <div class="tpl-section-head">
        <span class="tpl-section-title">点击插入</span>
        <span class="tpl-section-hint">把光标放到模板里要插入的位置，再点下方按钮</span>
      </div>
      <div class="tpl-section-head" style="margin-top:6px;">
        <span class="tpl-section-hint"><strong style="color:#3730a3;">必填字段</strong>（如这本书没填该字段，渲染时显示"〔X待补〕"提醒补上）</span>
      </div>
      <div class="tpl-chip-row">${requiredButtonsHtml}</div>
      <div class="tpl-section-head" style="margin-top:8px;">
        <span class="tpl-section-hint"><strong style="color:#047857;">可选段</strong>（如这本书没填该字段，整段连同周围的标点一起消失，<em>不会</em>显示占位）</span>
      </div>
      <div class="tpl-chip-row">${optionalButtonsHtml}</div>
    </div>

    <div class="tpl-preview-section">
      <div class="tpl-section-head">
        <span class="tpl-section-title">实时预览</span>
        <select id="tpl-sample" class="tpl-sample-select">
          ${sampleBooks.map((s, i) => `<option value="${i}">${escapeHtml(s.label)}</option>`).join('')}
        </select>
      </div>
      <div class="tpl-section-head" style="margin-top:2px;">
        <span class="tpl-section-hint">用左边样书数据渲染你的模板；切换样书可以试不同字段组合（带译者 / 带版次 等）</span>
      </div>
      <div id="tpl-preview" class="tpl-preview">（待渲染）</div>
      <div id="tpl-error" class="tpl-error hidden"></div>
    </div>
  `;

  const titles = {
    'edit': '编辑格式',
    'clone': '基于此新建',
    'create-blank': '新建格式',
  };

  // —— DOM ↔ 模板字符串相互转换 ——

  // 取字段中文标签
  function fieldLabel(key) {
    const d = FIELD_DEFS.find(x => x.key === key);
    return d ? d.label : key;
  }

  // 造一个"必填"chip 节点（蓝紫色）
  function makeReqChip(field) {
    const span = document.createElement('span');
    span.className = 'tpl-token tpl-token-req';
    span.contentEditable = 'false';
    span.dataset.kind = 'req';
    span.dataset.field = field;
    span.title = `{${field}}`;
    span.textContent = fieldLabel(field);
    return span;
  }

  // 造一个"可选段"chip 节点（绿色），visually: [prefix(可编辑)] [?字段 pill] [suffix(可编辑)] [×]
  // 外层 contenteditable=false → 整段是原子单元；
  // 内部 .opt-lit 重新 contenteditable=true → 用户可直接修改 prefix/suffix；
  // 悬停时显示 × 按钮 → 一键删整段；
  // 此外加 keydown 处理：在 prefix 头按 Backspace 或 suffix 尾按 Delete 也删整段。
  function makeOptChip(field, prefix, suffix) {
    const span = document.createElement('span');
    span.className = 'tpl-token tpl-token-opt';
    span.contentEditable = 'false';
    span.dataset.kind = 'opt';
    span.dataset.field = field;
    span.title = `可选段 — 这本书该字段空时整段消失（含两侧文字）`;
    // prefix（可编辑），始终渲染（哪怕空）
    const pre = document.createElement('span');
    pre.className = 'opt-lit';
    pre.dataset.role = 'prefix';
    pre.contentEditable = 'true';
    pre.spellcheck = false;
    pre.textContent = prefix || '';
    span.appendChild(pre);
    // ?字段 主体（不可编辑）
    const main = document.createElement('span');
    main.className = 'opt-main';
    main.contentEditable = 'false';
    main.textContent = '?' + fieldLabel(field);
    span.appendChild(main);
    // suffix（可编辑）
    const suf = document.createElement('span');
    suf.className = 'opt-lit';
    suf.dataset.role = 'suffix';
    suf.contentEditable = 'true';
    suf.spellcheck = false;
    suf.textContent = suffix || '';
    span.appendChild(suf);
    // × 删除按钮（悬停时显示）
    const close = document.createElement('span');
    close.className = 'opt-close';
    close.contentEditable = 'false';
    close.title = '删除整段';
    close.textContent = '×';
    span.appendChild(close);
    return span;
  }

  // 把模板字符串渲染到 contenteditable 容器
  function templateToDom(template, container) {
    container.textContent = '';
    if (!template) return;
    let tokens;
    try {
      tokens = window.xdFormats.parseTemplate(template);
    } catch (_) {
      // 解析失败 → 全当字面，让用户看到自己写的什么
      container.appendChild(document.createTextNode(template));
      return;
    }
    for (const tok of tokens) {
      if (tok.kind === 'lit') {
        container.appendChild(document.createTextNode(tok.text));
      } else if (tok.kind === 'req') {
        container.appendChild(makeReqChip(tok.field));
      } else {
        container.appendChild(makeOptChip(tok.field, tok.prefix, tok.suffix));
      }
    }
  }

  // 把 contenteditable 容器序列化回模板字符串
  function domToTemplate(rootEl) {
    const parts = [];
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          parts.push(child.textContent);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.classList && child.classList.contains('tpl-token')) {
            if (child.dataset.kind === 'req') {
              parts.push(`{${child.dataset.field}}`);
            } else {
              // 从可编辑的 .opt-lit[data-role=prefix/suffix] 子节点读最新值
              const preEl = child.querySelector(':scope > .opt-lit[data-role="prefix"]');
              const sufEl = child.querySelector(':scope > .opt-lit[data-role="suffix"]');
              const prefix = preEl ? preEl.textContent : '';
              const suffix = sufEl ? sufEl.textContent : '';
              parts.push(`{?${child.dataset.field} ${prefix}{}${suffix}}`);
            }
          } else if (child.tagName === 'BR') {
            parts.push('\n');
          } else if (child.tagName === 'DIV' || child.tagName === 'P') {
            // contenteditable 在按 Enter 时可能注入 <div> 包裹的行
            if (parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');
            walk(child);
          } else {
            walk(child);
          }
        }
      }
    }
    walk(rootEl);
    return parts.join('');
  }

  // 在当前光标位置插入节点（contenteditable 内）
  function insertNodeAtCaret(rootEl, node) {
    const sel = window.getSelection();
    if (sel.rangeCount && rootEl.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      // 光标移到节点之后；插入一个零宽间隔避免光标卡在 chip 内部
      const after = document.createRange();
      after.setStartAfter(node);
      after.setEndAfter(node);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      rootEl.appendChild(node);
      const range = document.createRange();
      range.selectNodeContents(rootEl);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    rootEl.focus();
  }

  // 在指定屏幕坐标处插入节点（drop 时用）
  function insertNodeAtPoint(rootEl, node, clientX, clientY) {
    let range = null;
    try {
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(clientX, clientY);
      } else if (document.caretPositionFromPoint) {
        const cp = document.caretPositionFromPoint(clientX, clientY);
        if (cp) {
          range = document.createRange();
          range.setStart(cp.offsetNode, cp.offset);
          range.collapse(true);
        }
      }
    } catch (_) {}
    if (range && rootEl.contains(range.startContainer)) {
      range.insertNode(node);
      const after = document.createRange();
      after.setStartAfter(node);
      after.setEndAfter(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      rootEl.appendChild(node);
    }
    rootEl.focus();
  }

  // 用 setTimeout 在 modal 打开后绑定动态事件（实时预览 / 插入按钮）
  const setupListeners = () => {
    const taEl = document.getElementById('tpl-template');
    const sampleEl = document.getElementById('tpl-sample');
    const previewEl = document.getElementById('tpl-preview');
    const errorEl = document.getElementById('tpl-error');
    if (!taEl) return;  // modal hasn't rendered yet — bail and let next setupListeners try

    // 初始填入模板
    templateToDom(initial.template, taEl);
    updatePlaceholder();

    function updatePlaceholder() {
      if (taEl.textContent.trim() === '' && !taEl.querySelector('.tpl-token')) {
        taEl.classList.add('is-empty');
      } else {
        taEl.classList.remove('is-empty');
      }
    }

    function refresh() {
      updatePlaceholder();
      const tpl = domToTemplate(taEl);
      const sampleIdx = parseInt(sampleEl.value, 10) || 0;
      const sb = sampleBooks[sampleIdx];
      try {
        const out = window.xdFormats.renderCitation({
          template: tpl, meta: sb.meta,
          book_page: sb.book_page, book_page_end: sb.book_page_end, pdf_page: sb.pdf_page,
        });
        previewEl.textContent = out;
        errorEl.classList.add('hidden');
        taEl.classList.remove('error');
      } catch (err) {
        previewEl.textContent = '（无法预览 — 见下方错误）';
        errorEl.textContent = `模板语法错误：${err.message}`;
        errorEl.classList.remove('hidden');
        taEl.classList.add('error');
      }
    }

    taEl.addEventListener('input', refresh);
    sampleEl.addEventListener('change', refresh);

    // ×按钮点击 → 删除整个可选段 chip（事件代理，因为 chip 是动态生成的）
    taEl.addEventListener('click', (e) => {
      const close = e.target && e.target.closest && e.target.closest('.opt-close');
      if (!close) return;
      e.preventDefault();
      e.stopPropagation();
      const chip = close.closest('.tpl-token-opt');
      if (chip) {
        chip.remove();
        refresh();
        taEl.focus();
      }
    });

    // 键盘：在 prefix 起点 Backspace / 在 suffix 末尾 Delete → 删整段
    taEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const sel = window.getSelection();
      if (!sel.rangeCount || !sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const offset = range.startOffset;

      // 在 opt chip 内部？
      const startEl = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      const optChip = startEl && startEl.closest && startEl.closest('.tpl-token-opt');
      if (!optChip || !taEl.contains(optChip)) return;

      const preEl = optChip.querySelector(':scope > .opt-lit[data-role="prefix"]');
      const sufEl = optChip.querySelector(':scope > .opt-lit[data-role="suffix"]');

      if (e.key === 'Backspace') {
        // 光标在 prefix 头 (offset==0) → 删整段
        const inPrefix = preEl && (preEl === node || preEl.contains(node));
        if (inPrefix && offset === 0) {
          e.preventDefault();
          optChip.remove();
          refresh();
          taEl.focus();
        }
      } else if (e.key === 'Delete') {
        // 光标在 suffix 尾 → 删整段
        const inSuffix = sufEl && (sufEl === node || sufEl.contains(node));
        if (inSuffix) {
          const textLen = sufEl.textContent.length;
          const atEnd = (node === sufEl && offset === sufEl.childNodes.length)
                    || (node.nodeType === Node.TEXT_NODE && offset === node.length
                        && (sufEl.lastChild === node || sufEl.lastChild.contains(node)));
          if (atEnd) {
            e.preventDefault();
            optChip.remove();
            refresh();
            taEl.focus();
          }
        }
      }
    });

    // 阻止 contenteditable 默认的富文本粘贴（只保留纯文本）
    taEl.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    // 按钮：点击 → 插入到光标处；拖拽 → 携带 kind/field/prefix/suffix；drop 时插入到鼠标位置
    document.querySelectorAll('.tpl-insert-btn').forEach(b => {
      function buildChip() {
        if (b.dataset.kind === 'req') {
          return makeReqChip(b.dataset.field);
        }
        return makeOptChip(b.dataset.field, b.dataset.prefix || '', b.dataset.suffix || '');
      }
      // 点击插入
      b.addEventListener('click', () => {
        insertNodeAtCaret(taEl, buildChip());
        refresh();
      });
      // 拖拽：dataTransfer 用自定义 mime 携带元数据
      b.addEventListener('dragstart', (e) => {
        const meta = JSON.stringify({
          kind: b.dataset.kind,
          field: b.dataset.field,
          prefix: b.dataset.prefix || '',
          suffix: b.dataset.suffix || '',
        });
        e.dataTransfer.setData('application/x-xundian-chip', meta);
        // text/plain 兜底，万一掉到其它能接收文本的地方
        const fallback = b.dataset.kind === 'req'
          ? `{${b.dataset.field}}`
          : `{?${b.dataset.field} ${b.dataset.prefix || ''}{}${b.dataset.suffix || ''}}`;
        e.dataTransfer.setData('text/plain', fallback);
        e.dataTransfer.effectAllowed = 'copy';
        b.classList.add('dragging');
      });
      b.addEventListener('dragend', () => {
        b.classList.remove('dragging');
      });
    });

    // contenteditable 接受 drop
    taEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      taEl.classList.add('drop-target');
    });
    taEl.addEventListener('dragleave', () => {
      taEl.classList.remove('drop-target');
    });
    taEl.addEventListener('drop', (e) => {
      e.preventDefault();
      taEl.classList.remove('drop-target');
      const metaStr = e.dataTransfer.getData('application/x-xundian-chip');
      if (metaStr) {
        try {
          const meta = JSON.parse(metaStr);
          const node = meta.kind === 'req'
            ? makeReqChip(meta.field)
            : makeOptChip(meta.field, meta.prefix, meta.suffix);
          insertNodeAtPoint(taEl, node, e.clientX, e.clientY);
        } catch (err) {
          console.error(err);
        }
      } else {
        // 兜底：纯文本 drop
        const text = e.dataTransfer.getData('text/plain') || '';
        if (text) {
          const textNode = document.createTextNode(text);
          insertNodeAtPoint(taEl, textNode, e.clientX, e.clientY);
        }
      }
      refresh();
    });

    // "一键填充内置模板"按钮 — 帮新用户冷启动
    const fillBtns = [
      ['tpl-fill-gbt', 'gbt7714'],
      ['tpl-fill-humanities', 'humanities_2024'],
      ['tpl-fill-law', 'law_2025'],
    ];
    for (const [btnId, fmtId] of fillBtns) {
      const btn = document.getElementById(btnId);
      if (!btn) continue;
      btn.addEventListener('click', () => {
        const tpl = window.xdFormats.getBuiltinTemplate(fmtId);
        if (tpl) {
          templateToDom(tpl, taEl);
          taEl.focus();
          refresh();
        }
      });
    }
    refresh();
  };

  // 用 setTimeout 让 showModal 先把 DOM 注入，然后绑事件
  setTimeout(setupListeners, 0);

  const result = await showModal({
    title: titles[options.mode] || '编辑格式',
    bodyHtml,
    onOk: async () => {
      const name = (document.getElementById('tpl-name').value || '').trim();
      const editorEl = document.getElementById('tpl-template');
      const template = domToTemplate(editorEl);
      if (!name) { alert('请填名称'); return false; }
      try {
        window.xdFormats.parseTemplate(template);
      } catch (err) {
        alert('模板语法错误：' + err.message);
        return false;
      }
      return { name, template, parent_id: initial.parent_id || null };
    },
  });

  return result || null;
}

async function _resolveActiveFormatPayload() {
  const id = window.xdFormats.getActiveFormatId();
  const fmt = await window.xdFormats.getFormatById(id);
  // 内置且未修改 → template 留 null（Python 端能查到 id）
  // 用户 / 已修改的内置 → template 也传过去
  if (!fmt) return { id, template: null };
  if (fmt.category === 'builtin' && !window.xdFormats.isModifiedBuiltin(fmt)) {
    return { id, template: null };
  }
  return { id, template: fmt.template };
}

async function populateGlobalFormatSelectors() {
  const all = await window.xdFormats.listAllFormats();
  const builtins = all.filter(f => f.category === 'builtin');
  const users = all.filter(f => f.category === 'user');

  let optsHtml = '<optgroup label="内置">';
  optsHtml += builtins.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}${window.xdFormats.isModifiedBuiltin(f) ? ' ●已修改' : ''}</option>`).join('');
  optsHtml += '</optgroup>';
  if (users.length) {
    optsHtml += '<optgroup label="我的">';
    optsHtml += users.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('');
    optsHtml += '</optgroup>';
  }
  optsHtml += '<optgroup label="操作"><option value="__manage__">＋ 管理格式…</option></optgroup>';

  for (const selId of ['lookup-format-select', 'scan-format-select']) {
    const sel = document.getElementById(selId);
    if (!sel) continue;
    sel.innerHTML = optsHtml;
    const active = window.xdFormats.getActiveFormatId();
    sel.value = active;
    sel.onchange = (e) => {
      if (e.target.value === '__manage__') {
        // 切到管理 tab
        const tab = document.querySelector('.tab-btn[data-tab="formats"]');
        if (tab) tab.click();
        e.target.value = active;
        return;
      }
      window.xdFormats.setActiveFormatId(e.target.value);
      for (const otherId of ['lookup-format-select', 'scan-format-select']) {
        if (otherId !== selId) {
          const other = document.getElementById(otherId);
          if (other) other.value = e.target.value;
        }
      }
      rerenderAllCitations();
    };
  }
}

// 格式管理 tab 的事件代理
document.addEventListener('click', async (e) => {
  // 顶部三个按钮
  if (e.target && e.target.id === 'btn-fmt-new-blank') {
    const r = await openTemplateEditor({ mode: 'create-blank', initialFormat: { name: '', template: '' } });
    if (r) await saveNewUserFormat(r);
    await renderFormatList();
    await populateGlobalFormatSelectors();
    return;
  }
  if (e.target && e.target.id === 'btn-fmt-infer') {
    await openInferFlow();
    return;
  }
  if (e.target && e.target.id === 'btn-fmt-import') {
    document.getElementById('fmt-import-file').click();
    return;
  }
  // 列表项里的按钮
  const action = e.target && e.target.dataset && e.target.dataset.action;
  if (!action) return;
  const item = e.target.closest('.fmt-item');
  if (!item) return;
  const fmtId = item.dataset.fmtId;
  if (action === 'edit') return handleFormatEdit(fmtId);
  if (action === 'clone') return handleFormatClone(fmtId);
  if (action === 'reset') return handleFormatReset(fmtId);
  if (action === 'delete') return handleFormatDelete(fmtId);
  if (action === 'export') return handleFormatExport(fmtId);
});


// 导入 JSON 的文件选择监听（Task 4.4）
document.addEventListener('change', async (e) => {
  if (e.target && e.target.id === 'fmt-import-file') {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';  // 允许再次选同名文件
    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (err) {
      alert('JSON 解析失败：' + err.message);
      return;
    }
    const valid = window.xdFormats.validateImportedFormat(parsed);
    if (!valid.ok) {
      alert('导入失败：' + valid.error);
      return;
    }
    // 同名重复 → 提示
    const all = await window.xdFormats.listAllFormats();
    if (all.some(f => f.name === valid.name)) {
      const choice = prompt(`已存在同名格式 "${valid.name}"。\n输入新名（直接确认则用同名 + (导入)）：`, valid.name + ' (导入)');
      if (choice === null) return;
      valid.name = (choice || '').trim() || (valid.name + ' (导入)');
    }
    await saveNewUserFormat({
      name: valid.name,
      template: valid.template,
      parent_id: valid.based_on || null,
    });
    await renderFormatList();
    await populateGlobalFormatSelectors();
    alert('导入成功：' + valid.name);
  }
});


async function saveNewUserFormat({ name, template, parent_id }) {
  const id = `user_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await window.db.putFormat({
    id, name, category: 'user', template,
    parent_id: parent_id || null,
    created_at: now, updated_at: now,
  });
}


// 样例反推 UI 流程：选参照书 → 粘贴样例 → 审阅反推结果 → 采纳 or 修一下
async function openInferFlow() {
  // 列出库里全字段已填的书供选作参照
  const books = await window.dbHelpers.getBooksForUI();
  const candidates = books.filter(b =>
    b.author && b.author !== 'XX'
    && b.title
    && b.publisher && b.publisher !== 'XX出版社'
    && b.year && b.year !== '0000'
  );
  if (candidates.length === 0) {
    alert('需要至少一本元数据齐全的书做参照。请先去书架补一本（author/title/publisher/year 都不能是默认占位）。');
    return;
  }
  const optsHtml = candidates.map(b => `<option value="${escapeHtml(b.file_id)}">${escapeHtml(b.author)}《${escapeHtml(b.title)}》</option>`).join('');

  // 第一步：选参照书 + 粘贴样例
  const step1 = await showModal({
    title: '从样例反推格式（1/2）',
    bodyHtml: `
      <label>参照书</label>
      <select id="infer-ref">${optsHtml}</select>
      <label>粘贴样例（这本书在该格式下应该是什么样子）</label>
      <textarea id="infer-sample" rows="3" placeholder="例：任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。"></textarea>
      <label>样例里出现的页码</label>
      <input id="infer-page" type="number" value="25" />
      <p class="hint">算法会按字段值长度倒序在样例中查找替换。"主编/译"等责任方式无法自动推为 <code>{?role}</code> 段 — 反推完用"修一下"手动加。</p>
    `,
    onOk: async () => {
      const refId = document.getElementById('infer-ref').value;
      const sample = (document.getElementById('infer-sample').value || '').trim();
      const page = parseInt(document.getElementById('infer-page').value, 10) || 25;
      if (!sample) { alert('请粘贴样例'); return false; }
      const refBook = candidates.find(b => b.file_id === refId);
      const inferred = window.xdFormats.inferTemplateFromSample({
        refMeta: refBook, sample, refPage: page,
      });
      return { inferred, refBook, page };
    },
  });
  if (!step1) return;

  // 计算回填验证
  const backRender = window.xdFormats.renderCitation({
    template: step1.inferred,
    meta: step1.refBook,
    book_page: step1.page,
  });

  // 第二步：审阅 + 命名 + 选择"采纳"或"修一下"
  // 由于普通 showModal 没有"extra button"，我们用 radio 选择动作
  const step2 = await showModal({
    title: '反推结果（2/2）',
    bodyHtml: `
      <label>反推出的模板</label>
      <div class="tpl-textarea" style="background:#f6f8fa;padding:8px;white-space:pre-wrap;">${escapeHtml(step1.inferred)}</div>

      <label>回填验证（用该参照书渲染上述模板）</label>
      <div class="tpl-preview">${escapeHtml(backRender)}</div>

      <label>命名（保存为新的"我的"格式）</label>
      <input id="infer-name" placeholder="例：我的历史研究改" />

      <label style="margin-top:10px;">下一步</label>
      <label style="font-weight:normal;display:block;margin-top:4px;">
        <input type="radio" name="infer-action" value="accept" checked />
        ✓ 采纳并保存（直接保存上方模板）
      </label>
      <label style="font-weight:normal;display:block;">
        <input type="radio" name="infer-action" value="edit" />
        ✎ 修一下（进编辑器继续修改）
      </label>
    `,
    onOk: async () => {
      const name = (document.getElementById('infer-name').value || '').trim();
      const action = document.querySelector('input[name="infer-action"]:checked').value;
      if (action === 'accept' && !name) {
        alert('请填名称');
        return false;
      }
      return { action, name, template: step1.inferred };
    },
  });
  if (!step2) return;

  if (step2.action === 'accept') {
    await saveNewUserFormat({ name: step2.name, template: step2.template });
  } else if (step2.action === 'edit') {
    const r = await openTemplateEditor({
      mode: 'create-blank',
      initialFormat: { name: step2.name || '', template: step2.template },
    });
    if (r) await saveNewUserFormat(r);
  }
  await renderFormatList();
  await populateGlobalFormatSelectors();
}


async function handleFormatEdit(fmtId) {
  const fmt = await window.xdFormats.getFormatById(fmtId);
  if (!fmt) return;
  const r = await openTemplateEditor({ mode: 'edit', initialFormat: fmt });
  if (!r) return;
  const now = Date.now();
  // 修改内置格式 → 以 builtin category 写入 IndexedDB（"已修改的内置"）
  // 修改 user 格式 → 写入 IndexedDB
  await window.db.putFormat({
    id: fmt.id,
    name: r.name,
    category: fmt.category,
    template: r.template,
    parent_id: fmt.parent_id || null,
    created_at: fmt.created_at || now,
    updated_at: now,
  });
  await renderFormatList();
  await populateGlobalFormatSelectors();
  rerenderAllCitations();
}


async function handleFormatClone(fmtId) {
  const src = await window.xdFormats.getFormatById(fmtId);
  if (!src) return;
  const r = await openTemplateEditor({
    mode: 'clone',
    initialFormat: { name: `${src.name} 副本`, template: src.template, parent_id: src.id },
  });
  if (!r) return;
  await saveNewUserFormat(r);
  await renderFormatList();
  await populateGlobalFormatSelectors();
}


async function handleFormatReset(fmtId) {
  if (!confirm('重置为内置默认模板？这会丢弃你对此内置格式的修改。')) return;
  await window.db.deleteFormat(fmtId);
  await renderFormatList();
  await populateGlobalFormatSelectors();
  rerenderAllCitations();
}


async function handleFormatDelete(fmtId) {
  if (!confirm('删除这个自定义格式？')) return;
  await window.db.deleteFormat(fmtId);
  // 如当前 active 就是它，回退默认
  if (window.xdFormats.getActiveFormatId() === fmtId) {
    window.xdFormats.setActiveFormatId(window.xdFormats.DEFAULT_FORMAT_ID);
  }
  await renderFormatList();
  await populateGlobalFormatSelectors();
  rerenderAllCitations();
}


// 任务 4.3：导出 JSON
async function handleFormatExport(fmtId) {
  const fmt = await window.xdFormats.getFormatById(fmtId);
  if (!fmt) return;
  const payload = {
    "$schema": "xundian-cite/v1",
    name: fmt.name,
    template: fmt.template,
    based_on: fmt.parent_id || null,
    exported_at: Math.floor(Date.now() / 1000),
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = fmt.name.replace(/[\\/:*?"<>|]/g, '_');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.xundian-cite.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


async function rerenderAllCitations() {
  const id = window.xdFormats.getActiveFormatId();
  const fmt = await window.xdFormats.getFormatById(id);
  if (!fmt) return;
  document.querySelectorAll('.fmt-chip').forEach(chip => {
    const cardId = chip.dataset.cardId;
    const cardData = _cardMetaMap.get(cardId);
    if (!cardData) return;
    let newCitation;
    try {
      newCitation = window.xdFormats.renderCitation({
        template: fmt.template,
        meta: cardData.meta,
        book_page: cardData.book_page,
        book_page_end: cardData.book_page_end,
        pdf_page: cardData.pdf_page,
      });
    } catch (_) { return; }
    chip.dataset.currentFmt = id;
    chip.textContent = `📐 ${fmt.name} ▾`;
    const textEl = document.querySelector(`.cand-citation-text[data-card-id="${cardId}"]`);
    if (textEl) textEl.textContent = newCitation;
  });
}

async function bootstrap() {
  // 1. 浏览器能力检查
  if (!window.fs.isSupported()) {
    _showBootError(
      '当前浏览器不支持「File System Access API」。\n' +
      '请使用 Chrome / Edge / 国产 Chromium 系浏览器打开。\n' +
      'Firefox 与 Safari 暂不支持本应用。'
    );
    return;
  }
  if (!('indexedDB' in window)) {
    _showBootError('当前浏览器禁用了 IndexedDB，无法保存书架数据。');
    return;
  }

  // 2. 加载 Pyodide
  window.py.onPhase = ({ phase, detail }) => _updateBootPhase(phase, detail);
  try {
    await window.py.init();
  } catch (e) {
    console.error(e);
    _showBootError(`Python 加载失败：${e && e.message || e}\n\n请检查网络是否能访问 cdn.jsdelivr.net。`);
    return;
  }

  // 3. 同步设置到 Python 端
  try {
    const sRes = await callApi('get_settings');
    await window.py.call('set_settings', sRes.settings);
  } catch (e) {
    console.warn('同步设置失败：', e);
  }

  // 4. 关掉启动遮罩
  $('#boot-overlay').classList.add('hidden');
  setStatus('就绪');

  // 填充全局格式选择器
  await populateGlobalFormatSelectors();

  // 5. 数据目录展示（在欢迎卡里）
  try {
    const r = await callApi('get_data_dir_path');
    const codeEl = $('#welcome-data-dir');
    if (codeEl && r.path) codeEl.textContent = r.path;
  } catch (_) {}

  // 6. 书架空 → 自动切到书架页（与桌面版一致）
  try {
    const r = await callApi('list_books');
    const hasBooks = (r.books || []).some((b) => b.exists);
    if (!hasBooks) {
      switchTab('library');
      return;
    }
  } catch (_) {}

  refreshBookList();
}

// 启动
window.addEventListener('DOMContentLoaded', bootstrap);
