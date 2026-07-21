#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/farming-npm-smoke.XXXXXX)"
PREFIX="${TMP_ROOT}/prefix"
CONFIG_DIR="${TMP_ROOT}/config"
PORT_VALUE="${FARMING_NPM_SMOKE_PORT:-6794}"
NPM_MAJOR="$(npm --version | cut -d. -f1)"

if [ "${NPM_MAJOR}" -lt 12 ]; then
  echo "npm package release smoke requires npm 12 or newer, found $(npm --version)" >&2
  exit 1
fi

cleanup() {
  if [ -x "${PREFIX}/bin/farming" ]; then
    "${PREFIX}/bin/farming" stop --config-dir "${CONFIG_DIR}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

mkdir -p "${PREFIX}" "${CONFIG_DIR}"
cd "${PROJECT_ROOT}"
npm pack --pack-destination "${TMP_ROOT}" --silent >/dev/null
PACKAGE_TARBALL="$(find "${TMP_ROOT}" -maxdepth 1 -name 'farming-code-*.tgz' -print -quit)"
if [ -z "${PACKAGE_TARBALL}" ]; then
  echo "npm pack did not create a farming-code tarball" >&2
  exit 1
fi

npm install --global --prefix "${PREFIX}" "${PACKAGE_TARBALL}" --ignore-scripts --no-audit --no-fund --silent
PACKAGE_ROOT="${PREFIX}/lib/node_modules/farming-code"
CODEX_ACP_UPSTREAM="${PACKAGE_ROOT}/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
CODEX_ACP_VENDOR="${PACKAGE_ROOT}/dist/acp/codex-acp-1.1.4.js"
if [ ! -f "${CODEX_ACP_VENDOR}" ]; then
  echo "npm package omitted the version-locked Codex ACP runtime" >&2
  exit 1
fi
node - "${PACKAGE_ROOT}" "${CODEX_ACP_UPSTREAM}" "${CODEX_ACP_VENDOR}" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [packageRoot, upstreamEntry, vendorEntry] = process.argv.slice(2);
const sha256 = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const expectedUpstream = '7534a0ad3cc4c9affd0b2da5007fa53ea0f1d6fcd71b2c5ef202e2056a976a97';
const expectedVendor = '39cbae01e336c2ca185d624358e03280d1f6fef6d73bbe42dd9eb77e2b1efb32';
if (sha256(upstreamEntry) !== expectedUpstream) {
  throw new Error('Packed install unexpectedly mutated the upstream codex-acp dependency');
}
if (sha256(vendorEntry) !== expectedVendor) {
  throw new Error('Packed Codex ACP runtime failed its SHA-256 verification');
}
const { resolveAcpLaunch } = require(path.join(packageRoot, 'backend/acp-runtime'));
const launch = resolveAcpLaunch('codex');
if (fs.realpathSync(launch.args.at(-1)) !== fs.realpathSync(vendorEntry)) {
  throw new Error(`Codex ACP launch did not select the packaged runtime: ${launch.args.at(-1)}`);
}
NODE
node "${PROJECT_ROOT}/scripts/smoke-codex-acp-process.js" --package-root "${PACKAGE_ROOT}"
"${PREFIX}/bin/farming" help >/dev/null
FARMING_DISABLE_AUTH=1 "${PREFIX}/bin/farming" daemon \
  --port "${PORT_VALUE}" \
  --base-path /farming \
  --config-dir "${CONFIG_DIR}" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${PORT_VALUE}/farming/api/auth/status" | grep -q '"authRequired":false'

node -e '
  const path = require("path");
  const prefix = process.argv[1];
  const pty = require(path.join(prefix, "lib/node_modules/farming-code/node_modules/node-pty"));
  if (typeof pty.spawn !== "function") throw new Error("node-pty did not load from the npm package");
' "${PREFIX}"

"${PREFIX}/bin/farming" stop --config-dir "${CONFIG_DIR}" >/dev/null
echo "✓ npm package installs globally without package mutation, verifies Codex ACP, starts Farming, and loads node-pty"
