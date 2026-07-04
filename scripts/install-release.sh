#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_CONFIG_FILE="${FARMING_INSTALL_CONFIG_FILE:-${SOURCE_DIR}/config/farming.install.env}"
if [ -f "${INSTALL_CONFIG_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${INSTALL_CONFIG_FILE}"
fi

default_install_dir() {
  if [ -f "${SOURCE_DIR}/RELEASE.json" ] && [ -f "${SOURCE_DIR}/dist/index.html" ]; then
    printf '%s\n' "${SOURCE_DIR}"
  else
    printf '%s\n' "${HOME}/farming"
  fi
}

INSTALL_DIR="${FARMING_INSTALL_DIR:-$(default_install_dir)}"
PERSISTED_ENV_FILE="${INSTALL_DIR}/.farming-install-env"
if [ -f "${PERSISTED_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${PERSISTED_ENV_FILE}"
fi

PORT_VALUE="${FARMING_PORT:-${PORT:-6694}}"
BASE_PATH="${FARMING_BASE_PATH:-/farming}"
CONFIG_DIR_VALUE="${FARMING_CONFIG_DIR:-}"
SERVER_HOME_VALUE="${FARMING_SERVER_HOME:-}"
USE_GLIBC="${FARMING_USE_GLIBC:-auto}"

default_glibc_root() {
  local install_parent
  install_parent="$(cd "$(dirname "${INSTALL_DIR}")" 2>/dev/null && pwd || dirname "${INSTALL_DIR}")"
  if [ -x "${install_parent}/glibc228/lib/ld-2.28.so" ]; then
    printf '%s\n' "${install_parent}/glibc228"
  else
    printf '%s\n' "${HOME}/.farming/glibc228"
  fi
}

GLIBC_ROOT="${FARMING_GLIBC_ROOT:-$(default_glibc_root)}"
GLIBC_DIR="${GLIBC_ROOT}/lib"
GLIBC_TARBALL="${FARMING_GLIBC_TARBALL:-}"
BUNDLED_GLIBC_TARBALL="${SOURCE_DIR}/vendor/glibc228-lib.tar.gz"
GLIBC_SOURCE_REPO="https://github.com/liuliping0315/glibc2.28_for_CentOS7.git"
PID_FILE="${INSTALL_DIR}/.farming.pid"
LOG_FILE="${INSTALL_DIR}/farming.log"

log() {
  echo "==> $*"
}

is_truthy() {
  [[ "${1:-}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]
}

glibc_version_lt_228() {
  local version
  version="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
  if [ -z "${version}" ]; then
    return 1
  fi
  awk -v version="${version}" 'BEGIN {
    split(version, parts, ".")
    major = parts[1] + 0
    minor = parts[2] + 0
    exit !(major < 2 || (major == 2 && minor < 28))
  }'
}

use_glibc() {
  case "${USE_GLIBC}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    0|false|FALSE|no|NO|off|OFF)
      return 1
      ;;
    auto)
      glibc_version_lt_228
      ;;
    *)
      echo "Unknown FARMING_USE_GLIBC value: ${USE_GLIBC}" >&2
      exit 1
      ;;
  esac
}

ensure_prerequisites() {
  command -v node >/dev/null
  command -v npm >/dev/null
  if use_glibc && [ ! -f "${GLIBC_TARBALL}" ] && [ ! -f "${BUNDLED_GLIBC_TARBALL}" ]; then
    command -v git >/dev/null
  fi
}

install_glibc_from_tarball() {
  local tarball="$1"
  local tmp_dir found lib_source
  tmp_dir="$(mktemp -d /tmp/farming-glibc.XXXXXX)"
  tar --no-same-owner -xf "${tarball}" -C "${tmp_dir}"
  chmod -R u+rwX "${tmp_dir}" 2>/dev/null || true
  found="$(find "${tmp_dir}" -type f -name 'ld-2.28.so' | head -1 || true)"
  if [ -z "${found}" ]; then
    chmod -R u+rwX "${tmp_dir}" 2>/dev/null || true
    rm -rf "${tmp_dir}"
    echo "glibc tarball does not contain ld-2.28.so: ${tarball}" >&2
    exit 1
  fi

  lib_source="$(dirname "${found}")"
  mkdir -p "${GLIBC_ROOT}"
  rm -rf "${GLIBC_DIR}"
  cp -R "${lib_source}" "${GLIBC_DIR}"
  chmod -R u+rwX "${GLIBC_DIR}" 2>/dev/null || true
  rm -rf "${tmp_dir}"
}

ensure_glibc() {
  if ! use_glibc; then
    log "Skipping glibc 2.28 runtime setup."
    return 0
  fi

  log "Ensuring glibc 2.28 runtime is available ..."
  if [ -x "${GLIBC_DIR}/ld-2.28.so" ]; then
    return 0
  fi

  if [ -n "${GLIBC_TARBALL}" ]; then
    log "Installing glibc runtime from ${GLIBC_TARBALL} ..."
    install_glibc_from_tarball "${GLIBC_TARBALL}"
    return 0
  fi

  if [ -f "${BUNDLED_GLIBC_TARBALL}" ]; then
    log "Installing bundled glibc runtime ..."
    install_glibc_from_tarball "${BUNDLED_GLIBC_TARBALL}"
    return 0
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d /tmp/farming-glibc.XXXXXX)"
  git clone --depth 1 "${GLIBC_SOURCE_REPO}" "${tmp_dir}/repo" >/dev/null 2>&1
  tar -xf "${tmp_dir}/repo/lib.tgz" -C "${tmp_dir}/repo"
  mkdir -p "${GLIBC_ROOT}"
  rm -rf "${GLIBC_DIR}"
  cp -R "${tmp_dir}/repo/lib" "${GLIBC_ROOT}/"
  rm -rf "${tmp_dir}"
}

sync_release_files() {
  mkdir -p "${INSTALL_DIR}"
  local source_real install_real
  source_real="$(cd "${SOURCE_DIR}" && pwd)"
  install_real="$(cd "${INSTALL_DIR}" && pwd)"
  if [ "${source_real}" = "${install_real}" ]; then
    return 0
  fi

  log "Installing release files to ${INSTALL_DIR} ..."
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'node_modules/' \
      --exclude '.farming.pid' \
      --exclude '.farming-install-env' \
      --exclude 'farming.log' \
      "${SOURCE_DIR}/" "${INSTALL_DIR}/"
    return 0
  fi

  find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 \
    ! -name node_modules \
    ! -name .farming.pid \
    ! -name .farming-install-env \
    ! -name farming.log \
    -exec rm -rf {} +
  (
    cd "${SOURCE_DIR}"
    tar \
      --exclude './node_modules' \
      --exclude './.farming.pid' \
      --exclude './.farming-install-env' \
      --exclude './farming.log' \
      -cf - .
  ) | (
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
  local node_bin auth_line config_line home_line node_runtime_lines exec_line
  node_bin="$(command -v node)"
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

  if use_glibc; then
    exec_line="exec ${GLIBC_DIR}/ld-2.28.so --library-path ${GLIBC_DIR} ${node_bin} backend/server.js"
    node_runtime_lines="export FARMING_NODE_LD=\"${GLIBC_DIR}/ld-2.28.so\"
export FARMING_NODE_LIBRARY_PATH=\"${GLIBC_DIR}\""
  else
    exec_line="exec ${node_bin} backend/server.js"
    node_runtime_lines="unset FARMING_NODE_LD
unset FARMING_NODE_LIBRARY_PATH"
  fi

  cat > "${INSTALL_DIR}/.farming-launcher.sh" <<EOF
#!/usr/bin/env bash
source ~/.bashrc 2>/dev/null || source ~/.bash_profile 2>/dev/null || true
cd "${INSTALL_DIR}"
export PORT="${PORT_VALUE}"
export FARMING_BASE_PATH="${BASE_PATH}"
export FARMING_NODE_BIN="${node_bin}"
${node_runtime_lines}
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
  write_default_env_var FARMING_USE_GLIBC "${USE_GLIBC}"
  write_default_env_var FARMING_GLIBC_ROOT "${GLIBC_ROOT}"
  write_default_env_var FARMING_NODE_MAX_OLD_SPACE_SIZE "${FARMING_NODE_MAX_OLD_SPACE_SIZE:-auto}"
  [ -n "${CONFIG_DIR_VALUE}" ] && write_default_env_var FARMING_CONFIG_DIR "${CONFIG_DIR_VALUE}"
  [ -n "${SERVER_HOME_VALUE}" ] && write_default_env_var FARMING_SERVER_HOME "${SERVER_HOME_VALUE}"
  [ -n "${GLIBC_TARBALL}" ] && write_default_env_var FARMING_GLIBC_TARBALL "${GLIBC_TARBALL}"
  [ -n "${FARMING_UPDATE_MANIFEST_URL:-}" ] && write_default_env_var FARMING_UPDATE_MANIFEST_URL "${FARMING_UPDATE_MANIFEST_URL}"
  [ -n "${FARMING_UPDATE_ASSET_BASE_URL:-}" ] && write_default_env_var FARMING_UPDATE_ASSET_BASE_URL "${FARMING_UPDATE_ASSET_BASE_URL}"
  [ -n "${FARMING_UPDATE_ASSET_PATTERN:-}" ] && write_default_env_var FARMING_UPDATE_ASSET_PATTERN "${FARMING_UPDATE_ASSET_PATTERN}"
  [ -n "${FARMING_UPDATE_AUTH_TOKEN:-}" ] && write_default_env_var FARMING_UPDATE_AUTH_TOKEN "${FARMING_UPDATE_AUTH_TOKEN}"
  [ -n "${FARMING_UPDATE_ALLOW_UNBUNDLED_GLIBC:-}" ] && write_default_env_var FARMING_UPDATE_ALLOW_UNBUNDLED_GLIBC "${FARMING_UPDATE_ALLOW_UNBUNDLED_GLIBC}"
  return 0
}

start_server() {
  ensure_prerequisites
  ensure_glibc
  stop_server
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
  if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    log "Server is RUNNING (PID $(cat "${PID_FILE}"))"
    tail -40 "${LOG_FILE}" 2>/dev/null || true
  else
    log "Server is NOT running."
    rm -f "${PID_FILE}"
  fi
}

logs_server() {
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
  FARMING_UPDATE_MANIFEST_URL= # optional, enable in-app upgrades from an HTTP(S) manifest
  FARMING_UPDATE_ASSET_BASE_URL= # optional, base URL for relative update tarball paths
  FARMING_USE_GLIBC=auto
  FARMING_GLIBC_ROOT=          # optional, defaults to sibling glibc228/ or ~/.farming/glibc228
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
