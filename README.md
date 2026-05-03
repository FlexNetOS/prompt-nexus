# PromptNexus

> **You speak. PromptNexus delivers. No plans, no workarounds, no dangling threads — only the finished product.**

PromptNexus is the always-listening operator that hears a need in normal conversation, evaluates intent, recruits the right harness and agents, enforces the Boil-the-Ocean mandate, and only stops when the work is decisively done.

## Layered Architecture

PromptNexus does not replace either harness. It sits **on top** of them.

```
┌────────────────────────────────────────────────────────────────┐
│  PromptNexus (this repo) — the operator                        │
│  Conversation → Intent → Plan → Spine invocation → Verify      │
│  Personas: QueenB (orchestrator) · Popeye (front) · Leonidas   │
│  Models: Haiku 4.5 (interpreter) · Sonnet 4.6 / Opus 4.7 (work)│
└──────────────────────────────┬─────────────────────────────────┘
                               │ delegates pipeline phases to
              ┌────────────────┴────────────────┐
              ▼                                 ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│  harness-template — the spine│   │  agent_harness (ECC)         │
│  /think→/plan→/code→/review→ │   │  the catalog                 │
│  /test→/ship→/reflect        │   │  agents · skills · commands  │
│  Multi-Claude fan-out        │   │  hooks · rules · MCP configs │
│  github.com/FlexNetOS/       │   │  v2.0.0-rc.1                 │
│  harness-template            │   │                              │
└──────────────────────────────┘   └──────────────────────────────┘
```

- **agent_harness (ECC):** *catalog.* 48 agents, 189 skills, 68 commands, hook fabric. Component depth.
- **harness-template:** *spine.* Phase-ownership pipeline with multi-Claude fan-out per phase.
- **PromptNexus:** *operator.* Translates conversation into spine invocations and component selection.

Never merge. Never fork. Layer.

## The Loop

**Interpret → Transform → Monitor → Review → Enforce → Verify → (repeat as needed)**

| Phase | Owner | Output |
|---|---|---|
| Interpret | Popeye (Haiku) | Schema-validated intent + extracted goals |
| Transform | QueenB (Sonnet/Opus) | Plan + harness/spine invocation contract |
| Monitor | The Auditor (Sonnet) | Execution telemetry, drift detection |
| Review | Sub-agents (Sonnet) | Gate findings, edge-case map |
| Enforce | Leonidas (Sonnet) | Boil-the-Ocean verdict — pass/fail |
| Verify | Triple-verify chain | Final delivery confirmation |

## Personas

- **QueenB** — primary orchestrator. Plans. Recruits. Reviews final outputs.
- **Popeye** — user-facing. Translates conversation, returns finished work.
- **Leonidas** — enforcer. Owns Boil-the-Ocean. Has veto.
- **The Auditor** — 24/7 verification subagent. Tool-use compliance, hallucination detection.

See [personas/](personas/).

## Model Routing

- **Haiku 4.5 (`claude-haiku-4-5-20251001`)** — interpreter, conversation listener, structured-output classification, deterministic routing. Cheap, fast, always on.
- **Sonnet 4.6 (`claude-sonnet-4-6`)** — workhorse for planning, sub-agent execution, code work, review.
- **Opus 4.7 (`claude-opus-4-7`)** — reserved for hard reasoning, ambiguous architecture calls, Leonidas verdicts under contention.

Interpretation runs on a separate model from execution — Tab 2 architectural mandate.

## Boil-the-Ocean Mandate (canonical)

Stored at [docs/MANDATE.md](docs/MANDATE.md). Enforced by:
- `hooks/btoo-stop-gate.js` — blocks the Stop event when work is partial.
- `commands/btoo-check.md` — on-demand audit against the 9 principles.
- `evals/verdict.schema.json` — every Stop emits a `verdict.json`.

The marginal cost of completeness is near zero with AI. Do the whole thing.

## Devcontainer Distribution

- Image: `ghcr.io/flexnetos/prompt-nexus-devcontainer:latest`
- First clone pulls the image (~30s) instead of building (~5min). Goal: *instant agentic project*.
- Build pipeline: `.github/workflows/devcontainer-publish.yml` (TODO).

## Status

| Move | Status |
|---|---|
| 1. Canonical layout + README | ✅ done (this file) |
| 2. PRD | ✅ done (see [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md)) |
| 3. Boil-the-Ocean machinery (hook + command + verdict schema) | ⏳ next |
| 4. Conversation-listener daemon design doc | ⏳ next |
| 5. Devcontainer image publish workflow | ⏳ next |
| 6. Layered-architecture ADR | ⏳ next |

## Source materials

- `../PromptNexus.md.docx` — original spec (extracted into PRD)
- `../garrys-mega-plan.md` — review-mode methodology (sourced into BTOO machinery)
- `../Overture/`, `../prompt-library/`, `../prompts/`, `../links/`, `../.sixth/` — seed corpus
- `../codex_app_update.md`, `../prompt_temp.md` — supplementary context

## Repos

- agent_harness (ECC): `~/AI-Workspace/_projects/harness/agent_harness/`
- harness-template: `~/AI-Workspace/_projects/harness/harness-template/`
- PromptNexus: this directory.
