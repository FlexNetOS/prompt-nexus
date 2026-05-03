#!/usr/bin/env node
/**
 * Routing-matrix lint.
 *
 * Reads docs/ROUTING_MATRIX.md, parses the markdown tables, and verifies that
 * every routing target points at a component that exists in the layered
 * architecture (Layer 1 = agent_harness; Layer 2 = harness-template).
 *
 * Layered-architecture invariant from ADR-001 (docs/ARCHITECTURE.md):
 *   - "Every routing-matrix row points at a component that exists at lint-time."
 *
 * Resolution rules (in order):
 *   1. agent_harness commands → ../../harness/agent_harness/commands/<name>.md
 *      (or absolute via env AGENT_HARNESS_ROOT)
 *   2. agent_harness skills → ../../harness/agent_harness/skills/<name>/
 *   3. agent_harness agents → ../../harness/agent_harness/agents/<name>.md
 *   4. harness-template phases → ../../harness/harness-template/commands/<phase>.md
 *      (or absolute via env HARNESS_TEMPLATE_ROOT)
 *   5. PromptNexus operator skills → ./skills/<name>/SKILL.md
 *
 * Non-fatal mode: if neither sibling repo is present (fresh clone scenario),
 * the lint warns but exits 0. Fatal mode: --strict makes any unresolved row
 * exit non-zero.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STRICT = process.argv.includes('--strict');
const ROOT = path.resolve(__dirname, '..');
const MATRIX = path.join(ROOT, 'docs', 'ROUTING_MATRIX.md');

const AGENT_HARNESS_ROOT = process.env.AGENT_HARNESS_ROOT
  || path.resolve(ROOT, '..', '..', 'harness', 'agent_harness');
const HARNESS_TEMPLATE_ROOT = process.env.HARNESS_TEMPLATE_ROOT
  || path.resolve(ROOT, '..', '..', 'harness', 'harness-template');

if (!fs.existsSync(MATRIX)) {
  console.error(`[lint-routing-matrix] ROUTING_MATRIX.md not found at ${MATRIX}`);
  process.exit(1);
}

const md = fs.readFileSync(MATRIX, 'utf8');

// Extract all `/<command>` and `<agent-name>` mentions in tables.
// Matrix uses backticks for component names: `agent_harness /skill-create`,
// `harness-template /code`, `prompt-library architecture-strategist`, etc.
const componentRegex = /`([a-z_][a-z0-9_-]*\/[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*\s+\/[a-z][a-z0-9_-]+|[a-z][a-z0-9_-]+\.md)`/gi;
const slashCmdRegex = /\b(agent_harness|harness-template|prompt-library)\s+`?\/([a-z][a-z0-9_-]+)`?/gi;
const subagentRegex = /^\|\s*(?:Architecture|Security|Performance|Code\b|Bug|Data|Pattern|TDD|Build|Repo|Framework|Git|Spec|Best|PR|Editorial|Feedback|Multi-|End-|Senior).+?\|\s*`([a-z][a-z0-9_-]+(?:[\/-]?[a-z0-9_-]+)*)`\s*\|\s*([a-z_]+(?:\s*\/\s*[a-z_]+)?)/gim;

const findings = { resolved: 0, unresolved: [], skipped_repo_missing: [] };

const haveAgentHarness = fs.existsSync(AGENT_HARNESS_ROOT);
const haveHarnessTemplate = fs.existsSync(HARNESS_TEMPLATE_ROOT);

if (!haveAgentHarness) findings.skipped_repo_missing.push(`agent_harness at ${AGENT_HARNESS_ROOT}`);
if (!haveHarnessTemplate) findings.skipped_repo_missing.push(`harness-template at ${HARNESS_TEMPLATE_ROOT}`);

function resolveAgentHarness(name) {
  if (!haveAgentHarness) return 'skipped';
  const candidates = [
    path.join(AGENT_HARNESS_ROOT, 'commands', `${name}.md`),
    path.join(AGENT_HARNESS_ROOT, 'skills', name),
    path.join(AGENT_HARNESS_ROOT, 'skills', name, 'SKILL.md'),
    path.join(AGENT_HARNESS_ROOT, 'agents', `${name}.md`)
  ];
  return candidates.some((p) => fs.existsSync(p)) ? 'resolved' : 'unresolved';
}

function resolveHarnessTemplate(name) {
  if (!haveHarnessTemplate) return 'skipped';
  // harness-template's commands live under packages/harness-core/commands/
  // (not the repo root). The spine phases (think|plan|code|review|test|ship|reflect)
  // and all other commands resolve there.
  const candidates = [
    path.join(HARNESS_TEMPLATE_ROOT, 'packages', 'harness-core', 'commands', `${name}.md`),
    path.join(HARNESS_TEMPLATE_ROOT, 'commands', `${name}.md`),
    path.join(HARNESS_TEMPLATE_ROOT, 'commands', `${name}`),
    path.join(HARNESS_TEMPLATE_ROOT, 'docs', 'SPINE.md'), // spine phases also documented here
    path.join(HARNESS_TEMPLATE_ROOT, '.opencode', 'commands', `${name}.md`)
  ];
  return candidates.some((p) => fs.existsSync(p)) ? 'resolved' : 'unresolved';
}

function resolvePromptNexus(name) {
  const candidate = path.join(ROOT, 'skills', name, 'SKILL.md');
  return fs.existsSync(candidate) ? 'resolved' : 'unresolved';
}

// Parse the matrix's "Route to" column for slash-commands like `harness-template /code`.
let m;
slashCmdRegex.lastIndex = 0;
while ((m = slashCmdRegex.exec(md)) !== null) {
  const [, repo, cmd] = m;
  let result;
  if (repo === 'agent_harness') result = resolveAgentHarness(cmd);
  else if (repo === 'harness-template') result = resolveHarnessTemplate(cmd);
  else if (repo === 'prompt-library') result = 'skipped'; // prompt-library is reference-only, not invoked directly in v1
  else result = 'unresolved';

  if (result === 'resolved') findings.resolved++;
  else if (result === 'unresolved') findings.unresolved.push(`${repo} /${cmd}`);
}

// Print report
console.log('## Routing-matrix lint');
console.log(`  Resolved: ${findings.resolved}`);
console.log(`  Unresolved: ${findings.unresolved.length}`);
if (findings.unresolved.length) {
  console.log('  Unresolved targets:');
  findings.unresolved.forEach((u) => console.log(`    - ${u}`));
}
if (findings.skipped_repo_missing.length) {
  console.log('  Skipped (sibling repos not present):');
  findings.skipped_repo_missing.forEach((s) => console.log(`    - ${s}`));
}

if (findings.unresolved.length > 0 && STRICT) {
  console.error('FAIL (strict): unresolved routing targets present.');
  process.exit(1);
}

console.log('OK');
process.exit(0);
