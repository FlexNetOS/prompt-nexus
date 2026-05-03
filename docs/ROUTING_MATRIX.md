# Routing Matrix — Intent → Harness Component

**Purpose:** Map every classified `Intent` to a concrete invocation in either the agent_harness catalog or the harness-template spine. **This is data, not code** — change the matrix to change routing.

**Source taxonomy:** prompt-library's 24-agent taxonomy + agent_harness command surface + harness-template spine phases.

**Layering rule:** PromptNexus never duplicates work. Every row points at an existing component. New work files an issue against the right harness.

## Intent classification (Popeye / Haiku output)

```yaml
Intent:
  type: request | aside | problem | off-topic
  content: <the utterance>
  urgency: low | normal | high | emergency
  scope_hint: ?one of [code, docs, ops, host, prompt, planning, review, test, ship, research]
  refinement_of: ?<prior turn_id>
```

## Routing rules

### A. Off-topic + Aside
**No routing.** Popeye acknowledges or stays silent. Logged for memory context only.

### B. Request — direct mapping by `scope_hint`

| scope_hint | Route to | Phase | Why |
|---|---|---|---|
| `code` | harness-template `/code` | spine | Multi-Claude fan-out per package |
| `docs` | agent_harness `/update-docs` or `/skill-create` | catalog | Doc-updater agent + skill-creator |
| `ops` | agent_harness `/runbook` (clone-to-PromptNexus) | catalog | Runbook for operational sequences |
| `host` | PromptNexus `host-environment-doctor` skill | operator | Investigation autonomous, mutation gated |
| `prompt` | PromptNexus `skills/btoo-check` + agent_harness `/skill-create` | operator + catalog | Prompt iteration with BTOO audit |
| `planning` | harness-template `/plan` (lightweight) OR agent_harness `/blueprint` (multi-PR) | spine + catalog | Pick by horizon: single PR → /plan; many PRs → /blueprint |
| `review` | harness-template `/review` | spine | Multi-specialist fan-out (security, performance, style, data-integrity) |
| `test` | harness-template `/test` (subsumes /tdd, /e2e) | spine | TDD or E2E sub-modes per memory note on the spine |
| `ship` | harness-template `/ship` (subsumes /build-fix) | spine | Conventional commit + PR + CI |
| `research` | agent_harness `/learn` + `repo-research-analyst` agent | catalog | Codebase archaeology + pattern extraction |

### C. Problem — diagnose then route

For `type=problem`, Popeye does NOT route directly. Instead:
1. QueenB invokes the path-finder ([PATHFINDER.md](PATHFINDER.md)) to diagnose.
2. Path-finder returns: `{ playbook_id, recovery_plan, mutation_required: bool }`.
3. If `mutation_required=false`, run recovery autonomously, then re-classify the resulting state.
4. If `mutation_required=true`, surface to operator unless `BTOO_AUTO_REMEDIATE=1`.

### D. Refinement (`refinement_of` is set)

Refinement of a prior turn → re-enter Loop at TRANSFORM, not INTERPRET. QueenB amends the existing plan rather than starting over.

## Specialist sub-agent recruitment (within a route)

When QueenB enters TRANSFORM and recruits sub-agents, she draws from this catalog (sourced from prompt-library + agent_harness):

| Concern | Sub-agent | Source |
|---|---|---|
| Architecture | `architecture-strategist` | prompt-library |
| Security | `security-sentinel` / `security-reviewer` | prompt-library / agent_harness |
| Performance | `performance-oracle` / `performance-optimizer` | prompt-library / agent_harness |
| Code style (lang-specific) | `compounding-{python,rails,typescript}-reviewer` / `{python,go,rust,java,kotlin,cpp,csharp,typescript}-reviewer` | prompt-library / agent_harness |
| Code simplicity | `code-simplicity-reviewer` / `refactor-cleaner` | prompt-library / agent_harness |
| Bug reproduction | `bug-reproduction-validator` / `silent-failure-hunter` | prompt-library / agent_harness |
| Data integrity | `data-integrity-guardian` / `database-reviewer` | prompt-library / agent_harness |
| Pattern recognition | `pattern-recognition-specialist` / `code-architect` | prompt-library / agent_harness |
| TDD execution | `tdd-guide` | agent_harness |
| Build error resolution | `build-error-resolver` (or language-specific) | agent_harness |
| Repo research | `repo-research-analyst` / `code-explorer` | prompt-library / agent_harness |
| Framework docs | `framework-docs-researcher` / `docs-lookup` | prompt-library / agent_harness |
| Git archaeology | `git-history-analyzer` | prompt-library |
| Spec analysis | `spec-flow-analyzer` | prompt-library |
| Best practices | `best-practices-researcher` | prompt-library |
| PR comment resolution | `pr-comment-resolver` | prompt-library |
| Editorial style | `every-style-editor` / `comment-analyzer` | prompt-library / agent_harness |
| Feedback codification | `feedback-codifier` | prompt-library |
| Multi-specialist orchestration | `code-review-coordinator` / `plan-coordinator` | prompt-library |
| End-to-end testing | `principal-qa-engineer` / `e2e-runner` | Overture / agent_harness |
| Senior engineering execution | `senior-engineer` (Opus) / `engineer` (Opus) | Overture / prompt-library |

## Coverage SLA

- ≥95% of utterances must hit a row in this matrix (PRD G5 / metric in §11).
- New intents that don't fit get a roadblock report (see PATHFINDER.md FM4) and an automated PR opening a new row.

## Update protocol

1. New row added → CI lint runs to confirm the target component exists in agent_harness or harness-template.
2. Lint failure → PR blocked; the matrix cannot point at a non-existent component.
3. Quarterly review → reconcile against agent_harness `agent.yaml` and harness-template's command list.

## Open questions

- **R1:** When prompt-library and agent_harness both offer a sub-agent for the same concern (e.g., architecture-strategist vs code-architect), which wins? Default: prefer prompt-library because of the richer specialist taxonomy. Flag for review.
- **R2:** Does the matrix support weighted routing (e.g., 70% to harness-template, 30% to agent_harness for a mixed concern)? v1: no; pick one. v2: revisit.
- **R3:** Refinement detection (rule D) — by content similarity or by explicit `refinement_of` from Popeye? v1: explicit only. v2: add similarity check.
