#!/bin/sh
# Spusti aplikaci lokalne bez Dockeru (pro vyzkouseni/vyvoj). Data uklada do ./data.
# Pak otevrete https://localhost:8580 (certifikat je vlastni - prohlizec se zepta na vyjimku)  (prvni prihlaseni: admin / admin, zmena hesla je povinna)
set -eu
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
mkdir -p data
HWSW_DATA="$(pwd)/data" exec .venv/bin/python -m app
