#!/usr/bin/env bash
# ---
# name: docx-env-setup (macOS / Linux)
# description: Environment detection, dependency check & install for DOCX skill on macOS and Linux.
# ---
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}○${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

# ── Resolve DOCX_SKILL_DIR ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCX_SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export DOCX_SKILL_DIR

echo "============================================"
echo "  DOCX Skill — Environment Setup"
echo "  (macOS / Linux)"
echo "============================================"
echo ""

# ── Step 1: Platform Detection ──
OS="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: $OS $ARCH"

if [ "$OS" = "Darwin" ]; then
    PLATFORM="mac"
elif [ "$OS" = "Linux" ]; then
    PLATFORM="linux"
else
    echo "Unsupported platform: $OS. For Windows use env_setup/setup_windows.ps1"
    exit 1
fi

echo "Detected: $PLATFORM"
echo "DOCX_SKILL_DIR=$DOCX_SKILL_DIR"
echo ""

# ── China mirror detection & config ──
USE_CN_MIRROR=false
PIP_MIRROR_ARGS=""
NPM_MIRROR_ARGS=""

if [ "${USE_CN_MIRROR_FORCE:-}" = "true" ]; then
    USE_CN_MIRROR=true
elif curl -s --connect-timeout 3 https://pypi.org > /dev/null 2>&1; then
    USE_CN_MIRROR=false
else
    warn "pypi.org unreachable — enabling China mirrors"
    USE_CN_MIRROR=true
fi

if [ "$USE_CN_MIRROR" = true ]; then
    PIP_MIRROR_ARGS="-i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn"
    NPM_MIRROR_ARGS="--registry https://registry.npmmirror.com"
    info "China mirrors enabled (pip: tuna, npm: npmmirror)"
    echo ""
fi

ERRORS=0

# ── Step 2a: Homebrew (macOS only) ──
if [ "$PLATFORM" = "mac" ]; then
    echo "--- [1/7] Homebrew (macOS package manager) ---"
    if command -v brew &>/dev/null; then
        ok "brew installed"
    else
        fail "brew not found"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
fi

# ── Step 2b: Node.js + npm ──
echo "--- [2/7] Node.js + npm ---"
if command -v node &>/dev/null; then
    ok "node ($(node --version))"
else
    fail "node not found (required — docx generation uses docx-js on Node)"
    case "$PLATFORM" in
        mac)   info "Install: brew install node" ;;
        linux) info "Install: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
               info "         sudo apt install -y nodejs"
               if [ "$USE_CN_MIRROR" = true ]; then
                   info "China alt: https://npmmirror.com/mirrors/node/"
               fi ;;
    esac
    ERRORS=$((ERRORS + 1))
fi

if command -v npm &>/dev/null; then
    ok "npm ($(npm --version))"
else
    fail "npm not found"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# ── Step 2c: npm package: docx ──
echo "--- [3/7] npm package: docx ---"
if node -e "require('docx')" 2>/dev/null || npm list -g docx &>/dev/null; then
    DOCX_VER=$(node -e "try{console.log(require('docx/package.json').version)}catch(e){console.log('installed')}" 2>/dev/null)
    ok "docx ($DOCX_VER)"
else
    fail "docx not installed"
    info "Installing docx..."
    if [ "$USE_CN_MIRROR" = true ]; then
        npm install -g docx $NPM_MIRROR_ARGS 2>/dev/null && ok "Installed: docx" \
            || { fail "npm install failed. Try: npm install -g docx $NPM_MIRROR_ARGS"; ERRORS=$((ERRORS + 1)); }
    else
        npm install -g docx 2>/dev/null && ok "Installed: docx" \
            || { fail "npm install failed. Try: npm install -g docx"; ERRORS=$((ERRORS + 1)); }
    fi
fi
echo ""

# ── Step 2d: Python 3 + pip ──
echo "--- [4/7] Python 3 + pip (post-processing) ---"
if command -v python3 &>/dev/null; then
    PY_VER=$(python3 --version 2>&1)
    ok "python3 ($PY_VER)"
    if [ "$PLATFORM" = "mac" ]; then
        PY_PATH=$(which python3 2>/dev/null)
        if [[ "$PY_PATH" == "/usr/bin/python3" ]]; then
            warn "Using macOS system Python (limited). Recommend: brew install python3"
        fi
    fi
else
    fail "python3 not found"
    case "$PLATFORM" in
        mac)   info "Install: brew install python3" ;;
        linux) info "Install: sudo apt install python3 python3-pip" ;;
    esac
    ERRORS=$((ERRORS + 1))
fi

if python3 -m pip --version &>/dev/null 2>&1; then
    ok "pip installed"
else
    fail "pip not found"
    case "$PLATFORM" in
        mac)   info "Install: python3 -m ensurepip --upgrade" ;;
        linux) info "Install: sudo apt install python3-pip" ;;
    esac
    ERRORS=$((ERRORS + 1))
fi
echo ""

# ── Step 2e: Python packages ──
echo "--- [5/7] Python packages (defusedxml) ---"
PY_PKGS=(
    "defusedxml:defusedxml"
)

MISSING_PY=()
for entry in "${PY_PKGS[@]}"; do
    mod="${entry%%:*}"
    pkg="${entry##*:}"
    if python3 -c "import $mod" 2>/dev/null; then
        ver=$(python3 -c "import $mod; print(getattr($mod, '__version__', 'ok'))" 2>/dev/null)
        ok "$pkg ($ver)"
    else
        fail "$pkg not installed"
        MISSING_PY+=("$pkg")
    fi
done

if [ ${#MISSING_PY[@]} -gt 0 ]; then
    info "Installing missing Python packages: ${MISSING_PY[*]}"
    # shellcheck disable=SC2086
    python3 -m pip install -q $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || python3 -m pip install -q --user $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || python3 -m pip install -q --break-system-packages $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || { fail "pip install failed. Try: pip install $PIP_MIRROR_ARGS ${MISSING_PY[*]}"; ERRORS=$((ERRORS + 1)); }
    ok "Installed: ${MISSING_PY[*]}"
fi
echo ""

# ── Local Font Verification ──
echo "--- Local Fonts (no automatic download or installation) ---"
if [ "$PLATFORM" = "mac" ]; then
    FONT_DIRS=("$HOME/Library/Fonts" "/Library/Fonts" "/System/Library/Fonts")
else
    FONT_DIRS=("$HOME/.local/share/fonts" "$HOME/.fonts" "/usr/local/share/fonts" "/usr/share/fonts")
fi
FONT_DIR=""
CJK_FOUND=false
for dir in "${FONT_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    if [ -z "$FONT_DIR" ]; then FONT_DIR="$dir"; fi
    if [ -n "$(find "$dir" -type f \( -iname 'NotoSansSC*' -o -iname 'NotoSerifSC*' -o -iname 'Noto*CJK*' -o -iname 'PingFang*' -o -iname 'Songti*' -o -iname '*Heiti*' -o -iname '*WenQuanYi*' -o -iname 'wqy*' \) -print -quit 2>/dev/null || true)" ]; then
        CJK_FOUND=true
    fi
done
if command -v fc-list >/dev/null 2>&1 && [ -n "$(fc-list :lang=zh 2>/dev/null || true)" ]; then
    CJK_FOUND=true
fi
export FONT_DIR
info "Using existing local fonts: $FONT_DIR"
if [ "$CJK_FOUND" = true ]; then
    ok "CJK fonts available (local/system)"
else
    warn "No CJK font detected. Choose an existing suitable font or obtain one from a trusted source with user approval."
fi
echo ""

# ── Summary ──
echo "============================================"
if [ $ERRORS -eq 0 ]; then
    echo "  All dependencies OK."
else
    echo "  $ERRORS issue(s) found. Fix them above."
fi
echo "  DOCX_SKILL_DIR=$DOCX_SKILL_DIR"
echo "  FONT_DIR=$FONT_DIR (existing local font directory)"
echo "============================================"
