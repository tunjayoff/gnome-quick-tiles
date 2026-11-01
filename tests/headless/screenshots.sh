#!/usr/bin/env bash
# Regenerates the README screenshots in docs/screenshots using the isolated headless Shell.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/docs/screenshots"
PROBE_MODE=screenshots PROBE_SHOTS_DIR="$ROOT/docs/screenshots" "$ROOT/tests/headless/run.sh"
ls -1 "$ROOT/docs/screenshots"
