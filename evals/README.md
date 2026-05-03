# PromptNexus Evals

Three artifact streams live here:

| Stream | Dir | Source | Content |
|---|---|---|---|
| Verdicts | `verdicts/` | `hooks/btoo-stop-gate.js` (deterministic) and `commands/btoo-check.md` (LLM) | One file per turn. BTOO scorecard against the 9 principles. Schema: [verdict.schema.json](verdict.schema.json). |
| Audits | `audits/` | The Auditor persona (Sonnet) | Tool-compliance, hallucination, schema-violation findings per turn. Feeds into the verdict. |
| Roadblocks | `roadblocks/` | Path-finder when no playbook matches | Markdown report of un-recoverable symptoms; pairs with an auto-PR adding a new playbook entry. |

## Eval harness (planned)

Per the seed corpus's `prompts/prompt-test-framework.md` pattern, evals are run via:

1. **promptfoo** — multi-model A/B for the routing matrix and intent classification.
2. **BAML** — schema validation at the edge of every typed output.
3. **LLM-as-judge** — Leonidas (Sonnet) scores `/btoo-check` outputs against the 9 principles.

Concrete eval suites land in v1.1:
- `evals/suites/intent-classification/` — Popeye accuracy on 50 synthetic utterances.
- `evals/suites/routing-correctness/` — QueenB picks the right matrix row for known intents.
- `evals/suites/btoo-fidelity/` — Leonidas's `/btoo-check` agrees with human-labeled gold turns.

## .gitignore policy

`evals/verdicts/`, `evals/audits/`, `evals/roadblocks/` are gitignored — they are runtime artifacts. Only `verdict.schema.json` and this README ship in the repo.

## Reading a verdict

```bash
ls -t evals/verdicts | head -5      # most recent verdicts
jq '.decision, .principles' evals/verdicts/<file>.json
jq -r '.principles | to_entries[] | select(.value.status != "pass") | "\(.key): \(.value.status) - \(.value.gap_description // "")"' evals/verdicts/<file>.json
```

## Override audit (weekly cadence)

```bash
# Override rate over the last 30 days (target: ≤5%)
total=$(ls evals/verdicts/*.json | wc -l)
overrides=$(jq -s 'map(select(.decision.override_used == true)) | length' evals/verdicts/*.json)
echo "Override rate: $(( overrides * 100 / total ))%"
```

If the rate exceeds 5%, the mandate or the gate is mis-calibrated. Surface as a tuning conversation — never silently accept.
