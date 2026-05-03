/**
 * Popeye keyword classifier — used by hooks/prompt-listener.js as the fallback
 * when (a) Haiku times out / fails or (b) the daily token budget is exhausted.
 *
 * Source: lifted from subagents/popeye-listener/test/run-fixtures.js
 * (10/10 fixture pass rate; substring-collision fixes already in place).
 *
 * Output: { type, scope_hint, urgency } — a subset of the full Intent schema.
 * The caller wraps this with turn_id, content, confidence (set lower than the
 * Haiku call would produce — 0.55 default), reasoning ("keyword fallback").
 */

'use strict';

function classifyFallback(utterance) {
  const u = String(utterance || '').toLowerCase();

  // Emergency
  if (/(right now|asap|production is down|users can.t|data loss)/.test(u)) {
    const scope = /production|users|deploy|ship/.test(u) ? 'ops' : 'host';
    return { type: 'problem', scope_hint: scope, urgency: 'emergency' };
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

module.exports = { classifyFallback };
