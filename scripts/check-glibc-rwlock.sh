#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
runtime="${1:?Usage: check-glibc-rwlock.sh RUNTIME_LIB_DIR}"
temporary="$(mktemp -d)"
trap 'rm -rf -- "${temporary}"' EXIT
# Link the compatibility pthread DSO explicitly: modern glibc merges it into
# libc, which would bind even baseline pthread symbol versions to the wrong DSO.
timeout --signal=KILL 10 "${CC:-cc}" -std=gnu11 -O2 -pthread -Wl,--wrap=__libc_start_main \
  "${root}/scripts/fixtures/glibc-rwlock.c" -Wl,--no-as-needed \
  "${runtime}/libpthread.so.0" "${runtime}/libc.so.6" "${runtime}/ld-2.28.so" \
  -Wl,--as-needed -o "${temporary}/rwlock"
timeout --signal=KILL 10 "${runtime}/ld-2.28.so" --library-path "${runtime}" "${temporary}/rwlock" >&2
