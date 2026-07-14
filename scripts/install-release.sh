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
LOG_FILE="${INSTALL_DIR}/farming.log"

log() {
  echo "==> $*"
}

is_truthy() {
  [[ "${1:-}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]
}

ensure_prerequisites() {
  [ -n "${SYSTEM_NODE_BIN}" ] || { echo "Node.js 22 or newer is required." >&2; exit 1; }
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

  local node_exec config_line home_line auth_line
  node_exec="exec \"${SYSTEM_NODE_BIN}\" \"\$@\""
  if use_glibc_runtime; then
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
export FARMING_NODE_BIN="${RUNTIME_BIN_DIR}/node"
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

stop_server() {
  if release_uses_managed_npm && [ -x "${STABLE_CLI_DIR}/farming" ]; then
    local managed_args=(stop)
    [ -n "${CONFIG_DIR_VALUE}" ] && managed_args+=(--config-dir "${CONFIG_DIR_VALUE}")
    "${STABLE_CLI_DIR}/farming" "${managed_args[@]}" || true
    return 0
  fi
  if [ ! -f "${PID_FILE}" ]; then
    log "No PID file found. Server not running."
    return 0
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
    log "Stopping server (PID ${pid}) ..."
    kill "${pid}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      if ! kill -0 "${pid}" 2>/dev/null; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "${pid}" 2>/dev/null; then
      kill -9 "${pid}" 2>/dev/null || true
    fi
  else
    log "Stale PID file found. Cleaning up."
  fi
  rm -f "${PID_FILE}"
}

write_launcher() {
  local node_bin auth_line config_line home_line exec_line runtime_lines
  node_bin="${SYSTEM_NODE_BIN}"
  exec_line="exec \"${node_bin}\" backend/server.js"
  runtime_lines="unset FARMING_NODE_LD FARMING_NODE_LIBRARY_PATH FARMING_NPM_COMMAND FARMING_NPM_PREFIX"
  if use_glibc_runtime; then
    exec_line="exec \"${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so\" --library-path \"${GLIBC_RUNTIME_ROOT}/lib\" \"${node_bin}\" backend/server.js"
    runtime_lines="${runtime_lines}
export FARMING_NODE_LD=\"${GLIBC_RUNTIME_ROOT}/lib/ld-2.28.so\"
export FARMING_NODE_LIBRARY_PATH=\"${GLIBC_RUNTIME_ROOT}/lib\""
  fi
  auth_line="unset FARMING_DISABLE_AUTH"
  if is_truthy "${FARMING_DISABLE_AUTH:-0}"; then
    auth_line="export FARMING_DISABLE_AUTH=1"
    log "Token auth will be disabled for this server process."
  else
    log "Token auth is enabled by default."
  fi

  config_line=""
  if [ -n "${CONFIG_DIR_VALUE}" ]; then
    mkdir -p "${CONFIG_DIR_VALUE}"
    config_line="export FARMING_CONFIG_DIR=\"${CONFIG_DIR_VALUE}\""
  fi

  home_line=""
  if [ -n "${SERVER_HOME_VALUE}" ]; then
    mkdir -p "${SERVER_HOME_VALUE}"
    home_line="export HOME=\"${SERVER_HOME_VALUE}\""
  fi

  write_persisted_env

  cat > "${INSTALL_DIR}/.farming-launcher.sh" <<EOF
#!/usr/bin/env bash
source ~/.bashrc 2>/dev/null || source ~/.bash_profile 2>/dev/null || true
cd "${INSTALL_DIR}"
export PORT="${PORT_VALUE}"
export FARMING_BASE_PATH="${BASE_PATH}"
export FARMING_NODE_BIN="${node_bin}"
${runtime_lines}
${config_line}
${home_line}
if [ "\${FARMING_NODE_MAX_OLD_SPACE_SIZE:-auto}" = "auto" ] || [ -z "\${FARMING_NODE_MAX_OLD_SPACE_SIZE:-}" ]; then
  export FARMING_NODE_MAX_OLD_SPACE_SIZE="\$(./scripts/compute-node-heap-mb.sh)"
fi
case "\${FARMING_NODE_MAX_OLD_SPACE_SIZE}" in
  0|off|OFF|false|FALSE)
    unset NODE_OPTIONS
    ;;
  *)
    export NODE_OPTIONS="--max-old-space-size=\${FARMING_NODE_MAX_OLD_SPACE_SIZE}"
    echo "Farming Node heap max: \${FARMING_NODE_MAX_OLD_SPACE_SIZE} MB"
    ;;
esac
${auth_line}
${exec_line}
EOF
  chmod +x "${INSTALL_DIR}/.farming-launcher.sh"
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
  write_launcher

  log "Starting Farming server on port ${PORT_VALUE} ..."
  nohup "${INSTALL_DIR}/.farming-launcher.sh" > "${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  sleep 3

  if ! kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    log "Server failed to stay running. Recent logs:"
    tail -80 "${LOG_FILE}" 2>/dev/null || true
    rm -f "${PID_FILE}"
    exit 1
  fi

  log "Server started. Access URL:"
  echo ""
  tail -80 "${LOG_FILE}" | grep -E 'Local:|Network:|Token:|Token auth|Farming server running' || tail -40 "${LOG_FILE}"
  echo ""
}

status_server() {
  if release_uses_managed_npm && [ -x "${STABLE_CLI_DIR}/farming" ]; then
    local managed_args=(status)
    [ -n "${CONFIG_DIR_VALUE}" ] && managed_args+=(--config-dir "${CONFIG_DIR_VALUE}")
    "${STABLE_CLI_DIR}/farming" "${managed_args[@]}"
    return 0
  fi
  if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    log "Server is RUNNING (PID $(cat "${PID_FILE}"))"
    tail -40 "${LOG_FILE}" 2>/dev/null || true
  else
    log "Server is NOT running."
    rm -f "${PID_FILE}"
  fi
}

logs_server() {
  if release_uses_managed_npm && [ -x "${STABLE_CLI_DIR}/farming" ]; then
    local managed_args=(logs)
    [ -n "${CONFIG_DIR_VALUE}" ] && managed_args+=(--config-dir "${CONFIG_DIR_VALUE}")
    "${STABLE_CLI_DIR}/farming" "${managed_args[@]}"
    return 0
  fi
  tail -80 "${LOG_FILE}" 2>/dev/null || echo "No log file found."
}

install_release() {
  ensure_prerequisites
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
