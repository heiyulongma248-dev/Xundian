# 多引用格式支持 · 设计文档

- **日期**：2026-05-15
- **范围**：仅网页版（`web/`），桌面版（`src/`、`frontend/`、`api.py`）本次不动
- **作者**：通过 brainstorming 协作产出

## 1. 背景

当前网页版只支持 GB/T 7714—2015 一种引用格式（实现写死在 `web/pysrc/citation.py`），用户已收集了至少另外两种学术体例需要支持，并希望能扩展、修改、保存自定义格式。

## 2. 目标

1. 内置 3 种格式，开箱即用：
   - **GB/T 7714—2015**（中国国标，现行默认）
   - **历史研究体例**（《历史研究》等人文社科期刊用）
   - **法学引注手册 2025**（《法学引注手册》第二版）
2. 内置格式**可被用户编辑**（覆盖式保存到本地，可一键重置）。
3. 用户可在查询前**全局选择**格式（持久化），也可对**单个卡片临时切换**（不跨刷新）。
4. 四条"造新格式"路径全部支持：
   - 克隆内置 → 改
   - 空白新建（手写模板）
   - 从样例反推（粘贴一段引文 + 选一本参照书）
   - 导入 / 导出 JSON 文件
5. "智能识别"功能扩展为多格式探测器，能吃下三种格式的粘贴文本并抽取所有字段（含新增的 4 个）。
6. Markdown 报告导出按**全局选择的格式**统一渲染。

## 3. 非目标（v1 明确不做）

- CSL（Citation Style Language）支持
- 桌面版同步（src/、frontend/、api.py）
- 模板嵌套条件段
- 从期刊网页一键导入
- 西文学术体例预设（APA / MLA / Chicago 等）

## 4. 关键模块

| 模块 | 职责 | 新/改 |
| --- | --- | --- |
| `web/pysrc/citation.py` | 改造为模板引擎；输入"模板字符串 + 元数据"，输出字符串 | 改 |
| `web/pysrc/formats.py` | 内置 3 种格式的模板字符串常量（id / 名称 / 模板） | 新 |
| `web/pysrc/parse_meta.py` | 多格式探测 + 字段抽取（智能识别）；从现 app.js 逻辑迁出再扩展 | 新（或移动） |
| `web/pysrc/web_api.py` | `lookup_quote` / `scan_document` 新增 `format_id` + `template` 参数；新增 `render_citation` 工具入口 | 改 |
| `web/formats.js` | JS 镜像渲染器（与 Python 版完全等价），用于卡片级 chip 切换、模板编辑器实时预览 | 新 |
| `web/db.js` | 新增 IndexedDB store `formats` | 改 |
| `web/app.js` | 全局选择器、卡片 chip、新 tab "📐 引用格式"、模板编辑器、扩展 editBookMeta | 改 |
| `web/index.html` / `style.css` | 新 tab DOM + 选择器 + chip + 编辑器样式 | 改 |
| `web/service-worker.js` | SELF_ASSETS 加 `formats.py`、`formats.js`、`parse_meta.py`；CACHE_NAME v4→v5 | 改 |

## 5. 数据模型

### 5.1 书目元数据扩展

在原 7 字段（`author / title / doc_type / place / publisher / year / page_offset`）基础上新增：

| 字段 | 类型 | 默认 | "待补"占位文 |
| --- | --- | --- | --- |
| `role` 责任方式 | str | `""`（=著，省略） | 永不出占位 |
| `country` 国别 | str | `""` | 永不出占位 |
| `translator` 译者 | str | `""` | 永不出占位 |
| `edition` 版次 | str | `""` | 永不出占位 |

老 library 记录不需要迁移脚本，`Library.from_dict()` 给新字段加默认空串即可。

`page` 不属于书目元数据（运行时由 matcher 提供），渲染规则单独见 5.3。原 7 个**存储**字段空时的占位文本：

| 字段 | 占位 |
| --- | --- |
| `author` | 〔作者待补〕 |
| `title` | 〔书名待补〕 |
| `place` | 〔出版地待补〕 |
| `publisher` | 〔出版社待补〕 |
| `year` | 〔出版年待补〕 |
| `doc_type` | `M`（已有默认值） |

### 5.2 Format 对象

```json
{
  "id": "gbt7714" | "humanities_2024" | "law_2025" | "user_<uuid>",
  "name": "GB/T 7714—2015",
  "category": "builtin" | "user",
  "template": "{author}. {title}[{doc_type}]. ...",
  "parent_id": null | "gbt7714",
  "created_at": <unix-ts>,
  "updated_at": <unix-ts>
}
```

存储：
- 内置 3 种硬编码在 `web/pysrc/formats.py`（同步镜像在 `web/formats.js`）
- 用户格式 + "已编辑的内置"都存 IndexedDB `formats` store
- 运行时取格式：先查 IndexedDB，没有再回退到硬编码
- "重置内置" = 删 IndexedDB 中那条记录

### 5.3 `{page}` 智能渲染

| 运行时输入 | 输出 |
| --- | --- |
| `book_page=25` 单页 | `25` |
| `book_page=11, book_page_end=12` 跨页 | `11-12`（半角连字符） |
| `book_page=None, pdf_page=42` | `PDF第42页（书内页码待标定）` |
| 全空 | `页码待补` |

跨页连字符固定半角；嫌不对的用户可在模板里自行改用 `{?page_end}` 形态（未来扩展）。

## 6. 模板语法

### 6.1 两种构造

```
{field}              必填占位 — 输出字段值，空则输出该字段的"〔X待补〕"占位文（仅原 7 字段适用）
{?field literal{}literal}   可选段 — 字段非空时输出整段（{} 处替换为字段值），空则输出空字符串
```

字面字符直接输出。

### 6.2 补充规则

- **role "著" 自动省略**：当 `role == "著"` 或为空，渲染器视其为空，`{?role …}` 段不输出
- **不支持嵌套**：`{?…}` 内部不可再含 `{?…}`
- **不支持转义**：模板里禁用裸 `{` `}`（引用格式无此用例）
- **未知字段名** / **语法错误**：编辑器拒绝保存，标红出错位置 + 给出错误信息

合法字段名（共 11 个）：

```
author  role  country  title  translator  edition
doc_type  place  publisher  year  page
```

模板里使用任何不在该集合内的字段名都视为语法错误。

### 6.3 三个内置模板

```
GB/T 7714—2015
{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.

历史研究体例
{?country [{}]}{author}{?role {}}：《{title}》，{?translator {}译，}{place}：{publisher}，{year}年，第{page}页。

法学引注手册 2025
{?country [{}]}{author}{?role {}}：《{title}》{?edition （第{}版）}，{?translator {}译，}{publisher}{year}年版，第{page}页。
```

## 7. 双端渲染器（Python + JS 镜像）

### 7.1 分工

- **Python（`citation.py`）**：扫描 / 单句查询时统一走 Python 渲染，给所有结果一次性附 citation
- **JS（`formats.js`）**：卡片 chip 切换、模板编辑器实时预览 —— 不绕 Pyodide，零延迟

### 7.2 一致性保障

两端共享一组测试用例（JSON）：每条 `{format_template, meta, page, expected}`。任一端实现都必须跑过所有用例。

测试用例至少覆盖：
- 3 个内置 × 3 本样书（含完整字段、缺译者、缺版次等各种组合）
- "著" 自动省略
- 跨页 vs 单页
- `{field}` 字段空时的占位
- `{?field …}` 可选段空时的省略

## 8. UI

### 8.1 全局格式选择器

- 位置：单句查询页 + 文档扫描页 顶部工具区（书架页无）
- 视觉：`📐 引用格式 [▾]`
- 下拉项：内置 3 个 → 分隔 → "我的"按更新时间倒序 → 分隔 → `＋ 管理格式…`
- 持久化：`localStorage["xundian:active_format"] = format_id`
- 默认 `gbt7714`；若选中的 id 在 IndexedDB 找不到（用户删了），自动回退默认
- **切换不重跑查询** —— 走 JS 重渲染所有已显示卡片

### 8.2 卡片格式 chip

- 视觉：`📐 <格式名> ▾`（在"出处（建议）"行内）
- 点击弹下拉，与全局选择器同样的项目列表
- 切换走 JS 重渲染本卡片；不影响其他卡片、不改全局选择
- 覆盖**本页面会话内**有效，刷新 / 切 tab 失效
- `📋 复制脚注` 始终复制 chip 上当前显示的那段文本

### 8.3 "📐 引用格式" tab（格式管理页）

布局：
- **内置**组（3 条）— 每条按钮：[编辑] [基于此新建] [重置]（仅"●已修改"状态下显示）
- **我的**组 — 每条按钮：[编辑] [导出 JSON] [删除]
- 底部 3 按钮：[＋ 空白新建] [📥 从样例反推] [📂 导入 JSON]
- 默认格式带 ★ 标记，可右键设置默认

### 8.4 模板编辑器（弹层）

- 名称输入框
- 模板 textarea
- "插入字段"按钮组：10 个按钮，点击在光标处插入对应占位符
- 实时预览：用编辑器内置 2-3 本"完整字段"演示书渲染，可下拉切样书
- 语法错误：预览处红框 + 错误位置提示，[保存] 按钮禁用
- 按钮：[保存] [取消]

### 8.5 书目编辑器扩展

在现有"编辑书籍信息"弹层加 4 个字段：
- `▸ 责任方式`（提示：著/编/主编/译/整理，"著"自动省略）
- `▸ 国别`（提示：如"日""美"，留空则不输出 [国别] 前缀）
- `▸ 译者`（提示：如"谭汝谦、林启彦"）
- `▸ 版次`（提示：如"2"渲染为"(第2版)"）

排列：作者 → 责任方式 → 国别 → 书名 → 译者 → 版次 → 文献类型 → 出版地 → 出版社 → 出版年 → 文件夹。

## 9. 创建路径细节

### 9.1 克隆内置

格式管理页点 "基于此新建" → 模板编辑器（名称预填"<原名> 副本"，模板预填原始模板）→ 保存为新 `user_<uuid>`。

### 9.2 空白新建

格式管理页点 "＋ 空白新建" → 模板编辑器（名称空、模板空）→ 用户写 → 保存。

### 9.3 样例反推

UI 流程：
1. 选参照书（下拉，要求 author/title/publisher/year 都已填）
2. 粘贴样例引文
3. 点 [🔍 反推模板] → 显示反推结果 + 回填验证渲染
4. [✓ 采纳并命名保存] / [✎ 修一下] / [取消]

算法：
1. 从参照书取所有非空字段值
2. 按值长度倒序排序
3. 依次在样例里查找该值，命中第一处替换为对应 `{field}` 占位
4. 未命中的字段不进模板；用户在编辑器手动加 `{?…}`
5. 剩余文本全为字面

注意：参照书未填 `role` 时算法推不出 `{?role}`，回填里"主编"会是字面；UI 提示用户点"修一下"调整。

### 9.4 导入 / 导出 JSON

导出文件格式：
```json
{
  "$schema": "xundian-cite/v1",
  "name": "我的 GB/T 加强版",
  "template": "...",
  "based_on": "gbt7714",
  "exported_at": 1716000000
}
```
文件名：`<name 清理过的>.xundian-cite.json`。

导入：
- 总是生成新 `user_<uuid>` id，按 user 类入 IndexedDB
- schema 校验：必须含 name + template，模板必须语法通过
- 同名重复：UI 提示"已存在同名，改名 / 覆盖 / 取消"

## 10. 智能识别扩展

`web/pysrc/parse_meta.py`（如不存在则从 `app.js` 逻辑移出再扩展）。

### 10.1 探测优先级

1. 含 `[M]` / `[J]` / `[N]` 或英文 `. ` `: ` 分隔 → GB/T 7714
2. 含 `《》` + `出版社……年版`（无出版地紧跟出版社） → 法学引注手册
3. 含 `《》` + `出版地：出版社` + `第…页` → 历史研究
4. 都不像 → 退化按 GB/T 走

### 10.2 字段抽取（共用）

```
《(?P<title>[^》]+)》              → title
(?P<author>.+?)(?P<role>主编|编|译|整理)?[:：]《   → author + role
(?P<translator>[^，]+)译            → translator
\[(?P<country>[^\]]+)\]             → country
第(?P<edition>[0-9一二三四五六七八九十]+)版  → edition
+ 现有的 publisher / year / place / page 抽取逻辑
```

抽到的字段全部填进编辑表单（含新增 4 字段），用户人眼审核。

## 11. API 接口

### 11.1 `render_citation`（新工具入口）

```python
render_citation(format_id: str | None,
                template: str | None,
                meta: dict,
                book_page: int | None,
                book_page_end: int | None,
                pdf_page: int | None) -> str
```

模板解析优先级：
1. 若 `template` 非空 → 直接用 `template` 渲染（用户格式走这条）
2. 否则若 `format_id` 命中 `formats.py` 中的内置 → 用对应内置模板
3. 否则 → 回退默认 `"gbt7714"`，并在 stderr 记录一行"未知 format_id=<x>"以便排查

约束：用户格式调用必须传 `template`（前端从 IndexedDB 取出后传递）；Python 端不读 IndexedDB。

### 11.2 `lookup_quote` / `scan_document` 新增参数

```python
lookup_quote(quote, ctx,
             format_id: str | None = None,
             template: str | None = None)

scan_document(text, ...,
              format_id: str | None = None,
              template: str | None = None)
```

兼容旧调用：两者都 None → 默认 GB/T。

## 12. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Python/JS 渲染器输出不一致 | 共享 JSON 测试用例，CI 两端都跑 |
| 反推算法把"北京大学"里的"北京"先吃 | 长值倒序替换 + 回填验证供人眼审 |
| 用户写错模板 | 实时语法校验 + 红框 + 禁用保存 |
| IndexedDB 不可用（隐私模式） | 内置 3 个仍可用，UI 提示"用户格式不可用" |
| 智能识别误判格式 | 优先级 GB/T > 法学 > 历史研究；抽取结果可编辑 |
| SW 缓存旧文件 | CACHE_NAME v4→v5 + 新文件加入 SELF_ASSETS |

## 13. 实施分阶段建议

为减小一次性变更风险，建议按以下阶段提交：

1. **元数据扩展 + 内置 3 个格式**：扩展 Library schema、写 `formats.py`、改造 `citation.py` 为模板引擎、加 JS 镜像 `formats.js`；不动 UI（先把渲染管道做对，单测覆盖三种格式 × 完整/缺字段样书）
2. **全局选择器 + 卡片 chip**：UI 接入；用户可以切格式看效果，但还不能造新格式
3. **格式管理 tab + 模板编辑器**：CRUD + IndexedDB 接入；克隆 + 空白新建
4. **样例反推 + 导入导出**：完成"造格式"剩下两条路径
5. **智能识别扩展**：`parse_meta.py` 多格式探测

每阶段都是可独立部署的增量。

## 14. 待定 / 后续可选

- 批量给文件夹下书统一补 role/translator 的工具
- 预览样书可来自用户书库
- v2：可视化结构编辑器（B 方案）作为模板字符串的另一编辑模式
