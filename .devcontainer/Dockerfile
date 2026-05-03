# PromptNexus devcontainer image.
# Built and published to ghcr.io/flexnetos/prompt-nexus-devcontainer by
# .github/workflows/devcontainer-publish.yml on every push to main.
#
# Goal: pull-not-build. First clone hits ~30s, not ~5min.

FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

# Yarn 4.x via corepack
RUN corepack enable && corepack prepare yarn@4.9.2 --activate

# Claude Code CLI (best-effort)
RUN npm install -g @anthropic-ai/claude-code 2>&1 || echo "[warn] claude-code install non-fatal"

# Playwright system deps (for the playwright MCP server)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
    libxss1 libxtst6 libgtk-3-0 libcups2 libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# Pre-create volume mount points with `node` ownership
# (avoids EACCES when named volumes attach over them)
RUN mkdir -p /workspaces/prompt-nexus/node_modules \
             /workspaces/prompt-nexus/evals/verdicts \
             /home/node/.yarn/berry/cache \
             /home/node/.npm \
             /home/node/.claude \
  && chown -R node:node /workspaces/prompt-nexus /home/node/.yarn /home/node/.npm /home/node/.claude

# BAML CLI (for intent.baml validation; pinned)
RUN npm install -g @boundaryml/baml@latest 2>&1 || echo "[warn] baml install non-fatal"

USER node
WORKDIR /workspaces/prompt-nexus
