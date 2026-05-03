---
name: cli-anything-fallback
description: Last-resort permission-edge-case fallback using HKUDS/CLI-Anything. Triggers when the path-finder hits a documented playbook but the recovery requires a permission elevation that the doctor's normal channels can't satisfy. Operator's explicit pointer ("If you run into a roadblock on permission just use HKUDS/CLI-Anything").
model: claude-sonnet-4-6
status: v1
---

# cli-anything-fallback

The operator's explicit instruction (2026-05-02): *"If you run into a roadblock on permission just use HKUDS/CLI-Anything."*

CLI-Anything is the HKUDS open-source CLI agent designed to operate any command-line tool with autonomous permission acquisition and elevation. We use it as the bottom rung of the path-finder ladder.

## When to invoke

Strict ladder — try in order, fall through on permission failure:

1. Direct execution under user account (the default).
2. `sudo`-elevated execution if the operation is documented as needing root.
3. `host-environment-doctor` skill (with its own playbook coverage).
4. **CLI-Anything fallback** ← this skill.
5. Operator surface (final escape).

## What CLI-Anything provides

- Autonomous capability discovery across CLI tools.
- Permission probing and elevation strategies.
- Tool synthesis (chaining unrelated CLIs to achieve a goal).
- Safe rollback if an action fails partway through.

## Setup

```bash
# Install CLI-Anything via the operator's package manager of choice.
# Reference: https://github.com/HKUDS/CLI-Anything
git clone https://github.com/HKUDS/CLI-Anything ~/.local/share/cli-anything
cd ~/.local/share/cli-anything
pip install -e .
```

Add to `.envrc`:

```bash
export PROMPTNEXUS_CLI_ANYTHING_BIN=~/.local/share/cli-anything/bin/cli-anything
```

## Invocation contract

When the doctor escalates here, it provides:

```yaml
goal: <one-line natural language goal, e.g. "install nvidia-driver-590">
context:
  - <relevant snapshot fields from doctor's audit.json>
constraints:
  - data_loss_risk: forbidden (still surfaces)
  - shared_infra: forbidden (still surfaces)
  - max_duration_seconds: 600
  - max_cost_cents: 0       # CLI-Anything is local; should be free
  - allowed_elevations: [sudo, polkit]
```

The skill calls CLI-Anything with the goal and constraints, captures stdout/stderr/exit code, and reports back to the doctor with:

```yaml
result: success | partial | failure
log_path: <path to full transcript>
mutations:
  - <list of state changes CLI-Anything made>
followup_steps:
  - <if any manual steps remain>
```

## Safety

CLI-Anything will be told the same data-loss + shared-infra rules as the rest of PromptNexus:

- Never `force-push`, `rm -rf` over uncommitted work, drop tables, `reset --hard`.
- Always log mutations to `evals/audits/<turn>.json` (via the doctor that invoked it).
- Stop and surface if a constraint is breached or a recovery requires elevation beyond `allowed_elevations`.

## Failure modes

| Failure | Recovery |
|---|---|
| CLI-Anything not installed | Surface to operator with install command (above) |
| CLI-Anything refuses the task | Doctor surfaces to operator with the refusal reason |
| CLI-Anything succeeds but verification still fails | Treated as a doctor verification failure → 3-retry → roadblock report |
| CLI-Anything triggers a data-loss-class operation | Hard stop; surface to operator regardless of mode |

## Implementation status

v1 — skill contract. Runtime lands when:
1. CLI-Anything is installed on the host (one-time setup).
2. The doctor's escalation logic is wired to call this skill (1-line addition in `skills/host-environment-doctor`).

## Open questions

- **C1:** Does CLI-Anything support a structured-output mode (JSON), or do we parse stdout? If it has a `--json` flag, prefer it. If not, write a parse adapter.
- **C2:** Should CLI-Anything's transcripts feed back into `mempalace` as training data for the operator's local BitNet model? Yes — the patterns it learns are valuable.
