#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
VERSION="${VERSION#v}"
if [[ -z "${VERSION}" ]]; then
  echo "Usage: $0 <version>" >&2
  exit 2
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
CANDIDATE_SHA="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
LOCK_VERSION="$(node -p "require('./package-lock.json').packages[''].version")"
TAG_SHA="$(git ls-remote origin "refs/tags/v${VERSION}^{}" | awk '{print $1}')"
GITHUB_RELEASE="$(gh release view "v${VERSION}" --repo "${REPOSITORY}" --json isDraft,tagName,url 2>/dev/null || true)"
NPM_VERSION="$(npm view "farming-code@${VERSION}" version 2>/dev/null || true)"
NPM_GIT_HEAD="$(npm view "farming-code@${VERSION}" gitHead 2>/dev/null || true)"

printf 'timestamp=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'repository=%s\n' "${REPOSITORY}"
printf 'requested_version=%s\n' "${VERSION}"
printf 'candidate_sha=%s\n' "${CANDIDATE_SHA}"
printf 'branch=%s\n' "${BRANCH}"
printf 'package_version=%s\n' "${PACKAGE_VERSION}"
printf 'lock_version=%s\n' "${LOCK_VERSION}"
printf 'notes_en=%s\n' "$(test -f "release-notes/v${VERSION}.md" && echo present || echo missing)"
printf 'notes_zh_cn=%s\n' "$(test -f "release-notes/v${VERSION}.zh_cn.md" && echo present || echo missing)"
printf 'tag_sha=%s\n' "${TAG_SHA}"
printf 'github_release=%s\n' "${GITHUB_RELEASE}"
printf 'npm_version=%s\n' "${NPM_VERSION}"
printf 'npm_git_head=%s\n' "${NPM_GIT_HEAD}"
printf 'worktree_status_begin\n'
git status --short
printf 'worktree_status_end\n'
