#!/usr/bin/env node
/**
 * Listener test harness — runs synthetic utterances through a keyword
 * fallback classifier (the LLM-based path needs Haiku + BAML runtime, not
 * available offline). Intent is to validate the test corpus and the schema
 * shape without making API calls.
 *
 * When the BAML runtime is installed and configured, this same harness will
 * replay the corpus through the real ClassifyIntent function and compare
 * against expectations.
 */

'use strict';

const FIXTURES = [
  { utterance: 'Write a hook that scores a turn against the 9 BTOO principles.',
    expected: { type: 'request', scope_hint: 'code', urgency: 'normal' } },
  { utterance: 'The system is acting up — Docker won\'t start the container.',
    expected: { type: 'problem', scope_hint: 'host', urgency: 'high' } },
  { utterance: 'Yeah that makes sense, the layered architecture is the right call.',
    expected: { type: 'aside', scope_hint: null, urgency: 'low' } },
  { utterance: 'Production is down RIGHT NOW — users can\'t log in.',
    expected: { type: 'problem', scope_hint: 'ops', urgency: 'emergency' } },
  { utterance: 'Can you recommend a coffee shop nearby?',
    expected: { type: 'off_topic', scope_hint: null, urgency: 'low' } },
  { utterance: 'Add tests for the BTOO hook.',
    expected: { type: 'request', scope_hint: 'test', urgency: 'normal' } },
  { utterance: 'Update the README to reflect the new layered architecture.',
    expected: { type: 'request', scope_hint: 'docs', urgency: 'normal' } },
  { utterance: 'Plan out the next two weeks of work for PromptNexus.',
    expected: { type: 'request', scope_hint: 'planning', urgency: 'normal' } },
  { utterance: 'Review my latest commit for security issues.',
    expected: { type: 'request', scope_hint: 'review', urgency: 'normal' } },
  { utterance: 'Ship the BTOO machinery as v0.1.',
    expected: { type: 'request', scope_hint: 'ship', urgency: 'normal' } }
];

// Tiny keyword fallback classifier (mirrors classifier-fallback.js intent).
function classifyFallback(utt) {
  const u = utt.toLowerCase();

  // Emergency
  if (/(right now|asap|production is down|users can.t|data loss)/.test(u)) {
    return { type: 'problem', scope_hint: /production|users|deploy|ship/.test(u) ? 'ops' : 'host', urgency: 'emergency' };
  }
  // Off-topic
  if (/(coffee shop|recommend.*restaurant|weather|sports score)/.test(u)) {
    return { type: 'off_topic', scope_hint: null, urgency: 'low' };
  }
  // Aside
  if (/^(yeah|okay|sure|thanks|cool|interesting|got it|that makes sense)/.test(u)) {
    return { type: 'aside', scope_hint: null, urgency: 'low' };
  }
  // Problem
  if (/\b(acting up|won.?t|broken|stuck|error|fail|crash|isn.?t working)\b/.test(u)) {
    const scope = /\b(docker|container|wsl|window|host|file ?system)\b/.test(u) ? 'host'
      : /\b(deploy|production|release)\b/.test(u) ? 'ops'
      : 'code';
    const urg = /\b(now|urgent|asap)\b/.test(u) ? 'high'
      : /\b(won.?t start|broken|stuck|crash)\b/.test(u) ? 'high'
      : 'normal';
    return { type: 'problem', scope_hint: scope, urgency: urg };
  }
  // Request — explicit verbs take precedence over content keywords.
  // Order: action-verb scopes first; topic-only scopes last.
  const scope = /^review\b|\breview (my|the|this|that)\b|\bcritique\b|\baudit\b/.test(u) ? 'review'
    : /\b(tdd|unit test|tests? for|add tests|write tests|test coverage|e2e)\b/.test(u) ? 'test'
    : /^ship\b|\bship the\b|\bship it\b|\bcommit (this|that|the)\b|\bopen (a )?pr\b|\brelease\b|\bdeploy\b|\bmerge\b/.test(u) ? 'ship'
    : /\b(readme|update.*docs?|write.*docs?|runbook|adr|documentation)\b/.test(u) ? 'docs'
    : /\b(plan out|plan the|breakdown|roadmap)\b/.test(u) ? 'planning'
    : /\b(research|investigate|explore|find out)\b/.test(u) ? 'research'
    : /\b(tune the prompt|edit persona|btoo mandate|boil[- ]the[- ]ocean injection|prompt engineering)\b/.test(u) ? 'prompt'
    : 'code';
  return { type: 'request', scope_hint: scope, urgency: 'normal' };
}

let pass = 0, fail = 0;
const results = [];

for (const f of FIXTURES) {
  const got = classifyFallback(f.utterance);
  const ok = got.type === f.expected.type
    && got.scope_hint === f.expected.scope_hint
    && got.urgency === f.expected.urgency;
  if (ok) pass++; else fail++;
  results.push({ utt: f.utterance, expected: f.expected, got, ok });
}

console.log(`Listener fixtures (keyword fallback): ${pass}/${FIXTURES.length} pass`);
results.filter((r) => !r.ok).forEach((r) => {
  console.log(`  FAIL: ${r.utt}`);
  console.log(`    expected: ${JSON.stringify(r.expected)}`);
  console.log(`    got:      ${JSON.stringify(r.got)}`);
});

process.exit(fail === 0 ? 0 : 1);
