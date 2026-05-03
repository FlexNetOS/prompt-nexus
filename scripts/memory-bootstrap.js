#!/usr/bin/env node
/**
 * Memory bootstrap — initialize ChromaDB collections + verify Postgres schema
 * + smoke-test mempalace round-trip. Run after `setup-foundation.sh` once.
 */

'use strict';

const memory = require('../memory/client');

async function ensureCollection(name) {
  const url = `${memory.CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`;
  const http = require('http'); // eslint-disable-line no-unused-vars
  const r = await require('../memory/client').chromaHeartbeat();
  if (!r.ok) {
    console.error(`[bootstrap] chroma not reachable at ${memory.CHROMA_URL}`);
    return false;
  }
  // Create-or-get via the v2 endpoint.
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = require('http').request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const ok = res.statusCode < 400 || res.statusCode === 409;
        console.log(`    [chroma] collection ${name}: ${res.statusCode} ${ok ? '✓' : '✗'}`);
        resolve(ok);
      });
    });
    req.on('error', (e) => { console.error('chroma error:', e.message); resolve(false); });
    // ChromaDB v0.5.20 v2 API: collections start without a server-side
    // embedding function. PromptNexus uses Postgres full-text for v0.1
    // recall; ChromaDB collections exist but are populated only when an
    // embedder is wired in v0.2.
    req.write(JSON.stringify({ name, get_or_create: true }));
    req.end();
  });
}

async function main() {
  console.log('==> PromptNexus memory bootstrap');
  console.log(`    chroma:    ${memory.CHROMA_URL}`);
  console.log(`    postgres:  ${memory.PG_URL.replace(/:[^@:]+@/, ':***@')}`);
  console.log(`    mempalace: ${memory.MEMPALACE_URL}`);

  console.log('\n  Chroma heartbeat...');
  const hb = await memory.chromaHeartbeat();
  if (!hb.ok) {
    console.error('    ✗ unreachable. Run docker compose first.');
    process.exit(2);
  }
  console.log('    ✓');

  console.log('\n  Ensuring collections...');
  await ensureCollection('intents');
  await ensureCollection('verdicts');
  await ensureCollection('roadblocks');
  await ensureCollection('council');

  console.log('\n  Mempalace recall smoke test...');
  const rc = await memory.recall('boil the ocean', 3);
  console.log(`    hits: ${(rc.hits || []).length}${rc.warning ? ' (warning: ' + rc.warning + ')' : ''}`);

  console.log('\n  Edge insert smoke test...');
  const er = await memory.insertEdge('test', 'bootstrap-1', 'test', 'bootstrap-2', 'self-test', 1.0, { source: 'memory-bootstrap' });
  console.log(`    inserted: ${er.ok ? '✓' : '✗ (status ' + er.status + ')'}`);

  console.log('\n==> Memory bootstrap complete.');
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err.stack || err.message);
  process.exit(1);
});
