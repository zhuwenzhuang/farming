#!/usr/bin/env bash
set -euo pipefail

DOCKER_CONTEXT="${1:-}"

command -v docker >/dev/null || {
  echo "Docker is required to build the Linux release artifact." >&2
  exit 1
}

if [ -n "${DOCKER_CONTEXT}" ]; then
  DOCKER_ENDPOINT="$(docker context inspect "${DOCKER_CONTEXT}" --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || {
    echo "Docker context '${DOCKER_CONTEXT}' cannot be inspected." >&2
    exit 2
  }
elif [ -n "${DOCKER_HOST:-}" ]; then
  DOCKER_ENDPOINT="${DOCKER_HOST}"
else
  DOCKER_ENDPOINT="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || {
    echo "The current Docker context cannot be inspected." >&2
    exit 2
  }
fi

case "${DOCKER_ENDPOINT}" in
  unix://*) ;;
  *)
    echo "Farming's private Linux builder requires a local Unix-socket Docker engine because it bind-mounts local repository paths." >&2
    echo "Use a local Docker context; remote, TCP, forwarded, and Windows-pipe Docker endpoints are unsupported." >&2
    exit 2
    ;;
esac
