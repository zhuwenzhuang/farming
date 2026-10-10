#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_VERSION="$(cd "${PROJECT_ROOT}" && node -p "require('./package.json').version")"
GIT_SHA="$(git -C "${PROJECT_ROOT}" rev-parse HEAD)"
OUTPUT_DIR="${1:-${PROJECT_ROOT}/releases/npm}"
NPM_REGISTRY="${FARMING_NPM_PACK_REGISTRY:-https://registry.npmjs.org/}"
NPM_MAJOR="$(npm --version | cut -d. -f1)"
TMP_ROOT="$(mktemp -d /tmp/farming-npm-pack.XXXXXX)"
STAGE_DIR="${TMP_ROOT}/package"
PACKAGE_TARBALL="${OUTPUT_DIR}/farming-code-${PACKAGE_VERSION}.tgz"

cleanup() {
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

if [ "${NPM_MAJOR}" -lt 12 ]; then
  echo "npm package release packing requires npm 12 or newer, found $(npm --version)" >&2
  exit 1
fi

mkdir -p "${STAGE_DIR}" "${OUTPUT_DIR}"
rm -f "${PACKAGE_TARBALL}"

echo "==> Building npm package runtime" >&2
(cd "${PROJECT_ROOT}" && npm run prepack >&2)
(cd "${PROJECT_ROOT}" && bash scripts/prepare-user-install-runtime.sh >&2)

echo "==> Preparing isolated production dependency tree" >&2
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.farming-runtime-seed/' \
  --exclude '.tmp/' \
  --exclude 'releases/' \
  --exclude 'dist-release/' \
  --exclude 'reference/' \
  --exclude 'coverage/' \
  --exclude 'playwright-report/' \
  --exclude 'test-results/' \
  "${PROJECT_ROOT}/" "${STAGE_DIR}/"

(
  cd "${STAGE_DIR}"
  npm ci --omit=dev --omit=optional --ignore-scripts --registry="${NPM_REGISTRY}" \
    --replace-registry-host=always --no-audit --no-fund >&2
)

node - "${STAGE_DIR}" "${GIT_SHA}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const stageRoot = path.resolve(process.argv[2]);
const gitSha = process.argv[3];
const rootManifestPath = path.join(stageRoot, 'package.json');
const lockPath = path.join(stageRoot, 'package-lock.json');
const hiddenLockPath = path.join(stageRoot, 'node_modules', '.package-lock.json');
const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const resolveDependencyManifest = (parentManifestPath, dependencyName) => {
  let current = path.dirname(parentManifestPath);
  while (current.startsWith(stageRoot)) {
    const candidate = path.join(current, 'node_modules', ...dependencyName.split('/'), 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (current === stageRoot) break;
    current = path.dirname(current);
  }
  throw new Error(`Bundled dependency ${dependencyName} is missing for ${parentManifestPath}`);
};

// These dependencies are compiled into browser assets. Shipping their source
// trees again would duplicate hundreds of megabytes. DOMPurify remains pinned
// during the frontend build, but no longer has a production dependency edge.
for (const name of ['@visactor/vtable', 'mermaid', 'monaco-editor', 'dompurify', 'npm', 'lucide', 'react', 'react-dom', 'katex', 'highlight.js', ...Object.keys(rootManifest.farmingUserRuntimeDependencies || {}).filter(name => name.startsWith('node-'))]) {
  if (fs.existsSync(path.join(stageRoot, 'node_modules', name))) {
    throw new Error(`Unexpected build-only or private runtime dependency in npm image: ${name}`);
  }
}

// Windows PDBs are debugger symbols, not executable PTY dependencies. Prune
// only these known companions in the isolated image, preserving every native
// addon, DLL, executable and license (including the Windows ARM64 prebuild).
for (const platform of ['win32-x64', 'win32-arm64']) {
  for (const name of ['conpty.pdb', 'conpty_console_list.pdb']) {
    fs.rmSync(path.join(stageRoot, 'node_modules/node-pty/prebuilds', platform, name), { force: true });
  }
}
// xterm's browser bundles are served directly and its headless bundles execute
// on the Server. Keep both, but not their duplicate TypeScript debugger maps.
for (const name of Object.keys(rootManifest.dependencies).filter(name => name.startsWith('@xterm/'))) {
  for (const directory of ['lib', 'lib-headless']) {
    const bundleRoot = path.join(stageRoot, 'node_modules', name, directory);
    if (!fs.existsSync(bundleRoot)) continue;
    for (const filename of fs.readdirSync(bundleRoot)) {
      if (/\.m?js\.map$/.test(filename)) fs.unlinkSync(path.join(bundleRoot, filename));
    }
  }
}

// SheetJS is already compiled into the frontend. The backend uses xlsx.js;
// retain its code-page tables and both Node module entry points, not duplicate
// browser bundles, ExtendScript builds or debugger maps.
const sheetDist = path.join(stageRoot, 'node_modules/xlsx/dist');
for (const filename of fs.readdirSync(sheetDist)) {
  if (/^xlsx\.(?:core|full|mini)\.min\.(?:js|map)$/.test(filename)
    || filename === 'xlsx.extendscript.js') fs.unlinkSync(path.join(sheetDist, filename));
}
// The ACP SDK publishes its test suite and declaration/debug output alongside
// runtime modules. Keep every runtime entry point, schema and license.
const sdkDist = path.join(stageRoot, 'node_modules/@agentclientprotocol/sdk/dist');
const pruneSdk = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['examples', 'test-support'].includes(entry.name)) fs.rmSync(target, { recursive: true });
      else pruneSdk(target);
    } else if (/(?:\.test\.js|\.d\.ts|\.map)$/.test(entry.name)) fs.unlinkSync(target);
  }
};
pruneSdk(sdkDist);

// Express 5.2 declares body-parser ^2.2.1 and qs ^6.14.0, and body-parser
// 2.3.0 declares qs ^6.15.2, so the patched production chain resolves
// naturally. Pin the reviewed versions instead of rewriting override edges.
const expressManifestPath = path.join(stageRoot, 'node_modules', 'express', 'package.json');
const expressManifest = JSON.parse(fs.readFileSync(expressManifestPath, 'utf8'));
const bodyParserManifestPath = resolveDependencyManifest(expressManifestPath, 'body-parser');
const bodyParserManifest = JSON.parse(fs.readFileSync(bodyParserManifestPath, 'utf8'));
const qsManifestPath = resolveDependencyManifest(bodyParserManifestPath, 'qs');
const qsManifest = JSON.parse(fs.readFileSync(qsManifestPath, 'utf8'));
if (expressManifest.version !== '5.2.1' || bodyParserManifest.version !== '2.3.0' || qsManifest.version !== '6.16.0') {
  throw new Error(
    `Express production chain mismatch: express=${expressManifest.version}, body-parser=${bodyParserManifest.version}, qs=${qsManifest.version}`,
  );
}

if (!/^[0-9a-f]{40}$/.test(gitSha)) {
  throw new Error(`Invalid npm release gitHead: ${gitSha}`);
}
delete rootManifest.overrides;
rootManifest.gitHead = gitSha;
writeJson(rootManifestPath, rootManifest);
fs.rmSync(lockPath, { force: true });
fs.rmSync(hiddenLockPath, { force: true });
NODE

echo "==> Packing platform runtime dependencies" >&2
node "${PROJECT_ROOT}/scripts/package-npm-runtimes.mjs" "${STAGE_DIR}" "${OUTPUT_DIR}"

echo "==> Packing bundled npm release" >&2
(
  cd "${STAGE_DIR}"
  npm pack --ignore-scripts --pack-destination "${OUTPUT_DIR}" --silent >/dev/null
)

if [ ! -f "${PACKAGE_TARBALL}" ]; then
  echo "npm pack did not create ${PACKAGE_TARBALL}" >&2
  exit 1
fi

# Verify the main image boundary after npm has applied its files/bundle rules.
node - "${PACKAGE_TARBALL}" <<'NODE'
const { execFileSync } = require('node:child_process');
const entries = new Set(execFileSync('tar', ['-tzf', process.argv[2]], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n'));
for (const entry of entries) {
  if (/^package\/dist\/runtime\/(agent-browser|ripgrep|glibc228)\//.test(entry)) {
    throw new Error(`npm main image duplicated a platform runtime: ${entry}`);
  }
}
if (!entries.has('package/dist/frontend-licenses.txt')) throw new Error('npm package omitted frontend dependency notices');
for (const entry of entries) {
  if (/^package\/node_modules\/@xterm\/[^/]+\/lib(?:-headless)?\/[^/]+\.m?js\.map$/.test(entry)) {
    throw new Error(`npm package duplicated terminal debug maps: ${entry}`);
  }
}
if ([...entries].some(entry => entry.startsWith('package/node_modules/node-pty/'))) throw new Error('npm main image duplicated native PTY');
NODE

printf '%s\n' "${PACKAGE_TARBALL}"
