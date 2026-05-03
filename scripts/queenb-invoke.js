#!/usr/bin/env node
/**
 * QueenB invocation harness.
 *
 * Called from hooks/prompt-listener.js after Popeye classifies an intent.
 * Delivers a routed plan that pairs the Intent with a target on the routing
 * matrix (harness-template spine phase or agent_harness catalog command).
 *
 * Async by design: the listener fires QueenB and returns immediately. The
 * plan lands on the *next* turn as a context note (via evals/plans/<turn>.json
 * which the listener reads as part of its history pull).
 *
 * Latency budget: not bound to listener's 1.2s p95. QueenB can take up to
 * 8s p95 because it runs against Sonnet 4.6 with the full routing matrix.
 *
 * Inputs (CLI args or stdin JSON):
 *   { intent: <Intent object>, recall: [<related prior intents>] }
 *
 * Output:
 *   evals/plans/<turn_id>.json — signed plan JSON.
 *
 * Always exits 0 — never blocks the listener.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const PNX_ROOT = path.resolve(__dirname, '..');
const PLANS_DIR = path.join(PNX_ROOT, 'evals', 'plans');
const ROUTING_MATRIX_PATH = path.join(PNX_ROOT, 'docs', 'ROUTING_MATRIX.md');
const QUEENB_PERSONA_PATH = path.join(PNX_ROOT, 'personas', 'queenb.md');

const SONNET_MODEL = process.env.PROMPTNEXUS_QUEENB_MODEL || 'claude-sonnet-4-6';
const QUEENB_TIMEOUT_MS = Number(process.env.PROMPTNEXUS_QUEENB_TIMEOUT_MS || '8000');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

const SYSTEM_PROMPT_HEADER = `You are QueenB, primary orchestrator of PromptNexus.

You receive a typed Intent from Popeye (Haiku) plus recent recall context.
Your job: produce a SIGNED PLAN that maps the Intent to a concrete target
on the routing matrix and breaks the work into ordered steps.

Always respect the layered architecture (ADR-001):
  Layer 3 — PromptNexus (operator)        ← that's you
  Layer 2 — harness-template (the spine)
  Layer 1 — agent_harness (the catalog)
You CALL Layer 1/2; you never duplicate them.

Boil-the-Ocean is mandatory: every plan ships the finished work, not a plan
to build it. The 9 principles are non-negotiable; partial work loops back
to TRANSFORM.

Routing matrix (read this and route accordingly):
{{ROUTING_MATRIX}}

Output ONLY a JSON object matching this schema:
{
  "intent_summary": "string",
  "route": {
    "layer": "harness-template" | "agent_harness" | "prompt-nexus",
    "target": "<command or skill name>",
    "rationale": "string"
  },
  "phases": [
    {"phase_id": "string", "summary": "string", "exit_criteria": ["string"]}
  ],
  "sub_agents": ["<from the matrix's specialist catalog>"],
  "permanent_solve_reachable": true | false,
  "estimated_duration_minutes": number,
  "data_loss_risk": false,
  "confidence": 0.0-1.0
}
No prose. JSON only.`;

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

function loadRoutingMatrix() {
  try {
    return fs.readFileSync(ROUTING_MATRIX_PATH, 'utf8');
  } catch {
    return '(routing matrix unavailable; default to /plan)';
  }
}

function callSonnet(systemPrompt, userMessage) {
  return new Promise((resolve) => {
    if (!ANTHROPIC_API_KEY) return resolve({ error: 'no-api-key' });
    const body = JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
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
      timeout: QUEENB_TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return resolve({ error: `sonnet-${res.statusCode}` });
        try { resolve({ ok: true, body: JSON.parse(data) }); }
        catch (err) { resolve({ error: 'sonnet-parse', detail: err.message }); }
      });
    });
    req.on('error', (err) => resolve({ error: 'sonnet-network', detail: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'sonnet-timeout' }); });
    req.write(body);
    req.end();
  });
}

function parseSonnetPlan(res) {
  const content = res.body && res.body.content && res.body.content[0] && res.body.content[0].text;
  if (!content) return null;
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const plan = JSON.parse(cleaned);
    return plan;
  } catch {
    return null;
  }
}

function fallbackPlan(intent) {
  // Static routing fallback when Sonnet is unavailable.
  const scopeRoute = {
    code: { layer: 'harness-template', target: '/code' },
    docs: { layer: 'agent_harness', target: '/update-docs' },
    ops: { layer: 'agent_harness', target: '/runbook' },
    host: { layer: 'prompt-nexus', target: 'host-environment-doctor' },
    prompt: { layer: 'prompt-nexus', target: 'btoo-check' },
    planning: { layer: 'harness-template', target: '/plan' },
    review: { layer: 'harness-template', target: '/review' },
    test: { layer: 'harness-template', target: '/test' },
    ship: { layer: 'harness-template', target: '/ship' },
    research: { layer: 'agent_harness', target: '/learn' }
  };
  const route = scopeRoute[intent.scope_hint] || { layer: 'harness-template', target: '/plan' };
  return {
    intent_summary: intent.content || '',
    route: { ...route, rationale: 'static fallback (Sonnet unavailable)' },
    phases: [{ phase_id: 'p1', summary: 'execute via target', exit_criteria: ['target completes'] }],
    sub_agents: [],
    permanent_solve_reachable: true,
    estimated_duration_minutes: 30,
    data_loss_risk: false,
    confidence: 0.5
  };
}

(async function main() {
  let payload = {};
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[queenb] stdin parse failure: ${err.message}\n`);
    process.exit(0);
  }
  const intent = payload.intent;
  const recall = payload.recall || [];
  if (!intent || !intent.turn_id) {
    process.stderr.write('[queenb] missing intent.turn_id\n');
    process.exit(0);
  }

  const startMs = Date.now();
  const routingMatrix = loadRoutingMatrix();
  const systemPrompt = SYSTEM_PROMPT_HEADER.replace('{{ROUTING_MATRIX}}', routingMatrix.slice(0, 8000));
  const userMessage = `INTENT:
${JSON.stringify(intent, null, 2)}

RECALL (recent related intents):
${JSON.stringify(recall, null, 2)}`;

  let plan = null;
  let backend = 'fallback';
  if (ANTHROPIC_API_KEY) {
    const sonnetRes = await callSonnet(systemPrompt, userMessage);
    if (sonnetRes.ok) {
      plan = parseSonnetPlan(sonnetRes);
      if (plan) backend = 'sonnet-4.6';
    }
  }
  if (!plan) {
    plan = fallbackPlan(intent);
  }

  const planRecord = {
    schema_version: '1.0.0',
    turn_id: intent.turn_id,
    operator: intent.operator || 'david',
    timestamp: new Date().toISOString(),
    backend,
    duration_ms: Date.now() - startMs,
    intent,
    plan
  };

  ensureDir(PLANS_DIR);
  const outFile = path.join(PLANS_DIR, `${planRecord.timestamp.replace(/[:.]/g, '-')}-${intent.turn_id}.json`);
  fs.writeFileSync(outFile, JSON.stringify(planRecord, null, 2));
  process.stdout.write(`[queenb] plan: ${outFile}\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`[queenb] fatal: ${err.stack || err.message}\n`);
  process.exit(0);
});
