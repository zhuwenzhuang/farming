#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_VERSION="$(cd "${PROJECT_ROOT}" && node -p "require('./package.json').version")"
RELEASE_VERSION="${FARMING_RELEASE_VERSION:-$(cd "${PROJECT_ROOT}" && node - <<'NODE'
const version = require('./package.json').version;
const majorRelease = version.match(/^([1-9]\d*)\.0\.0$/);
process.stdout.write(majorRelease ? majorRelease[1] : version);
NODE
)}"
BASE_PATH="${FARMING_BASE_PATH:-/farming}"
RELEASE_DIR="${FARMING_RELEASE_DIR:-${PROJECT_ROOT}/releases/${RELEASE_VERSION}}"
CHECKSUM_FILE="${RELEASE_DIR}/farming_${RELEASE_VERSION}_checksums.txt"
MANIFEST_FILE="${RELEASE_DIR}/manifest.json"
ASSET_MANIFEST_TMP="$(mktemp /tmp/farming-cli-assets.XXXXXX)"
PKG_LOGS=()
BUNDLE_ENTRY="${PROJECT_ROOT}/backend/farming-app-cli.pkg.js"
BUNDLE_WORKER="${PROJECT_ROOT}/backend/terminal-screen-worker-thread.pkg.js"
BUNDLE_USAGE_WORKER="${PROJECT_ROOT}/backend/usage-history-worker.pkg.js"
GIT_SHA="$(cd "${PROJECT_ROOT}" && git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
GIT_STATUS="$(cd "${PROJECT_ROOT}" && git status --porcelain --untracked-files=normal 2>/dev/null || true)"
GIT_DIRTY=false
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "${GIT_STATUS}" ]; then
  GIT_DIRTY=true
fi

log() {
  echo "==> $*" >&2
}

host_pkg_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "Unsupported host platform: $(uname -s)" >&2; exit 1 ;;
  esac
}

host_pkg_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "x64" ;;
    *) echo "Unsupported host arch: $(uname -m)" >&2; exit 1 ;;
  esac
}

default_node_major() {
  if [ -n "${FARMING_PKG_NODE_MAJOR:-}" ]; then
    echo "${FARMING_PKG_NODE_MAJOR}"
    return
  fi

  case "$(host_pkg_platform)" in
    linux|macos) echo "22" ;;
    *) echo "22" ;;
  esac
}

artifact_name_for_target() {
  local target="$1"
  local name
  name="$(printf '%s' "${target}" | sed -E 's/^node[0-9]+-//')"
  name="${name/macos/darwin}"
  name="${name//-/_}"
  name="${name/_x64/_amd64}"
  echo "${name}"
}

asset_extension_for_target() {
  case "$1" in
    *-win-*) echo ".exe" ;;
    *) echo "" ;;
  esac
}

sha256_value() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  else
    shasum -a 256 "${file}" | awk '{print $1}'
  fi
}

check_release_binary() {
  local file="$1"
  if ! command -v strings >/dev/null 2>&1; then
    log "strings not found; skipping binary source leak scan."
    return
  fi

  local patterns='backend/tests|src/components/|conversation-log\.md|AGENTS\.md - AI Agent|Farming 2 CLI tests|smoke-cli-release|项目简介|backend/farming-app-cli\.js|backend/server\.js|backend/config-manager\.js'
  if strings "${file}" | grep -E "${patterns}" >/tmp/farming-cli-release-leaks.$$ 2>/dev/null; then
    echo "Release binary contains source/debug marker(s):" >&2
    head -40 /tmp/farming-cli-release-leaks.$$ >&2 || true
    rm -f /tmp/farming-cli-release-leaks.$$
    exit 1
  fi
  rm -f /tmp/farming-cli-release-leaks.$$
}

MODERN_PKG_BIN="${PROJECT_ROOT}/node_modules/@yao-pkg/pkg/lib-es5/bin.js"
BUNDLE_CLI_RUNTIME="${PROJECT_ROOT}/scripts/bundle-cli-runtime.js"

cleanup() {
  rm -f "${BUNDLE_ENTRY}" "${BUNDLE_WORKER}" "${BUNDLE_USAGE_WORKER}" "${ASSET_MANIFEST_TMP}"
  if [ "${#PKG_LOGS[@]}" -gt 0 ]; then
    rm -f "${PKG_LOGS[@]}"
  fi
}
trap cleanup EXIT

if [ ! -f "${MODERN_PKG_BIN}" ]; then
  echo "Missing @yao-pkg/pkg. Run npm install first." >&2
  exit 1
fi

if [ ! -f "${BUNDLE_CLI_RUNTIME}" ]; then
  echo "Missing CLI runtime bundler script." >&2
  exit 1
fi

NODE_MAJOR="$(default_node_major)"
DEFAULT_TARGET="node${NODE_MAJOR}-$(host_pkg_platform)-$(host_pkg_arch)"
TARGETS="${FARMING_CLI_TARGETS:-${DEFAULT_TARGET}}"

if [ "${GIT_DIRTY}" = "true" ]; then
  log "Working tree has uncommitted or untracked changes; packaging the current checkout."
fi

log "Building frontend for base path ${BASE_PATH} ..."
(cd "${PROJECT_ROOT}" && FARMING_BASE_PATH="${BASE_PATH}" npm run build >&2)

log "Bundling backend runtime with esbuild ..."
(
  cd "${PROJECT_ROOT}"
  FARMING_CLI_BUNDLE_ENTRY="${BUNDLE_ENTRY}" \
  FARMING_CLI_BUNDLE_WORKER="${BUNDLE_WORKER}" \
  FARMING_CLI_BUNDLE_USAGE_WORKER="${BUNDLE_USAGE_WORKER}" \
    node "${BUNDLE_CLI_RUNTIME}" >&2
)

mkdir -p "${RELEASE_DIR}"
rm -f "${CHECKSUM_FILE}" "${MANIFEST_FILE}"
cp "${PROJECT_ROOT}/LICENSE" "${RELEASE_DIR}/LICENSE"
cp "${PROJECT_ROOT}/THIRD_PARTY_NOTICES.md" "${RELEASE_DIR}/THIRD_PARTY_NOTICES.md"

IFS=',' read -ra TARGET_ARRAY <<< "${TARGETS}"
for target in "${TARGET_ARRAY[@]}"; do
  target="$(echo "${target}" | xargs)"
  [ -n "${target}" ] || continue
  artifact="$(artifact_name_for_target "${target}")"
  extension="$(asset_extension_for_target "${target}")"
  asset_file="farming_${RELEASE_VERSION}_${artifact}${extension}"
  out_bin="${RELEASE_DIR}/${asset_file}"
  pkg_log="$(mktemp /tmp/farming-cli-pkg.XXXXXX)"
  PKG_LOGS+=("${pkg_log}")

  log "Packaging ${target} -> ${out_bin} ..."
  rm -f "${out_bin}"

  (
    cd "${PROJECT_ROOT}"
    FARMING_PKG_ENTRY="backend/farming-app-cli.pkg.js" \
    FARMING_PKG_WORKER_ENTRY="backend/terminal-screen-worker-thread.pkg.js" \
    FARMING_PKG_USAGE_WORKER_ENTRY="backend/usage-history-worker.pkg.js" \
      node "${MODERN_PKG_BIN}" \
      -c pkg.config.cjs \
      -t "${target}" \
      --no-native-build \
      --fallback-to-source \
      --compress GZip \
      -o "${out_bin}" \
      backend/farming-app-cli.pkg.js 2>&1 | tee "${pkg_log}" >&2
  )

  if grep -Eq 'Failed to generate V8 bytecode.*Use --fallback-to-source|UNEXPECTED-20: no source or bytecode' "${pkg_log}"; then
    echo "pkg did not embed executable JavaScript for ${target}; refusing to publish a broken CLI." >&2
    exit 1
  fi

  chmod +x "${out_bin}"
  check_release_binary "${out_bin}"
  if [ "${target}" = "${DEFAULT_TARGET}" ]; then
    if ! "${out_bin}" --help >/dev/null 2>&1; then
      echo "Packaged CLI failed its native startup self-check: ${out_bin}" >&2
      exit 1
    fi
    codex_bin="$(command -v codex || true)"
    if [ -z "${codex_bin}" ]; then
      echo "Packaged CLI ACP smoke requires the pinned Codex executable from node_modules." >&2
      exit 1
    fi
    CODEX_PATH="${codex_bin}" node "${PROJECT_ROOT}/scripts/smoke-codex-acp-process.js" \
      --command "${out_bin}" \
      --arg --farming-codex-acp
    if ! "${out_bin}" --farming-usage-history-smoke >/dev/null; then
      echo "Packaged CLI failed its Usage History worker + SQLite smoke: ${out_bin}" >&2
      exit 1
    fi
  fi
  sha256="$(sha256_value "${out_bin}")"
  printf '%s  %s\n' "${sha256}" "${asset_file}" >> "${CHECKSUM_FILE}"
  printf '%s\t%s\t%s\t%s\n' "${target}" "${artifact}" "${asset_file}" "${sha256}" >> "${ASSET_MANIFEST_TMP}"
  log "CLI application ready: ${out_bin}"
  printf '%s\n' "${out_bin}"
done

FARMING_RELEASE_MANIFEST_FILE="${MANIFEST_FILE}" \
FARMING_ASSET_MANIFEST_TMP="${ASSET_MANIFEST_TMP}" \
FARMING_RELEASE_VERSION_VALUE="${RELEASE_VERSION}" \
FARMING_PACKAGE_VERSION_VALUE="${PACKAGE_VERSION}" \
FARMING_RELEASE_GIT_SHA="${GIT_SHA}" \
FARMING_RELEASE_GIT_DIRTY="${GIT_DIRTY}" \
FARMING_RELEASE_BASE_PATH="${BASE_PATH}" \
FARMING_RELEASE_BUILT_AT="${BUILT_AT}" \
node <<'NODE'
const fs = require('fs');

const assets = fs.readFileSync(process.env.FARMING_ASSET_MANIFEST_TMP, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [target, artifact, file, sha256] = line.split('\t');
    const [platform, arch] = artifact.split('_');
    return { target, platform, arch, artifact, file, sha256 };
  });

const manifest = {
  name: 'farming',
  releaseVersion: process.env.FARMING_RELEASE_VERSION_VALUE,
  packageVersion: process.env.FARMING_PACKAGE_VERSION_VALUE,
  entry: 'farming',
  gitSha: process.env.FARMING_RELEASE_GIT_SHA,
  dirty: process.env.FARMING_RELEASE_GIT_DIRTY === 'true',
  basePath: process.env.FARMING_RELEASE_BASE_PATH,
  sourceIncluded: false,
  builtAt: process.env.FARMING_RELEASE_BUILT_AT,
  assets,
};

fs.writeFileSync(process.env.FARMING_RELEASE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

log "Release manifest ready: ${MANIFEST_FILE}"
