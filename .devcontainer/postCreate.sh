#!/usr/bin/env bash
# PromptNexus postCreate — runs once after devcontainer build.
# Mirrors agent_harness's pattern (yarn install + MCP pre-warm + verify).

set -e

echo "[postCreate] yarn 4.9.2 activate"
corepack enable
corepack prepare yarn@4.9.2 --activate

if [ -f package.json ]; then
  echo "[postCreate] yarn install --immutable"
  yarn install --immutable 2>&1 | tee /tmp/postCreate-yarn.log || {
    echo "[postCreate] yarn install reported errors; checking ajv presence..."
    if [ ! -d node_modules/ajv ]; then
      echo "[postCreate] FATAL: yarn install failed (no node_modules/ajv)"
      exit 1
    fi
    echo "[postCreate] non-fatal warnings only — node_modules populated"
  }
else
  echo "[postCreate] no package.json yet — skipping yarn install"
fi

# MCP pre-warm (best-effort)
if [ -f .mcp.json ]; then
  echo "[postCreate] MCP pre-warm"
  for pkg in $(node -e "const j=require('./.mcp.json');for(const k of Object.keys(j.mcpServers||{})){const s=j.mcpServers[k];if(s.command==='npx'&&s.args){console.log(s.args.filter(a=>a!=='-y').join(' '))}}" 2>/dev/null); do
    echo "[postCreate]  prewarm: $pkg"
    npx -y $pkg --help >/dev/null 2>&1 || echo "[postCreate]  prewarm $pkg failed (non-fatal)"
  done
fi

# Verdicts dir + .gitignore
mkdir -p evals/verdicts evals/audits evals/roadblocks
if [ ! -f evals/.gitignore ]; then
  cat > evals/.gitignore <<'EOF'
verdicts/
audits/
roadblocks/
*.json
!verdict.schema.json
EOF
fi

echo "[postCreate] done"
