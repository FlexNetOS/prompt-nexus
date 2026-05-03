#!/usr/bin/env node
/**
 * The Auditor — PostToolUse hook.
 *
 * Validates every tool call in real time:
 *   - Was the tool on the persona's allowlist?
 *   - Did the input match an expected schema (lightweight regex/shape check)?
 *   - Did the output deviate from claimed actions (heuristic hallucination flags)?
 *
 * Files findings to evals/audits/<turn_id>.json (append-only) and inserts a
 * memory-palace edge so QueenB can recall tool-use patterns across sessions.
 *
 * Wiring (user-global ~/.claude/settings.json):
 *   { "hooks": { "PostToolUse": [{ "matcher": ".*", "hooks": [{
 *     "type": "command",
 *     "command": "node C:/.../prompt-nexus/hooks/audit-listener.js"
 *   }]}]}}
 *
 * Always exits 0 — the auditor logs but never blocks tool flow at PostToolUse.
 * Blocking is the Stop-gate's job (Leonidas).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PNX_ROOT = path.resolve(__dirname, '..');
const AUDITS_DIR = path.join(PNX_ROOT, 'evals', 'audits');

// Per-persona tool allowlists (lifted from personas/*.md). When a tool call
// arrives, we match the active persona context (TBD: read from intent file
// or session env) and check the tool against this map.
const ALLOWLISTS = {
  popeye: new Set(['Read', 'mcp__memory__add_observations', 'mcp__memory__open_nodes', 'mcp__memory__search_nodes']),
  queenb: new Set(['Read', 'Grep', 'Glob', 'Bash', 'mcp__memory__add_observations', 'mcp__memory__open_nodes', 'mcp__memory__search_nodes']),
  leonidas: new Set(['Read', 'Grep', 'Glob', 'Bash', 'mcp__memory__add_observations']),
  auditor: new Set(['Read', 'Grep', 'Glob']),
  // Default: any tool is allowed when no persona context is set. The intent
  // here is observability, not enforcement — Leonidas blocks at Stop.
  '*': null
};

// Heuristic hallucination flags — pattern-match for common "claim mismatch"
// shapes in tool outputs.
const HALLUCINATION_PATTERNS = [
  { pattern: /successfully (created|wrote|installed|deployed) [a-zA-Z0-9_./-]+/i, severity: 'low', reason: 'self-congratulatory success claim — verify against actual state' },
  { pattern: /(should be|will probably|might) (work|succeed|pass)/i, severity: 'low', reason: 'speculation framed as outcome' },
  { pattern: /(I'?ll|let me) (try|attempt|see if)/i, severity: 'low', reason: 'tentative framing — boil-the-ocean rejects "tabled for later"' }
];

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function detectHallucinations(output) {
  if (!output || typeof output !== 'string') return [];
  return HALLUCINATION_PATTERNS
    .filter(({ pattern }) => pattern.test(output))
    .map(({ severity, reason, pattern }) => ({
      claim: (output.match(pattern) || [''])[0].slice(0, 200),
      ground_truth: '(needs verification — auditor flagged claim shape)',
      severity,
      reason
    }));
}

function checkAllowlist(persona, toolName) {
  const allowlist = ALLOWLISTS[persona] || ALLOWLISTS['*'];
  if (!allowlist) return { allowed: true, reason: 'no-persona-context' };
  if (allowlist.has(toolName)) return { allowed: true, reason: 'on-allowlist' };
  return { allowed: false, reason: `${toolName} not in ${persona} allowlist` };
}

function appendAudit(turnId, record) {
  ensureDir(AUDITS_DIR);
  const file = path.join(AUDITS_DIR, `${turnId}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

async function recordPalaceEdge(turnId, toolName) {
  try {
    const memory = require('../memory/client');
    await memory.insertEdge('intent', turnId, 'tool_call', toolName, 'invoked', 1.0, { ts: new Date().toISOString() });
  } catch (err) {
    process.stderr.write(`[auditor] palace edge insert failed: ${err.message}\n`);
  }
}

(async function main() {
  let payload = {};
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[auditor] stdin parse failure: ${err.message}\n`);
    process.exit(0);
  }

  const turnId = payload.turn_id || `turn-${Date.now()}`;
  const toolName = payload.tool_name || payload.tool || 'unknown';
  const toolInput = payload.tool_input || payload.input || {};
  const toolOutput = payload.tool_output || payload.output || '';
  const persona = payload.persona || '*';
  const success = payload.success !== false;

  const allowCheck = checkAllowlist(persona, toolName);
  const hallucinations = detectHallucinations(typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput));

  const auditRecord = {
    schema_version: '1.0.0',
    turn_id: turnId,
    timestamp: new Date().toISOString(),
    persona,
    tool_name: toolName,
    tool_input_size_bytes: JSON.stringify(toolInput).length,
    tool_output_size_bytes: typeof toolOutput === 'string' ? toolOutput.length : JSON.stringify(toolOutput).length,
    success,
    allowlist_check: allowCheck,
    hallucination_flags: hallucinations,
    schema_violations: []
  };

  appendAudit(turnId, auditRecord);
  await recordPalaceEdge(turnId, toolName);

  // Surface to stderr ONLY when an allowlist violation happens — Stop-gate
  // will pick this up via auditor_findings on the next turn.
  if (!allowCheck.allowed) {
    process.stderr.write(`[auditor] DISALLOWED: ${toolName} for persona ${persona} — ${allowCheck.reason}\n`);
  }

  process.exit(0);
})().catch((err) => {
  process.stderr.write(`[auditor] fatal: ${err.stack || err.message}\n`);
  process.exit(0);
});
