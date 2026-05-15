// citation 渲染 — JS 端测试（与 Python 共用 tests/citation_test_cases.json）
// 跑法：node tests/citation_test.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 直接 import web/formats.js — 它会绑到 globalThis.window，需要先 stub
// Windows 上 dynamic import 要 file:// URL，不能直接用绝对路径
globalThis.window = globalThis.window || {};
await import(pathToFileURL(path.join(ROOT, 'web', 'formats.js')).href);

const { renderCitation, BUILTIN_FORMATS, getBuiltinTemplate } = window.xdFormats;

const FIXTURE = path.join(ROOT, 'tests', 'citation_test_cases.json');
const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

let passed = 0;
const failures = [];
for (const c of data.cases) {
  const out = renderCitation({
    template: c.template,
    meta: c.meta,
    book_page: c.book_page,
    book_page_end: c.book_page_end,
    pdf_page: c.pdf_page,
  });
  if (out === c.expected) {
    passed += 1;
  } else {
    failures.push(`\n  [${c.name}]\n    期望: ${c.expected}\n    实际: ${out}`);
  }
}

console.log(`citation 渲染：${passed}/${data.cases.length} 通过`);

// 内置格式存在性
const ids = new Set(BUILTIN_FORMATS.map(f => f.id));
if (!(ids.has('gbt7714') && ids.has('humanities_2024') && ids.has('law_2025'))) {
  failures.push('\n  内置格式 id 不齐全');
}
if (getBuiltinTemplate('nonexistent_id') !== null) {
  failures.push('\n  getBuiltinTemplate("nonexistent_id") 应返回 null');
}

if (failures.length) {
  console.error('失败:' + failures.join(''));
  process.exit(1);
}
console.log('全部通过');
