---
name: btoo-check
description: On-demand Boil-the-Ocean audit of the in-progress turn against the 9 principles. Runs Leonidas's full LLM-driven check (not just the deterministic Stop-gate rules). Returns a scorecard and recommended recoveries.
model: claude-sonnet-4-6
status: v1
---

# /btoo-check — On-Demand BTOO Audit

## When to use

- Mid-turn, before Stop, to catch partial work while there's still time to fix it.
- After a `/leonidas-override` to verify the override was justified.
- After a roadblock recovery, to confirm the fix didn't break Principle 4 (loose ends).
- During code review, to score a teammate's PR against BTOO before merging.

**Do NOT use** as a replacement for the Stop-gate hook — they are complementary. The Stop-gate is fast and deterministic (rule-based). `/btoo-check` is slow and judgment-based (LLM). Run the gate every Stop; run this on demand.

## Inputs

- (Optional) A target turn_id or verdict file path. Defaults to "current turn."
- (Optional) A specific principle to audit deeply (e.g. `--principle=p3` for the no-shortcuts check).

## How it works

1. Read the current turn's commitment + delivery + auditor findings (from in-memory state or `evals/verdicts/<id>.json`).
2. Read source materials touched by the turn (the actual files changed).
3. For each of the 9 principles, run a Leonidas system-prompt audit against Sonnet 4.6:
   - Principle text (from [docs/MANDATE.md](../../docs/MANDATE.md)).
   - Commitment + delivery + audit findings.
   - File diffs (read from disk).
4. Aggregate per-principle status (pass | gap | blocker) with evidence and recovery.
5. Write `evals/verdicts/<id>-btoo-check.json` (a separate audit file from the Stop-gate verdict).
6. Return a Markdown scorecard to the operator.

## Output

```
BTOO Check — turn abc123 (2026-05-02T14:33:00Z)
═══════════════════════════════════════════════════════════════════
P1 search the ground            ✅ pass     evidence: ...
P2 build completely             ⚠️  gap      gap: 1 of 5 promised deliverables missing — `docs/PATHFINDER.md` not written
                                              recovery: write the file before Stop
P3 reject the illusion of speed ✅ pass     evidence: no shortcuts in diff
P4 leave no loose ends          ❌ blocker  gap: TODO comment left in subagents/popeye-listener/intent.baml:42
                                              recovery: resolve or open a tracking issue with deadline
P5 test like an enemy           ✅ pass     evidence: 8 tests, all pass; chaos test for OOM included
P6 documentation is supply lines ✅ pass    evidence: 3 docs updated alongside 5 files
P7 outcomes not plans           ✅ pass     evidence: deliverables match commitment
P8 total responsibility         ✅ pass     evidence: 0 disallowed tool calls
P9 decisive victory             ⚠️  gap      gap: 1 medium-severity hallucination flag (auditor)
                                              recovery: re-verify the cited file path in subagents/popeye-listener/DESIGN.md:88

DECISION: BLOCK (1 blocker, 2 gaps)
RECOVERY PATH: fix P4 first (cleanup TODO), then re-verify P9 finding, then re-run /btoo-check.
```

## Cost

- Sonnet 4.6 call with ~10K-token context per principle audit.
- Approximately 9 LLM calls per check (one per principle, parallelizable).
- Budget: a `/btoo-check` should cost <$0.20 in API tokens. If it costs more, the turn's diff is too large — split the work.

## Implementation status

v1 — slash command stub. Runtime is the `Skill` invocation that loads this `SKILL.md` and runs the audit through the Sonnet contract. Hook integration (auto-run on `/leonidas-override`) lands in v1.1.
