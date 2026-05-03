---
description: "Force-pass a BLOCKed Stop event. Logged for weekly review. Use only when a permanent solve is genuinely not in scope."
argument-hint: "<reason — required, free text>"
---

# /leonidas-override

Force-pass the BTOO Stop-gate when a permanent solve is genuinely out of scope and a partial delivery is the right call (e.g., a generated file with no upstream, a one-shot diagnostic, an emergency hotfix where docs follow in a separate PR).

**Override is the exception, not the pattern.** If your override rate exceeds 5% across a rolling 30-day window, the mandate or the gate is wrong — surface that as a tuning conversation, do not silently keep overriding.

## Usage

```
/leonidas-override "Diagnostic spike for FM4 path-finder; permanent fix tracked at issue #142, ETA Friday."
```

## What it does

1. Sets `LEONIDAS_OVERRIDE=1` and `LEONIDAS_OVERRIDE_REASON=<reason>` for the next Stop event only.
2. The next Stop emits a verdict with `decision.override_used: true` and `decision.override_reason: <reason>`.
3. The verdict file lands in `evals/verdicts/` like any other.
4. A weekly cron summarizes overrides to the operator: count, reasons, principle most-overridden.

## Required fields

- `<reason>` — non-empty string. The hook will REFUSE the override if the reason is empty, "n/a," "test," or shorter than 20 characters. Documenting *why* is the price of override.

## What override does NOT do

- It does not skip the Auditor — `audit.json` is still written.
- It does not skip the verdict file — the override and reason are recorded.
- It does not extend to subsequent turns — each override is single-use.

## Audit cadence

Weekly review (open question Q4 in the PRD pending resolution). If override rate >5%, that is a signal the mandate is too strict for the current scope OR the rules are misfiring — investigate, do not normalize.

## See also

- [commands/btoo-check.md](btoo-check.md) — on-demand audit (use BEFORE override to confirm a permanent solve is really unreachable)
- [hooks/btoo-stop-gate.js](../hooks/btoo-stop-gate.js) — the Stop-gate this overrides
- [docs/MANDATE.md](../docs/MANDATE.md) — the standard
