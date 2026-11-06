#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_PATH="${FARMING_BASE_PATH:-/farming}"
BUNDLE_NODE_MODULES="${FARMING_BUNDLE_NODE_MODULES:-1}"
RELEASE_PROFILE="${FARMING_RELEASE_PROFILE:-standard}"
PACKAGE_VERSION="$(cd "${PROJECT_ROOT}" && node -p "require('./package.json').version")"
RELEASE_VERSION="${FARMING_RELEASE_VERSION:-${PACKAGE_VERSION}}"
RELEASE_VERSION="${RELEASE_VERSION#v}"
RELEASE_DIR="${FARMING_RELEASE_DIR:-${PROJECT_ROOT}/releases/${RELEASE_VERSION}}"
GIT_SHA="${FARMING_RELEASE_GIT_SHA:-$(cd "${PROJECT_ROOT}" && git rev-parse HEAD 2>/dev/null || true)}"
GIT_STATUS="$(cd "${PROJECT_ROOT}" && git status --porcelain --untracked-files=normal 2>/dev/null || true)"
GIT_DIRTY=false
host_platform() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) echo "Unsupported host platform: $(uname -s)" >&2; exit 1 ;;
  esac
}

host_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "x64" ;;
    *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

TARGET_PLATFORM="${FARMING_RELEASE_PLATFORM:-$(host_platform)}"
TARGET_ARCH="${FARMING_RELEASE_ARCH:-$(host_arch)}"
DEFAULT_RELEASE_NAME="farming-${RELEASE_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}"
if [ -n "${GIT_STATUS}" ]; then
  GIT_DIRTY=true
fi
RELEASE_NAME="${FARMING_RELEASE_NAME:-${DEFAULT_RELEASE_NAME}}"
PRESERVE_STAGE_ROOT=false
if [ -n "${FARMING_RELEASE_STAGE_ROOT:-}" ]; then
  case "${FARMING_RELEASE_STAGE_ROOT}" in
    /*) ;;
    *) echo "FARMING_RELEASE_STAGE_ROOT must be an absolute path." >&2; exit 1 ;;
  esac
  if [ -e "${FARMING_RELEASE_STAGE_ROOT}" ]; then
    echo "FARMING_RELEASE_STAGE_ROOT must not already exist: ${FARMING_RELEASE_STAGE_ROOT}" >&2
    exit 1
  fi
  TMP_ROOT="${FARMING_RELEASE_STAGE_ROOT}"
  mkdir -p "${TMP_ROOT}"
  PRESERVE_STAGE_ROOT=true
else
  TMP_ROOT="$(mktemp -d /tmp/farming-release.XXXXXX)"
fi

log() {
  echo "==> $*" >&2
}

checksum() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" > "${file}.sha256"
  else
    shasum -a 256 "${file}" > "${file}.sha256"
  fi
}

cleanup() {
  if [ "${PRESERVE_STAGE_ROOT}" != "true" ]; then
    rm -rf "${TMP_ROOT}"
  fi
}
trap cleanup EXIT

tar_create_options() {
  local options=()
  if tar --disable-copyfile -cf /dev/null --files-from /dev/null >/dev/null 2>&1; then
    options+=(--disable-copyfile)
  fi
  if tar --no-xattrs -cf /dev/null --files-from /dev/null >/dev/null 2>&1; then
    options+=(--no-xattrs)
  fi
  printf '%s\n' "${options[@]}"
}

glibc_runtime_requested() {
  [ "${RELEASE_PROFILE}" = "linux-x64-legacy-glibc228" ]
}

resolve_glibc_runtime_bundle() {
  # The shared owner validates explicit inputs and recipe-isolated
  # FARMING_GLIBC_RUNTIME_CACHE entries before either packaging path uses them.
  python3 "${PROJECT_ROOT}/scripts/prepare-glibc-runtime.py" "${TMP_ROOT}/glibc228-lib.tar.gz"
}

APP_DIR="${TMP_ROOT}/${RELEASE_NAME}"
TARBALL="${RELEASE_DIR}/${RELEASE_NAME}.tar.gz"

mkdir -p "${APP_DIR}" "${RELEASE_DIR}"

if [ "${RELEASE_VERSION}" != "${PACKAGE_VERSION}" ]; then
  echo "Release version must match package.json: release=${RELEASE_VERSION}, package=${PACKAGE_VERSION}" >&2
  exit 1
fi

if [[ ! "${GIT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release git SHA must be an exact 40-character commit: ${GIT_SHA:-missing}" >&2
  exit 1
fi

if [ "${GIT_DIRTY}" = "true" ]; then
  echo "Refusing to package a dirty working tree. Commit or remove all tracked and untracked changes first." >&2
  exit 1
fi

log "Building frontend for base path ${BASE_PATH} ..."
(cd "${PROJECT_ROOT}" && FARMING_BASE_PATH="${BASE_PATH}" npm run build:package >&2)

runtime_platform_key="${TARGET_PLATFORM}-${TARGET_ARCH}"
if glibc_runtime_requested; then
  runtime_platform_key="${runtime_platform_key}-musl"
fi
log "Preparing packaged runtime for ${runtime_platform_key} ..."
(cd "${PROJECT_ROOT}" && npm run prepare:packaged-runtimes -- --platform "${runtime_platform_key}" >&2)

log "Copying release files ..."
git -C "${PROJECT_ROOT}" archive --format=tar HEAD -- \
  package.json \
  backend \
  bin \
  config/farming.deploy.env.example \
  config/farming.install.env.example \
  docs/products/code \
  extensions \
  frontend \
  scripts/compute-node-heap-mb.sh \
  scripts/install-release.sh \
  scripts/smoke-deployed-server.mjs \
  LICENSE \
  README.md \
  README.zh_cn.md \
  SECURITY.md \
  shared \
  THIRD_PARTY_NOTICES.md \
  index.html | tar -xf - -C "${APP_DIR}"

# Backend runtime JavaScript is generated from .cts sources during `npm run build`
# and is intentionally not tracked. Copy the exact generated counterpart of each
# supported runtime source into the archive after the tracked-source snapshot.
for runtime_root in \
  "${PROJECT_ROOT}/backend" \
  "${PROJECT_ROOT}/extensions/browser/backend" \
  "${PROJECT_ROOT}/extensions/computer/backend" \
  "${PROJECT_ROOT}/extensions/language-server/backend" \
  "${PROJECT_ROOT}/extensions/shared-config/backend" \
  "${PROJECT_ROOT}/extensions/a2a/backend"; do
  while IFS= read -r source_path; do
    runtime_path="${source_path%.cts}.cjs"
    if [ ! -f "${runtime_path}" ]; then
      echo "Generated backend runtime is missing: ${runtime_path}" >&2
      exit 1
    fi
    relative_path="${runtime_path#${PROJECT_ROOT}/}"
    mkdir -p "${APP_DIR}/$(dirname "${relative_path}")"
    cp "${runtime_path}" "${APP_DIR}/${relative_path}"
  done < <(find "${runtime_root}" \
    \( -type d \( -name tests -o -name types -o -name vendor \) -prune \) \
    -o \( -type f -name '*.cts' -print \))
done

cp "${PROJECT_ROOT}/package-lock.json" "${APP_DIR}/package-lock.json"
cp "${PROJECT_ROOT}/backend/usage-history-scanner.generated.js" \
  "${APP_DIR}/backend/usage-history-scanner.generated.js"
rm -rf "${APP_DIR}/backend/tests"

cp -R "${PROJECT_ROOT}/dist" "${APP_DIR}/dist"

if glibc_runtime_requested; then
  if [ "${TARGET_PLATFORM}" != "linux" ] || [ "${TARGET_ARCH}" != "x64" ]; then
    echo "The legacy glibc runtime bundle only supports linux-x64." >&2
    exit 1
  fi
  log "Adding legacy glibc 2.28 runtime ..."
  mkdir -p "${APP_DIR}/vendor"
  cp "$(resolve_glibc_runtime_bundle)" "${APP_DIR}/vendor/glibc228-lib.tar.gz"
fi

if [ "${BUNDLE_NODE_MODULES}" != "0" ]; then
  log "Installing production dependencies into app bundle ..."
  (
    cd "${APP_DIR}"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      PUPPETEER_SKIP_DOWNLOAD=1 \
      npm ci --omit=dev >&2
  )
  "${PROJECT_ROOT}/node_modules/.bin/tsx" "${PROJECT_ROOT}/scripts/assert-no-bundled-agent-clis.ts" "${APP_DIR}" >&2
fi

cat > "${APP_DIR}/farming" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
MANAGED_NPM=0
if grep -Eq '"updateMethod"[[:space:]]*:[[:space:]]*"npm"' "${DIR}/RELEASE.json" 2>/dev/null; then
  MANAGED_NPM=1
  export FARMING_NPM_PREFIX="${FARMING_NPM_PREFIX:-${HOME}/.farming/npm}"
  export FARMING_INSTALL_DIR="${FARMING_NPM_PREFIX}/lib/node_modules/farming-code"
else
  export FARMING_INSTALL_DIR="${FARMING_INSTALL_DIR:-${DIR}}"
fi
export FARMING_INSTALL_CONFIG_FILE="${FARMING_INSTALL_CONFIG_FILE:-${DIR}/config/farming.install.env}"

if [ -f "${DIR}/.farming-install-env" ]; then
  # shellcheck disable=SC1091
  source "${DIR}/.farming-install-env"
fi

if [ "$#" -eq 0 ]; then
  if [ "${MANAGED_NPM}" = "1" ] && [ -d "${FARMING_INSTALL_DIR}/node_modules" ]; then
    set -- daemon
  elif [ -d "${FARMING_INSTALL_DIR}/node_modules" ]; then
    set -- start
  else
    set -- install
  fi
fi

if [ "${MANAGED_NPM}" = "1" ]; then
  if [ "${1:-}" = "install" ] || [ ! -f "${FARMING_INSTALL_DIR}/package.json" ]; then
    exec bash "${DIR}/scripts/install-release.sh" install
  fi
  exec "${FARMING_CLI_INSTALL_DIR:-${HOME}/.farming/bin}/farming" "$@"
fi

case "${1:-}" in
  install|start|serve|daemon|stop|status|logs|help)
    exec bash "${DIR}/scripts/install-release.sh" "$@"
    ;;
  *)
    node_bin="$(type -P node || true)"
    if [ -z "${node_bin}" ]; then
      echo "Node.js 22.13 or newer is required." >&2
      exit 1
    fi
    if ! "${node_bin}" -e \
      'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 13) || major >= 23 ? 0 : 1)'; then
      echo "Node.js 22.13 or newer is required." >&2
      exit 1
    fi
    if [ "${FARMING_USE_GLIBC_RUNTIME:-auto}" != "0" ] && [ "$(uname -s)" = Linux ]; then
      version="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
      loader="${FARMING_GLIBC_RUNTIME_ROOT:-${HOME}/.farming/glibc228}/lib/ld-2.28.so"
      if [ -n "${version}" ] && [ "$(printf '%s\n%s\n' "2.28" "${version}" | sort -V | head -1)" = "${version}" ] && [ "${version}" != "2.28" ] && [ -x "${loader}" ]; then
        exec "${loader}" --library-path "$(dirname "${loader}")" "${node_bin}" "${DIR}/bin/farming" "$@"
      fi
    fi
    exec "${node_bin}" "${DIR}/bin/farming" "$@"
    ;;
esac
EOF
chmod +x "${APP_DIR}/farming"

cat > "${APP_DIR}/RELEASE.json" <<EOF
{
  "name": "farming",
  "type": "app-bundle",
  "updateMethod": "${FARMING_RELEASE_UPDATE_METHOD:-$(if glibc_runtime_requested; then printf 'npm'; else printf 'app-bundle'; fi)}",
  "releaseVersion": "${RELEASE_VERSION}",
  "packageVersion": "${PACKAGE_VERSION}",
  "gitSha": "${GIT_SHA}",
  "dirty": ${GIT_DIRTY},
  "basePath": "${BASE_PATH}",
  "platform": "${TARGET_PLATFORM}",
  "arch": "${TARGET_ARCH}",
  "compatibilityProfile": "${RELEASE_PROFILE}",
  "bundledNodeModules": $(if [ "${BUNDLE_NODE_MODULES}" != "0" ]; then printf 'true'; else printf 'false'; fi),
  "bundledGlibcRuntime": $(if glibc_runtime_requested; then printf 'true'; else printf 'false'; fi),
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

log "Creating ${TARBALL} ..."
rm -f "${TARBALL}" "${TARBALL}.sha256"
TAR_OPTIONS=()
while IFS= read -r option; do
  [ -n "${option}" ] && TAR_OPTIONS+=("${option}")
done < <(tar_create_options)
COPYFILE_DISABLE=1 tar "${TAR_OPTIONS[@]}" -C "${TMP_ROOT}" -czf "${TARBALL}" "${RELEASE_NAME}"
checksum "${TARBALL}"

log "Release package ready."
printf '%s\n' "${TARBALL}"
