#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/farming-npm-smoke.XXXXXX)"
PREFIX="${TMP_ROOT}/prefix"
CONFIG_DIR="${TMP_ROOT}/config"
WORKSPACE_DIR="${TMP_ROOT}/workspace"
PORT_VALUE="${FARMING_NPM_SMOKE_PORT:-6794}"
NPM_CACHE="${TMP_ROOT}/npm-cache"
NPM_REGISTRY="${FARMING_NPM_SMOKE_REGISTRY:-https://registry.npmjs.org/}"
NPM_MAJOR="$(npm --version | cut -d. -f1)"
SERVER_PID=""
NATIVE_HOST_PID=""
MAIN_BASH_PID=""

if [ "${NPM_MAJOR}" -lt 12 ]; then
  echo "npm package release smoke requires npm 12 or newer, found $(npm --version)" >&2
  exit 1
fi

process_is_alive() {
  local pid="$1"
  [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1
}

wait_for_process_exit() {
  local pid="$1"
  local label="$2"
  local attempts=0
  while process_is_alive "${pid}"; do
    if [ "${attempts}" -ge 200 ]; then
      echo "npm package smoke leaked ${label} process ${pid}" >&2
      ps -p "${pid}" -o pid=,ppid=,command= >&2 || true
      return 1
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
}

terminate_smoke_process() {
  local pid="$1"
  if ! process_is_alive "${pid}"; then
    return
  fi
  kill -TERM "${pid}" >/dev/null 2>&1 || true
  local attempts=0
  while process_is_alive "${pid}" && [ "${attempts}" -lt 20 ]; do
    attempts=$((attempts + 1))
    sleep 0.1
  done
  if process_is_alive "${pid}"; then
    kill -KILL "${pid}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [ -x "${PREFIX}/bin/farming" ]; then
    "${PREFIX}/bin/farming" stop --config-dir "${CONFIG_DIR}" >/dev/null 2>&1 || true
  fi
  terminate_smoke_process "${SERVER_PID}"
  terminate_smoke_process "${NATIVE_HOST_PID}"
  terminate_smoke_process "${MAIN_BASH_PID}"
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

mkdir -p "${PREFIX}" "${CONFIG_DIR}" "${WORKSPACE_DIR}"
cd "${PROJECT_ROOT}"
NPM_CONFIG_CACHE="${NPM_CACHE}" NPM_CONFIG_REGISTRY="${NPM_REGISTRY}" \
  npm pack --pack-destination "${TMP_ROOT}" --silent >/dev/null
PACKAGE_TARBALL="$(find "${TMP_ROOT}" -maxdepth 1 -name 'farming-code-*.tgz' -print -quit)"
if [ -z "${PACKAGE_TARBALL}" ]; then
  echo "npm pack did not create a farming-code tarball" >&2
  exit 1
fi

NPM_CONFIG_CACHE="${NPM_CACHE}" NPM_CONFIG_REGISTRY="${NPM_REGISTRY}" \
  npm install --global --prefix "${PREFIX}" "${PACKAGE_TARBALL}" \
    --ignore-scripts --no-audit --no-fund --silent
PACKAGE_ROOT="${PREFIX}/lib/node_modules/farming-code"
CODEX_ACP_VENDOR="${PACKAGE_ROOT}/dist/acp/codex-acp-1.1.4.mjs"
CLAUDE_ACP_VENDOR="${PACKAGE_ROOT}/dist/acp/claude-agent-acp-0.59.0.mjs"
for runtime_module in \
  agent-order \
  agent-order-transaction \
  agent-provider-session \
  agent-env \
  agent-json-stream \
  agent-lifecycle-journal \
  agent-runtime-binding \
  acp-checkpoint-store \
  async-cache \
  auth \
  atomic-json-store \
  business-health \
  chat-runtime \
  cli-agents \
  claude-settings \
  codex-context-window \
  codex-models \
  codex-session-archive \
  codex-transcript-sanitizer \
  command-runner-child \
  control-api \
  executable-discovery \
  farming-agent-bootstrap \
  farming-cli \
  farming-session-store \
  farming-net-server \
  farming-net-pass \
  farming-net-registry \
  git-worktree-info \
  input-parts \
  input-routing \
  index-html \
  json-cli-runtime \
  main-agent-skills \
  main-page-session \
  native-pty-controller-generation \
  native-pty-host-identity \
  native-pty-host-path \
  native-session-engine \
  network \
  npm-update-helper \
  provider-adapters \
  provider-session-service \
  provider-session-id \
  preview-session-manager \
  qr-share-tickets \
  review-diff-router \
  review-session-service \
  review-session-router \
  review-session-store \
  review-state-router \
  review-state-store \
  run-history-store \
  runtime-executable-invocation \
  runtime-dependency-manager \
  runtime-observation \
  server-process-identity \
  session-engine \
  session-engine-bridge \
  session-engine-router \
  session-stream-protocol \
  slash-command-discovery \
  storage-layout \
  system-monitor \
  terminal-attach-checkpoint \
  terminal-exit-quiescence \
  terminal-reducer-flow-control \
  terminal-runtime-cleanup \
  terminal-screen-state \
  terminal-screen-worker-thread \
  terminal-screen-worker-pool \
  terminal-screen-worker \
  terminal-state-serialization \
  theme-manager \
  usage-forecast \
  usage-history-client \
  usage-history-smoke \
  usage-history-worker \
  update-service \
  workspace-directory \
  workspace-discovery \
  workspace-root-registry
do
  if [ ! -f "${PACKAGE_ROOT}/backend/${runtime_module}.cjs" ]; then
    echo "npm package omitted compiled backend runtime ${runtime_module}.cjs" >&2
    exit 1
  fi
  if [ -e "${PACKAGE_ROOT}/backend/${runtime_module}.cts" ]; then
    echo "npm package unexpectedly included backend TypeScript source ${runtime_module}.cts" >&2
    exit 1
  fi
done
if [ ! -f "${CODEX_ACP_VENDOR}" ]; then
  echo "npm package omitted the version-locked Codex ACP runtime" >&2
  exit 1
fi
if [ ! -f "${CLAUDE_ACP_VENDOR}" ]; then
  echo "npm package omitted the version-locked Claude ACP runtime" >&2
  exit 1
fi
node "${PROJECT_ROOT}/scripts/assert-no-bundled-agent-clis.js" "${PACKAGE_ROOT}"
node - "${PACKAGE_ROOT}" "${CODEX_ACP_VENDOR}" "${CLAUDE_ACP_VENDOR}" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [packageRoot, codexVendorEntry, claudeVendorEntry] = process.argv.slice(2);
const sha256 = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const expectedCodexVendor = '7d9647ad2af49d47311a785bf5abd2d317d7c7438ae9d4eacfe785ba37191718';
const expectedClaudeVendor = 'a6aa515dd02382617bf46d9eac47b8a1022c6835bcf7a8d61e2c63939be2e49c';
if (sha256(codexVendorEntry) !== expectedCodexVendor) {
  throw new Error('Packed Codex ACP runtime failed its SHA-256 verification');
}
if (sha256(claudeVendorEntry) !== expectedClaudeVendor) {
  throw new Error('Packed Claude ACP runtime failed its SHA-256 verification');
}
const { resolveAcpLaunch } = require(path.join(packageRoot, 'backend/acp-runtime'));
const codexLaunch = resolveAcpLaunch('codex');
if (fs.realpathSync(codexLaunch.args.at(-1)) !== fs.realpathSync(codexVendorEntry)) {
  throw new Error(`Codex ACP launch did not select the packaged runtime: ${codexLaunch.args.at(-1)}`);
}
const claudeLaunch = resolveAcpLaunch('claude');
if (fs.realpathSync(claudeLaunch.args.at(-1)) !== fs.realpathSync(claudeVendorEntry)) {
  throw new Error(`Claude ACP launch did not select the packaged runtime: ${claudeLaunch.args.at(-1)}`);
}
NODE
CODEX_PATH="${PROJECT_ROOT}/node_modules/.bin/codex" \
  node "${PROJECT_ROOT}/scripts/smoke-codex-acp-process.js" --package-root "${PACKAGE_ROOT}"
node "${PROJECT_ROOT}/scripts/smoke-claude-acp-process.js" --package-root "${PACKAGE_ROOT}"
node "${PROJECT_ROOT}/scripts/smoke-browser-mcp-process.js" --package-root "${PACKAGE_ROOT}"
"${PREFIX}/bin/farming" help >/dev/null
FARMING_DISABLE_AUTH=1 FARMING_NATIVE_PTY_HOST_PERSIST=0 FARMING_SKIP_RUNTIME_PREPARE=1 \
  "${PREFIX}/bin/farming" daemon \
  --port "${PORT_VALUE}" \
  --base-path /farming \
  --config-dir "${CONFIG_DIR}" >/dev/null
SERVER_PID="$(tr -d '[:space:]' < "${CONFIG_DIR}/farming-server.pid")"
if ! [[ "${SERVER_PID}" =~ ^[0-9]+$ ]] || ! process_is_alive "${SERVER_PID}"; then
  echo "npm package smoke could not identify the running Farming server" >&2
  exit 1
fi
curl --fail --silent --show-error "http://127.0.0.1:${PORT_VALUE}/farming/api/auth/status" | grep -q '"authRequired":false'

node -e '
  const path = require("path");
  const prefix = process.argv[1];
  const pty = require(path.join(prefix, "lib/node_modules/farming-code/node_modules/node-pty"));
  if (typeof pty.spawn !== "function") throw new Error("node-pty did not load from the npm package");
' "${PREFIX}"

SPAWN_OUT="$("${PREFIX}/bin/farming" spawn \
  --port "${PORT_VALUE}" \
  --config-dir "${CONFIG_DIR}" \
  --no-auth \
  --workspace "${WORKSPACE_DIR}" \
  -- /bin/bash)"
MAIN_AGENT_ID="$(printf '%s\n' "${SPAWN_OUT}" | sed -n 's/^Started //p' | head -1)"
if [ -z "${MAIN_AGENT_ID}" ]; then
  echo "npm package smoke failed to start its Main bash: ${SPAWN_OUT}" >&2
  exit 1
fi

RUNTIME_PIDS="$(node - "${PACKAGE_ROOT}" "${CONFIG_DIR}" <<'NODE'
const { execFileSync } = require('child_process');
const net = require('net');
const path = require('path');

const [packageRoot, configDir] = process.argv.slice(2);
const { nativePtyHostSocketPath } = require(path.join(packageRoot, 'backend/native-pty-host-path.cjs'));
const socketPath = nativePtyHostSocketPath(configDir);
const socket = net.createConnection(socketPath);
let buffer = '';
let identityResolved = false;
const timeout = setTimeout(() => {
  socket.destroy(new Error(`Timed out reading native PTY host identity from ${socketPath}`));
}, 5000);

socket.on('connect', () => {
  socket.write(`${JSON.stringify({ id: 'npm-smoke-ping', method: 'ping', params: {} })}\n`);
});
socket.on('data', chunk => {
  if (identityResolved) return;
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.id !== 'npm-smoke-ping') {
      newline = buffer.indexOf('\n');
      continue;
    }
    identityResolved = true;
    clearTimeout(timeout);
    const hostPid = Number(message.result && message.result.pid);
    if (!Number.isInteger(hostPid) || hostPid <= 0) {
      throw new Error(`Native PTY host returned an invalid PID: ${line}`);
    }
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
    const bashChildren = rows.filter(row => (
      row.ppid === hostPid && /(?:^|[\s/])bash(?:\s|$)/.test(row.command)
    ));
    if (bashChildren.length !== 1) {
      throw new Error(
        `Expected one Main bash child of native PTY host ${hostPid}, found ${bashChildren.length}: `
        + JSON.stringify(rows.filter(row => row.ppid === hostPid)),
      );
    }
    process.stdout.write(`${hostPid} ${bashChildren[0].pid}\n`);
    socket.end();
    return;
  }
});
socket.on('error', error => {
  clearTimeout(timeout);
  throw error;
});
NODE
)"
read -r NATIVE_HOST_PID MAIN_BASH_PID <<< "${RUNTIME_PIDS}"
if ! [[ "${NATIVE_HOST_PID}" =~ ^[0-9]+$ ]] || ! [[ "${MAIN_BASH_PID}" =~ ^[0-9]+$ ]]; then
  echo "npm package smoke could not identify its native PTY process tree: ${RUNTIME_PIDS}" >&2
  exit 1
fi

"${PREFIX}/bin/farming" stop --config-dir "${CONFIG_DIR}" >/dev/null
wait_for_process_exit "${SERVER_PID}" "Farming server"
wait_for_process_exit "${NATIVE_HOST_PID}" "native PTY host"
wait_for_process_exit "${MAIN_BASH_PID}" "Main bash"
echo "✓ npm package installs globally without package mutation, verifies Codex ACP, and stops its server/native PTY process tree"
