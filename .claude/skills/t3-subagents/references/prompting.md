# Prompting & delegation deep-dive

## Why a brief FILE, not an inline prompt

A file survives resume, can be re-read by the agent mid-task, and forces you to
make the scope/verification explicit. Inline paragraphs drift and get truncated
in panels. The pattern below shipped ~15 production changes in this repo.

## The non-obvious rules (each earned)

- **VERIFIED root cause, not a hypothesis.** If you hand an agent a guess as
  fact, it builds on sand. Do the recon yourself first, or tell the agent the
  root cause is UNCONFIRMED and step 1 is to confirm it.
- **File paths + line numbers from your recon.** The single biggest quality
  lever. An agent given `ChatView.logic.ts:212` fixes the right thing; one told
  "somewhere in the chat view" wanders.
- **Name what other agents are editing right now.** Parallel agents MUST have
  disjoint scopes; the brief is where you enforce it. If two need the same file,
  serialize them or move the repo-wide one into an isolated worktree.
- **Per-item verification with expected results.** "Run the tests" invites "they
  pass" with no proof. "Run `vp test packages/x` → expected 12 passing" makes
  the agent paste output you can check.
- **Demand stated uncertainties + unverifiable items.** Especially device-only
  behavior (Android/iOS installs, GUI health checks) the agent can't confirm in
  its sandbox — you want those flagged, not silently assumed working.
- **"Do NOT commit or push."** The launcher owns the commit after the audit.

## Model choice for the delegated agent

See `delegation-policy.md`. Short version: implementation → non-fable
(opus/sonnet in-session, gpt-5.5 via omp/MCP), then fable audits. Read-only
mapping/recon agents are cheap in output but still use opus unless the mapping
needs deep judgment.

## The audit gate — expanded

The reviewer (fable) does NOT rubber-stamp:

1. **Independent reruns.** Re-run the checks yourself: `vp check`,
   `vp run typecheck`, `vp test`. Known pre-existing failures to not chase:
   pnpm-workspace.yaml fmt, lint errors in `ProviderCommandReactor.test.ts`.
   Root typecheck OOMs on mobile under parallelism — run mobile standalone.
2. **Read the risky diff surfaces.** State machines, concurrency, auth — where a
   passing test still hides a bug.
3. **Scope-creep check.** `git status` vs the agent's claimed file list. An agent
   that "just also fixed" an unrelated file is a review flag.
4. **Scoped commit + straggler sweep.** Commit with explicit pathspecs, then
   `git status` AGAIN — a pathspec-scoped `git add` silently LEAVES files outside
   the listed dirs uncommitted, and the next agent inherits the dirty tree. This
   bit real work; always sweep after.

Commit hygiene: conventional messages, NO Claude co-author / "Generated with"
trailers (owner rule for this fork — see the repo's memory/rules). If a tool
re-adds trailers, strip them (`git filter-branch --msg-filter` over the fork
range, then force-push with `--force-with-lease`).
