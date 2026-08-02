#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"
export FARMING_BASE_PATH="${FARMING_BASE_PATH:-/farming}"
npm run build
FARMING_UI=react node bin/farming start --port 3000
