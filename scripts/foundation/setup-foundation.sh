#!/usr/bin/env bash
# PromptNexus foundation bootstrap.
# Idempotent. Run end-to-end on a fresh Ubuntu 24.04+ WSL2 box.
#
# Order:
#   1. apt update + base packages
#   2. NVIDIA driver + CUDA 13 (pinned via existing ai-top-utility scripts)
#   3. Docker Engine + Compose v2
#   4. AI TOP Utility 4.2.1 (.deb)
#   5. ai-training-optimize.sh — kernel + GPU tuning
#   6. Memory stack: ChromaDB + Postgres 17 + mempalace + sqlite-web
#   7. Health checks
#
# Reads from ai-top-utility/ at $AITU_ROOT (default ~/AI-Workspace/ai-top-utility).
# Writes logs to /tmp/promptnexus-foundation.log.
#
# This script does not run inside the prompt-nexus devcontainer; it runs on
# the WSL2 / bare-metal host that owns the GPUs.

set -euo pipefail

LOG=/tmp/promptnexus-foundation.log
exec > >(tee -a "$LOG") 2>&1
echo "==> PromptNexus foundation bootstrap @ $(date -Iseconds)"

AITU_ROOT="${AITU_ROOT:-$HOME/AI-Workspace/ai-top-utility}"
PNX_ROOT="${PNX_ROOT:-$HOME/AI-Workspace/_projects/prompt_hub/prompt-nexus}"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "[step requires sudo] re-running with sudo: $1"
    sudo -E "$@"
    return $?
  fi
  "$@"
}

step() { echo ""; echo "==> [$1] $2"; }

# 1. apt update + base packages
step 1 "apt update + base packages"
require_root apt-get update -y
require_root apt-get install -y --no-install-recommends \
  curl wget git build-essential ca-certificates gnupg lsb-release \
  python3 python3-pip python3-venv \
  jq unzip xz-utils \
  postgresql-client sqlite3

# 2. NVIDIA driver + CUDA 13 (delegated to ai-top-utility's scripts)
step 2 "NVIDIA driver + CUDA 13"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi | grep -q "CUDA Version: 13"; then
  echo "    CUDA 13.x already installed; skipping driver install."
else
  if [[ -f "$AITU_ROOT/ai-top/ai-top-complete/install-scripts/2_nvidia_driver_cuda_2404.sh" ]]; then
    bash "$AITU_ROOT/ai-top/ai-top-complete/install-scripts/2_nvidia_driver_cuda_2404.sh"
  else
    echo "    [warn] expected script not found; run AI TOP installer manually then re-run this."
  fi
fi

# 3. Docker Engine + Compose v2
step 3 "Docker Engine + Compose v2"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "    [warn] docker compose v2 missing; install via apt or upgrade docker"
fi

# 4. AI TOP Utility 4.2.1
step 4 "AI TOP Utility 4.2.1"
if dpkg -l gigabyte-ai-top-utility 2>/dev/null | grep -q '^ii'; then
  echo "    already installed"
else
  if [[ -f "$AITU_ROOT/gigabyte-ai-top-utility-4.2.1.deb" ]]; then
    require_root apt-get install -y "$AITU_ROOT/gigabyte-ai-top-utility-4.2.1.deb"
  else
    echo "    [warn] .deb not found at $AITU_ROOT — skipping"
  fi
fi

# 5. ai-training-optimize.sh
step 5 "Kernel + GPU tuning"
if [[ -f "$AITU_ROOT/model-training-prep/configs/ai-training-optimize.sh" ]]; then
  require_root bash "$AITU_ROOT/model-training-prep/configs/ai-training-optimize.sh" start || \
    echo "    [warn] optimize script returned non-zero; check $LOG"
else
  echo "    [warn] ai-training-optimize.sh not found"
fi

# 6. Memory stack
step 6 "Memory stack — ChromaDB + Postgres + mempalace + sqlite-web"
cd "$PNX_ROOT"
if [[ ! -f .env ]]; then
  cat > .env <<'EOF'
PROMPTNEXUS_PG_USER=promptnexus
PROMPTNEXUS_PG_PASSWORD=changeme-please
PROMPTNEXUS_PG_DB=promptnexus
EOF
  echo "    wrote .env (CHANGE the password before going to prod)"
fi
docker compose -f docker/docker-compose.memory.yml up -d --build

# 7. Health checks
step 7 "Health checks (allow up to 90s for first start)"
for i in $(seq 1 18); do
  ok=0
  curl -fsS http://localhost:8000/api/v2/heartbeat >/dev/null 2>&1 && ((ok+=1)) || true
  pg_isready -h localhost -p 5432 >/dev/null 2>&1 && ((ok+=1)) || true
  curl -fsS http://localhost:8077/health >/dev/null 2>&1 && ((ok+=1)) || true
  if [[ $ok -eq 3 ]]; then echo "    all 3 services healthy ✓"; break; fi
  echo "    waiting ($i/18, healthy=$ok/3)..."
  sleep 5
done

echo ""
echo "==> Foundation ready."
echo "    Chroma:      http://localhost:8000   (vector store)"
echo "    Postgres:    localhost:5432          (structured memory)"
echo "    Mempalace:   http://localhost:8077   (reasoning store)"
echo "    SQLite-web:  http://localhost:8079   (verdicts/audits read-only)"
echo "    Logs:        $LOG"
echo ""
echo "    Next: cd $PNX_ROOT && node scripts/memory-bootstrap.js"
