#!/usr/bin/env bash
set -euo pipefail

# Run inside an already prepared Linux builder. Tool installation and the live
# Server are outside this command's ownership; caches survive each source checkout.
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${1:-}"
if [ "$#" -gt 1 ] || [ -z "${OUTPUT_DIR}" ] || [[ "${OUTPUT_DIR}" != /* ]]; then
  echo "Usage: FARMING_BUILD_CACHE_ROOT=/absolute/cache scripts/build-private-linux-native.sh /absolute/output" >&2
  exit 2
fi
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "Private native builds require the prepared Linux x64 environment." >&2; exit 2
fi
if [ -z "${FARMING_BUILD_CACHE_ROOT:-}" ] || [[ "${FARMING_BUILD_CACHE_ROOT}" != /* ]]; then
  echo "FARMING_BUILD_CACHE_ROOT must select the persistent builder cache." >&2; exit 2
fi
cd "${PROJECT_ROOT}"
GIT_SHA="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "Private builds require a clean committed source checkout." >&2; exit 1
fi
if [ "$(npm --version)" != 12.0.2 ]; then
  echo "Prepared builder requires npm 12.0.2; prepare its fixed toolchain before building." >&2; exit 1
fi
VERSION="$(node -p 'require("./package.json").version')"
mkdir -p "${OUTPUT_DIR}" "${FARMING_BUILD_CACHE_ROOT}"
export FARMING_RELEASE_GIT_SHA="${GIT_SHA}"
export FARMING_RELEASE_UPDATE_METHOD=app-bundle
export FARMING_RELEASE_DIR="${OUTPUT_DIR}"
export FARMING_RELEASE_NAME="farming-${VERSION}-${GIT_SHA:0:12}-linux-x64-private-glibc228"
ARCHIVE="${OUTPUT_DIR}/${FARMING_RELEASE_NAME}.tar.gz"
export npm_config_cache="${FARMING_BUILD_CACHE_ROOT}/npm"
export pnpm_config_store_dir="${FARMING_BUILD_CACHE_ROOT}/pnpm-store"
export pnpm_config_cache_dir="${FARMING_BUILD_CACHE_ROOT}/pnpm-metadata"
export FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1
verify_archive() {
  node --import tsx scripts/verify-release-bundle.ts "${ARCHIVE}" >&2
  node --import tsx - "${ARCHIVE}" "${GIT_SHA}" <<'NODE'
import assert from 'node:assert/strict';
import { readBundleRelease } from './scripts/verify-release-bundle.ts';
const { release } = readBundleRelease(process.argv[2]);
assert.equal(release.gitSha, process.argv[3]);
assert.equal(release.platform, 'linux');
assert.equal(release.arch, 'x64');
assert.equal(release.updateMethod, 'app-bundle');
assert.equal(release.compatibilityProfile, 'linux-x64-legacy-glibc228');
assert.equal(release.bundledGlibcRuntime, true);
NODE
  (cd "${OUTPUT_DIR}" && sha256sum -c "${FARMING_RELEASE_NAME}.tar.gz.sha256") >&2
}
if [ -e "${ARCHIVE}" ]; then
  if [ ! -x node_modules/.bin/tsx ]; then timeout 300 npm ci --prefer-offline --no-audit --no-fund >&2; fi
  verify_archive
  printf '%s\n' "${ARCHIVE}"
  exit 0
fi
export XDG_DATA_HOME="${FARMING_BUILD_CACHE_ROOT}/xdg-data"
export CARGO_TARGET_DIR="${FARMING_BUILD_CACHE_ROOT}/cargo-target"
export FARMING_AGENT_BROWSER_BUILD_CACHE="${FARMING_BUILD_CACHE_ROOT}/browser-builds"
export FARMING_GLIBC_RUNTIME_CACHE="${FARMING_BUILD_CACHE_ROOT}/glibc228-lib.tar.gz"
export FARMING_RIPGREP_ARCHIVE_CACHE="${FARMING_BUILD_CACHE_ROOT}/ripgrep"
timeout 300 npm ci --prefer-offline --no-audit --no-fund >&2
BROWSER_OUTPUT="$(mktemp -d "${OUTPUT_DIR}/.browser-XXXXXX")"
trap 'rm -rf "${BROWSER_OUTPUT}"' EXIT
export FARMING_AGENT_BROWSER_ARTIFACTS="${BROWSER_OUTPUT}"
node scripts/build-agent-browser-runtime.mjs --platform linux-x64-musl --output "${BROWSER_OUTPUT}" >&2
npm run release:app:legacy-linux >&2
verify_archive
printf '%s\n' "${ARCHIVE}"
