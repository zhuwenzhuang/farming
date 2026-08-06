#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VERSION="${1:-$(node -p "require('${PROJECT_ROOT}/package.json').version")}"

cd "${PROJECT_ROOT}"

SHA="$(git rev-parse HEAD)"
BRANCH="$(git branch --show-current)"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
LOCK_VERSION="$(node -p "require('./package-lock.json').packages[''].version")"
NOTES="release-notes/v${VERSION}.md"
WORKTREE="$(git status --short)"
ORIGIN_MAIN="$(git rev-parse --verify origin/main 2>/dev/null || true)"

printf 'release_version=%s\n' "${VERSION}"
printf 'candidate_sha=%s\n' "${SHA}"
printf 'branch=%s\n' "${BRANCH}"
printf 'package_version=%s\n' "${PACKAGE_VERSION}"
printf 'lock_version=%s\n' "${LOCK_VERSION}"
printf 'release_notes=%s\n' "$(if [[ -f "${NOTES}" ]]; then printf present; else printf missing; fi)"
printf 'origin_main_sha=%s\n' "${ORIGIN_MAIN:-missing}"
printf 'worktree=%s\n' "$(if [[ -n "${WORKTREE}" ]]; then printf dirty; else printf clean; fi)"

if [[ -n "${WORKTREE}" ]]; then
  printf '%s\n' 'worktree_entries<<EOF'
  printf '%s\n' "${WORKTREE}"
  printf '%s\n' 'EOF'
fi

if command -v gh >/dev/null 2>&1; then
  gh run list \
    --workflow ci.yml \
    --commit "${SHA}" \
    --limit 3 \
    --json databaseId,status,conclusion,createdAt,updatedAt,url \
    --jq '{ci_runs: .}' 2>/dev/null || printf '%s\n' 'ci_runs=unavailable'
  gh release view "v${VERSION}" \
    --json tagName,isDraft,isPrerelease,publishedAt,targetCommitish,url \
    --jq '{github_release: .}' 2>/dev/null || printf '%s\n' 'github_release=missing'
else
  printf '%s\n' 'github=unavailable'
fi

if command -v npm >/dev/null 2>&1; then
  npm view "farming-code@${VERSION}" version gitHead --json 2>/dev/null \
    || printf '%s\n' 'npm_release=missing'
else
  printf '%s\n' 'npm=unavailable'
fi
