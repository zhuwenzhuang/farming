#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_CONFIG_FILE="${FARMING_INSTALL_CONFIG_FILE:-${SOURCE_DIR}/config/farming.install.env}"
if [ -f "${INSTALL_CONFIG_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${INSTALL_CONFIG_FILE}"
fi

release_uses_managed_npm() {
  [ -f "${SOURCE_DIR}/RELEASE.json" ] \
    && grep -Eq '"updateMethod"[[:space:]]*:[[:space:]]*"npm"' "${SOURCE_DIR}/RELEASE.json"
}

NPM_PREFIX="${FARMING_NPM_PREFIX:-${HOME}/.farming/npm}"

default_install_dir() {
  if release_uses_managed_npm; then
    printf '%s\n' "${NPM_PREFIX}/lib/node_modules/farming-code"
    return 0
  fi
  if [ -f "${SOURCE_DIR}/RELEASE.json" ] && [ -f "${SOURCE_DIR}/dist/index.html" ]; then
    printf '%s\n' "${SOURCE_DIR}"
  else
    printf '%s\n' "${HOME}/farming"
  fi
}

INSTALL_DIR="${FARMING_INSTALL_DIR:-$(default_install_dir)}"
if release_uses_managed_npm; then
  INSTALL_DIR="${NPM_PREFIX}/lib/node_modules/farming-code"
fi
PERSISTED_ENV_FILE="${INSTALL_DIR}/.farming-install-env"
if [ -f "${PERSISTED_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${PERSISTED_ENV_FILE}"
fi

PORT_VALUE="${FARMING_PORT:-${PORT:-6694}}"
BASE_PATH="${FARMING_BASE_PATH:-/farming}"
CONFIG_DIR_VALUE="${FARMING_CONFIG_DIR:-}"
SERVER_HOME_VALUE="${FARMING_SERVER_HOME:-}"
USE_GLIBC_RUNTIME="${FARMING_USE_GLIBC_RUNTIME:-auto}"
GLIBC_RUNTIME_ROOT="${FARMING_GLIBC_RUNTIME_ROOT:-${HOME}/.farming/glibc228}"
RUNTIME_BIN_DIR="${FARMING_RUNTIME_BIN_DIR:-${HOME}/.farming/runtime/bin}"
STABLE_CLI_DIR="${FARMING_CLI_INSTALL_DIR:-${HOME}/.farming/bin}"
SYSTEM_NODE_BIN="${FARMING_SYSTEM_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
SYSTEM_NPM_BIN="${FARMING_SYSTEM_NPM_BIN:-$(command -v npm 2>/dev/null || true)}"
PID_FILE="${INSTALL_DIR}/.farming.pid"

log() {
  echo "==> $*"
}

is_truthy() {
  [[ "${1:-}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]
}

effective_config_dir() {
  printf '%s\n' "${CONFIG_DIR_VALUE:-${HOME}/.farming}"
}

run_release_cli() {
  local release_root="$1"
  shift
  local cli_path="${release_root}/bin/farming"
  [ -f "${cli_path}" ] || {
    echo "Farming control CLI is unavailable: ${cli_path}" >&2
    return 1
  }
  if [ -x "${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so" ] && use_glibc_runtime; then
    FARMING_NODE_LD="${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so" \
      FARMING_NODE_LIBRARY_PATH="${GLIBC_RUNTIME_ROOT}/lib" \
      FARMING_NODE_BIN="${SYSTEM_NODE_BIN}" \
      "${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so" --library-path "${GLIBC_RUNTIME_ROOT}/lib" \
      "${SYSTEM_NODE_BIN}" "${cli_path}" "$@"
    return
  fi
  FARMING_NODE_BIN="${SYSTEM_NODE_BIN}" "${SYSTEM_NODE_BIN}" "${cli_path}" "$@"
}

run_installed_cli() {
  run_release_cli "${INSTALL_DIR}" "$@"
}

ensure_prerequisites() {
  [ -n "${SYSTEM_NODE_BIN}" ] || { echo "Node.js 22.13 LTS or Node.js 24+ is required." >&2; exit 1; }
  "${SYSTEM_NODE_BIN}" -e \
    'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 13) || major >= 24 ? 0 : 1)' \
    || { echo "Node.js 22.13 LTS or Node.js 24+ is required." >&2; exit 1; }
  if release_uses_managed_npm; then
    [ -n "${SYSTEM_NPM_BIN}" ] || { echo "npm is required for managed Farming updates." >&2; exit 1; }
  fi
  if [ ! -d "${SOURCE_DIR}/node_modules/express" ] || [ ! -d "${SOURCE_DIR}/node_modules/node-pty" ]; then
    command -v npm >/dev/null
  fi
}

system_glibc_lt_228() {
  [ "$(uname -s)" = "Linux" ] || return 1
  local version
  version="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
  [ -n "${version}" ] || return 1
  [ "$(printf '%s\n%s\n' "2.28" "${version}" | sort -V | head -1)" = "${version}" ] && [ "${version}" != "2.28" ]
}

use_glibc_runtime() {
  case "${USE_GLIBC_RUNTIME}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    0|false|FALSE|no|NO|off|OFF) return 1 ;;
    auto) system_glibc_lt_228 && { [ -x "${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so" ] || [ -f "${INSTALL_DIR}/vendor/glibc228-lib.tar.gz" ] || [ -f "${SOURCE_DIR}/vendor/glibc228-lib.tar.gz" ]; } ;;
    *) echo "Unknown FARMING_USE_GLIBC_RUNTIME value: ${USE_GLIBC_RUNTIME}" >&2; exit 1 ;;
  esac
}

ensure_glibc_runtime() {
  if ! use_glibc_runtime; then
    return 0
  fi
  if [ -x "${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so" ]; then
    return 0
  fi
  local bundle="${INSTALL_DIR}/vendor/glibc228-lib.tar.gz"
  if [ ! -f "${bundle}" ] && [ -f "${SOURCE_DIR}/vendor/glibc228-lib.tar.gz" ]; then
    bundle="${SOURCE_DIR}/vendor/glibc228-lib.tar.gz"
  fi
  if [ ! -f "${bundle}" ]; then
    echo "Legacy glibc runtime was requested, but this release does not include vendor/glibc228-lib.tar.gz." >&2
    exit 1
  fi
  local temp_dir
  temp_dir="$(mktemp -d /tmp/farming-glibc.XXXXXX)"
  tar --no-same-owner -xzf "${bundle}" -C "${temp_dir}"
  chmod -R u+rwX "${temp_dir}"
  local loader
  loader="$(find "${temp_dir}" -type f -name 'ld-2.28.so' | head -1 || true)"
  if [ -z "${loader}" ]; then
    rm -rf "${temp_dir}"
    echo "Legacy glibc runtime is missing ld-2.28.so: ${bundle}" >&2
    exit 1
  fi
  mkdir -p "${GLIBC_RUNTIME_ROOT}"
  rm -rf "${GLIBC_RUNTIME_ROOT}/lib"
  cp -R "$(dirname "${loader}")" "${GLIBC_RUNTIME_ROOT}/lib"
  chmod -R u+rwX "${GLIBC_RUNTIME_ROOT}/lib"
  rm -rf "${temp_dir}"
}

write_managed_npm_launchers() {
  release_uses_managed_npm || return 0
  mkdir -p "${RUNTIME_BIN_DIR}" "${STABLE_CLI_DIR}"

  local node_exec managed_node_bin loader_lines config_line home_line auth_line
  node_exec="exec \"${SYSTEM_NODE_BIN}\" \"\$@\""
  managed_node_bin="${RUNTIME_BIN_DIR}/node"
  loader_lines=""
  if use_glibc_runtime; then
    managed_node_bin="${SYSTEM_NODE_BIN}"
    loader_lines="export FARMING_NODE_LD=\"${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so\"
export FARMING_NODE_LIBRARY_PATH=\"${GLIBC_RUNTIME_ROOT}/lib\""
    node_exec="exec \"${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so\" --library-path \"${GLIBC_RUNTIME_ROOT}/lib\" \"${SYSTEM_NODE_BIN}\" \"\$@\""
  fi

  cat > "${RUNTIME_BIN_DIR}/node" <<EOF
#!/usr/bin/env bash
set -euo pipefail
${node_exec}
EOF
  chmod +x "${RUNTIME_BIN_DIR}/node"

  cat > "${RUNTIME_BIN_DIR}/npm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="${RUNTIME_BIN_DIR}:\${PATH}"
exec "${SYSTEM_NPM_BIN}" "\$@"
EOF
  chmod +x "${RUNTIME_BIN_DIR}/npm"

  config_line=""
  [ -n "${CONFIG_DIR_VALUE}" ] && config_line="export FARMING_CONFIG_DIR=\"${CONFIG_DIR_VALUE}\""
  home_line=""
  [ -n "${SERVER_HOME_VALUE}" ] && home_line="export HOME=\"${SERVER_HOME_VALUE}\""
  auth_line="unset FARMING_DISABLE_AUTH"
  is_truthy "${FARMING_DISABLE_AUTH:-0}" && auth_line="export FARMING_DISABLE_AUTH=1"

  cat > "${STABLE_CLI_DIR}/farming" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="${RUNTIME_BIN_DIR}:\${PATH}"
export FARMING_NODE_BIN="${managed_node_bin}"
${loader_lines}
export FARMING_NPM_COMMAND="${RUNTIME_BIN_DIR}/npm"
export FARMING_NPM_PREFIX="${NPM_PREFIX}"
export FARMING_SYSTEM_NODE_BIN="${SYSTEM_NODE_BIN}"
export FARMING_SYSTEM_NPM_BIN="${SYSTEM_NPM_BIN}"
${config_line}
${home_line}
${auth_line}
exec "${RUNTIME_BIN_DIR}/node" "${INSTALL_DIR}/bin/farming" "\$@"
EOF
  chmod +x "${STABLE_CLI_DIR}/farming"
}

sync_release_files() {
  mkdir -p "${INSTALL_DIR}"
  local source_real install_real bundled_dependencies
  source_real="$(cd "${SOURCE_DIR}" && pwd)"
  install_real="$(cd "${INSTALL_DIR}" && pwd)"
  if [ "${source_real}" = "${install_real}" ]; then
    return 0
  fi
  bundled_dependencies=false
  if [ -d "${SOURCE_DIR}/node_modules/express" ] && [ -d "${SOURCE_DIR}/node_modules/node-pty" ]; then
    bundled_dependencies=true
  fi

  log "Installing release files to ${INSTALL_DIR} ..."
  if command -v rsync >/dev/null 2>&1; then
    local rsync_excludes=(
      --exclude '.farming.pid' \
      --exclude '.farming-install-env' \
      --exclude 'farming.log'
    )
    if [ "${bundled_dependencies}" != "true" ]; then
      rsync_excludes+=(--exclude 'node_modules/')
    fi
    rsync -a --delete \
      "${rsync_excludes[@]}" \
      "${SOURCE_DIR}/" "${INSTALL_DIR}/"
    return 0
  fi

  if [ "${bundled_dependencies}" = "true" ]; then
    find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 \
      ! -name .farming.pid \
      ! -name .farming-install-env \
      ! -name farming.log \
      -exec rm -rf {} +
  else
    find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 \
      ! -name node_modules \
      ! -name .farming.pid \
      ! -name .farming-install-env \
      ! -name farming.log \
      -exec rm -rf {} +
  fi
  local tar_excludes=(
    --exclude './.farming.pid'
    --exclude './.farming-install-env'
    --exclude './farming.log'
  )
  if [ "${bundled_dependencies}" != "true" ]; then
    tar_excludes+=(--exclude './node_modules')
  fi
  (cd "${SOURCE_DIR}" && tar "${tar_excludes[@]}" -cf - .) | (
    cd "${INSTALL_DIR}"
    tar -xf -
  )
}

install_dependencies() {
  if [ ! -f "${INSTALL_DIR}/dist/index.html" ]; then
    echo "Release is missing dist/index.html. Rebuild with scripts/package-release.sh." >&2
    exit 1
  fi

  if [ -d "${INSTALL_DIR}/node_modules/express" ] && [ -d "${INSTALL_DIR}/node_modules/node-pty" ]; then
    log "Using bundled production dependencies."
    return 0
  fi

  log "Installing production dependencies ..."
  (
    cd "${INSTALL_DIR}"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      PUPPETEER_SKIP_DOWNLOAD=1 \
      npm ci --omit=dev
  )
}

prepare_release_runtime_dependencies() {
  release_uses_managed_npm && return 0
  if [ ! -f "${SOURCE_DIR}/backend/runtime-dependency-manager.js" ]; then
    echo "Release is missing its startup dependency manager." >&2
    return 1
  fi
  ensure_glibc_runtime
  log "Preparing startup dependencies before the restart window ..."
  run_release_cli "${SOURCE_DIR}" runtime prepare --config-dir "$(effective_config_dir)"
}

stop_server() {
  local config_dir
  config_dir="$(effective_config_dir)"
  if [ ! -f "${config_dir}/farming-server.pid" ] && [ ! -f "${PID_FILE}" ]; then
    log "No PID file found. Server not running."
    return 0
  fi
  if [ ! -f "${config_dir}/farming-server.pid" ]; then
    echo "This installation has only legacy PID metadata and cannot prove which process it owns. Stop that Farming Server manually once, remove ${PID_FILE}, and retry the install." >&2
    return 1
  fi
  # During an upgrade SOURCE_DIR is the complete new release. Its crash-only
  # control code must stop the old Server before INSTALL_DIR is mutated.
  run_release_cli "${SOURCE_DIR}" stop --config-dir "${config_dir}"
  rm -f "${PID_FILE}"
}

write_default_env_var() {
  local name="$1"
  local value="$2"
  printf 'if [ -z "${%s:-}" ]; then export %s=%q; fi\n' "${name}" "${name}" "${value}" >> "${PERSISTED_ENV_FILE}"
}

write_persisted_env() {
  mkdir -p "${INSTALL_DIR}"
  : > "${PERSISTED_ENV_FILE}"
  chmod 600 "${PERSISTED_ENV_FILE}" 2>/dev/null || true
  write_default_env_var FARMING_PORT "${PORT_VALUE}"
  write_default_env_var FARMING_BASE_PATH "${BASE_PATH}"
  write_default_env_var FARMING_USE_GLIBC_RUNTIME "${USE_GLIBC_RUNTIME}"
  write_default_env_var FARMING_GLIBC_RUNTIME_ROOT "${GLIBC_RUNTIME_ROOT}"
  write_default_env_var FARMING_NODE_MAX_OLD_SPACE_SIZE "${FARMING_NODE_MAX_OLD_SPACE_SIZE:-auto}"
  [ -n "${FARMING_RUNTIME_NPM_MIRROR:-}" ] \
    && write_default_env_var FARMING_RUNTIME_NPM_MIRROR "${FARMING_RUNTIME_NPM_MIRROR}"
  [ -n "${CONFIG_DIR_VALUE}" ] && write_default_env_var FARMING_CONFIG_DIR "${CONFIG_DIR_VALUE}"
  [ -n "${SERVER_HOME_VALUE}" ] && write_default_env_var FARMING_SERVER_HOME "${SERVER_HOME_VALUE}"
  return 0
}

start_server() {
  ensure_prerequisites
  ensure_glibc_runtime
  write_managed_npm_launchers
  stop_server
  if release_uses_managed_npm; then
    local managed_args=(daemon --port "${PORT_VALUE}" --base-path "${BASE_PATH}")
    [ -n "${CONFIG_DIR_VALUE}" ] && managed_args+=(--config-dir "${CONFIG_DIR_VALUE}")
    [ -n "${SERVER_HOME_VALUE}" ] && managed_args+=(--home "${SERVER_HOME_VALUE}")
    if is_truthy "${FARMING_DISABLE_AUTH:-0}"; then
      managed_args+=(--no-auth)
    fi
    log "Starting npm-managed Farming server on port ${PORT_VALUE} ..."
    "${STABLE_CLI_DIR}/farming" "${managed_args[@]}"
    echo "Managed CLI: ${STABLE_CLI_DIR}/farming"
    echo "Future updates use npm prefix: ${NPM_PREFIX}"
    return 0
  fi
  write_persisted_env

  local config_dir daemon_args
  config_dir="$(effective_config_dir)"
  daemon_args=(daemon --port "${PORT_VALUE}" --base-path "${BASE_PATH}" --config-dir "${config_dir}")
  [ -n "${SERVER_HOME_VALUE}" ] && daemon_args+=(--home "${SERVER_HOME_VALUE}")
  is_truthy "${FARMING_DISABLE_AUTH:-0}" && daemon_args+=(--no-auth)
  log "Starting Farming server on port ${PORT_VALUE} ..."
  run_installed_cli "${daemon_args[@]}"
  cp "${config_dir}/farming-server.pid" "${PID_FILE}"

  log "Server started. Access URL:"
  echo ""
  tail -80 "${config_dir}/farming-server.log" | grep -E 'Local:|Network:|Token:|Token auth|Farming server running' || tail -40 "${config_dir}/farming-server.log"
  echo ""
}

status_server() {
  if release_uses_managed_npm && [ -x "${STABLE_CLI_DIR}/farming" ]; then
    local managed_args=(status)
    [ -n "${CONFIG_DIR_VALUE}" ] && managed_args+=(--config-dir "${CONFIG_DIR_VALUE}")
    "${STABLE_CLI_DIR}/farming" "${managed_args[@]}"
    return 0
  fi
  run_installed_cli status --config-dir "$(effective_config_dir)"
}

logs_server() {
  if release_uses_managed_npm && [ -x "${STABLE_CLI_DIR}/farming" ]; then
    local managed_args=(logs)
    [ -n "${CONFIG_DIR_VALUE}" ] && managed_args+=(--config-dir "${CONFIG_DIR_VALUE}")
    "${STABLE_CLI_DIR}/farming" "${managed_args[@]}"
    return 0
  fi
  run_installed_cli logs --config-dir "$(effective_config_dir)"
}

install_release() {
  ensure_prerequisites
  prepare_release_runtime_dependencies
  stop_server
  sync_release_files
  install_dependencies
  start_server
}

usage() {
  cat <<EOF
Usage: scripts/install-release.sh <command>
       ./farming <command>

Commands:
  install  Install this release into FARMING_INSTALL_DIR and start it
  start    Start or restart the installed server
  daemon   Alias of start for parity with the single-file CLI release
  stop     Stop the installed server
  status   Show server status and recent startup URL
  logs     Show recent logs

Environment:
  FARMING_INSTALL_DIR=${HOME}/farming
  FARMING_INSTALL_CONFIG_FILE=config/farming.install.env
  FARMING_PORT=6694
  FARMING_BASE_PATH=/farming
  FARMING_CONFIG_DIR=          # optional, custom settings/token directory
  FARMING_SERVER_HOME=         # optional, isolate Codex/Claude history for demos/tests
  FARMING_USE_GLIBC_RUNTIME=auto  # use a bundled legacy runtime on Linux glibc < 2.28
  FARMING_GLIBC_RUNTIME_ROOT=  # optional extraction directory for that runtime
  FARMING_NPM_PREFIX=${HOME}/.farming/npm  # managed prefix used by the legacy Linux bootstrap
  FARMING_RUNTIME_NPM_MIRROR=  # override the packaged mirror candidate; use off to disable
  FARMING_NODE_MAX_OLD_SPACE_SIZE=auto  # auto-detect from cgroup or system memory; 0 disables override
  FARMING_DISABLE_AUTH=1      # optional, trusted local networks only
EOF
}

case "${1:-install}" in
  install) install_release ;;
  start|serve|daemon) start_server ;;
  stop) stop_server ;;
  status) status_server ;;
  logs) logs_server ;;
  *) usage; exit 1 ;;
esac
