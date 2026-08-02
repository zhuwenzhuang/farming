#!/usr/bin/env bash
set -euo pipefail

GRACE_SECONDS=5
DRY_RUN=0
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/stop-process-identity.sh
source "${script_dir}/stop-process-identity.sh"

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
signal_targets="${task_tmp_dir}/signal-targets.tsv"

cleanup() {
  rm -f "${initial_targets}" "${current_targets}" "${remaining_targets}" "${signal_targets}"
  rmdir "${task_tmp_dir}" 2>/dev/null || true
}
trap cleanup EXIT

collect_targets() {
  local output_file="$1"
  ps -ww -axo uid=,pid=,ppid=,pgid=,lstart=,command= | awk -v owner_uid="$(id -u)" '
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
      started[pid] = $5 " " $6 " " $7 " " $8 " " $9
      command = $10
      for (field = 11; field <= NF; field += 1) command = command " " $field
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
        if (selected[pid]) print pid "\t" group[pid] "\t" started[pid] "\t" commands[pid]
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
    command = length($4) > 180 ? substr($4, 1, 177) "..." : $4
    printf "  pid=%s pgid=%s %s\n", $1, $2, command
  }' "${input_file}"
}

signal_target_file() {
  local signal_name="$1"
  local input_file="$2"
  local owner_uid
  owner_uid="$(id -u)"
  while IFS=$'\t' read -r pid _group started_at command; do
    [ -n "${pid}" ] || continue
    farming_signal_process_if_identity_matches \
      "${signal_name}" "${pid}" "${owner_uid}" "${started_at}" "${command}" || true
  done < "${input_file}"
}

filter_alive_targets() {
  local input_file="$1"
  local owner_uid
  owner_uid="$(id -u)"
  while IFS=$'\t' read -r pid group started_at command; do
    [ -n "${pid}" ] || continue
    if farming_process_identity_matches "${pid}" "${owner_uid}" "${started_at}" "${command}"; then
      printf '%s\t%s\t%s\t%s\n' "${pid}" "${group}" "${started_at}" "${command}"
    fi
  done < "${input_file}"
}

alive_from_targets() {
  filter_alive_targets "$1" | cut -f1
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

awk -F '\t' '$4 ~ /\/backend\/farming-app-cli\.cjs([[:space:]]|$)/' \
  "${initial_targets}" > "${signal_targets}"

if [ -s "${signal_targets}" ]; then
  echo "Requesting graceful shutdown..."
  signal_target_file TERM "${signal_targets}"
  for ((attempt = 0; attempt < GRACE_SECONDS * 10; attempt += 1)); do
    [ -z "$(alive_from_targets "${initial_targets}")" ] && break
    sleep 0.1
  done
fi

collect_targets "${current_targets}"
{
  cat "${current_targets}"
  filter_alive_targets "${initial_targets}"
} | sort -n -u > "${remaining_targets}"

if [ -s "${remaining_targets}" ]; then
  echo "Stopping remaining Farming processes..."
  signal_target_file TERM "${remaining_targets}"
  sleep 2
  filter_alive_targets "${remaining_targets}" > "${signal_targets}"
  if [ -s "${signal_targets}" ]; then
    echo "Forcing unresponsive Farming processes to exit..."
    signal_target_file KILL "${signal_targets}"
    sleep 0.2
  fi
fi

collect_targets "${current_targets}"
alive_from_targets "${initial_targets}" > "${signal_targets}"
if [ -s "${current_targets}" ] || [ -s "${signal_targets}" ]; then
  echo "Some Farming processes are still running:" >&2
  if [ -s "${current_targets}" ]; then
    print_targets "${current_targets}" >&2
  else
    while IFS= read -r pid; do
      ps -p "${pid}" -o pid=,ppid=,pgid=,command= >&2 || true
    done < "${signal_targets}"
  fi
  exit 1
fi

echo "All Farming processes owned by $(id -un) have stopped. Configuration and sessions were preserved."
