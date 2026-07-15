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
LOG_FILE="${REMOTE_DIR}/farming.log"

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

server_config_dir_for_pid() {
  local pid="$1"
  remote "config_dir=\$(tr '\0' '\n' < /proc/${pid}/environ 2>/dev/null | \
    sed -n 's/^FARMING_CONFIG_DIR=//p' | head -1); \
    if [ -z \"\$config_dir\" ]; then config_dir=\"\$HOME/.farming\"; fi; \
    printf '%s' \"\$config_dir\""
}

write_server_control_metadata() {
  local pid="$1"
  local config_dir
  config_dir="$(server_config_dir_for_pid "${pid}")"
  remote "mkdir -p ${config_dir}; \
    printf '%s' '${pid}' > ${config_dir}/farming-server.pid; \
    updated_at=\$(date -u +%Y-%m-%dT%H:%M:%S.000Z); \
    printf '{\n  \"pid\": %s,\n  \"port\": %s,\n  \"basePath\": \"%s\",\n  \"configDir\": \"%s\",\n  \"updatedAt\": \"%s\"\n}\n' \
      '${pid}' '${REMOTE_PORT}' '${REMOTE_BASE_PATH}' '${config_dir}' \"\$updated_at\" \
      > ${config_dir}/farming-server.json"
}

arg_force_restart() {
  if [[ "${FARMING_REMOTE_FORCE_RESTART:-0}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]; then
    return 0
  fi
  for arg in "$@"; do
    if [ "${arg}" = "--force" ]; then
      return 0
    fi
  done
  return 1
}

remote_token_b64() {
  local configured
  configured="$(configured_token)"
  if [ -n "${configured}" ]; then
    printf '%s' "${configured}" | base64 | tr -d '\n'
    return
  fi

  remote "if test -f ${PID_FILE} && kill -0 \$(cat ${PID_FILE}) 2>/dev/null; then \
    token=\$(tr '\0' '\n' < /proc/\$(cat ${PID_FILE})/environ 2>/dev/null | \
      sed -n 's/^FARMING_TOKEN=//p' | head -1); \
    if [ -z \"\$token\" ]; then \
      config_dir=\$(tr '\0' '\n' < /proc/\$(cat ${PID_FILE})/environ 2>/dev/null | \
        sed -n 's/^FARMING_CONFIG_DIR=//p' | head -1); \
      if [ -z \"\$config_dir\" ]; then config_dir=\"\$HOME/.farming\"; fi; \
      if [ -f \"\$config_dir/.session-token\" ]; then token=\$(cat \"\$config_dir/.session-token\"); fi; \
    fi; \
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
  local metadata_b64
  metadata_b64="$(source_release_metadata_b64)"
  log "Writing source deployment metadata ..."
  remote "printf '%s' '${metadata_b64}' | base64 -d > ${REMOTE_DIR}/RELEASE.json"
}

assert_safe_to_restart() {
  if arg_force_restart "$@"; then
    log "Force restart requested; skipping active agent guard."
    return 0
  fi

  if ! remote "test -f ${PID_FILE} && kill -0 \$(cat ${PID_FILE}) 2>/dev/null"; then
    return 0
  fi

  local token_b64
  token_b64="$(remote_token_b64)"
  log "Checking for active agents before restart ..."
  if remote "cd ${REMOTE_DIR} && \
    FARMING_GUARD_HTTP_URL='http://127.0.0.1:${REMOTE_PORT}${REMOTE_BASE_PATH}/api/update' \
    FARMING_GUARD_TOKEN_B64='${token_b64}' \
    node <<'NODE'
const http = require('http');

const url = new URL(process.env.FARMING_GUARD_HTTP_URL);
const tokenB64 = process.env.FARMING_GUARD_TOKEN_B64 || '';
if (tokenB64) {
  url.searchParams.set('token', Buffer.from(tokenB64, 'base64').toString('utf8'));
}

let completed = false;
function finish(code) {
  if (completed) return;
  completed = true;
  process.exit(code);
}

const request = http.get(url, (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { body += chunk; });
  response.on('end', () => {
    if (response.statusCode !== 200) {
      console.error('Could not read Farming restart blockers over HTTP: status ' + response.statusCode);
      finish(3);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      console.error('Could not read Farming restart blockers over HTTP: invalid JSON');
      finish(3);
      return;
    }

    const blocking = payload && payload.update && Array.isArray(payload.update.blockingAgents)
      ? payload.update.blockingAgents
      : null;
    if (!blocking) {
      console.error('Could not read Farming restart blockers over HTTP: missing blockingAgents');
      finish(3);
      return;
    }

    if (blocking.length > 0) {
      console.error('Refusing to restart because active non-recoverable agents would be interrupted:');
      for (const agent of blocking) {
        const title = agent.task || agent.command || agent.id;
        const cwd = agent.cwd || '';
        console.error('- ' + agent.id + ' | ' + (agent.command || 'agent') + ' | ' + title + (cwd ? ' | ' + cwd : ''));
      }
      console.error('Retry with --force or FARMING_REMOTE_FORCE_RESTART=1 only if interruption is intentional.');
      finish(2);
      return;
    }

    finish(0);
  });
});

request.setTimeout(3000, () => {
  request.destroy(new Error('HTTP timeout'));
});
request.on('error', (error) => {
  console.error('Could not read Farming restart blockers over HTTP: ' + error.message);
  finish(3);
});
NODE"; then
    return 0
  elif [ "$?" = "2" ]; then
    echo "Restart aborted. Farming reported active non-main agents." >&2
    exit 1
  fi

  log "HTTP restart guard unavailable; falling back to WebSocket state check."
  if remote "cd ${REMOTE_DIR} && \
    FARMING_GUARD_WS_URL='ws://127.0.0.1:${REMOTE_PORT}${REMOTE_BASE_PATH}/ws' \
    FARMING_GUARD_TOKEN_B64='${token_b64}' \
    node <<'NODE'
const WebSocket = require('ws');

const url = new URL(process.env.FARMING_GUARD_WS_URL);
const tokenB64 = process.env.FARMING_GUARD_TOKEN_B64 || '';
if (tokenB64) {
  url.searchParams.set('token', Buffer.from(tokenB64, 'base64').toString('utf8'));
}

const ws = new WebSocket(url.toString());
const timeout = setTimeout(() => {
  console.error('Could not read Farming state before restart: WebSocket timeout.');
  ws.close();
  process.exit(3);
}, 5000);

function agentKindForCommand(command) {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find((token) => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const basename = (executable || '').split('/').pop() || '';
  if (basename === 'codex') return 'codex';
  if (basename === 'claude') return 'claude';
  if (['bash', 'zsh', 'sh', 'fish'].includes(basename)) return 'shell';
  return executable ? 'agent' : null;
}

function currentTerminalText(agent) {
  if (!agent) return '';
  const previewText = typeof agent.previewText === 'string' ? agent.previewText : '';
  if (previewText.trim()) return previewText.toLowerCase();
  return String(agent.output || '').slice(-1800).toLowerCase();
}

function lastIndexOfAny(text, needles) {
  return needles.reduce((last, needle) => Math.max(last, text.lastIndexOf(needle)), -1);
}

function lastCodexIdleFooterIndex(text) {
  const matches = Array.from(text.matchAll(/(?:^|\n)\s*(?:gpt|codex)[^\n]*(?:·|•)\s*(?:~|\/)[^\n]*$/gim));
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
  return lastMatch && typeof lastMatch.index === 'number' ? lastMatch.index : -1;
}

function codexActiveIndex(text) {
  const activeTextIndex = lastIndexOfAny(text, [
    'pursuing goal',
    'esc to interrupt',
    'press esc to interrupt',
    'reconnecting',
    '/stop to close',
    'background terminal running',
  ]);
  const workingIndex = /\bworking\b/.test(text) ? text.lastIndexOf('working') : -1;
  const stepMatches = Array.from(text.matchAll(/step\s+\d+\s*\/\s*\d+/g));
  const lastStepMatch = stepMatches.length > 0 ? stepMatches[stepMatches.length - 1] : undefined;
  const stepIndex = lastStepMatch && typeof lastStepMatch.index === 'number' ? lastStepMatch.index : -1;
  return Math.max(activeTextIndex, workingIndex, stepIndex);
}

function codexBlockedIndex(text) {
  return lastIndexOfAny(text, [
    'goal blocked',
    'input exceeds the context window',
    'please adjust your input and try again',
  ]);
}

function isCodexRestartBlocking(agent) {
  const output = currentTerminalText(agent);
  if (!output) return false;
  if (output.includes('messages to be submitted after next tool call')) return true;

  const activeIndex = codexActiveIndex(output);
  if (activeIndex < 0) return false;

  const blockedIndex = codexBlockedIndex(output);
  if (blockedIndex >= activeIndex) return false;

  return lastCodexIdleFooterIndex(output) <= activeIndex;
}

function isClaudeRestartBlocking(agent) {
  const output = currentTerminalText(agent);
  return (
    output.includes('esc to interrupt') ||
    output.includes('escape to interrupt') ||
    output.includes('ctrl+c to interrupt') ||
    output.includes('ctrl-c to interrupt') ||
    output.includes('press esc to interrupt')
  );
}

function isRecoverableEngineAgent(agent) {
  return agent && agent.engineName === 'native';
}

function isAgentTerminalBusy(agent) {
  if (agent && agent.terminalStatus) {
    if (agent.terminalStatus.activity === 'busy') return true;
    if (agent.terminalStatus.activity === 'idle' || agent.terminalStatus.activity === 'exited') return false;
  }
  return agent && agent.terminalBusy === true;
}

function isRestartBlockingAgent(agent) {
  if (!agent || agent.isMain === true || agent.archived === true) return false;
  if (agent.status === 'pending') return true;
  if (agent.status !== 'running') return false;
  if (isRecoverableEngineAgent(agent)) return false;
  if (isAgentTerminalBusy(agent)) return true;

  const kind = agent.terminalStatus && agent.terminalStatus.kind && agent.terminalStatus.kind !== 'unknown'
    ? agent.terminalStatus.kind
    : agentKindForCommand(agent.command);
  if (kind === 'shell') return false;
  if (kind === 'codex') return isCodexRestartBlocking(agent);
  if (kind === 'claude') return isClaudeRestartBlocking(agent);
  return true;
}

ws.on('message', (raw) => {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (error) {
    return;
  }
  if (message.type !== 'state') return;

  clearTimeout(timeout);
  const agents = Array.isArray(message.state && message.state.agents) ? message.state.agents : [];
  const blocking = agents.filter(isRestartBlockingAgent);

  if (blocking.length > 0) {
    console.error('Refusing to restart because active non-recoverable agents would be interrupted:');
    for (const agent of blocking) {
      const title = agent.task || agent.command || agent.id;
      const cwd = agent.cwd || agent.projectWorkspace || '';
      console.error('- ' + agent.id + ' | ' + (agent.command || 'agent') + ' | ' + title + (cwd ? ' | ' + cwd : ''));
    }
    console.error('Retry with --force or FARMING_REMOTE_FORCE_RESTART=1 only if interruption is intentional.');
    ws.close();
    process.exit(2);
  }

  ws.close();
  process.exit(0);
});

ws.on('error', (error) => {
  clearTimeout(timeout);
  console.error('Could not read Farming state before restart: ' + error.message);
  process.exit(3);
});
NODE"; then
    return 0
  fi

  echo "Restart aborted. Farming could not prove that no active non-main agents are running." >&2
  exit 1
}

# ── Commands ───────────────────────────────────────────────────

cmd_deploy() {
  ensure_remote_dir
  ensure_remote_prerequisites

  log "Syncing code to ${REMOTE}:${REMOTE_DIR} ..."
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
    "${PROJECT_ROOT}/" "${REMOTE}:${REMOTE_DIR}/"

  remote "if [ -f ${REMOTE_DIR}/.git ]; then rm -f ${REMOTE_DIR}/.git; fi"

  log "Installing dependencies ..."
  remote "cd ${REMOTE_DIR} && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci"

  log "Building frontend ..."
  remote "cd ${REMOTE_DIR} && FARMING_BASE_PATH=${REMOTE_BASE_PATH} npx vite build"

  log "Pruning development dependencies from runtime install ..."
  remote "cd ${REMOTE_DIR} && npm prune --omit=dev"

  write_source_release_metadata

  log "Deploy complete."
}

cmd_up() {
  assert_safe_to_restart "$@"
  cmd_deploy
  cmd_start "$@"
}

cmd_start() {
  local disable_auth="${FARMING_REMOTE_DISABLE_AUTH:-0}"
  local force_restart=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --disable-auth)
        disable_auth=1
        ;;
      --auth)
        disable_auth=0
        ;;
      --force)
        force_restart=1
        ;;
      *)
        echo "Unknown start option: $1" >&2
        exit 1
        ;;
    esac
    shift
  done

  ensure_remote_dir

  local configured_token
  configured_token="$(configured_token)"
  local inherited_token_b64=""
  if [ -z "${configured_token}" ]; then
    inherited_token_b64="$(remote_token_b64)"
  fi

  # Stop if already running
  if remote "test -f ${PID_FILE} && kill -0 \$(cat ${PID_FILE}) 2>/dev/null"; then
    if [ "${force_restart}" = "1" ]; then
      assert_safe_to_restart --force
    else
      assert_safe_to_restart
    fi
    log "Server already running (PID $(remote "cat ${PID_FILE}")). Restarting ..."
    if [ "${force_restart}" = "1" ]; then
      cmd_stop --force
    else
      cmd_stop
    fi
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
  local config_line exec_line runtime_lines
  config_line="unset FARMING_CONFIG_DIR"
  if [ -n "${REMOTE_CONFIG_DIR}" ]; then
    config_line="export FARMING_CONFIG_DIR=${REMOTE_CONFIG_DIR}"
  fi
  exec_line="exec ${remote_node} backend/server.js"
  runtime_lines="unset FARMING_NODE_LD FARMING_NODE_LIBRARY_PATH"
  if remote_uses_glibc; then
    exec_line="exec ${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so --library-path ${REMOTE_GLIBC_ROOT}/lib ${remote_node} backend/server.js"
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

  remote "nohup ${REMOTE_DIR}/.farming-launcher.sh > ${LOG_FILE} 2>&1 & echo \$! > ${PID_FILE}"

  # Treat an early process exit or an unreachable HTTP endpoint as a failed
  # deployment instead of printing a misleading success message.
  local started_pid
  started_pid=$(remote "cat ${PID_FILE}")
  if ! remote "for _ in \$(seq 1 15); do \
    if ! kill -0 ${started_pid} 2>/dev/null; then exit 1; fi; \
    code=\$(curl -sS --connect-timeout 1 --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${REMOTE_PORT}${REMOTE_BASE_PATH}/ 2>/dev/null || true); \
    case \"\$code\" in 200|401) exit 0 ;; esac; \
    sleep 1; \
  done; \
  exit 1"; then
    echo "Farming server failed to become healthy on ${REMOTE}:${REMOTE_PORT}." >&2
    remote "tail -30 ${LOG_FILE}" >&2 || true
    return 1
  fi

  # Source deployments and the product CLI must agree on which process owns
  # the configured server. Otherwise a later `farming status` or `stop` can
  # act on stale control metadata left by an earlier daemon launch.
  write_server_control_metadata "${started_pid}"

  log "Server started. Access URL:"
  echo ""
  remote "head -20 ${LOG_FILE}" 2>/dev/null || true
  echo ""
}

cmd_stop() {
  local force_restart=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --force)
        force_restart=1
        ;;
      *)
        echo "Unknown stop option: $1" >&2
        exit 1
        ;;
    esac
    shift
  done

  if ! remote "test -f ${PID_FILE}" 2>/dev/null; then
    log "No PID file found. Server not running."
    return 0
  fi

  if [ "${force_restart}" = "1" ]; then
    assert_safe_to_restart --force
  else
    assert_safe_to_restart
  fi

  local pid
  pid=$(remote "cat ${PID_FILE}")
  local control_config_dir
  control_config_dir="$(server_config_dir_for_pid "${pid}")"
  log "Stopping server (PID ${pid}) ..."

  remote "kill ${pid} 2>/dev/null || true; \
    for _ in \$(seq 1 30); do \
      kill -0 ${pid} 2>/dev/null || break; \
      sleep 0.2; \
    done; \
    if kill -0 ${pid} 2>/dev/null; then kill -9 ${pid} 2>/dev/null || true; fi; \
    if test -f ${control_config_dir}/farming-server.pid && \
      test \"\$(cat ${control_config_dir}/farming-server.pid)\" = '${pid}'; then \
      rm -f ${control_config_dir}/farming-server.pid ${control_config_dir}/farming-server.json; \
    fi; \
    rm -f ${PID_FILE}"
  log "Server stopped."
}

cmd_status() {
  if remote "test -f ${PID_FILE} && kill -0 \$(cat ${PID_FILE}) 2>/dev/null"; then
    local pid
    pid=$(remote "cat ${PID_FILE}")
    log "Server is RUNNING (PID ${pid})"
    echo ""
    remote "head -20 ${LOG_FILE}" 2>/dev/null || true
  else
    log "Server is NOT running."
    remote "rm -f ${PID_FILE}" 2>/dev/null || true
  fi
}

cmd_logs() {
  remote "tail -50 ${LOG_FILE}" 2>/dev/null || echo "No log file found."
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
           Stop the server after checking that no non-main agents are active.
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
  FARMING_REMOTE_FORCE_RESTART=1   # bypass active-agent restart guard
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
