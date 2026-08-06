#!/usr/bin/env bash
set -euo pipefail

RUN_ID="${1:?Usage: watch-run.sh RUN_ID [TIMEOUT_SECONDS]}"
TIMEOUT_SECONDS="${2:-1200}"
STARTED_AT="$(date +%s)"
PREVIOUS=""

while true; do
  NOW="$(date +%s)"
  if (( NOW - STARTED_AT > TIMEOUT_SECONDS )); then
    echo "Timed out waiting for GitHub Actions run ${RUN_ID}." >&2
    exit 124
  fi

  RUN_JSON="$(gh run view "${RUN_ID}" --json status,conclusion,headSha,url,jobs)"
  SNAPSHOT="$(jq -c '{status,conclusion,headSha,jobs:[.jobs[]|{name,status,conclusion}]}' <<<"${RUN_JSON}")"

  if [[ "${SNAPSHOT}" != "${PREVIOUS}" ]]; then
    date '+%Y-%m-%dT%H:%M:%S%z'
    printf '%s\n' "${SNAPSHOT}"
    PREVIOUS="${SNAPSHOT}"
  fi

  FAILED_COUNT="$(jq '[.jobs[] | select(.conclusion == "failure")] | length' <<<"${RUN_JSON}")"
  if [[ "${FAILED_COUNT}" -gt 0 ]]; then
    echo "Failure bundle for run ${RUN_ID}:" >&2
    jq -r '.jobs[] | select(.conclusion == "failure") | [.name,.startedAt,.completedAt,.url] | @tsv' <<<"${RUN_JSON}" >&2
    FAILED_LOG="$(gh run view "${RUN_ID}" --log-failed 2>&1 || true)"
    if command -v rg >/dev/null 2>&1; then
      rg -n -C 4 '##\[error\]|Error:|AssertionError|Command failed|not included|Expected:|Received:|[0-9]+ failed' \
        <<<"${FAILED_LOG}" | tail -160 >&2 || printf '%s\n' "${FAILED_LOG}" | tail -80 >&2
    else
      printf '%s\n' "${FAILED_LOG}" | tail -120 >&2
    fi
    exit 1
  fi

  STATUS="$(jq -r '.status' <<<"${RUN_JSON}")"
  if [[ "${STATUS}" == "completed" ]]; then
    CONCLUSION="$(jq -r '.conclusion' <<<"${RUN_JSON}")"
    [[ "${CONCLUSION}" == "success" ]] && exit 0
    echo "Run ${RUN_ID} completed with ${CONCLUSION}." >&2
    exit 1
  fi

  sleep 10
done
