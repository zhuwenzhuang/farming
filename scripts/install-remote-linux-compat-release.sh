#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARBALL="${FARMING_RELEASE_TARBALL:-${1:-}}"

if [ -z "${TARBALL}" ] || [ ! -f "${TARBALL}" ]; then
  echo "Usage: FARMING_RELEASE_TARBALL=<archive> scripts/install-remote-linux-compat-release.sh" >&2
  exit 2
fi

node "${PROJECT_ROOT}/scripts/verify-linux-compat-release.js" "${TARBALL}"

if [ -z "${FARMING_REMOTE:-}" ]; then
  echo "Set FARMING_REMOTE=user@host for the compatibility deployment target." >&2
  exit 2
fi

ssh "${FARMING_REMOTE}" 'set -e
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
glibc_version="$(getconf GNU_LIBC_VERSION | awk '\''{print $2}'\'')"
test "$(printf '\''2.17\n%s\n'\'' "${glibc_version}" | sort -V | head -1)" = 2.17
node_major="$(node -p '\''Number(process.versions.node.split(".")[0])'\'')"
test "${node_major}" -ge 22
'

FARMING_RELEASE_TARBALL="${TARBALL}" \
  "${PROJECT_ROOT}/scripts/install-remote-release.sh"
