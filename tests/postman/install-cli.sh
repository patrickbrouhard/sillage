#!/usr/bin/env bash
# Installe la version validée de Postman CLI dans un dossier dédié, sans sudo.
set -euo pipefail

version=1.56.1
destination=${1:?Usage: install-cli.sh DOSSIER_DESTINATION}
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
    echo "Ce script cible Linux x86_64 (y compris WSL2)." >&2
    exit 1
fi

mkdir -p "$destination"
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl --fail --silent --show-error --location --retry 3 \
    "https://dl-cli.pstmn.io/download/version/$version/linux64" \
    --output "$archive"
printf '%s  %s\n' '1169c039d5102d2c2eadec563fd7f0f8fdbf2ad7fed4bf728d2658a3bbb50105' "$archive" | sha256sum --check --status
tar -xzf "$archive" -C "$destination"
ln -sf postman-cli "$destination/postman"
"$destination/postman" --version
