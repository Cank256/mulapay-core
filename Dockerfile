# One image, three processes (APP_ROLE=api|worker|consumer), spec sections 4.1 and 11.
#
#   dev      full dependencies, used by docker-compose.yml for `npm run dev*`
#   build    compiles TypeScript
#   runtime  distroless Node 22: no shell, non-root, production dependencies only.
#            Run with a read-only root filesystem (compose `read_only: true`, k8s
#            `readOnlyRootFilesystem: true`). The process writes only to stdout.
#
# HEALTHCHECK runs `dist/scripts/healthcheck.js` (liveness): the api role probes /v1/health on
# PORT, the worker and consumer probe /health on HEALTH_PORT. The orchestrator should still probe
# readiness (/v1/health/ready, /health/ready) for traffic and restart decisions.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- dev ----
FROM ${NODE_IMAGE} AS dev
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY --chown=node:node . .
ENV NODE_ENV=development
CMD ["npm", "run", "dev"]

# ---- build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- production dependencies (same Debian base as the distroless runtime) ----
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime ----
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay root-owned and read-only to the nonroot (uid 65532) process user.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER nonroot
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "dist/scripts/healthcheck.js"]
# The distroless entrypoint is node; migrations: `docker run ... dist/db/migrate.js`
CMD ["dist/main.js"]
