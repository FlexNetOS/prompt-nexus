// Intent BAML schema — Popeye's classification output.
//
// BAML reference: BoundaryML/baml. This file defines a typed function
// `ClassifyIntent` that takes an utterance + recent history and returns a
// validated Intent object. Popeye's hook calls this function via the BAML
// runtime; QueenB reads the resulting Intent from disk.

class Intent {
  type IntentType
  content string @description("The original utterance, verbatim.")
  urgency Urgency
  scope_hint ScopeHint? @description("If type=request|problem, the routing scope. Null for aside/off-topic.")
  refinement_of string? @description("Turn ID of the prior turn this refines, if any.")
  confidence float @description("Classifier confidence 0.0-1.0. Below 0.6 should be re-classified or escalated.")
  reasoning string @description("One-sentence justification for the type and scope_hint choice.")
}

enum IntentType {
  request    @description("Operator wants something done.")
  aside      @description("Conversational filler, observation, or comment without an actionable ask.")
  problem    @description("Operator describes a roadblock, error, or symptom requiring diagnosis.")
  off_topic  @description("Personal, social, or unrelated to the work.")
}

enum Urgency {
  low        @description("Whenever — no time pressure.")
  normal     @description("Default — should be handled this session.")
  high       @description("Should be handled this turn or next.")
  emergency  @description("Drop everything — production breakage, data loss risk, security issue.")
}

enum ScopeHint {
  code       @description("Source code change or generation.")
  docs       @description("Documentation, README, runbook, ADR.")
  ops        @description("Operational task — running a known procedure.")
  host       @description("Host-environment issue (Windows, Docker, OS config).")
  prompt     @description("Prompt engineering, BTOO mandate, persona tuning.")
  planning   @description("Planning, scoping, breaking down work.")
  review     @description("Code review, design review, plan review.")
  test       @description("Testing, TDD, eval harness, regression check.")
  ship       @description("Commit, PR, deploy, release.")
  research   @description("Codebase archaeology, pattern extraction, external research.")
}

class ClassifyInput {
  utterance string @description("The new operator utterance.")
  history string[] @description("Last 5 turns (operator + assistant), most recent last. May be empty.")
  prior_intents string[] @description("Last 5 classified intent types, most recent last. May be empty.")
}

function ClassifyIntent(input: ClassifyInput) -> Intent {
  client Haiku45  // Configured to claude-haiku-4-5-20251001
  prompt #"
    You are Popeye, the conversation classifier for PromptNexus.

    Read the operator's utterance, the recent conversation history, and the
    prior intent types. Classify the utterance using the Intent schema.

    Rules:
    1. If the utterance describes a roadblock, error, or symptom (e.g. "the
       system is acting up", "this isn't working", "I'm stuck on X"), choose
       type=problem.
    2. If the utterance asks for an action ("write X", "fix Y", "run Z"),
       choose type=request.
    3. If the utterance is conversational without an actionable ask
       ("interesting", "thanks", "yeah that makes sense"), choose type=aside.
    4. If the utterance is unrelated to the work entirely, choose
       type=off_topic.
    5. For type=request|problem, ALWAYS pick a scope_hint. Do not leave it
       null. If unclear, pick the closest match and lower confidence.
    6. urgency=emergency only when the operator explicitly signals it
       (production down, data loss, security breach, "now", "right now",
       "asap"). Default to normal.
    7. refinement_of is set only when the utterance is clearly continuing
       the prior turn ("also", "and", "actually, change that to", "instead").
       Otherwise null.
    8. confidence below 0.6 should reflect genuine ambiguity. Do not
       artificially deflate to seem humble.

    Utterance: {{ input.utterance }}

    Recent history (oldest first):
    {% for turn in input.history %}
    - {{ turn }}
    {% endfor %}

    Prior intent types (oldest first): {{ input.prior_intents }}

    Respond ONLY with the Intent object. No prose.

    {{ ctx.output_format }}
  "#
}

// Tests — synthetic utterances Popeye must handle correctly.
test request_code {
  functions [ClassifyIntent]
  args {
    input {
      utterance "Write a hook that scores a turn against the 9 BTOO principles."
      history []
      prior_intents []
    }
  }
  // Expected: type=request, scope_hint=code, urgency=normal, confidence>=0.85
}

test problem_host {
  functions [ClassifyIntent]
  args {
    input {
      utterance "The system is acting up — Docker won't start the container."
      history []
      prior_intents []
    }
  }
  // Expected: type=problem, scope_hint=host, urgency=high, confidence>=0.8
}

test aside {
  functions [ClassifyIntent]
  args {
    input {
      utterance "Yeah that makes sense, the layered architecture is the right call."
      history []
      prior_intents ["request"]
    }
  }
  // Expected: type=aside, scope_hint=null, urgency=low, confidence>=0.85
}

test refinement {
  functions [ClassifyIntent]
  args {
    input {
      utterance "Actually, change Haiku to Sonnet for the listener."
      history ["operator: Use Haiku for the listener.", "assistant: Done — wired into the hook."]
      prior_intents ["request"]
    }
  }
  // Expected: type=request, scope_hint=code, refinement_of=<prior turn id>, confidence>=0.8
}

test off_topic {
  functions [ClassifyIntent]
  args {
    input {
      utterance "Can you recommend a coffee shop nearby?"
      history []
      prior_intents []
    }
  }
  // Expected: type=off_topic, scope_hint=null, urgency=low, confidence>=0.9
}

test emergency {
  functions [ClassifyIntent]
  args {
    input {
      utterance "Production is down RIGHT NOW — users can't log in."
      history []
      prior_intents []
    }
  }
  // Expected: type=problem, scope_hint=ops, urgency=emergency, confidence>=0.9
}
