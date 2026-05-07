// 寻典 — 前端逻辑（v1）
// 与后端通信走 window.pywebview.api.<methodName>(...)，所有方法返回 Promise<{ok, ...}>

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

// 长操作期间禁用所有"会引起后端干活"的按钮，避免重复触发与状态混乱
const BUSY_SELECTORS = [
  '#btn-add-book', '#btn-pick-docx', '#btn-export-report',
  '#btn-lookup', '#btn-settings',
  '.book-card .btn-tiny',
  '.result-card .btn-tiny',
  '.alt-cand-card .btn-tiny',
];

let _busyDepth = 0;  // 支持嵌套调用

function setBusy(busy) {
  if (busy) {
    _busyDepth += 1;
  } else {
    _busyDepth = Math.max(0, _busyDepth - 1);
  }
  const isBusy = _busyDepth > 0;
  for (const sel of BUSY_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      el.disabled = isBusy;
      el.classList.toggle('busy', isBusy);
    });
  }
  document.body.classList.toggle('is-busy', isBusy);
}

// 包装一个长操作：自动 setBusy(true)，结束/出错时 setBusy(false)
async function withBusy(fn) {
  setBusy(true);
  try {
    return await fn();
  } finally {
    setBusy(false);
  }
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 错误翻译表：把 Python 异常映射成大白话给非技术用户看
function friendlyError(method, errType, errMsg) {
  errType = errType || '';
  errMsg = errMsg || '';

  // 优先匹配 errType
  if (errType === 'FileNotFoundError') {
    return '找不到文件。可能被移走或删除了，请检查路径后重试。';
  }
  if (errType === 'PermissionError') {
    return '无权访问该文件。可能正被其他程序打开（比如 Word 正在编辑），关掉后重试。';
  }
  if (errType === 'KeyError') {
    return '操作的对象已不存在。请刷新书架后重试。';
  }
  // ValueError 看具体内容
  if (errType === 'ValueError' && errMsg.includes('已存在同名书')) {
    return '书架里已经有同名书了。请先在书架移除旧的，或换文件名再添加。';
  }
  if (errType === 'ValueError' && errMsg.includes('only .pdf')) {
    return '只能添加 PDF 文件（.pdf）。其他格式（如 .epub / .mobi / .doc）暂不支持。';
  }
  // 读 PDF 出错
  if (errMsg.includes('extract_text') || errMsg.includes('pypdf')) {
    return '这本 PDF 无法读取文字内容，可能是纯图片扫描件。当前版本不带 OCR，请先用其他工具加上文字层再添加。';
  }
  // 没扫描就导出
  if (errMsg.includes('还没扫描过')) {
    return '请先在「文档扫描」中扫描一份 docx，再来导出核对表。';
  }
  // 通用兜底
  return `操作"${method}"失败：${errMsg || '未知错误'}`;
}

async function callApi(method, ...args) {
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api[method]) {
    throw new Error(`后端方法不存在：${method}`);
  }
  const result = await window.pywebview.api[method](...args);
  if (result && result.ok === false) {
    const friendly = friendlyError(method, result.type, result.error);
    setStatus(friendly.length > 60 ? friendly.slice(0, 60) + '…' : friendly);
    showAlert(friendly, '操作失败');
    throw new Error(friendly);
  }
  return result;
}

// 简易模态框
function showModal({ title, bodyHtml, onOk, okText = '确定', cancelText = '取消', hideCancel = false, modalClass = '' }) {
  return new Promise((resolve) => {
    const modalEl = document.querySelector('#modal-overlay .modal');
    // 清掉上次的额外 class
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

// 自家提示框，替换原生 alert/confirm（更美观、风格一致）
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
// 后端事件总线（pywebview 的 evaluate_js 推过来的消息走这里）
// =========================================================
window.onPyEvent = (kind, payload) => {
  switch (kind) {
    // —— 单本解析（旧路径，保留兼容） ——
    case 'parse_start':
      setStatus(`解析中：${payload.file_id}…`, 0);
      break;
    case 'parse_progress':
      setStatus(
        `解析中：${payload.file_id}（${payload.current}/${payload.total}）`,
        (payload.current / payload.total) * 100,
      );
      break;
    case 'parse_done':
      setStatus(`完成：${payload.file_id} · ${payload.page_count} 页`, null);
      break;

    // —— 批量解析（新模态路径） ——
    case 'batch_start':
      onBatchStart(payload);
      break;
    case 'book_start':
      onBookStart(payload);
      break;
    case 'book_progress':
      onBookProgress(payload);
      break;
    case 'book_done':
      onBookDone(payload);
      break;
    case 'book_cancelled':
      onBookCancelled(payload);
      break;
    case 'book_failed':
      onBookFailed(payload);
      break;
    case 'batch_done':
      onBatchDone(payload);
      break;

    // —— 文档扫描 ——
    case 'scan_start':
      setStatus(`扫描中：${payload.docx}…`);
      break;
    case 'scan_total':
      onScanTotal(payload);
      break;
    case 'scan_phase':
      onScanPhase(payload);
      break;
    case 'scan_match':
      onScanMatch(payload);
      break;
    case 'scan_done':
      onScanDone(payload);
      break;
  }
};

// —— 扫描事件处理 ——

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

// 在做需要书架的动作前先确认书架非空；空则引导用户去添加书籍
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

// 折叠状态（仅内存；关掉 app 重置为展开）
const collapsedFolders = new Set();

function _renderBookCard(b) {
  const card = document.createElement('div');
  card.className = 'book-card';
  if (multiselectActive && selectedBookIds.has(b.file_id)) {
    card.classList.add('ms-selected');
  }
  // 拖拽：非多选模式 + PDF 存在时才允许
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
    // 拖拽：开始时存 file_id
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
  // name=null 即未分组
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

  // 折叠：点 header 但不点按钮区
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

  // —— 拖放接收 ——
  // 整个 section 都是 drop target（包括 header 和 body 区域）
  const targetFolder = isUngrouped ? null : name;
  section.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.types || !ev.dataTransfer.types.includes('text/plain')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    section.classList.add('drop-target');
  });
  section.addEventListener('dragleave', (ev) => {
    // 只有真正离开整个 section 时才取消高亮
    if (!section.contains(ev.relatedTarget)) {
      section.classList.remove('drop-target');
    }
  });
  section.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    section.classList.remove('drop-target');
    const fileId = ev.dataTransfer.getData('text/plain');
    if (!fileId) return;
    // 已经在目标文件夹里 → 不动
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

  // 按 folder 分组
  const byFolder = new Map();
  for (const f of folders) byFolder.set(f, []);
  const ungrouped = [];
  for (const b of books) {
    if (b.folder && byFolder.has(b.folder)) byFolder.get(b.folder).push(b);
    else if (b.folder) {
      // folder 字段指向不在 folders 列表里的名字（数据不一致）→ 当未分组处理
      ungrouped.push(b);
    } else {
      ungrouped.push(b);
    }
  }

  // 文件夹按字母序，未分组永远最后
  const sortedFolders = Array.from(byFolder.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const fname of sortedFolders) {
    container.appendChild(_renderFolderSection({
      name: fname,
      books: byFolder.get(fname),
      isUngrouped: false,
    }));
  }
  // 未分组：哪怕没有书也不渲染（避免空噪音）；只在有书时显示
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
    await editBookMeta(book);  // edit 是同步表单，不需要 busy
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
        if (!name || !name.trim()) return false;  // 阻止关闭
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

$('#btn-add-book').addEventListener('click', () => withBusy(async () => {
  const picked = await callApi('pick_pdf_files');
  const paths = picked.paths || [];
  if (paths.length === 0) return;

  // 让用户选目标文件夹（一次性应用到这批所有 PDF）
  let targetFolder = null;
  // 先取最新文件夹列表
  try {
    const fr = await callApi('list_folders');
    window._lastFolders = (fr.folders || []).map((f) => f.name);
  } catch (_) {}
  const fileNames = paths.map((p) => p.split(/[/\\]/).pop());
  const result = await showModal({
    title: `导入到哪个文件夹？（${paths.length} 本）`,
    bodyHtml: `
      <p class="dim" style="font-size:12px;">本次新增书籍：${fileNames.map(escapeHtml).join('、')}</p>
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
      return { folder: f || null };  // 包对象避免 null 与取消混淆
    },
  });
  if (result === null || typeof result !== 'object') return;  // 取消
  targetFolder = result.folder;

  // 批量导入：全部用占位元数据快速登记，再逐本解析
  let added = [];
  let skipped = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const filename = p.split(/[/\\]/).pop();
    setStatus(`登记中 ${i + 1}/${paths.length}：${filename}`);
    const r = await callApi('add_book_quick', p);
    if (r.skipped) {
      skipped.push({ filename, reason: r.reason });
    } else {
      added.push(r.book);
    }
  }

  // 如果用户选了文件夹，批量打标签
  if (targetFolder && added.length > 0) {
    await callApi('update_book_folders', added.map((b) => b.file_id), targetFolder);
  }
  refreshBookList();

  // 提示批量结果
  if (skipped.length) {
    const lines = skipped.map((s) => `· ${s.filename}（${s.reason}）`).join('\n');
    await showAlert(`本次添加 ${added.length} 本，跳过 ${skipped.length} 本：\n\n${lines}`, '导入结果');
  }

  // 用模态批量解析
  if (added.length > 0) {
    const ids = added.map((b) => b.file_id);
    openParseModal(ids);
    await callApi('parse_books_batch', ids);
    // 模态里点"完成"后再弹补元数据提示
    await showAlert(
      `已添加 ${added.length} 本书并完成解析（或被取消的部分需稍后重试）。\n\n` +
      `出版社、年份等出版信息留空，可在书架卡片点「编辑」补全。`,
      '导入完成',
    );
  }
  setStatus(`批量导入完成 · 新增 ${added.length} 本，跳过 ${skipped.length} 本`);
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

  // 头：状态 + 引文 ID
  const headerHtml = `
    <div class="header">
      <span class="status-badge ${st.cls}">${st.label}</span>
      <span>[${item.quote_id || '—'}] 引文</span>
    </div>
    <div class="quote">${escapeHtml(item.text)}</div>
  `;

  // 出处
  const citationHtml = `
    <div class="citation"><b>出处（建议）：</b>${escapeHtml(item.citation)}</div>
  `;

  // 上下文
  let contextHtml = '';
  if (item.context_before || item.context_after) {
    contextHtml = `
      <div class="ctx-label"><b>原文上下文：</b></div>
      <div class="ctx-text">……${escapeHtml(item.context_before)}<mark>${escapeHtml(item.text)}</mark>${escapeHtml(item.context_after)}……</div>
    `;
  }

  // 命中信息（仅有 best 时）
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

  // 其他疑似候选
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

  // 绑定按钮
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
  // UI 由事件流（scan_total / scan_match / scan_done）实时更新
  // 这里 await 只是等流结束；返回值用于兜底（理论上这时 lastScanResults 已经填好）
  const res = await callApi('scan_document', docxPath, scanScope);
  // 兜底：极端情况事件未触发时，用返回值补渲染
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
  // 只复制状态为 hit 的（自动命中）脚注，标记 ⚠ / ✗ 的让用户人工核对再复制
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
  const picked = await callApi('pick_save_path', '引文核对表.docx');
  if (!picked.path) return;
  const r = await callApi('export_report', picked.path);
  setStatus(`已导出：${r.saved_to}`);
  showAlert('核对表已导出到：\n\n' + r.saved_to, '导出成功');
}));

// 拖放支持
const dz = $('#scan-dropzone');
['dragenter', 'dragover'].forEach((ev) => {
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach((ev) => {
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); });
});
dz.addEventListener('drop', async (e) => {
  // pywebview 不直接给 file path（浏览器安全限制），用文件选择器更稳
  showAlert('请用「📂 选择 docx 文件」按钮选择文件。\n（受安全限制，拖放暂时无法直接读取文件路径。）', '改用按钮选择');
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
    // 顶部加一行小字"查询：「xxx」"
    const header = document.createElement('div');
    header.className = 'lookup-header';
    header.innerHTML = `<span class="dim" style="font-size:12px;">查询：</span><b>「${escapeHtml(quote)}」</b>`;
    container.appendChild(header);
    container.appendChild(renderResultCard(item));
    setStatus('查询完成');
  });
}

$('#btn-lookup').addEventListener('click', runLookup);

// Ctrl+Enter 触发查询
$('#lookup-quote').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runLookup();
  }
});
$('#lookup-ctx').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runLookup();
  }
});

// 输入框右侧 ✕ 清空按钮：根据是否有内容显隐
function bindClearButton(inputId, clearBtnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(clearBtnId);
  const wrap = input && input.parentElement;
  if (!input || !btn || !wrap) return;
  const sync = () => {
    wrap.classList.toggle('has-value', !!input.value);
  };
  input.addEventListener('input', sync);
  btn.addEventListener('click', () => {
    input.value = '';
    sync();
    input.focus();
  });
  sync();
}
bindClearButton('lookup-quote', 'btn-clear-quote');
bindClearButton('lookup-ctx', 'btn-clear-ctx');

// =========================================================
// 设置面板
// =========================================================

const DEFAULT_SETTINGS = { threshold: 0.85, ctx_weight: 0.10, top_k: 3 };

async function openSettings() {
  // 读取当前设置 + 关于信息
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
      <button class="btn-secondary" id="btn-open-data-dir" type="button">📂 打开数据目录</button>
      <button class="btn-tiny" id="btn-reset-defaults" type="button" style="margin-left:8px;">恢复默认</button>
    </div>

    <div class="settings-section">
      <h4>关于</h4>
      <div class="about-table">
        <div><span class="key">应用：</span>${escapeHtml(info.app_name || '寻典')} ${escapeHtml(info.version || '')}</div>
        <div><span class="key">Python：</span>${escapeHtml(info.python_version || '')}</div>
        <div><span class="key">数据目录：</span>${escapeHtml(info.data_dir || '')}</div>
        ${depsHtml}
      </div>
    </div>
  `;

  // 用 modal 装载，但保留我们自家滑块的实时联动
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

  // 在 modal 还活着的瞬间绑定的事件，会在 modal 关闭时随节点销毁；
  // 这里我们利用 showModal 内部 innerHTML 已注入，需要在 showModal 之后再绑定？
  // —— 由于 showModal 是同步注入再 await，这块在 await 前已经渲染好但事件没绑。
  // 为简化：把"实时联动"放到打开 modal 后立刻执行的微任务里。
  // 实际上下面的 setTimeout(0) 在 modal 关闭后才跑——所以放到这里没用。
  // 重写为：在打开 modal 之前就监听 DOM，另一种思路是在 showModal 里支持 onOpen 钩子。
  // 但当前 showModal 同步注入 → 我们可以在调用 showModal 后立刻用 setTimeout(0) 跑绑定，
  // 但需要在 await 之前。所以下面这段实际上在 modal 已关时跑——逻辑上不会出错，但绑不上。
  // —— 见 wireSettingsLiveValues() 真实实现，我们改用立即同步绑定。

  if (!result) return;
  if (result.__resetDefaults) {
    await callApi('update_settings', DEFAULT_SETTINGS);
    setStatus('设置已恢复默认');
    return;
  }
  await callApi('update_settings', result);
  setStatus(`设置已保存：阈值 ${result.threshold} · 语境权重 ${result.ctx_weight} · top-${result.top_k}`);
}

// 真正的"实时联动"——监听 modal 内的 input
document.addEventListener('input', (e) => {
  if (e.target.id === 'set-threshold') {
    $('#set-threshold-val').textContent = Number(e.target.value).toFixed(2);
  } else if (e.target.id === 'set-ctxw') {
    $('#set-ctxw-val').textContent = Number(e.target.value).toFixed(2);
  } else if (e.target.id === 'set-topk') {
    $('#set-topk-val').textContent = e.target.value;
  }
});

// 设置 modal 内的两个次要按钮
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

// 欢迎卡里的"添加你的第一本书"按钮 — 点击同 + 添加书籍
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'btn-welcome-add') {
    $('#btn-add-book').click();
  }
});

// =========================================================
// 解析进度模态（批量解析时）
// =========================================================

let parseRows = {};   // file_id -> DOM row element
let parseFinished = false;

function shortName(name) {
  // 截一下太长的文件名，保留前后
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
  setRowState(p.file_id, {
    state: 'in-progress',
    icon: '⏳',
    pages: '解析中…',
    fillPct: 0,
  });
}

function onBookProgress(p) {
  const pct = (p.current / p.total) * 100;
  setRowState(p.file_id, {
    pages: `${p.current}/${p.total}`,
    fillPct: pct,
  });
}

function onBookDone(p) {
  setRowState(p.file_id, {
    state: 'done',
    icon: '✓',
    pages: `${p.page_count} 页`,
    fillPct: 100,
  });
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
  setRowState(p.file_id, {
    state: 'failed',
    icon: '✗',
    pages: '失败',
    fillPct: 100,
  });
}

function onBatchDone(p) {
  parseFinished = true;
  const parts = [];
  if (p.done) parts.push(`✓ 完成 ${p.done}`);
  if (p.cancelled) parts.push(`🚫 取消 ${p.cancelled}`);
  if (p.failed) parts.push(`✗ 失败 ${p.failed}`);
  if (p.skipped) parts.push(`⏭ 跳过 ${p.skipped}`);
  $('#parse-summary').textContent = parts.join(' · ') || '完成';

  // 切按钮：取消 → 完成
  $('#btn-cancel-parse').classList.add('hidden');
  $('#btn-parse-done').classList.remove('hidden');
  $('#btn-parse-done').focus();

  // 同步刷新书架
  refreshBookList();
}

// 取消按钮
$('#btn-cancel-parse').addEventListener('click', async () => {
  if (parseFinished) return;
  $('#btn-cancel-parse').disabled = true;
  $('#btn-cancel-parse').textContent = '正在取消…';
  await callApi('cancel_parsing');
});

// 完成按钮（解析跑完后才显示）
$('#btn-parse-done').addEventListener('click', () => {
  closeParseModal();
});

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
  refreshBookList();  // 重新渲染以加/去 checkbox
}

function updateMultiselectToolbar() {
  $('#ms-count-num').textContent = selectedBookIds.size;
  // 智能显隐：基于选中项的状态
  const allBooks = window._lastBookList || [];
  const selectedBooks = allBooks.filter((b) => selectedBookIds.has(b.file_id));
  const hasUnparsed = selectedBooks.some((b) => !b.parsed && b.exists);
  const hasParsed = selectedBooks.some((b) => b.parsed && b.exists);
  $('#ms-batch-parse').classList.toggle('hidden', !hasUnparsed);
  $('#ms-batch-reparse').classList.toggle('hidden', !hasParsed);
  // 全部按钮在没选中时禁用（除了全选）
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
  // batch_done 事件已经触发 refreshBookList，这里不再重复
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
  // 先批量清缓存，再走带模态的批量解析
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

  // 取最新文件夹列表
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
      return { folder: f || null };  // 包对象避免 null 与取消混淆
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
  // 取最新文件夹列表
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
      // 包成对象，避免 showModal 把 null 转成 true 与取消混淆
      return { folder: f || null };
    },
  });
  if (result === null || typeof result !== 'object') return;  // 取消
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

// 范围状态：null = 全部
// 否则 { folders: [...], file_ids: [...], include_ungrouped: bool }
let scanScope = null;
let lookupScope = null;

function _scopeSummary(scope) {
  if (!scope) return '全部书架';
  const allBooks = window._lastBookList || [];
  // 计算选中的书数
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
  // 加载书架与文件夹
  const [foldersRes, booksRes] = await Promise.all([
    callApi('list_folders'),
    callApi('list_books'),
  ]);
  const folders = foldersRes.folders || [];
  const ungroupedCount = foldersRes.ungrouped || 0;
  const books = (booksRes.books || []).filter((b) => b.exists);

  // 初始勾选：把 currentScope 转成"哪些 file_id 应被勾"
  const checkedIds = new Set();
  if (!currentScope) {
    // 全部
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
  // 根据每本书的状态推出文件夹/未分组初始勾选（让初次打开就一致）
  function _allChecked(arr) { return arr.length > 0 && arr.every((b) => checkedIds.has(b.file_id)); }
  const folderCheckedInit = new Map();
  for (const f of folders) {
    folderCheckedInit.set(f.name, _allChecked(books.filter((b) => b.folder === f.name)));
  }
  const ungroupedBooks0 = books.filter((b) => !b.folder);
  const checkedUngrouped = _allChecked(ungroupedBooks0);

  // 渲染：仿书架页文件夹外观
  const treeRows = [];

  // "全部书架" 顶部一行（初始勾选根据所有书的勾选状态计算）
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

  function _renderFolderSection(opts) {
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

  // 文件夹
  for (const f of folders) {
    const booksInFolder = books.filter((b) => b.folder === f.name);
    treeRows.push(_renderFolderSection({
      name: f.name,
      isUngrouped: false,
      booksInFolder,
      checked: folderCheckedInit.get(f.name),
    }));
  }

  // 未分组
  const ungroupedBooks = books.filter((b) => !b.folder);
  if (ungroupedBooks.length > 0) {
    treeRows.push(_renderFolderSection({
      name: null,
      isUngrouped: true,
      booksInFolder: ungroupedBooks,
      checked: checkedUngrouped,
    }));
  }

  // showModal 的 Promise 构造体会同步注入 HTML，可以马上同步 indeterminate 状态
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
      // 如果"全部"被勾，等价于 null（全部书架）
      if (allCb && allCb.checked) return { __all__: true };

      const sel = {
        folders: [],
        file_ids: [],
        include_ungrouped: false,
      };
      $$('.scope-folder-cb').forEach((cb) => {
        if (cb.checked) sel.folders.push(cb.dataset.folder);
      });
      const ungroupedCb = $('#scope-ungrouped-cb');
      if (ungroupedCb && ungroupedCb.checked) sel.include_ungrouped = true;
      $$('.scope-book-cb').forEach((cb) => {
        if (cb.checked) {
          // 如果该书所在文件夹已经勾了，就不重复加
          // 找它的 folder
          const folder = books.find((b) => b.file_id === cb.dataset.id)?.folder;
          if (folder && sel.folders.includes(folder)) return;
          if (!folder && sel.include_ungrouped) return;
          sel.file_ids.push(cb.dataset.id);
        }
      });
      // 全部都没选
      if (!sel.folders.length && !sel.file_ids.length && !sel.include_ungrouped) {
        showAlert('请至少勾选一项作为查找范围。');
        return false;
      }
      return sel;
    },
  });
  // 注入 HTML 后立即设置 indeterminate（"半选"），随后等用户决定
  _syncScopeParents();
  const result = await modalPromise;

  if (result === null) return null;  // 取消
  if (result.__all__) return null;   // 选了"全部"
  return result;
}

// 范围模态：父子复选框三层联动（全部书架 ↔ 文件夹 ↔ 单本书）
function _syncScopeParents() {
  // 每个文件夹 section：表头 checkbox 状态由其下书的勾选状态推出
  $$('.scope-folder-section').forEach((section) => {
    const headerCb = section.querySelector('.scope-folder-cb, #scope-ungrouped-cb');
    if (!headerCb) return;
    const bookCbs = Array.from(section.querySelectorAll('.scope-book-cb'));
    if (bookCbs.length === 0) {
      headerCb.indeterminate = false;
      return;
    }
    const all = bookCbs.every((cb) => cb.checked);
    const some = bookCbs.some((cb) => cb.checked);
    headerCb.checked = all;
    headerCb.indeterminate = some && !all;
  });
  // "全部书架"：所有书的勾选状态推出
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
    // 主复选框 → 级联到所有书 + 所有文件夹标题
    const checked = e.target.checked;
    e.target.indeterminate = false;
    $$('.scope-book-cb').forEach((cb) => { cb.checked = checked; cb.indeterminate = false; });
    $$('.scope-folder-cb').forEach((cb) => { cb.checked = checked; cb.indeterminate = false; });
    const u = $('#scope-ungrouped-cb'); if (u) { u.checked = checked; u.indeterminate = false; }
  } else if (e.target.classList && e.target.classList.contains('scope-folder-cb')) {
    // 文件夹 → 级联到它下面的书
    e.target.indeterminate = false;
    const section = e.target.closest('.scope-folder-section');
    if (section) {
      section.querySelectorAll('.scope-book-cb').forEach((cb) => { cb.checked = e.target.checked; });
    }
    _syncScopeParents();
  } else if (e.target.id === 'scope-ungrouped-cb') {
    e.target.indeterminate = false;
    const section = e.target.closest('.scope-folder-section');
    if (section) {
      section.querySelectorAll('.scope-book-cb').forEach((cb) => { cb.checked = e.target.checked; });
    }
    _syncScopeParents();
  } else if (e.target.classList && e.target.classList.contains('scope-book-cb')) {
    // 书勾选变化 → 把它的文件夹和"全部书架"状态重新推算
    _syncScopeParents();
  }
});

// 范围模态：点击文件夹标题（除 checkbox 与 label 外）切换折叠
document.addEventListener('click', (e) => {
  const header = e.target.closest && e.target.closest('.scope-folder-header');
  if (!header) return;
  // 点 checkbox / 点 label 文字 / 点 .book-name 都不应触发折叠
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
  // 点的是 folder-name 也允许触发折叠（仿书架页）
  const section = header.parentElement;
  if (section && section.classList.contains('scope-folder-section')) {
    section.classList.toggle('collapsed');
  }
});

$('#scan-scope-edit').addEventListener('click', async () => {
  const r = await openScopeModal(scanScope);
  if (r !== undefined) {
    scanScope = r;
    updateScopeSummaries();
  }
});

$('#lookup-scope-edit').addEventListener('click', async () => {
  const r = await openScopeModal(lookupScope);
  if (r !== undefined) {
    lookupScope = r;
    updateScopeSummaries();
  }
});

// =========================================================
// 启动
// =========================================================
async function bootstrap() {
  setStatus('就绪');
  // 把数据目录路径填到欢迎卡的 <code> 标签
  try {
    const r = await callApi('get_data_dir_path');
    const codeEl = $('#welcome-data-dir');
    if (codeEl && r.path) codeEl.textContent = r.path;
  } catch (_) {}

  // 首次启动判断：若书架空（没有任何存在的 PDF），自动切到书架页签。
  // 这样用户一打开就看到欢迎卡 + [+ 添加你的第一本书]，不会停在空空的扫描页茫然。
  try {
    const r = await callApi('list_books');
    const hasBooks = (r.books || []).some((b) => b.exists);
    if (!hasBooks) {
      switchTab('library');  // switchTab 内部会调 refreshBookList
      return;
    }
  } catch (_) {}

  refreshBookList();
}

window.addEventListener('pywebviewready', bootstrap);
