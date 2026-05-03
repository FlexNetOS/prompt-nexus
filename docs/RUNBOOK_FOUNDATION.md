# Runbook — Foundation: Ubuntu → AI TOP → ChromaDB → Memory Palace

**One-shot end-to-end.** Run on the user's TRX50-AI-TOP host (WSL2 Ubuntu 24.04+ or bare-metal Ubuntu 24.04+).
**Wall-clock target:** ≤ 30 minutes on first run (NVIDIA driver + CUDA install dominates); ≤ 5 minutes on rebuild.

---

## Pre-flight — host (5 minutes, manual)

The user's box is Threadripper PRO 7965WX + 2× RTX 5090 + 256GB DDR5 + Gigabyte TRX50-AI-TOP. This runbook assumes:

- Latest BIOS already flashed (F12f from `~/AI-Workspace/ai-top-utility/bios/mb_bios_trx50-ai-top_8astp003_f12f/`).
- WSL2 with Ubuntu 24.04 LTS installed, OR bare-metal Ubuntu 24.04+.
- Operator account has passwordless `sudo` (the foundation script needs it).
- Network reachable (will pull NVIDIA repo, Docker repo, conda channels, npm, PyPI, Docker Hub, GHCR, GitHub).

If WSL2 isn't installed yet:

```powershell
# Run from PowerShell as administrator on Windows.
wsl --install -d Ubuntu-24.04
wsl --update
```

---

## Step 1 — Foundation bootstrap (one command)

```bash
cd ~/AI-Workspace/_projects/prompt_hub/prompt-nexus
bash scripts/foundation/setup-foundation.sh
```

This runs in order:

1. `apt update` + base packages (curl, git, python3, postgres-client, sqlite3).
2. NVIDIA driver + CUDA 13 via the existing `ai-top-utility/.../install-scripts/2_nvidia_driver_cuda_2404.sh`.
3. Docker Engine + Compose v2.
4. AI TOP Utility 4.2.1 from `~/AI-Workspace/ai-top-utility/gigabyte-ai-top-utility-4.2.1.deb`.
5. Kernel + GPU tuning via `ai-top-utility/model-training-prep/configs/ai-training-optimize.sh start`.
6. Memory stack: ChromaDB 0.5.20 + Postgres 17 + mempalace + sqlite-web (via `docker compose`).
7. Health checks (waits up to 90s).

Expected output ends with:

```
==> Foundation ready.
    Chroma:      http://localhost:8000
    Postgres:    localhost:5432
    Mempalace:   http://localhost:8077
    SQLite-web:  http://localhost:8079
```

If a step fails, check `/tmp/promptnexus-foundation.log`. Common failures and recoveries map to [PATHFINDER.md](PATHFINDER.md):

| Failure | Playbook |
|---|---|
| `nvidia-smi` shows no CUDA 13 after step 2 | P-TOOL-MISSING (install via the script directly) |
| Docker daemon not running | P-TOOL-MISSING (`sudo systemctl start docker`) |
| Postgres won't start in compose | P-PERM-DENIED (likely pgdata volume permissions) |
| Mempalace build failure | P-NETWORK-FAIL (upstream repo unreachable; falls back to local impl automatically) |

---

## Step 2 — Memory bootstrap

```bash
node scripts/memory-bootstrap.js
```

Creates ChromaDB collections (`intents`, `verdicts`, `roadblocks`, `council`), smoke-tests mempalace recall + edge insertion, confirms Postgres is reachable. Exits non-zero on any failure.

Expected output ends with:

```
==> Memory bootstrap complete.
```

---

## Step 3 — Validate the full stack

```bash
# From the prompt-nexus directory:
docker compose -f docker/docker-compose.memory.yml ps
curl -s http://localhost:8000/api/v2/heartbeat | jq
curl -s http://localhost:8077/health | jq
PGPASSWORD=changeme-please psql -h localhost -U promptnexus -d promptnexus -c '\dt'
sqlite3 evals/promptnexus.sqlite '.schema'    # may be empty until first verdict
```

All four should return successfully.

---

## Step 4 — Tune the system for training (optional but recommended)

The tuner was already run in Step 1. Status / re-apply:

```bash
sudo bash ~/AI-Workspace/ai-top-utility/model-training-prep/configs/ai-training-optimize.sh status
sudo bash ~/AI-Workspace/ai-top-utility/model-training-prep/configs/ai-training-optimize.sh start
sudo bash ~/AI-Workspace/ai-top-utility/model-training-prep/configs/ai-training-optimize.sh stop  # to revert
```

Settings applied (see ai-top-utility report § 6):
- GPU: persistence ON, TDP 575W × 2, clocks locked 2100/3105MHz.
- CPU: governor=performance, C-states disabled.
- Memory: `vm.swappiness=10`, `vm.dirty_bytes=4GB`, THP=`madvise`.
- IPC: `kernel.shmmax=256GB`, `kernel.shmall=64M pages`.
- NCCL: IB topology + TCP fallback.

---

## Step 5 — Conda env (NVIDIA path, Python 3.12)

```bash
bash ~/AI-Workspace/ai-top-utility/ai-top/ai-top-complete/install-scripts/3_conda_2404.sh
# AMD path: amd_4_conda_2404.sh
```

This now creates a Python **3.12** env (bumped from 3.10 in this runbook's authoring turn). PyTorch 2.11.0+cu130, DeepSpeed 0.16.4, transformers 4.55.0, NCCL 2.29.3+cuda13.0.

---

## Step 6 — First trainer run (sanity check)

```bash
cd ~/AI-Workspace/_projects/prompt_hub/prompt-nexus
bash scripts/launch-trainer.sh --model qwen3 --dry-run
```

Dry-run validates the trainer config + conda env without spending compute. Expected: exit 0, `evals/training/<run_id>/run.json` written.

Real training (~hours, depending on dataset):

```bash
bash scripts/launch-trainer.sh --model qwen3 --epochs 3 --lr 2e-4 --batch 4
```

---

## Step 7 — Wire the BTOO Stop-gate to the live session

Add to `.claude/settings.json` (project-local Claude Code config):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PROJECT_DIR}/hooks/btoo-stop-gate.js"
        }]
      }
    ]
  }
}
```

Set in your shell:

```bash
export BTOO_AUTO_REMEDIATE=1
export BTOO_AUTO_REMEDIATE_SCOPE=local
export PROMPTNEXUS_CHROMA_URL=http://localhost:8000
export PROMPTNEXUS_PG_URL=postgresql://promptnexus:changeme-please@localhost:5432/promptnexus
export PROMPTNEXUS_MEMPALACE_URL=http://localhost:8077
```

The next Claude Code session will route every Stop event through the BTOO hook; verdicts land in both `evals/verdicts/` (file) and `verdicts` (Postgres table) and ChromaDB's `verdicts` collection.

---

## Step 8 — Cross-LLM council (optional)

Add provider keys to `.env`:

```bash
# .env (gitignored)
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
MOONSHOT_API_KEY=...
OLLAMA_HOST=http://localhost:11434
```

Then start Ollama for local-model voices:

```bash
ollama serve &
ollama pull qwen3:8b
ollama pull qwen2.5-coder:7b
```

QueenB will now consult the council when she hits contention. See [skills/cross-llm-council/SKILL.md](../skills/cross-llm-council/SKILL.md).

---

## Verification — end-of-foundation checklist

- [ ] `bash scripts/foundation/setup-foundation.sh` exited 0.
- [ ] `node scripts/memory-bootstrap.js` exited 0.
- [ ] `docker compose -f docker/docker-compose.memory.yml ps` shows 4 services healthy.
- [ ] `nvidia-smi` shows CUDA 13.x and 2× RTX 5090.
- [ ] `dpkg -l gigabyte-ai-top-utility` shows installed.
- [ ] `bash scripts/launch-trainer.sh --model qwen3 --dry-run` exited 0.
- [ ] `.claude/settings.json` has the BTOO Stop hook.
- [ ] First test prompt in Claude Code → verdict appears in `evals/verdicts/` AND in Postgres `verdicts` table AND in Chroma `verdicts` collection.

---

## Failure recovery

| Symptom | Playbook in [PATHFINDER.md](PATHFINDER.md) |
|---|---|
| Chroma 8000 / mempalace 8077 / postgres 5432 unreachable | P-MCP-DOWN (treat docker compose service as MCP) |
| `nvidia-smi` errors | P-TOOL-MISSING + driver reinstall |
| Conda env activation fails | P-TOOL-MISSING (re-run install-scripts) |
| EACCES on Postgres pgdata volume | P-PERM-DENIED |
| `docker compose build` fails on mempalace.Dockerfile | P-NETWORK-FAIL (rebuilds from local fallback) |
| WSL2 `wsl --install` hangs | P-HOST-CONFIG-BROKEN (manual Windows path; outside `BTOO_AUTO_REMEDIATE`) |

Under `BTOO_AUTO_REMEDIATE=1` (default), the host-environment-doctor skill applies these recoveries autonomously. Only data-loss-risk and shared-infra writes surface to the operator.

---

## Why this matters for PromptNexus

After this runbook completes:

- **Local memory** — every intent, verdict, audit, council session, and roadblock is stored in Postgres (structured) and ChromaDB (vector). PromptNexus has cross-session recall of every operator interaction.
- **Reasoning store** — Memory Palace traces multi-hop reasoning paths (intent → verdict → outcome → recovery). QueenB recalls *why* prior decisions were made, not just *what* they were.
- **Local compute** — the 2× RTX 5090 rig is online. Qwen3 + BitNet 1.5B serve via Ollama at near-zero cost; the cloud reserves to Sonnet/Opus for hard reasoning.
- **Boil-the-Ocean enforced live** — the BTOO Stop hook is wired into Claude Code; every turn produces a verdict; partial work BLOCKs unless override.
- **Roadblocks become playbooks** — every novel failure feeds back into PATHFINDER.md as a new entry the next bootstrap doesn't have to invent.

This is the foundation. Move 7+ (Overture visual gate, Popeye live listener, BAML runtime) builds on top.
