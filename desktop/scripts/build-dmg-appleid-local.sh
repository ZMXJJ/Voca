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

# ── Notarize DMG ──
echo "Notarizing DMG: ${DMG_FILE}"
xcrun notarytool submit "${DMG_FILE}" \
  --apple-id "${APPLE_ID}" \
  --team-id "${APPLE_TEAM_ID}" \
  --password "${APPLE_PASSWORD}" \
  --wait

echo "Stapling DMG: ${DMG_FILE}"
xcrun stapler staple "${DMG_FILE}"

echo "Verifying DMG notarization..."
spctl --assess --type open --context context:primary-signature --verbose "${DMG_FILE}"

echo "Done: ${DMG_FILE}"
