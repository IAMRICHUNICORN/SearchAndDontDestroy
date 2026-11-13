#!/bin/sh
# Bezpecna aktualizace na QNAPu: 1) zaloha databaze, 2) novy image, 3) restart.
# Pouziti: ./scripts/update.sh [cesta/k/hwsw-monitor-X.Y.Z-amd64.tar]
#   bez parametru se image sestavi ze zdrojovych souboru v teto slozce.
set -eu
cd "$(dirname "$0")/.."
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
NAME=hwsw-monitor

if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "1/3 Zalohuji databazi pred aktualizaci..."
  docker exec "$NAME" python -c "from app import db; print('   zaloha:', db.backup_db('manual'))"
else
  echo "1/3 Kontejner nebezi - zalohu provede nova verze sama pri startu."
fi

echo "2/3 Pripravuji novy image..."
if [ $# -ge 1 ]; then
  docker load -i "$1"
  $DC up -d --no-build
else
  $DC build
  $DC up -d
fi

echo "3/3 Cekam na start..."
i=0
while [ $i -lt 30 ]; do
  STATE="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo starting)"
  [ "$STATE" = "healthy" ] && { echo "Aktualizace dokoncena."; docker logs --tail 5 "$NAME"; exit 0; }
  i=$((i + 1)); sleep 3
done
echo "POZOR: kontejner se nehlasi jako zdravy. Zkontrolujte: docker logs $NAME" >&2
echo "Databaze nebyla poskozena - zalohy jsou v ./data/backups" >&2
exit 1
