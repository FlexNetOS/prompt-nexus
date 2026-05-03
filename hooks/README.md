# PromptNexus Hooks

Claude Code hooks that wire PromptNexus's runtime behavior into the session.

## Files

| Hook | Event | Purpose |
|---|---|---|
| `promptnexus-enforcer.js` | `UserPromptSubmit` | The enforcer. Classifies the utterance, persists to mempalace, looks up routing matrix, pulls the last verdict, **injects a `## PROMPTNEXUS DIRECTIVE` block** into Claude's context via stdout. Course-corrects on a per-turn basis. |
| `btoo-stop-gate.js` | `Stop` | Score the turn against the 9 Boil-the-Ocean principles, write `evals/verdicts/<ts>.json`, BLOCK Stop on blocker (exit 2). Override via `LEONIDAS_OVERRIDE=1`. |

## Wiring (project `.claude/settings.json`)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "node ${CLAUDE_PROJECT_DIR}/hooks/promptnexus-enforcer.js" }]
      }
    ],
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "node ${CLAUDE_PROJECT_DIR}/hooks/btoo-stop-gate.js" }]
      }
    ]
  }
}
```

PromptNexus = enforcer (entry) + Stop-gate (exit). Every turn enters through the enforcer's directive and exits through Leonidas's verdict.

## Stdin contract

The hook expects a JSON object on stdin:

```json
{
  "turn_id": "uuid-or-counter",
  "operator": "david",
  "commitment": {
    "intent_summary": "...",
    "deliverables_promised": ["..."],
    "permanent_solve_reachable": true
  },
  "delivery": {
    "files_changed": ["..."],
    "tests_run": [{"name": "...", "status": "pass|fail|skip|missing"}],
    "docs_updated": ["..."],
    "deliverables_satisfied": ["..."]
  },
  "auditor": {
    "tool_compliance": {"total_calls": 0, "disallowed_calls": 0},
    "hallucination_flags": [],
    "schema_violations": []
  }
}
```

If stdin is empty or malformed, the hook **allows** Stop and logs to stderr — it never crashes the session.

## Scoring rules (deterministic — no LLM call)

The Stop hook must be fast (<200ms typical). It scores the 9 principles using rules that can run on pure JSON:

| Principle | Rule |
|---|---|
| p1, p3, p4, p7 | Always pass at Stop; deferred to `/btoo-check` (LLM judgment) |
| p2 — build completely | All `commitment.deliverables_promised` must be in `delivery.deliverables_satisfied` |
| p5 — test like an enemy | At least one test ran; all tests pass; no required tests missing |
| p6 — documentation is supply lines | If `files_changed > 0`, then `docs_updated > 0` |
| p8 — total responsibility | `auditor.tool_compliance.disallowed_calls === 0` |
| p9 — decisive victory | No high-severity hallucinations; no schema violations |

A single `blocker` BLOCKs Stop, **unless**:
1. `LEONIDAS_OVERRIDE=1` (operator force-pass — logged).
2. `BTOO_BLOCK_COUNT >= 3` (auto-escalate to operator with roadblock report).
3. `commitment.permanent_solve_reachable === false` (no permanent solve was in scope).

**`BTOO_AUTO_REMEDIATE=1` (default in `.devcontainer/devcontainer.json`):**
- When blockers exist AND none are data-loss-risk: the hook still BLOCKs Stop (exit 2) so QueenB loops back to TRANSFORM and applies the documented recoveries automatically — without surfacing to the operator. The verdict's `decision.reason` is annotated `[auto-remediate=1; loop back to TRANSFORM and apply recoveries automatically]`.
- When blockers include data-loss-risk patterns (force-push, `rm -rf`, DB drop, `reset --hard`): the hook BLOCKs and **always surfaces** to the operator. *Permission is easy; data loss is not.*

## Override

The `/leonidas-override` slash command sets `LEONIDAS_OVERRIDE=1` and `LEONIDAS_OVERRIDE_REASON=<reason>` for the next Stop event only. Override count is logged in the verdict and surfaced weekly — see [docs/PRODUCT_REQUIREMENTS.md](../docs/PRODUCT_REQUIREMENTS.md#11-success-metrics) (override rate ≤5% target).

## Verdict output

Every Stop emits `evals/verdicts/<timestamp>-<turn_id>.json` — schema at [evals/verdict.schema.json](../evals/verdict.schema.json).

## Roadmap

- v1.1 — Add `Audit` event hook for live tool-compliance enforcement (the Auditor persona).
- v1.2 — Integrate Overture MCP for visual plan approval as a pre-Stop visual gate.
- v1.3 — promptfoo + BAML eval invocation as part of `/btoo-check` (deeper LLM-driven audit).
