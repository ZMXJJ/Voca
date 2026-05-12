#!/usr/bin/env bash
# 从本机移除 Voca 应用及其常见数据目录（macOS）。
# 用法:
#   ./uninstall-voca-macos.sh          # 交互确认后删除
#   ./uninstall-voca-macos.sh --yes    # 跳过确认（脚本/自动化用）
#
# 删除前请先退出 Voca。需要管理员权限的路径会跳过并提示你用 sudo 自行处理。

set -euo pipefail

YES=0
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  YES=1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

BUNDLE_ID="com.voca.desktop"
HOME_DIR="${HOME:?HOME is not set}"

remove_if_exists() {
  local path="$1"
  local label="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    if rm -rf "$path" 2>/dev/null; then
      echo "Removed: $label ($path)"
    else
      echo "Could not remove (try sudo or unlock): $path" >&2
    fi
  fi
}

echo "Voca uninstall (macOS)"
echo "Bundle id: $BUNDLE_ID"
echo ""

if [[ "$YES" -ne 1 ]]; then
  echo "This will delete:"
  echo "  - Voca.app under /Applications or ~/Applications (if present)"
  echo "  - ~/Library/Application Support/Voca"
  echo "  - ~/Library/Caches/${BUNDLE_ID}"
  echo "  - ~/Library/Preferences/${BUNDLE_ID}.plist"
  echo "  - ~/Library/Saved Application State/${BUNDLE_ID}.savedState"
  echo ""
  read -r -p "Continue? [y/N] " ans
  if [[ ! "${ans:-}" =~ ^[yY]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "Quitting Voca (if running)..."
killall Voca 2>/dev/null || true
sleep 1

remove_if_exists "/Applications/Voca.app" "Application"
remove_if_exists "${HOME_DIR}/Applications/Voca.app" "User Applications"

remove_if_exists "${HOME_DIR}/Library/Application Support/Voca" "App Support data"
remove_if_exists "${HOME_DIR}/Library/Caches/${BUNDLE_ID}" "Caches"
remove_if_exists "${HOME_DIR}/Library/Preferences/${BUNDLE_ID}.plist" "Preferences"
remove_if_exists "${HOME_DIR}/Library/Saved Application State/${BUNDLE_ID}.savedState" "Saved state"

echo ""
echo "Done. If you installed models elsewhere (e.g. VOCA_MODEL_DIR), remove those paths manually."
