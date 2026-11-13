#!/bin/sh
# Spusti aplikaci lokalne bez Dockeru (pro vyzkouseni/vyvoj). Data uklada do ./data.
# Pak otevrete http://localhost:8580  (prvni prihlaseni: admin / admin, zmena hesla je povinna)
set -eu
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
mkdir -p data
HWSW_DATA="$(pwd)/data" exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${HWSW_PORT:-8580}"
