#!/bin/sh
# Sestavi Docker image a ulozi ho jako soubor pro import do QNAP Container Station.
# Pouziti: ./scripts/build-image.sh [amd64|arm64]     (vychozi amd64 = QNAP s Intel/AMD)
set -eu
cd "$(dirname "$0")/.."
ARCH="${1:-amd64}"
VERSION="$(cat app/VERSION)"
mkdir -p dist
OUT="dist/hwsw-monitor-${VERSION}-${ARCH}.tar"
docker buildx build --platform "linux/${ARCH}" -t "hwsw-monitor:${VERSION}" --output "type=docker,dest=${OUT}" .
echo "Hotovo: ${OUT}"
echo "Na QNAPu: docker load -i $(basename "${OUT}")   (nebo Container Station > Images > Import)"
