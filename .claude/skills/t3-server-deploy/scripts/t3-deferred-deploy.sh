#!/usr/bin/env bash
# Deferred, idle-gated deploy of a freshly built t3 server into a live
# `t3 serve` host WITHOUT killing active agent sessions.
#
# Why "deferred": the repo is developed with the very server built from it, and
# every provider process (claude/codex/…) is a child of `t3 serve`. Restarting
# serve kills them all — including the agent that is running this deploy. So
# this script is launched DETACHED (systemd-run --user; see references/), waits
# until there are zero running/starting sessions, then swaps dist/ and restarts.
#
# Why a DIST SWAP (not `npm i -g`): the installed package's node_modules already
# has the resolved dep set (server bundle externalizes deps), and node-pty
# cannot gyp-rebuild on hosts without python. `npm pack` + install also breaks
# on the repo's pnpm `catalog:` deps. Reusing the installed node_modules is both
# safe and required. Rolls back to dist.old if serve doesn't come back.
#
# ============================ VARIABLES ====================================
# Override via the environment. Defaults are the ORIGINAL owner's (nixbox) —
# substitute for a new host.
#   STAGED_DIST  where you staged the fresh `apps/server/dist` before arming
#   GLOBAL_PKG   the npm-global t3 package dir (real dir, holds dist/ + node_modules)
#   SQLITE       a sqlite3 binary (no system sqlite3 on NixOS; point at any)
#   DB           t3 state db, queried read-only for the idle signal
#   SERVE_CMD    exact command used to (re)launch serve in tmux
#   HEALTH_URL   health endpoint polled after restart
#   TMUX_SESSION tmux session that owns the serve window
#   SERVE_WINDOW name for the recreated serve window
#   NTFY_URL     optional ntfy topic for notifications ("" disables)
#   BASE_PATH    prepended to PATH so the detached unit finds node/tmux/curl
STAGED_DIST=${STAGED_DIST:-$HOME/.local/state/t3-deploy/dist}
GLOBAL_PKG=${GLOBAL_PKG:-$HOME/.npm-global/lib/node_modules/t3}
SQLITE=${SQLITE:-sqlite3}
DB=${DB:-$HOME/.t3/userdata/state.sqlite}
SERVE_CMD=${SERVE_CMD:-t3 serve --host 0.0.0.0}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3773/.well-known/t3/environment}
TMUX_SESSION=${TMUX_SESSION:-main}
SERVE_WINDOW=${SERVE_WINDOW:-t3-}
NTFY_URL=${NTFY_URL:-}
BASE_PATH=${BASE_PATH:-/run/current-system/sw/bin:$HOME/.npm-global/bin}
# ===========================================================================

set -u
export PATH=$BASE_PATH:$PATH
LOG=${LOG:-$(dirname "$STAGED_DIST")/deploy.log}

say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
notify() {
  [ -z "$NTFY_URL" ] && return 0
  curl --fail -s --max-time 10 -H "Title: $1" -H "Tags: $2" -d "$3" "$NTFY_URL" >/dev/null || true
}

busy_sessions() {
  "$SQLITE" -readonly "$DB" \
    "SELECT count(*) FROM projection_thread_sessions WHERE status IN ('running','starting');" \
    2>/dev/null || echo 1
}

if [ ! -f "$STAGED_DIST/bin.mjs" ] || [ ! -d "$GLOBAL_PKG/dist" ]; then
  say "FAIL: staged dist or global package missing"
  notify "t3 deploy misconfigured" "x,warning" "Staged dist or global t3 package missing; nothing deployed."
  exit 1
fi

say "armed; waiting for idle (staged dist: $STAGED_DIST)"
consecutive_idle=0
deadline=$(( $(date +%s) + 12*3600 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(busy_sessions)" = "0" ]; then
    consecutive_idle=$((consecutive_idle + 1))
    # Three clean polls 20s apart so a settling turn can't fake idle.
    [ "$consecutive_idle" -ge 3 ] && break
  else
    consecutive_idle=0
  fi
  sleep 20
done

if [ "$consecutive_idle" -lt 3 ]; then
  say "gave up: never idle within 12h"
  notify "t3 deploy skipped" "warning" "t3 was never idle within 12h; run the deploy again."
  exit 1
fi

say "idle confirmed, swapping dist"
rm -rf "$GLOBAL_PKG/dist.new" "$GLOBAL_PKG/dist.old"
if ! cp -r "$STAGED_DIST" "$GLOBAL_PKG/dist.new"; then
  say "FAIL: staging copy into global package"
  notify "t3 deploy failed" "x,warning" "Copying the new dist into the global t3 package failed; see deploy.log"
  exit 1
fi
mv "$GLOBAL_PKG/dist" "$GLOBAL_PKG/dist.old" && mv "$GLOBAL_PKG/dist.new" "$GLOBAL_PKG/dist" || {
  say "FAIL: dist swap"
  [ -d "$GLOBAL_PKG/dist.old" ] && [ ! -d "$GLOBAL_PKG/dist" ] && mv "$GLOBAL_PKG/dist.old" "$GLOBAL_PKG/dist"
  notify "t3 deploy failed" "x,warning" "dist swap failed (rolled back); see deploy.log"
  exit 1
}

# Locate the tmux pane that owns the running `t3 serve` via its tty.
serve_pid=$(pgrep -f "bin/t3 serve" | head -1 || true)
if [ -z "${serve_pid:-}" ]; then
  say "no running t3 serve found; install done, nothing to restart"
  notify "t3 deployed (no restart needed)" "white_check_mark" "Patched t3 installed; no serve process was running."
  exit 0
fi
serve_tty=/dev/$(ps -o tty= -p "$serve_pid" | tr -d ' ')
pane=$(tmux list-panes -a -F '#{pane_id} #{pane_tty}' 2>/dev/null | awk -v t="$serve_tty" '$2==t {print $1; exit}')

if [ -z "${pane:-}" ]; then
  say "FAIL: could not map t3 serve (pid $serve_pid, tty $serve_tty) to a tmux pane"
  notify "t3 deploy needs a hand" "warning" "Patched t3 installed, but its serve process isn't in tmux; restart it manually."
  exit 1
fi

say "restarting t3 serve in pane $pane"
# CRITICAL: the serve pane runs `t3 serve` as its FOREGROUND command (no shell),
# so killing serve makes the pane — and thus its window — exit. send-keys into
# it would land nowhere. So: capture the owning window, stop serve, then
# recreate a fresh persistent serve window and health-check the REAL endpoint (a
# single early pgrep races startup and yields false negatives — this exact bug
# once left serve down through both deploy AND rollback).
win=$(tmux list-panes -a -F '#{pane_id} #{window_id}' 2>/dev/null \
        | awk -v p="$pane" '$1==p {print $2; exit}')

stop_serve() {
  tmux send-keys -t "$pane" C-c 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$serve_pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$serve_pid" 2>/dev/null; then
    say "SIGINT ignored, sending SIGTERM"
    kill "$serve_pid" 2>/dev/null
    sleep 3
  fi
}

start_serve() {
  # the pane's command may already have exited on kill, taking the window with
  # it; kill any remnant and spawn a clean, named, persistent serve window.
  [ -n "${win:-}" ] && tmux kill-window -t "$win" 2>/dev/null
  tmux new-window -d -t "$TMUX_SESSION" -n "$SERVE_WINDOW" "$SERVE_CMD"
}

serve_up() {
  for _ in $(seq 1 20); do
    curl -fsS --max-time 5 -o /dev/null "$HEALTH_URL" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

stop_serve
start_serve
if serve_up; then
  say "deployed and restarted (previous dist kept at dist.old)"
  notify "t3 deployed" "white_check_mark,rocket" "Patched t3 is live."
else
  say "serve did not come back, rolling back dist"
  mv "$GLOBAL_PKG/dist" "$GLOBAL_PKG/dist.failed" 2>/dev/null
  mv "$GLOBAL_PKG/dist.old" "$GLOBAL_PKG/dist" 2>/dev/null
  win=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_id} #{window_name}' 2>/dev/null \
          | awk -v n="$SERVE_WINDOW" '$2==n {print $1; exit}')
  start_serve
  if serve_up; then
    say "rollback ok (bad dist kept at dist.failed)"
    notify "t3 deploy rolled back" "x,warning" "New dist didn't start; rolled back (bad dist kept at dist.failed)."
  else
    say "FAIL: rollback also did not come back"
    notify "t3 down after deploy" "x,rotating_light" "t3 serve didn't come back after deploy OR rollback; check the tmux pane."
  fi
fi
