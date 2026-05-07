"""
把 dist/寻典 Mac 构建包 目录打成 zip，关键：
- .command 文件保留 Unix 0755 可执行权限
- 其他文件 0644
- 使用 LF 行尾（Mac/Linux bash 要求）
- UTF-8 文件名（macOS 解压时正确显示中文）
"""
import os
import sys
import zipfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

KIT_DIR = Path(r"E:\PycharmProjects\PythonProject\CitationLookup\dist\寻典 Mac 构建包")
ZIP_PATH = Path(r"E:\PycharmProjects\PythonProject\CitationLookup\dist\寻典 Mac 构建包.zip")

if not KIT_DIR.exists():
    sys.exit(f"找不到目录：{KIT_DIR}")

EXECUTABLE_SUFFIXES = {".command", ".sh"}


def file_perm(rel_path: Path) -> int:
    """返回 zip 里要存的 unix 权限位（高 16 位）。"""
    suffix = rel_path.suffix.lower()
    if suffix in EXECUTABLE_SUFFIXES:
        # rwxr-xr-x（0755）
        return (0o100755 << 16)
    return (0o100644 << 16)


def main():
    if ZIP_PATH.exists():
        ZIP_PATH.unlink()

    file_count = 0
    exec_count = 0

    # 用 ZIP_DEFLATED 压缩；用 UTF-8 文件名（默认即可）
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED, allowZip64=False) as zf:
        # 遍历 KIT_DIR 下所有文件
        for root, dirs, files in os.walk(KIT_DIR):
            # 排除 .DS_Store、__pycache__ 等
            dirs[:] = [d for d in dirs if d not in {"__pycache__", ".venv-mac-build"}]
            for f in files:
                if f.startswith(".DS_Store") or f.endswith(".pyc"):
                    continue
                full = Path(root) / f
                # zip 里的路径 = 顶级目录 + 相对路径（保留中文目录名）
                rel = full.relative_to(KIT_DIR.parent)
                arcname = rel.as_posix()  # zip 用 / 分隔

                # 创建 ZipInfo，手动指定权限
                zi = zipfile.ZipInfo(arcname, date_time=full.stat().st_mtime
                                     and tuple(__import__("datetime").datetime
                                              .fromtimestamp(full.stat().st_mtime)
                                              .timetuple()[:6]))
                zi.external_attr = file_perm(rel)
                zi.compress_type = zipfile.ZIP_DEFLATED

                with open(full, "rb") as fp:
                    zf.writestr(zi, fp.read())

                file_count += 1
                if rel.suffix.lower() in EXECUTABLE_SUFFIXES:
                    exec_count += 1
                    print(f"  + {arcname}  [可执行 0755]")
                else:
                    print(f"  + {arcname}")

    size_mb = ZIP_PATH.stat().st_size / (1024 * 1024)
    print()
    print(f"✓ 已生成：{ZIP_PATH}")
    print(f"  共 {file_count} 个文件（其中 {exec_count} 个标记为可执行）")
    print(f"  压缩后大小：{size_mb:.2f} MB")


if __name__ == "__main__":
    main()
