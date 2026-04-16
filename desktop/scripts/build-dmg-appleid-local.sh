#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DESKTOP_DIR}/.env.apple-notarize.local"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing local env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

required_vars=(
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
)

missing_vars=()
for name in "${required_vars[@]}"; do
  value="${!name:-}"
  if [[ -z "${value}" ]]; then
    missing_vars+=("${name}")
  fi
done

if (( ${#missing_vars[@]} > 0 )); then
  echo "Missing required environment variables in ${ENV_FILE}:" >&2
  printf '  - %s\n' "${missing_vars[@]}" >&2
  exit 1
fi

export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export CPATH="${SDKROOT}/usr/include"

cd "${DESKTOP_DIR}"
npm run build:dmg

DMG_DIR="${DESKTOP_DIR}/src-tauri/target/release/bundle/dmg"
DMG_FILE=$(find "${DMG_DIR}" -name '*.dmg' -maxdepth 1 | head -1)

if [[ -z "${DMG_FILE}" ]]; then
  echo "No DMG found in ${DMG_DIR}" >&2
  exit 1
fi

NOTARIZE_ARGS=(
  --apple-id "${APPLE_ID}"
  --team-id "${APPLE_TEAM_ID}"
  --password "${APPLE_PASSWORD}"
  --wait
)

# ── Step 1: Notarize the DMG (also approves all contents including the .app) ──
echo "Notarizing DMG: ${DMG_FILE}"
xcrun notarytool submit "${DMG_FILE}" "${NOTARIZE_ARGS[@]}"

# ── Step 2: Staple the .app inside the DMG ──
# The .app inside the DMG doesn't carry a stapled ticket; users who drag it
# to /Applications would need an online Gatekeeper check, which fails behind
# corporate firewalls. Fix: convert DMG to writable, staple the .app, convert
# back.
WORK_DIR=$(mktemp -d)
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "Converting DMG to writable image..."
hdiutil convert "${DMG_FILE}" -format UDRW -o "${WORK_DIR}/writable.dmg"

echo "Mounting writable image..."
hdiutil attach "${WORK_DIR}/writable.dmg" -readwrite -nobrowse -mountpoint "${WORK_DIR}/mnt"

APP_PATH="${WORK_DIR}/mnt/Voca.app"
if [[ ! -d "${APP_PATH}" ]]; then
  echo "Voca.app not found inside DMG" >&2
  hdiutil detach "${WORK_DIR}/mnt"
  exit 1
fi

echo "Stapling .app inside DMG: ${APP_PATH}"
xcrun stapler staple "${APP_PATH}"

echo "Unmounting writable image..."
hdiutil detach "${WORK_DIR}/mnt"

echo "Converting back to compressed read-only DMG..."
rm -f "${DMG_FILE}"
hdiutil convert "${WORK_DIR}/writable.dmg" -format UDZO -imagekey zlib-level=9 -o "${DMG_FILE}"

# ── Step 3: Re-sign and re-notarize the rebuilt DMG ──
echo "Re-signing DMG..."
codesign --force --sign "${APPLE_SIGNING_IDENTITY}" --timestamp "${DMG_FILE}"

echo "Re-notarizing final DMG: ${DMG_FILE}"
xcrun notarytool submit "${DMG_FILE}" "${NOTARIZE_ARGS[@]}"

echo "Stapling final DMG..."
xcrun stapler staple "${DMG_FILE}"

# ── Verify ──
echo "Verifying DMG notarization..."
spctl --assess --type open --context context:primary-signature --verbose "${DMG_FILE}"

echo "Done: ${DMG_FILE}"
