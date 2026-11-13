#!/bin/sh
# Kompletni zaloha: Docker image + data (databaze, sifrovaci klic) + konfigurace.
# Pouziti: ./scripts/backup-full.sh /share/Backup/hwsw
set -eu
cd "$(dirname "$0")/.."
DEST="${1:?Zadejte cilovou slozku, napr. /share/Backup/hwsw}"
NAME=hwsw-monitor
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${DEST}/hwsw-${STAMP}"
mkdir -p "$OUT"

echo "1/3 Data (konzistentni snimek databaze za behu)..."
TMP="$(docker exec "$NAME" python -c "from app import db; print(db.full_backup_file())")"
docker cp "${NAME}:${TMP}" "${OUT}/data.tar.gz"
docker exec "$NAME" rm -f "$TMP"

echo "2/3 Docker image..."
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
docker save "$IMAGE" | gzip > "${OUT}/image.tar.gz"

echo "3/3 Konfigurace..."
cp docker-compose.yml "${OUT}/"
cat > "${OUT}/OBNOVA.txt" <<TXT
Obnova HWSW Monitoru ze zalohy ${STAMP} (image ${IMAGE})
1) gunzip -c image.tar.gz | docker load
2) mkdir data && tar -xzf data.tar.gz -C data      (vznikne data/hwsw.db a data/secret.key)
3) docker compose up -d --no-build                  (ve slozce s docker-compose.yml)
TXT
du -sh "$OUT"
echo "Hotovo: $OUT"
