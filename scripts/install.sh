#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Installs the built module and its chain patches on a Move over SSH (Schwung's key setup).
#   ./scripts/build.sh && ./scripts/install.sh [host]      host defaults to move.local
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-move.local}"
DEST=/data/UserData/schwung
[ -d dist/choralroot ] || { echo "dist/choralroot missing: run ./scripts/build.sh first"; exit 1; }

echo "==> module -> $HOST:$DEST/modules/midi_fx/choralroot/"
ssh "ableton@$HOST" "mkdir -p $DEST/modules/midi_fx/choralroot $DEST/patches"
scp -q dist/choralroot/* "ableton@$HOST:$DEST/modules/midi_fx/choralroot/"
echo "==> chain patches -> $HOST:$DEST/patches/"
scp -q chain_patches/*.json "ableton@$HOST:$DEST/patches/"
ssh "ableton@$HOST" "chmod -R a+rw $DEST/modules/midi_fx/choralroot"
echo "==> done. The patches need OB-Xd installed (Schwung Manager > catalog > OB-Xd)."
