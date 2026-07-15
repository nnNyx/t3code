# Delegation model policy: non-fable implements, fable audits

**Rule (owner instruction):** delegate implementation/subagent work to models
that are NOT fable, then audit the result AS fable before committing/shipping.

## Why

fable is the most expensive model on this box (cost rank per the box CLAUDE.md:
fable 2, opus 4, gpt-5.5 9 — higher = better/cheaper as documented there; treat
fable as the premium judgment model). Its value is judgment — reviews,
architecture, tricky debugging — not bulk implementation. Inherited-model `Agent`
calls silently run everything on fable, which wastes that budget.

## How to apply

- **In-session `Agent` calls:** pass `model: "opus"` (default for
  implementation); `sonnet` for simple mechanical UI work. Explore/read-only
  mapping agents are cheap in output tokens but still use opus unless the mapping
  needs deep judgment.
- **MCP chat threads / omp one-shots:** delegate to `gpt-5.5` when its auth
  works (it's the bulk/mechanical default and effectively free); fall back to
  opus/sonnet otherwise.
- **Then ALWAYS audit as fable before commit:** read the riskiest diff surfaces
  (state machines, concurrency, auth) — not just the pass/fail summary. See the
  audit gate in SKILL.md / prompting.md.
- **Standing override:** if a cheaper model's output misses the bar, rerun with
  a smarter model without asking. Judge the output, not the price tag. Cost is a
  tie-breaker only; for anything that ships, intelligence > taste > cost.
