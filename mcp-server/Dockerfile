# Dockerfile for mcp-server — Phase 2 deploy.
#
# Build context: REPO ROOT (../). The mcp-server imports schema files from
# ../src/lib/db/schema-*.ts via relative paths, so we need both the dashboard's
# /src and our /mcp-server in the image.
#
# Runtime: tsx (no tsc emit). Bundling/tsc-compile would require copying the
# dashboard's whole TS toolchain to keep schema-*.ts type imports resolvable;
# tsx solves this transparently and the cold-start overhead is fine for
# 5–15 РОПов on a single replica.
FROM node:20-alpine

ARG MCP_PORT=3009
ENV NODE_ENV=production \
    PORT=${MCP_PORT} \
    TZ=Europe/Berlin

WORKDIR /app

# Install workspace deps. Root package.json declares "workspaces": ["mcp-server"]
# so a single `npm ci` at root pulls all transitive deps into /app/node_modules.
COPY package.json package-lock.json ./
COPY mcp-server/package.json ./mcp-server/
RUN npm ci --omit=dev --no-audit --no-fund

# Sources — schemas + helpers from dashboard, mcp-server itself.
COPY src/lib/db ./src/lib/db
COPY mcp-server/src ./mcp-server/src
COPY mcp-server/tsconfig.json ./mcp-server/

EXPOSE ${MCP_PORT}

# Healthcheck — Dokploy probes /health to declare service ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/health || exit 1

WORKDIR /app/mcp-server
CMD ["npx", "tsx", "src/index.ts"]
