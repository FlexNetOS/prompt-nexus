# Path-Finder — Recovery Playbooks

**Purpose:** When QueenB's plan hits a roadblock during MONITOR, the path-finder consults this catalog of documented recoveries. *Investigation is autonomous; mutation is gated* unless `BTOO_AUTO_REMEDIATE=1`.

Every playbook follows the same shape: **detect → diagnose → recover → verify**.

If a roadblock has no playbook here, the loop hits 3 retries → emits a roadblock report → opens an auto-PR adding a new playbook entry. *We never invent recoveries on the fly in production.* (FM4 from the PRD.)

---

## P-AUTH-MISSING — required credential not present

**Detect:** Tool call fails with `401`, `403`, "auth required", "missing token", "PAT not set", or the file `~/.claude/.../credentials` is missing the expected entry.

**Diagnose (autonomous):**
1. Identify which credential — service name, env var, scope.
2. Check `~/.netrc`, `.env`, `.env.local`, `.envrc`, container `containerEnv`, MCP server config.
3. Cross-check against `links/extracted-links.json` for the documented auth source.

**Recover (gated):**
- If env-var only: prompt operator, set in `.envrc`, sourced.
- If OAuth flow needed: invoke service's documented flow, store securely.
- If service is GitHub: prefer `gh auth login` over PAT.
- **Mutation gate:** in v0.1, `BTOO_AUTO_REMEDIATE=1` is ON by default — credential writes proceed without confirm. The auditor logs every write to `evals/audits/<turn>.json` for review. Shared-infra writes (matched by `BTOO_AUTO_REMEDIATE_SCOPE != "local"`) still confirm.

**Verify:** Re-run the failing tool call; `audit.json.tool_compliance.disallowed_calls===0`.

---

## P-PERM-DENIED — permission denied on file or process

**Detect:** `EACCES`, `EPERM`, "permission denied", a `chmod`/`chown` failure.

**Diagnose:**
1. Identify owner of the offending path (`stat`, `ls -l`).
2. Check if path is on a Windows bind-mount (containers).
3. Check if process is running as the right user inside the container.

**Recover (gated):**
- If bind-mount EACCES: route via the named volume (see agent_harness boot memory) — `Dev Containers: Rebuild Container`.
- If user mismatch: switch to the right user via the container's documented `remoteUser`.
- **Never `sudo chmod -R 777`.** That's a workaround, not a recovery — Principle 3.

**Verify:** Re-run; new test confirming the path is correctly owned/permitted.

---

## P-TOOL-MISSING — required CLI or library not installed

**Detect:** `command not found`, `MODULE_NOT_FOUND`, `ENOENT` on a binary path.

**Diagnose:**
1. Identify the missing tool by name + minimum version.
2. Check the documented install path: `package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `Dockerfile`, `postCreate.sh`.
3. Check if the tool is in agent_harness's `.devcontainer/Dockerfile` already and just hasn't propagated to the new image.

**Recover (gated for installs):**
- If declared in package.json/etc: run the project's install script (`yarn install`, `pip install -e .`, `cargo build`).
- If undeclared: add to the right manifest, then install. Update `Dockerfile` if it should be in the published image.
- If a one-shot dev tool: install with `--save-dev` or in a transient venv.
- **Mutation gate:** in v0.1, `BTOO_AUTO_REMEDIATE=1` is ON — installs proceed; auditor logs the install in `delivery.files_changed` so the verdict captures it. Manifest updates also proceed.

**Verify:** Re-run; record the install in `delivery.files_changed` if a manifest was updated.

---

## P-MCP-DOWN — MCP server unhealthy or absent

**Detect:** `/mcp list` shows fewer than expected; tool calls to `mcp__<server>__*` fail; auditor flags MCP timeout.

**Diagnose:**
1. Identify which server (e.g., `context7`, `memory`, `playwright`).
2. Check `.mcp.json` for the pinned version.
3. Check container logs for npx pre-warm failure (agent_harness FM1 pattern).
4. Check the MCP server's network reachability (HTTP-based servers).

**Recover (full autonomy under `BTOO_AUTO_REMEDIATE=1`):**
- Restart server: `/mcp restart <name>`.
- If npx pre-warm failed: re-run `node scripts/ecc.js verify` (or the equivalent for prompt-nexus).
- If a server is misversioned: update `.mcp.json` directly; auditor logs the version diff.
- **Never edit `.mcp.json` to *remove* a server** to make a problem go away — workaround, Principle 3. Removal is not a recovery; it is a defect.

**Verify:** `/mcp list` shows all expected servers responding.

---

## P-DISK-FULL — out of disk space

**Detect:** `ENOSPC`, "no space left on device", `df` showing >95% on the workspace volume.

**Diagnose:**
1. Identify where space is being consumed: `du -sh */`, container layer sizes, build artifact dirs.
2. Check named-volume sizes (`ecc-node-modules`, `ecc-yarn-cache`).

**Recover (autonomous under `BTOO_AUTO_REMEDIATE=1`):**
- Clear `node_modules/` and reinstall — proceed; log to `delivery.files_changed`.
- Prune Docker: `docker system prune -f` — proceed only when other-workspace risk is bounded (i.e., the operator's only running container is the current one). If multiple containers run, surface before pruning.
- Clear yarn/npm caches in their named volumes — proceed.

**Verify:** `df` shows headroom; rerun the failing operation.

---

## P-GIT-CONFLICT — merge or rebase conflict

**Detect:** `git status` shows unmerged paths; `git merge`/`rebase` returned non-zero with conflict markers.

**Diagnose:**
1. Identify conflicting files.
2. Check git history of conflicting hunks (which commits introduced).
3. Decide: take ours / theirs / manual merge.

**Recover (autonomous for *non-destructive* paths; surface for destructive):**
- Three-way merge with full diff context attempted first.
- If both sides cleanly mergeable hunks (no overlap on the same lines), auto-resolve and continue.
- If true overlap exists: surface to operator with the conflict map. **Never auto-pick `--ours` or `--theirs` on overlapping hunks** — that is a destructive shortcut, Principle 3. `BTOO_AUTO_REMEDIATE=1` does not override this; data-loss-risk operations always confirm.

**Verify:** `git status` clean; tests pass post-merge.

---

## P-NETWORK-FAIL — outbound network failure

**Detect:** `ETIMEDOUT`, `EAI_AGAIN`, `ECONNREFUSED` on outbound HTTP/HTTPS.

**Diagnose:**
1. Identify endpoint.
2. Check container network config (Dev Containers `runArgs`).
3. Test reachability: `curl -I <endpoint>`.
4. Check rate-limit headers (429 with retry-after).

**Recover (autonomous for transient; gated for proxy changes):**
- Transient: backoff + retry (max 3, exponential).
- Persistent + endpoint reachable from host: container DNS or proxy issue — surface.
- Rate-limit: respect retry-after, log to memory for cost-tracking.

**Verify:** Endpoint responsive; eventually-consistent retry succeeded.

---

## P-HOST-CONFIG-BROKEN — Windows host config issue

**Detect:** Operator reports "the system is acting up," tool calls fail outside the container due to host issues, file paths not resolving on the host.

**Diagnose (autonomous):**
1. Confirm we're inside the devcontainer — if yes, host issues should not affect us; surface as informational.
2. If outside the container: read host environment (`uname`, `wmic`, registry as appropriate).
3. Cross-reference with operator's existing memory note: "Windows environment repair in progress."

**Recover (autonomous under `BTOO_AUTO_REMEDIATE=1`):**
- Diagnose with read-only host inspection (`uname`, `wmic`, registry read, `Get-Service`, `Get-Process`).
- Apply documented fixes from the host-environment-doctor skill catalog. Auditor logs every host-side write to `evals/audits/<turn>.json`.
- For changes that touch shared infra (registry HKLM, group policy, services that other containers depend on) — surface before writing.
- Per memory note: the operator's host repair is in progress. Coordinate with the operator's repair plan rather than fighting it.

**Verify:** Operator confirms; symptom does not reproduce.

---

## P-DEPENDABOT-LOCKFILE — dependabot PR fails CI on `npm ci` lockfile mismatch

**Detect:** Open PR by `dependabot[bot]` (or `dependabot/...` branch name). CI failure log contains `npm error code EUSAGE` + `npm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync` + `npm error Invalid: lock file's <pkg>@<old> does not satisfy <pkg>@<new>`.

**Diagnose (autonomous):**
1. Confirm the PR's branch name matches `dependabot/npm_and_yarn/<pkg>-<version>`.
2. Read `package.json` on the PR's branch — confirm dependabot bumped a version.
3. Read `package-lock.json` on the PR's branch — confirm it still has the old version.
4. Detect peer-dep family bumps: if the PR touches `@eslint/js` alone but has `eslint` at an incompatible major, plan a combined bump. Same for `@types/react` ↔ `react`, `@typescript-eslint/parser` ↔ `@typescript-eslint/eslint-plugin`, etc.

**Recover (autonomous under `BTOO_AUTO_REMEDIATE=1`):**
1. Fetch and check out the dependabot branch in the agent_harness root worktree.
2. If the PR is part of a peer-dep family, edit `package.json` to bump siblings together (e.g., bump `eslint` when `@eslint/js` is bumped).
3. Run `npm install --no-audit --no-fund` to refresh `package-lock.json`.
4. `git add package.json package-lock.json` (and only those — never sweep in untracked session files).
5. Commit with `build(deps): refresh package-lock.json for <pkg> <version>` (and note any sibling bumps).
6. Push to the PR branch.
7. Reset any side-effect drift (`yarn.lock` is touched as a side effect by some postinstall scripts; reset before switching branches).

**Verify:** `gh pr checks <num>` returns ≥80% pass on the next run. If a peer-dep conflict reappears, expand the family.

**Anti-patterns (forbidden):**
- Downgrading the dependency to match the lockfile (defeats the bump).
- Commenting out failing tests.
- Adding `--legacy-peer-deps` to the CI install step (masks real conflicts).
- Closing the PR without merging (tells dependabot to give up).

**Related:** `skills/dependabot-watcher/` — runtime that polls open PRs and applies this recovery automatically when triggered by QueenB.

---

## P-MIC-CONFIG — microphone records but never sends

**Detect:** Operator reports the mic is recording but the message breaks before submit; voice transcription endpoint hangs or returns mid-stream.

**Diagnose (autonomous):**
1. Query Windows microphone privacy state via PowerShell (read-only): `Get-WinUserLanguageList`, registry `HKCU:\Software\Microsoft\Speech_OneCore` (read).
2. Check Claude Code (or browser) microphone permission:
   - `Settings > Privacy & security > Microphone > Allow apps to access your microphone` — must be On.
   - The specific app must be listed and toggled On.
   - Background-microphone access must be enabled.
3. Check audio device routing: `Settings > System > Sound > Advanced > App volume and device preferences` — confirm the app routes to a present device.
4. Inspect Realtek/audio driver state via Device Manager (`Get-PnpDevice -Class AudioEndpoint`).
5. If recording captures but submit fails: capture the failing network call (transcription endpoint timeout or 5xx).

**Recover (operator-confirm class — host-side privacy + driver writes):**
- Permission toggles: surface to operator with the exact path; never auto-toggle privacy settings.
- Driver update: surface; do not auto-install drivers.
- Network endpoint: if a transcription service is timing out, suggest a network-side diagnostic (P-NETWORK-FAIL) and fall back to text input.

**Verify:** Operator confirms a successful voice → text round-trip.

---

## Index by symptom

| Symptom | Playbook |
|---|---|
| 401, 403, missing token | P-AUTH-MISSING |
| EACCES, EPERM | P-PERM-DENIED |
| command not found, ENOENT, MODULE_NOT_FOUND | P-TOOL-MISSING |
| /mcp list short, mcp__ tool fail | P-MCP-DOWN |
| ENOSPC, "no space left" | P-DISK-FULL |
| unmerged paths, conflict markers | P-GIT-CONFLICT |
| ETIMEDOUT, ECONNREFUSED, 429 | P-NETWORK-FAIL |
| "system is acting up" / Windows-only | P-HOST-CONFIG-BROKEN |
| mic records but submit breaks | P-MIC-CONFIG |
| dependabot PR + npm ci EUSAGE / lockfile out of sync | P-DEPENDABOT-LOCKFILE |

## Adding a new playbook

When the loop hits 3 retries and no existing playbook matches, the path-finder:
1. Writes a roadblock report to `evals/roadblocks/<ts>.md` with the symptom, attempted recoveries, and operator notes.
2. Opens a draft PR adding a new playbook stub here, pre-filled with the symptom and the recovery the operator chose.
3. Future identical symptoms route through the new playbook automatically.

This is how PromptNexus *learns*. The path-finder is data, and data grows.

## Auto-remediate flag — ON BY DEFAULT (v0.1)

`BTOO_AUTO_REMEDIATE=1` is the default in `.devcontainer/devcontainer.json`. Mutation gates flip from "ask first" to "act, log, surface afterward." Operator decision (2026-05-02): *"Flip it. Remove every roadblock. Permission is easy. Done. You have full access."*

**What this means in practice:**
- Reads, diagnoses, plans → autonomous, always.
- Local writes (this devcontainer's volumes, project files, MCP server installs, dependency adds, lockfile updates, env file edits in `.env.local`, `.envrc`) → autonomous; auditor logs each write.
- Container-level writes (`.devcontainer/`, `Dockerfile`, devcontainer named volumes, `~/.claude` state) → autonomous; auditor logs.
- Host-side writes outside the devcontainer (Windows registry HKLM, group policy, system services, host filesystem outside the workspace bind-mount) → still surface before writing **only if** the change affects state outside the operator's exclusive control. Personal/user-scope host changes proceed.
- Destructive operations with data-loss risk (force-push, `rm -rf` on uncommitted work, branch deletion, DB drops, git reset --hard with uncommitted changes, overlapping merge conflicts) → ALWAYS surface, regardless of the flag. *Permission is easy; data loss is not.* Principle 3.

**Scope variable:** `BTOO_AUTO_REMEDIATE_SCOPE=local` (default) limits autonomy to the current devcontainer + the operator's user-scope host. `=global` extends it (do not set unless explicitly authorized for the session). `=read-only` reverts to the v0 cautious behavior for one session.

**Kill-switch:** any error during auto-remediate that produces a non-recoverable state (irreversible mutation that cannot be undone by a single counter-action) flips the flag to `read-only` for the rest of the session and surfaces a roadblock report.

**Audit trail:** every autonomous mutation is logged to `evals/audits/<turn>.json` with: what was changed, what tool did it, what state existed before, what state exists after. Weekly review surfaces patterns; if a recurring autonomous action is producing low-value churn, the playbook gets refined.
