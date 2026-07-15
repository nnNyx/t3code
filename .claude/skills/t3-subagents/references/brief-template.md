# Subagent brief template

Copy this into a file (e.g. `/tmp/brief-<task>.md`) and hand the PATH to the
agent. Fill every section — an empty section is a gap the agent will guess into.

```markdown
# Task: <one-line imperative title>

## Context

<What this is, and WHY. If a bug: the VERIFIED root cause — what you actually
confirmed, not a hypothesis. Link the code path.>

## Scope (READ CAREFULLY)

- Touch ONLY: <exact files / dirs>
- Do NOT touch: <files / dirs off-limits, esp. ones other agents own right now>
- Concurrently being edited by other agents: <files> (so you don't collide)

## Recon (use these — don't re-derive)

- <file:path>:<line> — <what's there / why it matters>
- <file:path>:<line> — ...

## Required design

<The approach to take. Constraints, patterns to follow, APIs to use. If there's
a right way and a tempting wrong way, say both.>

## Verification (run each; expected result shown)

- `<command>` -> expected: <result>
- `<command>` -> expected: <result>
- Anything you CANNOT verify here (e.g. on-device behavior): say so explicitly.

## Rules

- Do NOT commit or push. Leave the working tree dirty for review.
- No Claude co-author / "Generated with" trailers (repo rule).

## Report back

- Per verification item: the command output (not "it passed").
- Files changed (exact paths).
- Uncertainties, assumptions, and anything left unverified.
```
