---
description: "Ask PromptNexus what's outstanding. Returns: open roadblocks, last 5 verdicts, override-rate this week, unresolved routing-matrix targets, data-loss flags."
argument-hint: "[--days=N]"
---

# /promptnexus-status

Ask PromptNexus where you are.

The intent is that **Claude does not get to decide what's outstanding** — Leonidas + the verdict log + mempalace decide. This command is the read.

## What it returns

```
PromptNexus Status — generated <ts> by Leonidas (Sonnet 4.6)
══════════════════════════════════════════════════════════════════════

LAST 5 VERDICTS (most recent first):
  <ts> · <turn_id> · ALLOW|BLOCK · blocks=N · override=yes|no · dlr=yes|no
    reason: "<one-line>"

OVERRIDE-RATE (rolling 30 days): X.X%   (target ≤5%; alarms above)

OPEN ROADBLOCKS (recovered=false):
  <playbook_id> · <symptom> · age=<duration>

UNRESOLVED ROUTING-MATRIX TARGETS:
  <repo /command> · last seen in matrix at row <n>

ACTIVE DIRECTIVES IN FLIGHT:
  <list of intents with no follow-up verdict yet>

NEXT MOVES (Leonidas's prescription):
  1. <first thing to do, with rationale>
  2. <second thing>
  3. <third thing>

THE STANDARD: `holy shit, that's done.` — anything less is a BLOCK.
```

## How it works

1. Reads `evals/verdicts/*.json` for the local file source of truth.
2. Queries Postgres `verdicts` table for cross-session history (when memory-stack-all is up).
3. Queries Postgres `roadblocks` table where `recovered = false`.
4. Runs `node scripts/lint-routing-matrix.js --strict` to surface unresolved matrix targets.
5. Hands the aggregated state to Leonidas (Sonnet) with the system prompt: *"Given this state, prescribe the next 3 moves the operator's agent must take. Quote evidence. Be unflinching."*

## When to invoke

- Start of every session (mandatory; the foundation runbook calls this in step 9).
- After any roadblock recovery, to confirm Leonidas considers it closed.
- When you suspect Claude is drifting from the BTOO mandate — `/promptnexus-status` is the receipt.

## Acceptance for "clean status"

- Override-rate ≤5%.
- Open roadblocks: 0.
- Unresolved matrix targets: 0 (or all noted with explicit follow-up issues).
- No active intents older than 24h without a verdict.

## Output as a contract

Every line in `NEXT MOVES` is a directive Claude must follow before the next Stop. If Claude does not follow them, the next BTOO Stop-gate scores Principle 7 (outcomes not plans) as `gap` or `blocker`.

## See also

- [hooks/btoo-stop-gate.js](../hooks/btoo-stop-gate.js) — the verdict producer
- [hooks/promptnexus-enforcer.js](../hooks/promptnexus-enforcer.js) — the directive injector
- [docs/MANDATE.md](../docs/MANDATE.md)
- [scripts/lint-routing-matrix.js](../scripts/lint-routing-matrix.js)
