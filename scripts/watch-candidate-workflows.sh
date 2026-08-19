#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_SHA="${1:-}"
if [[ -z "${CANDIDATE_SHA}" ]]; then
  echo "Usage: $0 <candidate-sha> [repository] [timeout-seconds]" >&2
  exit 2
fi

REPOSITORY="${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
TIMEOUT_SECONDS="${3:-900}"
POLL_SECONDS="${FARMING_RELEASE_WORKFLOW_POLL_SECONDS:-5}"
DISCOVERY_SECONDS="${FARMING_RELEASE_WORKFLOW_DISCOVERY_SECONDS:-20}"
NO_RUN_TIMEOUT_SECONDS="${FARMING_RELEASE_WORKFLOW_NO_RUN_TIMEOUT_SECONDS:-60}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_ROOT="${FARMING_RELEASE_WATCH_DIR:-${PROJECT_ROOT}/.tmp/release-watch}"
BUNDLE_DIR="${BUNDLE_ROOT}/candidate-${CANDIDATE_SHA}"
STARTED_AT="$(date +%s)"
PREVIOUS_SNAPSHOT=""
SEEN_RUN_COUNT=0
mkdir -p "${BUNDLE_DIR}"

while true; do
  NOW="$(date +%s)"
  ELAPSED="$((NOW - STARTED_AT))"
  RUNS_JSON="$(
    gh run list \
      --repo "${REPOSITORY}" \
      --commit "${CANDIDATE_SHA}" \
      --event push \
      --limit 100 \
      --json databaseId,workflowName,status,conclusion,createdAt,updatedAt,url,event
  )"
  printf '%s\n' "${RUNS_JSON}" > "${BUNDLE_DIR}/workflows.json"

  SNAPSHOT="$(
    RUNS_JSON="${RUNS_JSON}" node <<'NODE'
const runs = JSON.parse(process.env.RUNS_JSON);
const snapshot = runs
  .map(run => ({
    id: run.databaseId,
    workflow: run.workflowName,
    status: run.status,
    conclusion: run.conclusion,
  }))
  .sort((left, right) => String(left.workflow).localeCompare(String(right.workflow)));
process.stdout.write(JSON.stringify(snapshot));
NODE
  )"
  if [[ "${SNAPSHOT}" != "${PREVIOUS_SNAPSHOT}" ]]; then
    printf '%s candidate=%s workflows=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CANDIDATE_SHA}" "${SNAPSHOT}"
    PREVIOUS_SNAPSHOT="${SNAPSHOT}"
  fi

  FAILURE_RUNS="$(
    RUNS_JSON="${RUNS_JSON}" node <<'NODE'
const runs = JSON.parse(process.env.RUNS_JSON);
const failed = runs.filter(run => run.status === 'completed' && run.conclusion !== 'success');
process.stdout.write(JSON.stringify(failed));
NODE
  )"
  FAILURE_COUNT="$(FAILURE_RUNS="${FAILURE_RUNS}" node -p 'JSON.parse(process.env.FAILURE_RUNS).length')"
  if [[ "${FAILURE_COUNT}" -gt 0 ]]; then
    while IFS=$'\t' read -r RUN_ID WORKFLOW CONCLUSION URL; do
      [[ -n "${RUN_ID}" ]] || continue
      gh run view "${RUN_ID}" --repo "${REPOSITORY}" --log-failed \
        > "${BUNDLE_DIR}/${RUN_ID}-failure.log" 2>&1 || true
      printf 'Candidate workflow failed: %s (%s) %s\n' "${WORKFLOW}" "${CONCLUSION}" "${URL}" >&2
      FIRST_ERROR="$(
        rg -i -m1 -n \
          'npm[[:space:]]+error|[[:space:]]Error:|##\[error\]|Timeout reached|deployment_queued|[[:space:]]failed([[:space:]:]|$)' \
          "${BUNDLE_DIR}/${RUN_ID}-failure.log" || true
      )"
      printf 'First error: %s\n' "${FIRST_ERROR:-not found in failed-step log}" >&2
    done < <(
      FAILURE_RUNS="${FAILURE_RUNS}" node <<'NODE'
const runs = JSON.parse(process.env.FAILURE_RUNS);
for (const run of runs) {
  process.stdout.write(`${run.databaseId}\t${run.workflowName}\t${run.conclusion}\t${run.url}\n`);
}
NODE
    )
    echo "Candidate workflow failure bundle: ${BUNDLE_DIR}" >&2
    exit 1
  fi

  RUN_COUNT="$(RUNS_JSON="${RUNS_JSON}" node -p 'JSON.parse(process.env.RUNS_JSON).length')"
  if [[ "${RUN_COUNT}" -gt 0 ]]; then
    SEEN_RUN_COUNT="${RUN_COUNT}"
  fi
  RUNNING_COUNT="$(
    RUNS_JSON="${RUNS_JSON}" node -p \
      'JSON.parse(process.env.RUNS_JSON).filter(run => run.status !== "completed").length'
  )"
  if [[ "${RUN_COUNT}" -gt 0 && "${RUNNING_COUNT}" -eq 0 && "${ELAPSED}" -ge "${DISCOVERY_SECONDS}" ]]; then
    echo "All ${RUN_COUNT} candidate push workflows succeeded for ${CANDIDATE_SHA}."
    exit 0
  fi

  # GitHub's run-list endpoint can briefly return an empty snapshot after it
  # already exposed the candidate runs. Do not forget that authoritative
  # discovery and misclassify the candidate as having never triggered CI.
  if [[ "${RUN_COUNT}" -eq 0 && "${SEEN_RUN_COUNT}" -eq 0 && "${ELAPSED}" -ge "${NO_RUN_TIMEOUT_SECONDS}" ]]; then
    echo "No candidate push workflows appeared for ${CANDIDATE_SHA} within ${NO_RUN_TIMEOUT_SECONDS}s." >&2
    echo "Candidate workflow discovery bundle: ${BUNDLE_DIR}" >&2
    exit 1
  fi

  if [[ "${ELAPSED}" -ge "${TIMEOUT_SECONDS}" ]]; then
    echo "Timed out after ${TIMEOUT_SECONDS}s waiting for candidate push workflows for ${CANDIDATE_SHA}." >&2
    echo "Candidate workflow timeout bundle: ${BUNDLE_DIR}" >&2
    exit 124
  fi

  sleep "${POLL_SECONDS}"
done
