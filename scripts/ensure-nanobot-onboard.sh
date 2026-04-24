#!/usr/bin/env bash
# Bootstrap ~/.nanobot/config.json if missing (same as `nanobot onboard` without --wizard).
#
# NOTE: The Procfile now uses `console gateway`, which already calls this
# bootstrap in Python. Keep this shell helper for scripts and CI that rely on
# the historical filename; for interactive setup run `nanobot onboard --wizard`.
set -euo pipefail

config_json="${HOME}/.nanobot/config.json"
if [[ ! -f "$config_json" ]]; then
  echo "First run: no nanobot config at ${config_json}; running 'nanobot onboard'…"
  nanobot onboard
fi
