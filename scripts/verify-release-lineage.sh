#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANDIDATE="${1:-HEAD}"

if [ -z "${FARMING_RELEASE_INTEGRATION_REF:-}" ]; then
  printf 'Release lineage check skipped: FARMING_RELEASE_INTEGRATION_REF is not set.\n' >&2
  printf 'Set FARMING_RELEASE_INTEGRATION_REF to an authoritative ref (for example, refs/remotes/origin/main) to enforce fail-closed integration-line verification.\n' >&2
  printf 'This check is required in formal GitHub release preparation and publication workflows.\n' >&2
  exit 0
fi

INTEGRATION_REF="${FARMING_RELEASE_INTEGRATION_REF}"

if ! git -C "${PROJECT_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Release lineage check requires a Git checkout: ${PROJECT_ROOT}" >&2
  exit 1
fi

if ! CANDIDATE_SHA="$(git -C "${PROJECT_ROOT}" rev-parse --verify "${CANDIDATE}^{commit}" 2>/dev/null)"; then
  echo "Release lineage check cannot resolve candidate commit: ${CANDIDATE}" >&2
  exit 1
fi

if ! git -C "${PROJECT_ROOT}" show-ref --verify --quiet "${INTEGRATION_REF}"; then
  echo "Authoritative release integration ref is unavailable: ${INTEGRATION_REF}" >&2
  echo "Fetch the main integration line before preparing or publishing a release (for example: git fetch origin +refs/heads/main:${INTEGRATION_REF})." >&2
  exit 1
fi

INTEGRATION_SHA="$(git -C "${PROJECT_ROOT}" rev-parse --verify "${INTEGRATION_REF}^{commit}")"
if ! git -C "${PROJECT_ROOT}" merge-base --is-ancestor "${CANDIDATE_SHA}" "${INTEGRATION_SHA}"; then
  echo "Release candidate ${CANDIDATE_SHA} is not reachable from the authoritative integration ref ${INTEGRATION_REF} (${INTEGRATION_SHA})." >&2
  echo "Merge the candidate into main and fetch the updated integration ref before preparing or publishing the release." >&2
  exit 1
fi

printf 'Release lineage verified: candidate=%s integration_ref=%s integration_sha=%s\n' \
  "${CANDIDATE_SHA}" \
  "${INTEGRATION_REF}" \
  "${INTEGRATION_SHA}"
