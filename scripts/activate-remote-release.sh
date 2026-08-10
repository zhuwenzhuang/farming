#!/usr/bin/env bash
set -euo pipefail

ARTIFACT=""
EXPECTED_CHECKSUM=""
EXPECTED_GIT_SHA=""
EXPECTED_SELECTION=""
REMOTE_DIR=""
CONFIG_DIR=""
SERVER_HOME=""
APP_PORT="6694"
BASE_PATH="/farming"
SMOKE_AGENT="codex"
KEEP_IMAGES="5"
DISABLE_AUTH="0"
RUNTIME_NPM_MIRROR=""

usage() {
  cat <<'EOF'
Usage: activate-remote-release.sh --artifact PATH --checksum SHA256 --git-sha SHA \
  --remote-dir PATH [options]

This is the remote half of Farming's transactional deployment. It accepts one
verified app bundle, publishes an immutable image, switches one symlink, and
rolls back to the prior image if startup or product smoke fails.
EOF
}

read_value() {
  local option="$1"
  local value="${2:-}"
  if [ -z "${value}" ] || [[ "${value}" == --* ]]; then
    echo "${option} requires a value" >&2
    exit 2
  fi
  printf '%s\n' "${value}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact) ARTIFACT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --checksum) EXPECTED_CHECKSUM="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --git-sha) EXPECTED_GIT_SHA="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --expected-selection) EXPECTED_SELECTION="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --remote-dir) REMOTE_DIR="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --config-dir) CONFIG_DIR="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --server-home) SERVER_HOME="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --app-port) APP_PORT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --base-path) BASE_PATH="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --smoke-agent) SMOKE_AGENT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --keep-images) KEEP_IMAGES="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --runtime-npm-mirror) RUNTIME_NPM_MIRROR="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --disable-auth) DISABLE_AUTH="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown remote activation option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ ! -f "${ARTIFACT}" ]; then
  echo "Deployment artifact does not exist: ${ARTIFACT:-missing}" >&2
  exit 1
fi
if [[ ! "${EXPECTED_CHECKSUM}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Deployment checksum must be an exact SHA-256." >&2
  exit 1
fi
if [[ ! "${EXPECTED_GIT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Deployment git SHA must contain 40 lowercase hexadecimal characters." >&2
  exit 1
fi
case "${EXPECTED_SELECTION}" in
  none|legacy:*|image:*) ;;
  *) echo "--expected-selection is missing or invalid." >&2; exit 1 ;;
esac
case "${REMOTE_DIR}" in
  /*) ;;
  *) echo "--remote-dir must be an absolute path." >&2; exit 1 ;;
esac
if [ -n "${CONFIG_DIR}" ]; then
  case "${CONFIG_DIR}" in /*) ;; *) echo "--config-dir must be an absolute path." >&2; exit 1 ;; esac
fi
if [ -n "${SERVER_HOME}" ]; then
  case "${SERVER_HOME}" in /*) ;; *) echo "--server-home must be an absolute path." >&2; exit 1 ;; esac
fi
if [[ ! "${APP_PORT}" =~ ^[0-9]+$ ]] || [ "${APP_PORT}" -lt 1 ] || [ "${APP_PORT}" -gt 65535 ]; then
  echo "--app-port must be between 1 and 65535." >&2
  exit 1
fi
if [[ ! "${KEEP_IMAGES}" =~ ^[0-9]+$ ]] || [ "${KEEP_IMAGES}" -lt 2 ] || [ "${KEEP_IMAGES}" -gt 20 ]; then
  echo "--keep-images must be between 2 and 20." >&2
  exit 1
fi
if [[ "${BASE_PATH}" != /* ]] || [[ "${BASE_PATH}" == *[[:space:]]* ]]; then
  echo "--base-path must be an absolute URL path without whitespace." >&2
  exit 1
fi

for command_name in node tar sha256sum flock curl find stat; do
  command -v "${command_name}" >/dev/null || {
    echo "Remote deployment requires ${command_name}." >&2
    exit 1
  }
done

SYSTEM_NODE="$(command -v node)"
CONFIG_DIR="${CONFIG_DIR:-${HOME}/.farming}"
STATE_ROOT="${REMOTE_DIR}.deploy"
IMAGES_DIR="${STATE_ROOT}/images"
STAGING_DIR="${STATE_ROOT}/staging/${EXPECTED_GIT_SHA}-${EXPECTED_CHECKSUM:0:16}"
IMAGE_ID="${EXPECTED_GIT_SHA:0:12}-${EXPECTED_CHECKSUM:0:16}"
IMAGE_ROOT="${IMAGES_DIR}/${IMAGE_ID}"
LOCK_FILE="${STATE_ROOT}/deploy.lock"
PREVIOUS_LINK="${STATE_ROOT}/previous"
SMOKE_WORKSPACE="${STATE_ROOT}/smoke/${IMAGE_ID}"

mkdir -p "${IMAGES_DIR}" "${STATE_ROOT}/staging" "${STATE_ROOT}/smoke"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another Farming deployment is active for ${REMOTE_DIR}." >&2
  exit 1
fi

current_selection() {
  if [ -L "${REMOTE_DIR}" ]; then
    local selected
    selected="$(readlink -f "${REMOTE_DIR}")"
    node - "${selected}/.farming-deployment.json" <<'NODE'
const fs = require('fs');
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(`image:${value.gitSha || 'legacy'}:${value.sha256 || value.imageId || 'unknown'}`);
} catch {
  process.stdout.write('invalid-symlink');
}
NODE
    return
  fi
  if [ -d "${REMOTE_DIR}" ]; then
    stat -Lc 'legacy:%d:%i' "${REMOTE_DIR}"
    return
  fi
  if [ -e "${REMOTE_DIR}" ]; then
    printf '%s\n' invalid-path
    return
  fi
  printf '%s\n' none
}

if [ "$(current_selection)" != "${EXPECTED_SELECTION}" ]; then
  echo "Farming deployment selection changed after preparation began; refresh and retry." >&2
  exit 1
fi

cleanup_staging() {
  if [ -n "${STAGING_DIR:-}" ] && [[ "${STAGING_DIR}" == "${STATE_ROOT}/staging/"* ]]; then
    rm -rf "${STAGING_DIR}" || echo "Warning: could not remove deployment staging ${STAGING_DIR}." >&2
  fi
  if [ -n "${SMOKE_WORKSPACE:-}" ] && [[ "${SMOKE_WORKSPACE}" == "${STATE_ROOT}/smoke/"* ]]; then
    rm -rf "${SMOKE_WORKSPACE}" || echo "Warning: could not remove deployment smoke workspace ${SMOKE_WORKSPACE}." >&2
  fi
  if [[ "${ARTIFACT:-}" == "${STATE_ROOT}/incoming/"*.tar.gz ]]; then
    rm -f "${ARTIFACT}" || echo "Warning: could not remove uploaded deployment artifact." >&2
  fi
}
trap cleanup_staging EXIT

ACTUAL_CHECKSUM="$(sha256sum "${ARTIFACT}" | awk '{print $1}')"
if [ "${ACTUAL_CHECKSUM}" != "${EXPECTED_CHECKSUM}" ]; then
  echo "Remote deployment artifact checksum mismatch." >&2
  exit 1
fi

if tar -tzf "${ARTIFACT}" | awk '
  /^\// { bad=1 }
  { count=split($0, parts, "/"); for (i=1; i<=count; i++) if (parts[i] == "..") bad=1 }
  END { exit bad ? 0 : 1 }
'; then
  echo "Deployment artifact contains an unsafe archive path." >&2
  exit 1
fi

run_node() {
  local runtime_root="$1"
  shift
  local loader="${runtime_root}/.farming-glibc/lib/ld-2.28.so"
  if [ -x "${loader}" ]; then
    FARMING_NODE_LD="${loader}" \
      FARMING_NODE_LIBRARY_PATH="$(dirname "${loader}")" \
      "${loader}" --library-path "$(dirname "${loader}")" "${SYSTEM_NODE}" "$@"
    return
  fi
  "${SYSTEM_NODE}" "$@"
}

run_cli() {
  local runtime_root="$1"
  local code_root="$2"
  shift 2
  (
    cd "${code_root}"
    export FARMING_ACTIVE_PACKAGE_ROOT="${code_root}"
    export FARMING_NODE_BIN="${SYSTEM_NODE}"
    if [ -n "${RUNTIME_NPM_MIRROR}" ]; then
      export FARMING_RUNTIME_NPM_MIRROR="${RUNTIME_NPM_MIRROR}"
    fi
    run_node "${runtime_root}" "${code_root}/bin/farming" "$@"
  )
}

server_args() {
  printf '%s\n' daemon --port "${APP_PORT}" --base-path "${BASE_PATH}" --config-dir "${CONFIG_DIR}"
  if [ -n "${SERVER_HOME}" ]; then printf '%s\n' --home "${SERVER_HOME}"; fi
  if [ "${DISABLE_AUTH}" = "1" ]; then printf '%s\n' --no-auth; fi
}

start_server() {
  local runtime_root="$1"
  local code_root="$2"
  local args=()
  while IFS= read -r value; do args+=("${value}"); done < <(server_args)
  if run_cli "${runtime_root}" "${code_root}" "${args[@]}" >/dev/null 2>&1; then
    return 0
  fi
  echo "Farming Server startup failed; inspect the Config-owned farming-server.log on the target." >&2
  return 1
}

stop_server() {
  local runtime_root="$1"
  local code_root="$2"
  run_cli "${runtime_root}" "${code_root}" stop --config-dir "${CONFIG_DIR}"
}

switch_current() {
  local target="$1"
  local temporary_link="${REMOTE_DIR}.next-${IMAGE_ID}-$$"
  rm -f "${temporary_link}"
  ln -s "${target}" "${temporary_link}"
  mv -Tf "${temporary_link}" "${REMOTE_DIR}"
}

prepare_image() {
  if [ -d "${IMAGE_ROOT}" ]; then
    local existing
    existing="$(node -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(`${value.gitSha || ""}\t${value.sha256 || ""}`);
    ' "${IMAGE_ROOT}/.farming-deployment.json" 2>/dev/null || true)"
    if [ "${existing}" != "${EXPECTED_GIT_SHA}"$'\t'"${EXPECTED_CHECKSUM}" ]; then
      echo "Existing deployment image ${IMAGE_ID} does not match its immutable identity." >&2
      exit 1
    fi
    return
  fi

  rm -rf "${STAGING_DIR}"
  mkdir -p "${STAGING_DIR}"
  tar --no-same-owner -xzf "${ARTIFACT}" -C "${STAGING_DIR}"
  local roots=()
  while IFS= read -r root; do roots+=("${root}"); done < <(find "${STAGING_DIR}" -mindepth 1 -maxdepth 1 -type d -print)
  if [ "${#roots[@]}" -ne 1 ]; then
    echo "Deployment artifact must contain exactly one application directory." >&2
    exit 1
  fi
  local prepared_root="${roots[0]}"
  local metadata
  metadata="$(node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write([
      value.type || "", value.gitSha || "", value.platform || "", value.arch || "",
      value.updateMethod || "", String(value.bundledNodeModules === true),
      String(value.bundledGlibcRuntime === true),
    ].join("\t"));
  ' "${prepared_root}/RELEASE.json")"
  local release_type release_sha release_platform release_arch update_method bundled_modules bundled_glibc
  IFS=$'\t' read -r release_type release_sha release_platform release_arch update_method bundled_modules bundled_glibc <<<"${metadata}"
  if [ "${release_type}" != "app-bundle" ] || [ "${release_sha}" != "${EXPECTED_GIT_SHA}" ]; then
    echo "Deployment artifact identity does not match the requested commit." >&2
    exit 1
  fi
  if [ "${release_platform}" != "linux" ] || [ "${release_arch}" != "x64" ]; then
    echo "Deployment artifact must target linux-x64." >&2
    exit 1
  fi
  if [ "${update_method}" != "app-bundle" ] || [ "${bundled_modules}" != "true" ]; then
    echo "Deployment artifact must be a self-contained app bundle." >&2
    exit 1
  fi
  if [ "${bundled_glibc}" = "true" ]; then
    local glibc_bundle="${prepared_root}/vendor/glibc228-lib.tar.gz"
    test -f "${glibc_bundle}" || { echo "Deployment artifact is missing its glibc runtime." >&2; exit 1; }
    mkdir -p "${prepared_root}/.farming-glibc"
    tar --no-same-owner -xzf "${glibc_bundle}" -C "${prepared_root}/.farming-glibc"
    local loader
    loader="$(find "${prepared_root}/.farming-glibc" -type f -name ld-2.28.so -print -quit)"
    if [ -z "${loader}" ]; then
      echo "Deployment artifact glibc runtime has no loader." >&2
      exit 1
    fi
    if [ "${loader}" != "${prepared_root}/.farming-glibc/lib/ld-2.28.so" ]; then
      mkdir -p "${prepared_root}/.farming-glibc/lib"
      cp -R "$(dirname "${loader}")/." "${prepared_root}/.farming-glibc/lib/"
    fi
    chmod +x "${prepared_root}/.farming-glibc/lib/ld-2.28.so"
  fi
  node - "${prepared_root}/.farming-deployment.json" "${IMAGE_ID}" "${EXPECTED_GIT_SHA}" "${EXPECTED_CHECKSUM}" <<'NODE'
const fs = require('fs');
const [file, imageId, gitSha, sha256] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'farming-remote-image-v1',
  imageId,
  gitSha,
  sha256,
  createdAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });
NODE
  mv "${prepared_root}" "${IMAGE_ROOT}"
}

prepare_image

(
  cd "${IMAGE_ROOT}"
  run_node "${IMAGE_ROOT}" -e 'require("node-pty"); process.stdout.write("node-pty ok\n")' \
    </dev/null >/dev/null
)
run_cli "${IMAGE_ROOT}" "${IMAGE_ROOT}" runtime prepare --config-dir "${CONFIG_DIR}" --no-activate

PREVIOUS_ROOT=""
LEGACY_ROOT=""
if [ "$(current_selection)" != "${EXPECTED_SELECTION}" ]; then
  echo "Farming deployment selection changed before activation; refusing a stale deployment." >&2
  exit 1
fi
if [ -L "${REMOTE_DIR}" ]; then
  PREVIOUS_ROOT="$(readlink -f "${REMOTE_DIR}")"
elif [ -d "${REMOTE_DIR}" ]; then
  LEGACY_ROOT="${IMAGES_DIR}/legacy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  PREVIOUS_ROOT="${LEGACY_ROOT}"
elif [ -e "${REMOTE_DIR}" ]; then
  echo "Remote install path is neither a directory nor a symlink: ${REMOTE_DIR}" >&2
  exit 1
fi

if [ "${PREVIOUS_ROOT}" = "${IMAGE_ROOT}" ]; then
  start_server "${IMAGE_ROOT}" "${IMAGE_ROOT}"
else
  stop_server "${IMAGE_ROOT}" "${IMAGE_ROOT}"
  if [ -n "${LEGACY_ROOT}" ]; then
    if ! mv "${REMOTE_DIR}" "${LEGACY_ROOT}"; then
      start_server "${IMAGE_ROOT}" "${REMOTE_DIR}" || true
      echo "Could not migrate the previous installation into the image store." >&2
      exit 1
    fi
    node - "${LEGACY_ROOT}/.farming-deployment.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, `${JSON.stringify({
  format: 'farming-remote-image-v1',
  imageId: 'legacy-migration',
  legacy: true,
  createdAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });
NODE
  fi
  if ! switch_current "${IMAGE_ROOT}"; then
    if [ -n "${PREVIOUS_ROOT}" ]; then
      switch_current "${PREVIOUS_ROOT}" || true
      start_server "${IMAGE_ROOT}" "${PREVIOUS_ROOT}" || true
    fi
    echo "Could not atomically select the new Farming image." >&2
    exit 1
  fi
  if ! start_server "${IMAGE_ROOT}" "${IMAGE_ROOT}"; then
    START_FAILURE="New Farming image failed its Server startup handshake."
  else
    START_FAILURE=""
  fi
fi

if [ -z "${START_FAILURE:-}" ]; then
  mkdir -p "${SMOKE_WORKSPACE}"
  if command -v git >/dev/null 2>&1; then git -C "${SMOKE_WORKSPACE}" init -q; fi
  SMOKE_ARGS=(
    --base-url "http://127.0.0.1:${APP_PORT}${BASE_PATH}"
    --workspace "${SMOKE_WORKSPACE}"
    --agent "${SMOKE_AGENT}"
  )
  if [ "${DISABLE_AUTH}" != "1" ]; then
    SMOKE_ARGS+=(--token-file "${CONFIG_DIR}/.session-token")
  fi
  if ! run_node "${IMAGE_ROOT}" "${IMAGE_ROOT}/scripts/smoke-deployed-server.mjs" \
    "${SMOKE_ARGS[@]}"; then
    START_FAILURE="New Farming image failed the HTTP, WebSocket, PTY, or ACP deployment smoke."
  fi
fi

if [ -n "${START_FAILURE:-}" ]; then
  stop_server "${IMAGE_ROOT}" "${IMAGE_ROOT}" || true
  if [ -n "${PREVIOUS_ROOT}" ]; then
    switch_current "${PREVIOUS_ROOT}"
    PREVIOUS_RUNTIME="${PREVIOUS_ROOT}"
    if [ ! -x "${PREVIOUS_RUNTIME}/.farming-glibc/lib/ld-2.28.so" ]; then PREVIOUS_RUNTIME="${IMAGE_ROOT}"; fi
    if start_server "${PREVIOUS_RUNTIME}" "${PREVIOUS_ROOT}"; then
      echo "${START_FAILURE} The previous image was restored." >&2
    else
      echo "${START_FAILURE} Rollback also failed; operator action is required." >&2
    fi
  else
    rm -f "${REMOTE_DIR}"
    echo "${START_FAILURE} No previous image was available." >&2
  fi
  exit 1
fi

if [ -n "${PREVIOUS_ROOT}" ] && [ "${PREVIOUS_ROOT}" != "${IMAGE_ROOT}" ]; then
  ln -sfn "${PREVIOUS_ROOT}" "${PREVIOUS_LINK}"
fi

CURRENT_ROOT="$(readlink -f "${REMOTE_DIR}")"
PREVIOUS_PROTECTED="$(readlink -f "${PREVIOUS_LINK}" 2>/dev/null || true)"
retained=0
CLEANUP_WARNING="false"
while IFS= read -r candidate; do
  [ -d "${candidate}" ] || continue
  if [ "${candidate}" = "${CURRENT_ROOT}" ] || [ "${candidate}" = "${PREVIOUS_PROTECTED}" ] || [ "${retained}" -lt "${KEEP_IMAGES}" ]; then
    retained=$((retained + 1))
    continue
  fi
  if [ -f "${candidate}/.farming-deployment.json" ] && [[ "${candidate}" == "${IMAGES_DIR}/"* ]]; then
    chmod -R u+rwX "${candidate}" 2>/dev/null || true
    if ! rm -rf "${candidate}"; then
      echo "Warning: could not remove old Farming image ${candidate}." >&2
      CLEANUP_WARNING="true"
    fi
  fi
done < <(find "${IMAGES_DIR}" -mindepth 1 -maxdepth 1 -type d -print0 | xargs -0 -r ls -1dt 2>/dev/null || true)

rm -f "${ARTIFACT}"
node - "${IMAGE_ID}" "${EXPECTED_GIT_SHA}" "${IMAGE_ROOT}" "${CLEANUP_WARNING}" <<'NODE'
const [imageId, gitSha, imageRoot, cleanupWarning] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ ok: true, imageId, gitSha, imageRoot, cleanupWarning: cleanupWarning === 'true' })}\n`);
NODE
