#!/usr/bin/env bash
# Installs the extension for the current user. Also keeps a uniquely named copy so the
# running Shell can load fresh code from Looking Glass without logging out.
set -euo pipefail

cd "$(dirname "$0")"
UUID=quicktiles@tunjayoff
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
EXTDIR="$DATA/gnome-shell/extensions/$UUID"
# The running Shell (and the Extensions app, for prefs.js) keep using the copy that was
# loaded, so copies are never deleted here; the runtime dir is emptied at logout.
DEVROOT="${XDG_RUNTIME_DIR:-/tmp}/quicktiles-dev"

rm -rf "$EXTDIR"
mkdir -p "$EXTDIR"
cp -r extension/$UUID/. "$EXTDIR/"
glib-compile-schemas "$EXTDIR/schemas"

# Shell caches extension modules by path, so each reload needs a new folder
DEVDIR="$DEVROOT/$(date +%s%N)/$UUID"
mkdir -p "$DEVDIR"
cp -r "$EXTDIR/." "$DEVDIR/"
printf '%s\n' "$DEVDIR" > "$DEVROOT/latest"

echo "Installed: $EXTDIR"
echo "Next login, or now from Looking Glass (Alt+F2, lg), paste this one line to load or reload it:"
echo
echo "const u='$UUID', m=Main.extensionManager, o=m.lookup(u); if (o) await m.unloadExtension(o); const d=new TextDecoder().decode(GLib.file_get_contents(GLib.get_user_runtime_dir()+'/quicktiles-dev/latest')[1]).trim(); await m.loadExtension(m.createExtensionObject(u, Gio.File.new_for_path(d), 2)); m.enableExtension(u)"
