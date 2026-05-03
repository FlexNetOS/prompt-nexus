---
name: local-model-harness
description: Run, fine-tune, and serve local models (Qwen3, BitNet 1.5B) via the user's existing ai-top-utility training pipeline. Routes between cloud (Anthropic API) and local (Ollama / vLLM / direct PyTorch) based on cost, privacy, and latency. Wires the trainer at ai-top-utility/model-training-prep/training/train.py.
model: claude-sonnet-4-6 (orchestration) · local (inference)
status: v1
---

# local-model-harness

The user has a TRX50-AI-TOP box with 2× RTX 5090 (1,150W combined TDP), Threadripper PRO 7965WX, 256GB DDR5. That hardware is wasted if PromptNexus only ever calls the Anthropic API. This skill turns the local rig into a first-class compute provider for PromptNexus.

## Inventory (auto-discovered at session start)

| Asset | Location | Status check |
|---|---|---|
| `train.py` (Qwen3 / Qwen2.5-Coder LoRA) | `~/AI-Workspace/ai-top-utility/model-training-prep/training/train.py` | exists |
| Conda env (NVIDIA path, Python 3.12, CUDA 13.0, PyTorch 2.11) | created by `ai-top-utility/.../install-scripts/3_conda_2404.sh` | conda env list |
| Conda env (AMD path, ROCm 6.4) | `amd_4_conda_2404.sh` | conda env list |
| AI TOP Utility 4.2.1 daemon | `gigabyte-ai-top-utility` apt package | systemctl status |
| `ai-training-optimize.sh` (kernel + GPU tuning) | `model-training-prep/configs/ai-training-optimize.sh` | run with `status` arg |
| Ollama (optional, fast local serve) | port 11434 | `curl localhost:11434/api/version` |
| vLLM (optional, batched inference) | port 8000 (clashes with chroma — use 8001) | env `VLLM_PORT` |

## Models supported

| Model | Size | Use case | Source |
|---|---|---|---|
| `qwen3:8b` | ~16GB BF16 | General reasoning, tool use, fast | HF Hub `Qwen/Qwen3-8B` |
| `qwen3:32b` | ~64GB BF16 | Heavier reasoning across both 5090s | HF Hub `Qwen/Qwen3-32B` |
| `qwen2.5-coder:7b` | ~14GB BF16 | Code synthesis (already in train.py) | HF Hub `Qwen/Qwen2.5-Coder-7B-Instruct` |
| `bitnet:1.5b` | ~3GB INT (1.58-bit) | Token-cheap classification, deterministic | Trained locally via `train.py --model bitnet` |
| (User's choice) `qwen3-fine-tuned` | as trained | Domain-specific PromptNexus operator model | LoRA output of `train.py` |

The user mentioned "Qwen 3.6" — the actual model name as of 2026-05 is `Qwen3` family (Qwen3-8B / 32B / 235B). Routing this skill to the closest available variant.

## Routing — when to use local vs cloud

| Condition | Route |
|---|---|
| Operator privacy flag set on the turn | local-only (no cloud) |
| Token budget exceeded for the day | local-only |
| Latency-critical (< 200ms target) | local Ollama/Qwen3-8B |
| Heavy reasoning, multi-step plan | Anthropic Sonnet 4.6 (cloud) |
| Tiebreak / contention | Opus 4.7 (cloud) — reserved |
| Routine classification (Popeye-class) | local BitNet 1.5B if trained, else Haiku 4.5 |
| Training-job orchestration (queueing, monitoring, hyperparameter tuning) | local Qwen2.5-Coder-7B + AI TOP daemon |

## Trainer launcher

`scripts/launch-trainer.sh` wraps `ai-top-utility/model-training-prep/training/train.py`:

```bash
bash scripts/launch-trainer.sh --model qwen3 --epochs 3 --lr 2e-4 --batch 4
bash scripts/launch-trainer.sh --model coder --epochs 5 --lr 1e-4 --batch 2
bash scripts/launch-trainer.sh --model bitnet --epochs 2 --lr 5e-5 --batch 8 --ctx 2048
bash scripts/launch-trainer.sh --dry-run --model qwen3       # validate config, no training
```

The launcher:
1. Verifies `ai-training-optimize.sh status` shows the system is tuned (575W TDP locked, kernel.swappiness=10, etc.). If not, applies it.
2. Sources the conda env (`miniforge3` activated to the correct env per CUDA/ROCm path).
3. Invokes `train.py` with the LoRA hyperparameters.
4. Streams loss/metric output to a TUI + writes structured logs to `evals/training/<run_id>/`.
5. On completion, optionally registers the resulting LoRA adapter with Ollama (`ollama create promptnexus-qwen3 -f Modelfile`).

## Inference adapter

`memory/local-model-client.js` (companion to `memory/client.js`) provides:

```js
const local = require('../memory/local-model-client');
const reply = await local.complete({
  model: 'qwen3:8b',
  prompt: '...',
  system: '...',
  max_tokens: 1024,
  temperature: 0.7
});
```

Falls back to cloud automatically if Ollama is unreachable.

## Cost & priorities

- Local inference is essentially free (electricity only).
- Cloud inference is metered.
- The skill prefers local for everything that fits the hardware budget; reserves cloud for heavy reasoning, tiebreaks, and operator-explicit "use Sonnet" overrides.

## Open questions

- **L1:** Should the BitNet 1.5B be trained on the user's *own* prior conversation transcripts (privacy-preserving operator model)? Strong yes — that's the personalization win. Lands in v1.1 once memory_palace has 30+ days of intent/verdict data.
- **L2:** vLLM vs Ollama for serving Qwen3? vLLM is faster for batched inference, Ollama is simpler ops. Default Ollama; switch to vLLM if throughput matters.
- **L3:** Model versions move fast — we pin in `~/.local/share/ollama/models/<sha>` and update via cron.

## Implementation status

v1 — skill contract + launcher script + inference adapter shim. Real Ollama / vLLM integration lands when the foundation is up and the user runs `ollama serve` on the host (one command).
