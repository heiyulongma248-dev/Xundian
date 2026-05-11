# 寻典 · 网页版

把桌面版 1:1 迁移到浏览器：
- **PDF 抽文字** → `pdf.js`（原生 V8，速度接近桌面版）
- **匹配 / 简繁 / 引文抽取 / 渲染核对表** → Pyodide（WebAssembly CPython，复用桌面版核心算法）
- **PDF 文件位置** → File System Access API（浏览器记 handle，PDF 仍在你磁盘上）
- **书架 / 缓存 / 设置** → IndexedDB

## 必备条件

- **浏览器**：Chrome / Edge / 其它 Chromium 系（86+）。Firefox 与 Safari **不支持**（启动会被拦截）。
- **本地启动需要一个 HTTP 服务器**，因为 File System Access API 在 `file://` 协议下不可用。
  最简单的是用 Python 内置的：

```powershell
# 在项目根目录（这个 web/ 文件夹的父目录）下执行：
python -m http.server 8000
```

然后浏览器打开：**http://localhost:8000/web/**

> 不要打开 `file:///.../web/index.html` —— 浏览器会拒绝 `showOpenFilePicker`。

## 首次启动

第一次打开页面会下载 Pyodide（约 10 MB）+ 必要的 Python 包，预计 5–15 秒。
进度会显示在中间的启动遮罩上。之后浏览器会缓存，秒级开启。

## 功能对照

与桌面版 1:1：
- 📚 **我的书架**：添加 PDF、文件夹分类、多选批量操作、批量解析（带进度+取消）
- 📄 **文档扫描**：选 docx → 流式显示每条引文的命中情况 → 复制脚注 / 导出核对表
- 🔍 **单句查询**：贴一句话直接查出处
- ⚙ **设置**：阈值 / 语境权重 / top-K，保存在浏览器 IndexedDB

## 关键差异（与桌面版相比）

| 项目 | 桌面版 | 网页版 |
|---|---|---|
| 安装 | 需打包 + 装 | 打开 URL 即用 |
| 数据位置 | `%APPDATA%/XunDian/` | 浏览器 IndexedDB（每个域名独立） |
| PDF 文件 | 程序记本地路径 | 浏览器记 `FileSystemFileHandle`（PDF 仍在你电脑上） |
| PDF 跳页 | 调外部浏览器 | 当前浏览器新 tab + blob URL |
| 导出 docx | 系统保存对话框 | `showSaveFilePicker` 或 fallback 到下载文件夹 |

## 目录结构

```
web/
├── index.html              主页面 + 启动遮罩
├── app.js                  前端逻辑（与桌面版同源，IO 层换成桥）
├── style.css               直接复用桌面版
├── icon.png                直接复用桌面版
├── py-bridge.js            Pyodide 加载器 + RPC
├── fs-bridge.js            File System Access API 包装
├── pdf-extract.js          pdf.js 包装（抽 PDF 文字层，跑在 V8 里）
├── db.js                   IndexedDB 包装
├── manifest.json           PWA 元数据
├── service-worker.js       PWA 离线缓存（默认未启用，见下文）
└── pysrc/
    ├── extract_quotes.py   接受 bytes（其余不变）
    ├── pdf_text.py         只剩后处理（PageText / is_low_quality / 书内页码识别）
    ├── matcher.py          与桌面版完全一致
    ├── citation.py         与桌面版完全一致
    ├── render_report.py    返回 bytes（不再写文件）
    └── web_api.py          替代 api.py，提供 Pyodide 内的 Api 单例
```

## Service Worker（PWA 离线模式）

`service-worker.js` 文件已就绪，但 **默认未在 `index.html` 里注册** —
这是为了首轮调试时不被旧缓存坑到（改完代码刷新会拿到新版本，不会被 SW 缓存挡住）。

确认网页版功能稳定后，在 `index.html` 底部加上：
```html
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js');
}
</script>
```
即可启用离线模式 —— 二次访问 1 秒内打开，断网也能用已加书架。

## 验收清单（来自《网页版开发指南.md》)

阶段 2 完成需通过：
- [ ] 三 tab UI 与桌面版视觉一致
- [ ] 加书 → 解析 → 进度条流式显示
- [ ] 关掉浏览器重开，书架仍在（IndexedDB 持久化）
- [ ] 选 docx 扫描，结果流式出
- [ ] 命中条目「📋 复制脚注」能粘贴到外部
- [ ] 命中条目「📖 在 PDF 中查看」新 tab 跳到对应页
- [ ] 导出核对表 docx，下载后字体一致（中文宋体、英文 Times New Roman）
- [ ] 桌面版基准测试结果一致（详见指南 §7）

## 已知限制

1. **pdf.js 与 pypdf 文字层提取可能有微小差异**（换行/空格处理不同）。但 matcher
   归一化阶段会去掉所有空白与标点，对匹配结果几乎无影响。
2. **`opencc-python-reimplemented` 可能装不上** — 装不上时 matcher.py 自动回落
   到内置简繁映射表，繁体字覆盖会比桌面版略弱，但对胡适语料这样的常见简繁混排足够。
3. **拖放 docx 进扫描区**已经支持；拖放 PDF 进书架暂不支持（需要从拖入 file
   反推 FileSystemFileHandle，浏览器目前还没有稳定 API）。
