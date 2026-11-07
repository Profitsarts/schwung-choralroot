#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Host test: builds the MIDI FX for this machine and drives it as Schwung's chain does.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
cc -std=c11 -O2 -Wall -Wextra -Werror -Isrc -Ivendor/choralroot \
    src/dsp/choralroot_fx.c vendor/choralroot/cr_engine.c tests/test_host.c -o build/test_host
build/test_host
if command -v node >/dev/null 2>&1; then
    node tests/pads_logic.test.mjs
    node tests/pads_ui.test.mjs
else
    echo "(node not found: skipping the ChoralRoot Pads tests)"
fi
