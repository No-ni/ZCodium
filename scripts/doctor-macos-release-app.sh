#!/usr/bin/env bash

set -euo pipefail

APP_PATH="${1:-${ZCODE_MACOS_RELEASE_APP_PATH:-/Applications/ZCodium.app}}"
ZCODE_HOME_DIR="${ZCODE_HOME:-${HOME:+$HOME/.zcodium}}"
APP_BUNDLE_NAME="$(basename "$APP_PATH")"
APP_DISPLAY_NAME="${APP_BUNDLE_NAME%.app}"
APP_EXECUTABLE_NAME="${ZCODE_APP_EXECUTABLE_NAME:-$APP_DISPLAY_NAME}"
# 本 fork 保留旧电脑操作后端（@trycua/cua-driver + 旧 zcode-cua driver），官方独立 Helper.app
# 与 broker/helperConstants 不在发行链路里；这里只验收真实产品 bundle 自身。
# 需要额外做公证票据验收时显式开启，缺省不联网、不猜测。
REQUIRE_APP_STAPLE=0
if [[ "${ZCODE_MACOS_REQUIRE_STAPLE:-0}" =~ ^(1|true|on)$ ]]; then
  REQUIRE_APP_STAPLE=1
fi
DATA_ROOT="${ZCODE_DATA_ROOT:-.zcodium}"

if [ "${APP_PATH:-}" = "--help" ] || [ "${APP_PATH:-}" = "-h" ]; then
  cat <<'USAGE'
Usage:
  bash scripts/doctor-macos-release-app.sh /Applications/ZCodium.app
  ZCODE_MACOS_RELEASE_APP_PATH=/Applications/ZCodium.app pnpm run doctor:macos-release
  ZCODE_MACOS_REQUIRE_STAPLE=1 bash scripts/doctor-macos-release-app.sh /Applications/ZCodium.app

Always validates the installed macOS release app with:
  codesign --verify --deep --strict <app>
  spctl -a -vv -t exec <app>
  Mach-O magic check on Contents/MacOS/<executable>

ZCODE_MACOS_REQUIRE_STAPLE=1 additionally runs a local notarization staple check
against the release app itself (xcrun is only required in that mode).

The doctor also confirms the product data root stays on this fork's own identity:
${ZCODE_HOME:-$HOME/.zcodium}. A release app that would fall back to the upstream
data directory fails closed.
USAGE
  exit 0
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[macos-release-doctor] missing required command: $command_name" >&2
    exit 1
  fi
}

assert_bundle_dir() {
  local label="$1"
  local bundle_path="$2"
  if [ -z "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} path is empty" >&2
    exit 1
  fi
  if [ ! -d "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} missing: $bundle_path" >&2
    exit 1
  fi
}

assert_executable() {
  local label="$1"
  local executable_path="$2"
  if [ ! -x "$executable_path" ]; then
    echo "[macos-release-doctor] ${label} executable missing or not executable: $executable_path" >&2
    exit 1
  fi
}

assert_macho_executable() {
  local label="$1"
  local executable_path="$2"
  local magic
  magic="$(od -An -N4 -tx1 -v "$executable_path" | tr -d ' \n')"
  case "$magic" in
    feedface|feedfacf|cafebabe|cafebabf|cffaedfe|cefaedfe|bebafeca|bfbafeca) ;;
    *)
      echo "[macos-release-doctor] ${label} is not a Mach-O executable: $executable_path" >&2
      exit 1
      ;;
  esac
}

assert_fork_data_root() {
  # 根因：本 fork 的业务数据根必须是 .zcodium。构建若漏改身份，安装后的 app 会读写官方
  # .zcode 目录，等于把 ZCodium 客户端接回上游数据面；release 验收必须在这里挡住。
  local resolved_root="$1"
  if [ -z "$resolved_root" ]; then
    echo "[macos-release-doctor] product data root unresolved; set ZCODE_HOME or HOME" >&2
    exit 1
  fi
  case "$resolved_root" in
    *"/${DATA_ROOT}"|*"/${DATA_ROOT}/") ;;
    *"/.zcode"*|*"zcode.z.ai"*)
      echo "[macos-release-doctor] product data root is not this fork's identity: $resolved_root" >&2
      exit 1
      ;;
    *)
      echo "[macos-release-doctor] product data root must end with /${DATA_ROOT}: $resolved_root" >&2
      exit 1
      ;;
  esac
  echo "[macos-release-doctor] product data root: $resolved_root"
}

run_quiet_validation() {
  local label="$1"
  shift
  local output_file
  output_file="$(mktemp "${TMPDIR:-/tmp}/zcode-macos-release-doctor.XXXXXX")"
  if "$@" >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 0
  fi

  echo "[macos-release-doctor] ${label} failed" >&2
  cat "$output_file" >&2
  rm -f "$output_file"
  return 1
}

validate_release_bundle() {
  local label="$1"
  local bundle_path="$2"
  local require_notarization_staple="${3:-0}"

  echo "[macos-release-doctor] validating ${label}: $bundle_path"
  run_quiet_validation "${label} codesign verify" codesign --verify --deep --strict "$bundle_path"
  run_quiet_validation "${label} Gatekeeper exec assessment" spctl -a -vv -t exec "$bundle_path"
  if [ "$require_notarization_staple" = "1" ]; then
    # 修复原因：xcrun 只属于 macOS 的 staple 验收工具，必须等 bundle 存在且基础签名校验通过后再检查，
    # 否则缺工具的错误会掩盖 bundle 缺失或签名错误这类更直接的发布故障。
    require_command xcrun
    # 仅检查 spctl 会被联网取票或缓存掩盖，必须验证最终 app 的本地 staple。
    run_quiet_validation "${label} notarization staple" xcrun stapler validate "$bundle_path"
  fi
}

require_command codesign
require_command spctl

# Bugfix: 过去 release/notarization 成功只说明 DMG 通过了 gate，不能证明安装后的主 app
# 能被 Gatekeeper 以 exec 类型放行，也不能证明主可执行是真 Mach-O 而不是残留的 shell wrapper。
# 这里先 fail-closed 检查 bundle 结构与 Mach-O 头，再跑 codesign/spctl。
assert_bundle_dir "$APP_BUNDLE_NAME" "$APP_PATH"
assert_executable "$APP_BUNDLE_NAME" "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE_NAME"
assert_macho_executable \
  "$APP_BUNDLE_NAME executable" \
  "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE_NAME"
assert_fork_data_root "$ZCODE_HOME_DIR"

validate_release_bundle "$APP_BUNDLE_NAME" "$APP_PATH" "$REQUIRE_APP_STAPLE"

echo "[macos-release-doctor] done"
