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
KEEP_IMAGES="2"
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

for command_name in node tar sha256sum flock curl find stat readlink df du; do
  command -v "${command_name}" >/dev/null || {
    echo "Remote deployment requires ${command_name}." >&2
    exit 1
  }
done

SYSTEM_NODE="$(command -v node)"
CONFIG_DIR="${CONFIG_DIR:-${HOME}/.farming}"
CONFIG_DIR="$(readlink -m "${CONFIG_DIR}")"
if [ -z "${CONFIG_DIR}" ] || [ "${CONFIG_DIR}" = "/" ]; then
  echo "--config-dir must resolve to a dedicated Config directory." >&2
  exit 1
fi
STATE_ROOT="${REMOTE_DIR}.deploy"
IMAGES_DIR="${STATE_ROOT}/images"
STAGING_DIR="${STATE_ROOT}/staging/${EXPECTED_GIT_SHA}-${EXPECTED_CHECKSUM:0:16}"
IMAGE_ID="${EXPECTED_GIT_SHA:0:12}-${EXPECTED_CHECKSUM:0:16}"
IMAGE_ROOT="${IMAGES_DIR}/${IMAGE_ID}"
LOCK_FILE="${STATE_ROOT}/deploy.lock"
PREVIOUS_LINK="${STATE_ROOT}/previous"
SMOKE_WORKSPACE="${STATE_ROOT}/smoke/${IMAGE_ID}"
CONFIG_PARENT="$(dirname "${CONFIG_DIR}")"
CONFIG_NAME="$(basename "${CONFIG_DIR}")"
CONFIG_BACKUP="${CONFIG_PARENT}/.${CONFIG_NAME}.farming-deploy-backup-${IMAGE_ID}"
CONFIG_FAILED_COPY="${CONFIG_PARENT}/.${CONFIG_NAME}.farming-deploy-failed-${IMAGE_ID}"
CONFIG_SNAPSHOT_ACTIVE="0"
IMAGE_CLEANUP_READY="0"
RECOVERY_SAFE="1"
CLEANUP_WARNING="false"

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
  local status=$?
  if [ "$status" -ne 0 ] && [ "$IMAGE_CLEANUP_READY" = "1" ] && [ "$RECOVERY_SAFE" = "1" ]; then
    prune_images failed || echo "Warning: failed deployment image cleanup did not complete." >&2
  fi
  if [ -n "${STAGING_DIR:-}" ] && [[ "${STAGING_DIR}" == "${STATE_ROOT}/staging/"* ]]; then
    rm -rf "${STAGING_DIR}" || echo "Warning: could not remove deployment staging ${STAGING_DIR}." >&2
  fi
  if [ -n "${SMOKE_WORKSPACE:-}" ] && [[ "${SMOKE_WORKSPACE}" == "${STATE_ROOT}/smoke/"* ]]; then
    rm -rf "${SMOKE_WORKSPACE}" || echo "Warning: could not remove deployment smoke workspace ${SMOKE_WORKSPACE}." >&2
  fi
  if [[ "${ARTIFACT:-}" == "${STATE_ROOT}/incoming/"*.tar.gz ]]; then
    rm -f "${ARTIFACT}" || echo "Warning: could not remove uploaded deployment artifact." >&2
  fi
  return "$status"
}
trap cleanup_staging EXIT

ensure_no_unresolved_config_snapshot() {
  local unresolved_snapshot
  for unresolved_snapshot in \
    "${CONFIG_PARENT}/.${CONFIG_NAME}.farming-deploy-backup-"* \
    "${CONFIG_PARENT}/.${CONFIG_NAME}.farming-deploy-failed-"*; do
    if [ -e "${unresolved_snapshot}" ] || [ -L "${unresolved_snapshot}" ]; then
      echo "A Config snapshot from an earlier deployment still requires operator reconciliation." >&2
      return 1
    fi
  done
  return 0
}

stage_config_snapshot() {
  if ! ensure_no_unresolved_config_snapshot; then
    return 1
  fi
  if ! mv "${CONFIG_DIR}" "${CONFIG_BACKUP}"; then
    echo "Could not checkpoint the stopped Config before activation." >&2
    return 1
  fi
  mkdir -p "${CONFIG_DIR}"
  if ! cp -a "${CONFIG_BACKUP}/." "${CONFIG_DIR}/"; then
    rm -rf "${CONFIG_DIR}"
    mv "${CONFIG_BACKUP}" "${CONFIG_DIR}" || true
    echo "Could not prepare an isolated Config copy for activation." >&2
    return 1
  fi
  CONFIG_SNAPSHOT_ACTIVE="1"
}

restore_config_snapshot() {
  [ "${CONFIG_SNAPSHOT_ACTIVE}" = "1" ] || return 0
  if ! mv "${CONFIG_DIR}" "${CONFIG_FAILED_COPY}"; then
    echo "Could not isolate the failed image's Config state." >&2
    return 1
  fi
  if ! mv "${CONFIG_BACKUP}" "${CONFIG_DIR}"; then
    mv "${CONFIG_FAILED_COPY}" "${CONFIG_DIR}" || true
    echo "Could not restore the pre-activation Config snapshot." >&2
    return 1
  fi
  rm -rf "${CONFIG_FAILED_COPY}"
  CONFIG_SNAPSHOT_ACTIVE="0"
}

commit_config_snapshot() {
  [ "${CONFIG_SNAPSHOT_ACTIVE}" = "1" ] || return 0
  rm -rf "${CONFIG_BACKUP}"
  CONFIG_SNAPSHOT_ACTIVE="0"
}

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

# The deploy lock owns retention in preparation, success, and reconciled failure.
# An incomplete rollback leaves every image available for operator recovery.
prune_images() {
  local mode="$1"
  CURRENT_ROOT="$(readlink -f "${REMOTE_DIR}")"
  PREVIOUS_PROTECTED="$(readlink -f "${PREVIOUS_LINK}" 2>/dev/null || true)"

  # Resolve which images are still referenced by live processes before pruning.
  # A Farming Server started from a remote image carries image-root-qualified
  # command-line arguments (for example the CLI entrypoint, the bundled glibc
  # loader, or backend entrypoints), so an exact /proc cmdline scan proves live
  # usage for any Config instance, independent of image version or working
  # directory. One deployment root belongs to one operating user, so process
  # ownership is decided from the /proc entry's uid; if ownership or command-line
  # evidence cannot be proven, the scan reports uncertainty and cleanup is
  # skipped instead of guessed. Production always scans /proc.
  #
  # Concurrency boundary: this is a snapshot scan, not an atomic lease. The
  # current/previous pointers protect normal new starts of the selected Config;
  # the live-reference scan protects already-running Servers of other Configs
  # observed at scan time; uncertain observation skips all cleanup.
  LIVE_REFERENCE_OUTPUT="$(node - "${IMAGES_DIR}" <<'NODE'
const fs = require('fs');
const path = require('path');

const imagesDir = path.resolve(process.argv[2]);
const imagesPrefix = imagesDir + path.sep;
const referenced = new Set();
let uncertain = false;
const ownUid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
if (ownUid < 0) uncertain = true;
let procEntries = [];
try {
  procEntries = fs.readdirSync('/proc');
} catch {
  uncertain = true;
}
for (const entry of procEntries) {
  if (!/^\d+$/.test(entry)) continue;
  if (entry === String(process.pid)) continue;
  if (uncertain) break;
  let procStat;
  try {
    procStat = fs.statSync(path.join('/proc', entry));
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : '';
    if (code === 'ENOENT' || code === 'ESRCH') continue;
    uncertain = true;
    break;
  }
  if (procStat.uid !== ownUid) continue;
  let cmdline;
  try {
    cmdline = fs.readFileSync(path.join('/proc', entry, 'cmdline'));
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : '';
    if (code === 'ENOENT' || code === 'ESRCH') continue;
    uncertain = true;
    break;
  }
  for (const arg of cmdline.toString('utf8').split('\0')) {
    if (arg.startsWith(imagesPrefix)) {
      const topLevel = arg.slice(imagesPrefix.length).split(path.sep)[0];
      if (topLevel && topLevel !== '..') referenced.add(path.join(imagesDir, topLevel));
    }
  }
}
if (uncertain) process.stdout.write('UNCERTAIN\n');
for (const imageRoot of [...referenced].sort()) {
  process.stdout.write(`${imageRoot}\n`);
}
NODE
  )" || LIVE_REFERENCE_OUTPUT="UNCERTAIN"

  LIVE_REFERENCED_IMAGES=()
  LIVE_REFERENCE_UNCERTAIN="false"
  while IFS= read -r reference_line; do
    if [ "${reference_line}" = "UNCERTAIN" ]; then
      LIVE_REFERENCE_UNCERTAIN="true"
    elif [ -n "${reference_line}" ]; then
      LIVE_REFERENCED_IMAGES+=("${reference_line}")
    fi
  done <<< "${LIVE_REFERENCE_OUTPUT}"

  retained=0
  while IFS= read -r candidate; do
    [ -d "${candidate}" ] || continue
    if [ "${candidate}" = "${CURRENT_ROOT}" ] || [ "${candidate}" = "${PREVIOUS_PROTECTED}" ]; then
      retained=$((retained + 1))
      continue
    fi
    if [ "${candidate}" = "${IMAGE_ROOT}" ] && [ "$mode" != "failed" ]; then
      continue
    fi
    if [ "${LIVE_REFERENCE_UNCERTAIN}" = "true" ]; then
      continue
    fi
    for live_referenced_image in ${LIVE_REFERENCED_IMAGES[@]+"${LIVE_REFERENCED_IMAGES[@]}"}; do
      if [ "${candidate}" = "${live_referenced_image}" ]; then
        continue 2
      fi
    done
    if [ "$mode" != "failed" ] || [ "${candidate}" != "${IMAGE_ROOT}" ]; then
      if [ "${retained}" -lt "${KEEP_IMAGES}" ]; then
        retained=$((retained + 1))
        continue
      fi
    fi
    if [ ! -L "${candidate}" ] && [ -f "${candidate}/.farming-deployment.json" ] && [[ "${candidate}" == "${IMAGES_DIR}/"* ]]; then
      if ! node - "$candidate" "$IMAGE_ROOT" "$EXPECTED_GIT_SHA" "$EXPECTED_CHECKSUM" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, target, sha, checksum] = process.argv.slice(2);
try {
  const marker = path.join(root, '.farming-deployment.json');
  if (fs.lstatSync(marker).isSymbolicLink() || fs.statSync(root).uid !== process.geteuid()) process.exit(1);
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (value.format !== 'farming-remote-image-v1') process.exit(1);
  if (root === target && (value.gitSha !== sha || value.sha256 !== checksum)) process.exit(1);
  const regular = /^[0-9a-f]{40}$/.test(value.gitSha) && /^[0-9a-f]{64}$/.test(value.sha256)
    && path.basename(root) === `${value.gitSha.slice(0, 12)}-${value.sha256.slice(0, 16)}`;
  const legacy = value.legacy === true && value.imageId === 'legacy-migration'
    && /^legacy-[0-9]{8}T[0-9]{6}Z-[0-9]+$/.test(path.basename(root));
  if (!regular && !legacy) process.exit(1);
} catch { process.exit(1); }
NODE
      then
        echo "Warning: image ownership could not be proven for $candidate; retained." >&2
        CLEANUP_WARNING="true"
        continue
      fi
      echo "Removing unreferenced Farming image $(basename "${candidate}")" >&2
      chmod -R u+rwX "${candidate}" 2>/dev/null || true
      if ! rm -rf "${candidate}"; then
        echo "Warning: could not remove old Farming image ${candidate}." >&2
        CLEANUP_WARNING="true"
      fi
    fi
  done < <(find "${IMAGES_DIR}" -mindepth 1 -maxdepth 1 -type d -print0 | xargs -0 -r ls -1dt 2>/dev/null || true)

  if [ "${LIVE_REFERENCE_UNCERTAIN}" = "true" ]; then
    echo "Warning: live image references could not be proven; old image cleanup was skipped." >&2
    CLEANUP_WARNING="true"
  fi
}

config_snapshot_bytes() {
  if [ ! -d "$CONFIG_DIR" ]; then printf '0\n'; return; fi
  local allocated apparent
  allocated="$(du -s -B1 "$CONFIG_DIR" | awk '{print $1}')"
  apparent="$(du -s -B1 --apparent-size "$CONFIG_DIR" | awk '{print $1}')"
  if [ "$allocated" -gt "$apparent" ]; then printf '%s\n' "$allocated"; else printf '%s\n' "$apparent"; fi
}

existing_parent() {
  local directory="$1"
  while [ ! -d "$directory" ]; do directory="$(dirname "$directory")"; done
  printf '%s\n' "$directory"
}

require_space() {
  local directory="$1" required="$2" phase="$3" available
  available="$(df -PB1 "$directory" | awk 'END {print $4}')"
  if [[ ! "$available" =~ ^[0-9]+$ ]] || [[ ! "$required" =~ ^[0-9]+$ ]]; then
    echo "Cannot determine deployment disk capacity for $directory." >&2
    return 1
  fi
  echo "Disk preflight ($phase): $directory needs $required bytes; $available bytes available." >&2
  if [ "$available" -lt "$required" ]; then
    echo "Insufficient disk space before $phase: $directory needs $required bytes, available $available. Current Server has not been stopped." >&2
    return 1
  fi
}

check_preparation_space() {
  local unpacked=0 snapshot config_filesystem
  snapshot="$(config_snapshot_bytes)"
  config_filesystem="$(existing_parent "$CONFIG_PARENT")"
  if [ ! -d "$IMAGE_ROOT" ]; then
    unpacked="$(LC_ALL=C tar -tvzf "$ARTIFACT" | awk '{total += $3} END {printf "%.0f\n", total}')"
  fi
  # Account for the Config copy on its own filesystem, plus 1 GiB headroom
  # for compatibility extraction, runtime preparation and concurrent writes.
  if [ "$(stat -c %d "$IMAGES_DIR")" = "$(stat -c %d "$config_filesystem")" ]; then
    require_space "$IMAGES_DIR" "$((unpacked + snapshot + 1073741824))" preparation
  else
    require_space "$IMAGES_DIR" "$((unpacked + 1073741824))" preparation
    require_space "$config_filesystem" "$((snapshot + 1073741824))" preparation
  fi
}

if ! ensure_no_unresolved_config_snapshot; then
  exit 1
fi

IMAGE_CLEANUP_READY="1"
prune_images preparing
check_preparation_space
prepare_image

(
  cd "${IMAGE_ROOT}"
  run_node "${IMAGE_ROOT}" -e 'require("node-pty"); process.stdout.write("node-pty ok\n")' \
    </dev/null >/dev/null
)
mkdir -p "${CONFIG_DIR}"
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
  require_space "$(existing_parent "$CONFIG_PARENT")" "$(($(config_snapshot_bytes) + 1073741824))" "Config checkpoint"
  RECOVERY_SAFE="0"
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
  if ! stage_config_snapshot; then
    if [ -n "${PREVIOUS_ROOT}" ]; then
      PREVIOUS_RUNTIME="${PREVIOUS_ROOT}"
      if [ ! -x "${PREVIOUS_RUNTIME}/.farming-glibc/lib/ld-2.28.so" ]; then PREVIOUS_RUNTIME="${IMAGE_ROOT}"; fi
      if start_server "${PREVIOUS_RUNTIME}" "${PREVIOUS_ROOT}"; then RECOVERY_SAFE="1"; fi
    fi
    exit 1
  fi
  if ! switch_current "${IMAGE_ROOT}"; then
    restore_config_snapshot || true
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
  CONFIG_RESTORED="true"
  if ! restore_config_snapshot; then CONFIG_RESTORED="false"; fi
  if [ -n "${PREVIOUS_ROOT}" ]; then
    switch_current "${PREVIOUS_ROOT}"
    PREVIOUS_RUNTIME="${PREVIOUS_ROOT}"
    if [ ! -x "${PREVIOUS_RUNTIME}/.farming-glibc/lib/ld-2.28.so" ]; then PREVIOUS_RUNTIME="${IMAGE_ROOT}"; fi
    if [ "${CONFIG_RESTORED}" = "true" ] && start_server "${PREVIOUS_RUNTIME}" "${PREVIOUS_ROOT}"; then
      RECOVERY_SAFE="1"
      echo "${START_FAILURE} The previous image was restored." >&2
    else
      echo "${START_FAILURE} Rollback also failed; operator action is required." >&2
    fi
  else
    rm -f "${REMOTE_DIR}"
    if [ "$CONFIG_RESTORED" = "true" ]; then RECOVERY_SAFE="1"; fi
    echo "${START_FAILURE} No previous image was available." >&2
  fi
  exit 1
fi

commit_config_snapshot
RECOVERY_SAFE="1"

if [ -n "${PREVIOUS_ROOT}" ] && [ "${PREVIOUS_ROOT}" != "${IMAGE_ROOT}" ]; then
  ln -sfn "${PREVIOUS_ROOT}" "${PREVIOUS_LINK}"
fi

prune_images succeeded

rm -f "${ARTIFACT}"
node - "${IMAGE_ID}" "${EXPECTED_GIT_SHA}" "${IMAGE_ROOT}" "${CLEANUP_WARNING}" <<'NODE'
const [imageId, gitSha, imageRoot, cleanupWarning] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ ok: true, imageId, gitSha, imageRoot, cleanupWarning: cleanupWarning === 'true' })}\n`);
NODE
