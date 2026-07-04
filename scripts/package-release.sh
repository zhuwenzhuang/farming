#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_PATH="${FARMING_BASE_PATH:-/farming}"
GLIBC_BUNDLE="${FARMING_GLIBC_BUNDLE:-}"
GLIBC_SOURCE_REPO="${FARMING_GLIBC_SOURCE_REPO:-https://github.com/liuliping0315/glibc2.28_for_CentOS7.git}"
BUNDLE_NODE_MODULES="${FARMING_BUNDLE_NODE_MODULES:-1}"
PACKAGE_VERSION="$(cd "${PROJECT_ROOT}" && node -p "require('./package.json').version")"
RELEASE_VERSION="${FARMING_RELEASE_VERSION:-$(cd "${PROJECT_ROOT}" && node - <<'NODE'
const version = require('./package.json').version;
const majorRelease = version.match(/^([1-9]\d*)\.0\.0$/);
process.stdout.write(majorRelease ? majorRelease[1] : version);
NODE
)}"
RELEASE_DIR="${FARMING_RELEASE_DIR:-${PROJECT_ROOT}/releases/${RELEASE_VERSION}}"
GIT_SHA="$(cd "${PROJECT_ROOT}" && git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
GIT_STATUS="$(cd "${PROJECT_ROOT}" && git status --porcelain --untracked-files=normal 2>/dev/null || true)"
GIT_DIRTY=false
DEFAULT_RELEASE_NAME="farming-${RELEASE_VERSION}"
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

glibc_tarball_contains_loader() {
  local tarball="$1"
  tar -tf "${tarball}" 2>/dev/null | awk '/(^|\/)ld-2\.28\.so$/ { found=1 } END { exit found ? 0 : 1 }'
}

create_glibc_bundle_from_root() {
  local glibc_root="$1"
  local output="$2"
  if [ ! -f "${glibc_root}/lib/ld-2.28.so" ]; then
    echo "FARMING_GLIBC_ROOT must contain lib/ld-2.28.so: ${glibc_root}" >&2
    exit 1
  fi
  tar -czf "${output}" -C "${glibc_root}" lib
}

resolve_glibc_bundle() {
  local output="${TMP_ROOT}/glibc228-lib.tar.gz"

  if [ -n "${GLIBC_BUNDLE}" ]; then
    if [ ! -f "${GLIBC_BUNDLE}" ]; then
      echo "FARMING_GLIBC_BUNDLE does not exist: ${GLIBC_BUNDLE}" >&2
      exit 1
    fi
    if ! glibc_tarball_contains_loader "${GLIBC_BUNDLE}"; then
      echo "FARMING_GLIBC_BUNDLE must contain ld-2.28.so: ${GLIBC_BUNDLE}" >&2
      exit 1
    fi
    printf '%s\n' "${GLIBC_BUNDLE}"
    return 0
  fi

  if [ -n "${FARMING_GLIBC_ROOT:-}" ]; then
    create_glibc_bundle_from_root "${FARMING_GLIBC_ROOT}" "${output}"
    printf '%s\n' "${output}"
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to fetch the default glibc 2.28 runtime for app bundle packaging." >&2
    echo "Install git, or set FARMING_GLIBC_BUNDLE=/path/to/glibc228-lib.tar.gz." >&2
    exit 1
  fi

  local repo_dir="${TMP_ROOT}/glibc-source"
  log "Fetching glibc 2.28 runtime for old Linux app bundle ..."
  if ! git clone --depth 1 "${GLIBC_SOURCE_REPO}" "${repo_dir}" >&2; then
    echo "Failed to fetch glibc 2.28 runtime from ${GLIBC_SOURCE_REPO}" >&2
    echo "Check network access, or set FARMING_GLIBC_BUNDLE=/path/to/glibc228-lib.tar.gz." >&2
    exit 1
  fi
  if [ ! -f "${repo_dir}/lib.tgz" ]; then
    echo "Default glibc source is missing lib.tgz: ${GLIBC_SOURCE_REPO}" >&2
    exit 1
  fi
  if ! glibc_tarball_contains_loader "${repo_dir}/lib.tgz"; then
    echo "Default glibc source lib.tgz does not contain ld-2.28.so: ${GLIBC_SOURCE_REPO}" >&2
    exit 1
  fi
  printf '%s\n' "${repo_dir}/lib.tgz"
}

APP_DIR="${TMP_ROOT}/${RELEASE_NAME}"
TARBALL="${RELEASE_DIR}/${RELEASE_NAME}.tar.gz"

mkdir -p "${APP_DIR}" "${RELEASE_DIR}"

if [ "${GIT_DIRTY}" = "true" ]; then
  log "Working tree has uncommitted or untracked changes; packaging the current checkout."
fi

log "Building frontend for base path ${BASE_PATH} ..."
(cd "${PROJECT_ROOT}" && FARMING_BASE_PATH="${BASE_PATH}" npm run build >&2)

log "Copying release files ..."
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'dist-release/' \
  --exclude 'releases/' \
  --exclude '.git/' \
  --exclude '.idea/' \
  --exclude '.vscode/' \
  --exclude '.farming/' \
  --exclude '.tmp/' \
  --exclude '.dolt/' \
  --exclude 'reference/' \
  --exclude 'archive/' \
  --exclude 'conversation-log.md' \
  --exclude 'claude_plan.md' \
  --exclude 'remote-communication*.md' \
  --exclude 'terminal-session-attach-plan.md' \
  --exclude '[' \
  --exclude '.doltcfg/' \
  --exclude 'config.yaml' \
  --exclude 'playwright-report/' \
  --exclude 'test-results/' \
  --exclude 'tests/' \
  --exclude 'backend/tests/' \
  --exclude 'scripts/e2e*.js' \
  --exclude 'scripts/run-tests.js' \
  --exclude 'scripts/start-playwright-server.js' \
  --exclude 'scripts/test-*.js' \
  --exclude 'eslint.config.js' \
  --exclude 'playwright.config.ts' \
  --exclude 'docs/internal/' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude '.farming.pid' \
  --exclude '.claude/' \
  --exclude '.env' \
  --exclude '.farming-release.env' \
  --exclude 'config/farming.deploy.env' \
  --exclude 'config/farming.install.env' \
  "${PROJECT_ROOT}/" "${APP_DIR}/"

cp -R "${PROJECT_ROOT}/dist" "${APP_DIR}/dist"

if [ "${BUNDLE_NODE_MODULES}" != "0" ]; then
  log "Installing production dependencies into app bundle ..."
  (
    cd "${APP_DIR}"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      PUPPETEER_SKIP_DOWNLOAD=1 \
      npm ci --omit=dev >&2
  )
fi

GLIBC_BUNDLE_SOURCE="$(resolve_glibc_bundle)"
log "Bundling glibc runtime from ${GLIBC_BUNDLE_SOURCE} ..."
mkdir -p "${APP_DIR}/vendor"
cp "${GLIBC_BUNDLE_SOURCE}" "${APP_DIR}/vendor/glibc228-lib.tar.gz"

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
  "bundledNodeModules": $(if [ "${BUNDLE_NODE_MODULES}" != "0" ]; then printf 'true'; else printf 'false'; fi),
  "bundledGlibc": true,
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
