#!/usr/bin/env bash
set -euo pipefail

read_limit_bytes() {
  local value

  if [ -r /sys/fs/cgroup/memory.max ]; then
    value="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
    if [ -n "${value}" ] && [ "${value}" != "max" ] && [ "${value}" -gt 0 ] 2>/dev/null; then
      echo "${value}"
      return 0
    fi
  fi

  if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    value="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)"
    if [ -n "${value}" ] && [ "${value}" -gt 0 ] 2>/dev/null && [ "${value}" -lt 9000000000000000000 ] 2>/dev/null; then
      echo "${value}"
      return 0
    fi
  fi

  awk '/MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo 2>/dev/null || true
}

limit_bytes="$(read_limit_bytes)"
if [ -z "${limit_bytes}" ] || ! [ "${limit_bytes}" -gt 0 ] 2>/dev/null; then
  echo 4096
  exit 0
fi

limit_mb=$((limit_bytes / 1024 / 1024))
if [ "${limit_mb}" -le 0 ]; then
  echo 4096
  exit 0
fi

if [ "${limit_mb}" -le 2048 ]; then
  heap_mb=$((limit_mb * 75 / 100))
elif [ "${limit_mb}" -le 8192 ]; then
  heap_mb=$((limit_mb - 1024))
else
  heap_mb=$((limit_mb * 90 / 100))
fi

if [ "${heap_mb}" -lt 512 ]; then
  heap_mb=512
fi

echo "${heap_mb}"
