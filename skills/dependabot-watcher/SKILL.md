---
name: dependabot-watcher
description: Auto-handle dependabot PRs that fail CI on npm ci lockfile mismatch. Triggers on a daily cron OR when QueenB sees scope=ship + content matching dependabot patterns OR when a PostToolUse hook detects `gh pr list` returning open dependabot PRs with failing checks. Encodes the P-DEPENDABOT-LOCKFILE playbook as a runnable routine.
model: claude-sonnet-4-6 (orchestration) · git/npm (execution)
status: v1
---

# dependabot-watcher

The recurring fix surfaced from the 2026-05-03 session: dependabot bumps `package.json` but doesn't update `package-lock.json`; `npm ci` then refuses to run because the two are out of sync. Multiplied across 4 open PRs, that's hours of manual cleanup. This skill makes it a one-command routine.

## When to use

- Daily cron (recommended) — `dependabot-watcher --since=24h` checks every connected repo for open dependabot PRs with failing checks and applies the fix where the playbook matches.
- On-demand — operator invokes `/dependabot-watcher` after seeing red CI on a dependabot PR.
- Auto-routed — QueenB classifies an intent like *"why are the dependabot PRs failing"* (scope=ship, contains `dependabot|deps|bump`) and routes here.

## Inputs

```yaml
repos: ["FlexNetOS/agent_harness", ...]   # default: all repos with dependabot.yml
include_branches: ["dependabot/npm_and_yarn/*"]
exclude_pkgs: []                            # never auto-fix these
combine_peer_families: true                 # bump @eslint/js + eslint together, etc.
push: true                                  # set false for dry-run
max_prs_per_run: 10
```

## How it works

```
For each open PR by dependabot[bot]:
    1. gh pr checks <num> → does any required check fail with EUSAGE?
       If no → skip (CI passing or unrelated failure).
    2. gh pr view <num> --json headRefName → extract branch.
    3. git fetch origin && git switch <branch>.
    4. Read package.json, identify the bumped dep + version.
    5. If dep belongs to a peer-dep family AND `combine_peer_families=true`:
        Bump siblings to compatible versions (lookup table below).
    6. npm install --no-audit --no-fund (refreshes lockfile).
    7. git add package.json package-lock.json (ONLY these — never untracked drift).
    8. git checkout yarn.lock (reset side-effect drift from postinstall).
    9. git commit -m "build(deps): refresh package-lock.json for <pkg> <version>".
    10. git push.
    11. Move to next PR.
```

## Peer-dep family lookup

| Bumped dep | Bump together |
|---|---|
| `@eslint/js@10.x` | `eslint@10.x` |
| `eslint@10.x` | `@eslint/js@10.x` |
| `@typescript-eslint/parser` | `@typescript-eslint/eslint-plugin` (same version) |
| `react@N` | `react-dom@N`, `@types/react@N`, `@types/react-dom@N` |
| `vue@N` | `vue-router@N` (matching major) |
| `vite@N` | `@vitejs/plugin-react@<compat>` |
| `@types/node@N` | (none — but verify Node version matrix in CI is compatible) |
| `typescript@N` | (none required, but flag if `@types/*` declares peer-typescript ranges) |

Extend this table when new peer-dep families surface.

## Anti-patterns (the doctor refuses)

- Downgrading the dep to match the lockfile (defeats the bump; dependabot will reopen).
- Adding `--legacy-peer-deps` to CI (masks real conflicts).
- Closing the PR without merging (dependabot keeps reopening).
- Sweeping unrelated session files into the dependabot commit (e.g., `.claude/settings.json` — keep commits scoped).

## Cost ceiling

- One Sonnet call per session (orchestration).
- N npm-install calls per session (one per PR).
- Per-incident budget: 5 min wall-clock per PR. Beyond → escalate.
- Daily cap: 10 PRs auto-fixed.

## Output

`evals/dependabot-runs/<date>.json`:

```json
{
  "date": "2026-05-03",
  "prs_inspected": 4,
  "prs_fixed": 4,
  "prs_skipped": 0,
  "prs_escalated": 0,
  "fixes": [
    {"pr": 5, "branch": "dependabot/.../typescript-6.0.3", "result": "lockfile_refreshed"},
    {"pr": 6, "branch": "dependabot/.../eslint/js-10.0.1", "result": "combined_with_eslint_10.3.0"},
    {"pr": 7, "branch": "dependabot/.../types/node-25.6.0", "result": "lockfile_refreshed"},
    {"pr": 8, "branch": "dependabot/.../eslint-10.3.0", "result": "combined_with_@eslint/js_10.0.1"}
  ]
}
```

Memory Palace records each PR fix as an edge: `(pr, <num>) -> recovered_via -> (playbook, P-DEPENDABOT-LOCKFILE)`.

## Implementation status

v1 — skill contract + playbook entry.

Runtime lands as `scripts/dependabot-watcher.js` (Node) which invokes `gh`, `git`, `npm` directly. It doesn't need Anthropic API access — the playbook is rule-based, not LLM-judgment-based.

## Schedule

Once the runtime ships, register a cron via the agent_harness `/schedule` skill: `daily 08:00 → /dependabot-watcher --since=24h`. The watcher sweeps overnight bumps before the operator's first session.
