#!/usr/bin/env bash
set -euo pipefail

RUN_ID="${1:-}"
if [[ -z "${RUN_ID}" ]]; then
  echo "Usage: $0 <workflow-run-id> [repository]" >&2
  exit 2
fi

REPOSITORY="${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_ROOT="${FARMING_RELEASE_WATCH_DIR:-${PROJECT_ROOT}/.tmp/release-watch}"
BUNDLE_DIR="${BUNDLE_ROOT}/${RUN_ID}"
mkdir -p "${BUNDLE_DIR}"

while true; do
  RUN_JSON="$(gh run view "${RUN_ID}" --repo "${REPOSITORY}" --json status,conclusion,headSha,workflowName,url,jobs)"
  FAILURE_JOB="$({ RUN_JSON="${RUN_JSON}" node <<'NODE'
const run = JSON.parse(process.env.RUN_JSON);
const terminalFailures = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
const job = (run.jobs || []).find(candidate => terminalFailures.has(candidate.conclusion));
if (job) process.stdout.write(JSON.stringify({ id: job.databaseId, name: job.name, conclusion: job.conclusion }));
NODE
  } || true)"

  if [[ -n "${FAILURE_JOB}" ]]; then
    JOB_ID="$(FAILURE_JOB="${FAILURE_JOB}" node -p "JSON.parse(process.env.FAILURE_JOB).id")"
    JOB_NAME="$(FAILURE_JOB="${FAILURE_JOB}" node -p "JSON.parse(process.env.FAILURE_JOB).name")"
    HEAD_SHA="$(RUN_JSON="${RUN_JSON}" node -p "JSON.parse(process.env.RUN_JSON).headSha")"
    gh run view "${RUN_ID}" --repo "${REPOSITORY}" --job "${JOB_ID}" --log-failed > "${BUNDLE_DIR}/failure.log" || true
    gh api "repos/${REPOSITORY}/commits/${HEAD_SHA}" --jq '.files[]?.filename' > "${BUNDLE_DIR}/changed-files.txt" || true
    FIRST_ERROR="$(rg -i -m1 -n 'npm[[:space:]]+error|[[:space:]]Error:|##\[error\]|[[:space:]]failed([[:space:]:]|$)|[[:space:]]failure([[:space:]:]|$)' "${BUNDLE_DIR}/failure.log" || true)"
    RUN_ID="${RUN_ID}" RUN_JSON="${RUN_JSON}" FAILURE_JOB="${FAILURE_JOB}" FIRST_ERROR="${FIRST_ERROR}" BUNDLE_DIR="${BUNDLE_DIR}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const run = JSON.parse(process.env.RUN_JSON);
const job = JSON.parse(process.env.FAILURE_JOB);
const summary = {
  runId: process.env.RUN_ID,
  workflow: run.workflowName,
  url: run.url,
  candidateSha: run.headSha,
  job,
  firstError: process.env.FIRST_ERROR || '',
  changedFiles: fs.readFileSync(path.join(process.env.BUNDLE_DIR, 'changed-files.txt'), 'utf8').split(/\r?\n/).filter(Boolean),
  failureLog: path.join(process.env.BUNDLE_DIR, 'failure.log'),
};
fs.writeFileSync(path.join(process.env.BUNDLE_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
NODE
    echo "Workflow ${RUN_ID} failed in ${JOB_NAME} for ${HEAD_SHA}."
    echo "First error: ${FIRST_ERROR:-not found in failed-step log}"
    echo "Failure bundle: ${BUNDLE_DIR}"
    exit 1
  fi

  STATUS="$(RUN_JSON="${RUN_JSON}" node -p "JSON.parse(process.env.RUN_JSON).status")"
  if [[ "${STATUS}" == "completed" ]]; then
    CONCLUSION="$(RUN_JSON="${RUN_JSON}" node -p "JSON.parse(process.env.RUN_JSON).conclusion")"
    HEAD_SHA="$(RUN_JSON="${RUN_JSON}" node -p "JSON.parse(process.env.RUN_JSON).headSha")"
    echo "Workflow ${RUN_ID} completed with ${CONCLUSION} for ${HEAD_SHA}."
    [[ "${CONCLUSION}" == "success" ]]
    exit
  fi

  sleep 5
done
