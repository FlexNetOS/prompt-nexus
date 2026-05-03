---
name: cross-llm-council
description: Convene a council of LLM "friends" (OpenAI Codex, Google Gemini, Moonshot Kimi) to break ties, validate ambiguous decisions, or brainstorm under uncertainty. Routes through MCP-configured providers; falls back gracefully when API keys are missing. Stores transcripts in council_sessions Postgres table.
model: claude-sonnet-4-6 (synthesis) · external (voices)
status: v1
---

# cross-llm-council

When QueenB hits a contested architecture decision, an ambiguous routing call, or needs a sanity check on a Boil-the-Ocean verdict, she convenes the council.

## Voices

| Voice | Provider | Strength | When to consult |
|---|---|---|---|
| **Codex** | OpenAI gpt-5-codex (or current SOTA) | Code synthesis, refactor judgment, language-specific patterns | Architectural choices that hinge on code feasibility |
| **Gemini** | Google `gemini-2.5-pro` (or current) | Long-context analysis, multimodal, Google ecosystem | Cross-document synthesis, large-codebase reasoning |
| **Kimi** | Moonshot `kimi-k2` | Long-context Chinese-language native, alternative reasoning style | Diverse-perspective tiebreaker, edge-case stress test |
| **(Local) Qwen3** | Local via Ollama / vLLM | Fast, no-API-cost, on-device | Privacy-sensitive questions, rapid sanity checks |
| **(Local) BitNet 1.5B** | Local via the user's training pipeline | Token-cheap, deterministic | Routine classification confirmations |

Claude (Sonnet) is the **chair** — synthesizes the voices, doesn't vote. Opus is reserved for hard contention; if the chair detects the voices are genuinely split, escalates to Opus 4.7 for tiebreak.

## When to convene

- A `/btoo-check` returns `gap` on principles 1, 3, 4, or 7 (the LLM-judgment principles) and Leonidas wants a second opinion before a `BLOCK` decision.
- QueenB's plan has two routing matrix rows that both look correct (e.g., a refactor that touches both `code` and `prompt` scopes).
- The path-finder has no playbook for an encountered roadblock and a recovery has to be invented (FM4 from PRD).
- Operator explicitly says *"check with the council"* or *"what would Codex say?"*

**Do NOT convene** for:
- Trivial decisions (anything one Sonnet call can handle).
- Decisions where the cost of a wrong call is < the cost of the council session.
- Stylistic preferences (taste isn't a vote).

## Convocation

QueenB writes a `CouncilQuestion`:

```yaml
question: <one-paragraph framing>
context_artifacts:
  - <relative paths to plan, PRD, code under review>
target_voices: [codex, gemini, kimi]   # subset; default = all available
synthesis_target: decision | brainstorm | tiebreak
budget_cents: 50                        # max API spend; council aborts if exceeded
deadline_seconds: 60                    # if voices haven't returned, ship with what we have
```

The skill then:

1. Reads `~/.claude/.../mcp.json` (or `.mcp.json` in the project) to find configured providers.
2. For each available voice, opens an MCP connection or HTTPS POST to the provider's API.
3. Sends the question + 3 most relevant context artifacts (compressed via `code2prompt` if > 50K tokens).
4. Collects responses with timeouts.
5. Hands all responses to the chair (Sonnet) for synthesis.

## Synthesis schema

```yaml
synthesis:
  consensus: <one-paragraph if voices agree, else null>
  divergence:
    - voice: codex
      claim: <…>
    - voice: gemini
      claim: <…>
  decision: <chair's recommendation, or "OPUS_TIEBREAK_REQUESTED" if split>
  confidence: 0.0–1.0
  cost_cents: <actual>
  duration_ms: <actual>
```

## Persistence

Every council session writes to `council_sessions` (Postgres) and indexes the synthesis into ChromaDB's `council` collection. Memory Palace adds an edge: `(turn, <turn_id>) -> consulted -> (council, <session_id>)`. Future similar questions can recall prior council outputs.

## Provider config

Each provider needs an entry in `.mcp.json` or env vars:

```bash
# OpenAI Codex
export OPENAI_API_KEY=sk-...
export OPENAI_CODEX_MODEL=gpt-5-codex   # update to current SOTA

# Google Gemini
export GOOGLE_API_KEY=...
export GEMINI_MODEL=gemini-2.5-pro

# Moonshot Kimi
export MOONSHOT_API_KEY=...
export KIMI_MODEL=kimi-k2

# Local (Ollama)
export OLLAMA_HOST=http://localhost:11434
export OLLAMA_MODELS=qwen3:8b,bitnet-1.5b
```

If a key is missing, that voice is silently dropped from the panel — never a hard failure. The chair adapts to a smaller council.

## Cost guard

- Per session budget: $0.50 default, settable per question.
- Daily cap: $5 default (configurable in `.env`).
- If the cap is hit, the council degrades to local-only voices (Qwen3 + BitNet) until the daily window rolls over.

## Implementation status

v1 — skill contract. Runtime lands when:
1. Provider MCP configs are added to `.mcp.json`.
2. The council orchestration runtime (`scripts/council-runner.js`) is written — uses Anthropic's Messages API for the chair, plus three provider-specific HTTP clients for the voices.

The skill defines the contract; the runtime is a one-screen script that reads this skill's YAML and executes.

## See also

- `agent_harness/skills/council/SKILL.md` — the original four-voice council pattern (Architect / Skeptic / Pragmatist / Critic) — orthogonal to this skill (that one is intra-Claude personas; this one is cross-LLM).
- `docs/ROUTING_MATRIX.md` — when QueenB chooses to consult, vs. when she decides solo.
