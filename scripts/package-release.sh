#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_PATH="${FARMING_BASE_PATH:-/farming}"
BUNDLE_NODE_MODULES="${FARMING_BUNDLE_NODE_MODULES:-1}"
RELEASE_PROFILE="${FARMING_RELEASE_PROFILE:-standard}"
GLIBC_RUNTIME_BUNDLE="${FARMING_GLIBC_RUNTIME_BUNDLE:-}"
GLIBC_RUNTIME_SOURCE_REPO="${FARMING_GLIBC_RUNTIME_SOURCE_REPO:-https://github.com/liuliping0315/glibc2.28_for_CentOS7.git}"
GLIBC_RUNTIME_SOURCE_REF="${FARMING_GLIBC_RUNTIME_SOURCE_REF:-ba989d6b879b75bc3a823b53e684cdd3ab1bdbcd}"
GLIBC_RUNTIME_SOURCE_SHA256="${FARMING_GLIBC_RUNTIME_SOURCE_SHA256:-eaf615e3d72b096bc603476a481730e39b5e01e47dc874ae05e535be1bc7fb89}"
PACKAGE_VERSION="$(cd "${PROJECT_ROOT}" && node -p "require('./package.json').version")"
RELEASE_VERSION="${FARMING_RELEASE_VERSION:-${PACKAGE_VERSION}}"
RELEASE_VERSION="${RELEASE_VERSION#v}"
RELEASE_DIR="${FARMING_RELEASE_DIR:-${PROJECT_ROOT}/releases/${RELEASE_VERSION}}"
GIT_SHA="$(cd "${PROJECT_ROOT}" && git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
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
TMP_ROOT="$(mktemp -d /tmp/farming-release.XXXXXX)"

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

checksum_value() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  else
    shasum -a 256 "${file}" | awk '{print $1}'
  fi
}

cleanup() {
  rm -rf "${TMP_ROOT}"
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

glibc_tarball_contains_loader() {
  local tarball="$1"
  tar -tf "${tarball}" 2>/dev/null | awk '/(^|\/)ld-2\.28\.so$/ { found=1 } END { exit found ? 0 : 1 }'
}

resolve_glibc_runtime_bundle() {
  local output="${TMP_ROOT}/glibc228-lib.tar.gz"
  if [ -n "${GLIBC_RUNTIME_BUNDLE}" ]; then
    if [ ! -f "${GLIBC_RUNTIME_BUNDLE}" ] || ! glibc_tarball_contains_loader "${GLIBC_RUNTIME_BUNDLE}"; then
      echo "FARMING_GLIBC_RUNTIME_BUNDLE must contain ld-2.28.so: ${GLIBC_RUNTIME_BUNDLE}" >&2
      exit 1
    fi
    printf '%s\n' "${GLIBC_RUNTIME_BUNDLE}"
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to fetch the pinned legacy glibc runtime." >&2
    exit 1
  fi

  local repo_dir="${TMP_ROOT}/glibc-source"
  log "Fetching pinned glibc 2.28 runtime ${GLIBC_RUNTIME_SOURCE_REF} ..."
  git -C "${TMP_ROOT}" init -q "${repo_dir}"
  git -C "${repo_dir}" remote add origin "${GLIBC_RUNTIME_SOURCE_REPO}"
  git -C "${repo_dir}" fetch --depth 1 origin "${GLIBC_RUNTIME_SOURCE_REF}" >&2
  git -C "${repo_dir}" checkout --detach FETCH_HEAD >&2
  if [ ! -f "${repo_dir}/lib.tgz" ] || ! glibc_tarball_contains_loader "${repo_dir}/lib.tgz"; then
    echo "Pinned glibc runtime is missing a valid lib.tgz: ${GLIBC_RUNTIME_SOURCE_REPO}" >&2
    exit 1
  fi
  local actual_sha256
  actual_sha256="$(checksum_value "${repo_dir}/lib.tgz")"
  if [ "${actual_sha256}" != "${GLIBC_RUNTIME_SOURCE_SHA256}" ]; then
    echo "Pinned glibc runtime checksum mismatch: expected ${GLIBC_RUNTIME_SOURCE_SHA256}, got ${actual_sha256}" >&2
    exit 1
  fi
  cp "${repo_dir}/lib.tgz" "${output}"
  printf '%s\n' "${output}"
}

APP_DIR="${TMP_ROOT}/${RELEASE_NAME}"
TARBALL="${RELEASE_DIR}/${RELEASE_NAME}.tar.gz"

mkdir -p "${APP_DIR}" "${RELEASE_DIR}"

if [ "${RELEASE_VERSION}" != "${PACKAGE_VERSION}" ]; then
  echo "Release version must match package.json: release=${RELEASE_VERSION}, package=${PACKAGE_VERSION}" >&2
  exit 1
fi

if [ "${GIT_DIRTY}" = "true" ]; then
  echo "Refusing to package a dirty working tree. Commit or remove all tracked and untracked changes first." >&2
  exit 1
fi

log "Building frontend for base path ${BASE_PATH} ..."
(cd "${PROJECT_ROOT}" && FARMING_BASE_PATH="${BASE_PATH}" npm run build >&2)

log "Copying release files ..."
git -C "${PROJECT_ROOT}" archive --format=tar HEAD -- \
  package.json \
  backend \
  bin \
  config/farming.deploy.env.example \
  config/farming.install.env.example \
  docs/products/code \
  frontend \
  scripts/compute-node-heap-mb.sh \
  scripts/install-release.sh \
  scripts/sync-ghostty-vendor.js \
  LICENSE \
  README.md \
  README.zh_cn.md \
  SECURITY.md \
  THIRD_PARTY_NOTICES.md \
  index.html | tar -xf - -C "${APP_DIR}"
cp "${PROJECT_ROOT}/package-lock.json" "${APP_DIR}/package-lock.json"
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
fi

cat > "${APP_DIR}/farming" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
export FARMING_INSTALL_DIR="${FARMING_INSTALL_DIR:-${DIR}}"
export FARMING_INSTALL_CONFIG_FILE="${FARMING_INSTALL_CONFIG_FILE:-${DIR}/config/farming.install.env}"

if [ -f "${DIR}/.farming-install-env" ]; then
  # shellcheck disable=SC1091
  source "${DIR}/.farming-install-env"
fi

if [ "$#" -eq 0 ]; then
  if [ -d "${DIR}/node_modules" ]; then
    set -- start
  else
    set -- install
  fi
fi

case "${1:-}" in
  install|start|serve|daemon|stop|status|logs|help)
    exec bash "${DIR}/scripts/install-release.sh" "$@"
    ;;
  *)
    if [ "${FARMING_USE_GLIBC_RUNTIME:-auto}" != "0" ] && [ "$(uname -s)" = Linux ]; then
      version="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
      loader="${FARMING_GLIBC_RUNTIME_ROOT:-${HOME}/.farming/glibc228}/lib/ld-2.28.so"
      if [ -n "${version}" ] && [ "$(printf '%s\n%s\n' "2.28" "${version}" | sort -V | head -1)" = "${version}" ] && [ "${version}" != "2.28" ] && [ -x "${loader}" ]; then
        exec "${loader}" --library-path "$(dirname "${loader}")" node "${DIR}/bin/farming" "$@"
      fi
    fi
    exec node "${DIR}/bin/farming" "$@"
    ;;
esac
EOF
chmod +x "${APP_DIR}/farming"

cat > "${APP_DIR}/RELEASE.json" <<EOF
{
  "name": "farming",
  "type": "app-bundle",
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
