#!/usr/bin/env bash

farming_read_process_identity() {
  local pid="$1"
  ps -ww -p "${pid}" -o uid=,lstart=,command= 2>/dev/null | awk '
    NF >= 7 {
      command = $7
      for (field = 8; field <= NF; field += 1) command = command " " $field
      print $1 "\t" $2 " " $3 " " $4 " " $5 " " $6 "\t" command
      found = 1
      exit
    }
    END { exit !found }
  '
}

farming_process_identity_matches() {
  local pid="$1"
  local expected_uid="$2"
  local expected_started_at="$3"
  local expected_command="$4"
  local current_identity
  local current_uid
  local current_started_at
  local current_command

  current_identity="$(farming_read_process_identity "${pid}")" || return 1
  IFS=$'\t' read -r current_uid current_started_at current_command <<< "${current_identity}"
  [ "${current_uid}" = "${expected_uid}" ] \
    && [ "${current_started_at}" = "${expected_started_at}" ] \
    && [ "${current_command}" = "${expected_command}" ]
}

farming_send_signal() {
  local signal_name="$1"
  local pid="$2"
  kill "-${signal_name}" "${pid}"
}

farming_signal_process_if_identity_matches() {
  local signal_name="$1"
  local pid="$2"
  local expected_uid="$3"
  local expected_started_at="$4"
  local expected_command="$5"

  farming_process_identity_matches \
    "${pid}" "${expected_uid}" "${expected_started_at}" "${expected_command}" || return 3
  farming_send_signal "${signal_name}" "${pid}"
}
