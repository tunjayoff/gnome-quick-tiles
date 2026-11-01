#!/usr/bin/env bash
# Builds the zip to upload to extensions.gnome.org.
set -euo pipefail
cd "$(dirname "$0")"
gnome-extensions pack extension/quicktiles@tunjayoff \
    --extra-source=layout.js --extra-source=editMode.js --extra-source=commandTiles.js --extra-source=gtype.js --extra-source=builtinTiles.js --extra-source=builtinCatalog.js --extra-source=icons \
    --force --out-dir=.
ls -1 ./*.shell-extension.zip
