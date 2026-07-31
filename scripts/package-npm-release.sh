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

echo "==> Preparing isolated production dependency tree" >&2
rsync -a \
  --exclude '/.git/' \
  --exclude '/node_modules/' \
  --exclude '/releases/' \
  --exclude '/coverage/' \
  --exclude '/playwright-report/' \
  --exclude '/test-results/' \
  "${PROJECT_ROOT}/" "${STAGE_DIR}/"

(
  cd "${STAGE_DIR}"
  npm ci --omit=dev --ignore-scripts --registry="${NPM_REGISTRY}" --no-audit --no-fund >&2
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
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

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

const globalOverrides = new Map([
  ['@hono/node-server', rootManifest.overrides?.['@hono/node-server']],
  ['dompurify', rootManifest.overrides?.dompurify],
  ['qs', rootManifest.overrides?.qs],
]);
for (const [dependencyName, version] of globalOverrides) {
  if (typeof version !== 'string' || !version) {
    throw new Error(`Missing reviewed npm override for ${dependencyName}`);
  }
  let patchedEdges = 0;
  for (const packagePath of Object.keys(lock.packages || {})) {
    if (!packagePath.startsWith('node_modules/')) continue;
    const manifestPath = path.join(stageRoot, packagePath, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let changed = false;
    for (const field of ['dependencies', 'optionalDependencies']) {
      if (!manifest[field]?.[dependencyName]) continue;
      const dependencyManifestPath = resolveDependencyManifest(manifestPath, dependencyName);
      const dependencyManifest = JSON.parse(fs.readFileSync(dependencyManifestPath, 'utf8'));
      if (dependencyManifest.version !== version) {
        throw new Error(
          `Override mismatch for ${manifest.name} -> ${dependencyName}: expected ${version}, got ${dependencyManifest.version}`,
        );
      }
      manifest[field][dependencyName] = version;
      patchedEdges += 1;
      changed = true;
    }
    if (changed) writeJson(manifestPath, manifest);
  }
  if (patchedEdges === 0) {
    throw new Error(`Reviewed npm override ${dependencyName}@${version} no longer owns a production dependency edge`);
  }
}

const expressOverride = rootManifest.overrides?.['express@^4.22.2']?.['body-parser'];
if (typeof expressOverride !== 'string' || !expressOverride) {
  throw new Error('Missing reviewed Express body-parser override');
}
const expressManifestPath = path.join(stageRoot, 'node_modules', 'express', 'package.json');
const expressManifest = JSON.parse(fs.readFileSync(expressManifestPath, 'utf8'));
const bodyParserManifestPath = resolveDependencyManifest(expressManifestPath, 'body-parser');
const bodyParserManifest = JSON.parse(fs.readFileSync(bodyParserManifestPath, 'utf8'));
if (expressManifest.version !== '4.22.2' || bodyParserManifest.version !== expressOverride) {
  throw new Error(
    `Express override mismatch: express=${expressManifest.version}, body-parser=${bodyParserManifest.version}`,
  );
}
expressManifest.dependencies['body-parser'] = expressOverride;
writeJson(expressManifestPath, expressManifest);

if (!/^[0-9a-f]{40}$/.test(gitSha)) {
  throw new Error(`Invalid npm release gitHead: ${gitSha}`);
}
delete rootManifest.overrides;
rootManifest.gitHead = gitSha;
writeJson(rootManifestPath, rootManifest);
fs.rmSync(lockPath, { force: true });
fs.rmSync(hiddenLockPath, { force: true });
NODE

echo "==> Packing bundled npm release" >&2
(
  cd "${STAGE_DIR}"
  npm pack --ignore-scripts --pack-destination "${OUTPUT_DIR}" --silent >/dev/null
)

if [ ! -f "${PACKAGE_TARBALL}" ]; then
  echo "npm pack did not create ${PACKAGE_TARBALL}" >&2
  exit 1
fi

printf '%s\n' "${PACKAGE_TARBALL}"
