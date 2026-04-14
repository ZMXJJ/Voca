#!/usr/bin/env bash
#
# Voca 完全卸载脚本
# 删除应用本体及所有本地数据（模型、缓存、数据库、日志等）
#
# 用法:
#   curl -fsSL <hosted-url>/uninstall.sh | bash
#   或直接运行: bash uninstall.sh
#
set -euo pipefail

APP_PATH="/Applications/Voca.app"
DATA_DIR="${HOME}/Library/Application Support/Voca"
LEGACY_TEMP_DIR="${TMPDIR:-/tmp}/voca"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}Voca 卸载工具${NC}"
echo "=============================="
echo ""

found_items=()

if [[ -d "${APP_PATH}" ]]; then
  found_items+=("应用程序  ${APP_PATH}")
fi

if [[ -d "${DATA_DIR}" ]]; then
  data_size=$(du -sh "${DATA_DIR}" 2>/dev/null | cut -f1)
  found_items+=("应用数据  ${DATA_DIR}  (${data_size})")
fi

if [[ -d "${LEGACY_TEMP_DIR}" ]]; then
  found_items+=("临时文件  ${LEGACY_TEMP_DIR}")
fi

if (( ${#found_items[@]} == 0 )); then
  echo -e "${GREEN}未检测到 Voca 相关文件，无需卸载。${NC}"
  exit 0
fi

echo "检测到以下 Voca 相关文件:"
echo ""
for item in "${found_items[@]}"; do
  echo -e "  ${YELLOW}•${NC} ${item}"
done
echo ""

read -rp "确认删除以上所有内容？此操作不可撤销 [y/N]: " confirm
if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
  echo "已取消。"
  exit 0
fi

echo ""

if [[ -d "${APP_PATH}" ]]; then
  echo -n "删除应用程序..."
  rm -rf "${APP_PATH}"
  echo -e " ${GREEN}完成${NC}"
fi

if [[ -d "${DATA_DIR}" ]]; then
  echo -n "删除应用数据（模型、缓存、数据库等）..."
  rm -rf "${DATA_DIR}"
  echo -e " ${GREEN}完成${NC}"
fi

if [[ -d "${LEGACY_TEMP_DIR}" ]]; then
  echo -n "删除临时文件..."
  rm -rf "${LEGACY_TEMP_DIR}"
  echo -e " ${GREEN}完成${NC}"
fi

echo ""
echo -e "${GREEN}Voca 已完全卸载。${NC}"
