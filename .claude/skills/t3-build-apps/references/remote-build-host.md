# Building on someone else's Mac (remote build host)

Desktop dmg and iOS builds need macOS; Android/win/linux can cross-build on
Linux. If you don't have a local Mac, drive one over ssh. This is the "other
people" path — nothing here assumes the original owner's identity.

## 1. Generate an ssh key and authorize it on the build Mac

```bash
ssh-keygen -t ed25519 -C "you@example.com"          # if you don't have one
ssh-copy-id user@build-mac          # or append the pubkey to the Mac's
                                    # ~/.ssh/authorized_keys by hand
```

On the Mac, enable Remote Login (System Settings → General → Sharing → Remote
Login). Confirm: `ssh user@build-mac 'echo ok'`.

## 2. ssh config host aliases + PATH

Add an alias so commands are short and you can keep a tailnet + LAN fallback:

```sshconfig
# ~/.ssh/config
Host build-mac
    HostName 100.x.y.z        # tailnet IP (preferred)
    User you
Host build-mac-lan
    HostName 192.168.1.x      # LAN fallback when the tailnet host is flaky
    User you
```

A **non-login** ssh shell has a lean PATH — use FULL paths for tools, or export
them at the top of scripts. On nix-darwin the Mac needs
`/run/current-system/sw/bin` on PATH for nix tools.

## 3. scp scripts — do NOT nest heredocs

Quoting through `ssh host 'bash -c "…"'` with heredocs inside is a reliable way
to corrupt a build script. Write the script locally, `scp` it, run it:

```bash
scp ./ios-device-build.sh build-mac:~/build.sh
ssh build-mac 'chmod +x ~/build.sh'
```

## 4. Long builds: nohup + log file + polling

Builds run 5–20+ min; an ssh drop shouldn't kill them. Run detached in the
Mac's tmux (owner uses session `work`, windows like `androidbuild`) or via
nohup, always with an explicit log:

```bash
ssh build-mac 'cd ~ && nohup ~/build.sh > /tmp/t3-build.log 2>&1 &'
# poll:
ssh build-mac 'tail -n 40 /tmp/t3-build.log'
```

Look for the script's explicit DONE/EXIT markers (`BUILD_EXIT=0`,
`IOS_DEVICE_BUILD_DONE`, etc.) rather than trusting the ssh exit code.

## 5. GUI-only steps

The iOS **signed build** must run in the Mac's own login/GUI session (see
ios.md). From ssh, kick it via
`osascript -e 'tell application "Terminal" to do script "…"'` so it runs in an
aqua session with keychain access. Desktop health checks over ssh
false-negative (HEALTH=000) — verify via `open` in the login session.
