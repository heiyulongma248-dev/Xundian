// 寻典网页版 — Pyodide 桥
// 负责：
//   1. 加载 Pyodide + 必需的 Python 包（pypdf / python-docx / opencc 可选）
//   2. 把本项目的 pysrc/*.py 写到 Pyodide 虚拟文件系统
//   3. 实例化 Api 单例，暴露 await py.call('method', ...args) 入口
//   4. JS ↔ Python 之间的对象转换由本桥统一做掉，业务代码看到的都是普通 JS 对象

'use strict';

const PYODIDE_VERSION = '0.27.7';
// 同源加载（web/lib/pyodide/），避免依赖 cdn.jsdelivr.net —— 国内访问更稳定，
// 也支持完全离线（Service Worker 缓存后）。
// 如果你要换回 CDN，把下面这行改成：
//   const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PYODIDE_INDEX_URL = 'lib/pyodide/';

// 拆成两组：
// - BUNDLED：Pyodide 内置仓库里有，走 pyodide.loadPackage()（快）
// - PYPI：走 micropip.install() 从 PyPI 拉
// 注：默认 PDF 抽文字由 JS 端的 pdf.js 完成（快）。
//     但对 OCR 扫描 PDF（Type 3 字体 / 不可见文字层）pdf.js 经常抽空，
//     所以仍保留 pypdf 作为兜底解析器 —— 慢但兼容性好。
// opencc 在 PyPI 上有纯 Python 重实现（opencc-python-reimplemented），装不上就走
// matcher.py 内置简繁映射表。
const BUNDLED_PACKAGES = ['lxml', 'micropip'];
const PYPI_PACKAGES = ['python-docx', 'pypdf'];
const OPTIONAL_PYPI_PACKAGES = ['opencc-python-reimplemented'];

// 跟 pysrc/ 下文件名一一对应；加载顺序无所谓，import 时按需触发
const PY_FILES = [
  '__init__.py',
  'extract_quotes.py',
  'pdf_text.py',
  'matcher.py',
  'citation.py',
  'render_report.py',
  'web_api.py',
];

class PyBridge {
  constructor() {
    this.pyodide = null;
    this.api = null;          // PyProxy of api instance in web_api.py
    this.ready = false;
    this._readyPromise = null;
    this.onPhase = null;      // 加载阶段回调，参数 { phase, detail }
    this._optionalLoaded = {};
  }

  async init() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = this._doInit();
    return this._readyPromise;
  }

  _phase(phase, detail = '') {
    if (typeof this.onPhase === 'function') {
      try { this.onPhase({ phase, detail }); } catch (_) {}
    }
  }

  async _doInit() {
    // 1. 注入 Pyodide 加载脚本（CDN）
    if (typeof loadPyodide === 'undefined') {
      this._phase('loading_pyodide', '下载 Pyodide…');
      await this._injectScript(`${PYODIDE_INDEX_URL}pyodide.js`);
    }

    // 2. 加载 Pyodide
    this._phase('init_pyodide', '初始化 Python 解释器…');
    // eslint-disable-next-line no-undef
    this.pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });

    // 3a. 装内置包：lxml + micropip
    this._phase('install_packages', `加载基础包（${BUNDLED_PACKAGES.join(', ')}）…`);
    await this.pyodide.loadPackage(BUNDLED_PACKAGES);

    // 3b. 用 micropip 从 PyPI 装纯 Python 包
    const micropip = this.pyodide.pyimport('micropip');
    this._phase('install_packages', `从 PyPI 安装：${PYPI_PACKAGES.join(', ')}…`);
    await micropip.install(this.pyodide.toPy(PYPI_PACKAGES));

    // 装完后立刻验证各个包能 import —— 提前暴露问题，
    // 比解析时才发现 ModuleNotFoundError 强得多
    for (const pkg of PYPI_PACKAGES) {
      const importName = (pkg === 'python-docx') ? 'docx' : pkg.replace(/-/g, '_');
      try {
        await this.pyodide.runPythonAsync(`import ${importName}`);
      } catch (e) {
        console.error(`[py-bridge] ${pkg} 安装后 import ${importName} 失败：`, e);
        throw new Error(`Python 包 ${pkg} 装好了但 import 失败：${e}`);
      }
    }

    // 4. 尝试装可选包（opencc）；装不上就走 matcher.py 的内置 fallback
    for (const pkg of OPTIONAL_PYPI_PACKAGES) {
      try {
        this._phase('install_optional', `尝试安装 ${pkg}（可选）…`);
        await micropip.install(this.pyodide.toPy([pkg]));
        this._optionalLoaded[pkg] = true;
      } catch (e) {
        this._optionalLoaded[pkg] = false;
        // 控制台留个痕迹，不打扰用户
        console.warn(`[py-bridge] 可选包 ${pkg} 没装上，将使用内置简繁映射表。`, e);
      }
    }

    // 5. 把 pysrc/*.py 拷到 Pyodide 虚拟文件系统的 /home/pyodide/pysrc/
    this._phase('mount_sources', '加载寻典核心模块…');
    this.pyodide.FS.mkdirTree('/home/pyodide/pysrc');
    for (const filename of PY_FILES) {
      const src = await this._fetchText(`pysrc/${filename}`);
      this.pyodide.FS.writeFile(`/home/pyodide/pysrc/${filename}`, src);
    }

    // 6. import + 拿到 Api 实例
    this._phase('import_api', '初始化 API…');
    await this.pyodide.runPythonAsync(`
import sys
if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')
from pysrc.web_api import api
`);
    this.api = this.pyodide.globals.get('api');
    if (!this.api) throw new Error('Python api 单例未生成（pysrc/web_api.py 出错？）');

    this.ready = true;
    this._phase('ready', '就绪');
  }

  // —— 私有：注入 <script src=...> 并等加载完成 ——
  _injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`加载 ${src} 失败`));
      document.head.appendChild(s);
    });
  }

  async _fetchText(path) {
    // 相对当前 HTML 的路径；http-server 跑在 web/ 目录下时 'pysrc/x.py' 正好能找到
    const r = await fetch(path);
    if (!r.ok) throw new Error(`无法读取 ${path}：HTTP ${r.status}`);
    return await r.text();
  }

  // —— 主入口：调 Python 方法 ——
  // 用法：const result = await py.call('scan_document', docxBytes, booksData, booksMeta);
  // - 自动把 JS 参数深度转换为 Python 对象（Object → dict, Array → list, Uint8Array 原样）
  // - 自动把 Python 返回值转回纯 JS 对象（dict → Object）
  async call(method, ...args) {
    if (!this.ready) await this.init();
    if (!(method in this.api)) {
      throw new Error(`Python 方法不存在：${method}`);
    }
    // 深度转 JS → Python（这样 Python 看到的就是普通 dict/list，
    // 不必每个方法里手写 to_py）
    const pyArgs = args.map((a) => this._toPy(a));
    let pyResult;
    try {
      pyResult = this.api[method](...pyArgs);
      // 自动等待 awaitable
      if (pyResult && typeof pyResult.then === 'function') {
        pyResult = await pyResult;
      }
    } finally {
      // 释放参数 proxy（如果有）
      for (const a of pyArgs) {
        if (a && typeof a.destroy === 'function') a.destroy();
      }
    }
    return this._toJs(pyResult);
  }

  _toPy(value) {
    if (value === null || value === undefined) return value;
    // Uint8Array / ArrayBuffer 直接传，Python 端 bytes() 即可
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    // 函数：包成 PyProxy（Pyodide 会把它当成 async function 处理）
    if (typeof value === 'function') {
      return this.pyodide.toPy(value);
    }
    // 普通对象 / 数组 / 标量
    if (typeof value === 'object' || Array.isArray(value)) {
      return this.pyodide.toPy(value);
    }
    return value;
  }

  _toJs(value) {
    if (value === null || value === undefined) return value;
    // PyProxy 有 toJs 方法
    if (value && typeof value.toJs === 'function') {
      const js = value.toJs({ dict_converter: Object.fromEntries });
      try { value.destroy(); } catch (_) {}
      return js;
    }
    return value;
  }

  // —— 同步调用（少数地方需要，比如 cancel_parsing）——
  callSync(method, ...args) {
    if (!this.ready) throw new Error('Python 还没就绪');
    const pyArgs = args.map((a) => this._toPy(a));
    let pyResult;
    try {
      pyResult = this.api[method](...pyArgs);
    } finally {
      for (const a of pyArgs) {
        if (a && typeof a.destroy === 'function') a.destroy();
      }
    }
    return this._toJs(pyResult);
  }
}

window.py = new PyBridge();
