#!/usr/bin/env bash
# Run once before gateway: bootstrap ~/.nanobot/config.json if missing (same as `nanobot onboard` without --wizard).
# For interactive setup, run `nanobot onboard --wizard` manually.
set -euo pipefail

config_json="${HOME}/.nanobot/config.json"
if [[ ! -f "$config_json" ]]; then
  echo "First run: no nanobot config at ${config_json}; running 'nanobot onboard'…"
  nanobot onboard
fi
