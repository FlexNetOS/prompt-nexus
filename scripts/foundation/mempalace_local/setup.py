"""Memory Palace fallback — runs if the upstream repo is unreachable at build time.

Implements the minimum API surface PromptNexus needs:
  POST /palace/edges         Insert intent → verdict → outcome graph edges.
  GET  /palace/recall        Recall related context by query string + top_k.
  GET  /palace/path          Trace a multi-hop reasoning path.
  GET  /health               Liveness probe.
"""

from setuptools import setup, find_packages

setup(
    name="mempalace",
    version="0.1.0+local",
    packages=find_packages(),
    install_requires=[
        "fastapi>=0.115",
        "uvicorn[standard]>=0.32",
        "psycopg[binary]>=3.2",
        "chromadb-client>=0.5.20",
        "pydantic>=2.8",
    ],
)
