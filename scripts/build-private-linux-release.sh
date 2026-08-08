#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER_IMAGE="${FARMING_DEPLOY_BUILDER_IMAGE:-node:22.17.0-bookworm}"
DOCKER_CONTEXT="${FARMING_DEPLOY_DOCKER_CONTEXT:-}"
NPM_REGISTRY="${FARMING_DEPLOY_NPM_REGISTRY:-https://registry.npmjs.org/}"
OUTPUT_DIR=""

usage() {
  cat <<'EOF'
Usage: scripts/build-private-linux-release.sh [options]

Build one committed Farming SHA as a private Linux x64 app bundle. The build
runs in an isolated Linux container and never uses the target Server as a
builder.

Options:
  --output-dir PATH       Artifact output directory (default: .tmp/private-releases/<sha>)
  --builder-image IMAGE   Linux amd64 container image (default: node:22.17.0-bookworm)
  --docker-context NAME   Explicit Docker context used by the Linux builder
  --npm-registry URL      npm registry used inside the builder
  --help                  Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --builder-image)
      BUILDER_IMAGE="${2:-}"
      shift 2
      ;;
    --docker-context)
      DOCKER_CONTEXT="${2:-}"
      shift 2
      ;;
    --npm-registry)
      NPM_REGISTRY="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown private release build option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v git >/dev/null || { echo "git is required." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required to build the Linux release artifact." >&2; exit 1; }
if [ -n "${DOCKER_CONTEXT}" ] && { [[ "${DOCKER_CONTEXT}" == -* ]] || [[ "${DOCKER_CONTEXT}" == *[[:space:]]* ]]; }; then
  echo "--docker-context must be one Docker context name without whitespace." >&2
  exit 2
fi
case "${NPM_REGISTRY}" in
  http://*|https://*) ;;
  *) echo "--npm-registry must be an HTTP or HTTPS URL." >&2; exit 2 ;;
esac
if [[ "${NPM_REGISTRY}" == *[[:space:]]* ]]; then
  echo "--npm-registry cannot contain whitespace." >&2
  exit 2
fi

DOCKER_ARGS=()
if [ -n "${DOCKER_CONTEXT}" ]; then DOCKER_ARGS+=(--context "${DOCKER_CONTEXT}"); fi
docker "${DOCKER_ARGS[@]}" info >/dev/null 2>&1 || {
  echo "Docker is installed but its Linux engine is not running." >&2
  exit 1
}

GIT_SHA="$(git -C "${PROJECT_ROOT}" rev-parse HEAD)"
PACKAGE_VERSION="$(git -C "${PROJECT_ROOT}" show "${GIT_SHA}:package.json" | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(String(JSON.parse(s).version)))')"
SHORT_SHA="${GIT_SHA:0:12}"
RELEASE_NAME="farming-${PACKAGE_VERSION}-${SHORT_SHA}-linux-x64-private-glibc228"
OUTPUT_DIR="${OUTPUT_DIR:-${PROJECT_ROOT}/.tmp/private-releases/${GIT_SHA}}"
case "${OUTPUT_DIR}" in
  /*) ;;
  *) OUTPUT_DIR="${PROJECT_ROOT}/${OUTPUT_DIR}" ;;
esac
RUNTIME_CACHE_DIR="${PROJECT_ROOT}/.tmp/deploy-runtime-cache"
mkdir -p "${OUTPUT_DIR}" "${PROJECT_ROOT}/.tmp/deploy-npm-cache" "${RUNTIME_CACHE_DIR}"

WORKTREE_ROOT="$(mktemp -d "${PROJECT_ROOT}/.tmp/private-release-worktree.XXXXXX")"
WORKTREE_DIR="${WORKTREE_ROOT}/source"
cleanup() {
  git -C "${PROJECT_ROOT}" worktree remove --force "${WORKTREE_DIR}" >/dev/null 2>&1 || true
  rm -rf "${WORKTREE_ROOT}"
}
trap cleanup EXIT

echo "==> Preparing isolated source tree for ${GIT_SHA}" >&2
git -C "${PROJECT_ROOT}" worktree add --detach "${WORKTREE_DIR}" "${GIT_SHA}" >/dev/null
GIT_COMMON_DIR="$(git -C "${WORKTREE_DIR}" rev-parse --path-format=absolute --git-common-dir)"

echo "==> Building private Linux release in ${BUILDER_IMAGE}" >&2
docker "${DOCKER_ARGS[@]}" run --rm --platform linux/amd64 \
  --mount "type=bind,source=${WORKTREE_DIR},target=${WORKTREE_DIR}" \
  --mount "type=bind,source=${GIT_COMMON_DIR},target=${GIT_COMMON_DIR},readonly" \
  --mount "type=bind,source=${OUTPUT_DIR},target=/output" \
  --mount "type=bind,source=${PROJECT_ROOT}/.tmp/deploy-npm-cache,target=/root/.npm" \
  --mount "type=bind,source=${RUNTIME_CACHE_DIR},target=/farming-runtime-cache" \
  --workdir "${WORKTREE_DIR}" \
  --env GIT_CONFIG_COUNT=1 \
  --env GIT_CONFIG_KEY_0=safe.directory \
  --env GIT_CONFIG_VALUE_0="${WORKTREE_DIR}" \
  --env FARMING_RELEASE_GIT_SHA="${GIT_SHA}" \
  --env FARMING_RELEASE_DIR=/output \
  --env FARMING_RELEASE_NAME="${RELEASE_NAME}" \
  --env FARMING_RELEASE_UPDATE_METHOD=app-bundle \
  --env FARMING_GLIBC_RUNTIME_CACHE=/farming-runtime-cache/glibc228-lib.tar.gz \
  --env FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1 \
  --env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  --env PUPPETEER_SKIP_DOWNLOAD=1 \
  --env npm_config_registry="${NPM_REGISTRY}" \
  "${BUILDER_IMAGE}" \
  bash -lc 'npm ci --no-audit --no-fund && npm run release:app:legacy-linux' >&2

TARBALL="${OUTPUT_DIR}/${RELEASE_NAME}.tar.gz"
test -f "${TARBALL}"
test -f "${TARBALL}.sha256"

node --import tsx "${PROJECT_ROOT}/scripts/verify-release-bundle.ts" "${TARBALL}" >&2
node --import tsx - "${TARBALL}" "${GIT_SHA}" <<'NODE'
import { readBundleRelease } from './scripts/verify-release-bundle.ts';
const [archivePath, expectedSha] = process.argv.slice(2);
const { release } = readBundleRelease(archivePath);
if (release.platform !== 'linux' || release.arch !== 'x64') {
  throw new Error('Private deployment artifact must target linux-x64');
}
if (release.compatibilityProfile !== 'linux-x64-legacy-glibc228' || release.bundledGlibcRuntime !== true) {
  throw new Error('Private deployment artifact must include the legacy glibc runtime');
}
if (release.updateMethod !== 'app-bundle') {
  throw new Error('Private deployment artifact must remain an app-bundle installation');
}
if (release.gitSha !== expectedSha) {
  throw new Error(`Private deployment artifact SHA mismatch: ${release.gitSha || 'missing'}`);
}
NODE

printf '%s\n' "${TARBALL}"
