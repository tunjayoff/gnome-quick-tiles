#!/usr/bin/env bash
# Runs the extension and a test probe in an isolated headless GNOME Shell.
# The real session is never touched: settings live in a temporary keyfile instead of
# dconf, and all XDG variables are set before the D-Bus session starts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/quicktiles-test.XXXXXX")"
EXT="$WORK/data/gnome-shell/extensions"

mkdir -p "$EXT" "$WORK/config/glib-2.0/settings"
# Own runtime dir: Shell keeps sockets and a crash-protection file there, which must not
# collide with the real session. Kept short because socket paths are limited to 108 bytes.
RUNTIME="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/qt-test.XXXXXX")"
trap 'rm -rf "$RUNTIME"' EXIT
cp -r "$ROOT/extension/quicktiles@tunjayoff" "$EXT/"
cp -r "$ROOT/tests/headless/probe@test" "$EXT/"
glib-compile-schemas "$EXT/quicktiles@tunjayoff/schemas"
# A second copy for the Looking Glass reload check (Shell caches modules by path)
mkdir -p "$WORK/reload"
cp -r "$EXT/quicktiles@tunjayoff" "$WORK/reload/"

TILES="[{\"id\": \"flag\", \"title\": \"Flag\", \"icon\": \"starred-symbolic\", \"kind\": \"toggle\", \"on\": \"touch $WORK/flag\", \"off\": \"rm -f $WORK/flag\", \"status\": \"test -e $WORK/flag && echo On\"}, {\"id\": \"btn\", \"title\": \"Button\", \"icon\": \"utilities-terminal-symbolic\", \"kind\": \"button\", \"command\": \"touch $WORK/clicked\"}]"
cat > "$WORK/config/glib-2.0/settings/keyfile" <<KEYFILE
[org/gnome/shell]
enabled-extensions=['quicktiles@tunjayoff', 'probe@test']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/shell/extensions/quicktiles]
custom-tiles='$TILES'
KEYFILE

before="$(dconf dump / | sha256sum)"
env XDG_RUNTIME_DIR="$RUNTIME" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
    XDG_STATE_HOME="$WORK/state" SHELL_DEBUG="${SHELL_DEBUG:-}" GSETTINGS_BACKEND=keyfile PROBE_OUT="$WORK" PROBE_PREFS_CLICKS="${PROBE_PREFS_CLICKS:-}" \
    PROBE_RELOAD_DIR="$WORK/reload/quicktiles@tunjayoff" \
    dbus-run-session -- timeout 60 gnome-shell --headless --wayland --no-x11 \
    --virtual-monitor 1280x800 > "$WORK/shell.log" 2>&1 || true
after="$(dconf dump / | sha256sum)"

# The test session has no accessibility bus; apps complain about it, which is not our problem
problems() { grep -E "$1" "$WORK/shell.log" | grep -v "org.a11y.atspi" || true; }

problems "PROBE|JS ERROR|CRITICAL|quicktiles:" | sed 's/^.*PROBE/PROBE/'
echo "Log and screenshots: $WORK"

[ "$before" = "$after" ] || echo "WARNING: the real dconf database changed during the test (another app may have written to it)"
if [ -n "$(problems "PROBE FAIL|JS ERROR|CRITICAL")" ] || ! grep -q "PROBE done" "$WORK/shell.log"; then
    echo "FAILED"
    exit 1
fi
echo "PASSED"
