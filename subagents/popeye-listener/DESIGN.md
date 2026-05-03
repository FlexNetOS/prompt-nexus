# Popeye Conversation Listener — Design Doc

**Status:** Design (no runtime yet — Move 4 of the locked plan).
**Owner:** Popeye persona (Haiku 4.5).
**Goal:** Read every operator utterance in the Claude Code session in real time, classify, and hand the typed Intent to QueenB.

---

## 1. Problem

PromptNexus's defining capability — *hearing needs in conversation without an explicit slash command* — depends on a listener that runs *between* the operator typing and Claude Code's normal prompt-handling. The current Claude Code architecture does not expose a first-class "intercept every prompt" event. Three candidate attach points exist; we need to pick one for v1 and design around it.

## 2. Candidate attach points

### Option A — UserPromptSubmit hook (preferred for v1)

Claude Code emits a `UserPromptSubmit` event when the operator submits a prompt. Hooks bound to this event run *before* the assistant responds and can:
- Inspect the prompt text.
- Inject additional context.
- Block the prompt with an exit-2 (rare; not desired here).
- Exit 0 to allow normal flow.

**Pros:**
- First-class, documented, supported.
- Synchronous — runs before Claude responds, so classification happens at the right moment.
- Cheap — a Haiku call costs <$0.001 per utterance.

**Cons:**
- Adds latency to every turn (target: <1.2s p95 — within Haiku's envelope).
- Cannot read prior turns' tool outputs (only the new prompt + system context).

**Verdict for v1: USE THIS.**

### Option B — Sidecar daemon listening over Claude Code session API

Run a long-lived Node process inside the devcontainer that subscribes to the Claude Code session via its (currently undocumented) WebSocket / IPC interface. Tail conversation in real time.

**Pros:**
- Can see assistant responses too (full conversation context).
- Persists across turns; can do warm-cache classification.

**Cons:**
- Relies on undocumented surface — fragile across Claude Code versions.
- Process lifecycle headaches (start, restart, OOM).
- More complex.

**Verdict for v1: defer to v2** when the API stabilizes.

### Option C — MCP server with a `prompt_classify` tool

Expose classification as an MCP tool. The assistant calls it explicitly. Operator never touches it.

**Pros:**
- Clean MCP integration.
- Reusable across other harnesses.

**Cons:**
- Requires the assistant to *choose* to call it — defeats "no explicit slash command" goal.
- Round-trip costs more than a hook.

**Verdict for v1: rejected** — solves a different problem (on-demand classification, not always-on).

## 3. v1 architecture (UserPromptSubmit hook)

```
┌─────────────────────────────────────────────────────────────┐
│  Operator types in Claude Code session                      │
│                          │                                  │
│                          ▼                                  │
│  Claude Code emits UserPromptSubmit event                   │
│                          │                                  │
│                          ▼                                  │
│  hooks/prompt-listener.js (this hook)                       │
│   ├─ Read prompt + last 5-turn rolling history from         │
│   │  evals/listener-history.jsonl                           │
│   ├─ Call Haiku 4.5 with the Intent BAML schema             │
│   ├─ Validate the response against intent.baml              │
│   ├─ Append to evals/intents/<turn>.json                    │
│   └─ Inject summary into the assistant's context as a       │
│      system note: "INTENT: <type> · <scope_hint> · <summary>│
│                          │                                  │
│                          ▼                                  │
│  Claude Code runs the assistant (QueenB / Sonnet)           │
│  QueenB reads INTENT note, routes via ROUTING_MATRIX.md     │
└─────────────────────────────────────────────────────────────┘
```

## 4. Latency budget (target p95 ≤ 1.2s)

| Step | Budget |
|---|---|
| Hook bootstrap (Node startup, env resolve) | 50ms |
| Read 5-turn history from disk | 20ms |
| Haiku 4.5 call (small prompt, small response) | 800ms p95 |
| BAML schema validation | 30ms |
| Write intent file + inject context | 50ms |
| **Total p95** | **~950ms (margin: 250ms)** |

If the budget is breached three times in 5 minutes, the listener degrades to keyword-based classification (rule-based fallback in `classifier-fallback.js`) and surfaces the breach to the operator.

## 5. Intent schema (BAML)

See [intent.baml](intent.baml) — typed schema with strict validation.

## 6. Failure modes

| ID | Mode | Recovery |
|---|---|---|
| L1 | Haiku timeout | Fallback to keyword classifier; flag in `audit.json` |
| L2 | BAML validation fails | Re-prompt Haiku once; if still invalid, classify as `aside` (safe default) |
| L3 | History file corrupt | Truncate, re-create empty; operator notified |
| L4 | Cost runaway (Haiku > daily budget) | Degrade to keyword classifier; surface breach |
| L5 | Listener crashes | UserPromptSubmit hook exits 0 on any error — never blocks Claude Code |
| L6 | Race — two utterances classified simultaneously | Single-writer queue; second waits (UserPromptSubmit is sync, so this should not occur in practice) |

## 7. Cost ceiling

- Haiku 4.5 input: ~500 tokens (prompt + history + schema). ~$0.00007 per call.
- Haiku 4.5 output: ~50 tokens. ~$0.0000175 per call.
- Per-utterance cost: ~$0.00009.
- Daily budget at 200 utterances/day: ~$0.018. Negligible.

## 8. Implementation order

1. **`subagents/popeye-listener/intent.baml`** — schema (this turn).
2. **`subagents/popeye-listener/classifier-prompt.md`** — Haiku system prompt + few-shot examples.
3. **`subagents/popeye-listener/classifier-fallback.js`** — keyword-based fallback (covers L1, L4).
4. **`hooks/prompt-listener.js`** — the UserPromptSubmit hook. Reads stdin (the prompt), runs classification, writes intent file, injects context.
5. **`subagents/popeye-listener/intent-history.jsonl`** — rolling history; rotated daily.
6. **Test:** synthetic 50-utterance corpus, target ≥90% classification accuracy.

This is the v1.0 ship list. v1.1 adds Option B (sidecar daemon) when the Claude Code session API stabilizes.

## 9. Open questions

- **L7:** Should the injected INTENT context be visible to the operator (e.g. as a system note in the chat UI)? **Lean: yes** — transparency.
- **L8:** Should classification be cached for verbatim-repeated utterances? **Lean: yes, 5-min TTL**, dropped on session restart.
- **L9:** When classification flips between turns ("aside" → "request" within 2 turns), do we silently re-route, or surface the change? **Lean: surface** — the operator should know if Popeye changed his mind.
