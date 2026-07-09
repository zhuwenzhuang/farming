#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/farming-npm-smoke.XXXXXX)"
PREFIX="${TMP_ROOT}/prefix"
CONFIG_DIR="${TMP_ROOT}/config"
PORT_VALUE="${FARMING_NPM_SMOKE_PORT:-6794}"

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

npm install --global --prefix "${PREFIX}" "${PACKAGE_TARBALL}" --no-audit --no-fund --silent
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
echo "✓ npm package installs globally, starts Farming, and loads node-pty"
