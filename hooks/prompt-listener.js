#!/usr/bin/env node
/**
 * Popeye conversation listener — UserPromptSubmit hook.
 *
 * Reads the operator's prompt from stdin (Claude Code hook contract: JSON
 * payload with at minimum `prompt` field), classifies via Haiku 4.5 with
 * BAML-shaped output, falls back to keyword classifier on failure or budget
 * exhaustion, persists the intent to disk + memory backend, and prints a
 * single context-injection line to stdout that Claude Code prepends to the
 * assistant's context as a system note.
 *
 * Wiring (user-global ~/.claude/settings.json):
 *   {
 *     "hooks": {
 *       "UserPromptSubmit": [{
 *         "matcher": ".*",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node C:/Users/.../prompt-nexus/hooks/prompt-listener.js"
 *         }]
 *       }]
 *     }
 *   }
 *
 * Latency budget: p95 ≤ 1.2s. On timeout, fall back to keyword classifier.
 * Cost ceiling: hard-stops at $1/day default (env: PROMPTNEXUS_LISTENER_DAILY_USD).
 *
 * Always exits 0 — never blocks Claude Code. Errors are logged to stderr.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { classifyFallback } = require('../subagents/popeye-listener/classifier-fallback');

// ---------- Configuration ----------
const PNX_ROOT = path.resolve(__dirname, '..');
const INTENTS_DIR = path.join(PNX_ROOT, 'evals', 'intents');
const BUDGET_FILE = path.join(PNX_ROOT, 'evals', '.listener-budget.json');
const SKIP_GLOBS = (process.env.PROMPTNEXUS_LISTENER_SKIP_GLOBS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DAILY_USD_CAP = Number(process.env.PROMPTNEXUS_LISTENER_DAILY_USD || '1');
const HAIKU_MODEL = process.env.PROMPTNEXUS_LISTENER_MODEL || 'claude-haiku-4-5-20251001';
const HAIKU_TIMEOUT_MS = Number(process.env.PROMPTNEXUS_LISTENER_TIMEOUT_MS || '1100');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

// Approximate Haiku 4.5 pricing (USD per 1M tokens) — adjust as pricing changes.
const HAIKU_INPUT_USD_PER_M = 1.0;
const HAIKU_OUTPUT_USD_PER_M = 5.0;

// ---------- Helpers ----------
function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function shouldSkip(cwd) {
  if (!cwd || !SKIP_GLOBS.length) return false;
  const normalized = cwd.replace(/\\/g, '/');
  return SKIP_GLOBS.some((g) => {
    const re = new RegExp('^' + g
      .replace(/\\/g, '/')
      .replace(/[.+^${}()|[\]]/g, '\\$&')
      .replace(/\*\*/g, '___DOUBLESTAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/___DOUBLESTAR___/g, '.*') + '$');
    return re.test(normalized);
  });
}

function readBudget() {
  try {
    const raw = fs.readFileSync(BUDGET_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { day: '', spent_usd: 0 };
  }
}

function writeBudget(budget) {
  try {
    ensureDir(path.dirname(BUDGET_FILE));
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(budget));
  } catch (err) {
    process.stderr.write(`[listener] budget write failed: ${err.message}\n`);
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function budgetExhausted() {
  const b = readBudget();
  if (b.day !== todayKey()) return false; // new day, reset on next charge
  return b.spent_usd >= DAILY_USD_CAP;
}

function chargeBudget(usd) {
  const b = readBudget();
  if (b.day !== todayKey()) {
    b.day = todayKey();
    b.spent_usd = 0;
  }
  b.spent_usd += usd;
  writeBudget(b);
}

// ---------- Haiku call ----------
function callHaiku(promptText, history) {
  return new Promise((resolve) => {
    if (!ANTHROPIC_API_KEY) {
      return resolve({ error: 'no-api-key' });
    }
    const body = JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildUserMessage(promptText, history) }
      ]
    });
    const u = new URL(ANTHROPIC_BASE_URL + '/v1/messages');
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': ANTHROPIC_API_KEY,
        'Anthropic-Version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: HAIKU_TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return resolve({ error: `haiku-${res.statusCode}` });
        }
        try {
          resolve({ ok: true, body: JSON.parse(data) });
        } catch (err) {
          resolve({ error: 'haiku-parse', detail: err.message });
        }
      });
    });
    req.on('error', (err) => resolve({ error: 'haiku-network', detail: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'haiku-timeout' }); });
    req.write(body);
    req.end();
  });
}

const SYSTEM_PROMPT = `You are Popeye, the conversation classifier for PromptNexus.
Read the operator's utterance and classify it using the Intent schema.

Rules:
1. type=problem when operator describes a roadblock/error/symptom (e.g. "the system is acting up").
2. type=request when operator asks for an action ("write X", "fix Y", "run Z").
3. type=aside when conversational without an actionable ask ("yeah", "thanks", "got it").
4. type=off_topic when unrelated to the work entirely.
5. For type=request|problem, ALWAYS pick a scope_hint from: code, docs, ops, host, prompt, planning, review, test, ship, research.
6. urgency=emergency only when explicitly signaled (production down, data loss, "right now", "asap"). Default normal.
7. confidence below 0.6 reflects genuine ambiguity.

Respond ONLY with a JSON object. No prose. Schema:
{"type":"...","scope_hint":"..." or null,"urgency":"...","confidence":0.0-1.0,"reasoning":"one sentence"}`;

function buildUserMessage(promptText, history) {
  const recent = (history || []).slice(-3).join('\n  ');
  return `Utterance: ${promptText}\n\nRecent history (last 3 turns):\n  ${recent || '(none)'}`;
}

function parseHaikuResponse(haikuRes, promptText) {
  const content = haikuRes.body && haikuRes.body.content && haikuRes.body.content[0] && haikuRes.body.content[0].text;
  if (!content) return null;
  // Strip markdown fences if Haiku wrapped them.
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    // Validate shape against the Intent schema.
    const validTypes = ['request', 'aside', 'problem', 'off_topic'];
    const validUrgency = ['low', 'normal', 'high', 'emergency'];
    const validScopes = ['code', 'docs', 'ops', 'host', 'prompt', 'planning', 'review', 'test', 'ship', 'research', null];
    if (!validTypes.includes(parsed.type)) return null;
    if (!validUrgency.includes(parsed.urgency)) return null;
    if (!validScopes.includes(parsed.scope_hint)) parsed.scope_hint = null;
    if (typeof parsed.confidence !== 'number') parsed.confidence = 0.7;
    parsed.content = promptText;
    return parsed;
  } catch {
    return null;
  }
}

function estimateUsd(haikuRes) {
  const usage = haikuRes.body && haikuRes.body.usage;
  if (!usage) return 0;
  const inUsd = (usage.input_tokens || 0) / 1_000_000 * HAIKU_INPUT_USD_PER_M;
  const outUsd = (usage.output_tokens || 0) / 1_000_000 * HAIKU_OUTPUT_USD_PER_M;
  return inUsd + outUsd;
}

// ---------- Memory backend (best-effort; never blocks the hook) ----------
async function indexIntentToMemory(intent) {
  try {
    const memory = require('../memory/client');
    await memory.indexIntent(intent);
  } catch (err) {
    process.stderr.write(`[listener] memory.indexIntent failed: ${err.message}\n`);
  }
}

// ---------- Main ----------
(async function main() {
  const startMs = Date.now();
  let payload = {};
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[listener] stdin parse failure: ${err.message}\n`);
    process.exit(0);
  }

  const promptText = payload.prompt || payload.user_prompt || payload.input || '';
  const cwd = payload.cwd || process.cwd();
  const turnId = payload.turn_id || `turn-${Date.now()}`;

  if (!promptText.trim()) {
    process.exit(0);
  }
  if (shouldSkip(cwd)) {
    process.exit(0);
  }

  // History: read most recent intents for context (best-effort).
  let history = [];
  try {
    if (fs.existsSync(INTENTS_DIR)) {
      const files = fs.readdirSync(INTENTS_DIR).sort().slice(-3);
      history = files.map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, f), 'utf8'));
          return `[${j.type}/${j.scope_hint || '-'}] ${(j.content || '').slice(0, 80)}`;
        } catch {
          return null;
        }
      }).filter(Boolean);
    }
  } catch {}

  // Decide path: Haiku or fallback.
  let intent = null;
  let backend = 'fallback';
  if (ANTHROPIC_API_KEY && !budgetExhausted()) {
    const haikuRes = await callHaiku(promptText, history);
    if (haikuRes.ok) {
      intent = parseHaikuResponse(haikuRes, promptText);
      if (intent) {
        backend = 'haiku-4.5';
        chargeBudget(estimateUsd(haikuRes));
      }
    }
  }
  if (!intent) {
    const fb = classifyFallback(promptText);
    intent = {
      type: fb.type,
      scope_hint: fb.scope_hint,
      urgency: fb.urgency,
      content: promptText,
      confidence: 0.55,
      reasoning: 'keyword fallback (Haiku unavailable, timed out, or budget exhausted)'
    };
    backend = 'fallback';
  }

  // Persist intent to disk.
  ensureDir(INTENTS_DIR);
  const intentRecord = {
    schema_version: '1.0.0',
    turn_id: turnId,
    operator: payload.operator || 'david',
    timestamp: nowIso(),
    cwd,
    backend,
    duration_ms: Date.now() - startMs,
    ...intent
  };
  const outFile = path.join(INTENTS_DIR, `${intentRecord.timestamp.replace(/[:.]/g, '-')}-${turnId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(intentRecord, null, 2));

  // Best-effort: index into memory backend (Chroma + Postgres via mempalace).
  await indexIntentToMemory(intentRecord);

  // Fire QueenB async (fire-and-forget). Plan lands on the next turn via
  // evals/plans/<turn>.json which the listener reads as part of history.
  if (intent.type === 'request' || intent.type === 'problem') {
    fireQueenBAsync(intentRecord);
  }

  // Read any plan from the prior turn for context-injection.
  const priorPlan = readPriorPlan();

  // Read the most recent verdict so the directive carries BTOO state forward.
  const priorVerdict = readLastVerdict();

  // Operator-facing concise log line on stderr (was stdout in v0.1).
  process.stderr.write(`INTENT: ${intent.type} | scope=${intent.scope_hint || '-'} | urgency=${intent.urgency} | conf=${intent.confidence.toFixed(2)} | backend=${backend}\n`);

  // Inject the full PROMPTNEXUS DIRECTIVE block on stdout — Claude Code
  // injects this into the assistant's context as a system note. This is
  // how PromptNexus issues directives to Claude.
  process.stdout.write(renderDirective({
    turnId, intent, backend,
    plan: priorPlan,
    verdict: priorVerdict
  }));
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`[listener] fatal: ${err.stack || err.message}\n`);
  process.exit(0);
});

function fireQueenBAsync(intentRecord) {
  try {
    const { spawn } = require('child_process');
    const queenbScript = path.join(PNX_ROOT, 'scripts', 'queenb-invoke.js');
    if (!fs.existsSync(queenbScript)) return;
    const child = spawn(process.execPath, [queenbScript], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env
    });
    child.stdin.write(JSON.stringify({ intent: intentRecord, recall: [] }));
    child.stdin.end();
    child.unref();
  } catch (err) {
    process.stderr.write(`[listener] queenb spawn failed: ${err.message}\n`);
  }
}

function readPriorPlan() {
  try {
    const plansDir = path.join(PNX_ROOT, 'evals', 'plans');
    if (!fs.existsSync(plansDir)) return null;
    const files = fs.readdirSync(plansDir).filter((f) => f.endsWith('.json')).sort();
    const latest = files[files.length - 1];
    if (!latest) return null;
    const stat = fs.statSync(path.join(plansDir, latest));
    // Only inject plans that landed within the last 5 minutes (otherwise stale).
    if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) return null;
    return JSON.parse(fs.readFileSync(path.join(plansDir, latest), 'utf8'));
  } catch {
    return null;
  }
}

function readLastVerdict() {
  try {
    const dir = path.join(PNX_ROOT, 'evals', 'verdicts');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(-1);
    if (!files.length) return null;
    const v = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    return {
      turn_id: v.turn_id,
      allow: v.decision && v.decision.allow,
      reason: ((v.decision && v.decision.reason) || '').slice(0, 140),
      override_used: !!(v.decision && v.decision.override_used),
      data_loss_risk: !!(v.decision && v.decision.data_loss_risk_blocker),
      block_count: (v.decision && v.decision.block_count) || 0
    };
  } catch {
    return null;
  }
}

const SCOPE_TO_ROUTE = {
  code:     'harness-template /code',
  docs:     'agent_harness /update-docs OR /skill-create',
  ops:      'agent_harness /runbook',
  host:     'PromptNexus skills/host-environment-doctor',
  prompt:   'PromptNexus skills/btoo-check + agent_harness /skill-create',
  planning: 'harness-template /plan OR agent_harness /blueprint',
  review:   'harness-template /review',
  test:     'harness-template /test',
  ship:     'harness-template /ship',
  research: 'agent_harness /learn + repo-research-analyst'
};

function renderDirective({ turnId, intent, backend, plan, verdict }) {
  const out = [];
  out.push('');
  out.push('## PROMPTNEXUS DIRECTIVE');
  out.push(`turn=${turnId} · classifier=${backend} · backend=mempalace`);
  out.push(`INTENT: ${intent.type} · scope=${intent.scope_hint || '-'} · urgency=${intent.urgency} · conf=${intent.confidence.toFixed(2)}`);
  const route = intent.scope_hint ? SCOPE_TO_ROUTE[intent.scope_hint] : null;
  if (route) out.push(`ROUTE: ${route}`);
  if (plan) {
    out.push(`QUEENB-PLAN: ${plan.plan.route.layer} ${plan.plan.route.target} · ${plan.plan.phases.length} phase(s) · conf=${plan.plan.confidence.toFixed(2)}`);
  }
  if (verdict) {
    out.push(`LAST VERDICT: ${verdict.allow ? 'ALLOW' : 'BLOCK'} (turn=${verdict.turn_id}, blocks=${verdict.block_count}, override=${verdict.override_used ? 'yes' : 'no'}, dlr=${verdict.data_loss_risk ? 'yes' : 'no'})`);
    if (!verdict.allow) out.push(`  reason: ${verdict.reason}`);
  } else {
    out.push('LAST VERDICT: (none — first turn or no verdicts yet)');
  }

  out.push('');
  out.push('DIRECTIVE FROM PROMPTNEXUS:');
  if (intent.type === 'problem' && intent.urgency === 'emergency') {
    out.push('- EMERGENCY classification. Drop everything else; route through skills/host-environment-doctor (scope=host) or agent_harness /runbook (scope=ops).');
    out.push('- Investigate read-only first. Mutation gates apply unless data-loss-class.');
  }
  if (intent.scope_hint === 'host') {
    out.push('- HOST-class request. Operator\'s Claude Code session is OUTSIDE the .vhdx (Substrate, docs/ARCHITECTURE.md). Do not assume container reachability without checking. WSL is the path to unhindered access.');
  }
  if (verdict && !verdict.allow && !verdict.override_used) {
    out.push(`- PREVIOUS TURN BLOCKED. Resolve the BTOO blocker before opening new work: "${verdict.reason}".`);
  }
  if (verdict && verdict.data_loss_risk) {
    out.push('- PREVIOUS TURN flagged data-loss-risk. Surface destructive ops to operator regardless of BTOO_AUTO_REMEDIATE.');
  }
  if (route) out.push(`- Route this work to: ${route}`);
  if (plan) out.push('- A QueenB plan from a recent turn is in flight; honor it unless the operator overrides.');
  out.push('- Boil-the-Ocean is enforced at Stop. Partial deliveries BLOCK unless permanent_solve_reachable=false.');
  out.push('');
  out.push('Course-correction: if you catch yourself "flagging things outside your reach," you have the wrong tool selection. Re-route. PromptNexus is the coworker — use the harness, do not narrate around it.');
  out.push('');
  return out.join('\n');
}
