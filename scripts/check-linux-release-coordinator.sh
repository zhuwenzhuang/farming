#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
VERSION="${VERSION#v}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Usage: $0 <exact-version-without-v-prefix>" >&2
  exit 2
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

fail() {
  echo "Linux release coordinator is not ready: $*" >&2
  exit 1
}

for command_name in git gh node npm docker codex; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || fail "missing required command: ${command_name}"
done

[[ "$(uname -s)" == "Linux" ]] \
  || fail "this coordinator path is Linux-only; found $(uname -s)"

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit((major === 22 && minor >= 13) || major >= 24 ? 0 : 1);
' || fail "Node must satisfy ^22.13.0 or >=24.0.0; found $(node --version)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "${BRANCH}" == "main" ]] || fail "release checkout must be on main; found ${BRANCH}"

WORKTREE_STATUS="$(git status --porcelain --untracked-files=normal)"
[[ -z "${WORKTREE_STATUS}" ]] || fail "release checkout has uncommitted changes"

CANDIDATE_SHA="$(git rev-parse HEAD)"
[[ "${CANDIDATE_SHA}" =~ ^[a-f0-9]{40}$ ]] || fail "HEAD is not a full commit SHA"

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
LOCK_VERSION="$(node -p "require('./package-lock.json').packages[''].version")"
[[ "${PACKAGE_VERSION}" == "${VERSION}" ]] \
  || fail "package.json version ${PACKAGE_VERSION} does not match ${VERSION}"
[[ "${LOCK_VERSION}" == "${VERSION}" ]] \
  || fail "package-lock.json version ${LOCK_VERSION} does not match ${VERSION}"
[[ -f "release-notes/v${VERSION}.md" ]] || fail "missing English release notes"
[[ -f "release-notes/v${VERSION}.zh_cn.md" ]] || fail "missing Chinese release notes"

SSL_VERIFY="$(git config --global --get http.sslVerify 2>/dev/null || true)"
SSL_VERIFY_NORMALIZED="$(printf '%s' "${SSL_VERIFY}" | tr '[:upper:]' '[:lower:]')"
[[ "${SSL_VERIFY_NORMALIZED}" != "false" ]] \
  || fail "global Git http.sslVerify=false must be removed"
SSL_VERSION="$(git config --global --get http.sslVersion 2>/dev/null || true)"
SSL_VERSION_NORMALIZED="$(printf '%s' "${SSL_VERSION}" | tr '[:upper:]' '[:lower:]')"
case "${SSL_VERSION_NORMALIZED}" in
  tlsv1|tlsv1.0|tlsv1.1)
    fail "obsolete global Git http.sslVersion=${SSL_VERSION} must be removed"
    ;;
esac

gh auth status --hostname github.com >/dev/null 2>&1 \
  || fail "GitHub CLI is not authenticated"
if ! REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; then
  fail "cannot resolve the GitHub repository"
fi
[[ -n "${REPOSITORY}" ]] || fail "cannot resolve the GitHub repository"
if ! PUSH_PERMISSION="$(gh api "repos/${REPOSITORY}" --jq .permissions.push)"; then
  fail "cannot verify GitHub push permission"
fi
[[ "${PUSH_PERMISSION}" == "true" ]] || fail "GitHub identity does not have push permission"

for workflow in ci.yml release.yml publish-release.yml; do
  if ! WORKFLOW_STATE="$(gh api "repos/${REPOSITORY}/actions/workflows/${workflow}" --jq .state)"; then
    fail "cannot inspect GitHub workflow ${workflow}"
  fi
  [[ "${WORKFLOW_STATE}" == "active" ]] \
    || fail "GitHub workflow ${workflow} is not active"
done

if ! REMOTE_MAIN_SHA="$(git ls-remote origin refs/heads/main | awk '{print $1}')"; then
  fail "cannot read origin/main"
fi
[[ "${REMOTE_MAIN_SHA}" == "${CANDIDATE_SHA}" ]] \
  || fail "origin/main ${REMOTE_MAIN_SHA:-missing} does not equal candidate ${CANDIDATE_SHA}"

docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"
CONFIG_DIR="${FARMING_CONFIG_DIR:-${HOME}/.farming}"
COMPUTER_IMAGE="${FARMING_RELEASE_COMPUTER_IMAGE:-}"
if [[ -z "${COMPUTER_IMAGE}" ]]; then
  SETTINGS_FILE="${CONFIG_DIR}/settings.json"
  [[ -f "${SETTINGS_FILE}" ]] \
    || fail "set FARMING_RELEASE_COMPUTER_IMAGE or provide ${SETTINGS_FILE}"
  if ! COMPUTER_IMAGE="$(node -e '
    const fs = require("node:fs");
    const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(typeof settings.computerImage === "string" ? settings.computerImage : "");
  ' "${SETTINGS_FILE}" 2>/dev/null)"; then
    fail "cannot read Computer image from ${SETTINGS_FILE}"
  fi
fi
[[ "${COMPUTER_IMAGE}" =~ @sha256:[a-f0-9]{64}$ ]] \
  || fail "Computer image must be pinned by sha256 digest"
docker image inspect "${COMPUTER_IMAGE}" >/dev/null 2>&1 \
  || fail "pinned Computer image is not present locally"

codex login status >/dev/null 2>&1 || fail "Codex CLI is not logged in"
node scripts/check-release-managed-dependency-updates.mjs \
  || fail "managed Agent dependency preflight failed"

printf 'coordinator_platform=linux\n'
printf 'candidate_sha=%s\n' "${CANDIDATE_SHA}"
printf 'release_version=%s\n' "${VERSION}"
printf 'artifact_execution=github-actions\n'
printf 'npm_publication=github-actions-oidc\n'
printf 'ios_acceptance=skipped\n'
printf 'ios_acceptance_reason=linux-coordinator-special-rule\n'
printf 'computer_image=%s\n' "${COMPUTER_IMAGE}"
printf 'preflight=ready\n'
