#!/usr/bin/env node
/**
 * Boil-the-Ocean Stop-Gate Hook
 *
 * Claude Code Stop-event hook. Reads the turn's deliverable summary on stdin,
 * scores it against the 9 principles, writes a verdict.json, and exits 0
 * (ALLOW Stop) or 2 (BLOCK Stop, with reason on stderr — Claude Code's
 * convention for blocking hooks).
 *
 * Wiring (in .claude/settings.json hooks block):
 *   { "Stop": [{ "command": "node hooks/btoo-stop-gate.js" }] }
 *
 * Inputs (stdin, JSON):
 *   {
 *     "turn_id": "...",
 *     "operator": "david",
 *     "commitment": { "intent_summary": "...", "deliverables_promised": [...], "permanent_solve_reachable": true },
 *     "delivery":   { "files_changed": [...], "tests_run": [...], "docs_updated": [...] },
 *     "auditor":    { "tool_compliance": {...}, "hallucination_flags": [...], "schema_violations": [...] }
 *   }
 *
 * Outputs:
 *   - evals/verdicts/<ISO>-<turn_id>.json (always — pass or block)
 *   - exit 0 + verdict path on stdout if ALLOW
 *   - exit 2 + reason on stderr if BLOCK
 *
 * Override path: /leonidas-override <reason> sets env LEONIDAS_OVERRIDE=1
 * and LEONIDAS_OVERRIDE_REASON=<reason>. Override is logged but always allows.
 *
 * Principle scoring uses a deterministic rule-based pass — no LLM call here,
 * because Stop hooks must be fast (<200ms typical, 30s hard cap). Deeper
 * audit is done by the /btoo-check command (which DOES call an LLM via
 * Leonidas's Sonnet contract).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0.0';
const MAX_BLOCKS_PER_TURN = 3;
const VERDICTS_DIR = path.resolve(__dirname, '..', 'evals', 'verdicts');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    setTimeout(() => reject(new Error('stdin timeout')), 5000);
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Score one principle. Returns { status, evidence, gap_description?, recovery? }.
 * Rules are intentionally conservative — better to BLOCK and let Leonidas's
 * /btoo-check loosen on demand than to silently pass partial work.
 */
function scorePrinciples(input) {
  const { commitment = {}, delivery = {}, auditor = {} } = input;
  const promised = commitment.deliverables_promised || [];
  const satisfied = delivery.deliverables_satisfied || [];
  const tests = delivery.tests_run || [];
  const docs = delivery.docs_updated || [];
  const files = delivery.files_changed || [];
  const hallucinations = auditor.hallucination_flags || [];
  const schemaViolations = auditor.schema_violations || [];
  const disallowedCalls = (auditor.tool_compliance && auditor.tool_compliance.disallowed_calls) || 0;

  // Vacuous-truth mode: when no commitment was made by QueenB (e.g., Claude
  // Code's native Stop payload arrives without a structured commitment from
  // the listener pipeline), the scorer cannot compare delivery against a
  // non-existent claim. Pass principles that depend on commitment/delivery
  // shape; surface only the principles whose data is actually present.
  const noCommitmentToVerify = promised.length === 0;

  const allPromisedSatisfied = noCommitmentToVerify || promised.every((p) => satisfied.includes(p));
  const anyTestsRun = tests.some((t) => t.status === 'pass' || t.status === 'fail');
  const allTestsPass = tests.length > 0 && tests.every((t) => t.status === 'pass');
  const anyTestsMissing = tests.some((t) => t.status === 'missing');

  return {
    p1_search_the_ground: {
      status: 'pass',
      evidence: 'Search-the-ground is enforced by upstream gateguard hooks (pre:edit-write); presumed pass at Stop.'
    },
    p2_build_completely: allPromisedSatisfied
      ? {
          status: 'pass',
          evidence: noCommitmentToVerify
            ? 'No structured commitment from QueenB this turn — vacuous pass (gate active when commitment present).'
            : `All ${promised.length} promised deliverables satisfied.`
        }
      : {
          status: 'blocker',
          evidence: `${satisfied.length}/${promised.length} promised deliverables satisfied.`,
          gap_description: 'Half-built. ' + (promised.filter((p) => !satisfied.includes(p)).join('; ')),
          recovery: 'Loop back to TRANSFORM with the unsatisfied deliverables; do not Stop.'
        },
    p3_no_shortcuts: {
      status: 'pass',
      evidence: 'Shortcut detection requires LLM judgment; deferred to /btoo-check.'
    },
    p4_no_loose_ends: {
      status: 'pass',
      evidence: 'Loose-end detection requires LLM judgment; deferred to /btoo-check.'
    },
    p5_test_like_an_enemy: (() => {
      // No commitment → no claim about testing → vacuous pass.
      if (noCommitmentToVerify && tests.length === 0) {
        return {
          status: 'pass',
          evidence: 'No commitment + no test claim — vacuous pass.'
        };
      }
      // No tests run AND files were changed → blocker (real change without verification).
      if (!anyTestsRun && files.length === 0 && tests.length === 0) {
        return { status: 'pass', evidence: 'No tests required (no files changed).' };
      }
      if (!anyTestsRun || anyTestsMissing || !allTestsPass) {
        return {
          status: !anyTestsRun ? 'blocker' : (anyTestsMissing ? 'gap' : 'blocker'),
          evidence: `tests_run: ${tests.length} (pass=${tests.filter((t) => t.status === 'pass').length}, fail=${tests.filter((t) => t.status === 'fail').length}, missing=${tests.filter((t) => t.status === 'missing').length})`,
          gap_description: !anyTestsRun ? 'No tests ran this turn.' : (anyTestsMissing ? 'Some required tests are missing.' : 'Some tests failed.'),
          recovery: 'Add missing tests; fix failing tests; re-run.'
        };
      }
      return { status: 'pass', evidence: `All ${tests.length} tests passed.` };
    })(),
    p6_documentation_is_supply_lines: docs.length > 0 || files.length === 0
      ? { status: 'pass', evidence: `${docs.length} docs updated.` }
      : {
          status: 'gap',
          evidence: `${files.length} files changed; ${docs.length} docs updated.`,
          gap_description: 'Code changed but documentation did not follow.',
          recovery: 'Update docs (README, runbook, ADR) for the changed surface area.'
        },
    p7_outcomes_not_plans: {
      status: 'pass',
      evidence: 'Outcome-vs-plan check requires LLM judgment; deferred to /btoo-check.'
    },
    p8_total_responsibility: disallowedCalls === 0
      ? { status: 'pass', evidence: 'No disallowed tool calls.' }
      : {
          status: 'blocker',
          evidence: `${disallowedCalls} disallowed tool call(s).`,
          gap_description: 'Persona violated its tool allowlist — boundary breach.',
          recovery: 'Re-route work through the correct persona.'
        },
    p9_decisive_victory: hallucinations.filter((h) => h.severity === 'high').length === 0 && schemaViolations.length === 0
      ? { status: 'pass', evidence: 'No high-severity hallucinations or schema violations.' }
      : {
          status: 'blocker',
          evidence: `hallucinations(high)=${hallucinations.filter((h) => h.severity === 'high').length}, schema_violations=${schemaViolations.length}`,
          gap_description: 'Delivery is not obviously decisive — auditor flagged issues.',
          recovery: 'Resolve auditor findings before Stop.'
        }
  };
}

function decide(principles, input) {
  const blockers = Object.entries(principles).filter(([, p]) => p.status === 'blocker');
  const overrideUsed = process.env.LEONIDAS_OVERRIDE === '1';
  const overrideReason = process.env.LEONIDAS_OVERRIDE_REASON || null;
  const blockCount = Number(process.env.BTOO_BLOCK_COUNT || '0');

  if (overrideUsed) {
    return {
      allow: true,
      reason: 'Leonidas override invoked by operator.',
      block_count: blockCount,
      override_used: true,
      override_reason: overrideReason
    };
  }

  // BTOO_AUTO_REMEDIATE=1 (default): when blockers exist, attempt auto-remediation
  // INSTEAD of blocking outright. The Stop hook still BLOCKs on the first cycle
  // so the agent can loop back to TRANSFORM and apply the recovery (write the
  // missing tests, write the missing docs, satisfy the missing deliverable).
  // The difference vs v0 is: the recovery proceeds without surfacing to the
  // operator. Only data-loss-risk blockers surface unconditionally.
  const autoRemediate = process.env.BTOO_AUTO_REMEDIATE === '1';
  const DATA_LOSS_RE = /(force[- ]push|rm\s+-rf|drop\s+table|reset\s+--hard|delete\s+branch|truncate\s+table|--no-verify|--force(?!\b)\b)/i;
  const haystack = JSON.stringify({
    commitment: input.commitment || {},
    delivery: input.delivery || {},
    auditor: input.auditor || {},
    blockers: blockers.map(([k, v]) => ({ k, ...v }))
  });
  const dataLossRiskBlocker = DATA_LOSS_RE.test(haystack);

  if (blockers.length === 0) {
    return { allow: true, reason: 'All principles pass.', block_count: blockCount, override_used: false, override_reason: null };
  }

  if (blockCount >= MAX_BLOCKS_PER_TURN) {
    return {
      allow: true,
      reason: `Max BLOCK count (${MAX_BLOCKS_PER_TURN}) reached; auto-escalating to operator with roadblock report.`,
      block_count: blockCount,
      override_used: false,
      override_reason: null
    };
  }

  // Block — but only if a permanent solve was reachable. If not, allow with gap notes.
  if (input.commitment && input.commitment.permanent_solve_reachable === false) {
    return {
      allow: true,
      reason: 'Permanent solve was not in scope for this turn; gaps logged for follow-up.',
      block_count: blockCount,
      override_used: false,
      override_reason: null
    };
  }

  const annotation = dataLossRiskBlocker
    ? ' [DATA-LOSS RISK — surfaces to operator regardless of auto-remediate]'
    : (autoRemediate ? ' [auto-remediate=1; loop back to TRANSFORM and apply recoveries automatically]' : '');

  return {
    allow: false,
    reason: `${blockers.length} blocker(s): ${blockers.map(([k]) => k).join(', ')}` + annotation,
    block_count: blockCount + 1,
    override_used: false,
    override_reason: null,
    auto_remediate: autoRemediate,
    data_loss_risk_blocker: dataLossRiskBlocker
  };
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch (err) {
    // Hook must never crash Claude Code. On parse failure, allow Stop and log.
    process.stderr.write(`[btoo-stop-gate] stdin parse failure: ${err.message}\n`);
    process.exit(0);
  }

  const turnId = input.turn_id || `unknown-${Date.now()}`;
  const verdict = {
    schema_version: SCHEMA_VERSION,
    turn_id: turnId,
    timestamp: nowIso(),
    operator: input.operator || 'unknown',
    commitment: input.commitment || { intent_summary: '', deliverables_promised: [], permanent_solve_reachable: false },
    delivery: input.delivery || { files_changed: [], tests_run: [], docs_updated: [] },
    principles: scorePrinciples(input),
    decision: null,
    auditor_findings: input.auditor || { tool_compliance: { total_calls: 0, disallowed_calls: 0 }, hallucination_flags: [], schema_violations: [] },
    trace: input.trace
  };
  verdict.decision = decide(verdict.principles, input);

  ensureDir(VERDICTS_DIR);
  const outPath = path.join(VERDICTS_DIR, `${verdict.timestamp.replace(/[:.]/g, '-')}-${turnId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));

  // Best-effort: index the verdict into the memory backend (Chroma + Postgres
  // via mempalace). Never blocks Stop on memory failure — fail-soft to JSONL
  // is built into the memory client.
  try {
    const memory = require('../memory/client');
    await memory.indexVerdict(verdict);
  } catch (err) {
    process.stderr.write(`[btoo-stop-gate] memory.indexVerdict failed: ${err.message}\n`);
  }

  if (verdict.decision.allow) {
    process.stdout.write(`[btoo] ALLOW: ${outPath}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`[btoo] BLOCK: ${verdict.decision.reason}\nVerdict: ${outPath}\n`);
    process.exit(2);
  }
}

main().catch((err) => {
  // Final safety net — never crash Claude Code.
  process.stderr.write(`[btoo-stop-gate] fatal: ${err.stack || err.message}\n`);
  process.exit(0);
});
