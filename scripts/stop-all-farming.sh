#!/usr/bin/env bash
set -euo pipefail

GRACE_SECONDS=5
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/stop-all-farming.sh [--dry-run]

Stops every Farming process owned by the current user without deleting
configuration or session data. Run --dry-run first to inspect the targets.

Options:
  --dry-run  Print matched processes without sending signals.
  -h, --help Show this help.
EOF
}

case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

task_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/farming-stop-all.XXXXXX")"
initial_targets="${task_tmp_dir}/initial-targets.tsv"
current_targets="${task_tmp_dir}/current-targets.tsv"
remaining_targets="${task_tmp_dir}/remaining-targets.tsv"
server_pids="${task_tmp_dir}/server-pids.txt"

cleanup() {
  rm -f "${initial_targets}" "${current_targets}" "${remaining_targets}" "${server_pids}"
  rmdir "${task_tmp_dir}" 2>/dev/null || true
}
trap cleanup EXIT

collect_targets() {
  local output_file="$1"
  ps -axo uid=,pid=,ppid=,pgid=,command= | awk -v owner_uid="$(id -u)" '
    function is_farming_seed(command) {
      return command ~ /\/backend\/farming-app-cli\.cjs([[:space:]]|$)/ \
        || command ~ /\/backend\/command-runner-child\.cjs([[:space:]]|$)/ \
        || command ~ /\/backend\/native-pty-host\.cjs([[:space:]]|$)/ \
        || command ~ /\/dist\/acp\/[^ ]+-acp-[^ ]+\.mjs([[:space:]]|$)/ \
        || command ~ /\/bin\/farming[[:space:]]+browser[[:space:]]+mcp([[:space:]]|$)/ \
        || command ~ /(^|[;&[:space:]])node[[:space:]]+([^ ]*\/)?bin\/farming[[:space:]]+(start|daemon)([[:space:]]|$)/ \
        || command ~ /(Google Chrome|Chromium).*--user-data-dir=[^ ]*farming[-_.]/
    }

    $1 == owner_uid {
      pid = $2
      parent[pid] = $3
      group[pid] = $4
      command = $5
      for (field = 6; field <= NF; field += 1) command = command " " $field
      commands[pid] = command
      if (is_farming_seed(command)) selected[pid] = 1
    }

    END {
      changed = 1
      while (changed) {
        changed = 0
        for (pid in parent) {
          if (!selected[pid] && (parent[pid] in selected) && selected[parent[pid]]) {
            selected[pid] = 1
            changed = 1
          }
        }
      }
      for (pid in selected) {
        if (selected[pid]) print pid "\t" group[pid] "\t" commands[pid]
      }
    }
  ' | sort -n > "${output_file}"
}

print_targets() {
  local input_file="$1"
  local count
  count="$(wc -l < "${input_file}" | tr -d ' ')"
  if [ "${count}" -eq 0 ]; then
    echo "No Farming processes found for user $(id -un)."
    return
  fi
  echo "Matched ${count} Farming process(es):"
  awk -F '\t' '{
    command = length($3) > 180 ? substr($3, 1, 177) "..." : $3
    printf "  pid=%s pgid=%s %s\n", $1, $2, command
  }' "${input_file}"
}

signal_pid_file() {
  local signal_name="$1"
  local input_file="$2"
  while IFS= read -r pid; do
    [ -n "${pid}" ] || continue
    kill "-${signal_name}" "${pid}" 2>/dev/null || true
  done < "${input_file}"
}

alive_from_targets() {
  local input_file="$1"
  while IFS=$'\t' read -r pid _group _command; do
    [ -n "${pid}" ] || continue
    if kill -0 "${pid}" 2>/dev/null; then
      printf '%s\n' "${pid}"
    fi
  done < "${input_file}"
}

collect_targets "${initial_targets}"
print_targets "${initial_targets}"

if [ "${DRY_RUN}" -eq 1 ] || [ ! -s "${initial_targets}" ]; then
  exit 0
fi

if awk -F '\t' '$1 == 1 { found = 1 } END { exit !found }' "${initial_targets}"; then
  echo "Refusing to continue because the process matcher selected PID 1." >&2
  exit 2
fi

if awk -F '\t' -v current_pid="$$" '$1 == current_pid { found = 1 } END { exit !found }' "${initial_targets}"; then
  echo "Refusing to stop Farming from a Farming-owned terminal. Run this script from a separate terminal." >&2
  exit 2
fi

awk -F '\t' '$3 ~ /\/backend\/farming-app-cli\.cjs([[:space:]]|$)/ { print $1 }' \
  "${initial_targets}" > "${server_pids}"

if [ -s "${server_pids}" ]; then
  echo "Requesting graceful shutdown..."
  signal_pid_file TERM "${server_pids}"
  for ((attempt = 0; attempt < GRACE_SECONDS * 10; attempt += 1)); do
    [ -z "$(alive_from_targets "${initial_targets}")" ] && break
    sleep 0.1
  done
fi

collect_targets "${current_targets}"
{
  cat "${current_targets}"
  while IFS=$'\t' read -r pid group command; do
    if kill -0 "${pid}" 2>/dev/null; then
      printf '%s\t%s\t%s\n' "${pid}" "${group}" "${command}"
    fi
  done < "${initial_targets}"
} | sort -n -u > "${remaining_targets}"

if [ -s "${remaining_targets}" ]; then
  echo "Stopping remaining Farming processes..."
  cut -f1 "${remaining_targets}" > "${server_pids}"
  signal_pid_file TERM "${server_pids}"
  sleep 2
  alive_from_targets "${remaining_targets}" > "${server_pids}"
  if [ -s "${server_pids}" ]; then
    echo "Forcing unresponsive Farming processes to exit..."
    signal_pid_file KILL "${server_pids}"
    sleep 0.2
  fi
fi

collect_targets "${current_targets}"
alive_from_targets "${initial_targets}" > "${server_pids}"
if [ -s "${current_targets}" ] || [ -s "${server_pids}" ]; then
  echo "Some Farming processes are still running:" >&2
  if [ -s "${current_targets}" ]; then
    print_targets "${current_targets}" >&2
  else
    while IFS= read -r pid; do
      ps -p "${pid}" -o pid=,ppid=,pgid=,command= >&2 || true
    done < "${server_pids}"
  fi
  exit 1
fi

echo "All Farming processes owned by $(id -un) have stopped. Configuration and sessions were preserved."
