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

// —— 反推算法测试 ——
const { inferTemplateFromSample } = window.xdFormats;

const inferCases = [
  {
    name: '历史研究 — 全字段',
    refMeta: { author: '任继愈', title: '中国哲学发展史（先秦卷）', place: '北京', publisher: '人民出版社', year: '1983' },
    sample: '任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。',
    page: 25,
    expectedTemplate: '{author}主编：《{title}》，{place}：{publisher}，{year}年，第{page}页。',
  },
  {
    name: 'GB/T 7714 — 标准',
    refMeta: { author: '胡适', title: '胡适日记全编', doc_type: 'M', place: '合肥', publisher: '安徽教育出版社', year: '2001' },
    sample: '胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001: 25.',
    page: 25,
    expectedTemplate: '{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.',
  },
  {
    name: '长值优先 — 北京 vs 北京大学出版社',
    refMeta: { author: '汤一介', title: '中国儒学史', place: '北京', publisher: '北京大学出版社', year: '2011' },
    sample: '汤一介：《中国儒学史》，北京：北京大学出版社，2011年，第10页。',
    page: 10,
    expectedTemplate: '{author}：《{title}》，{place}：{publisher}，{year}年，第{page}页。',
  },
];

let inferPassed = 0;
const inferFailures = [];
for (const c of inferCases) {
  const t = inferTemplateFromSample({
    refMeta: c.refMeta, sample: c.sample, refPage: c.page,
  });
  if (t === c.expectedTemplate) {
    inferPassed += 1;
  } else {
    inferFailures.push(`\n  [${c.name}]\n    期望: ${c.expectedTemplate}\n    实际: ${t}`);
  }
}
console.log(`样例反推：${inferPassed}/${inferCases.length} 通过`);
if (inferFailures.length) {
  console.error('样例反推失败:' + inferFailures.join(''));
  process.exit(1);
}

if (failures.length) {
  console.error('失败:' + failures.join(''));
  process.exit(1);
}
console.log('全部通过');
