#!/usr/bin/env bash
set -euo pipefail

usage() {
  local status="${1:-2}"
  cat >&2 <<'EOF'
Usage:
  FARMING_COMPAT_IMAGE=<existing-image> \
    scripts/build-linux-compat-release-on-builder.sh [source-dir] [output-dir]

The source checkout must already be prepared and clean. The script reuses an
existing local Docker image and local npm/node-gyp caches, builds the glibc 2.17
bundle, verifies it, runs a real bash-agent smoke test, and writes the archive
and checksum to output-dir.

Optional environment:
  FARMING_COMPAT_NODE_DIR       Host directory containing Node.js 22+ (mounted read-only)
  FARMING_COMPAT_NPM_CACHE      Host npm cache (default: ~/.npm when present)
  FARMING_COMPAT_BUILD_CACHE    Host node-gyp/build cache (default: ~/.cache when present)
  FARMING_COMPAT_CONTAINER_PATH Extra PATH entries inside the builder
  FARMING_COMPAT_ALLOW_NETWORK  Set to 1 to allow npm network access (default: 0)
  FARMING_COMPAT_SMOKE_PORT     Port for the packaged-agent smoke (default: 46695)
EOF
  exit "${status}"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage 0
fi

SOURCE_DIR="$(cd "${1:-.}" && pwd)"
OUTPUT_ARG="${2:-${SOURCE_DIR}/releases/linux-compat-verified}"
mkdir -p "${OUTPUT_ARG}"
OUTPUT_DIR="$(cd "${OUTPUT_ARG}" && pwd)"

IMAGE="${FARMING_COMPAT_IMAGE:-}"
NODE_DIR="${FARMING_COMPAT_NODE_DIR:-}"
NPM_CACHE="${FARMING_COMPAT_NPM_CACHE:-${HOME}/.npm}"
BUILD_CACHE="${FARMING_COMPAT_BUILD_CACHE:-${HOME}/.cache}"
ALLOW_NETWORK="${FARMING_COMPAT_ALLOW_NETWORK:-0}"
SMOKE_PORT="${FARMING_COMPAT_SMOKE_PORT:-46695}"

if [ -z "${IMAGE}" ]; then
  echo "FARMING_COMPAT_IMAGE must name an existing local builder image." >&2
  usage 2
fi
if [ ! -f "${SOURCE_DIR}/package.json" ] || [ ! -x "${SOURCE_DIR}/scripts/package-linux-compat-release.sh" ]; then
  echo "Not a Farming source checkout: ${SOURCE_DIR}" >&2
  exit 2
fi
if [ "$(git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]; then
  echo "Farming source must be a Git checkout: ${SOURCE_DIR}" >&2
  exit 2
fi
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "Run this script on the existing Linux x86_64 builder host." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required on the builder host." >&2
  exit 1
fi
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "Builder image is not available locally: ${IMAGE}" >&2
  echo "The script will not pull it automatically." >&2
  exit 1
fi
if [ -n "$(git -C "${SOURCE_DIR}" status --porcelain --untracked-files=normal)" ]; then
  echo "Refusing to package a dirty source checkout: ${SOURCE_DIR}" >&2
  exit 1
fi
if [ -n "${NODE_DIR}" ] && [ ! -x "${NODE_DIR}/bin/node" ]; then
  echo "FARMING_COMPAT_NODE_DIR does not contain bin/node: ${NODE_DIR}" >&2
  exit 2
fi
case "${ALLOW_NETWORK}" in
  0|1) ;;
  *) echo "FARMING_COMPAT_ALLOW_NETWORK must be 0 or 1." >&2; exit 2 ;;
esac
case "${SMOKE_PORT}" in
  ''|*[!0-9]*) echo "FARMING_COMPAT_SMOKE_PORT must be a port number." >&2; exit 2 ;;
esac
if [ "${SMOKE_PORT}" -lt 1 ] || [ "${SMOKE_PORT}" -gt 65535 ]; then
  echo "FARMING_COMPAT_SMOKE_PORT must be between 1 and 65535." >&2
  exit 2
fi

docker_args=(
  run --rm --pull=never
  --entrypoint /bin/bash
  --user "$(id -u):$(id -g)"
  -e HOME=/tmp/farming-builder-home
  -e FARMING_RELEASE_DIR=/output
  -e FARMING_SMOKE_PORT="${SMOKE_PORT}"
  -v "${SOURCE_DIR}:/work"
  -v "${OUTPUT_DIR}:/output"
)

container_path="${FARMING_COMPAT_CONTAINER_PATH:-}"
if [ -n "${NODE_DIR}" ]; then
  docker_args+=(-v "$(cd "${NODE_DIR}" && pwd):/opt/farming-node:ro")
  container_path="/opt/farming-node/bin${container_path:+:${container_path}}"
fi
if [ -d "${NPM_CACHE}" ]; then
  docker_args+=(-v "$(cd "${NPM_CACHE}" && pwd):/tmp/farming-builder-home/.npm")
fi
if [ -d "${BUILD_CACHE}" ]; then
  docker_args+=(-v "$(cd "${BUILD_CACHE}" && pwd):/tmp/farming-builder-home/.cache")
fi
if [ -n "${container_path}" ]; then
  docker_args+=(-e "FARMING_COMPAT_PATH_PREFIX=${container_path}")
fi
if [ "${ALLOW_NETWORK}" = "0" ]; then
  docker_args+=(--network none -e npm_config_offline=true)
else
  docker_args+=(-e npm_config_prefer_offline=true)
fi

docker "${docker_args[@]}" "${IMAGE}" -lc '
  set -euo pipefail
  export PATH="${FARMING_COMPAT_PATH_PREFIX:+${FARMING_COMPAT_PATH_PREFIX}:}${PATH}"
  mkdir -p "${HOME}"
  cd /work

  for command_name in node npm gcc g++ make python3 curl; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "Builder environment is missing ${command_name}." >&2
      exit 1
    fi
  done
  actual_glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '\''{print $2}'\'')"
  if [ "${actual_glibc}" != "2.17" ]; then
    echo "Builder environment must use glibc 2.17; found ${actual_glibc:-unknown}." >&2
    exit 1
  fi
  node_major="$(node -p '\''Number(process.versions.node.split(".")[0])'\'')"
  if [ "${node_major}" -lt 22 ]; then
    echo "Builder environment must use Node.js 22 or newer." >&2
    exit 1
  fi

  echo "==> Installing build dependencies from the configured npm cache ..." >&2
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci --ignore-scripts >&2

  version="$(node -p "require(\"./package.json\").version")"
  archive="/output/farming-${version}-linux-x64-glibc217.tar.gz"
  rm -f "${archive}" "${archive}.sha256"

  echo "==> Building and verifying the glibc 2.17 bundle ..." >&2
  npm run release:app:linux-compat >&2
  test -f "${archive}"
  test -f "${archive}.sha256"
  node scripts/verify-linux-compat-release.js "${archive}" >&2

  echo "==> Running packaged bash-agent smoke ..." >&2
  smoke_dir="$(mktemp -d /tmp/farming-linux-compat-smoke.XXXXXX)"
  trap '\''rm -rf "${smoke_dir}"'\'' EXIT
  tar -xzf "${archive}" -C "${smoke_dir}"
  bundle_dir="${smoke_dir}/farming-${version}-linux-x64-glibc217"
  scripts/smoke-cli-release.sh "${bundle_dir}/farming" "${FARMING_SMOKE_PORT}"

  echo "==> Verified Linux compatibility release:" >&2
  printf "%s\n%s\n" "${archive}" "${archive}.sha256"
'
