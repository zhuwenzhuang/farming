#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPAT_GLIBC_VERSION="2.17"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "Linux compatibility packages must be built on Linux x86_64." >&2
  exit 1
fi

actual_glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [ "${actual_glibc}" != "${COMPAT_GLIBC_VERSION}" ]; then
  echo "Linux compatibility packages must be built on glibc ${COMPAT_GLIBC_VERSION}; found ${actual_glibc:-unknown}." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
if [ -z "${node_major}" ] || [ "${node_major}" -lt 22 ]; then
  echo "Linux compatibility packaging requires Node.js 22 or newer." >&2
  exit 1
fi

for command_name in npm gcc g++ make python3; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Linux compatibility packaging requires ${command_name}." >&2
    exit 1
  fi
done

package_version="$(cd "${PROJECT_ROOT}" && node -p "require('./package.json').version")"
release_name="${FARMING_RELEASE_NAME:-farming-${package_version}-linux-x64-glibc217}"

tarball="$({
  cd "${PROJECT_ROOT}"
  FARMING_RELEASE_PLATFORM=linux \
  FARMING_RELEASE_ARCH=x64 \
  FARMING_RELEASE_NAME="${release_name}" \
  FARMING_RELEASE_PROFILE=linux-x64-glibc217 \
  npm_config_build_from_source=true \
    ./scripts/package-release.sh
})"

node "${PROJECT_ROOT}/scripts/verify-linux-compat-release.js" "${tarball}"
printf '%s\n' "${tarball}"
