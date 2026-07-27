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

# ── Configuration ──────────────────────────────────────────────
REMOTE="$(resolve_remote)"
REMOTE_DIR="${FARMING_REMOTE_DIR:-farming}"
REMOTE_PORT="${FARMING_REMOTE_PORT:-6694}"
REMOTE_BASE_PATH="${FARMING_REMOTE_BASE_PATH:-/farming}"
REMOTE_CONFIG_DIR="${FARMING_REMOTE_CONFIG_DIR:-}"
REMOTE_GLIBC_ROOT="${FARMING_REMOTE_GLIBC_ROOT:-}"
REMOTE_USE_GLIBC="${FARMING_REMOTE_USE_GLIBC:-${REMOTE_GLIBC_ROOT:+1}}"

PID_FILE="${REMOTE_DIR}/.farming.pid"
REMOTE_STAGE_DIR="${REMOTE_DIR}.deploy-staging"
REMOTE_BACKUP_DIR="${REMOTE_DIR}.deploy-backup"
REMOTE_DEPLOY_STATE="${REMOTE_DIR}.deploy-state"
DEPLOY_OPERATION_ID="$(date +%s)-$$"

# ── Helpers ────────────────────────────────────────────────────
remote() {
  ssh "${REMOTE}" "$@"
}

log() {
  echo "==> $*"
}

ensure_remote_dir() {
  remote "mkdir -p ${REMOTE_DIR}"
}

recover_interrupted_deploy() {
  remote "phase=\$(sed -n 's/^phase=//p' ${REMOTE_DEPLOY_STATE} 2>/dev/null | head -1); \
    if test -e ${REMOTE_BACKUP_DIR}; then \
      case \"\$phase\" in \
        switching|awaiting-health) \
          if test -e ${REMOTE_DIR}; then exit 0; fi; \
          mv ${REMOTE_BACKUP_DIR} ${REMOTE_DIR}; \
          rm -f ${REMOTE_DEPLOY_STATE} ;; \
        committed) \
          rm -rf ${REMOTE_BACKUP_DIR}; \
          rm -f ${REMOTE_DEPLOY_STATE} ;; \
        *) \
          echo 'Deployment backup exists without a provable activation phase; refusing automatic cleanup.' >&2; \
          exit 1 ;; \
      esac; \
    elif test \"\$phase\" = switching && test ! -e ${REMOTE_DIR}; then \
      echo 'Interrupted deployment has neither a live directory nor a rollback directory.' >&2; \
      exit 1; \
  fi"
}

rollback_pending_deploy() {
  if remote_server_control_exists 2>/dev/null; then
    cmd_stop_with_root "${REMOTE_DIR}"
  fi
  remote "test -e ${REMOTE_BACKUP_DIR}; \
    rm -rf ${REMOTE_DIR}; \
    mv ${REMOTE_BACKUP_DIR} ${REMOTE_DIR}; \
    rm -f ${REMOTE_DEPLOY_STATE}"
}

ensure_remote_prerequisites() {
  log "Checking remote prerequisites ..."
  remote "command -v node >/dev/null && command -v npm >/dev/null && command -v git >/dev/null && command -v curl >/dev/null"
  if remote_uses_glibc; then
    if [ -z "${REMOTE_GLIBC_ROOT}" ]; then
      echo "FARMING_REMOTE_GLIBC_ROOT is required when FARMING_REMOTE_USE_GLIBC is enabled." >&2
      exit 1
    fi
    remote "test -x ${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so"
  fi
}

remote_uses_glibc() {
  [[ "${REMOTE_USE_GLIBC}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]
}

configured_token() {
  printf '%s' "${FARMING_REMOTE_TOKEN:-${FARMING_TOKEN:-}}"
}

server_config_dir() {
  if [ -n "${REMOTE_CONFIG_DIR}" ]; then
    printf '%s' "${REMOTE_CONFIG_DIR}"
    return
  fi
  remote 'printf "%s" "$HOME/.farming"'
}

remote_server_control_exists() {
  local config_dir
  config_dir="$(server_config_dir)"
  remote "test -f ${PID_FILE} || test -f ${config_dir}/farming-server.pid"
}

remote_token_b64() {
  local configured
  configured="$(configured_token)"
  if [ -n "${configured}" ]; then
    printf '%s' "${configured}" | base64 | tr -d '\n'
    return
  fi

  local config_dir
  config_dir="$(server_config_dir)"
  remote "if [ -f ${config_dir}/.session-token ]; then \
    token=\$(cat ${config_dir}/.session-token); \
    printf '%s' \"\$token\" | base64 | tr -d '\n'; \
  fi" 2>/dev/null || true
}

source_release_metadata_b64() {
  node - "${PROJECT_ROOT}" <<'NODE' | base64 | tr -d '\n'
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = process.argv[2];

function git(args) {
  try {
    return childProcess.execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitQuiet(args) {
  try {
    childProcess.execFileSync('git', ['-C', projectRoot, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function isDirty() {
  if (!gitQuiet(['diff', '--quiet'])) return true;
  if (!gitQuiet(['diff', '--cached', '--quiet'])) return true;
  return git(['ls-files', '--others', '--exclude-standard']) !== '';
}

function normalizeSemver(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function compareSemver(left, right) {
  const leftParts = normalizeSemver(left).split('.').map(part => Number(part) || 0);
  const rightParts = normalizeSemver(right).split('.').map(part => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((leftParts[index] || 0) > (rightParts[index] || 0)) return 1;
    if ((leftParts[index] || 0) < (rightParts[index] || 0)) return -1;
  }
  return 0;
}

function latestTaggedVersion() {
  return git(['tag', '--list', 'v[0-9]*', '--sort=-v:refname'])
    .split(/\r?\n/)
    .map(normalizeSemver)
    .find(Boolean) || '';
}

function sourceVersionSuffix(gitDescribe, dirty) {
  const described = String(gitDescribe || '').match(/^v?\d+\.\d+\.\d+-(\d+)-g[0-9a-f]+(?:-dirty)?$/i);
  if (described) return described[1];
  return dirty ? '1' : '';
}

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const gitSha = git(['rev-parse', 'HEAD']);
const gitDescribe = git(['describe', '--tags', '--dirty', '--always']) || gitSha.slice(0, 12) || String(packageJson.version || '');
const dirty = isDirty();
const packageVersion = String(packageJson.version || '');
const latestVersion = latestTaggedVersion();
const packageNewerThanLatest = compareSemver(packageVersion, latestVersion) > 0;
const baseVersion = packageNewerThanLatest ? normalizeSemver(packageVersion) : latestVersion;
const suffix = packageNewerThanLatest ? '' : sourceVersionSuffix(gitDescribe, dirty);
const releaseVersion = baseVersion
  ? `${baseVersion}${suffix ? `-${suffix}` : ''}`
  : gitDescribe.replace(/^v(?=\d)/, '');

process.stdout.write(JSON.stringify({
  type: 'source-deploy',
  releaseVersion,
  packageVersion,
  gitSha,
  gitDescribe,
  dirty,
  deployedAt: new Date().toISOString(),
  bundledNodeModules: false,
}, null, 2));
process.stdout.write('\n');
NODE
}

write_source_release_metadata() {
  local target_dir="${1:-${REMOTE_DIR}}"
  local metadata_b64
  metadata_b64="$(source_release_metadata_b64)"
  log "Writing source deployment metadata ..."
  remote "printf '%s' '${metadata_b64}' | base64 -d > ${target_dir}/RELEASE.json"
}

# ── Commands ───────────────────────────────────────────────────

prepare_deploy() {
  recover_interrupted_deploy
  if remote "test -f ${REMOTE_DEPLOY_STATE}" 2>/dev/null; then
    cmd_start
  fi
  remote "rm -rf ${REMOTE_STAGE_DIR} && mkdir -p \$(dirname ${REMOTE_STAGE_DIR}) ${REMOTE_STAGE_DIR}"
  ensure_remote_prerequisites

  log "Syncing code to staging directory ${REMOTE}:${REMOTE_STAGE_DIR} ..."
  rsync -azP --delete \
    --exclude 'node_modules/' \
    --exclude 'dist/' \
    --exclude 'dist-release/' \
    --exclude 'tmp/' \
    --exclude '.tmp/' \
    --exclude '.beads/' \
    --exclude '.gc/' \
    --exclude '.dolt-backup/' \
    --exclude 'fa-273-mol-dog-stale-db/' \
    --exclude 'fa-oxg-mol-dog-stale-db/' \
    --exclude '.git' \
    --exclude '.git/' \
    --exclude '.idea/' \
    --exclude '.farming/' \
    --exclude '.dolt/' \
    --exclude 'reference/' \
    --exclude 'archive/' \
    --exclude 'poem/' \
    --exclude 'conversation-log.md' \
    --exclude 'claude_plan.md' \
    --exclude 'remote-communication*.md' \
    --exclude 'terminal-session-attach-plan.md' \
    --exclude 'releases/' \
    --exclude 'eslint.config.js' \
    --exclude 'playwright.config.ts' \
    --exclude '[' \
    --exclude '.doltcfg/' \
    --exclude 'config.yaml' \
    --exclude 'playwright-report/' \
    --exclude 'test-results/' \
    --exclude 'tests/' \
    --exclude 'backend/tests/' \
    --exclude 'scripts/e2e*.js' \
    --exclude 'scripts/run-tests.js' \
    --exclude 'scripts/start-playwright-server.js' \
    --exclude 'scripts/test-*.js' \
    --exclude '.DS_Store' \
    --exclude '*.log' \
    --exclude '.farming.pid' \
    --exclude '.claude/' \
    --exclude '.env' \
    "${PROJECT_ROOT}/" "${REMOTE}:${REMOTE_STAGE_DIR}/"

  remote "if [ -f ${REMOTE_STAGE_DIR}/.git ]; then rm -f ${REMOTE_STAGE_DIR}/.git; fi"

  log "Installing dependencies ..."
  remote "cd ${REMOTE_STAGE_DIR} && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci"

  log "Building frontend and CRT renderers ..."
  remote "cd ${REMOTE_STAGE_DIR} && FARMING_BASE_PATH=${REMOTE_BASE_PATH} npm run build"

  log "Pruning development dependencies from runtime install ..."
  remote "cd ${REMOTE_STAGE_DIR} && npm prune --omit=dev"

  write_source_release_metadata "${REMOTE_STAGE_DIR}"
}

activate_prepared_deploy() {
  remote "test ! -e ${REMOTE_BACKUP_DIR}; \
    printf '%s\n' 'operationId=${DEPLOY_OPERATION_ID}' 'phase=switching' > ${REMOTE_DEPLOY_STATE}; \
    if test -e ${REMOTE_DIR}; then mv ${REMOTE_DIR} ${REMOTE_BACKUP_DIR}; fi; \
    if mv ${REMOTE_STAGE_DIR} ${REMOTE_DIR}; then \
      printf '%s\n' 'operationId=${DEPLOY_OPERATION_ID}' 'phase=awaiting-health' > ${REMOTE_DEPLOY_STATE}; \
    else \
      if test ! -e ${REMOTE_DIR} && test -e ${REMOTE_BACKUP_DIR}; then mv ${REMOTE_BACKUP_DIR} ${REMOTE_DIR}; fi; \
      rm -f ${REMOTE_DEPLOY_STATE}; \
      exit 1; \
    fi"
}

cmd_deploy() {
  prepare_deploy
  log "Deploy prepared. Run '$0 up' to stop the old Server, atomically activate it, and verify the new Server."
}

cmd_up() {
  prepare_deploy
  if remote_server_control_exists 2>/dev/null; then
    cmd_stop_with_root "${REMOTE_STAGE_DIR}"
  fi
  activate_prepared_deploy
  if FARMING_SKIP_DEPLOY_RECOVERY=1 cmd_start "$@"; then
    return 0
  fi
  echo "New Farming release failed to start; restoring the previous complete release." >&2
  if remote "test -e ${REMOTE_BACKUP_DIR}" 2>/dev/null; then
    rollback_pending_deploy
    cmd_start "$@" || true
  fi
  return 1
}

cmd_start() {
  local disable_auth="${FARMING_REMOTE_DISABLE_AUTH:-0}"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --disable-auth)
        disable_auth=1
        ;;
      --auth)
        disable_auth=0
        ;;
      --force)
        # Kept as a no-op for command compatibility. Restart is always crash-only.
        ;;
      *)
        echo "Unknown start option: $1" >&2
        exit 1
        ;;
    esac
    shift
  done

  if [ "${FARMING_SKIP_DEPLOY_RECOVERY:-0}" != "1" ]; then
    recover_interrupted_deploy
    if remote "test -f ${REMOTE_DEPLOY_STATE}" 2>/dev/null; then
      if FARMING_SKIP_DEPLOY_RECOVERY=1 cmd_start "$@"; then
        return 0
      fi
      if remote "test -e ${REMOTE_BACKUP_DIR}" 2>/dev/null; then
        echo "Interrupted Farming release failed health verification; restoring the previous release." >&2
        rollback_pending_deploy
        FARMING_SKIP_DEPLOY_RECOVERY=1 cmd_start "$@" || true
      fi
      return 1
    fi
  fi
  ensure_remote_dir

  local configured_token
  configured_token="$(configured_token)"
  local inherited_token_b64=""
  if [ -z "${configured_token}" ]; then
    inherited_token_b64="$(remote_token_b64)"
  fi

  # A PID file is an ownership claim, even when signal probing is denied.
  # The CLI validates the exact process identity before it sends SIGKILL.
  if remote_server_control_exists 2>/dev/null; then
    log "A previous Server control record exists. Reconciling it before start ..."
    cmd_stop
  fi

  log "Starting Farming server on ${REMOTE}:${REMOTE_PORT} ..."

  # Resolve node path on remote
  local remote_node
  remote_node=$(remote "which node")

  local auth_line
  auth_line="unset FARMING_DISABLE_AUTH"
  if [[ "${disable_auth}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]; then
    auth_line="export FARMING_DISABLE_AUTH=1"
    log "Token auth will be disabled for this server process."
  else
    log "Token auth is enabled by default. Use '$0 start --disable-auth' to run without token auth."
  fi

  local token_line
  token_line="unset FARMING_TOKEN"
  if [ -n "${configured_token}" ]; then
    local token_b64
    token_b64=$(printf '%s' "${configured_token}" | base64 | tr -d '\n')
    token_line="export FARMING_TOKEN=\"\$(printf '%s' '${token_b64}' | base64 -d)\""
  elif [ -n "${inherited_token_b64}" ]; then
    token_line="export FARMING_TOKEN=\"\$(printf '%s' '${inherited_token_b64}' | base64 -d)\""
  fi

  # Write launcher script on remote (login shell to inherit user PATH)
  local config_dir config_line exec_line runtime_lines auth_arg
  config_dir="$(server_config_dir)"
  config_line="export FARMING_CONFIG_DIR=${config_dir}"
  auth_arg=""
  if [[ "${disable_auth}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]; then
    auth_arg="--no-auth"
  fi
  exec_line="exec ${remote_node} bin/farming daemon --port ${REMOTE_PORT} --base-path ${REMOTE_BASE_PATH} --config-dir ${config_dir} ${auth_arg}"
  runtime_lines="unset FARMING_NODE_LD FARMING_NODE_LIBRARY_PATH"
  if remote_uses_glibc; then
    exec_line="exec ${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so --library-path ${REMOTE_GLIBC_ROOT}/lib ${remote_node} bin/farming daemon --port ${REMOTE_PORT} --base-path ${REMOTE_BASE_PATH} --config-dir ${config_dir} ${auth_arg}"
    runtime_lines="export FARMING_NODE_LD=${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so
export FARMING_NODE_LIBRARY_PATH=${REMOTE_GLIBC_ROOT}/lib"
  fi

  remote "printf '%s\n' \
    '#!/usr/bin/env bash' \
    'source ~/.bashrc 2>/dev/null || source ~/.bash_profile 2>/dev/null || true' \
    'cd ${REMOTE_DIR}' \
    'export PORT=${REMOTE_PORT}' \
    'export FARMING_BASE_PATH=${REMOTE_BASE_PATH}' \
    '${config_line}' \
    'export FARMING_NODE_BIN=${remote_node}' \
    '${runtime_lines}' \
    'if [ \"\${FARMING_NODE_MAX_OLD_SPACE_SIZE:-auto}\" = \"auto\" ] || [ -z \"\${FARMING_NODE_MAX_OLD_SPACE_SIZE:-}\" ]; then' \
    '  export FARMING_NODE_MAX_OLD_SPACE_SIZE=\"\$(./scripts/compute-node-heap-mb.sh)\"' \
    'fi' \
    'case \"\${FARMING_NODE_MAX_OLD_SPACE_SIZE}\" in' \
    '  0|off|OFF|false|FALSE) unset NODE_OPTIONS ;;' \
    '  *) export NODE_OPTIONS=\"--max-old-space-size=\${FARMING_NODE_MAX_OLD_SPACE_SIZE}\"; echo \"Farming Node heap max: \${FARMING_NODE_MAX_OLD_SPACE_SIZE} MB\" ;;' \
    'esac' \
    '${token_line}' \
    '${auth_line}' \
    '${exec_line}' \
    > ${REMOTE_DIR}/.farming-launcher.sh && chmod +x ${REMOTE_DIR}/.farming-launcher.sh"

  if ! remote "${REMOTE_DIR}/.farming-launcher.sh"; then
    return 1
  fi
  remote "cp ${config_dir}/farming-server.pid ${PID_FILE}"
  if remote "test -f ${REMOTE_DEPLOY_STATE} && grep -Eq '^phase=(switching|awaiting-health)$' ${REMOTE_DEPLOY_STATE}"; then
    remote "printf '%s\n' 'operationId=${DEPLOY_OPERATION_ID}' 'phase=committed' > ${REMOTE_DEPLOY_STATE}; \
      rm -rf ${REMOTE_BACKUP_DIR}; \
      rm -f ${REMOTE_DEPLOY_STATE}"
  fi

  log "Server started. Access URL:"
  echo ""
  remote "head -20 ${config_dir}/farming-server.log" 2>/dev/null || true
  echo ""
}

cmd_stop_with_root() {
  local cli_root="$1"
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --force)
        # Kept as a no-op for command compatibility. Stop is always crash-only.
        ;;
      *)
        echo "Unknown stop option: $1" >&2
        exit 1
        ;;
    esac
    shift
  done

  if ! remote_server_control_exists 2>/dev/null; then
    log "No PID file found. Server not running."
    return 0
  fi

  local control_config_dir
  control_config_dir="$(server_config_dir)"
  local pid
  pid="$(remote "if test -f ${control_config_dir}/farming-server.pid; then cat ${control_config_dir}/farming-server.pid; else cat ${PID_FILE}; fi")"
  log "Stopping server (PID ${pid}) ..."

  local remote_node
  remote_node="$(remote "which node")"
  local stop_command
  stop_command="${remote_node} bin/farming stop --config-dir ${control_config_dir}"
  if remote_uses_glibc; then
    stop_command="${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so --library-path ${REMOTE_GLIBC_ROOT}/lib ${remote_node} bin/farming stop --config-dir ${control_config_dir}"
  fi
  remote "(cd ${cli_root} && ${stop_command}) && rm -f ${PID_FILE}"
  log "Server stopped."
}

cmd_stop() {
  recover_interrupted_deploy
  cmd_stop_with_root "${REMOTE_DIR}" "$@"
}

cmd_status() {
  local config_dir remote_node status_command
  config_dir="$(server_config_dir)"
  remote_node="$(remote "which node")"
  status_command="${remote_node} bin/farming status --config-dir ${config_dir}"
  if remote_uses_glibc; then
    status_command="${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so --library-path ${REMOTE_GLIBC_ROOT}/lib ${remote_node} bin/farming status --config-dir ${config_dir}"
  fi
  remote "cd ${REMOTE_DIR} && ${status_command}"
}

cmd_logs() {
  local config_dir
  config_dir="$(server_config_dir)"
  remote "tail -50 ${config_dir}/farming-server.log" 2>/dev/null || echo "No log file found."
}

# ── Main ───────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  up [--disable-auth] [--force]
           Sync code, install deps, build frontend, prune dev deps, then restart.
  deploy   Sync code, install deps, build frontend
  start [--disable-auth] [--force]
           Start the server (or restart if running). Token auth is enabled by default.
  stop [--force]
           Stop the server immediately through the crash-only lifecycle.
  status   Check if server is running
  logs     Show recent log output

Environment:
  FARMING_REMOTE=user@host         # required unless config/farming.deploy.env exists
  FARMING_REMOTE_DIR=/path/to/farming
  FARMING_REMOTE_PORT=6694
  FARMING_REMOTE_BASE_PATH=/farming
  FARMING_REMOTE_CONFIG_DIR=/path/to/config
  FARMING_REMOTE_GLIBC_ROOT=/path/to/glibc228
  FARMING_REMOTE_USE_GLIBC=1      # launch Node through ld-2.28.so
EOF
}

case "${1:-}" in
  up)     shift; cmd_up "$@" ;;
  deploy) cmd_deploy ;;
  start)  shift; cmd_start "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  logs)   cmd_logs ;;
  *)      usage; exit 1 ;;
esac
