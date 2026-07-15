#!/usr/bin/env bash
# Install a freshly built desktop app and health-check it end to end. The
# electron-builder afterPack/afterSign hooks (in scripts/build-desktop-artifact.ts)
# swap the pruned packed node_modules for the COMPLETE staged tree; this script
# validates that the installed app actually boots with no ERR_MODULE_NOT_FOUND.
#
# GUI vs SSH gotcha: launched over plain SSH the app gives HEALTH=000 and
# Keychain errKCInteractionNotAllowed (no aqua/GUI session) even when it is
# FINE. The truth is in stderr: "backend ready" + "main window created" = healthy.
# For a real HEALTH=200 check, launch via `open` in the user's own login session.
#
# ============================ VARIABLES ====================================
# macOS example. Point APP at the built .app (from a dmg mount or release/).
APP=${APP:-"/Applications/T3 Code (Alpha).app"}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3773/.well-known/t3/environment}
# ===========================================================================
set -u
RES="$APP/Contents/Resources/app/node_modules"

echo "=== node_modules sanity (complete tree, ~296 pkgs, electron ABSENT) ==="
if [ -d "$RES" ]; then
  echo "pkg_count=$(find "$RES" -maxdepth 1 -type d | wc -l | tr -d ' ')"
  for p in ms pure-rand effect; do
    [ -d "$RES/$p" ] && echo "present: $p" || echo "MISSING: $p"
  done
  # electron must NOT be bundled — it carries a nested Electron.app that
  # codesign chokes on and the app never needs (the app IS the runtime).
  [ -d "$RES/electron" ] && echo "WARN: electron present (should be excluded)" || echo "ok: electron excluded"
else
  echo "NO node_modules at $RES — asar may be true, or the hook didn't run"
fi

echo "=== launch + health ==="
# Prefer the user's GUI session for a truthful health code:
open "$APP" 2>/dev/null || echo "note: 'open' failed (headless?) — check stderr for 'backend ready'"
for _ in $(seq 1 30); do
  code=$(curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "HEALTH=$code   (000 over headless SSH is a FALSE negative — verify 'backend ready'/'main window created' in the app's stderr)"
