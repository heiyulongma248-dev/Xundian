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
    const result = await window.py.call(
      'scan_document',
      _stagedDocx.bytes,
      booksData,
      booksMeta,
      _stagedDocx.name,
    );
    return { ok: true, ...(result || {}) };
  },

  async lookup_quote(quote, ctxBefore, ctxAfter, scope) {
    const fileIds = await _resolveScopeToFileIds(scope);
    const booksData = await window.dbHelpers.getBooksPagesData(fileIds);
    const booksMeta = await window.dbHelpers.getBooksMeta();
    const result = await window.py.call(
      'lookup_quote',
      quote,
      ctxBefore || '',
      ctxAfter || '',
      booksData,
      booksMeta,
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
    const bytes = await window.py.call('export_report_bytes');
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

async function editBookMeta(book) {
  const result = await showModal({
    title: '编辑书籍信息',
    bodyHtml: `
      <label>作者</label><input id="m-author" value="${escapeHtml(book.author)}" />
      <label>书名</label><input id="m-title" value="${escapeHtml(book.title)}" />
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
        title: $('#m-title').value.trim(),
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

function renderResultCard(item) {
  const statusMap = {
    hit:  { label: '✓ 自动命中',     color: '#1e823b', cls: 'ok' },
    low:  { label: '⚠ 置信度偏低',   color: '#b78612', cls: 'warn' },
    miss: { label: '✗ 未命中',        color: '#c0392b', cls: 'error' },
  };
  const st = statusMap[item.status];

  const card = document.createElement('div');
  card.className = 'result-card';

  const headerHtml = `
    <div class="header">
      <span class="status-badge ${st.cls}">${st.label}</span>
      <span>[${item.quote_id || '—'}] 引文</span>
    </div>
    <div class="quote">${escapeHtml(item.text)}</div>
  `;

  const citationHtml = `
    <div class="citation"><b>出处（建议）：</b>${escapeHtml(item.citation)}</div>
  `;

  let contextHtml = '';
  if (item.context_before || item.context_after) {
    contextHtml = `
      <div class="ctx-label"><b>原文上下文：</b></div>
      <div class="ctx-text">……${escapeHtml(item.context_before)}<mark>${escapeHtml(item.text)}</mark>${escapeHtml(item.context_after)}……</div>
    `;
  }

  let bestHtml = '';
  if (item.candidates && item.candidates.length > 0) {
    const best = item.candidates[0];
    const bp = best.book_page != null ? `书内 p${best.book_page}${best.is_cross_page ? `–${best.book_page_end}` : ''}` : '书内页码未识别';
    const cross = best.is_cross_page ? '<span class="cross-page-tag">跨页</span> ' : '';
    bestHtml = `
      <div class="ctx-label" style="margin-top:8px;"><b>命中位置：</b></div>
      <div class="ctx-text">${cross}${escapeHtml(best.book_file)} · PDF p${best.pdf_page}${best.is_cross_page ? `–${best.pdf_page_end}` : ''} · ${bp}</div>
      <div class="scores">主分 ${best.score.toFixed(2)} · 语境分 ${best.ctx_score.toFixed(2)} · 综合 ${best.final_score.toFixed(2)}</div>
      <div class="ctx-label"><b>书中片段：</b></div>
      <div class="snippet">……${escapeHtml(best.snippet_before)}<span class="highlight">${escapeHtml(item.text)}</span>${escapeHtml(best.snippet_after)}……</div>
      <div class="actions">
        <button class="btn-tiny" data-act="copy" data-payload="${escapeHtml(item.citation)}">📋 复制脚注</button>
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
          const bp = c.book_page != null ? `书内 p${c.book_page}` : '书内页码未识别';
          return `
            <div class="alt-cand-card">
              <div><b>候选 ${i + 2}</b> · ${escapeHtml(c.book_file)} · PDF p${c.pdf_page} · ${bp}</div>
              <div class="scores">主分 ${c.score.toFixed(2)} · 语境分 ${c.ctx_score.toFixed(2)} · 综合 ${c.final_score.toFixed(2)}</div>
              <div class="snippet">……${escapeHtml(c.snippet_before)}<span class="highlight">${escapeHtml(item.text)}</span>${escapeHtml(c.snippet_after)}……</div>
              <div class="actions">
                <button class="btn-tiny" data-act="open-pdf" data-file="${escapeHtml(c.book_file)}" data-page="${c.pdf_page}">📖 在 PDF 中查看</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  card.innerHTML = headerHtml + citationHtml + contextHtml + bestHtml + altHtml;

  card.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      if (act === 'copy') {
        try {
          await navigator.clipboard.writeText(btn.dataset.payload);
          setStatus('脚注已复制到剪贴板');
        } catch (e) {
          showAlert('复制到剪贴板失败：' + e, '复制失败');
        }
      } else if (act === 'open-pdf') {
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

  // 注意：drop 之后必须立刻把 items 转成 handle，items 在异步之间会失效
  // 所以先把 items 同步收集到数组里再 await
  const items = Array.from(dataTransfer.items || []);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    let handle;
    try {
      handle = await item.getAsFileSystemHandle();
    } catch (_) { handle = null; }
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
