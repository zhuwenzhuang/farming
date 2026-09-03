#!/usr/bin/env bash
set -euo pipefail

STATE="${1:?Usage: set-release-acceptance-status.sh STATE VERSION CAMPAIGN_ID [SHA]}"
VERSION="${2:?Usage: set-release-acceptance-status.sh STATE VERSION CAMPAIGN_ID [SHA]}"
CAMPAIGN_ID="${3:?Usage: set-release-acceptance-status.sh STATE VERSION CAMPAIGN_ID [SHA]}"
SHA="${4:-$(git rev-parse HEAD)}"

case "${STATE}" in
  pending|success|failure|error) ;;
  *)
    echo "Release acceptance state must be pending, success, failure, or error: ${STATE}" >&2
    exit 2
    ;;
esac

if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Release acceptance version must be exact semver without a v prefix: ${VERSION}" >&2
  exit 2
fi
if [[ ! "${CAMPAIGN_ID}" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,47}$ ]]; then
  echo "Release acceptance campaign ID must be a 1-48 character safe identifier." >&2
  exit 2
fi
if [[ ! "${SHA}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Release acceptance SHA must be a full lowercase commit SHA: ${SHA}" >&2
  exit 2
fi

CONTEXT="farming/release-acceptance/${VERSION}/${CAMPAIGN_ID}"
COORDINATOR_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
IOS_ACCEPTANCE="selected-by-change"
if [[ "${COORDINATOR_PLATFORM}" == "linux" ]]; then
  IOS_ACCEPTANCE="skipped-linux-coordinator-rule"
fi
case "${STATE}" in
  pending) DESCRIPTION="Automated and Computer Use acceptance is running" ;;
  success) DESCRIPTION="Automated and Computer Use acceptance passed" ;;
  failure) DESCRIPTION="Required release acceptance failed" ;;
  error) DESCRIPTION="Release acceptance could not complete" ;;
esac
if [[ "${STATE}" == "success" && "${COORDINATOR_PLATFORM}" == "linux" ]]; then
  DESCRIPTION="Acceptance passed; iOS skipped by Linux coordinator rule"
fi

REPOSITORY="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
gh api \
  --method POST \
  "repos/${REPOSITORY}/statuses/${SHA}" \
  -f state="${STATE}" \
  -f context="${CONTEXT}" \
  -f description="${DESCRIPTION}" \
  >/dev/null

printf 'acceptance_context=%s\n' "${CONTEXT}"
printf 'candidate_sha=%s\n' "${SHA}"
printf 'state=%s\n' "${STATE}"
printf 'coordinator_platform=%s\n' "${COORDINATOR_PLATFORM}"
printf 'ios_acceptance=%s\n' "${IOS_ACCEPTANCE}"
