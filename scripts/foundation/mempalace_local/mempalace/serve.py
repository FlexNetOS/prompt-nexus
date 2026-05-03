"""Memory Palace service — FastAPI app on Postgres + ChromaDB.

This is the local fallback. The upstream `mempalace/mempalace` repo is
preferred when available; this provides API parity for v0.1.
"""

import argparse
import os
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

import chromadb
import psycopg
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

PG_URL = os.environ.get("MEMPALACE_PG_URL", "postgresql://promptnexus:changeme@postgres:5432/promptnexus")
CHROMA_URL = os.environ.get("MEMPALACE_CHROMA_URL", "http://chroma:8000")
EMBED_MODEL = os.environ.get("MEMPALACE_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
COLLECTIONS = ("intents", "verdicts", "roadblocks", "council")


def _embed(model: SentenceTransformer, texts: list[str]) -> list[list[float]]:
    return model.encode(texts, normalize_embeddings=True).tolist()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Lightweight HTTP client (no embedding function bundled). Embeddings are
    # computed in-process via sentence-transformers and passed to Chroma as
    # `query_embeddings` / `embeddings`.
    parsed = urlparse(CHROMA_URL)
    client = chromadb.HttpClient(host=parsed.hostname or "chroma", port=parsed.port or 8000)
    _app.state.chroma_client = client
    _app.state.collections = {name: client.get_or_create_collection(name=name) for name in COLLECTIONS}
    _app.state.embedder = SentenceTransformer(EMBED_MODEL)
    _app.state.pg_url = PG_URL
    yield


app = FastAPI(title="Memory Palace (PromptNexus local)", version="0.1.0+local", lifespan=lifespan)


class Edge(BaseModel):
    src_kind: str
    src_id: str
    dst_kind: str
    dst_id: str
    relation: str
    weight: float = 1.0
    metadata: dict[str, Any] | None = None


class RecallQuery(BaseModel):
    query: str
    top_k: int = 5
    operator: str | None = None


@app.get("/health")
def health():
    return {"status": "ok", "service": "mempalace", "version": "0.1.0-local"}


@app.post("/palace/edges")
def insert_edge(edge: Edge):
    try:
        with psycopg.connect(PG_URL, autocommit=True) as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO palace_edges (src_kind, src_id, dst_kind, dst_id, relation, weight, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    edge.src_kind,
                    edge.src_id,
                    edge.dst_kind,
                    edge.dst_id,
                    edge.relation,
                    edge.weight,
                    None if edge.metadata is None else __import__("json").dumps(edge.metadata),
                ),
            )
        return {"inserted": True, "edge": edge.model_dump()}
    except psycopg.Error as exc:
        raise HTTPException(500, f"pg error: {exc}") from exc


@app.post("/palace/recall")
async def recall(q: RecallQuery):
    """Vector recall via ChromaDB; pivots into structured rows via Postgres."""
    try:
        coll = app.state.collections["intents"]
        embedding = _embed(app.state.embedder, [q.query])[0]
        res = coll.query(query_embeddings=[embedding], n_results=q.top_k)
        hits = (res.get("ids") or [[]])[0]
        if not hits:
            return {"hits": [], "backend": "chroma-vector"}
        with psycopg.connect(PG_URL) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT turn_id, type, scope_hint, content, created_at FROM intents WHERE turn_id = ANY(%s)",
                (hits,),
            )
            rows = cur.fetchall()
        by_id = {r[0]: r for r in rows}
        ordered = [by_id[h] for h in hits if h in by_id]
        return {
            "hits": [
                {"turn_id": r[0], "type": r[1], "scope_hint": r[2], "content": r[3], "created_at": r[4].isoformat()}
                for r in ordered
            ],
            "backend": "chroma-vector",
        }
    except Exception as exc:  # noqa: BLE001 — recall must never crash the server
        return {"hits": [], "warning": str(exc)}


class IndexIntentRequest(BaseModel):
    turn_id: str
    content: str
    operator: str = "david"
    type: str = "request"
    urgency: str = "normal"
    scope_hint: str | None = None
    confidence: float = 0.7
    reasoning: str | None = None
    refinement_of: str | None = None
    metadata: dict[str, Any] | None = None


@app.post("/palace/index/intent")
def index_intent(req: IndexIntentRequest):
    """Index intent in Chroma (for vector recall) AND Postgres (for structured rows).

    Both writes happen; failure of one is logged but doesn't fail the other —
    PromptNexus's enforcer must never block on memory issues.
    """
    chroma_ok = False
    pg_ok = False
    errors = []

    # Chroma upsert
    try:
        embedding = _embed(app.state.embedder, [req.content])[0]
        meta = {
            "type": req.type,
            "scope_hint": req.scope_hint or "",
            "urgency": req.urgency,
            "operator": req.operator,
        }
        if req.metadata:
            meta.update({k: str(v) for k, v in req.metadata.items()})
        app.state.collections["intents"].upsert(
            ids=[req.turn_id],
            embeddings=[embedding],
            documents=[req.content],
            metadatas=[meta],
        )
        chroma_ok = True
    except Exception as exc:  # noqa: BLE001
        errors.append(f"chroma: {exc}")

    # Postgres upsert
    try:
        with psycopg.connect(PG_URL, autocommit=True) as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO intents (turn_id, operator, type, content, urgency, scope_hint, refinement_of, confidence, reasoning)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (turn_id) DO UPDATE SET
                    type = EXCLUDED.type,
                    content = EXCLUDED.content,
                    urgency = EXCLUDED.urgency,
                    scope_hint = EXCLUDED.scope_hint,
                    refinement_of = EXCLUDED.refinement_of,
                    confidence = EXCLUDED.confidence,
                    reasoning = EXCLUDED.reasoning
                """,
                (
                    req.turn_id, req.operator, req.type, req.content, req.urgency,
                    req.scope_hint, req.refinement_of, req.confidence, req.reasoning,
                ),
            )
        pg_ok = True
    except psycopg.Error as exc:
        errors.append(f"postgres: {exc}")

    if not chroma_ok and not pg_ok:
        raise HTTPException(500, f"both backends failed: {'; '.join(errors)}")
    return {"indexed": True, "turn_id": req.turn_id, "chroma": chroma_ok, "postgres": pg_ok, "errors": errors or None}


class IndexVerdictRequest(BaseModel):
    turn_id: str
    schema_version: str = "1.0.0"
    operator: str = "david"
    decision: dict[str, Any]
    principles: dict[str, Any]
    commitment: dict[str, Any]
    delivery: dict[str, Any]
    auditor_findings: dict[str, Any] = {}
    trace: dict[str, Any] | None = None


@app.post("/palace/index/verdict")
def index_verdict(req: IndexVerdictRequest):
    """Write verdict to Chroma (vector recall on the BLOCK/ALLOW reason) AND
    Postgres (structured row for trend analysis + override-rate queries)."""
    chroma_ok = False
    pg_ok = False
    errors = []

    summary = f"[{'PASS' if req.decision.get('allow') else 'BLOCK'}] {req.decision.get('reason', '')}"
    try:
        emb = _embed(app.state.embedder, [summary])[0]
        meta = {
            "operator": req.operator,
            "allow": str(bool(req.decision.get("allow"))),
            "override_used": str(bool(req.decision.get("override_used"))),
            "data_loss_risk": str(bool(req.decision.get("data_loss_risk_blocker"))),
            "block_count": str(req.decision.get("block_count", 0)),
        }
        app.state.collections["verdicts"].upsert(
            ids=[req.turn_id + "-verdict"],
            embeddings=[emb],
            documents=[summary],
            metadatas=[meta],
        )
        chroma_ok = True
    except Exception as exc:  # noqa: BLE001
        errors.append(f"chroma: {exc}")

    try:
        with psycopg.connect(PG_URL, autocommit=True) as conn, conn.cursor() as cur:
            import json as _json
            cur.execute(
                """
                INSERT INTO verdicts (
                    turn_id, schema_version, operator,
                    decision_allow, decision_reason, block_count, override_used, override_reason,
                    auto_remediate, data_loss_risk_blocker,
                    principles, commitment, delivery, auditor_findings, trace
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb)
                """,
                (
                    req.turn_id,
                    req.schema_version,
                    req.operator,
                    bool(req.decision.get("allow")),
                    str(req.decision.get("reason", "")),
                    int(req.decision.get("block_count", 0)),
                    bool(req.decision.get("override_used", False)),
                    req.decision.get("override_reason"),
                    bool(req.decision.get("auto_remediate", False)),
                    bool(req.decision.get("data_loss_risk_blocker", False)),
                    _json.dumps(req.principles),
                    _json.dumps(req.commitment),
                    _json.dumps(req.delivery),
                    _json.dumps(req.auditor_findings),
                    _json.dumps(req.trace) if req.trace else None,
                ),
            )
        pg_ok = True
    except psycopg.Error as exc:
        errors.append(f"postgres: {exc}")

    if not chroma_ok and not pg_ok:
        raise HTTPException(500, f"both backends failed: {'; '.join(errors)}")
    return {"indexed": True, "turn_id": req.turn_id, "chroma": chroma_ok, "postgres": pg_ok, "errors": errors or None}


@app.get("/palace/path")
def path(src_kind: str, src_id: str, max_hops: int = 3):
    """Trace a multi-hop reasoning path through palace_edges."""
    if max_hops > 6:
        max_hops = 6
    try:
        with psycopg.connect(PG_URL) as conn, conn.cursor() as cur:
            cur.execute(
                """
                WITH RECURSIVE hops AS (
                    SELECT src_kind, src_id, dst_kind, dst_id, relation, weight, 1 AS depth
                    FROM palace_edges
                    WHERE src_kind = %s AND src_id = %s
                    UNION ALL
                    SELECT e.src_kind, e.src_id, e.dst_kind, e.dst_id, e.relation, e.weight, h.depth + 1
                    FROM palace_edges e
                    INNER JOIN hops h ON e.src_kind = h.dst_kind AND e.src_id = h.dst_id
                    WHERE h.depth < %s
                )
                SELECT * FROM hops ORDER BY depth, weight DESC LIMIT 200
                """,
                (src_kind, src_id, max_hops),
            )
            rows = cur.fetchall()
        return {"path": [
            {"src_kind": r[0], "src_id": r[1], "dst_kind": r[2], "dst_id": r[3], "relation": r[4], "weight": r[5], "depth": r[6]}
            for r in rows
        ]}
    except psycopg.Error as exc:
        raise HTTPException(500, f"pg error: {exc}") from exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8077)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run("mempalace.serve:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
