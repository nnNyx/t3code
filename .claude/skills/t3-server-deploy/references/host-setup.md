# First-time setup for a new serve host

One-time work to make the deferred-deploy recipe seamless on a fresh machine.
Owner's concrete values (nixbox) are shown as examples — substitute yours.

## 1. Install the global `t3` package

The live server runs the **npm-global** package, not the repo checkout, so a
dist swap can replace `dist/` while keeping the resolved `node_modules`.

```bash
# Configure an npm global prefix in your home (no root):
npm config set prefix ~/.npm-global
export PATH=$HOME/.npm-global/bin:$PATH   # add to your shell rc
npm i -g t3            # or the fork's published package / a known-good version
which t3              # -> ~/.npm-global/bin/t3
ls ~/.npm-global/lib/node_modules/t3/dist   # the dir the deploy swaps
```

`GLOBAL_PKG` in the deploy script must point at
`~/.npm-global/lib/node_modules/t3` (a real dir, not a symlink; its version
tracks `apps/server/package.json`).

## 2. tmux serve window convention

Run serve as the **foreground command of a dedicated, named window** so the
deploy can find and recreate it deterministically:

```bash
tmux new-window -d -t main -n t3- 't3 serve --host 0.0.0.0'
# owner also passes --public-url https://t3.example.net so the pairing QR
# advertises the relay domain instead of the LAN IP.
```

Set `TMUX_SESSION`/`SERVE_WINDOW`/`SERVE_CMD` in the deploy script to match.

## 3. systemd-user environment (for the detached arm)

`systemd-run --user` needs a running user manager. Enable **lingering** so it
survives your logout and so the manager is up at boot:

```bash
loginctl enable-linger "$USER"
systemctl --user status        # user manager should be running
echo "$XDG_RUNTIME_DIR"        # e.g. /run/user/1000 — must be set for --user
```

If `XDG_RUNTIME_DIR` is unset in a bare ssh/tmux env, export it
(`export XDG_RUNTIME_DIR=/run/user/$(id -u)`) before `systemd-run --user`.

Always pass an explicit interpreter (`/run/current-system/sw/bin/bash` on
NixOS) — the user-manager PATH is systemd-only and won't find `bash`/`node`.

## 4. A sqlite3 binary for the idle query

The idle gate reads `state.sqlite` read-only. NixOS ships no system `sqlite3`;
point `SQLITE` at any sqlite3 binary you have (the owner reuses one at
`~/.local/state/omp-auth-check/sqlite-bin-bin/bin/sqlite3`). Alternatively query
via `node --experimental-sqlite`. The query:

```sql
SELECT count(*) FROM projection_thread_sessions
WHERE status IN ('running','starting');
```

## 5. Optional: ntfy notifications

Set `NTFY_URL` to a topic (e.g. `http://127.0.0.1:2586/host-alerts`) to get
deploy success/failure pushes. Leave empty to disable.
