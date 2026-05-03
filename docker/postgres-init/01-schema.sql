-- PromptNexus structured-memory schema (Postgres 17).
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Intent classifications from Popeye (mirrors evals/intents/<turn>.json).
CREATE TABLE IF NOT EXISTS intents (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id       TEXT         NOT NULL UNIQUE,
    operator      TEXT         NOT NULL,
    type          TEXT         NOT NULL CHECK (type IN ('request','aside','problem','off_topic')),
    content       TEXT         NOT NULL,
    urgency       TEXT         NOT NULL CHECK (urgency IN ('low','normal','high','emergency')),
    scope_hint    TEXT         CHECK (scope_hint IS NULL OR scope_hint IN ('code','docs','ops','host','prompt','planning','review','test','ship','research')),
    refinement_of TEXT,
    confidence    REAL         NOT NULL,
    reasoning     TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intents_operator_created ON intents (operator, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intents_type ON intents (type);
CREATE INDEX IF NOT EXISTS idx_intents_refinement ON intents (refinement_of) WHERE refinement_of IS NOT NULL;

-- BTOO verdicts from Leonidas (mirrors evals/verdicts/<turn>.json).
CREATE TABLE IF NOT EXISTS verdicts (
    id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id                  TEXT         NOT NULL,
    schema_version           TEXT         NOT NULL,
    operator                 TEXT         NOT NULL,
    decision_allow           BOOLEAN      NOT NULL,
    decision_reason          TEXT         NOT NULL,
    block_count              INTEGER      NOT NULL DEFAULT 0,
    override_used            BOOLEAN      NOT NULL DEFAULT FALSE,
    override_reason          TEXT,
    auto_remediate           BOOLEAN      NOT NULL DEFAULT FALSE,
    data_loss_risk_blocker   BOOLEAN      NOT NULL DEFAULT FALSE,
    principles               JSONB        NOT NULL,
    commitment               JSONB        NOT NULL,
    delivery                 JSONB        NOT NULL,
    auditor_findings         JSONB        NOT NULL,
    trace                    JSONB,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verdicts_turn ON verdicts (turn_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_operator_created ON verdicts (operator, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verdicts_block ON verdicts (decision_allow, override_used) WHERE NOT decision_allow;

-- Path-finder roadblocks (mirrors evals/roadblocks/<ts>.md, structured).
CREATE TABLE IF NOT EXISTS roadblocks (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id       TEXT,
    playbook_id   TEXT,
    symptom       TEXT         NOT NULL,
    diagnosis     TEXT,
    recovery      TEXT,
    recovered     BOOLEAN      NOT NULL DEFAULT FALSE,
    operator_note TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_roadblocks_unrecovered ON roadblocks (created_at DESC) WHERE NOT recovered;

-- Auditor findings stream (per-turn, real-time).
CREATE TABLE IF NOT EXISTS audits (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id             TEXT         NOT NULL,
    tool_call_count     INTEGER      NOT NULL DEFAULT 0,
    disallowed_count    INTEGER      NOT NULL DEFAULT 0,
    hallucination_flags JSONB        NOT NULL DEFAULT '[]'::jsonb,
    schema_violations   JSONB        NOT NULL DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audits_turn ON audits (turn_id);

-- Memory Palace edges (intent → verdict → outcome graph).
CREATE TABLE IF NOT EXISTS palace_edges (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    src_kind        TEXT         NOT NULL,
    src_id          TEXT         NOT NULL,
    dst_kind        TEXT         NOT NULL,
    dst_id          TEXT         NOT NULL,
    relation        TEXT         NOT NULL,
    weight          REAL         NOT NULL DEFAULT 1.0,
    metadata        JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_palace_src ON palace_edges (src_kind, src_id);
CREATE INDEX IF NOT EXISTS idx_palace_dst ON palace_edges (dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS idx_palace_relation ON palace_edges (relation);

-- Cross-LLM council transcripts (Codex / Gemini / Kimi).
CREATE TABLE IF NOT EXISTS council_sessions (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id         TEXT         NOT NULL,
    question        TEXT         NOT NULL,
    voices          JSONB        NOT NULL,
    synthesis       TEXT,
    decision        TEXT,
    cost_cents      INTEGER      NOT NULL DEFAULT 0,
    duration_ms     INTEGER,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_council_turn ON council_sessions (turn_id);

-- Override-rate window — materialized for the weekly audit query.
CREATE OR REPLACE VIEW v_override_rate_30d AS
SELECT
    operator,
    COUNT(*)                                   AS total_verdicts,
    COUNT(*) FILTER (WHERE override_used)      AS overrides,
    ROUND(100.0 * COUNT(*) FILTER (WHERE override_used) / NULLIF(COUNT(*), 0), 2) AS override_pct
FROM verdicts
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY operator;

-- Schema version marker.
CREATE TABLE IF NOT EXISTS _schema_version (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW());
INSERT INTO _schema_version VALUES ('1.0.0', NOW()) ON CONFLICT DO NOTHING;
