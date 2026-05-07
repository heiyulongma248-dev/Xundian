# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置 — 寻典 v1.0 macOS 版

构建命令（在项目根目录跑，必须在 Mac 上）：
    pyinstaller build/xundian-mac.spec --noconfirm --clean

产出：
    dist/寻典.app/         — macOS 应用包
        Contents/
        ├── MacOS/寻典      — 主可执行文件
        ├── Resources/      — 图标 + frontend + 全部依赖
        └── Info.plist      — 元数据

注意：
- 必须在 macOS 上跑 PyInstaller，不能跨平台编译
- 必须事先 pip install pyobjc-core pyobjc-framework-WebKit pyobjc-framework-Cocoa
- 必须事先把 build/icon-256.png 转换为 build/icon.icns（构建脚本里会做）
"""

from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_data_files

# 项目根（spec 在 build/ 下）
ROOT = Path(SPECPATH).parent.resolve()

# —— 收集第三方包的全部依赖 ——

# opencc：简繁字典
opencc_datas, opencc_binaries, opencc_hiddenimports = collect_all('opencc')

# pywebview：JS 注入文件 + 后端模块
webview_datas = collect_data_files('webview')

# pyobjc：Mac 上 pywebview 用 Cocoa/WebKit 后端，需要它
pyobjc_hiddenimports = []
for pkg in [
    'objc',
    'Foundation',
    'AppKit',
    'Cocoa',
    'WebKit',
    'PyObjCTools',
]:
    try:
        d, b, h = collect_all(pkg)
        opencc_datas += d
        opencc_binaries += b
        pyobjc_hiddenimports += h
    except Exception:
        pass

# 图标：构建脚本会先把 icon-256.png 转成 icon.icns
icon_path = ROOT / 'build' / 'icon.icns'
icon_arg = str(icon_path) if icon_path.exists() else None


a = Analysis(
    [str(ROOT / 'app.py')],
    pathex=[str(ROOT)],
    binaries=opencc_binaries,
    datas=[
        # 应用自身资源
        (str(ROOT / 'frontend'), 'frontend'),
        # 图标如果已生成也带上（app.py 会找）
    ] + ([(str(icon_path), 'build')] if icon_arg else [])
      + opencc_datas + webview_datas,
    hiddenimports=[
        'webview.platforms.cocoa',
        *opencc_hiddenimports,
        *pyobjc_hiddenimports,
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
    excludes=[
        # 排除不用的大包
        'tkinter', 'matplotlib', 'numpy', 'scipy',
        'pandas', 'PIL', 'sqlite3', 'unittest', 'test',
        'pydoc', 'doctest',
        # Windows 专属，Mac 不用
        'clr', 'clr_loader', 'pythonnet',
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
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
    icon=icon_arg,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,    # 跟随构建机器（Apple Silicon 出 arm64，Intel 出 x86_64）
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
    name='寻典',  # 中间产物
)

# macOS BUNDLE：把 COLLECT 的内容打成 .app
app = BUNDLE(
    coll,
    name='寻典.app',
    icon=icon_arg,
    bundle_identifier='com.xundian.app',
    info_plist={
        'NSHighResolutionCapable': 'True',
        'NSPrincipalClass': 'NSApplication',
        'CFBundleName': '寻典',
        'CFBundleDisplayName': '寻典',
        'CFBundleVersion': '1.0',
        'CFBundleShortVersionString': '1.0',
        'CFBundleExecutable': '寻典',
        'LSMinimumSystemVersion': '10.13',
        # 中文界面
        'CFBundleLocalizations': ['zh_CN', 'en'],
        'CFBundleDevelopmentRegion': 'zh_CN',
    },
)
