#!/bin/bash
# ============================================================
# 寻典 Mac 一键构建脚本
# 双击此文件即可自动完成所有构建步骤
# ============================================================

set -e
set -o pipefail

# —— 颜色 ——
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

# —— 切到脚本所在目录（构建包根）—— 注意不要 cd ..，否则会跑到父目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
PROJECT_ROOT="$(pwd)"

# —— 清掉系统代理设置（许多 Mac 上有失效的代理 env，会让 pip 卡死）——
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

# —— pip 优先使用清华镜像（国内访问 PyPI 主站常超时）——
PIP_INDEX_PRIMARY="https://pypi.tuna.tsinghua.edu.cn/simple/"
PIP_INDEX_FALLBACK="https://pypi.org/simple/"

pip_install_safe() {
    # 先用清华镜像，挂了自动退到 PyPI 主站
    if pip install -i "$PIP_INDEX_PRIMARY" --disable-pip-version-check "$@" 2>&1 \
        | grep -v "^WARNING: Retrying" | grep -v "ProxyError" | grep -v "^WARNING: " ; then
        return 0
    fi
    warn "清华镜像安装失败，改用 PyPI 主站重试…"
    pip install -i "$PIP_INDEX_FALLBACK" --disable-pip-version-check "$@" 2>&1 \
        | grep -v "^WARNING: Retrying" | grep -v "ProxyError" | grep -v "^WARNING: "
}

# —— 输出函数 ——
banner() {
    echo
    echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}${BOLD}  寻典 Mac 一键构建${NC}"
    echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
}

step() {
    echo
    echo -e "${BLUE}${BOLD}>>> $1${NC}"
}

ok() { echo -e "    ${GREEN}✓${NC} $1"; }
info() { echo -e "    ${GRAY}$1${NC}"; }
warn() { echo -e "    ${YELLOW}⚠${NC} $1"; }

fail() {
    echo
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}${BOLD}  ✗ 构建失败${NC}"
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}$1${NC}"
    echo
    echo -e "${YELLOW}如需技术支持，请把以上整个终端输出截图发给开发者。${NC}"
    echo
    read -p "按 Enter 关闭此窗口…"
    exit 1
}

# ============================================================
banner

# ============================================================
# 1. 检查 Python
# ============================================================
step "1/6  检查 Python"

# 把常见 Python 安装位置主动加到 PATH 最前
# 这样脚本无论从哪里启动（双击 .command 时 PATH 可能很短），都能找到 python.org / Homebrew 装的 Python
export PATH="/usr/local/bin:/opt/homebrew/bin:\
/Library/Frameworks/Python.framework/Versions/3.13/bin:\
/Library/Frameworks/Python.framework/Versions/3.12/bin:\
/Library/Frameworks/Python.framework/Versions/3.11/bin:\
/Library/Frameworks/Python.framework/Versions/3.10/bin:\
$PATH"

# 不再让 set -e 在 Python 探测阶段把脚本秒杀
set +e

PYTHON_BIN=""

# Step 1.1：优先找带版本号的 python (python3.13 / 3.12 / ...)
# 关键：明确避开 /usr/bin/python3——它是 macOS 自带的空壳，调用时会触发 xcode-select 弹窗
for ver in python3.13 python3.12 python3.11 python3.10; do
    p=$(command -v "$ver" 2>/dev/null)
    if [ -n "$p" ] && [ "$p" != "/usr/bin/python3" ]; then
        # 真能跑（import sys 不报错）才算数
        if "$p" -c 'import sys' >/dev/null 2>&1; then
            PYTHON_BIN="$p"
            break
        fi
    fi
done

# Step 1.2：没找到带版本号的，按已知绝对路径再试一次
if [ -z "$PYTHON_BIN" ]; then
    for candidate in \
        /usr/local/bin/python3 \
        /opt/homebrew/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/3.10/bin/python3; do
        if [ -x "$candidate" ]; then
            if "$candidate" -c 'import sys' >/dev/null 2>&1; then
                PYTHON_BIN="$candidate"
                break
            fi
        fi
    done
fi

# Step 1.3：实在找不到才报错（绝不调用 /usr/bin/python3，避免触发 xcode-select 弹窗）
if [ -z "$PYTHON_BIN" ]; then
    echo
    echo -e "${RED}    ✗ 未找到可用的 Python 3${NC}"
    echo
    echo -e "${YELLOW}    可能原因：${NC}"
    echo -e "    1. 系统没装 Python — 请到 https://www.python.org/downloads/macos/ 下载安装"
    echo -e "       选 ${BOLD}macOS 64-bit universal2 installer${NC}（.pkg），双击一路下一步"
    echo -e "    2. 已装 Python 但 PATH 未刷新 — ${BOLD}关闭此窗口、重新双击 构建寻典.command${NC}"
    echo -e "    3. 某些版本的 macOS 里需要重启 Mac 后 PATH 才生效"
    echo
    echo -e "${GRAY}    （我们故意不调用 /usr/bin/python3，因为那是个空壳，会弹 Xcode 安装框）${NC}"
    echo
    open "https://www.python.org/downloads/macos/" 2>/dev/null || true
    echo
    read -p "按 Enter 关闭此窗口…"
    exit 1
fi

# 拿到版本号
PYVER=$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")' 2>/dev/null)
PYMAJOR=$("$PYTHON_BIN" -c 'import sys; print(sys.version_info.major)' 2>/dev/null)
PYMINOR=$("$PYTHON_BIN" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null)

if [ -z "$PYVER" ]; then
    fail "Python 找到了（$PYTHON_BIN），但调用失败。可能是装坏了——请重装 Python 后再试。"
fi

if [ "$PYMAJOR" -lt 3 ] || { [ "$PYMAJOR" -eq 3 ] && [ "$PYMINOR" -lt 10 ]; }; then
    fail "Python 版本太旧（当前 $PYVER），需要 3.10 或更新。请到 python.org 下载新版后再试。"
fi

# 后续步骤恢复 set -e（任一步失败即停）
set -e

ok "找到 Python $PYVER"
info "路径：$PYTHON_BIN"

# ============================================================
# 2. 建虚拟环境
# ============================================================
step "2/6  建立虚拟环境"

VENV_DIR=".venv-mac-build"
if [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/python" ]; then
    info "已存在虚拟环境，复用之"
else
    rm -rf "$VENV_DIR"
    "$PYTHON_BIN" -m venv "$VENV_DIR" || fail "建立虚拟环境失败。"
fi

# 激活
source "$VENV_DIR/bin/activate"
ok "虚拟环境就绪：$VENV_DIR"

# ============================================================
# 3. 装依赖
# ============================================================
step "3/6  安装依赖（首次约 1-2 分钟，走清华镜像）"

info "升级 pip..."
pip_install_safe --upgrade pip || true  # pip 升不上去不致命

info "安装 requirements-mac.txt..."
if [ ! -f "build/requirements-mac.txt" ]; then
    fail "找不到 build/requirements-mac.txt。当前目录：$(pwd)。说明你解压的构建包不完整——请重新解压 zip 后再试。"
fi
pip_install_safe -r build/requirements-mac.txt || \
    fail "依赖安装失败。可能原因：①网络不通；②镜像源都挂了；③某个依赖包在 Mac 上需要编译。把以上整段终端输出截图发给开发者排查。"

ok "全部依赖已就绪"

# ============================================================
# 4. 准备 Mac 图标 (.icns)
# ============================================================
step "4/6  准备 Mac 图标"

ICNS_PATH="build/icon.icns"
PNG_PATH="build/icon-256.png"

if [ -f "$ICNS_PATH" ]; then
    info "icon.icns 已存在，跳过"
elif [ -f "$PNG_PATH" ] && command -v iconutil &> /dev/null && command -v sips &> /dev/null; then
    info "用 iconutil + sips 从 icon-256.png 生成 icon.icns..."
    ICONSET="build/icon.iconset"
    rm -rf "$ICONSET"
    mkdir -p "$ICONSET"

    # 各档位尺寸都生成（macOS 需要这一组）
    sips -z 16 16     "$PNG_PATH" --out "$ICONSET/icon_16x16.png" >/dev/null 2>&1
    sips -z 32 32     "$PNG_PATH" --out "$ICONSET/icon_16x16@2x.png" >/dev/null 2>&1
    sips -z 32 32     "$PNG_PATH" --out "$ICONSET/icon_32x32.png" >/dev/null 2>&1
    sips -z 64 64     "$PNG_PATH" --out "$ICONSET/icon_32x32@2x.png" >/dev/null 2>&1
    sips -z 128 128   "$PNG_PATH" --out "$ICONSET/icon_128x128.png" >/dev/null 2>&1
    sips -z 256 256   "$PNG_PATH" --out "$ICONSET/icon_128x128@2x.png" >/dev/null 2>&1
    cp "$PNG_PATH" "$ICONSET/icon_256x256.png"
    # 512 / 1024 直接复制 256（图标小 app 也能用）
    cp "$PNG_PATH" "$ICONSET/icon_256x256@2x.png"
    cp "$PNG_PATH" "$ICONSET/icon_512x512.png"
    cp "$PNG_PATH" "$ICONSET/icon_512x512@2x.png"

    iconutil -c icns "$ICONSET" -o "$ICNS_PATH" || fail "iconutil 转 icns 失败。"
    rm -rf "$ICONSET"
    ok "已生成 $ICNS_PATH"
else
    warn "缺少 icon-256.png 或 sips/iconutil — app 图标会用默认"
fi

# ============================================================
# 5. PyInstaller 打包
# ============================================================
step "5/6  打包应用（约 30-90 秒，请耐心等待）"

# 清旧产物
rm -rf "dist/寻典.app" "build/寻典"

info "调用 PyInstaller，输出已被简化以便阅读..."

# 用 stdbuf -i0 -o0 让 grep 不缓冲（macOS 默认无 stdbuf，改用 perl 行缓冲）
pyinstaller build/xundian-mac.spec --noconfirm --clean --log-level=WARN 2>&1 | \
    perl -ne '$|=1; print unless /^\s*\d+\s+INFO/;' || \
    fail "PyInstaller 打包失败。详情见 build/寻典/warn-寻典.txt（如果存在）。"

if [ ! -d "dist/寻典.app" ]; then
    fail "打包没有产生 dist/寻典.app。可能依赖没装齐——查看上面的错误信息。"
fi

ok "已生成 dist/寻典.app"

# 给 .app 加可执行权限（保险起见）
chmod -R +x "dist/寻典.app/Contents/MacOS/" 2>/dev/null || true

# 移除 quarantine 属性，让用户首次打开更顺
xattr -dr com.apple.quarantine "dist/寻典.app" 2>/dev/null || true

# ============================================================
# 6. 完成
# ============================================================
step "6/6  完成！"
echo

APP_SIZE=$(du -sh "dist/寻典.app" 2>/dev/null | cut -f1 || echo "未知")
echo -e "  ${BOLD}📦 产出${NC}：${GREEN}$PROJECT_ROOT/dist/寻典.app${NC}"
echo -e "      （体积约 $APP_SIZE）"
echo
if [ -f "dist/寻典使用说明.pdf" ]; then
    echo -e "  ${BOLD}📖 配套手册${NC}：$PROJECT_ROOT/dist/寻典使用说明.pdf"
    echo
fi

echo -e "${YELLOW}${BOLD}下一步：${NC}"
echo -e "  ${BOLD}1.${NC} 把 ${BOLD}dist/寻典.app${NC} 和 ${BOLD}dist/寻典使用说明.pdf${NC} 一起压成 zip"
echo -e "  ${BOLD}2.${NC} 把 zip 发给最终用户"
echo -e "  ${BOLD}3.${NC} 用户解压后 ${BOLD}右键 → 打开${NC} 寻典.app（首次需绕过 Gatekeeper）"
echo

# Finder 中选中产出
if command -v open &> /dev/null; then
    open -R "dist/寻典.app" 2>/dev/null || true
fi

echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  ✓ 全部完成${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
read -p "按 Enter 关闭此窗口…"
