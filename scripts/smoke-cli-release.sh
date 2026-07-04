#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 /path/to/farming [port]" >&2
  exit 2
fi

BIN="$1"
REQUESTED_PORT="${2:-${FARMING_SMOKE_PORT:-}}"
BASE_PATH="${FARMING_SMOKE_BASE_PATH:-/farming}"
TOKEN_MARKER="farming-cli-smoke-ok-$$"
SMOKE_AGENT="${FARMING_SMOKE_AGENT:-1}"

if [ ! -x "${BIN}" ]; then
  echo "Binary is not executable: ${BIN}" >&2
  exit 2
fi

TMP_ROOT="${TMPDIR:-/tmp}"
WORK_DIR="$(mktemp -d "${TMP_ROOT%/}/farming-cli-smoke.XXXXXX")"
HOME_DIR="${WORK_DIR}/home"
WORKSPACE_DIR="${WORK_DIR}/workspace"
mkdir -p "${HOME_DIR}" "${WORKSPACE_DIR}"

dump_logs() {
  local server_log="${HOME_DIR}/.farming/farming-server.log"
  local native_log="${HOME_DIR}/.farming/native-pty-host.log"
  if [ -f "${server_log}" ]; then
    echo "--- farming-server.log ---" >&2
    tail -160 "${server_log}" >&2 || true
  fi
  if [ -f "${native_log}" ]; then
    echo "--- native-pty-host.log ---" >&2
    tail -160 "${native_log}" >&2 || true
  fi
}

cleanup() {
  HOME="${HOME_DIR}" "${BIN}" stop >/dev/null 2>&1 || true
}
finish() {
  local status="$?"
  if [ "${status}" -ne 0 ]; then
    dump_logs
  fi
  cleanup
  exit "${status}"
}
trap finish EXIT

DAEMON_ARGS=(daemon)
if [ -n "${REQUESTED_PORT}" ]; then
  DAEMON_ARGS+=(--port "${REQUESTED_PORT}")
fi

HOME="${HOME_DIR}" "${BIN}" "${DAEMON_ARGS[@]}" >/tmp/farming-cli-smoke-daemon.$$.log 2>&1 || {
  cat /tmp/farming-cli-smoke-daemon.$$.log >&2 || true
  exit 1
}

URL="$(HOME="${HOME_DIR}" "${BIN}" url)"
PORT="$(printf '%s\n' "${URL}" | sed -n 's#^http://[^:]*:\([0-9][0-9]*\).*#\1#p' | head -1)"
if [ -z "${PORT}" ]; then
  echo "Failed to parse Farming URL: ${URL}" >&2
  exit 1
fi

if [ ! -f "${HOME_DIR}/.farming/settings.json" ]; then
  echo "settings.json was not auto-created under ${HOME_DIR}/.farming" >&2
  exit 1
fi

if [ ! -f "${HOME_DIR}/.farming/.session-token" ]; then
  echo ".session-token was not auto-created under ${HOME_DIR}/.farming" >&2
  exit 1
fi

AUTH_JSON="$(curl -fsS "http://127.0.0.1:${PORT}${BASE_PATH}/api/auth/status")"
case "${AUTH_JSON}" in
  *'"authRequired":true'*) ;;
  *)
    echo "Unexpected auth status: ${AUTH_JSON}" >&2
    exit 1
    ;;
esac

if [ -n "${REQUESTED_PORT}" ]; then
  SPAWN_ARGS=(--port "${REQUESTED_PORT}" --workspace "${WORKSPACE_DIR}" -- /bin/bash)
else
  SPAWN_ARGS=(--workspace "${WORKSPACE_DIR}" -- /bin/bash)
fi
if [ "${SMOKE_AGENT}" = "0" ]; then
  HOME="${HOME_DIR}" "${BIN}" stop >/dev/null
  trap - EXIT
  echo "OK binary=${BIN} port=${PORT} home=${HOME_DIR} agent=skipped"
  exit 0
fi
SPAWN_OUT="$(HOME="${HOME_DIR}" "${BIN}" spawn "${SPAWN_ARGS[@]}")"
AGENT_ID="$(printf '%s\n' "${SPAWN_OUT}" | sed -n 's/^Started //p' | head -1)"
if [ -z "${AGENT_ID}" ]; then
  echo "Failed to parse spawned agent id from: ${SPAWN_OUT}" >&2
  exit 1
fi

if [ -n "${REQUESTED_PORT}" ]; then
  HOME="${HOME_DIR}" "${BIN}" send --port "${REQUESTED_PORT}" "${AGENT_ID}" "echo ${TOKEN_MARKER}" >/dev/null
else
  HOME="${HOME_DIR}" "${BIN}" send "${AGENT_ID}" "echo ${TOKEN_MARKER}" >/dev/null
fi
sleep 1
if [ -n "${REQUESTED_PORT}" ]; then
  OUTPUT="$(HOME="${HOME_DIR}" "${BIN}" output --port "${REQUESTED_PORT}" "${AGENT_ID}" --tail 2000)"
else
  OUTPUT="$(HOME="${HOME_DIR}" "${BIN}" output "${AGENT_ID}" --tail 2000)"
fi
if ! printf '%s\n' "${OUTPUT}" | grep -F "${TOKEN_MARKER}" >/dev/null; then
  echo "Agent output did not contain marker ${TOKEN_MARKER}" >&2
  printf '%s\n' "${OUTPUT}" >&2
  exit 1
fi

if [ -n "${REQUESTED_PORT}" ]; then
  HOME="${HOME_DIR}" "${BIN}" kill --port "${REQUESTED_PORT}" "${AGENT_ID}" >/dev/null
else
  HOME="${HOME_DIR}" "${BIN}" kill "${AGENT_ID}" >/dev/null
fi
HOME="${HOME_DIR}" "${BIN}" stop >/dev/null
trap - EXIT

echo "OK binary=${BIN} port=${PORT} home=${HOME_DIR}"
