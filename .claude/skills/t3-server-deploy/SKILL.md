---
name: t3-server-deploy
description: Build, stage, and arm a deferred, idle-gated deploy of t3 server/web changes to a live `t3 serve` host without killing active agent sessions. Use when shipping server- or browser-side changes to a running serve host (e.g. nixbox). Not for desktop/mobile apps (see t3-build-apps).
---

# t3 server deploy (deferred, zero-downtime-ish)

Ship server/web changes to a live `t3 serve` host **without interrupting active
agent sessions**. Every provider process (claude/codex) is a child of `t3 serve`,
so a naive restart kills them all — including the agent doing the deploy. The fix
is a **detached, idle-gated dist swap**: build now, arm a background job that
waits until no sessions are running, then swaps `dist/` and restarts serve.

> **Scope note.** Updating the server only fixes the **browser** flow. Desktop
> apps bundle their own web client + server, and the renderer always loads the
> LOCAL bundle — UI changes there need a fresh desktop build (t3-build-apps).

## Host model (substitute for your host)

The live server runs the **npm-global `t3` package**
(`~/.npm-global/lib/node_modules/t3`), NOT the repo checkout. It runs as the
foreground command of a tmux window (owner: session `main`, window `t3-`,
`t3 serve --host 0.0.0.0`, `0.0.0.0:3773`, health `GET /.well-known/t3/environment`).
The idle signal is read from `~/.t3/userdata/state.sqlite`.

New host? Do the one-time setup in `references/host-setup.md` first (npm-global
install, systemd-user lingering, a sqlite3 binary).

## Deploy recipe

```bash
cd ~/dev/t3code

# 1. BUILD. Bundles @t3tools/web into apps/server/dist (dist/client).
npx vp run --filter t3 build

# 2. VERIFY THE BUILD ACTUALLY SUCCEEDED before staging. A failed vite build
#    can exit 0 through vp — a bad bundle would then be deployed. Require the
#    success line:
#      grep -q "Bundled web app" <build output>   # or check dist/client mtime
#    Do NOT stage a build you did not see finish cleanly.

# 3. STAGE dist to the deferred-deploy staging dir.
STAGE=~/.local/state/t3-deploy/dist
rm -rf "$STAGE"; mkdir -p "$(dirname "$STAGE")"
cp -r apps/server/dist "$STAGE"
# If prepareOutDir / cp fails on root-owned leftovers in a dist dir (NixOS):
#   /run/wrappers/bin/sudo rm -rf <path>     # NixOS sudo lives in wrappers

# 4. ARM the detached deploy. systemd-run --user survives your own session
#    (which is itself one of the "running" sessions it waits for). Use an
#    explicit interpreter path — the user-manager PATH is systemd-only.
systemd-run --user --unit=t3-deploy --description="t3 deferred deploy" \
  /run/current-system/sw/bin/bash \
  ~/dev/t3code/.claude/skills/t3-server-deploy/scripts/t3-deferred-deploy.sh
```

The script (`scripts/t3-deferred-deploy.sh`, all paths/hosts are `VARIABLES` at
the top) then: waits for **3 consecutive idle polls** 20s apart (a settling turn
can't fake idle), swaps `dist` → `dist.old`, recreates the serve window, and
health-checks the real endpoint over ~20s. Rolls back to `dist.old` (bad build
kept at `dist.failed`) if serve doesn't return.

## Checking / rollback

```bash
tail -f ~/.local/state/t3-deploy/deploy.log     # did it fire? what happened?
systemctl --user status t3-deploy               # is the armed job still waiting?
# Manual rollback: swap dist.old back and recreate the window:
GP=~/.npm-global/lib/node_modules/t3
mv "$GP/dist" "$GP/dist.bad" && mv "$GP/dist.old" "$GP/dist"
tmux new-window -d -t main -n t3- 't3 serve --host 0.0.0.0'
```

## CRITICAL safety rules (learned the hard way)

- **Verify "Bundled web app" before staging.** A failed vite build exits 0
  through vp; staging it ships a broken bundle.
- **Never restart while your own turn is mid-flight.** That's the entire reason
  the deploy is deferred — do NOT bypass it with a direct restart during work.
- **Recreate the serve window; never `send-keys` a restart.** Serve is the
  window's foreground command — killing it kills the pane, so `send-keys` lands
  nowhere. Recreate the window and health-check the endpoint (a single early
  `pgrep` races startup → false "serve did not come back" → needless rollback).
- **Root-owned leftovers in dist break prepareOutDir.** Fix with
  `/run/wrappers/bin/sudo` on NixOS (system sudo isn't on PATH).
- **Dist swap only — never `npm i -g` a tarball.** pnpm `catalog:` deps don't
  resolve under npm and node-pty can't gyp-rebuild without python.

Full rationale, the state.sqlite idle query, and the 2026-07-05 double-outage
post-mortem: `references/deploy-internals.md`.
