#!/usr/bin/env bash
set -euo pipefail

EXIT_WAIT_SECONDS=5
DRY_RUN=0
signal_failures=0
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/stop-process-identity.sh
source "${script_dir}/stop-process-identity.sh"

usage() {
  cat <<'EOF'
Usage: scripts/stop-all-farming.sh [--dry-run]

Directly kills every selected Farming process owned by the current user without deleting
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
    function path_ends_with(value, suffix, prefix_length) {
      if (value == suffix) return 1
      prefix_length = length(value) - length(suffix)
      return prefix_length > 0 \
        && substr(value, prefix_length, 1) == "/" \
        && substr(value, prefix_length + 1) == suffix
    }

    function is_node_executable(value) {
      return value == "node" || value == "node.exe" || value ~ /\/node(\.exe)?$/
    }

    function is_linux_loader(value) {
      return value ~ /(^|\/)(ld-linux[^\/]*|ld-musl[^\/]*|ld-[0-9]+(\.[0-9]+)*\.so)$/
    }

    function is_server_script(value) {
      return path_ends_with(value, "backend/farming-app-cli.cjs")
    }

    function is_internal_script(value) {
      return path_ends_with(value, "backend/command-runner-child.cjs") \
        || path_ends_with(value, "backend/acp-runtime-host-process.cjs") \
        || path_ends_with(value, "backend/native-pty-host.cjs") \
        || value ~ /(^|\/)dist\/acp\/[^\/[:space:]]+-acp-[^\/[:space:]]+\.mjs$/
    }

    function is_server_cli(cli_field, command) {
      if (!path_ends_with($(cli_field), "bin/farming")) return 0
      command = $(cli_field + 1)
      return command == "start" || command == "daemon"
    }

    function is_browser_cli(cli_field) {
      return path_ends_with($(cli_field), "bin/farming") \
        && $(cli_field + 1) == "browser" \
        && $(cli_field + 2) == "mcp"
    }

    function is_node_auxiliary_seed(node_field, script_field) {
      if (!is_node_executable($(node_field))) return 0
      return is_internal_script($(script_field)) \
        || is_browser_cli(script_field)
    }

    function is_server_seed() {
      return (is_node_executable($10) \
          && (is_server_script($11) || is_server_cli(11))) \
        || (is_linux_loader($10) && $11 == "--library-path" \
          && is_node_executable($13) \
          && (is_server_script($14) || is_server_cli(14))) \
        || is_server_cli(10)
    }

    function is_chrome_seed(command) {
      if (command !~ /--user-data-dir=[^ ]*farming[-_.]/) return 0
      return $10 ~ /(^|\/)(google-chrome(-stable)?|chromium(-browser)?)$/ \
        || command ~ /^\/[^[:space:]]*\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome([[:space:]]|$)/ \
        || command ~ /^\/[^[:space:]]*\/Chromium\.app\/Contents\/MacOS\/Chromium([[:space:]]|$)/
    }

    function farming_seed_kind(command) {
      # Only executable/argv positions establish a Farming-owned root. A path
      # mentioned by an unrelated command remains unowned; descendants of a
      # verified root are added separately below.
      if (is_server_seed()) return 2
      if (is_node_auxiliary_seed(10, 11) \
          || (is_linux_loader($10) && $11 == "--library-path" \
            && is_node_auxiliary_seed(13, 14)) \
          || is_browser_cli(10) \
          || is_chrome_seed(command)) return 1
      return 0
    }

    $1 == owner_uid {
      pid = $2
      parent[pid] = $3
      group[pid] = $4
      started[pid] = $5 " " $6 " " $7 " " $8 " " $9
      command = $10
      for (field = 11; field <= NF; field += 1) command = command " " $field
      commands[pid] = command
      seed_kind = farming_seed_kind(command)
      if (seed_kind) {
        selected[pid] = 1
        server[pid] = seed_kind == 2
      }
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
        # Kill Server roots first, then ancestors before their workers, so
        # Servers cannot recreate a detached Host and parents cannot recreate a worker
        # after it is killed. Detached descendants remain in this snapshot.
        depth = 0
        ancestor = parent[pid]
        while (ancestor in parent && ancestor != parent[ancestor]) {
          depth += 1
          ancestor = parent[ancestor]
        }
        if (selected[pid]) print pid "\t" group[pid] "\t" started[pid] "\t" sprintf("%d:%09d", server[pid] ? 0 : 1, depth) "\t" commands[pid]
      }
    }
  ' | sort -t $'\t' -k4,4 -k1,1n > "${output_file}"
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
    command = length($5) > 180 ? substr($5, 1, 177) "..." : $5
    printf "  pid=%s pgid=%s %s\n", $1, $2, command
  }' "${input_file}"
}

signal_target_file() {
  local signal_name="$1"
  local input_file="$2"
  local owner_uid
  owner_uid="$(id -u)"
  while IFS=$'\t' read -r pid _group started_at _order command; do
    [ -n "${pid}" ] || continue
    if ! farming_signal_process_if_identity_matches \
      "${signal_name}" "${pid}" "${owner_uid}" "${started_at}" "${command}"; then
      signal_failures=$((signal_failures + 1))
    fi
  done < "${input_file}"
}

filter_alive_targets() {
  local input_file="$1"
  local owner_uid
  owner_uid="$(id -u)"
  while IFS=$'\t' read -r pid group started_at order command; do
    [ -n "${pid}" ] || continue
    if farming_process_identity_matches "${pid}" "${owner_uid}" "${started_at}" "${command}"; then
      printf '%s\t%s\t%s\t%s\t%s\n' "${pid}" "${group}" "${started_at}" "${order}" "${command}"
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

# One stop semantic: signal the verified snapshot directly with KILL. Do not
# turn a concurrent independent start into another implicitly selected stop.
echo "Hard-stopping selected Farming processes..."
signal_target_file KILL "${initial_targets}"
for ((attempt = 0; attempt < EXIT_WAIT_SECONDS * 10; attempt += 1)); do
  filter_alive_targets "${initial_targets}" > "${remaining_targets}"
  [ ! -s "${remaining_targets}" ] && break
  sleep 0.1
done

collect_targets "${current_targets}"
alive_from_targets "${initial_targets}" > "${signal_targets}"
if [ -s "${current_targets}" ] || [ -s "${signal_targets}" ] || [ "${signal_failures}" -ne 0 ]; then
  echo "Farming stop did not reach an empty process set. Remaining or concurrently started processes:" >&2
  if [ -s "${current_targets}" ]; then
    print_targets "${current_targets}" >&2
  else
    while IFS= read -r pid; do
      ps -p "${pid}" -o pid=,ppid=,pgid=,command= >&2 || true
    done < "${signal_targets}"
  fi
  echo "If a task or supervisor is starting Farming concurrently, stop that launcher before retrying npm restart." >&2
  exit 1
fi

echo "All Farming processes owned by $(id -un) have stopped. Configuration and sessions were preserved."
