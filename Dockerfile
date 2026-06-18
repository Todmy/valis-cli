# valis-cli — self-host image.
#
# Multi-stage: a full-deps builder compiles TypeScript with tsc, then a slim
# runtime carries only production deps + the compiled dist/. Build context is
# this directory (packages/cli) — the package is self-contained (no workspace:
# protocol deps), and tsconfig.docker.json inlines the monorepo base config so
# no parent files are required.
#
#   docker build -t valis-cli .
#   docker run --rm valis-cli --version
#
# fastembed (local embeddings for self-host) is an optional peer dependency and
# is NOT bundled — install it in a derived image or mount it if you run in
# client embedding mode (QDRANT_EMBEDDING_STRATEGY=client).

# ---- builder ----------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Install all deps (incl. dev) for the build. Copy manifest first for caching.
COPY package.json ./
RUN npm install --no-audit --no-fund --loglevel=error

# Compile.
COPY tsconfig.docker.json ./
COPY src ./src
COPY bin ./bin
RUN npx tsc -p tsconfig.docker.json

# Drop dev dependencies so we can copy a lean prod node_modules into runtime.
RUN npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# bin/valis.js carries its own #!/usr/bin/env node shebang.
ENTRYPOINT ["node", "dist/bin/valis.js"]
CMD ["--help"]
