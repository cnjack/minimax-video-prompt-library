# syntax=docker/dockerfile:1.7

# ---- Build stage: install all deps and build shared, client, and server ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy sources and build (topological order: shared -> server/client).
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/client packages/client
RUN pnpm -r run build

# ---- Runtime stage: production deps + built artifacts only ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable

# Install only production dependencies for the workspace.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

# Overlay the built artifacts (sources are not needed at runtime).
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/client/dist ./packages/client/dist

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/data/h3-studio.db \
    SEED_SAMPLES=true \
    PROVIDER_MODE=mock \
    CLIENT_DIST=/app/packages/client/dist \
    # node:sqlite is experimental in Node 22.
    NODE_OPTIONS="--experimental-sqlite --disable-warning=ExperimentalWarning"

EXPOSE 3001
# Migrations run on startup; the in-process poller advances non-terminal jobs.
WORKDIR /app/packages/server
CMD ["node", "dist/server.js"]
