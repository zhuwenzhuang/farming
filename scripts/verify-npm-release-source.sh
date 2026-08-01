#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SPEC="${1:-}"
EXPECTED_SHA="${2:-}"
MAX_ATTEMPTS="${3:-30}"
RETRY_DELAY_SECONDS="${4:-2}"

if [[ -z "${PACKAGE_SPEC}" || -z "${EXPECTED_SHA}" ]]; then
  echo "Usage: $0 <package@version> <expected-git-sha> [attempts] [delay-seconds]" >&2
  exit 2
fi

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
  published_sha="$(npm view "${PACKAGE_SPEC}" gitHead 2>/dev/null || true)"
  if [[ "${published_sha}" == "${EXPECTED_SHA}" ]]; then
    echo "Verified ${PACKAGE_SPEC} source revision: ${published_sha}"
    exit 0
  fi
  if [[ -n "${published_sha}" ]]; then
    echo "${PACKAGE_SPEC} is occupied by another source revision: npm=${published_sha}, candidate=${EXPECTED_SHA}" >&2
    exit 1
  fi
  if ((attempt < MAX_ATTEMPTS)); then
    sleep "${RETRY_DELAY_SECONDS}"
  fi
done

echo "${PACKAGE_SPEC} did not expose gitHead after ${MAX_ATTEMPTS} attempts; expected ${EXPECTED_SHA}" >&2
exit 1
