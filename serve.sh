#!/usr/bin/env bash
# Serve the refund metrics UI locally.
#   ./serve.sh            serve on http://localhost:8050 (exports the data first if data/refunds.parquet.enc is missing)
#   ./serve.sh --refresh  re-pull the data from ClickHouse, then serve
# Env: PORT (default 8050), HOST (default 127.0.0.1; decryption needs localhost or https, so a plain-http
#      LAN address won't work), PYTHON (default: ../.venv/bin/python if present, else python3), DAGS_PATH
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8050}"
HOST="${HOST:-127.0.0.1}"
if [[ -z "${PYTHON:-}" ]]; then
  if [[ -x ../.venv/bin/python ]]; then PYTHON=../.venv/bin/python; else PYTHON=python3; fi
fi

if [[ "${1:-}" == "--refresh" ]]; then
  "$PYTHON" export_data.py
elif [[ ! -f data/refunds.parquet.enc || ! -f data/.key ]]; then
  if [[ -f data/refunds.parquet ]]; then "$PYTHON" export_data.py --no-pull; else "$PYTHON" export_data.py; fi
fi

echo
echo "Refund metrics UI: http://${HOST/0.0.0.0/localhost}:${PORT}/#k=$(cat data/.key)  (Ctrl+C to stop)"
exec "$PYTHON" -m http.server "$PORT" --bind "$HOST"
