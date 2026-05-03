/**
 * PromptNexus memory client — talks to ChromaDB + Postgres + Memory Palace.
 *
 * Used by:
 *   - hooks/btoo-stop-gate.js (writes verdicts to Postgres + indexes into Chroma)
 *   - subagents/popeye-listener/* (writes intents to Postgres + Chroma rolling history)
 *   - skills/cross-llm-council/* (writes council transcripts to Postgres)
 *   - skills/host-environment-doctor/* (writes roadblocks to Postgres)
 *
 * This is a thin wrapper — fail-soft: if a backend is down, log to stderr
 * and fall back to JSONL files in evals/. PromptNexus must never block on
 * memory unavailability.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const CHROMA_URL = process.env.PROMPTNEXUS_CHROMA_URL || 'http://localhost:8000';
const PG_URL = process.env.PROMPTNEXUS_PG_URL || 'postgresql://promptnexus:changeme-please@localhost:5432/promptnexus';
const MEMPALACE_URL = process.env.PROMPTNEXUS_MEMPALACE_URL || 'http://localhost:8077';
const FALLBACK_DIR = path.resolve(__dirname, '..', 'evals');

function fallbackJsonl(stream, record) {
  try {
    const dir = path.join(FALLBACK_DIR, stream);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'fallback.jsonl'), JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`[memory] fallback failed: ${err.message}\n`);
  }
}

function httpJson(method, url, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ''),
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ ok: res.statusCode < 400, status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ ok: false, status: res.statusCode, body: data }); }
        });
      });
      req.on('error', () => resolve({ ok: false, status: 0, body: null, network: true }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: null, timeout: true }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      resolve({ ok: false, status: 0, body: null, error: err.message });
    }
  });
}

async function chromaHeartbeat() {
  return httpJson('GET', `${CHROMA_URL}/api/v2/heartbeat`);
}

async function indexIntent(intent) {
  if (!intent || !intent.turn_id || !intent.content) return { skipped: true };
  // Route through mempalace which writes BOTH Chroma (vector) and Postgres
  // (structured). Without the Postgres write, mempalace recall returns
  // Chroma hits but can't pivot to structured rows — that's the regression
  // we hit on 2026-05-03.
  const r = await httpJson('POST', `${MEMPALACE_URL}/palace/index/intent`, {
    turn_id: intent.turn_id,
    content: intent.content,
    operator: intent.operator || 'david',
    type: intent.type || 'request',
    urgency: intent.urgency || 'normal',
    scope_hint: intent.scope_hint || null,
    confidence: typeof intent.confidence === 'number' ? intent.confidence : 0.7,
    reasoning: intent.reasoning || null,
    refinement_of: intent.refinement_of || null
  });
  if (!r.ok) fallbackJsonl('intents', intent);
  return r;
}

async function indexVerdict(verdict) {
  if (!verdict || !verdict.turn_id) return { skipped: true };
  const r = await httpJson('POST', `${MEMPALACE_URL}/palace/index/verdict`, {
    turn_id: verdict.turn_id,
    schema_version: verdict.schema_version || '1.0.0',
    operator: verdict.operator || 'david',
    decision: verdict.decision || {},
    principles: verdict.principles || {},
    commitment: verdict.commitment || {},
    delivery: verdict.delivery || {},
    auditor_findings: verdict.auditor_findings || {},
    trace: verdict.trace || null
  });
  if (!r.ok) fallbackJsonl('verdicts-indexed', { turn_id: verdict.turn_id });
  return r;
}

async function recall(query, topK = 5) {
  const r = await httpJson('POST', `${MEMPALACE_URL}/palace/recall`, { query, top_k: topK }, 10000);
  if (!r.ok) {
    return { hits: [], warning: r.network ? 'mempalace-unreachable' : `mempalace-${r.status}` };
  }
  return r.body || { hits: [] };
}

async function insertEdge(srcKind, srcId, dstKind, dstId, relation, weight = 1.0, metadata = null) {
  const r = await httpJson('POST', `${MEMPALACE_URL}/palace/edges`, {
    src_kind: srcKind, src_id: srcId, dst_kind: dstKind, dst_id: dstId, relation, weight, metadata
  });
  if (!r.ok) fallbackJsonl('palace-edges', { srcKind, srcId, dstKind, dstId, relation, weight, metadata });
  return r;
}

module.exports = {
  chromaHeartbeat,
  indexIntent,
  indexVerdict,
  recall,
  insertEdge,
  CHROMA_URL,
  PG_URL,
  MEMPALACE_URL
};
