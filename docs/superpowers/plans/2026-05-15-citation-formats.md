# 多引用格式支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为网页版添加 3 种内置引用格式（GB/T 7714 / 历史研究体例 / 法学引注手册 2025），支持全局选择 + 卡片级临时切换 + 用户自定义（4 条创建路径），并扩展智能识别支持新字段。

**Architecture:** 模板引擎双端实现：Python（`citation.py`）做扫描/查询的统一渲染；JS（`formats.js`）做卡片级 chip 切换和编辑器实时预览，零 Pyodide 往返。内置 3 种格式以模板字符串硬编码在 `pysrc/formats.py` 和 `formats.js`；用户/已修改的格式存 IndexedDB。共享 JSON 测试用例锁定两端一致。

**Tech Stack:** Python（Pyodide）+ Vanilla JS + IndexedDB；Service Worker 缓存；Node + `unittest` 测试。

**Spec:** [`docs/superpowers/specs/2026-05-15-citation-formats-design.md`](../specs/2026-05-15-citation-formats-design.md)

**实施分阶段：**
- 阶段 1（任务 1.x）：数据模型 + 模板引擎双端 + 智能识别扩展 — 渲染管道走通，UI 上只多 4 个输入框
- 阶段 2（任务 2.x）：全局选择器 + 卡片 chip — 用户能切格式但还不能造新格式
- 阶段 3（任务 3.x）：格式管理 tab + 模板编辑器 + IndexedDB CRUD
- 阶段 4（任务 4.x）：样例反推 + JSON 导入导出

每阶段结束时项目处于可部署状态。

---

## 文件结构

### 新建
- `web/pysrc/formats.py` — 内置 3 种格式的模板字符串 + lookup helper
- `web/formats.js` — JS 镜像渲染器 + 内置 3 种格式镜像 + IndexedDB 接入
- `tests/citation_test_cases.json` — Python/JS 共享的测试用例
- `tests/test_citation.py` — Python 端 unittest（共用上面 JSON）
- `tests/citation_test.mjs` — JS 端 Node 测试（共用上面 JSON）

### 修改
- `web/pysrc/citation.py` — 改造为模板引擎（保留 `format_citation` 旧入口做向后兼容封装）
- `web/pysrc/web_api.py` — `lookup_quote` / `scan_document` 新增 `format_id` + `template` 参数；新增 `render_citation` 工具入口
- `web/app.js` — 多处：
  - `parseBookMetadata`（约第 1100-1500 行）：暴露 role/edition；新增 country/translator 检测
  - `editBookMeta`（约第 1471 行）：弹窗加 4 个新输入框
  - `getBooksMeta`（在 db.js 第 243 行）：返回值包含 4 个新字段
  - `dbHelpers.getBooksForUI`（在 db.js 第 209 行）：同上
  - 新增：全局格式选择器 + 卡片 chip + "📐 引用格式" tab + 模板编辑器
- `web/db.js` — DB_VERSION 1→2；新增 formats store；`getBooksMeta` 包含新字段
- `web/index.html` — 新 tab + 全局选择器位置 + 4 个新书目字段
- `web/style.css` — 新组件样式
- `web/service-worker.js` — SELF_ASSETS 加 `formats.py`、`formats.js`；CACHE_NAME `xundian-v4` → `xundian-v5`
- `tests/parse_test.mjs` — 新增 4 字段的测试用例

### 不动
- `src/`、`frontend/`、`api.py`（桌面版，不在本次范围内）

---

## 阶段 1：数据模型 + 模板引擎双端 + 智能识别扩展

### 任务 1.1：共享测试用例 JSON

**Files:**
- Create: `tests/citation_test_cases.json`

- [ ] **Step 1: 创建测试用例 JSON 文件**

每条用例包含：`name`（描述）、`template`（模板字符串）、`meta`（书目元数据）、`book_page`、`book_page_end`、`pdf_page`、`expected`（期望输出字符串）。

```json
{
  "$comment": "Python 和 JS 端共用的引用渲染测试用例。两端 render 函数喂同样的输入必须出同样的输出。",
  "cases": [
    {
      "name": "GB/T 7714 全字段",
      "template": "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.",
      "meta": {"author": "胡适", "title": "胡适日记全编", "doc_type": "M", "place": "合肥", "publisher": "安徽教育出版社", "year": "2001"},
      "book_page": 25, "book_page_end": null, "pdf_page": null,
      "expected": "胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001: 25."
    },
    {
      "name": "GB/T 7714 跨页",
      "template": "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.",
      "meta": {"author": "胡适", "title": "胡适日记全编", "doc_type": "M", "place": "合肥", "publisher": "安徽教育出版社", "year": "2001"},
      "book_page": 11, "book_page_end": 12, "pdf_page": null,
      "expected": "胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001: 11-12."
    },
    {
      "name": "历史研究体例 主编+全字段",
      "template": "{?country [{}]}{author}{?role {}}：《{title}》，{?translator {}译，}{place}：{publisher}，{year}年，第{page}页。",
      "meta": {"author": "任继愈", "role": "主编", "country": "", "translator": "", "title": "中国哲学发展史（先秦卷）", "place": "北京", "publisher": "人民出版社", "year": "1983"},
      "book_page": 25, "book_page_end": null, "pdf_page": null,
      "expected": "任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。"
    },
    {
      "name": "历史研究体例 著（自动省略）",
      "template": "{?country [{}]}{author}{?role {}}：《{title}》，{?translator {}译，}{place}：{publisher}，{year}年，第{page}页。",
      "meta": {"author": "赵景深", "role": "著", "country": "", "translator": "", "title": "文坛忆旧", "place": "上海", "publisher": "北新书局", "year": "1948"},
      "book_page": 43, "book_page_end": null, "pdf_page": null,
      "expected": "赵景深：《文坛忆旧》，上海：北新书局，1948年，第43页。"
    },
    {
      "name": "历史研究体例 译著（国别+译者）",
      "template": "{?country [{}]}{author}{?role {}}：《{title}》，{?translator {}译，}{place}：{publisher}，{year}年，第{page}页。",
      "meta": {"author": "实藤惠秀", "role": "", "country": "日", "translator": "谭汝谦、林启彦", "title": "中国人留学日本史", "place": "香港", "publisher": "中文大学出版社", "year": "1982"},
      "book_page": 11, "book_page_end": 12, "pdf_page": null,
      "expected": "[日]实藤惠秀：《中国人留学日本史》，谭汝谦、林启彦译，香港：中文大学出版社，1982年，第11-12页。"
    },
    {
      "name": "法学手册 2025 主编+全字段",
      "template": "{?country [{}]}{author}{?role {}}：《{title}》{?edition （第{}版）}，{?translator {}译，}{publisher}{year}年版，第{page}页。",
      "meta": {"author": "任继愈", "role": "主编", "country": "", "translator": "", "edition": "", "title": "中国哲学发展史（先秦卷）", "publisher": "人民出版社", "year": "1983"},
      "book_page": 25, "book_page_end": null, "pdf_page": null,
      "expected": "任继愈主编：《中国哲学发展史（先秦卷）》，人民出版社1983年版，第25页。"
    },
    {
      "name": "法学手册 2025 带版次",
      "template": "{?country [{}]}{author}{?role {}}：《{title}》{?edition （第{}版）}，{?translator {}译，}{publisher}{year}年版，第{page}页。",
      "meta": {"author": "黄仁宇", "role": "著", "country": "", "translator": "", "edition": "2", "title": "万历十五年", "publisher": "中华书局", "year": "2007"},
      "book_page": 1, "book_page_end": null, "pdf_page": null,
      "expected": "黄仁宇：《万历十五年》（第2版），中华书局2007年版，第1页。"
    },
    {
      "name": "必填字段缺失出占位",
      "template": "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.",
      "meta": {"author": "", "title": "", "doc_type": "M", "place": "", "publisher": "", "year": ""},
      "book_page": 7, "book_page_end": null, "pdf_page": null,
      "expected": "〔作者待补〕. 〔书名待补〕[M]. 〔出版地待补〕: 〔出版社待补〕, 〔出版年待补〕: 7."
    },
    {
      "name": "book_page 缺 + pdf_page 兜底",
      "template": "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.",
      "meta": {"author": "胡适", "title": "胡适日记", "doc_type": "M", "place": "合肥", "publisher": "安徽教育出版社", "year": "2001"},
      "book_page": null, "book_page_end": null, "pdf_page": 42,
      "expected": "胡适. 胡适日记[M]. 合肥: 安徽教育出版社, 2001: PDF第42页（书内页码待标定）."
    },
    {
      "name": "页码全空",
      "template": "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.",
      "meta": {"author": "胡适", "title": "胡适日记", "doc_type": "M", "place": "合肥", "publisher": "安徽教育出版社", "year": "2001"},
      "book_page": null, "book_page_end": null, "pdf_page": null,
      "expected": "胡适. 胡适日记[M]. 合肥: 安徽教育出版社, 2001: 页码待补."
    }
  ]
}
```

- [ ] **Step 2: 提交**

```bash
git add tests/citation_test_cases.json
git commit -m "test(citation): 共享 Python/JS 测试用例（10 例覆盖 3 内置格式 + 边界）"
```

---

### 任务 1.2：Python 端 `citation.py` 模板引擎

**Files:**
- Modify: `web/pysrc/citation.py`（完全重写，保留 `format_citation` 旧入口做兼容封装）
- Create: `tests/test_citation.py`

- [ ] **Step 1: 写失败的测试**

新建 `tests/test_citation.py`：

```python
"""共享 JSON 用例驱动的 Python 端 citation 渲染测试。"""
import json
import os
import sys
import unittest

# 把 web/ 加进 sys.path，让 pysrc 可被 import
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "web"))

from pysrc.citation import render_citation  # noqa: E402


FIXTURE = os.path.join(ROOT, "tests", "citation_test_cases.json")


class CitationRendererTest(unittest.TestCase):
    def test_all_cases(self):
        with open(FIXTURE, "r", encoding="utf-8") as f:
            data = json.load(f)
        failures = []
        for case in data["cases"]:
            out = render_citation(
                template=case["template"],
                meta=case["meta"],
                book_page=case.get("book_page"),
                book_page_end=case.get("book_page_end"),
                pdf_page=case.get("pdf_page"),
            )
            if out != case["expected"]:
                failures.append(
                    f"\n  [{case['name']}]\n    期望: {case['expected']}\n    实际: {out}"
                )
        if failures:
            self.fail("有用例失败：" + "".join(failures))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试，验证它失败**

```bash
cd "E:/PycharmProjects/PythonProject/CitationLookup-web/.claude/worktrees/determined-swirles-31f395"
python -m unittest tests.test_citation -v
```

期望：`ImportError: cannot import name 'render_citation'`（因为 `citation.py` 里还没这个函数）

- [ ] **Step 3: 写 `render_citation` 实现**

完全重写 `web/pysrc/citation.py`：

```python
"""引文渲染 — 模板引擎。

模板语法（v1）：
    {field}                必填占位；字段为空则输出"〔X待补〕"占位文
    {?field literal{}literal}   可选段；字段非空时输出整段（{}=字段值），空则消失
其它字符 = 字面。

合法字段（11 个）：
    author role country title translator edition doc_type place publisher year page

规则：
    - role == "著" 或为空 → 渲染为空（{?role …} 段被吃掉）
    - {page} 智能渲染：单页 "25"；跨页 "11-12"；book_page 缺则 pdf_page 兜底；全空 → "页码待补"
    - 不支持嵌套 {?…{?…}}
    - 不支持 { } 转义
"""
from __future__ import annotations

from typing import Optional


VALID_FIELDS = frozenset([
    "author", "role", "country", "title", "translator", "edition",
    "doc_type", "place", "publisher", "year", "page",
])

# 必填字段（{field} 空时显示占位文），运行时字段 page 单独处理
PLACEHOLDER = {
    "author": "〔作者待补〕",
    "title": "〔书名待补〕",
    "place": "〔出版地待补〕",
    "publisher": "〔出版社待补〕",
    "year": "〔出版年待补〕",
    "doc_type": "M",
}


class TemplateSyntaxError(ValueError):
    """模板语法错误（保存前会被编辑器拦下）。"""


def _format_page(book_page, book_page_end, pdf_page) -> str:
    if book_page is not None:
        if book_page_end is not None and book_page_end != book_page:
            return f"{book_page}-{book_page_end}"
        return str(book_page)
    if pdf_page is not None:
        return f"PDF第{pdf_page}页（书内页码待标定）"
    return "页码待补"


def _get_field(field: str, meta: dict, book_page, book_page_end, pdf_page) -> str:
    """取字段值。role=="著" 视为空。page 用智能渲染。"""
    if field == "page":
        return _format_page(book_page, book_page_end, pdf_page)
    val = meta.get(field, "")
    val = "" if val is None else str(val)
    if field == "role" and val == "著":
        return ""
    return val


def _render_required(field: str, value: str) -> str:
    """{field} 必填占位。空 → 占位文；非空 → 值。"""
    if value:
        return value
    return PLACEHOLDER.get(field, "")


def _parse(template: str):
    """模板 → token 数组。token = ('lit', s) | ('req', field) | ('opt', field, prefix, suffix)。

    抛 TemplateSyntaxError 表示模板有问题。
    """
    tokens = []
    i = 0
    n = len(template)
    while i < n:
        c = template[i]
        if c == "}":
            raise TemplateSyntaxError(f"位置 {i}：单独的 }} 无对应 {{")
        if c != "{":
            j = i
            while j < n and template[j] != "{" and template[j] != "}":
                j += 1
            tokens.append(("lit", template[i:j]))
            i = j
            continue
        # 进入 { ... }
        end = template.find("}", i + 1)
        if end < 0:
            raise TemplateSyntaxError(f"位置 {i}：{{ 没有对应的 }}")
        inner = template[i + 1:end]
        if not inner:
            raise TemplateSyntaxError(f"位置 {i}：空 {{}} 不允许")
        if inner[0] == "?":
            # 可选段 ?field literal{}literal
            rest = inner[1:].lstrip()
            sp = rest.find(" ")
            if sp < 0:
                raise TemplateSyntaxError(f"位置 {i}：可选段缺少字段名与文本分隔空格")
            field = rest[:sp]
            body = rest[sp + 1:]
            if field not in VALID_FIELDS:
                raise TemplateSyntaxError(f"位置 {i}：未知字段 {field!r}")
            slot = body.find("{}")
            if slot < 0:
                raise TemplateSyntaxError(f"位置 {i}：可选段内必须含一个 {{}} 占位")
            if body.find("{}", slot + 2) >= 0:
                raise TemplateSyntaxError(f"位置 {i}：可选段内只能含一个 {{}} 占位")
            if "{" in body.replace("{}", "") or "}" in body.replace("{}", ""):
                raise TemplateSyntaxError(f"位置 {i}：可选段内不允许嵌套 {{ }}")
            prefix = body[:slot]
            suffix = body[slot + 2:]
            tokens.append(("opt", field, prefix, suffix))
        else:
            field = inner
            if field not in VALID_FIELDS:
                raise TemplateSyntaxError(f"位置 {i}：未知字段 {field!r}")
            tokens.append(("req", field))
        i = end + 1
    return tokens


def render_citation(
    *,
    template: str,
    meta: dict,
    book_page: Optional[int] = None,
    book_page_end: Optional[int] = None,
    pdf_page: Optional[int] = None,
) -> str:
    """根据模板和元数据渲染一条引文字符串。"""
    tokens = _parse(template)
    out_parts = []
    for tok in tokens:
        if tok[0] == "lit":
            out_parts.append(tok[1])
        elif tok[0] == "req":
            field = tok[1]
            val = _get_field(field, meta, book_page, book_page_end, pdf_page)
            out_parts.append(_render_required(field, val))
        else:  # opt
            _, field, prefix, suffix = tok
            val = _get_field(field, meta, book_page, book_page_end, pdf_page)
            if val:
                out_parts.append(prefix + val + suffix)
    return "".join(out_parts)


# —— 向后兼容封装 ——
# 老代码 `from .citation import format_citation` 仍可用，
# 内部转调 render_citation 以 GB/T 7714 模板。

GBT_7714_TEMPLATE = "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}."


def format_citation(
    *,
    author: str,
    title: str,
    doc_type: str = "M",
    place: str = "XX",
    publisher: str = "XX出版社",
    year: str = "0000",
    book_page: Optional[int] = None,
    pdf_page: Optional[int] = None,
) -> str:
    """[已弃用，仅向后兼容] GB/T 7714 渲染。新代码请用 render_citation。"""
    return render_citation(
        template=GBT_7714_TEMPLATE,
        meta={
            "author": author, "title": title, "doc_type": doc_type,
            "place": place, "publisher": publisher, "year": year,
        },
        book_page=book_page,
        pdf_page=pdf_page,
    )
```

- [ ] **Step 4: 跑测试，验证通过**

```bash
python -m unittest tests.test_citation -v
```

期望：`OK`。如果某个用例失败，仔细对比 `期望` vs `实际`，调 `render_citation`。

- [ ] **Step 5: 提交**

```bash
git add web/pysrc/citation.py tests/test_citation.py
git commit -m "feat(citation): 模板引擎 + render_citation；保留 format_citation 兼容"
```

---

### 任务 1.3：Python 端 `formats.py` 内置 3 种格式

**Files:**
- Create: `web/pysrc/formats.py`
- Modify: `tests/test_citation.py`

- [ ] **Step 1: 写失败的测试**

在 `tests/test_citation.py` 末尾追加：

```python
from pysrc.formats import BUILTIN_FORMATS, get_builtin_template  # noqa: E402


class BuiltinFormatsTest(unittest.TestCase):
    def test_three_builtins_present(self):
        ids = {f["id"] for f in BUILTIN_FORMATS}
        self.assertEqual(ids, {"gbt7714", "humanities_2024", "law_2025"})

    def test_get_builtin_template_returns_string(self):
        t = get_builtin_template("gbt7714")
        self.assertIsInstance(t, str)
        self.assertIn("{author}", t)

    def test_get_builtin_template_unknown_returns_none(self):
        self.assertIsNone(get_builtin_template("nonexistent_id"))

    def test_builtin_humanities_renders_correctly(self):
        template = get_builtin_template("humanities_2024")
        out = render_citation(
            template=template,
            meta={"author": "任继愈", "role": "主编", "country": "", "translator": "",
                  "title": "中国哲学发展史（先秦卷）", "place": "北京",
                  "publisher": "人民出版社", "year": "1983"},
            book_page=25,
        )
        self.assertEqual(
            out,
            "任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。"
        )
```

运行：

```bash
python -m unittest tests.test_citation.BuiltinFormatsTest -v
```

期望：`ModuleNotFoundError: No module named 'pysrc.formats'`

- [ ] **Step 2: 写 `web/pysrc/formats.py` 实现**

```python
"""内置引用格式模板。仅 3 个，硬编码，不依赖运行时存储。

用户和"已修改的内置"都存 IndexedDB；运行时由 JS 端负责合并查询。
Python 端只懂内置 3 个，用户格式调用必须由 JS 传 template 字符串过来（见 web_api.render_citation）。
"""
from __future__ import annotations

from typing import Optional


BUILTIN_FORMATS = [
    {
        "id": "gbt7714",
        "name": "GB/T 7714—2015",
        "category": "builtin",
        "template": "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.",
    },
    {
        "id": "humanities_2024",
        "name": "历史研究体例",
        "category": "builtin",
        "template": "{?country [{}]}{author}{?role {}}：《{title}》，{?translator {}译，}{place}：{publisher}，{year}年，第{page}页。",
    },
    {
        "id": "law_2025",
        "name": "法学引注手册 2025",
        "category": "builtin",
        "template": "{?country [{}]}{author}{?role {}}：《{title}》{?edition （第{}版）}，{?translator {}译，}{publisher}{year}年版，第{page}页。",
    },
]

DEFAULT_FORMAT_ID = "gbt7714"


def get_builtin_template(format_id: str) -> Optional[str]:
    """返回内置格式的模板字符串；未知 id 返回 None。"""
    for f in BUILTIN_FORMATS:
        if f["id"] == format_id:
            return f["template"]
    return None
```

- [ ] **Step 3: 跑测试，验证通过**

```bash
python -m unittest tests.test_citation -v
```

期望：`OK`，所有用例通过。

- [ ] **Step 4: 提交**

```bash
git add web/pysrc/formats.py tests/test_citation.py
git commit -m "feat(formats): 内置 3 种格式（GB/T 7714 / 历史研究 / 法学手册）"
```

---

### 任务 1.4：JS 端 `formats.js` 镜像渲染器

**Files:**
- Create: `web/formats.js`
- Create: `tests/citation_test.mjs`

- [ ] **Step 1: 写失败的 JS 测试**

新建 `tests/citation_test.mjs`：

```javascript
// citation 渲染 — JS 端测试（与 Python 共用 tests/citation_test_cases.json）
// 跑法：node tests/citation_test.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 直接 import web/formats.js — 它会绑到 globalThis.window，需要先 stub
globalThis.window = globalThis.window || {};
await import(path.join(ROOT, 'web', 'formats.js'));

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
```

运行：

```bash
node tests/citation_test.mjs
```

期望：`Cannot find module 'web/formats.js'` 或类似失败。

- [ ] **Step 2: 写 `web/formats.js` 实现**

```javascript
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
    const end = template.indexOf('}', i + 1);
    if (end < 0) throw new TemplateSyntaxError(i, '{ 没有对应的 }');
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
      const cleaned = body.replace(/\{\}/g, '');
      if (cleaned.includes('{') || cleaned.includes('}')) {
        throw new TemplateSyntaxError(i, '可选段内不允许嵌套 { }');
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


// 暴露给浏览器和测试（globalThis.window 在 Node 测试里被预先 stub）
window.xdFormats = {
  renderCitation,
  parseTemplate,
  TemplateSyntaxError,
  BUILTIN_FORMATS,
  DEFAULT_FORMAT_ID,
  getBuiltinTemplate,
  VALID_FIELDS: [...VALID_FIELDS],
};
```

- [ ] **Step 3: 跑测试，验证通过**

```bash
node tests/citation_test.mjs
```

期望：`citation 渲染：10/10 通过` + `全部通过`。

- [ ] **Step 4: 提交**

```bash
git add web/formats.js tests/citation_test.mjs
git commit -m "feat(formats): JS 端渲染器 + 内置 3 格式镜像，与 Python 共享测试用例"
```

---

### 任务 1.5：扩展 `db.js` 元数据字段

**Files:**
- Modify: `web/db.js`（行约 209-256）

- [ ] **Step 1: 修改 `dbHelpers.getBooksForUI`**

打开 `web/db.js`，把 `getBooksForUI` 的返回对象（约第 220 行起）改为包含新增 4 字段：

```javascript
// 替换 web/db.js 中 dbHelpers.getBooksForUI 的 return map 体（约第 219-240 行）
return books.map((b) => {
  const c = cacheBy.get(b.file_id);
  return {
    file_id: b.file_id,
    pdf_path: b.handle ? b.handle.name : '(浏览器内部)',
    handle_name: b.handle ? b.handle.name : '',
    author: b.author || 'XX',
    title: b.title || (b.file_id || '').replace(/\.pdf$/i, ''),
    doc_type: b.doc_type || 'M',
    place: b.place || 'XX',
    publisher: b.publisher || 'XX出版社',
    year: b.year || '0000',
    // 新增 4 字段（默认空串，按"留空"语义）
    role: b.role || '',
    country: b.country || '',
    translator: b.translator || '',
    edition: b.edition || '',
    page_offset: b.page_offset != null ? b.page_offset : null,
    folder: b.folder || null,
    exists: !!b.handle,
    parsed: !!c,
    page_count: c ? c.page_count : 0,
    low_quality_pages: c ? c.low_quality_pages : 0,
  };
});
```

- [ ] **Step 2: 修改 `dbHelpers.getBooksMeta`**

把 `getBooksMeta` 返回对象（约第 246-256 行）改为包含 4 字段：

```javascript
// 替换 web/db.js 中 dbHelpers.getBooksMeta 的 for 循环体
for (const b of books) {
  out[b.file_id] = {
    author: b.author || 'XX',
    title: b.title || (b.file_id || '').replace(/\.pdf$/i, ''),
    doc_type: b.doc_type || 'M',
    place: b.place || 'XX',
    publisher: b.publisher || 'XX出版社',
    year: b.year || '0000',
    // 新增 4 字段
    role: b.role || '',
    country: b.country || '',
    translator: b.translator || '',
    edition: b.edition || '',
  };
}
```

- [ ] **Step 3: 提交**

```bash
git add web/db.js
git commit -m "feat(db): 书目元数据扩展 4 字段（role/country/translator/edition）"
```

---

### 任务 1.6：扩展 `web/app.js` 中的 `editBookMeta` 弹窗

**Files:**
- Modify: `web/app.js`（约第 1471-1520 行）

- [ ] **Step 1: 修改弹窗 HTML 与 onOk 返回值**

找到 `editBookMeta` 函数（约第 1471 行），在"作者"输入框后插入 4 个新字段，并扩展 `onOk` 返回的对象：

```javascript
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
```

- [ ] **Step 2: 加 `.hint-inline` 样式**

打开 `web/style.css`，在文件末尾追加：

```css
/* 编辑书目弹窗里的字段说明文字 */
.hint-inline {
  color: #888;
  font-size: 11px;
  font-weight: normal;
  margin-left: 4px;
}
```

- [ ] **Step 3: 手工验证**

```bash
# 启动 http 服务（如果还没有）
python -m http.server 8080 --directory web
```

打开 `http://localhost:8080`，点任一本书的"编辑"，确认弹窗里多了 4 个新字段；保存后刷新页面，确认值保留。

- [ ] **Step 4: 提交**

```bash
git add web/app.js web/style.css
git commit -m "feat(book-meta): 编辑弹窗加 4 新字段（role/country/translator/edition）"
```

---

### 任务 1.7：扩展 `parseBookMetadata` — 暴露 role + edition

**Files:**
- Modify: `web/app.js`（`parseBookMetadata` 函数，约第 1100 行起）
- Modify: `tests/parse_test.mjs`

- [ ] **Step 1: 在 `tests/parse_test.mjs` 末尾加新用例**

找到 CASES 数组末尾，在闭 `]` 前加：

```javascript
  // ========== 新增字段测试 ==========
  {
    name: '历史研究体例 — 暴露 role=主编',
    input: '任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。',
    expect: { author: '任继愈', role: '主编', title: '中国哲学发展史（先秦卷）', place: '北京', publisher: '人民出版社', year: '1983' },
  },
  {
    name: '历史研究体例 — 著（自动归一化为空）',
    input: '赵景深著：《文坛忆旧》，上海：北新书局，1948年，第43页。',
    expect: { author: '赵景深', role: '', title: '文坛忆旧', place: '上海', publisher: '北新书局', year: '1948' },
  },
  {
    name: '法学手册 — edition 数字',
    input: '黄仁宇：《万历十五年》（第2版），中华书局2007年版，第1页。',
    expect: { author: '黄仁宇', title: '万历十五年', edition: '2', publisher: '中华书局', year: '2007' },
  },
  {
    name: '修订版 → edition="修订"',
    input: '黄仁宇. 万历十五年[M]. 修订版. 北京: 中华书局, 2007.',
    expect: { author: '黄仁宇', title: '万历十五年', edition: '修订', place: '北京', publisher: '中华书局', year: '2007' },
  },
```

- [ ] **Step 2: 检查 marker 范围**

`parse_test.mjs` 第 24-25 行用 `'// 常见出版地城市表'` 和 `'\nasync function editBookMeta'` 作为代码切片 marker。确认两个 marker 仍在 app.js 里且包住 `parseBookMetadata` 整段：

```bash
grep -n "// 常见出版地城市表\|^async function editBookMeta" web/app.js
```

期望：能看到两行，城市表在前，editBookMeta 在后。

- [ ] **Step 3: 跑测试，确认新用例失败**

```bash
node tests/parse_test.mjs
```

期望：旧用例仍通过；新加的 4 条会因 role/edition 未暴露而失败。

- [ ] **Step 4: 改造 `parseBookMetadata` 初始化结构**

在 `web/app.js` 中找到 `function parseBookMetadata(input)` 内的 `const out = {` 声明（约第 1101 行），把它替换为：

```javascript
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
```

- [ ] **Step 5: 让 edition 暴露出来**

在 `parseBookMetadata` 中找到第 7 步（"剥离版本标记"，约第 1287 行的 `workingS = workingS.replace(/(第\s*\d+\s*版|...)/g, ...)`），改为同时把数字/关键词抽出来给 `out.edition`：

```javascript
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
```

- [ ] **Step 6: 暴露 role**

在 `parseBookMetadata` 末尾"13. 收尾清理"之前（约第 1461 行）增加一步 12.5：

```javascript
  // 12.5 暴露 role：检测 author 末尾的责任方式 marker，剥下来写到 out.role
  //      只在 author 已确定时做。"著"/"撰" 归一化为空（"著"按 spec §6.2 自动省略）
  if (out.author) {
    const roleRe = /(编著|编译|主编|选编|编辑|编校|编)$/;
    const rm = out.author.match(roleRe);
    if (rm) {
      const marker = rm[1];
      out.author = out.author.slice(0, -marker.length).trim();
      out.role = marker;
    } else {
      const omitRe = /(著|撰)$/;
      const om = out.author.match(omitRe);
      if (om) {
        out.author = out.author.slice(0, -om[1].length).trim();
        out.role = '';  // "著"/"撰" → 空
      }
    }
  }
```

- [ ] **Step 7: 跑测试，验证通过**

```bash
node tests/parse_test.mjs
```

期望：全部用例通过（原有 + 新加 4 条）。如有失败，对照"期望 vs 实际"调整。

- [ ] **Step 8: 提交**

```bash
git add web/app.js tests/parse_test.mjs
git commit -m "feat(parse): 暴露 role + edition 字段（之前已识别但被丢弃）"
```

---

### 任务 1.8：扩展 `parseBookMetadata` — 新增 country + translator 检测

**Files:**
- Modify: `web/app.js`
- Modify: `tests/parse_test.mjs`

- [ ] **Step 1: 在 `tests/parse_test.mjs` 末尾加更多用例**

```javascript
  // ========== country / translator ==========
  {
    name: 'country [日] 前缀',
    input: '[日]实藤惠秀：《中国人留学日本史》，谭汝谦、林启彦译，香港：中文大学出版社，1982年，第11-12页。',
    expect: { country: '日', author: '实藤惠秀', translator: '谭汝谦、林启彦', title: '中国人留学日本史', place: '香港', publisher: '中文大学出版社', year: '1982' },
  },
  {
    name: 'country [美] + 全角 ［］',
    input: '［美］斐迪南·滕尼斯：《共同体与社会》，林荣远译，北京：商务印书馆，1999年，第4页。',
    expect: { country: '美', author: '斐迪南·滕尼斯', translator: '林荣远', title: '共同体与社会', place: '北京', publisher: '商务印书馆', year: '1999' },
  },
  {
    name: 'translator — 单译者',
    input: '蒙森：《罗马史》，李稼年译，北京：商务印书馆，2014年，第3页。',
    expect: { author: '蒙森', translator: '李稼年', title: '罗马史', place: '北京', publisher: '商务印书馆', year: '2014' },
  },
  {
    name: '无 country：[M] 标签不应被当成 country',
    input: '胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001.',
    expect: { country: '', author: '胡适', title: '胡适日记全编', doc_type: 'M' },
  },
```

- [ ] **Step 2: 跑测试，确认新用例失败**

```bash
node tests/parse_test.mjs
```

期望：country/translator 用例失败。

- [ ] **Step 3: 在 `parseBookMetadata` 步骤 2（[M] 检测）之后加 country 检测**

找到 step 2（约第 1119-1125 行）末尾，紧接其后加 step 2.5：

```javascript
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
```

- [ ] **Step 4: 在 step 12.5（任务 1.7 加的）之后加 translator 检测，并加 author 去重保护**

替换 step 12.5 整段，新增 step 12.6：

```javascript
  // 12.5 暴露 role：检测 author 末尾的责任方式 marker，剥下来写到 out.role
  //      只在 author 已确定时做。"著"/"撰" 归一化为空。
  //      注意：若 author marker 是"译"，本人就是译者；保留 author 即可（不写到 translator）。
  let authorIsTranslator = false;
  if (out.author) {
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
```

- [ ] **Step 5: 跑测试，验证通过**

```bash
node tests/parse_test.mjs
```

期望：全部用例通过。如失败请贴出具体失败 case 名，对照 spec §10.2 调整正则。

- [ ] **Step 6: 提交**

```bash
git add web/app.js tests/parse_test.mjs
git commit -m "feat(parse): 新增 country 和 translator 自动识别"
```

---

### 任务 1.9：扩展 `m-smart-btn` 把新字段写回输入框

**Files:**
- Modify: `web/app.js`（处理 `m-smart-btn` 点击的事件，约第 1967 行起）

- [ ] **Step 1: 找到 `m-smart-btn` click 处理逻辑**

```bash
grep -n "m-smart-btn\|m-smart-input\|'识别' " web/app.js
```

定位到大约第 1967-2050 行的事件处理代码。

- [ ] **Step 2: 修改"写回输入框"那段**

找到代码里读取 `parseBookMetadata` 结果后依次写回 `$('#m-author').value = ...` 那段，扩展为同步写入新 4 字段。把对应代码块整体替换为：

```javascript
  // 把识别结果填到对应 input；总是覆盖（用户已确认想用智能识别）
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v || '';
  };
  setVal('m-author', parsed.author);
  setVal('m-role', parsed.role);
  setVal('m-country', parsed.country);
  setVal('m-title', parsed.title);
  setVal('m-translator', parsed.translator);
  setVal('m-edition', parsed.edition);
  setVal('m-doctype', parsed.doc_type || 'M');
  setVal('m-place', parsed.place);
  setVal('m-pub', parsed.publisher);
  setVal('m-year', parsed.year);
```

（如果原代码用的是不同的 setter 风格，保持风格，把 6 个新 setter 调用合进去即可。）

- [ ] **Step 3: 修改"已识别 N/6 个字段"提示语**

找到 `已识别 ${recognizedCount}/6 个字段` 那行（约第 2020 行），把分母改成 10：

```javascript
    // 计数：6 个原字段 + 4 个新字段
    const fieldKeys = ['author', 'role', 'country', 'title', 'translator', 'edition', 'doc_type', 'place', 'publisher', 'year'];
    const recognizedCount = fieldKeys.filter(k => parsed[k] && String(parsed[k]).trim()).length;
    lines.push(`<div class="smart-parse-status-line ok">已识别 ${recognizedCount}/${fieldKeys.length} 个字段</div>`);
```

（注意：把原有的 recognizedCount 计算块整体替换为上面 3 行。）

- [ ] **Step 4: 手工验证**

```bash
python -m http.server 8080 --directory web
```

打开浏览器，点编辑书目，在智能识别框里依次粘贴 3 条不同格式的引文：

1. `胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001.`
2. `任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。`
3. `[日]实藤惠秀：《中国人留学日本史》，谭汝谦、林启彦译，香港：中文大学出版社，1982年，第11-12页。`

每条按"识别并填写"后确认：① 新字段（责任方式/国别/译者/版次）也被填上 ② 状态提示显示 `已识别 N/10`。

- [ ] **Step 5: 提交**

```bash
git add web/app.js
git commit -m "feat(parse-ui): 智能识别按钮把 role/country/translator/edition 写回弹窗"
```

---

### 任务 1.10：`web_api.py` 接受 `format_id` + `template`

**Files:**
- Modify: `web/pysrc/web_api.py`

- [ ] **Step 1: 添加 `render_citation` 顶层工具入口**

在 `web/pysrc/web_api.py` 顶部 import 区下方（紧跟 `from .citation import format_citation`），添加：

```python
from .citation import format_citation, render_citation as _render_citation
from .formats import get_builtin_template, DEFAULT_FORMAT_ID


def _resolve_template(format_id, template):
    """解析模板：用户传入的 template 优先；否则 format_id 内置查；都没有 → 默认。"""
    if template:
        return template
    if format_id:
        t = get_builtin_template(format_id)
        if t is not None:
            return t
    return get_builtin_template(DEFAULT_FORMAT_ID)
```

- [ ] **Step 2: 改造 `_format_cand_citation` 接受 template**

替换 `_format_cand_citation` 函数（约第 87 行）：

```python
def _format_cand_citation(
    cand: MatchCandidate,
    meta_dict: Optional[Dict[str, dict]],
    template: str,
) -> str:
    """根据候选所在书的 meta 拼一条「出处建议」给前端候选卡片用。
    meta_dict 缺失时返回空串（前端按"没有 citation"渲染）。"""
    if meta_dict is None:
        return ""
    m = meta_dict.get(cand.book_file) or {}
    # 注意：补齐渲染所需字段（含新 4 字段），缺失置空
    meta = {
        "author": m.get("author", "XX"),
        "role": m.get("role", ""),
        "country": m.get("country", ""),
        "translator": m.get("translator", ""),
        "edition": m.get("edition", ""),
        "title": m.get("title", cand.book_file),
        "doc_type": m.get("doc_type", "M"),
        "place": m.get("place", "XX"),
        "publisher": m.get("publisher", "XX出版社"),
        "year": m.get("year", "0000"),
    }
    return _render_citation(
        template=template,
        meta=meta,
        book_page=cand.book_page,
        book_page_end=cand.book_page_end,
        pdf_page=cand.pdf_page,
    )
```

- [ ] **Step 3: 改造 `_quote_result_to_dict` 接受 template**

替换 `_quote_result_to_dict`：

```python
def _quote_result_to_dict(
    quote: Quote,
    result: MatchResult,
    citation: str,
    threshold: float,
    meta_dict: Optional[Dict[str, dict]] = None,
    template: str = "",
) -> dict:
    if not result.candidates:
        status = "miss"
    elif result.best.score >= max(threshold, 0.95):
        status = "hit"
    elif result.best.score >= threshold:
        status = "low"
    else:
        status = "miss"
    cand_dicts = []
    for c in result.candidates:
        d = _candidate_to_dict(c)
        d["citation"] = _format_cand_citation(c, meta_dict, template)
        cand_dicts.append(d)
    return {
        "quote_id": quote.quote_id,
        "text": quote.text,
        "context_before": quote.context_before,
        "context_after": quote.context_after,
        "status": status,
        "citation": citation,
        "candidates": cand_dicts,
    }
```

- [ ] **Step 4: 改造 `scan_document` 签名与渲染调用**

替换 `scan_document` 的签名 + best 命中的 citation 拼装 + 调 `_quote_result_to_dict`：

```python
    async def scan_document(
        self, docx_bytes, books_data, books_meta,
        docx_name: str = "",
        format_id: Optional[str] = None,
        template: Optional[str] = None,
    ):
        """
        新增参数：
          format_id  — 内置格式 id（"gbt7714" / "humanities_2024" / "law_2025"）
          template   — 用户格式时由前端从 IndexedDB 取出后传过来；优先级高于 format_id
        都为 None 时回退默认 GB/T 7714。
        """
        resolved_template = _resolve_template(format_id, template)
        # …… 中间不变 ……
```

然后找到 `citation = format_citation(...)` 的调用（约第 314 行），替换为：

```python
            if mr.best is None:
                citation = "待人工确认"
            else:
                meta = meta_dict_clean.get(mr.best.book_file, {})
                meta_full = {
                    "author": meta.get("author", "XX"),
                    "role": meta.get("role", ""),
                    "country": meta.get("country", ""),
                    "translator": meta.get("translator", ""),
                    "edition": meta.get("edition", ""),
                    "title": meta.get("title", mr.best.book_file),
                    "doc_type": meta.get("doc_type", "M"),
                    "place": meta.get("place", "XX"),
                    "publisher": meta.get("publisher", "XX出版社"),
                    "year": meta.get("year", "0000"),
                }
                citation = _render_citation(
                    template=resolved_template,
                    meta=meta_full,
                    book_page=mr.best.book_page,
                    book_page_end=mr.best.book_page_end,
                    pdf_page=mr.best.pdf_page,
                )
            citations_for_export.append(citation)

            result_dict = _quote_result_to_dict(
                q, mr, citation, threshold, meta_dict_clean, resolved_template,
            )
```

- [ ] **Step 5: 改造 `lookup_quote` 签名与渲染调用**

同 step 4，对 `lookup_quote` 做相同改造。在函数签名（约第 374 行）加 `format_id` + `template` 参数；在 `citation = format_citation(...)` 处（约第 408 行）替换为：

```python
    def lookup_quote(
        self, quote: str, context_before: str, context_after: str,
        books_data, books_meta,
        format_id: Optional[str] = None,
        template: Optional[str] = None,
    ):
        resolved_template = _resolve_template(format_id, template)
        # ... 中间不变 ...

        if mr.best is None:
            citation = "待人工确认"
        else:
            meta = meta_dict_clean.get(mr.best.book_file, {})
            meta_full = {
                "author": meta.get("author", "XX"),
                "role": meta.get("role", ""),
                "country": meta.get("country", ""),
                "translator": meta.get("translator", ""),
                "edition": meta.get("edition", ""),
                "title": meta.get("title", mr.best.book_file),
                "doc_type": meta.get("doc_type", "M"),
                "place": meta.get("place", "XX"),
                "publisher": meta.get("publisher", "XX出版社"),
                "year": meta.get("year", "0000"),
            }
            citation = _render_citation(
                template=resolved_template,
                meta=meta_full,
                book_page=mr.best.book_page,
                book_page_end=mr.best.book_page_end,
                pdf_page=mr.best.pdf_page,
            )

        # 找到 _quote_result_to_dict 调用，传 resolved_template
        return {"quote": _quote_result_to_dict(
            fake, mr, citation, threshold, meta_dict_clean, resolved_template,
        )}
```

- [ ] **Step 6: 写测试验证向后兼容**

在 `tests/test_citation.py` 末尾追加：

```python
class WebApiBackwardCompatTest(unittest.TestCase):
    """验证不传 format_id/template 时仍按 GB/T 7714 渲染（旧调用兼容）。"""

    def test_format_citation_still_works(self):
        # citation.py 里的 format_citation 仍可用（旧代码用它）
        from pysrc.citation import format_citation
        out = format_citation(
            author="胡适", title="胡适日记", doc_type="M",
            place="合肥", publisher="安徽教育出版社", year="2001",
            book_page=25,
        )
        self.assertEqual(out, "胡适. 胡适日记[M]. 合肥: 安徽教育出版社, 2001: 25.")

    def test_resolve_template_falls_back_to_default(self):
        from pysrc.web_api import _resolve_template
        # 都不传 → 默认 GB/T
        t = _resolve_template(None, None)
        self.assertIn("{author}", t)
        self.assertIn("[{doc_type}]", t)

    def test_resolve_template_template_wins(self):
        from pysrc.web_api import _resolve_template
        t = _resolve_template("gbt7714", "CUSTOM {title}")
        self.assertEqual(t, "CUSTOM {title}")

    def test_resolve_template_unknown_id_falls_back(self):
        from pysrc.web_api import _resolve_template
        t = _resolve_template("user_xxxxxx", None)
        self.assertIn("{author}", t)  # 回退默认
```

运行：

```bash
python -m unittest tests.test_citation -v
```

期望：全部通过。

- [ ] **Step 7: 提交**

```bash
git add web/pysrc/web_api.py tests/test_citation.py
git commit -m "feat(api): lookup_quote/scan_document 接受 format_id+template；新增 _resolve_template"
```

---

### 任务 1.11：Service Worker 缓存升级

**Files:**
- Modify: `web/service-worker.js`

- [ ] **Step 1: 把 `formats.py` 与 `formats.js` 加进 SELF_ASSETS；CACHE_NAME v4 → v5**

```javascript
// 替换 web/service-worker.js 第 10 行
const CACHE_NAME = 'xundian-v5';
```

然后在 SELF_ASSETS 数组里，在 `'pysrc/web_api.py',` 那行下面加：

```javascript
  'pysrc/__init__.py',
  'pysrc/extract_quotes.py',
  'pysrc/pdf_text.py',
  'pysrc/matcher.py',
  'pysrc/citation.py',
  'pysrc/render_report.py',
  'pysrc/web_api.py',
  'pysrc/formats.py',           // 新增
  // ...
  'app.js',
  'style.css',
  'icon.png',
  'py-bridge.js',
  'fs-bridge.js',
  'pdf-extract.js',
  'db.js',
  'formats.js',                 // 新增
  // ...
```

（具体合并到现有数组里相邻位置；不要重复添加。）

- [ ] **Step 2: 在 `web/index.html` 里加 `<script src="formats.js">`**

打开 `web/index.html`，找到 `<script src="db.js"></script>` 一行，在它之后加：

```html
<script src="db.js"></script>
<script src="formats.js"></script>
```

- [ ] **Step 3: 手工验证**

```bash
python -m http.server 8080 --directory web
```

打开浏览器，DevTools → Application → Service Workers，刷新页面，确认 v5 注册成功。Console 里没有 404；执行 `window.xdFormats.BUILTIN_FORMATS.length` 应该等于 3。

- [ ] **Step 4: 提交**

```bash
git add web/service-worker.js web/index.html
git commit -m "chore(sw): 缓存升级 v4→v5；加载 formats.js 和 formats.py"
```

---

### 任务 1.12：阶段 1 收尾 — 全量回归

- [ ] **Step 1: 跑两套测试**

```bash
python -m unittest tests.test_citation -v
node tests/parse_test.mjs
node tests/citation_test.mjs
```

期望：三套全 OK。

- [ ] **Step 2: 手工冒烟**

```bash
python -m http.server 8080 --directory web
```

在浏览器中：
1. 编辑书目 → 4 个新字段可见、可填、可保存
2. 智能识别粘贴 3 种格式的引文 → 字段被正确填充
3. 跑一次单句查询 / 扫描 → 仍按 GB/T 7714 输出（因为还没接全局选择器）

- [ ] **Step 3: 阶段 1 完成提示**

如果一切 OK，阶段 1 完成。此时项目状态：
- 数据模型 ✓
- 模板引擎 Python + JS ✓ 同步
- 智能识别扩展 ✓
- 渲染仍走 GB/T 7714（用户尚不可切换）

阶段 1 可以独立部署 / 合并到 main。

---

## 阶段 2：全局格式选择器 + 卡片格式 chip

### 任务 2.1：localStorage 读写工具

**Files:**
- Modify: `web/formats.js`

- [ ] **Step 1: 在 `web/formats.js` 末尾追加 localStorage 工具**

在 `window.xdFormats = { ... }` 赋值之前追加：

```javascript
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
```

然后在 `window.xdFormats = {` 块里加这两个函数：

```javascript
window.xdFormats = {
  renderCitation,
  parseTemplate,
  TemplateSyntaxError,
  BUILTIN_FORMATS,
  DEFAULT_FORMAT_ID,
  getBuiltinTemplate,
  VALID_FIELDS: [...VALID_FIELDS],
  // 新增：
  getActiveFormatId,
  setActiveFormatId,
};
```

- [ ] **Step 2: 提交**

```bash
git add web/formats.js
git commit -m "feat(formats): getActiveFormatId/setActiveFormatId（localStorage 持久化）"
```

---

### 任务 2.2：全局格式选择器 DOM

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`

- [ ] **Step 1: 在单句查询页和文档扫描页顶部加选择器**

找到 `<section class="tab-panel" id="tab-lookup">` 和 `<section class="tab-panel" id="tab-scan">` 各自的开头，在 `.panel-header` 后面（或同等位置）添加：

```html
<div class="format-bar">
  <span class="format-bar-label">📐 引用格式</span>
  <select id="lookup-format-select" class="format-select"></select>
  <span class="format-bar-hint">这里选完，本次查询的所有结果都按这个格式渲染</span>
</div>
```

scan 页用 `id="scan-format-select"`。

- [ ] **Step 2: 加 CSS**

```css
/* 全局格式选择器条 */
.format-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  background: #f6f8fa;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 13px;
}
.format-bar-label {
  color: #666;
  font-weight: 500;
}
.format-select {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid #d0d7de;
  background: white;
  font-size: 13px;
  min-width: 220px;
}
.format-bar-hint {
  color: #999;
  font-size: 11px;
}
```

- [ ] **Step 3: 提交**

```bash
git add web/index.html web/style.css
git commit -m "feat(ui): 单句查询和文档扫描页加全局格式选择器条"
```

---

### 任务 2.3：填充选择器选项 + 持久化

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: 找到 app 启动钩子**

```bash
grep -n "DOMContentLoaded\|init()\|async function init" web/app.js | head -10
```

定位到 app 启动函数（应该叫 `init` 或类似）。

- [ ] **Step 2: 在启动逻辑里调一次 populate**

在启动函数主体最后添加：

```javascript
  // 填充全局格式选择器
  populateGlobalFormatSelectors();
```

然后在 app.js 适当位置（建议 callApi 附近）新增：

```javascript
// =========================================================
// 全局格式选择器
// =========================================================

function populateGlobalFormatSelectors() {
  const builtins = window.xdFormats.BUILTIN_FORMATS;
  // 阶段 2 不支持用户格式，先只列内置
  const optsHtml = builtins.map(f =>
    `<option value="${f.id}">${escapeHtml(f.name)}</option>`
  ).join('');

  for (const selId of ['lookup-format-select', 'scan-format-select']) {
    const sel = document.getElementById(selId);
    if (!sel) continue;
    sel.innerHTML = optsHtml;
    sel.value = window.xdFormats.getActiveFormatId();
    sel.addEventListener('change', (e) => {
      window.xdFormats.setActiveFormatId(e.target.value);
      // 同步另一个选择器
      for (const otherId of ['lookup-format-select', 'scan-format-select']) {
        if (otherId !== selId) {
          const other = document.getElementById(otherId);
          if (other) other.value = e.target.value;
        }
      }
      // 重渲染当前页面所有已显示的卡片
      rerenderAllCitations();
    });
  }
}

// 占位：被任务 2.6 实现
function rerenderAllCitations() {
  // 阶段 2 后面会实现
}
```

- [ ] **Step 3: 手工验证**

```bash
python -m http.server 8080 --directory web
```

打开浏览器，切到单句查询 → 选择器显示 3 个内置；改选 → 切到文档扫描 → 那边也同步；刷新 → 仍记得上次的选择。

- [ ] **Step 4: 提交**

```bash
git add web/app.js
git commit -m "feat(ui): 全局格式选择器 — 填充选项 + 持久化 + 双页同步"
```

---

### 任务 2.4：把 active_format 传给 Python

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: 找到 lookup_quote / scan_document 的前端调用点**

```bash
grep -n "lookup_quote\|scan_document" web/app.js | head -20
```

可能是 `callApi('lookup_quote', ...)` 之类。

- [ ] **Step 2: 在调用点附近加传参**

修改 `callApi('lookup_quote', ...)` 那行（或等价调用），把 `format_id` 作为新增参数传过去：

```javascript
// 旧调用（示例，可能形如）：
// const result = await callApi('lookup_quote', quote, ctxB, ctxA, booksData, booksMeta);

// 新调用：
const formatId = window.xdFormats.getActiveFormatId();
const result = await callApi(
  'lookup_quote', quote, ctxB, ctxA, booksData, booksMeta,
  formatId, null,   // template 留 null —— 阶段 2 只传内置 id
);
```

scan_document 同样处理。

- [ ] **Step 3: 检查 py-bridge.js 是否需要改**

```bash
grep -n "callApi\|toPython\|callMethod" web/py-bridge.js 2>/dev/null
```

如 `callApi` 已经是"原样转发参数"，无需改。否则按 bridge 实际接口扩展。

- [ ] **Step 4: 手工验证**

启动 server，跑单句查询，确认结果卡片的 citation 字符串符合当前选的格式（暂时只内置 3 个）。把全局选择器切到"历史研究体例"，**再发起一次新查询**（这步不会自动重渲染旧结果，那是任务 2.6 的事），看新结果是否按历史研究渲染。

- [ ] **Step 5: 提交**

```bash
git add web/app.js
git commit -m "feat(api): 前端把当前 active_format 传给 lookup_quote/scan_document"
```

---

### 任务 2.5：卡片上的格式 chip + 复制脚注同步

**Files:**
- Modify: `web/app.js`
- Modify: `web/style.css`

- [ ] **Step 1: 找到 `renderResultCard` 函数**

```bash
grep -n "renderResultCard\|function renderResult\|出处（建议）\|📋 复制脚注" web/app.js | head -20
```

定位到渲染卡片的核心函数。

- [ ] **Step 2: 修改卡片的"出处（建议）"行加 chip**

找到卡片"出处（建议）"那段的 HTML 模板，在"出处（建议）"文字旁边插入 chip：

```javascript
// 在卡片的"出处（建议）"标签位置，把它替换为类似：
const activeFormatId = window.xdFormats.getActiveFormatId();
const activeFormatName = (window.xdFormats.BUILTIN_FORMATS.find(f => f.id === activeFormatId) || {}).name || activeFormatId;

// 用于卡片标识，便于稍后查询/重渲染
const cardId = `card-${quote.quote_id}-${candIdx}`;

// 在"出处（建议）"标签的 innerHTML 拼接里加 chip：
`<div class="cand-citation-label" data-card-id="${cardId}">
  出处（建议）
  <button class="fmt-chip" data-card-id="${cardId}" data-current-fmt="${activeFormatId}" type="button">
    📐 ${escapeHtml(activeFormatName)} ▾
  </button>
</div>
<div class="cand-citation-text" data-card-id="${cardId}">${escapeHtml(c.citation)}</div>`
```

并在卡片渲染中给每张卡保存它对应的 `book_file` / `book_page` / `book_page_end` / `pdf_page` 数据，用于后续切换时本地重渲染（直接 stringify 进 data-meta 属性，或保留一个全局 Map）。建议加一个 module 级 Map：

```javascript
// 在 app.js 顶层
const _cardMetaMap = new Map();  // cardId → { meta, book_page, book_page_end, pdf_page }
```

在 renderResultCard 内填写：

```javascript
_cardMetaMap.set(cardId, {
  meta: _lastBooksMeta[c.book_file] || {},
  book_page: c.book_page,
  book_page_end: c.book_page_end,
  pdf_page: c.pdf_page,
  book_file: c.book_file,
});
```

- [ ] **Step 3: 加 CSS**

```css
/* 卡片上的格式 chip */
.fmt-chip {
  display: inline-block;
  padding: 1px 8px;
  margin-left: 8px;
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
  border-radius: 10px;
  font-size: 10px;
  cursor: pointer;
}
.fmt-chip:hover { background: #dbeafe; }

/* chip 下拉菜单 */
.fmt-chip-menu {
  position: absolute;
  background: white;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  padding: 4px 0;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  z-index: 1000;
  font-size: 12px;
  min-width: 180px;
}
.fmt-chip-menu .item {
  padding: 6px 12px;
  cursor: pointer;
}
.fmt-chip-menu .item:hover { background: #f0f6ff; }
.fmt-chip-menu .item.active { font-weight: 600; color: #1d4ed8; }
.fmt-chip-menu .divider { height: 1px; background: #eaeef2; margin: 4px 0; }
```

- [ ] **Step 4: 加 chip 点击事件 + 下拉菜单**

在 app.js 顶层加事件代理：

```javascript
// chip 点击事件代理
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


function showFmtChipMenu(chip) {
  // 关闭其它已开菜单
  document.querySelectorAll('.fmt-chip-menu').forEach(el => el.remove());

  const cardId = chip.dataset.cardId;
  const currentFmt = chip.dataset.currentFmt;
  const builtins = window.xdFormats.BUILTIN_FORMATS;

  const menu = document.createElement('div');
  menu.className = 'fmt-chip-menu';
  menu.innerHTML = builtins.map(f =>
    `<div class="item${f.id === currentFmt ? ' active' : ''}" data-fmt-id="${f.id}">
       ${f.id === currentFmt ? '✓ ' : '　 '}${escapeHtml(f.name)}
     </div>`
  ).join('');

  // 定位在 chip 下方
  const rect = chip.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const newFmtId = item.dataset.fmtId;
    applyCardFormatOverride(cardId, newFmtId);
    menu.remove();
  });
}


function applyCardFormatOverride(cardId, formatId) {
  const cardData = _cardMetaMap.get(cardId);
  if (!cardData) return;

  const template = window.xdFormats.getBuiltinTemplate(formatId);
  if (!template) return;

  let newCitation;
  try {
    newCitation = window.xdFormats.renderCitation({
      template,
      meta: cardData.meta,
      book_page: cardData.book_page,
      book_page_end: cardData.book_page_end,
      pdf_page: cardData.pdf_page,
    });
  } catch (err) {
    console.error('卡片重渲染失败：', err);
    return;
  }

  // 更新 chip 和 citation 文本
  const fmtName = (window.xdFormats.BUILTIN_FORMATS.find(f => f.id === formatId) || {}).name || formatId;
  const chip = document.querySelector(`.fmt-chip[data-card-id="${cardId}"]`);
  if (chip) {
    chip.dataset.currentFmt = formatId;
    chip.textContent = `📐 ${fmtName} ▾`;
  }
  const textEl = document.querySelector(`.cand-citation-text[data-card-id="${cardId}"]`);
  if (textEl) textEl.textContent = newCitation;
}
```

- [ ] **Step 5: 让"📋 复制脚注"复制 chip 上当前显示的文本**

找到"📋 复制脚注"按钮的点击处理（搜索 `复制脚注`）。把复制逻辑改为读取同 cardId 下 `.cand-citation-text` 的 `textContent`：

```javascript
// 复制脚注按钮（每张卡上一个）
//   旧实现可能从原始数据拼字符串。改为：直接读 DOM 里 chip 当前显示的那段
async function copyCardCitation(cardId) {
  const textEl = document.querySelector(`.cand-citation-text[data-card-id="${cardId}"]`);
  if (!textEl) return;
  await navigator.clipboard.writeText(textEl.textContent);
  showToast('已复制脚注到剪贴板');
}
```

（把现有的复制按钮 onclick 绑到 `copyCardCitation(cardId)` 上；cardId 也传给主命中卡片，不只是候选卡片。）

- [ ] **Step 6: 手工验证**

```bash
python -m http.server 8080 --directory web
```

发起一次单句查询。每张卡上：
1. 看到"📐 GB/T 7714 ▾" chip
2. 点 chip → 弹出 3 个内置选项 + 当前打勾
3. 选另一个 → citation 文本立即变化、chip 名变化
4. 点"📋 复制脚注" → 剪贴板内容是当前显示的格式
5. 切到其他卡 → 不受影响

- [ ] **Step 7: 提交**

```bash
git add web/app.js web/style.css
git commit -m "feat(card): 卡片格式 chip + 切换菜单 + 复制脚注随 chip 走"
```

---

### 任务 2.6：全局选择器切换时批量重渲染所有卡片

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: 实现 `rerenderAllCitations`**

替换任务 2.3 留下的占位实现：

```javascript
function rerenderAllCitations() {
  const formatId = window.xdFormats.getActiveFormatId();
  const template = window.xdFormats.getBuiltinTemplate(formatId);
  if (!template) return;
  const fmtName = (window.xdFormats.BUILTIN_FORMATS.find(f => f.id === formatId) || {}).name || formatId;

  // 遍历所有 chip 卡片
  document.querySelectorAll('.fmt-chip').forEach(chip => {
    const cardId = chip.dataset.cardId;
    const cardData = _cardMetaMap.get(cardId);
    if (!cardData) return;
    let newCitation;
    try {
      newCitation = window.xdFormats.renderCitation({
        template,
        meta: cardData.meta,
        book_page: cardData.book_page,
        book_page_end: cardData.book_page_end,
        pdf_page: cardData.pdf_page,
      });
    } catch (_) {
      return;
    }
    chip.dataset.currentFmt = formatId;
    chip.textContent = `📐 ${fmtName} ▾`;
    const textEl = document.querySelector(`.cand-citation-text[data-card-id="${cardId}"]`);
    if (textEl) textEl.textContent = newCitation;
  });
}
```

- [ ] **Step 2: 手工验证**

发起查询 → 多张卡显示后 → 全局选择器换一个格式 → 所有卡片瞬间重渲染。

- [ ] **Step 3: 提交**

```bash
git add web/app.js
git commit -m "feat(ui): 全局格式切换时批量重渲染所有已显示卡片（JS 端）"
```

---

### 任务 2.7：Markdown 报告导出按全局格式渲染

**Files:**
- Modify: `web/app.js`（找到导出按钮的事件）

- [ ] **Step 1: 找到导出报告调用**

```bash
grep -n "export_report\|render_report\|导出.*报告" web/app.js | head -10
```

- [ ] **Step 2: 把 format_id 一起传过去**

修改 `callApi('export_report', ...)`（或等价调用）增加 format_id：

```javascript
const formatId = window.xdFormats.getActiveFormatId();
const bytes = await callApi('export_report', formatId, null);
```

- [ ] **Step 3: web_api.py 的 `export_report` 接受新参数**

打开 `web/pysrc/web_api.py`，找到 `export_report` 方法。改造签名 + 重新渲染 citations：

```python
    def export_report(self, format_id: Optional[str] = None, template: Optional[str] = None):
        if not self._last_scan:
            raise RuntimeError("还没有可导出的扫描结果")
        s = self._last_scan
        resolved_template = _resolve_template(format_id, template)
        # 用新格式重新渲染 citations
        from .matcher import MatchResult  # noqa
        new_citations = []
        for q, mr in zip(s["quotes"], s["matches"]):
            if mr.best is None:
                new_citations.append("待人工确认")
                continue
            meta = s["meta_dict"].get(mr.best.book_file, {}) or {}
            meta_full = {
                "author": meta.get("author", "XX"),
                "role": meta.get("role", ""),
                "country": meta.get("country", ""),
                "translator": meta.get("translator", ""),
                "edition": meta.get("edition", ""),
                "title": meta.get("title", mr.best.book_file),
                "doc_type": meta.get("doc_type", "M"),
                "place": meta.get("place", "XX"),
                "publisher": meta.get("publisher", "XX出版社"),
                "year": meta.get("year", "0000"),
            }
            new_citations.append(_render_citation(
                template=resolved_template,
                meta=meta_full,
                book_page=mr.best.book_page,
                book_page_end=mr.best.book_page_end,
                pdf_page=mr.best.pdf_page,
            ))
        return render_report_bytes(
            quotes=s["quotes"],
            matches=s["matches"],
            citations=new_citations,
            books_pages=s["books_pages"],
            meta_dict=s["meta_dict"],
            threshold=s["threshold"],
        )
```

- [ ] **Step 4: 手工验证**

扫描一个 docx，切换全局格式到"历史研究体例"，点导出报告，打开下载的 .md 文件，确认引文按历史研究体例渲染。

- [ ] **Step 5: 提交**

```bash
git add web/app.js web/pysrc/web_api.py
git commit -m "feat(export): Markdown 报告按全局选择的格式重新渲染 citations"
```

---

### 任务 2.8：阶段 2 收尾

- [ ] **Step 1: 全量回归**

```bash
python -m unittest tests.test_citation -v
node tests/parse_test.mjs
node tests/citation_test.mjs
```

期望：全 OK。

- [ ] **Step 2: 浏览器手工冒烟**

1. 全局选择器：双页同步、持久化、切换重渲染所有卡 ✓
2. 卡片 chip：单卡覆盖、不影响其他、刷新后归全局 ✓
3. 复制脚注：跟着 chip 走 ✓
4. 导出 .md：按全局格式 ✓

阶段 2 完成。

---

## 阶段 3：格式管理 tab + 模板编辑器 + IndexedDB CRUD

### 任务 3.1：IndexedDB formats store

**Files:**
- Modify: `web/db.js`

- [ ] **Step 1: 升 DB_VERSION 并加 store**

```javascript
// 替换 web/db.js 第 17-22 行
const DB_NAME = 'xundian';
const DB_VERSION = 2;  // 1 → 2：新增 formats store
const STORE_BOOKS = 'books';
const STORE_FOLDERS = 'folders';
const STORE_CACHES = 'caches';
const STORE_SETTINGS = 'settings';
const STORE_FORMATS = 'formats';  // 新增
```

- [ ] **Step 2: 在 `onupgradeneeded` 里建 store**

在 `web/db.js` 的 `open()` 方法里，`onupgradeneeded` 回调内：

```javascript
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_BOOKS)) {
          db.createObjectStore(STORE_BOOKS, { keyPath: 'file_id' });
        }
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
          db.createObjectStore(STORE_FOLDERS, { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains(STORE_CACHES)) {
          db.createObjectStore(STORE_CACHES, { keyPath: 'file_id' });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
        // v2 新增：formats store
        if (!db.objectStoreNames.contains(STORE_FORMATS)) {
          db.createObjectStore(STORE_FORMATS, { keyPath: 'id' });
        }
      };
```

- [ ] **Step 3: 加 CRUD 方法**

在 `XunDianDB` 类内，`putSettings` 之后追加：

```javascript
  // —— formats ——

  async listFormats() {
    const tx = await this._tx([STORE_FORMATS]);
    return await this._req(tx.objectStore(STORE_FORMATS).getAll());
  }

  async getFormat(id) {
    const tx = await this._tx([STORE_FORMATS]);
    return await this._req(tx.objectStore(STORE_FORMATS).get(id));
  }

  async putFormat(fmt) {
    // fmt: { id, name, category: 'builtin'|'user', template, parent_id?, created_at, updated_at }
    const tx = await this._tx([STORE_FORMATS], 'readwrite');
    await this._req(tx.objectStore(STORE_FORMATS).put(fmt));
  }

  async deleteFormat(id) {
    const tx = await this._tx([STORE_FORMATS], 'readwrite');
    await this._req(tx.objectStore(STORE_FORMATS).delete(id));
  }
```

- [ ] **Step 4: 手工验证 schema 升级**

```bash
python -m http.server 8080 --directory web
```

打开浏览器，DevTools → Application → IndexedDB → xundian → 确认有 5 个 store（其中 formats 是新增）。如果原本 v1 数据库存在，升级到 v2 时数据应保留。

- [ ] **Step 5: 提交**

```bash
git add web/db.js
git commit -m "feat(db): DB_VERSION 1→2；新增 formats store + CRUD 方法"
```

---

### 任务 3.2：`formats.js` 接入 IndexedDB（合并内置+用户视图）

**Files:**
- Modify: `web/formats.js`

- [ ] **Step 1: 加 listAllFormats / getFormatById（异步，合并）**

在 `web/formats.js` 末尾追加：

```javascript
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
```

把这三个函数加进 `window.xdFormats`：

```javascript
window.xdFormats = {
  // ... 已有 ...
  listAllFormats,
  getFormatById,
  resolveTemplateForId,
  isModifiedBuiltin,
};
```

- [ ] **Step 2: 修改 populateGlobalFormatSelectors 用合并视图**

在 `web/app.js` 中，把 `populateGlobalFormatSelectors` 改为异步并使用 `listAllFormats`：

```javascript
async function populateGlobalFormatSelectors() {
  const all = await window.xdFormats.listAllFormats();
  const builtins = all.filter(f => f.category === 'builtin');
  const users = all.filter(f => f.category === 'user');

  let optsHtml = '<optgroup label="内置">';
  optsHtml += builtins.map(f => `<option value="${f.id}">${escapeHtml(f.name)}${window.xdFormats.isModifiedBuiltin(f) ? ' ●已修改' : ''}</option>`).join('');
  optsHtml += '</optgroup>';
  if (users.length) {
    optsHtml += '<optgroup label="我的">';
    optsHtml += users.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
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
        document.querySelector('.tab-btn[data-tab="formats"]').click();
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
```

- [ ] **Step 3: 提交**

```bash
git add web/formats.js web/app.js
git commit -m "feat(formats): listAllFormats 合并内置+IndexedDB；选择器分组渲染"
```

---

### 任务 3.3：新 tab "📐 引用格式" + DOM

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`
- Modify: `web/app.js`

- [ ] **Step 1: 在 `<nav class="tabs">` 加新按钮**

修改 `web/index.html` 的导航栏：

```html
<nav class="tabs">
  <button class="tab-btn" data-tab="library">📚 我的书架</button>
  <button class="tab-btn active" data-tab="scan">📄 文档扫描</button>
  <button class="tab-btn" data-tab="lookup">🔍 单句查询</button>
  <button class="tab-btn" data-tab="formats">📐 引用格式</button>
</nav>
```

- [ ] **Step 2: 在 `<main>` 末尾加 panel**

```html
<section class="tab-panel" id="tab-formats">
  <div class="panel-header">
    <h2>引用格式</h2>
    <div>
      <button class="btn-secondary" id="btn-fmt-new-blank">＋ 空白新建</button>
      <button class="btn-secondary" id="btn-fmt-infer">📥 从样例反推</button>
      <button class="btn-secondary" id="btn-fmt-import">📂 导入 JSON</button>
      <input type="file" id="fmt-import-file" accept=".json" style="display:none;" />
    </div>
  </div>
  <p class="hint">所有结果卡片和 .md 导出按"全局选择"的格式渲染。卡片上的 ▾ 按钮可临时切换单卡格式。</p>
  <div id="fmt-list-builtin" class="fmt-list-section">
    <h3>内置</h3>
    <div class="fmt-list" id="fmt-list-builtin-items"></div>
  </div>
  <div id="fmt-list-user" class="fmt-list-section">
    <h3>我的</h3>
    <div class="fmt-list" id="fmt-list-user-items"></div>
  </div>
</section>
```

- [ ] **Step 3: 加 CSS**

```css
/* 格式管理 tab */
.fmt-list-section {
  margin-top: 16px;
}
.fmt-list-section h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #666;
  margin: 12px 0 8px;
}
.fmt-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fmt-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: white;
  border: 1px solid #d0d7de;
  border-radius: 4px;
}
.fmt-item-name { font-weight: 500; }
.fmt-item-meta { color: #999; font-size: 11px; margin-left: 8px; }
.fmt-item-actions button {
  margin-left: 4px;
  font-size: 11px;
}
.fmt-item-default { color: #16a34a; font-size: 11px; margin-left: 6px; }
.fmt-item-modified { color: #f59e0b; font-size: 11px; margin-left: 6px; }
```

- [ ] **Step 4: 渲染列表函数**

在 `web/app.js` 适当位置（如 populateGlobalFormatSelectors 旁）：

```javascript
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
```

在 init 时把渲染挂上：

```javascript
  // 切到格式 tab 时渲染列表（既然 tab 切换已有逻辑，找到那里 hook）
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'formats') renderFormatList();
    });
  });
```

- [ ] **Step 5: 手工验证**

浏览器 → 切到"📐 引用格式" tab → 看到 3 条内置 + 空"我的"提示。按钮先不接事件（任务 3.4 起接）。

- [ ] **Step 6: 提交**

```bash
git add web/index.html web/style.css web/app.js
git commit -m "feat(ui): 新 tab 📐 引用格式 + 列表渲染（按钮事件待接）"
```

---

### 任务 3.4：模板编辑器 modal

**Files:**
- Modify: `web/app.js`
- Modify: `web/style.css`

- [ ] **Step 1: 写编辑器 modal 函数**

在 `web/app.js` 适当位置：

```javascript
// 模板编辑器 modal
//   options: { mode: 'edit'|'create-blank'|'clone', initialFormat: {name, template, parent_id?} }
//   resolve: 完成后的 format 对象（{ name, template, parent_id? }），取消 → null
async function openTemplateEditor(options) {
  const initial = options.initialFormat || { name: '', template: '', parent_id: null };
  const insertableFields = ['author', 'role', 'country', 'title', 'translator', 'edition', 'doc_type', 'place', 'publisher', 'year', 'page'];
  // 字段插入按钮 — 普通字段 + ?optional 段
  const buttonsHtml = insertableFields.map(f =>
    `<button class="mock-button" data-insert="{${f}}" type="button">+ {${f}}</button>`
  ).join('')
   + insertableFields.filter(f => f !== 'page' && f !== 'author' && f !== 'title')
       .map(f => `<button class="mock-button" data-insert="{?${f} {}}" type="button">+ {?${f}}</button>`).join('');

  const sampleBooks = [
    {
      label: '完整字段（任继愈主编《中国哲学发展史》）',
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
    <label>名称</label>
    <input id="tpl-name" value="${escapeHtml(initial.name)}" />

    <label>模板</label>
    <textarea id="tpl-template" rows="4" class="tpl-textarea">${escapeHtml(initial.template)}</textarea>

    <div class="tpl-insert-row">
      <span class="hint">点击插入：</span>
      ${buttonsHtml}
    </div>

    <label>实时预览（样书 <select id="tpl-sample">${sampleBooks.map((s, i) => `<option value="${i}">${escapeHtml(s.label)}</option>`).join('')}</select>）</label>
    <div id="tpl-preview" class="tpl-preview">（待渲染）</div>
    <div id="tpl-error" class="tpl-error hidden"></div>
  `;

  return new Promise((resolve) => {
    showModal({
      title: options.mode === 'edit' ? '编辑格式' : (options.mode === 'clone' ? '基于此新建' : '新建格式'),
      bodyHtml,
      onOk: async () => {
        const name = document.getElementById('tpl-name').value.trim();
        const template = document.getElementById('tpl-template').value;
        if (!name) { alert('请填名称'); return false; }
        try {
          window.xdFormats.parseTemplate(template);
        } catch (err) {
          alert('模板语法错误：' + err.message);
          return false;
        }
        return { name, template, parent_id: initial.parent_id || null };
      },
      onCancel: () => { resolve(null); return true; },
    }).then(result => resolve(result));

    // 模态打开后绑定事件
    setTimeout(() => {
      const taEl = document.getElementById('tpl-template');
      const sampleEl = document.getElementById('tpl-sample');
      const previewEl = document.getElementById('tpl-preview');
      const errorEl = document.getElementById('tpl-error');

      function refresh() {
        const tpl = taEl.value;
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
      document.querySelectorAll('[data-insert]').forEach(b => {
        b.addEventListener('click', () => {
          const ins = b.dataset.insert;
          const start = taEl.selectionStart;
          const end = taEl.selectionEnd;
          taEl.value = taEl.value.slice(0, start) + ins + taEl.value.slice(end);
          taEl.selectionStart = taEl.selectionEnd = start + ins.length;
          taEl.focus();
          refresh();
        });
      });
      refresh();
    }, 0);
  });
}
```

- [ ] **Step 2: 加 CSS**

```css
.tpl-textarea {
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  width: 100%;
}
.tpl-textarea.error {
  border-color: #dc2626;
  background: #fef2f2;
}
.tpl-insert-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 6px 0;
}
.tpl-preview {
  font-family: 'Source Han Serif', serif;
  font-size: 14px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 4px;
  padding: 8px;
  min-height: 32px;
}
.tpl-error {
  color: #dc2626;
  background: #fef2f2;
  border-left: 3px solid #dc2626;
  padding: 6px 10px;
  font-size: 12px;
  margin-top: 6px;
}
.hidden { display: none; }
```

- [ ] **Step 3: 提交**

```bash
git add web/app.js web/style.css
git commit -m "feat(formats): 模板编辑器 modal（名称+模板+插入按钮+实时预览+语法校验）"
```

---

### 任务 3.5：连接格式管理 tab 的按钮事件

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: 加按钮事件代理**

在 init 或同等位置：

```javascript
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


async function saveNewUserFormat({ name, template, parent_id }) {
  const id = `user_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await window.db.putFormat({
    id, name, category: 'user', template,
    parent_id: parent_id || null,
    created_at: now, updated_at: now,
  });
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


// 占位：任务 4.3 实现
async function handleFormatExport(fmtId) { alert('导出功能待阶段 4 实现'); }
```

- [ ] **Step 2: 手工验证**

逐项验：
1. 点 ＋ 空白新建 → 弹编辑器 → 填名称 + 模板 → 保存 → 列表里出现新格式
2. 点内置 GB/T 7714 的"基于此新建" → 弹编辑器，模板已填，名称为"GB/T 7714—2015 副本" → 保存 → 列表新增
3. 点内置的"编辑" → 修改模板 → 保存 → 列表里出现"●已修改" + "重置"按钮
4. 点"重置" → 确认 → 标记消失，恢复内置模板
5. 点用户格式"删除" → 确认 → 列表移除
6. 编辑后切到查询页发查询 → 卡片按新模板渲染

- [ ] **Step 3: 提交**

```bash
git add web/app.js
git commit -m "feat(formats): CRUD — 新建/克隆/编辑/重置/删除 全打通"
```

---

### 任务 3.6：用户格式的查询/扫描接入

**Files:**
- Modify: `web/app.js`（已在阶段 2 处理 callApi 调用）

- [ ] **Step 1: 修改 callApi 调用，按需把 template 传过去**

阶段 2 我们写了 `callApi('lookup_quote', ..., formatId, null)`。现在用户格式不在 Python 端，要把 template 一起传。改为：

```javascript
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
```

把 `lookup_quote` 调用改为：

```javascript
const { id: formatId, template: formatTemplate } = await _resolveActiveFormatPayload();
const result = await callApi('lookup_quote', quote, ctxB, ctxA, booksData, booksMeta, formatId, formatTemplate);
```

`scan_document` 和 `export_report` 同样改。

- [ ] **Step 2: 同步修改 chip 切换和重渲染**

`applyCardFormatOverride` 现在用 builtins only。改为支持用户格式：

```javascript
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
```

`rerenderAllCitations` 同样异步化：

```javascript
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
```

- [ ] **Step 3: 修改 chip 下拉菜单也列用户格式**

`showFmtChipMenu` 改为：

```javascript
async function showFmtChipMenu(chip) {
  document.querySelectorAll('.fmt-chip-menu').forEach(el => el.remove());
  const cardId = chip.dataset.cardId;
  const currentFmt = chip.dataset.currentFmt;
  const all = await window.xdFormats.listAllFormats();
  const builtins = all.filter(f => f.category === 'builtin');
  const users = all.filter(f => f.category === 'user');

  const renderItems = (arr) => arr.map(f =>
    `<div class="item${f.id === currentFmt ? ' active' : ''}" data-fmt-id="${f.id}">
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
      document.querySelector('.tab-btn[data-tab="formats"]').click();
    } else {
      applyCardFormatOverride(cardId, newFmtId);
    }
    menu.remove();
  });
}
```

- [ ] **Step 4: 手工验证**

1. 新建一个用户格式（例如把 GB/T 模板的"."替换成"。"）
2. 选 → 卡片 chip 下拉里能看到它
3. 全局选择器切到它 → 所有卡片重渲染
4. 单卡 chip 切到它 → 该卡渲染
5. 发起新查询 → 走 Python 端，但 template 由前端传 → 结果正确

- [ ] **Step 5: 提交**

```bash
git add web/app.js
git commit -m "feat(formats): 用户格式接入 chip 菜单/查询/扫描/导出全流程"
```

---

### 任务 3.7：阶段 3 收尾

- [ ] **Step 1: 全量回归**

```bash
python -m unittest tests.test_citation -v
node tests/parse_test.mjs
node tests/citation_test.mjs
```

期望：全 OK。

- [ ] **Step 2: 浏览器手工冒烟**

按 spec §8 / §9.1 / §9.2 全过一遍：
- 内置格式可编辑、可重置、可克隆
- 用户格式 CRUD
- 切格式实时重渲染
- 不同存储路径都正确

阶段 3 完成。

---

## 阶段 4：样例反推 + JSON 导入导出

### 任务 4.1：样例反推算法 + 测试

**Files:**
- Modify: `web/formats.js`
- Modify: `tests/citation_test.mjs`

- [ ] **Step 1: 在 `tests/citation_test.mjs` 末尾加反推测试用例**

在文件末尾、`process.exit` 之前加：

```javascript
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
  console.error('失败:' + inferFailures.join(''));
  process.exit(1);
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node tests/citation_test.mjs
```

期望：`inferTemplateFromSample is not a function`。

- [ ] **Step 3: 实现 `inferTemplateFromSample`**

在 `web/formats.js` 末尾（在 `window.xdFormats = { ... }` 之前）追加：

```javascript
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
```

把它加进 `window.xdFormats`：

```javascript
window.xdFormats = {
  // ...
  inferTemplateFromSample,
};
```

- [ ] **Step 4: 跑测试**

```bash
node tests/citation_test.mjs
```

期望：`样例反推：3/3 通过`。

- [ ] **Step 5: 提交**

```bash
git add web/formats.js tests/citation_test.mjs
git commit -m "feat(formats): 样例反推算法 inferTemplateFromSample（长值优先 + doc_type 特例）"
```

---

### 任务 4.2：样例反推 UI 流程

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: 实现"从样例反推"按钮处理**

```javascript
// 把空字符串/dummy 替换为真实事件
document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'btn-fmt-infer') {
    await openInferFlow();
  }
});


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

  const r = await showModal({
    title: '从样例反推格式',
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
      const sample = document.getElementById('infer-sample').value.trim();
      const page = parseInt(document.getElementById('infer-page').value, 10) || 25;
      if (!sample) { alert('请粘贴样例'); return false; }
      const refBook = candidates.find(b => b.file_id === refId);
      const inferred = window.xdFormats.inferTemplateFromSample({
        refMeta: refBook, sample, refPage: page,
      });
      return { inferred, refBook, page };
    },
  });
  if (!r) return;

  // 第二步：显示反推结果 + 回填验证 + [采纳并命名保存] / [修一下]
  const backRender = window.xdFormats.renderCitation({
    template: r.inferred, meta: r.refBook, book_page: r.page,
  });
  const accept = await showModal({
    title: '反推结果',
    bodyHtml: `
      <label>反推出的模板</label>
      <div class="tpl-textarea" style="background:#f6f8fa;padding:8px;">${escapeHtml(r.inferred)}</div>
      <label>回填验证（用该参照书渲染上述模板）</label>
      <div class="tpl-preview">${escapeHtml(backRender)}</div>
      <label>命名</label>
      <input id="infer-name" placeholder="例：我的历史研究改" />
    `,
    okText: '✓ 采纳并保存',
    extraButtons: [
      { id: 'btn-infer-edit', label: '✎ 修一下' },
    ],
    onOk: async () => {
      const name = document.getElementById('infer-name').value.trim();
      if (!name) { alert('请填名称'); return false; }
      return { action: 'accept', name, template: r.inferred };
    },
    onExtra: async (id) => {
      if (id === 'btn-infer-edit') {
        return { action: 'edit', template: r.inferred };
      }
    },
  });

  if (!accept) return;
  if (accept.action === 'accept') {
    await saveNewUserFormat({ name: accept.name, template: accept.template });
  } else if (accept.action === 'edit') {
    const r2 = await openTemplateEditor({
      mode: 'create-blank',
      initialFormat: { name: '', template: accept.template },
    });
    if (r2) await saveNewUserFormat(r2);
  }
  await renderFormatList();
  await populateGlobalFormatSelectors();
}
```

注意：`showModal` 可能不支持 `extraButtons`/`onExtra` —— 若现有 modal 工具不支持，请翻一下 `showModal` 的实现，加 extra 按钮支持；或拆成两个 modal（先反推、再确认）。

- [ ] **Step 2: 手工验证**

1. 切到格式 tab → 点"📥 从样例反推"
2. 选一本完整元数据的书
3. 粘贴 `任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。` + 页码 25
4. 看到反推模板 `{author}主编：《{title}》，{place}：{publisher}，{year}年，第{page}页。`
5. 看到回填验证字符串完全等于粘贴原文
6. 点"采纳并保存" → 列表新增
7. 重试一次，点"修一下" → 进编辑器，模板已填，可改

- [ ] **Step 3: 提交**

```bash
git add web/app.js
git commit -m "feat(formats): 样例反推 UI — 参照书选择/粘贴/回填验证/采纳或修一下"
```

---

### 任务 4.3：导出 JSON

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: 实现 `handleFormatExport`**

替换占位实现：

```javascript
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
```

- [ ] **Step 2: 手工验证**

格式 tab → 用户格式 → 导出 JSON → 浏览器下载一个 `<名称>.xundian-cite.json`；打开看 JSON 结构。

- [ ] **Step 3: 提交**

```bash
git add web/app.js
git commit -m "feat(formats): 导出用户格式为 .xundian-cite.json"
```

---

### 任务 4.4：导入 JSON

**Files:**
- Modify: `web/app.js`
- Modify: `web/formats.js`

- [ ] **Step 1: 在 `formats.js` 加 schema 校验**

在 `web/formats.js` 末尾、`window.xdFormats = { ... }` 之前：

```javascript
function validateImportedFormat(obj) {
  // 返回 { ok: true, name, template } 或 { ok: false, error }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '不是有效 JSON 对象' };
  if (!obj.name || typeof obj.name !== 'string') return { ok: false, error: '缺 name' };
  if (!obj.template || typeof obj.template !== 'string') return { ok: false, error: '缺 template' };
  try {
    parseTemplate(obj.template);
  } catch (err) {
    return { ok: false, error: '模板语法错误：' + err.message };
  }
  return { ok: true, name: obj.name.trim(), template: obj.template, based_on: obj.based_on || null };
}
```

加进 `window.xdFormats`：`validateImportedFormat`。

- [ ] **Step 2: 连接"导入 JSON"按钮**

```javascript
document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'btn-fmt-import') {
    document.getElementById('fmt-import-file').click();
  }
});

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
      valid.name = choice.trim() || (valid.name + ' (导入)');
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
```

- [ ] **Step 3: 手工验证**

1. 任务 4.3 导出一个 .xundian-cite.json
2. 删掉这个用户格式
3. 点"📂 导入 JSON" → 选刚才导出的文件 → 列表里又出现了
4. 编辑导出的 JSON 把 template 改成"{author}. {bad_field}." → 导入 → 弹错"未知字段 bad_field"
5. 编辑 JSON 把 name 删掉 → 导入 → 弹错"缺 name"
6. 测试同名导入 → 弹提示让改名

- [ ] **Step 4: 提交**

```bash
git add web/app.js web/formats.js
git commit -m "feat(formats): 导入 JSON — schema 校验 + 同名提示 + 写入用户格式"
```

---

### 任务 4.5：阶段 4 收尾 / 整体回归

- [ ] **Step 1: 全量测试**

```bash
python -m unittest tests.test_citation -v
node tests/parse_test.mjs
node tests/citation_test.mjs
```

期望：全 OK。

- [ ] **Step 2: 浏览器全功能冒烟**

按 spec §4 checklist 走一遍：

- [ ] 3 内置可见、可选、可编辑、可重置
- [ ] 4 条创建路径全部可用
- [ ] 全局选择持久化（刷新仍记得）
- [ ] 卡片 chip 切换 + 不跨刷新
- [ ] 复制脚注 = chip 当前显示
- [ ] Markdown 报告导出按全局格式
- [ ] 智能识别能吃下三种格式的粘贴
- [ ] 4 个新字段在书目编辑器
- [ ] 老书无 4 字段时（`role=""`），渲染不报错（被 `{?role}` 吃掉）
- [ ] 必填字段空时显示"〔X待补〕"
- [ ] 跨页 11-12 vs 单页 25 正确

- [ ] **Step 3: 文档同步**

如果 README 或其他 user-facing 文档需要更新（提到引用格式），更新它们：

```bash
grep -rn "GB/T 7714\|引用格式\|citation" README.md *.md 2>/dev/null
```

如果有提到旧实现的地方，更新。

- [ ] **Step 4: 整体提交**

```bash
git status
# 应该是干净的
```

阶段 4 完成 = v1 完成。

---

## 自我审查

**1. Spec 覆盖：**
- §2 目标 1（3 内置） ✓ 任务 1.3
- §2 目标 2（内置可编辑） ✓ 任务 3.5
- §2 目标 3（全局 + 卡片切换） ✓ 任务 2.2-2.6
- §2 目标 4（4 条创建路径） ✓ 任务 3.5 + 4.2 + 4.3-4.4
- §2 目标 5（智能识别扩展） ✓ 任务 1.7-1.9
- §2 目标 6（MD 导出按全局） ✓ 任务 2.7
- §5 数据模型 ✓ 任务 1.5-1.6
- §6 模板语法 ✓ 任务 1.2-1.4
- §7 双端渲染 + 一致性 ✓ 任务 1.2-1.4（共享 JSON 用例）
- §8 UI ✓ 任务 2.2-2.6, 3.3-3.5
- §9 创建路径 ✓ 任务 3.5, 4.2-4.4
- §10 智能识别 ✓ 任务 1.7-1.8
- §11 API ✓ 任务 1.10
- §12 风险 — 不直接对应任务，但实现里都对应有处理（语法校验、长值倒序、SW 缓存升级、模板字符串可序列化）
- §13 分阶段 ✓ 直接映射到本文档的 4 个阶段

**2. 占位符扫描：** 无 TBD / TODO / "implement later" / "similar to Task N"。所有 code 步骤都给了完整代码。

**3. 命名一致性：**
- `render_citation`（Python）和 `renderCitation`（JS）：同义，命名风格符合各自语言惯例 ✓
- `format_id` / `formatId`：同义 ✓
- `_format_cand_citation` 现在接收 `template` 而非 `meta_dict` only — 调用方在任务 1.10 内一并改 ✓
- `parseTemplate` JS 与 Python `_parse` 不同名但内部函数，不必对外暴露 ✓
- `BUILTIN_FORMATS` 两端同名 ✓
- 任务 2.5 / 2.6 / 3.6 / 4.1 都引用 `_cardMetaMap`、`_lastBooksMeta`、`applyCardFormatOverride`、`rerenderAllCitations` — 一致 ✓

**4. 风险点（实现时注意）：**
- 任务 2.5 中 `renderResultCard` 改动较大，要确保保留所有原行为（出处、命中位置、分数、书中片段、📖 在 PDF 中查看按钮）—— 只是把"出处（建议）"行的标签换成带 chip 的版本
- 任务 3.6 修改了 `applyCardFormatOverride` 和 `rerenderAllCitations` 变成 async — 调用方相应 await
- 任务 4.2 的 `showModal` 用了 `extraButtons` / `onExtra`，需确认现有 modal 工具是否支持；不支持就拆两个 modal

---

## 执行选择

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-citation-formats.md`. Two execution options:**

**1. Subagent-Driven（推荐）** — 每个任务派一个新 subagent，任务间审查；快速迭代，主上下文不会被实现细节淹没

**2. Inline Execution** — 在当前会话执行，用 executing-plans，批量执行带检查点

**Which approach?**
