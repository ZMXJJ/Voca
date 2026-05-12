#!/usr/bin/env bash
# 在 DMG 同目录生成「文件名.sha256」，便于随 GitHub Release 上传。
# 用法: ./desktop/scripts/write-dmg-sha256.sh path/to/Voca_0.3.0_aarch64.dmg
# 校验: cd 下载目录 && shasum -a 256 -c Voca_0.3.0_aarch64.dmg.sha256

set -euo pipefail

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0 <path-to.dmg>" >&2
  exit 1
fi

DMG="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if [[ ! -f "$DMG" ]]; then
  echo "Not a file: $DMG" >&2
  exit 1
fi

OUT="${DMG}.sha256"
BN="$(basename "$DMG")"
(
  cd "$(dirname "$DMG")"
  shasum -a 256 "$BN" >"${OUT}"
)

echo "Wrote ${OUT}"
cat "$OUT"
