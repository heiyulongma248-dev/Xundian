# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置 — 寻典 v1.0 Windows 版

构建命令（在项目根目录跑）：
    python -m PyInstaller build/xundian.spec --noconfirm --clean

产出：
    dist/寻典/             — onedir 模式输出
    ├── 寻典.exe
    ├── _internal/        — Python 运行时 + 全部依赖
    ├── frontend/         — HTML/CSS/JS（被 app.py 找到）
    └── build/icon.ico    — 图标（被 app.py 找到）
"""

from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_data_files

# 项目根（spec 文件位于 build/ 下，所以根是 ..）
ROOT = Path(SPECPATH).parent.resolve()

# —— 收集第三方包的全部依赖（关键步骤） ——

# opencc：简繁转换有 ~10 个 .json 字典 + .py 文件，必须全收
opencc_datas, opencc_binaries, opencc_hiddenimports = collect_all('opencc')

# pywebview：要 JS 注入文件 + 后端模块
webview_datas = collect_data_files('webview')
webview_hiddenimports = [
    'webview.platforms.edgechromium',
    'webview.platforms.winforms',
]

# clr / pythonnet：.NET 互操作的 dll
clr_datas, clr_binaries, clr_hiddenimports = collect_all('clr')
clr_loader_datas, clr_loader_binaries, clr_loader_hiddenimports = collect_all('clr_loader')
pythonnet_datas, pythonnet_binaries, pythonnet_hiddenimports = collect_all('pythonnet')


a = Analysis(
    [str(ROOT / 'app.py')],
    pathex=[str(ROOT)],
    binaries=opencc_binaries + clr_binaries + clr_loader_binaries + pythonnet_binaries,
    datas=[
        # 应用自身的资源
        (str(ROOT / 'frontend'), 'frontend'),
        (str(ROOT / 'build' / 'icon.ico'), 'build'),
    ] + opencc_datas + webview_datas + clr_datas + clr_loader_datas + pythonnet_datas,
    hiddenimports=[
        *webview_hiddenimports,
        *opencc_hiddenimports,
        *clr_hiddenimports,
        *clr_loader_hiddenimports,
        *pythonnet_hiddenimports,
        'docx',
        'pypdf',
        # 自家代码
        'src',
        'src.library',
        'src.extract_quotes',
        'src.pdf_text',
        'src.matcher',
        'src.citation',
        'src.render_report',
    ],
    hookspath=[],
    runtime_hooks=[],
    # 排除一批我们用不上但 PyInstaller 默认会追的大包，能砍掉 50+ MB
    excludes=[
        'tkinter', 'matplotlib', 'numpy', 'scipy',
        'pandas', 'PIL', 'sqlite3', 'unittest', 'test',
        'pydoc', 'doctest',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='寻典',
    icon=str(ROOT / 'build' / 'icon.ico'),
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # 不用 UPX 压缩；与杀软冲突概率高，且会大幅拖慢启动
    console=False,        # 没有黑色命令窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='寻典',          # dist/寻典/
)
