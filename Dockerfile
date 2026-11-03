# Builds and runs orc in a single image: the backend (FastAPI/uvicorn) serves the
# built SPA as static files, so it is one process, not two services. That is why
# the build has two stages (frontend build -> runtime) instead of two containers.

FROM node:22-alpine AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS runtime

# git is needed for task worktrees and merges; nodejs is the runtime for the Claude
# Code CLI that the dispatcher uses to start sessions (orc/claude_cli.py).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock hatch_build.py README.md LICENSE ./
COPY orc ./orc
RUN uv sync --frozen --no-dev

COPY --from=frontend /app/web/dist ./web/dist

ENV PATH="/app/.venv/bin:${PATH}"
EXPOSE 8765

# The host is pinned to loopback, as orc/security.py requires (the server runs
# verify_cmd, i.e. executes code, and must not listen on a non-loopback interface).
# The port is reachable from outside through network_mode: host in docker-compose.yml,
# not through -p/expose.
ENTRYPOINT ["orc", "serve", "--host", "127.0.0.1", "--port", "8765"]
