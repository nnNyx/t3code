---
name: t3-subagents
description: How to launch and prompt t3 subagents correctly — native Agent tool vs viewer-visible MCP chat threads vs detached external CLI execs, disjoint file scopes, model-override policy, the brief-file prompting pattern, and the audit gate before committing. Use whenever delegating implementation work to a subagent or another model in the t3code repo.
---

# t3 subagents: launching & prompting

Two audiences: how to **launch** delegated work, and how to **prompt** it so the
result is usable without a rewrite. Both matter — a well-launched agent with a
vague brief still fails.

## Launching — pick the right vehicle

**1. Native `Agent` tool (default for in-session subagents).** Visible in the t3
Subagents panel, background-capable, and **resumable via `SendMessage`** after
crashes or usage limits (resume keeps full context — a fresh `Agent` call does
not). Reach for this first for work inside your own session.

**2. MCP chat thread — PREFERRED for delegating to another model/driver**
(_available from server build 2026-07-11+_). Spawn a driver-backed t3 thread that
appears in the sidebar/viewer, so any session can watch it and no tmux/log
plumbing is needed:

- `chat_create_thread` — spawn a viewer-visible thread with a chosen model +
  initial prompt (e.g. hand a task to `codex`/`gpt-5.6-sol`).
- `chat_send_message` — steer or start a turn on an existing thread.
- `chat_get_thread_status` — poll status + last assistant output.

Use this instead of shelling out when you want another driver's judgment but
want the child observable in the UI like any other thread.

**3. Detached external CLI exec (`codex exec`, `omp -p`) — FALLBACK only**, e.g.
against an older server without the MCP chat tools. If you must:

- launch **detached** with an **explicit log file** and a **named tmux window**
  so it's monitorable (`tmux new-window -d -n <name> '<cmd> > /tmp/<name>.log 2>&1'`);
- remember the panel's external-agent detection is best-effort — an unnamed,
  logless exec is invisible and unrecoverable.

### Rules for all vehicles

- **Disjoint file scopes for parallel agents.** Two agents editing the same
  files will clobber each other. Give each a fenced, non-overlapping scope.
- **Repo-wide work (merges, sweeping refactors) goes in an isolated worktree**,
  not the shared checkout — it touches everything, so it can't share scope.
- **Model override per task.** Don't silently inherit the default model for bulk
  implementation. Policy (owner's): implementation subagents run on a NON-fable
  model (`model: "opus"` default, `sonnet` for simple mechanical UI, `gpt-5.5`
  via omp/MCP when its auth works), then **fable audits** before commit. fable's
  value is judgment, not bulk typing. Standing permission: if a cheaper model
  misses the bar, rerun on a smarter one without asking. Details:
  `references/delegation-policy.md`.

## Prompting — the brief-file pattern

This pattern shipped ~15 production changes here. Write a **self-contained brief
to a file**, not an inline paragraph. It must contain:

1. **Context** including VERIFIED root-cause analysis when known (not a guess).
2. **Exact scope fence:** the files/dirs to touch and an explicit _"do NOT touch
   X"_, plus what OTHER agents are concurrently editing.
3. **Required design / approach** (don't leave architecture to chance).
4. **Verification commands with expected results** — per item.
5. **"Do NOT commit or push."** (The launcher audits and commits.)
6. **Report format** — demand per-item verification output and that the agent
   state uncertainties + anything it could not verify (e.g. device-only checks).

Give **file paths + line numbers from your own recon** so the agent doesn't
re-derive them. Template: `references/brief-template.md`. Deeper rules and
examples: `references/prompting.md`.

## The audit gate (before you commit an agent's work)

Never commit an agent's diff on trust. As the reviewer (fable):

1. **Rerun tests/typechecks independently** — don't trust the agent's claim.
   Repo checks: `vp check`, `vp run typecheck`, `vp test` (vp is in
   `node_modules/.bin`; mobile typecheck standalone — root OOMs under parallelism).
2. **Read the diff**, focusing on risky surfaces (state machines, concurrency,
   auth), not just the pass/fail summary.
3. **Check scope creep:** `git status` vs the files the agent claimed to touch.
4. **Commit with scoped pathspecs.** HARD LESSON: a pathspec-scoped `git add`
   LOSES files outside the listed dirs — after committing, run `git status`
   again and sweep up stragglers, or the next agent inherits a dirty tree.

Commit style in this repo: conventional commits, **no Claude co-author /
"Generated with" trailers** (owner rule — the fork reads as their own work).
