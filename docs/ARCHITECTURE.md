# ADR-001: Layered, Never Merged

**Status:** Accepted (revised 2026-05-03 with Substrate section)
**Date:** 2026-05-02
**Decider:** David Revenaugh (operator) + Claude Opus 4.7 (architect)
**Supersedes:** None

---

## Substrate (added 2026-05-03)

PromptNexus runs on a Windows 11 host with a layered virtualization stack. Every component must respect what's *inside* the .vhdx vs. *outside* of it; the operator hits roadblocks otherwise.

```
Windows 11 host (operator's keyboard + mouse + microphone)
└── Hyper-V (Windows hypervisor)
    └── WSL2 lightweight VM
        └── ext4.vhdx (the .vhdx — Linux disk image)
            ├── Ubuntu distro (operator's main shell, systemd=true)
            │   └── Docker Engine (running INSIDE this distro)
            │       └── promptnexus bridge network 172.19.0.0/16
            │           ├── promptnexus-postgres   :5432  (127.0.0.1 binding)
            │           ├── promptnexus-chroma     :8000  (127.0.0.1 binding)
            │           ├── promptnexus-mempalace  :8077  (127.0.0.1 binding)
            │           └── promptnexus-sqlite-web :8079  (127.0.0.1 binding)
            │
            └── docker-desktop distro (Docker Desktop's system distro)
                └── (used for daemon orchestration; not where containers run)
```

**Three reachability paths:**
1. **From the Windows host:** `localhost:<port>` — works because `wslrelay.exe` proxies to WSL2 NAT → bridge network → container.
2. **From inside Ubuntu WSL2:** `localhost:<port>` — direct (same kernel network namespace as the docker daemon).
3. **From inside a devcontainer:** the service name (`postgres`, `chroma`, `mempalace`) via Docker's embedded DNS on the bridge network.

**WSL is the path to unhindered access.** No other path is faster, more compatible, or less brittle. Hyper-V containers, Windows containers, and bare Docker for Windows are all worse.

**The disconnect** that makes Claude Code sessions hit roadblocks: the operator's Claude Code session runs on the Windows side. When Claude tries to act on host config (registry, services, BIOS, microphone permissions), it is *outside* the .vhdx. When it acts on Ubuntu config or container state, it is inside the .vhdx via the docker daemon proxy. The path-finder skill (PATHFINDER.md) encodes this division; the foundation runbook respects it.

### AI TOP runs natively, not containerized

Containers would either need `--privileged --device=/dev/nvidia*` plus host-namespace sharing (defeats isolation) or the Gigabyte daemon would silently no-op on what it can't reach. Both are worse than running natively.

The right pattern: **AI TOP Utility 4.2.1 runs natively on Ubuntu (WSL2 or bare-metal).** PromptNexus orchestrates AI TOP via `scripts/launch-trainer.sh`. The trainer launcher invokes `train.py` inside a conda env (also native, in WSL2 Ubuntu).

Containers are for the memory backend and other commodity services. The hardware-control plane stays native.

---

## Context

Three artifacts exist in the operator's workspace:

1. **`agent_harness`** (the "everything-claude-code" / ECC plugin, v2.0.0-rc.1, at `~/AI-Workspace/_projects/harness/agent_harness/`) — a meta-harness with 48 agents, 189 skills, 68 commands, a hook fabric, and pinned MCP servers.
2. **`harness-template`** (the FlexNetOS spine, at `~/AI-Workspace/_projects/harness/harness-template/`, GitHub: `FlexNetOS/harness-template`) — a slash-command pipeline (`/think→/plan→/code→/review→/test→/ship→/reflect`) with multi-Claude fan-out per phase.
3. **`PromptNexus`** (this project, at `~/AI-Workspace/_projects/prompt_hub/prompt-nexus/`) — a conversational operator that hears needs and routes work.

The temptation is to merge or fork. Both fail.

- **Merge** kills the spine's pipeline cleanliness and the catalog's component depth — neither survives intact.
- **Fork** doubles maintenance and bit-rots within a quarter.

## Decision

**Layer them.** PromptNexus calls; it never absorbs.

```
┌──────────────────────────────────────────────────────────────┐
│ LAYER 3 — OPERATOR        PromptNexus                        │
│ Conversation → Intent → Routing → Verification               │
│ Models: Haiku (Popeye) · Sonnet (QueenB/Leonidas/Auditor) ·  │
│         Opus (tiebreak)                                      │
└────────────────────────────┬─────────────────────────────────┘
                             │ delegates phases to
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ LAYER 2 — SPINE           harness-template                   │
│ /think → /plan → /code → /review → /test → /ship → /reflect  │
│ Multi-Claude fan-out (tools/spine-fanout.js)                 │
│ FlexNetOS/harness-template                                   │
└────────────────────────────┬─────────────────────────────────┘
                             │ recruits components from
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ LAYER 1 — CATALOG         agent_harness (ECC)                │
│ 48 agents · 189 skills · 68 commands · hooks · MCPs · rules  │
│ v2.0.0-rc.1                                                  │
└──────────────────────────────────────────────────────────────┘
```

**Layer 3 (PromptNexus)** owns conversation, intent, routing, and BTOO enforcement. It calls Layer 2 for pipeline phases and Layer 1 directly for component invocations not phase-shaped (e.g., `/skill-create`, `/learn`).

**Layer 2 (harness-template)** owns the delivery pipeline. Each phase is a multi-Claude fan-out. It pulls components from Layer 1 as needed.

**Layer 1 (agent_harness)** owns components. It is a registry — agents, skills, commands, hooks. It does not orchestrate; it is orchestrated.

## Rules

1. **No duplication.** A capability lives in exactly one layer. PromptNexus never re-implements an agent_harness skill or a harness-template command.
2. **Top-down call only.** Layer 3 → Layer 2 → Layer 1. Lower layers never call up.
3. **Routing matrix is the contract.** Every Layer 3 → Layer 2/1 call passes through [ROUTING_MATRIX.md](ROUTING_MATRIX.md). CI lint blocks PRs that route to nonexistent components.
4. **`agent.yaml` is the canonical export contract for Layer 1.** Skills/commands not listed there are invisible. PromptNexus reads `agent.yaml` at session start.
5. **The spine is the canonical phase contract for Layer 2.** Phases are exactly: `think, plan, code, review, test, ship, reflect`. PromptNexus does not invent new phases; it composes existing ones.
6. **Memory is per-layer.** Each layer owns its own memory:
   - Layer 1: `~/.claude/.../memory/` (agent_harness operator memory)
   - Layer 2: `harness-template/memory/` (per the spine repo's conventions)
   - Layer 3: `prompt-nexus/evals/`, `prompt-nexus/.memory/` (verdicts, audits, ChromaDB cache)
   - Memory does not flow across layers without an explicit bridge.

## Consequences

### Positive
- Each layer can evolve independently. agent_harness adds a skill → PromptNexus picks it up via the routing-matrix lint at next session.
- Failures are localized. A bad sub-agent in Layer 1 doesn't poison Layer 3's routing logic.
- Boil-the-Ocean enforcement happens once, at Layer 3's Stop-gate — no need to retrofit hooks into every harness.
- The `harness-template` spine memory note (which already says "agent_harness commands subsume into the spine") and the new ADR are mutually consistent: harness-template *consumes* agent_harness; PromptNexus *consumes* harness-template.

### Negative
- An extra hop on the call path: conversation → PromptNexus → spine → catalog. Latency budget allocates for this (Popeye ≤1.2s, total turn ≤ TBD).
- Three repos to keep in sync. Mitigated by: (a) routing-matrix lint, (b) quarterly reconciliation, (c) shared memory via ChromaDB for cross-session intent recall.
- New users must understand layering before contributing. Mitigated by this ADR + README diagrams.

### Neutral
- Future Layer 0 (a substrate, e.g. a local model server, a vector DB cluster) can slot in without changing Layers 1–3.

## Anti-patterns to reject

- **"Just inline the agent_harness skill into PromptNexus."** No — that's duplication, and the next agent_harness update overwrites your fork.
- **"Just have the spine call PromptNexus."** No — that's bottom-up routing. PromptNexus is the front door, not a service.
- **"Maintain a third merged repo with everything in it."** No — that's the merge anti-pattern; both lose their identity.
- **"Hard-code the routing in PromptNexus code."** No — the matrix is data; lint enforces it.

## Validation

This ADR is validated when:
- [ ] No PromptNexus skill duplicates an agent_harness or harness-template skill (CI check).
- [ ] No agent_harness or harness-template module imports anything from `prompt-nexus/`.
- [ ] Every routing-matrix row points at a component that exists at lint-time.
- [ ] PromptNexus startup reads `agent.yaml` and the spine's command list and reports any drift.

## References

- [README.md](../README.md) — layered architecture diagram
- [ROUTING_MATRIX.md](ROUTING_MATRIX.md) — Layer 3 → Layer 2/1 contract
- [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) — G5 (layered, not merged)
- Memory: `project_harness_slash_command_spine.md` — harness-template's spine architecture
- Memory: `project_agent_harness_*` — three notes covering ECC's boot, PRP/blueprint flow, and hook gates
- Memory: `project_prompt_nexus.md` — locked decisions for Layer 3
