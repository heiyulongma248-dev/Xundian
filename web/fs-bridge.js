// 寻典网页版 — File System Access API 桥
// 负责：用户选 PDF / docx，记住文件 handle（持久化到 IndexedDB），
// 后续按需用 handle 拿到文件 bytes 喂给 Python。
//
// 浏览器要求：Chromium 86+（Chrome / Edge / Opera 桌面）。
// Firefox / Safari 不支持 showOpenFilePicker —— 启动时已经被拦下。

'use strict';

function _isSupported() {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

// —— 选 PDF（可多选） ——
async function pickPdfFiles({ multiple = true } = {}) {
  if (!_isSupported()) {
    throw new Error('当前浏览器不支持 showOpenFilePicker。请用 Chrome / Edge。');
  }
  try {
    const handles = await window.showOpenFilePicker({
      multiple,
      types: [{
        description: 'PDF 文件',
        accept: { 'application/pdf': ['.pdf'] },
      }],
      excludeAcceptAllOption: false,
    });
    return handles; // FileSystemFileHandle[]
  } catch (e) {
    // 用户按了取消 → DOMException AbortError，不当错误处理
    if (e && (e.name === 'AbortError' || e.code === 20)) return [];
    throw e;
  }
}

// —— 选 docx ——
async function pickDocxFile() {
  if (!_isSupported()) {
    throw new Error('当前浏览器不支持 showOpenFilePicker。请用 Chrome / Edge。');
  }
  try {
    const handles = await window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: 'Word 文档',
        accept: {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
        },
      }],
    });
    return handles[0]; // FileSystemFileHandle
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 20)) return null;
    throw e;
  }
}

// —— 读 handle 的字节 —— 必要时申请权限 ——
// 必须从用户手势上下文里调（onclick → 这个函数），否则浏览器会拒绝 requestPermission
async function readHandleBytes(handle, { silent = false } = {}) {
  if (!handle) return null;
  // queryPermission 不需要手势上下文；requestPermission 需要
  let perm;
  try {
    perm = await handle.queryPermission({ mode: 'read' });
  } catch (_) {
    perm = 'prompt';
  }
  if (perm !== 'granted') {
    if (silent) return null;
    try {
      const granted = await handle.requestPermission({ mode: 'read' });
      if (granted !== 'granted') {
        throw new Error('用户未授权读取该 PDF。请在浏览器弹窗里点「允许」。');
      }
    } catch (e) {
      throw new Error(`无法获得 PDF 读取权限：${e.message || e}`);
    }
  }
  let file;
  try {
    file = await handle.getFile();
  } catch (e) {
    // 文件被移走 / 删了
    throw new Error(`PDF 文件不见了或被移动了：${e.message || e}`);
  }
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

// —— 批量预申请读权限（一次性弹一遍许可） ——
// 多本书一起解析时，至少先把每个 handle 的权限拿到，避免中途遇到 prompt 中断。
async function ensureReadPermissions(handles) {
  const need = [];
  for (const h of handles) {
    let perm = 'prompt';
    try { perm = await h.queryPermission({ mode: 'read' }); } catch (_) {}
    if (perm !== 'granted') need.push(h);
  }
  for (const h of need) {
    try { await h.requestPermission({ mode: 'read' }); } catch (_) {}
  }
}

// —— 取得 handle 对应的文件名（不依赖系统路径） ——
function handleName(handle) {
  return handle && handle.name ? handle.name : '';
}

// —— PDF 跳页：打开自家 pdf-viewer.html，用 pdf.js 在 canvas 上渲染 ——
// 之前用 window.open(blob:application/pdf) 和 <embed> 都依赖 Chrome 自带 PDF
// 阅读器；如果用户禁用了它（Mac 用户常见，为了用 Preview），就会强制下载。
// 完全自己渲染（已经为了抽文字加载过的 pdf.js）就彻底没这个问题。
async function openPdfAtPage(handle, pageNum) {
  const bytes = await readHandleBytes(handle);
  if (!bytes) throw new Error('无法读取 PDF。');

  const pdfBlob = new Blob([bytes], { type: 'application/pdf' });
  const pdfUrl = URL.createObjectURL(pdfBlob);

  const viewerUrl = `pdf-viewer.html?file=${encodeURIComponent(pdfUrl)}`
    + `&page=${pageNum}`
    + `&name=${encodeURIComponent(handle.name || 'PDF')}`;

  const w = window.open(viewerUrl, '_blank');

  // 1 小时后回收 PDF blob URL —— viewer 已经 getDocument 抓过文档结构，
  // 后续翻页 pdf.js 内部用 ArrayBuffer，不再依赖 blob URL。
  setTimeout(() => URL.revokeObjectURL(pdfUrl), 3600_000);

  if (!w) {
    throw new Error('浏览器拦截了新窗口。请在地址栏右侧允许弹窗后重试。');
  }
  return { url: viewerUrl };
}

// —— 触发"另存为"下载 bytes —— 用于导出核对表 docx ——
async function downloadBytes(bytes, suggestedName) {
  // 优先用 showSaveFilePicker（更像桌面），不支持就退到 a.download
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'Word 文档',
          accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
        }],
      });
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      return { saved: true, name: handle.name };
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.code === 20)) {
        return { saved: false, cancelled: true };
      }
      // 其它错误：退到 a.download
      console.warn('[fs-bridge] showSaveFilePicker 失败，退到 a.download：', e);
    }
  }
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName || '引文核对表.docx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  return { saved: true, name: suggestedName };
}

window.fs = {
  isSupported: _isSupported,
  pickPdfFiles,
  pickDocxFile,
  readHandleBytes,
  ensureReadPermissions,
  handleName,
  openPdfAtPage,
  downloadBytes,
};
