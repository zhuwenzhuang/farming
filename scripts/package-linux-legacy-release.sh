#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "Legacy Linux packages must be built on Linux x86_64." >&2
  exit 1
fi

package_version="$(cd "${PROJECT_ROOT}" && node -p "require('./package.json').version")"
release_name="${FARMING_RELEASE_NAME:-farming-${package_version}-linux-x64-legacy-glibc228}"

FARMING_RELEASE_PLATFORM=linux \
FARMING_RELEASE_ARCH=x64 \
FARMING_RELEASE_NAME="${release_name}" \
FARMING_RELEASE_PROFILE=linux-x64-legacy-glibc228 \
  "${PROJECT_ROOT}/scripts/package-release.sh"
