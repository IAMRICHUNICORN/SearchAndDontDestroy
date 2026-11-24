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

echo "1b/3 Certifikat HTTPS (data/tls) - bez nej by po obnove agenti serveru neverili..."
umask 077
if docker exec "$NAME" test -d /data/tls; then
    docker exec "$NAME" tar -cf /tmp/hwsw-tls.tar -C /data tls
    docker cp "${NAME}:/tmp/hwsw-tls.tar" "${OUT}/tls.tar"
    docker exec "$NAME" rm -f /tmp/hwsw-tls.tar
    chmod 600 "${OUT}/tls.tar"
else
    echo "  (slozka data/tls neexistuje - HTTPS je vypnuto, preskoceno)"
fi
chmod 600 "${OUT}/data.tar.gz"

echo "2/3 Docker image..."
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
docker save "$IMAGE" | gzip > "${OUT}/image.tar.gz"

echo "3/3 Konfigurace..."
cp docker-compose.yml "${OUT}/"
cat > "${OUT}/OBNOVA.txt" <<TXT
Obnova HWSW Monitoru ze zalohy ${STAMP} (image ${IMAGE})
1) gunzip -c image.tar.gz | docker load
2) mkdir data && tar -xzf data.tar.gz -C data      (vznikne data/hwsw.db a data/secret.key)
2b) tar -xf tls.tar -C data                         (vznikne data/tls/cert.pem a key.pem - certifikat, kteremu veri agenti)
3) docker compose up -d --no-build                  (ve slozce s docker-compose.yml)
Soubory data.tar.gz a tls.tar obsahuji tajne udaje (klic pro hesla, soukromy klic certifikatu). Uchovejte je jen na bezpecnem miste.
TXT
du -sh "$OUT"
echo "Hotovo: $OUT"
