# Memory Palace service — long-term reasoning store on top of Postgres + Chroma.
# Builds from upstream `mempalace/mempalace` with PromptNexus integration shims.

FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Use the local fallback impl. Upstream `mempalace/mempalace` is not yet a
# valid Python package with a `serve` module — when it is, swap this block
# back to the conditional clone. The local impl is the v0.1 contract.
COPY mempalace_local /app/mempalace_local
RUN cp -r /app/mempalace_local /app/mempalace && \
    pip install --no-cache-dir -e /app/mempalace

# Common runtime deps.
# - chromadb-client is the thin HTTP client (avoids the broken baseten
#   embedding function import in chromadb==0.5.20's full package).
# - sentence-transformers provides the embedder (all-MiniLM-L6-v2 by default,
#   matches Chroma's bundled default for compatibility).
RUN pip install --no-cache-dir \
      fastapi==0.115.6 \
      uvicorn[standard]==0.32.1 \
      psycopg[binary]==3.2.3 \
      chromadb-client==0.5.20 \
      sentence-transformers==3.3.1 \
      pydantic==2.8.0 \
      httpx==0.27.0

EXPOSE 8077
CMD ["python", "-m", "mempalace.serve", "--host", "0.0.0.0", "--port", "8077"]
