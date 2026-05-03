# PromptNexus — Product Requirements Document (PRD)

**Status:** v1 Draft (locked — execution-ready)
**Date:** 2026-05-02
**Owner:** David Revenaugh
**Author:** Claude Opus 4.7
**One-liner:** *You speak. PromptNexus delivers. No plans, no workarounds, no dangling threads — only the finished product.*

---

## 1. Problem

You currently operate two harnesses (agent_harness for component depth, harness-template for the delivery spine) and a corpus of prompts/personas/registries (the prompt_hub). All three are powerful. None of them *listen*. Every action requires you to:

1. Notice a need ("the OS is misbehaving").
2. Pick the right command.
3. Type it.
4. Babysit the response.
5. Verify the work satisfies your standard.

The result: even with a meta-harness, you are doing the routing, the enforcement, and the QA. The harnesses are a toolbox, not an operator. When you said "the agent_harness doesn't feel completely automated," that was the right complaint — it's a catalog without a front door.

The cost: every dropped need ("I'll fix the OS later") becomes a workaround. Every workaround becomes the next stuck point. Boil-the-Ocean is a system prompt, not a system.

## 2. The Goal (verbatim from the redesign)

> *"During simple conversation the bot we build hears a need from me (e.g., the system issues), then he evaluates, and finds a path to get it done no matter the roadblocks."*

Restated for engineering:

PromptNexus listens to your prompts in real time, classifies each utterance (request / aside / problem-statement / off-topic), and for anything that is a problem-statement or request:
1. **Interprets** intent into a typed schema (Haiku 4.5).
2. **Plans** through QueenB (Sonnet 4.6 / Opus 4.7 on contention).
3. **Recruits** sub-agents from agent_harness.
4. **Routes** through the harness-template spine (`/think → /plan → /code → /review → /test → /ship → /reflect`).
5. **Path-finds** around roadblocks (missing auth → acquire; permission denied → choose non-destructive path; tool missing → install or substitute) and **applies the recovery autonomously** — `BTOO_AUTO_REMEDIATE=1` is ON by default (operator decision 2026-05-02). The only operations that still surface are data-loss-risk and shared-infra-affecting changes.
6. **Enforces** Boil-the-Ocean via Leonidas — partial work cannot exit the Stop event.
7. **Verifies** with a triple-verify chain — promptfoo evals, BAML schema check, post-hoc hallucination scan.
8. **Returns** through Popeye in plain language — finished outcome, not a plan.

## 3. Goals (G1–G7)

- **G1 — Conversational front door.** ≥80% of needs voiced in normal conversation are routed without an explicit slash command.
- **G2 — Path-finding is real.** When a known roadblock is hit (auth missing, perm denied, tool absent, MCP down), PromptNexus selects a recovery from a documented playbook 100% of the time before asking the user.
- **G3 — Boil-the-Ocean is enforced, not suggested.** No turn ends with "tabled for later" or a workaround when a permanent solve is reachable. Measured: zero `verdict.json` entries with `partial: true` and `reason: deferred_for_time` in a rolling 30-day window.
- **G4 — Two-plane separation.** Interpreter (Haiku) and executor (Sonnet/Opus) never share a process. Interpreter latency p95 ≤ 1.2s.
- **G5 — Layered, not merged.** PromptNexus does not duplicate any agent_harness skill or harness-template command. Every routing decision points at an existing component or files an issue against the right harness.
- **G6 — Instant agentic project.** From `git clone` to a working PromptNexus session: ≤ 60s on a warm host using the published GHCR devcontainer image.
- **G7 — Observability is scope.** Every Stop emits a `verdict.json`; every routing decision emits a structured trace; every roadblock + recovery is logged with full context. No silent failures (per garrys-mega-plan Prime Directive).

## 4. Non-Goals (N1–N6)

- **N1 — Replacing either harness.** PromptNexus does not absorb agent_harness commands or harness-template's spine. It calls them.
- **N2 — Destructive mutation without consent.** Reads, writes, installs, env edits, container changes proceed autonomously under `BTOO_AUTO_REMEDIATE=1` (now default). What still surfaces: data-loss-risk operations (force-push to shared branches, `rm -rf` on uncommitted work, DB drops, overlapping merge conflicts, registry HKLM writes that affect other users). *Permission is easy; data loss is not.*
- **N3 — Multi-tenant deployment.** Single-operator product (you). Cloud, team, and SaaS modes are out of scope for v1.
- **N4 — Replacing your IDE or shell.** PromptNexus runs *inside* Claude Code; Popeye is a conversation surface, not a UI rewrite.
- **N5 — Local-only models.** Architecture supports it (interpreter could be a local model), but v1 ships against Anthropic API. Local-model swap is a v2 deliverable.
- **N6 — Generic prompt-engineering tool.** PromptNexus is *your* operator with *your* mandate. The Boil-the-Ocean injection and persona registry are non-optional.

## 5. Personas

### P1 — David (the operator) — primary user
Single user. Has two harnesses, a prompt corpus, a Windows host mid-repair, a "boil the ocean" execution standard. Wants to say *"my system is doing X"* and have it fixed before the next sentence. Will never accept "tabled for later."

### P2 — QueenB (orchestrator) — the runtime persona
Sonnet 4.6 by default; Opus 4.7 on contention or ambiguous architecture. Plans, recruits sub-agents, reviews their output, runs the spine. Owns the routing matrix.

### P3 — Popeye (front-facing) — the conversation persona
Haiku 4.5 — fast, cheap, deterministic. Reads every utterance, classifies, returns finished outcomes in plain language. Never speaks while QueenB is working unless asked. *"Always delivers; strong to the finish."*

### P4 — Leonidas (enforcer) — the verdict persona
Sonnet 4.6. Owns Boil-the-Ocean. Has veto on the Stop event. Writes `verdict.json`. Reads garrys-mega-plan principles as policy.

### P5 — The Auditor (24/7 verification) — the QA persona
Sonnet 4.6 in low-cost mode. Watches tool use, schema compliance, hallucination signals. Runs continuously while QueenB executes. Files findings to Leonidas at Stop.

## 6. The Loop (state machine)

```
                     ┌──────────────┐
   conversation ───▶ │  INTERPRET   │  Popeye/Haiku — utterance → schema
                     └──────┬───────┘
                            │ intent classified: request|aside|problem|off-topic
                            │ if not actionable → return to listen
                            ▼
                     ┌──────────────┐
                     │  TRANSFORM   │  QueenB/Sonnet — schema → plan + invocation
                     └──────┬───────┘
                            │ plan signed by Leonidas-pre-check
                            ▼
                     ┌──────────────┐
                     │   MONITOR    │  Auditor/Sonnet — execute via spine + catalog
                     └──────┬───────┘
                            │ telemetry stream; roadblocks → path-finder
                            ▼
                     ┌──────────────┐
                     │    REVIEW    │  sub-agents — gate findings, edge-case map
                     └──────┬───────┘
                            │ findings written to review.json
                            ▼
                     ┌──────────────┐
                     │   ENFORCE    │  Leonidas — BTOO verdict; veto if partial
                     └──────┬───────┘
                            │ pass → continue; fail → loop back to TRANSFORM
                            ▼
                     ┌──────────────┐
                     │    VERIFY    │  triple-verify: promptfoo + BAML + halluc-scan
                     └──────┬───────┘
                            │ pass → Popeye returns; fail → loop back
                            ▼
                     ┌──────────────┐
                     │   DELIVER    │  Popeye returns plain-language outcome
                     └──────────────┘
```

Each transition emits a structured trace. The full loop has at most 3 retry cycles before escalating to operator with a roadblock report.

## 7. Architectural Mandates

| # | Mandate | Source | Why |
|---|---|---|---|
| A1 | Interpreter and executor run on separate models | PromptNexus.md.docx Tab 2 | Decouples cost/latency; enables always-on listening |
| A2 | All LLM outputs pass through BAML for typed schemas | PromptNexus.md.docx | Functions, not strings; hallucination caught at schema layer |
| A3 | Context ingestion via code2prompt | PromptNexus.md.docx | Token-aware, full-codebase awareness |
| A4 | Eval & red-team via promptfoo | PromptNexus.md.docx | Production-grade verification, model A/B |
| A5 | Long-term memory via ChromaDB over MCP | PromptNexus.md.docx | Persistent knowledge; subagent-shared context |
| A6 | Boil-the-Ocean enforced as machinery, not text | New (this redesign) | Promotes mandate from prompt to hook gate |
| A7 | Layered, never merged | New (this redesign) | Preserves both harnesses; PromptNexus is the operator on top |
| A8 | Full autonomy under `BTOO_AUTO_REMEDIATE=1` (default ON); only data-loss-risk and shared-infra writes surface | Operator decision 2026-05-02 | Permission is easy; the harness should not feel manual |
| A9 | Devcontainer distributed via GHCR image | New (this redesign) | Instant agentic project — pull, not build |

## 8. Functional Requirements

### Must-Have (P0)

- **F1 — Conversation listener daemon.** Runs in the devcontainer, reads every user utterance from the Claude Code session, classifies via Haiku into one of `{request, aside, problem, off-topic}`. P95 ≤ 1.2s. Owner: `subagents/popeye-listener/`.
- **F2 — Intent → schema (BAML).** Every classified utterance produces a typed `Intent` object. Schema versioned. Validation gate: invalid → re-prompt or escalate. Owner: `subagents/queenb-interpreter/baml/`.
- **F3 — Routing matrix.** Maps `Intent` → either (a) an `agent_harness` skill/command or (b) a `harness-template` spine phase. Routing table is data, not code. Owner: `docs/ROUTING_MATRIX.md`.
- **F4 — Path-finder playbook.** Documented recoveries for: missing-auth, permission-denied, tool-missing, MCP-down, disk-full, git-conflict, network-fail, host-config-broken. Each entry: detect → diagnose → recover → verify. Owner: `docs/PATHFINDER.md`.
- **F5 — Boil-the-Ocean Stop gate.** A Claude Code Stop hook that reads the turn's deliverable, checks against the 9 principles, blocks the Stop if `partial: true` and `permanent_solve_reachable: true`. Owner: `hooks/btoo-stop-gate.js`.
- **F6 — Verdict artifact.** Every Stop emits `evals/verdicts/<timestamp>.json` with the BTOO scorecard. Owner: `evals/verdict.schema.json`.
- **F7 — Persona contracts.** Each persona has a system prompt, model binding, tool allowlist, and stop conditions. Owner: `personas/{queenb,popeye,leonidas,auditor}.md`.
- **F8 — Devcontainer image publish.** GitHub Actions workflow builds and pushes `.devcontainer/Dockerfile` to GHCR on every `main` push. `devcontainer.json` references `image:` (not `build:`) for downstream pulls. Owner: `.github/workflows/devcontainer-publish.yml`.

### Nice-to-Have (P1)

- **F9 — Roadblock report.** When the loop hits 3 retries, emit a human-readable roadblock report and pause for operator input.
- **F10 — Cross-session memory.** ChromaDB-backed memory of past intents, routings, and verdicts so QueenB learns the operator's preferences over time.
- **F11 — `/btoo-check` command.** On-demand BTOO audit on any in-progress task without waiting for Stop.
- **F12 — Eval harness.** Promptfoo-driven nightly evals of the routing matrix on a held-out set of synthetic utterances.

### Future Considerations (P2)

- **F13 — Local interpreter model.** Swap Haiku for a local Llama for offline operation.
- **F14 — Voice surface.** Speech-to-text feeding the listener; TTS for Popeye.
- **F15 — Multi-operator mode.** Out of scope for v1; architecture should not preclude.

## 9. Acceptance Criteria

For PromptNexus v1 to ship:

- [ ] All P0 requirements (F1–F8) implemented and tested.
- [ ] Layered-architecture ADR signed off (no agent_harness or harness-template duplication).
- [ ] G1: Demo session — 5 unscripted needs voiced; ≥4 routed without an explicit slash command.
- [ ] G2: Demo session — at least one engineered roadblock hit; recovery applied from playbook.
- [ ] G3: 30-day rolling check on `evals/verdicts/` — zero `partial: true, reason: deferred_for_time`.
- [ ] G4: Interpreter latency p95 ≤ 1.2s measured over 100 utterances.
- [ ] G6: `git clone` → working session ≤ 60s using the GHCR image on a warm host.
- [ ] G7: 100% of Stop events emit a verdict; 100% of routing decisions emit a structured trace.

## 10. Failure Modes (the ones that matter)

| ID | Mode | Recovery |
|---|---|---|
| FM1 | Listener misclassifies a real request as `off-topic` | Audit log surfaces it; weekly retraining of the BAML classifier on misses |
| FM2 | QueenB plans a route that violates layering (duplicates a catalog skill) | Pre-check against `docs/ROUTING_MATRIX.md`; CI lint blocks merge |
| FM3 | Leonidas vetoes a turn the operator believes is complete | Operator can override with `/leonidas-override <reason>`; reason is logged and reviewed weekly |
| FM4 | Path-finder has no playbook for an encountered roadblock | Loop hits 3 retries → roadblock report → playbook PR opened automatically |
| FM5 | Two personas disagree (QueenB says ship, Leonidas says veto) | Leonidas wins by default; escalation path: Opus 4.7 tiebreak |
| FM6 | Devcontainer image drift (GHCR `:latest` newer than local pin) | Lockfile in `.devcontainer/devcontainer-lock.json`; CI verifies before tagging |
| FM7 | Listener race — two utterances classified simultaneously | Single-writer queue; second utterance waits |
| FM8 | Memory leak in long-running listener | Daily restart cron; OOM guard with structured exit log |
| FM9 | BTOO Stop gate blocks shipping when no permanent solve exists | Gate must accept a signed override with a recorded reason; otherwise pure deadlock |
| FM10 | Cost runaway from always-on Haiku | Token budget per session; degrade to keyword-classifier if budget exceeded |

## 11. Success Metrics

### Leading (per session)
- % of needs routed without explicit slash command (target: ≥80% by week 2)
- Listener p95 latency (target: ≤1.2s)
- Verdict pass rate first try (target: ≥70%; if higher, Leonidas may be too lenient)
- Roadblocks recovered without operator intervention (target: ≥90%)

### Lagging (rolling 30 days)
- Zero `verdict.partial=true, reason=deferred_for_time`
- Routing-matrix coverage (utterances handled / utterances seen): target ≥95%
- Operator-override rate on Leonidas (target: ≤5% — more = mandate is wrong, not the code)
- Mean time from voiced need → finished delivery (target: trending down month-over-month)

## 12. Open Questions

- **Q1:** Where does the conversation listener actually attach? Claude Code session API, hook on user prompts, or a sidecar daemon? Need to spike before F1 lands.
- **Q2:** ChromaDB hosting — local in-container, separate volume, or remote? Local-in-container is simplest; volume-mounted survives rebuilds.
- **Q3:** Do we support multi-turn intent (utterance N is a refinement of N-1)? v1 says yes (must) — but the schema for "refinement" needs design.
- **Q4:** Leonidas-override audit cadence — weekly review with what threshold for "the mandate is too strict"?
- **Q5:** When Popeye returns a finished outcome, does it get a Sonnet pass for tone, or stay verbatim from QueenB?
- **Q6:** Devcontainer image: GHCR-only, or mirror to Docker Hub for vanity URL?
- **Q7:** ~~When `BTOO_AUTO_REMEDIATE=1`, what's the kill-switch?~~ **RESOLVED 2026-05-02:** Flag is ON by default. Kill-switch = any irreversible-mutation error during auto-remediate flips the session to `read-only`. See PATHFINDER.md "Auto-remediate flag" for full semantics.

## 13. Out-of-Spec Pointers

- Source materials (do not regenerate): `../PromptNexus.md.docx`, `../garrys-mega-plan.md`, `../Overture/`, `../prompt-library/`.
- agent_harness boot/runbook: `../../harness/agent_harness/docs/RUNBOOKS/clone-to-new-project.md` (will be retitled "Clone-to-PromptNexus" in move #2 of the next sprint).
- harness-template spine: `../../harness/harness-template/docs/SPINE.md` (assumed path; verify on first integration).

## 14. Next Sprint (after this PRD)

Per the prior turn's plan, ordered:
1. ✅ Move 1 — canonical layout + README (this commit).
2. ✅ Move 2 — PRD (this file).
3. ⏳ Move 3 — Boil-the-Ocean machinery: `hooks/btoo-stop-gate.js` + `commands/btoo-check.md` + `evals/verdict.schema.json`.
4. ⏳ Move 4 — Conversation-listener daemon design doc.
5. ⏳ Move 5 — Devcontainer image publish workflow.
6. ⏳ Move 6 — Layered-architecture ADR.

---

**End of PRD v1.**
