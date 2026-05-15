// 寻典 — JS 端引文模板渲染器
//
// 与 web/pysrc/citation.py + web/pysrc/formats.py 行为完全一致。
// 由 tests/citation_test_cases.json 共享用例锁定一致性。
//
// 用途：
//   1. 卡片 chip 切换格式时本地重渲染（不走 Pyodide 回路）
//   2. 模板编辑器实时预览
//   3. 全局选择器换格式时批量重渲染已显示卡片

'use strict';

const VALID_FIELDS = new Set([
  'author', 'role', 'country', 'title', 'translator', 'edition',
  'doc_type', 'place', 'publisher', 'year', 'page',
]);

const PLACEHOLDER = {
  author: '〔作者待补〕',
  title: '〔书名待补〕',
  place: '〔出版地待补〕',
  publisher: '〔出版社待补〕',
  year: '〔出版年待补〕',
  doc_type: 'M',
};

const BUILTIN_FORMATS = [
  {
    id: 'gbt7714',
    name: 'GB/T 7714—2015',
    category: 'builtin',
    template: '{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.',
  },
  {
    id: 'humanities_2024',
    name: '历史研究体例',
    category: 'builtin',
    template: '{?country [{}]}{author}{?role {}}：《{title}》，{?translator {}译，}{place}：{publisher}，{year}年，第{page}页。',
  },
  {
    id: 'law_2025',
    name: '法学引注手册 2025',
    category: 'builtin',
    template: '{?country [{}]}{author}{?role {}}：《{title}》{?edition （第{}版）}，{?translator {}译，}{publisher}{year}年版，第{page}页。',
  },
];

const DEFAULT_FORMAT_ID = 'gbt7714';


class TemplateSyntaxError extends Error {
  constructor(pos, message) {
    super(`位置 ${pos}：${message}`);
    this.pos = pos;
  }
}


function _formatPage(bookPage, bookPageEnd, pdfPage) {
  if (bookPage != null) {
    if (bookPageEnd != null && bookPageEnd !== bookPage) {
      return `${bookPage}-${bookPageEnd}`;
    }
    return String(bookPage);
  }
  if (pdfPage != null) {
    return `PDF第${pdfPage}页（书内页码待标定）`;
  }
  return '页码待补';
}


function _getField(field, meta, bookPage, bookPageEnd, pdfPage) {
  if (field === 'page') return _formatPage(bookPage, bookPageEnd, pdfPage);
  let v = meta[field];
  if (v == null) v = '';
  v = String(v);
  if (field === 'role' && v === '著') return '';
  return v;
}


function _renderRequired(field, value) {
  if (value) return value;
  return PLACEHOLDER[field] || '';
}


function parseTemplate(template) {
  // PORT NOTE: this is the JS mirror of Python's _parse in web/pysrc/citation.py.
  // When entering a {?...} block, we must scan past inner {} placeholders so the
  // outer } is matched correctly (naïve indexOf('}', i+1) hits the } of {} first).
  // Otherwise the spec's invariants apply: no nesting, exactly one {} slot in
  // optional segments, unknown field names rejected, etc.
  const tokens = [];
  const n = template.length;
  let i = 0;
  while (i < n) {
    const c = template[i];
    if (c === '}') throw new TemplateSyntaxError(i, '单独的 } 无对应 {');
    if (c !== '{') {
      let j = i;
      while (j < n && template[j] !== '{' && template[j] !== '}') j += 1;
      tokens.push({ kind: 'lit', text: template.slice(i, j) });
      i = j;
      continue;
    }
    // Entering { ... }
    // Choose matching-} strategy based on whether this is a ?-segment.
    let end;
    if (i + 1 < n && template[i + 1] === '?') {
      let j = i + 1;
      end = -1;
      while (j < n) {
        const ch = template[j];
        if (ch === '{') {
          // only {} placeholder allowed inside optional segment
          if (j + 1 < n && template[j + 1] === '}') {
            j += 2;
            continue;
          }
          throw new TemplateSyntaxError(i, '可选段内不允许嵌套 { 或 { 后非 }');
        }
        if (ch === '}') { end = j; break; }
        j += 1;
      }
      if (end < 0) throw new TemplateSyntaxError(i, '{ 没有对应的 }');
    } else {
      end = template.indexOf('}', i + 1);
      if (end < 0) throw new TemplateSyntaxError(i, '{ 没有对应的 }');
    }
    const inner = template.slice(i + 1, end);
    if (!inner) throw new TemplateSyntaxError(i, '空 {} 不允许');
    if (inner[0] === '?') {
      const rest = inner.slice(1).replace(/^\s+/, '');
      const sp = rest.indexOf(' ');
      if (sp < 0) throw new TemplateSyntaxError(i, '可选段缺少字段名与文本分隔空格');
      const field = rest.slice(0, sp);
      const body = rest.slice(sp + 1);
      if (!VALID_FIELDS.has(field)) throw new TemplateSyntaxError(i, `未知字段 "${field}"`);
      const slot = body.indexOf('{}');
      if (slot < 0) throw new TemplateSyntaxError(i, '可选段内必须含一个 {} 占位');
      if (body.indexOf('{}', slot + 2) >= 0) {
        throw new TemplateSyntaxError(i, '可选段内只能含一个 {} 占位');
      }
      tokens.push({
        kind: 'opt', field, prefix: body.slice(0, slot), suffix: body.slice(slot + 2),
      });
    } else {
      const field = inner;
      if (!VALID_FIELDS.has(field)) throw new TemplateSyntaxError(i, `未知字段 "${field}"`);
      tokens.push({ kind: 'req', field });
    }
    i = end + 1;
  }
  return tokens;
}


function renderCitation({ template, meta, book_page = null, book_page_end = null, pdf_page = null }) {
  const tokens = parseTemplate(template);
  const out = [];
  for (const tok of tokens) {
    if (tok.kind === 'lit') {
      out.push(tok.text);
    } else if (tok.kind === 'req') {
      const v = _getField(tok.field, meta, book_page, book_page_end, pdf_page);
      out.push(_renderRequired(tok.field, v));
    } else {
      const v = _getField(tok.field, meta, book_page, book_page_end, pdf_page);
      if (v) out.push(tok.prefix + v + tok.suffix);
    }
  }
  return out.join('');
}


function getBuiltinTemplate(formatId) {
  for (const f of BUILTIN_FORMATS) {
    if (f.id === formatId) return f.template;
  }
  return null;
}


// —— localStorage 持久化"当前全局格式"——

const STORAGE_KEY = 'xundian:active_format';

function getActiveFormatId() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_FORMAT_ID;
  } catch (_) {
    return DEFAULT_FORMAT_ID;
  }
}

function setActiveFormatId(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch (_) {
    // 隐私模式忽略
  }
}


// —— 合并内置 + IndexedDB 的视图 ——
// 优先 IndexedDB：用户修改内置时会以同 id 写入 IndexedDB 覆盖。

async function listAllFormats() {
  const userOrOverridden = await window.db.listFormats();
  const overrideById = new Map(userOrOverridden.map(f => [f.id, f]));
  const merged = BUILTIN_FORMATS.map(b => overrideById.get(b.id) || b);
  // 加进所有不在 builtin id 集合里的 user 格式
  const builtinIds = new Set(BUILTIN_FORMATS.map(f => f.id));
  for (const f of userOrOverridden) {
    if (!builtinIds.has(f.id)) merged.push(f);
  }
  return merged;
}

async function getFormatById(id) {
  const fromDb = await window.db.getFormat(id);
  if (fromDb) return fromDb;
  for (const b of BUILTIN_FORMATS) if (b.id === id) return b;
  return null;
}

async function resolveTemplateForId(id) {
  const f = await getFormatById(id);
  return f ? f.template : null;
}

function isModifiedBuiltin(fmt) {
  // 来自 IndexedDB 且 id 在内置集合里 → 是"已修改的内置"
  return fmt.category === 'builtin'
      && BUILTIN_FORMATS.some(b => b.id === fmt.id);
}


// —— 样例反推 ——

function inferTemplateFromSample({ refMeta, sample, refPage }) {
  // 从参照书的非空字段值出发，按长度倒序在 sample 中查找，命中则替换为 {field}。
  // 剩余文本全为字面。
  const fields = ['author', 'title', 'publisher', 'place', 'year', 'doc_type', 'role', 'translator', 'edition', 'country'];
  const pairs = [];
  for (const f of fields) {
    const v = (refMeta[f] || '').trim();
    if (v) pairs.push({ field: f, value: v });
  }
  if (refPage != null) pairs.push({ field: 'page', value: String(refPage) });

  // 长值优先
  pairs.sort((a, b) => b.value.length - a.value.length);

  // doc_type 是单字符，{doc_type} 占位通常前后有 [] 包围；不做特殊处理，让裸 M 也被替换
  // 但要避免 publisher 里有 "M" 被吃掉 → 用单词边界：在 doc_type 这种短串前后必须不是中英文字符。
  let working = sample;
  // 用占位标记中间状态，避免后一个替换打到前一个的产物里
  // step1: 标记到 \x00{field}\x00；最后再去掉 \x00
  const _escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const { field, value } of pairs) {
    if (!value) continue;
    const placeholder = `\x00{${field}}\x00`;
    if (field === 'doc_type' && value.length === 1) {
      // 用 [X] 模式精确替换
      const re = new RegExp(`\\[${_escape(value)}\\]`);
      working = working.replace(re, `[${placeholder}]`);
    } else {
      const idx = working.indexOf(value);
      if (idx >= 0) working = working.slice(0, idx) + placeholder + working.slice(idx + value.length);
    }
  }

  // 去掉占位标记
  return working.replace(/\x00/g, '');
}


// 暴露给浏览器和测试（globalThis.window 在 Node 测试里被预先 stub）
window.xdFormats = {
  renderCitation,
  parseTemplate,
  TemplateSyntaxError,
  BUILTIN_FORMATS,
  DEFAULT_FORMAT_ID,
  getBuiltinTemplate,
  VALID_FIELDS: [...VALID_FIELDS],
  getActiveFormatId,
  setActiveFormatId,
  // 新增 (Task 3.2):
  listAllFormats,
  getFormatById,
  resolveTemplateForId,
  isModifiedBuiltin,
  // 新增 (Task 4.1):
  inferTemplateFromSample,
};
