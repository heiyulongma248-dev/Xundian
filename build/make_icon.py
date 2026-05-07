"""把 xundian.png 转成多分辨率 icon.ico。

策略：先按 256/128/64/48/32/16 各做一次高质量 Lanczos 缩放（避免 ICO 内置缩放有时偏糊），
再合成为一个 .ico 文件，让 Windows 在不同尺寸场景下自动挑用。
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "xundian.png"
DST = ROOT / "icon.ico"

ICON_SIZES = [16, 32, 48, 64, 128, 256]


def main():
    if not SRC.exists():
        raise FileNotFoundError(f"找不到源图：{SRC}")

    src = Image.open(SRC).convert("RGBA")
    print(f"源图：{src.size} {src.mode}")

    # 逐尺寸独立缩放，最大保真
    versions = []
    for size in ICON_SIZES:
        v = src.resize((size, size), Image.LANCZOS)
        versions.append(v)
        print(f"  生成 {size}×{size}")

    # 用最大那张（256）作为主图，其他尺寸塞到 sizes 参数里
    versions[-1].save(
        DST,
        format="ICO",
        sizes=[(s, s) for s in ICON_SIZES],
        append_images=versions[:-1],
    )
    print(f"\n输出：{DST}")
    print(f"大小：{DST.stat().st_size / 1024:.1f} KB")

    # 顺便存一份 256 PNG 以备需要
    png_preview = ROOT / "icon-256.png"
    versions[-1].save(png_preview, format="PNG")
    print(f"PNG 预览：{png_preview}")


if __name__ == "__main__":
    main()
