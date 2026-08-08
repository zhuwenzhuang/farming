#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_HOST=""
SSH_USER=""
SSH_PORT=""
SSH_OPTIONS=()
REMOTE_DIR=""
REMOTE_CONFIG_DIR=""
REMOTE_SERVER_HOME=""
APP_PORT="6694"
BASE_PATH="/farming"
ARTIFACT=""
BUILDER_IMAGE="${FARMING_DEPLOY_BUILDER_IMAGE:-node:22.17.0-bookworm}"
DOCKER_CONTEXT="${FARMING_DEPLOY_DOCKER_CONTEXT:-}"
NPM_REGISTRY="${FARMING_DEPLOY_NPM_REGISTRY:-https://registry.npmjs.org/}"
SMOKE_AGENT="codex"
KEEP_IMAGES="5"
DISABLE_AUTH="0"
RUNTIME_NPM_MIRROR=""

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh deploy --ssh-host HOST --remote-dir PATH [options]

Build the committed Farming SHA as a private Linux Release artifact, upload it
through SSH, atomically activate it, run product readiness checks, and roll back
on failure. The remote host never installs source dependencies or builds code.

SSH options:
  --ssh-host HOST             Required SSH hostname or config alias
  --ssh-user USER             SSH user (default: current SSH configuration)
  --ssh-port PORT             SSH port (default: OpenSSH config or 22)
  --ssh-option KEY=VALUE      Repeatable OpenSSH -o option

Deployment options:
  --remote-dir PATH           Required absolute active-install path
  --config-dir PATH           Remote Config instance (default: ~/.farming)
  --server-home PATH          Optional isolated remote HOME for the Server
  --app-port PORT             Farming HTTP port (default: 6694)
  --base-path PATH            Farming URL base path (default: /farming)
  --artifact PATH             Deploy an existing verified private app bundle
  --builder-image IMAGE       Linux amd64 builder used when --artifact is omitted
  --docker-context NAME       Explicit Docker context used by the Linux builder
  --npm-registry URL          npm registry used inside the Linux builder
  --smoke-agent COMMAND       ACP provider exercised after startup (default: codex)
  --keep-images COUNT         Recent images retained in addition to rollback (default: 5)
  --runtime-npm-mirror VALUE  Optional packaged-runtime npm mirror override
  --disable-auth              Disable Farming authentication for this Config
  --help                      Show this help

Authentication uses normal OpenSSH configuration, ssh-agent, and known_hosts.
EOF
}

read_value() {
  local option="$1"
  local value="${2:-}"
  if [ -z "${value}" ] || [[ "${value}" == --* ]]; then
    echo "${option} requires a value" >&2
    exit 2
  fi
  printf '%s\n' "${value}"
}

if [ "${1:-}" = "deploy" ]; then shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ssh-host) SSH_HOST="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --ssh-user) SSH_USER="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --ssh-port) SSH_PORT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --ssh-option) SSH_OPTIONS+=("$(read_value "$1" "${2:-}")"); shift 2 ;;
    --remote-dir) REMOTE_DIR="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --config-dir) REMOTE_CONFIG_DIR="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --server-home) REMOTE_SERVER_HOME="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --app-port) APP_PORT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --base-path) BASE_PATH="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --artifact) ARTIFACT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --builder-image) BUILDER_IMAGE="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --docker-context) DOCKER_CONTEXT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --npm-registry) NPM_REGISTRY="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --smoke-agent) SMOKE_AGENT="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --keep-images) KEEP_IMAGES="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --runtime-npm-mirror) RUNTIME_NPM_MIRROR="$(read_value "$1" "${2:-}")"; shift 2 ;;
    --disable-auth) DISABLE_AUTH="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown deploy option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "${SSH_HOST}" ] || [[ "${SSH_HOST}" == -* ]] || [[ "${SSH_HOST}" == *[[:space:]]* ]]; then
  echo "--ssh-host is required and must be one OpenSSH hostname or config alias." >&2
  exit 2
fi
if [ -n "${SSH_USER}" ] && [[ ! "${SSH_USER}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "--ssh-user contains unsupported characters." >&2
  exit 2
fi
if [ -n "${SSH_PORT}" ] && { [[ ! "${SSH_PORT}" =~ ^[0-9]+$ ]] || [ "${SSH_PORT}" -lt 1 ] || [ "${SSH_PORT}" -gt 65535 ]; }; then
  echo "--ssh-port must be between 1 and 65535." >&2
  exit 2
fi
case "${REMOTE_DIR}" in
  /*) ;;
  *) echo "--remote-dir is required and must be absolute." >&2; exit 2 ;;
esac
if [[ "${REMOTE_DIR}" == *[[:space:]]* ]]; then
  echo "--remote-dir cannot contain whitespace." >&2
  exit 2
fi
for remote_path in "${REMOTE_CONFIG_DIR}" "${REMOTE_SERVER_HOME}"; do
  if [ -n "${remote_path}" ] && { [[ "${remote_path}" != /* ]] || [[ "${remote_path}" == *[[:space:]]* ]]; }; then
    echo "Remote Config and Server HOME paths must be absolute and contain no whitespace." >&2
    exit 2
  fi
done
for ssh_option in ${SSH_OPTIONS[@]+"${SSH_OPTIONS[@]}"}; do
  if [[ ! "${ssh_option}" =~ ^[A-Za-z][A-Za-z0-9-]*=.+$ ]] || [[ "${ssh_option}" == *[[:space:]]* ]]; then
    echo "--ssh-option must use KEY=VALUE without whitespace." >&2
    exit 2
  fi
done

command -v ssh >/dev/null || { echo "ssh is required." >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required." >&2; exit 1; }

SSH_ARGS=()
if [ -n "${SSH_PORT}" ]; then SSH_ARGS+=(-p "${SSH_PORT}"); fi
for ssh_option in ${SSH_OPTIONS[@]+"${SSH_OPTIONS[@]}"}; do SSH_ARGS+=(-o "${ssh_option}"); done
SSH_ARGS+=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2)
DESTINATION="${SSH_HOST}"
if [ -n "${SSH_USER}" ]; then DESTINATION="${SSH_USER}@${SSH_HOST}"; fi

remote_command() {
  local command=""
  local argument quoted
  for argument in "$@"; do
    printf -v quoted '%q' "${argument}"
    command+="${command:+ }${quoted}"
  done
  printf '%s\n' "${command}"
}

echo "==> Checking remote deployment prerequisites" >&2
EXPECTED_SELECTION="$(ssh "${SSH_ARGS[@]}" "${DESTINATION}" "$(remote_command bash -s -- "${REMOTE_DIR}")" <<'REMOTE'
set -euo pipefail
remote_dir="$1"
for command_name in node tar sha256sum flock curl find stat; do
  command -v "${command_name}" >/dev/null || {
    echo "Remote deployment requires ${command_name}." >&2
    exit 1
  }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 13) || major >= 24 ? 0 : 1)' || {
  echo "Remote deployment requires Node.js 22.13 LTS or Node.js 24+." >&2
  exit 1
}
if [ -L "${remote_dir}" ]; then
  selected="$(readlink -f "${remote_dir}")"
  node - "${selected}/.farming-deployment.json" <<'NODE'
const fs = require('fs');
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(`image:${value.gitSha || 'legacy'}:${value.sha256 || value.imageId || 'unknown'}`);
} catch {
  process.stdout.write('invalid-symlink');
}
NODE
elif [ -d "${remote_dir}" ]; then
  stat -Lc 'legacy:%d:%i' "${remote_dir}"
elif [ -e "${remote_dir}" ]; then
  printf '%s\n' invalid-path
else
  printf '%s\n' none
fi
REMOTE
 )"
case "${EXPECTED_SELECTION}" in
  none|legacy:*|image:*) ;;
  *) echo "Remote install selection is invalid or cannot be verified." >&2; exit 1 ;;
esac

if [ -z "${ARTIFACT}" ]; then
  BUILD_OUTPUT_DIR="${PROJECT_ROOT}/.tmp/private-releases/$(git -C "${PROJECT_ROOT}" rev-parse HEAD)"
  ARTIFACT="$(${PROJECT_ROOT}/scripts/build-private-linux-release.sh \
    --output-dir "${BUILD_OUTPUT_DIR}" \
    --builder-image "${BUILDER_IMAGE}" \
    --docker-context "${DOCKER_CONTEXT}" \
    --npm-registry "${NPM_REGISTRY}")"
fi
case "${ARTIFACT}" in /*) ;; *) ARTIFACT="${PROJECT_ROOT}/${ARTIFACT}" ;; esac
if [ ! -f "${ARTIFACT}" ]; then
  echo "Deployment artifact does not exist: ${ARTIFACT}" >&2
  exit 1
fi

node --import tsx "${PROJECT_ROOT}/scripts/verify-release-bundle.ts" "${ARTIFACT}" >&2
METADATA="$(cd "${PROJECT_ROOT}" && node --import tsx - "${ARTIFACT}" <<'NODE'
import { readBundleRelease } from './scripts/verify-release-bundle.ts';
const { release } = readBundleRelease(process.argv[2]);
process.stdout.write([
  release.gitSha || '', release.platform || '', release.arch || '', release.updateMethod || '',
  String(release.bundledNodeModules === true), String(release.bundledGlibcRuntime === true),
].join('\t'));
NODE
)"
IFS=$'\t' read -r GIT_SHA PLATFORM ARCH UPDATE_METHOD BUNDLED_MODULES BUNDLED_GLIBC <<<"${METADATA}"
if [[ ! "${GIT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Deployment artifact does not identify one exact commit SHA." >&2
  exit 1
fi
if [ "${PLATFORM}" != "linux" ] || [ "${ARCH}" != "x64" ] || [ "${UPDATE_METHOD}" != "app-bundle" ] || [ "${BUNDLED_MODULES}" != "true" ]; then
  echo "Deployment artifact must be a self-contained linux-x64 app bundle." >&2
  exit 1
fi
if [ "${BUNDLED_GLIBC}" != "true" ]; then
  echo "Deployment artifact must carry its Linux compatibility runtime." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM="$(sha256sum "${ARTIFACT}" | awk '{print $1}')"
else
  CHECKSUM="$(shasum -a 256 "${ARTIFACT}" | awk '{print $1}')"
fi
OPERATION_ID="${GIT_SHA:0:12}-$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
REMOTE_ARTIFACT="${REMOTE_DIR}.deploy/incoming/${OPERATION_ID}.tar.gz"

ssh "${SSH_ARGS[@]}" "${DESTINATION}" "$(remote_command bash -s -- "${REMOTE_ARTIFACT}")" <<'REMOTE'
set -euo pipefail
artifact="$1"
case "${artifact}" in /*.deploy/incoming/*.tar.gz) ;; *) echo "Unsafe remote artifact path." >&2; exit 1 ;; esac
mkdir -p "$(dirname "${artifact}")"
REMOTE

RSYNC_RSH="ssh"
if [ -n "${SSH_PORT}" ]; then
  printf -v quoted_port '%q' "${SSH_PORT}"
  RSYNC_RSH+=" -p ${quoted_port}"
fi
for ssh_option in ${SSH_OPTIONS[@]+"${SSH_OPTIONS[@]}"}; do
  printf -v quoted_option '%q' "${ssh_option}"
  RSYNC_RSH+=" -o ${quoted_option}"
done
RSYNC_RSH+=" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"
echo "==> Uploading verified private Release artifact" >&2
rsync -a --partial --checksum -e "${RSYNC_RSH}" "${ARTIFACT}" "${DESTINATION}:${REMOTE_ARTIFACT}"

ACTIVATION_ARGS=(
  --artifact "${REMOTE_ARTIFACT}"
  --checksum "${CHECKSUM}"
  --git-sha "${GIT_SHA}"
  --expected-selection "${EXPECTED_SELECTION}"
  --remote-dir "${REMOTE_DIR}"
  --app-port "${APP_PORT}"
  --base-path "${BASE_PATH}"
  --smoke-agent "${SMOKE_AGENT}"
  --keep-images "${KEEP_IMAGES}"
)
if [ -n "${REMOTE_CONFIG_DIR}" ]; then ACTIVATION_ARGS+=(--config-dir "${REMOTE_CONFIG_DIR}"); fi
if [ -n "${REMOTE_SERVER_HOME}" ]; then ACTIVATION_ARGS+=(--server-home "${REMOTE_SERVER_HOME}"); fi
if [ -n "${RUNTIME_NPM_MIRROR}" ]; then ACTIVATION_ARGS+=(--runtime-npm-mirror "${RUNTIME_NPM_MIRROR}"); fi
if [ "${DISABLE_AUTH}" = "1" ]; then ACTIVATION_ARGS+=(--disable-auth); fi

echo "==> Activating image and running Server, WebSocket, PTY, and ACP readiness" >&2
ssh "${SSH_ARGS[@]}" "${DESTINATION}" \
  "$(remote_command bash -s -- "${ACTIVATION_ARGS[@]}")" \
  < "${PROJECT_ROOT}/scripts/activate-remote-release.sh"

echo "==> Deployment succeeded for ${GIT_SHA}" >&2
