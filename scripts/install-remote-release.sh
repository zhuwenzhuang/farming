#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_REMOTE_CONFIG_FILE="${PROJECT_ROOT}/config/farming.deploy.env"
LEGACY_REMOTE_CONFIG_FILE="${PROJECT_ROOT}/.farming-release.env"
if [ -n "${FARMING_REMOTE_CONFIG_FILE:-}" ]; then
  REMOTE_CONFIG_FILE="${FARMING_REMOTE_CONFIG_FILE}"
  if [ ! -f "${REMOTE_CONFIG_FILE}" ]; then
    echo "FARMING_REMOTE_CONFIG_FILE does not exist: ${REMOTE_CONFIG_FILE}" >&2
    exit 1
  fi
elif [ -f "${DEFAULT_REMOTE_CONFIG_FILE}" ]; then
  REMOTE_CONFIG_FILE="${DEFAULT_REMOTE_CONFIG_FILE}"
elif [ -f "${LEGACY_REMOTE_CONFIG_FILE}" ]; then
  REMOTE_CONFIG_FILE="${LEGACY_REMOTE_CONFIG_FILE}"
else
  REMOTE_CONFIG_FILE=""
fi

if [ -n "${REMOTE_CONFIG_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${REMOTE_CONFIG_FILE}"
fi

resolve_remote() {
  if [ -n "${FARMING_REMOTE:-}" ]; then
    printf '%s\n' "${FARMING_REMOTE}"
    return
  fi
  if [ -n "${FARMING_REMOTE_HOST:-}" ]; then
    printf '%s@%s\n' "${FARMING_REMOTE_USER:-${USER:-user}}" "${FARMING_REMOTE_HOST}"
    return
  fi
  echo "Set FARMING_REMOTE or create config/farming.deploy.env from config/farming.deploy.env.example." >&2
  exit 1
}

REMOTE="$(resolve_remote)"
REMOTE_DIR="${FARMING_REMOTE_DIR:-farming}"
REMOTE_PORT="${FARMING_REMOTE_PORT:-6694}"
REMOTE_BASE_PATH="${FARMING_REMOTE_BASE_PATH:-/farming}"
REMOTE_CONFIG_DIR="${FARMING_REMOTE_CONFIG_DIR:-}"
REMOTE_SERVER_HOME="${FARMING_REMOTE_SERVER_HOME:-}"

log() {
  echo "==> $*"
}

quote() {
  printf '%q' "$1"
}

checksum() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  else
    shasum -a 256 "${file}" | awk '{print $1}'
  fi
}

if [ -n "${FARMING_RELEASE_TARBALL:-}" ]; then
  TARBALL="${FARMING_RELEASE_TARBALL}"
else
  log "Packaging release for ${REMOTE_BASE_PATH} ..."
  TARBALL="$(cd "${PROJECT_ROOT}" && FARMING_BASE_PATH="${REMOTE_BASE_PATH}" ./scripts/package-release.sh)"
fi

if [ ! -f "${TARBALL}" ]; then
  echo "Release tarball not found: ${TARBALL}" >&2
  exit 1
fi

REMOTE_TARBALL="/tmp/$(basename "${TARBALL}")"
REMOTE_EXTRACT_DIR="/tmp/farming-release-install-$(date +%s)"
LOCAL_SHA="$(checksum "${TARBALL}")"

log "Uploading ${TARBALL} to ${REMOTE}:${REMOTE_TARBALL} ..."
ssh "${REMOTE}" "cat > $(quote "${REMOTE_TARBALL}")" < "${TARBALL}"
REMOTE_SHA="$(ssh "${REMOTE}" "sha256sum $(quote "${REMOTE_TARBALL}") | awk '{print \$1}'")"
if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]; then
  echo "Remote tarball checksum mismatch: local=${LOCAL_SHA} remote=${REMOTE_SHA}" >&2
  exit 1
fi

log "Installing release on ${REMOTE}:${REMOTE_DIR} ..."
ssh "${REMOTE}" "set -euo pipefail
mkdir -p $(quote "${REMOTE_EXTRACT_DIR}")
tar -xzf $(quote "${REMOTE_TARBALL}") -C $(quote "${REMOTE_EXTRACT_DIR}")
release_dir=\$(find $(quote "${REMOTE_EXTRACT_DIR}") -mindepth 1 -maxdepth 1 -type d | head -1)
FARMING_INSTALL_DIR=$(quote "${REMOTE_DIR}") \
FARMING_PORT=$(quote "${REMOTE_PORT}") \
FARMING_BASE_PATH=$(quote "${REMOTE_BASE_PATH}") \
FARMING_CONFIG_DIR=$(quote "${REMOTE_CONFIG_DIR}") \
FARMING_SERVER_HOME=$(quote "${REMOTE_SERVER_HOME}") \
bash \"\${release_dir}/scripts/install-release.sh\" install
rm -f $(quote "${REMOTE_TARBALL}")
rm -rf $(quote "${REMOTE_EXTRACT_DIR}")
"
