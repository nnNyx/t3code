# Desktop builds (mac / win / linux)

`node scripts/build-desktop-artifact.ts` builds all three; the `dist:desktop:*`
npm scripts wrap it. Artifacts land in `release/`. `--skip-build` reuses an
existing dist; `--keep-stage` keeps the /tmp stage for inspection.

## First-time setup

- **Toolchain:** Node via `vp` (`~/.vite-plus/bin` first on PATH), pnpm 11.
  `vp` lives in `node_modules/.bin` — add it to PATH or use `npx vp`.
- **Mac:** Xcode command-line tools for codesign; a login/GUI session for a
  truthful health check.
- **Windows cross-build on Linux:** `nix profile add nixpkgs#wine` (wine 11
  works). node-pty's gyp step needs a `nix-shell -p python3 gcc gnumake`. On
  NixOS use `/run/wrappers/bin/sudo` if a stage cleanup needs root.
- If a staged `vp install --prod` fails on a broken electron package, run
  `pnpm store prune` and retry.

## The pnpm-11 packaging fix (why asar:false + hooks)

After the pnpm-11 upstream merge, a plain build produced an app that crashed on
launch with cascading `ERR_MODULE_NOT_FOUND` (fast-check → pure-rand → ms →
@effect/... — effect's Schema.js eagerly loads FastCheck).

**Root cause:** the staged `vp install --prod` produces a complete but ISOLATED
pnpm `node_modules`, and electron-builder mis-packs pnpm's isolated layout into
the asar, dropping deduped transitive leaves. Everything tried to make pnpm
flatten (`node-linker=hoisted` via workspace.yaml / .npmrc / `--config` / lockfile
delete) FAILED — pnpm 11 here always stays isolated. `includeSubNodeModules` is
not a valid electron-builder key.

**Durable fix (baked into `scripts/build-desktop-artifact.ts`):** `asar: false`
plus two hook files written into the stage dir (`afterPack.cjs` + `afterSign.cjs`)
that swap the packed (~88-pkg) tree for the complete staged tree (~296 pkgs). A
plain `pnpm dist:desktop:*` now works with NO manual step.

Two hard constraints encoded in the hooks:

1. **Exclude the build-only `electron` package** from the copy — it carries a
   nested Electron.app+Framework that codesign chokes on, and the app never
   needs it (the app IS the runtime).
2. **Split by platform:** win/linux patch in `afterPack` (no signing); macOS
   patches in `afterSign` (AFTER sign+verify) — patching pnpm's symlink farm +
   native `.node` addons before signing fails `codesign --verify --deep --strict`.
   The ad-hoc sig is invalidated, but local/unsigned fork distribution strips
   quarantine on launch anyway.

Hook paths are referenced by ABSOLUTE path from `createBuildConfig`
(electron-builder resolves hook paths relative to its CWD = apps/desktop, so a
relative `./afterPack.cjs` is Cannot-find-module). `build-desktop-artifact.test.ts`
pins both hook paths to absolute stage paths.

## Gotchas that cost hours (Mac)

- macOS temp is `/var/folders/xx/yy/T/`, NOT `/tmp`; the stage lives there at
  depth ~5 — `find -maxdepth 4` misses it.
- Paths have spaces/parens (`T3 Code (Alpha).app`) — use `find`/quotes, not globs.
- Write Mac scripts to a file and `scp` them; don't nest heredocs (quoting trap).
- **HEALTH=000 over SSH is a FALSE negative.** A headless launch hits Keychain
  `errKCInteractionNotAllowed`; the app is fine if stderr shows `backend ready`
  - `main window created`. Verify a real 200 via `open` in your login session.
- The old `~/.local/bin/fix-mac-app.sh` manual-copy wrapper is now redundant.
  If you ever recover by hand: any build's `app/node_modules` (>50 pkgs) is
  interchangeable — the client JS bundle lives in the app's `dist/`, not in
  node_modules — so copy the NEWEST complete stage's tree into the app.

## Windows / Linux notes

- Cross-built win packages lack the WSL node-pty prebuild → WSL backend won't
  start; supply `--wsl-prebuild <pty.node>` for the target arch, or rely on the
  native backend + remote envs.
- Linux: `pnpm dist:desktop:linux` (AppImage, x64).
