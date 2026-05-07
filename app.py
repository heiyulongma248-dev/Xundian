"""寻典 — 桌面应用入口。

启动一个 pywebview 窗口，加载 frontend/index.html。
"""
from __future__ import annotations

import sys
from pathlib import Path

# 让 PyInstaller --onedir 模式下也能找到 frontend/
def _resource_path(*parts) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base.joinpath(*parts)


def main():
    import webview
    from api import Api

    api = Api()
    index_html = _resource_path("frontend", "index.html")
    if not index_html.exists():
        raise FileNotFoundError(f"找不到前端文件：{index_html}")

    window = webview.create_window(
        title="寻典 — 引文定位与脚注助手",
        url=str(index_html),
        js_api=api,
        width=1100,
        height=750,
        min_size=(900, 600),
    )
    api.set_window(window)

    debug = "--debug" in sys.argv

    # 图标（pywebview 5.x 支持 icon 参数；找不到就回落到默认）
    icon_path = _resource_path("build", "icon.ico")
    start_kwargs = {"debug": debug}
    if icon_path.exists():
        start_kwargs["icon"] = str(icon_path)

    try:
        webview.start(**start_kwargs)
    except TypeError:
        # 旧版 pywebview 不识 icon 参数
        webview.start(debug=debug)


if __name__ == "__main__":
    main()
