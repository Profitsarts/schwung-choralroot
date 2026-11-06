#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
#
# Cross-compiles the MIDI FX for the Move (aarch64) and packages dist/.
# Uses a local aarch64-linux-gnu-gcc when there is one, else the Docker image in scripts/Dockerfile.
# The tarball's top-level directory MUST be the module id: Schwung extracts it straight into
# modules/midi_fx/.
set -euo pipefail
cd "$(dirname "$0")/.."

ID=choralroot
IMAGE=schwung-choralroot-builder
SRCS="src/dsp/choralroot_fx.c vendor/choralroot/cr_engine.c"
FLAGS="-std=c11 -O2 -Wall -Wextra -shared -fPIC -Isrc -Ivendor/choralroot"

if command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
    echo "==> compiling with local aarch64-linux-gnu-gcc"
    # shellcheck disable=SC2086
    aarch64-linux-gnu-gcc $FLAGS $SRCS -o dsp.so
else
    docker build -q -t "$IMAGE" -f scripts/Dockerfile scripts/ >/dev/null
    echo "==> compiling with aarch64-linux-gnu-gcc (Docker)"
    docker run --rm -v "$PWD":/build -w /build "$IMAGE" \
        aarch64-linux-gnu-gcc $FLAGS $SRCS -o /build/dsp.so
fi

echo "==> packaging dist/"
rm -rf dist && mkdir -p "dist/$ID"
mv dsp.so "dist/$ID/dsp.so"
cp src/module.json LICENSE "dist/$ID/"
mkdir -p "dist/$ID/chain_patches" && cp chain_patches/*.json "dist/$ID/chain_patches/"
( cd dist && tar -czf "$ID-module.tar.gz" "$ID/" )
echo "==> done: dist/$ID-module.tar.gz"
