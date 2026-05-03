---
description: "On-demand Boil-the-Ocean audit of the current turn against the 9 principles. Returns scorecard with gaps and recoveries."
argument-hint: "[--principle=p1..p9] [--turn=<id>]"
---

# /btoo-check

Run an on-demand BTOO audit. See [skills/btoo-check/SKILL.md](../skills/btoo-check/SKILL.md) for full behavior.

## Quick reference

- `/btoo-check` — full 9-principle audit of the current turn.
- `/btoo-check --principle=p4` — deep-dive on a single principle.
- `/btoo-check --turn=abc123` — audit a past turn from `evals/verdicts/abc123*.json`.

## What it does

1. Reads commitment + delivery + auditor findings.
2. Runs Leonidas (Sonnet 4.6) against each principle with file diffs as context.
3. Writes `evals/verdicts/<turn>-btoo-check.json`.
4. Prints scorecard with per-principle status (pass | gap | blocker) and recoveries.

## When to invoke

- Mid-turn, before Stop, to catch partial work early.
- After a `/leonidas-override`, to verify the override was justified.
- During PR review, to score the diff against BTOO.

## Acceptance for a clean check

- All 9 principles `pass`, OR
- Operator-acknowledged gaps with documented follow-up, OR
- Override invoked with logged reason.

A blocker without override = BLOCK. Fix the blocker, do not push.

## See also

- [commands/leonidas-override.md](leonidas-override.md) — force-pass path
- [hooks/btoo-stop-gate.js](../hooks/btoo-stop-gate.js) — automatic Stop-gate (deterministic rules)
- [docs/MANDATE.md](../docs/MANDATE.md) — the 9 principles
- [evals/verdict.schema.json](../evals/verdict.schema.json) — verdict format
