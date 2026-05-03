#!/usr/bin/env bash
# Trainer launcher — wraps ai-top-utility/model-training-prep/training/train.py.
# Verifies system tuning, sources conda env, runs trainer, captures logs.
#
# Usage:
#   bash scripts/launch-trainer.sh --model qwen3 [--epochs N] [--lr X] [--batch N] [--dry-run]
#   bash scripts/launch-trainer.sh --model coder --epochs 5 --lr 1e-4
#   bash scripts/launch-trainer.sh --model bitnet --ctx 2048
#
# Options:
#   --model {qwen3|coder|bitnet}    Model preset (required)
#   --epochs N                       Override epochs (default 3)
#   --lr X                           Override learning rate (default 2e-4)
#   --batch N                        Override batch size (default 4)
#   --ctx N                          Override max context (default 4096)
#   --dry-run                        Validate config without training
#   --no-tune                        Skip ai-training-optimize.sh check
#   --force-tune                     Re-apply system tuning even if already on

set -euo pipefail

AITU_ROOT="${AITU_ROOT:-$HOME/AI-Workspace/ai-top-utility}"
TRAINER="$AITU_ROOT/model-training-prep/training/train.py"
TUNER="$AITU_ROOT/model-training-prep/configs/ai-training-optimize.sh"
CONDA_ENV="${PROMPTNEXUS_CONDA_ENV:-aitop}"
PNX_ROOT="${PNX_ROOT:-$HOME/AI-Workspace/_projects/prompt_hub/prompt-nexus}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
LOG_DIR="$PNX_ROOT/evals/training/$RUN_ID"
mkdir -p "$LOG_DIR"

MODEL=""
EPOCHS=""
LR=""
BATCH=""
CTX=""
DRY_RUN=0
SKIP_TUNE=0
FORCE_TUNE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --epochs) EPOCHS="$2"; shift 2 ;;
    --lr) LR="$2"; shift 2 ;;
    --batch) BATCH="$2"; shift 2 ;;
    --ctx) CTX="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-tune) SKIP_TUNE=1; shift ;;
    --force-tune) FORCE_TUNE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "[launch-trainer] unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$MODEL" ]] && { echo "--model is required" >&2; exit 2; }

[[ -f "$TRAINER" ]] || { echo "trainer not found: $TRAINER" >&2; exit 3; }

# 1. Verify system tuning is on.
if [[ $SKIP_TUNE -eq 0 ]]; then
  echo "==> [tune] verifying system optimization"
  if [[ $FORCE_TUNE -eq 1 ]] || ! sudo bash "$TUNER" status 2>/dev/null | grep -qE 'OPTIMIZED|active'; then
    echo "    applying ai-training-optimize.sh (sudo)"
    sudo bash "$TUNER" start | tee "$LOG_DIR/tune.log"
  else
    echo "    already optimized ✓"
  fi
fi

# 2. Conda env activation.
echo "==> [conda] activating env: $CONDA_ENV"
if command -v conda >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$(conda info --base)/etc/profile.d/conda.sh"
  conda activate "$CONDA_ENV" || { echo "[conda] env $CONDA_ENV not found; create via ai-top-utility install-scripts" >&2; exit 4; }
else
  echo "[conda] not on PATH; falling back to system python (NOT RECOMMENDED for training)" >&2
fi

# 3. Build trainer args.
ARGS=("--model" "$MODEL")
[[ -n "$EPOCHS" ]] && ARGS+=("--epochs" "$EPOCHS")
[[ -n "$LR" ]] && ARGS+=("--lr" "$LR")
[[ -n "$BATCH" ]] && ARGS+=("--batch" "$BATCH")
[[ -n "$CTX" ]] && ARGS+=("--max-seq" "$CTX")
[[ $DRY_RUN -eq 1 ]] && ARGS+=("--dry-run")

# 4. Launch.
echo "==> [train] $TRAINER ${ARGS[*]}"
echo "    run_id: $RUN_ID"
echo "    logs:   $LOG_DIR"

cd "$(dirname "$TRAINER")"
START=$(date +%s)
{
  python "$TRAINER" "${ARGS[@]}" 2>&1
  echo "[exit] $?"
} | tee "$LOG_DIR/train.log"
END=$(date +%s)

# 5. Persist run metadata.
cat > "$LOG_DIR/run.json" <<EOF
{
  "run_id": "$RUN_ID",
  "model": "$MODEL",
  "args": $(printf '%s\n' "${ARGS[@]}" | jq -R . | jq -sc .),
  "started_at": $START,
  "ended_at": $END,
  "duration_seconds": $((END - START)),
  "log_path": "$LOG_DIR/train.log",
  "tune_log": "$LOG_DIR/tune.log",
  "dry_run": $DRY_RUN
}
EOF

echo "==> [done] run_id=$RUN_ID duration=$((END - START))s"
echo "    metadata: $LOG_DIR/run.json"
