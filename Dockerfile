# ─────────────────────────────────────────────────────────────
# Dockerfile — Opygen Cleaning CRM Backend
# Project   : opygen-crm-backends
# Runtime   : Node.js 20 (Alpine)
# Port      : 3000
# Package   : pnpm
# ─────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────
# Stage 1 — base: enable pnpm via corepack on Alpine
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS base

# Enable pnpm via corepack (matches packageManager in package.json)
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /app

# ─────────────────────────────────────────────────────────────
# Stage 2 — dependencies: install ALL deps (dev+prod) for build
# ─────────────────────────────────────────────────────────────
FROM base AS dependencies

COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# ─────────────────────────────────────────────────────────────
# Stage 3 — build: compile TypeScript → dist/ via tsup
# ─────────────────────────────────────────────────────────────
FROM base AS build

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

# Generate Prisma client before building (required for type-safe queries)
RUN npx prisma generate

# Compile TypeScript
RUN npx tsc --noEmit && npx tsup

# ─────────────────────────────────────────────────────────────
# Stage 4 — migration: one-shot release image with Prisma CLI + compiled repair job
# Never run migrations from the long-lived API container. CI/CD or an operator
# runs this target exactly once before application rollout.
# ─────────────────────────────────────────────────────────────
FROM build AS migration

ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

# ─────────────────────────────────────────────────────────────
# Stage 5 — prod-dependencies: prune devDeps efficiently
# ─────────────────────────────────────────────────────────────
FROM dependencies AS prod-dependencies

RUN pnpm prune --prod

# ─────────────────────────────────────────────────────────────
# Stage 6 — development: hot-reload via tsx --watch
# ─────────────────────────────────────────────────────────────
FROM base AS development

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

ENV PORT=3000
ENV BACKEND_IP=0.0.0.0
ENV NODE_ENV=development

EXPOSE 3000
CMD ["pnpm", "run", "dev"]

# ─────────────────────────────────────────────────────────────
# Stage 7 — production: lean runtime image (DEFAULT FINAL STAGE)
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Runtime system deps
RUN apk add --no-cache wget ca-certificates

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what is needed at runtime with correct non-root ownership
COPY --chown=appuser:appgroup --from=prod-dependencies /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=build             /app/dist          ./dist
COPY --chown=appuser:appgroup --from=build             /app/package.json  ./

# Copy Prisma schema + generated client (needed by @prisma/client at runtime)
COPY --chown=appuser:appgroup --from=build /app/prisma ./prisma
COPY --chown=appuser:appgroup --from=build /app/src/generated ./src/generated

# Copy EJS email templates used by nodemailer
COPY --chown=appuser:appgroup --from=build /app/src/lib/templates ./src/lib/templates

USER appuser

ENV NODE_ENV=production
ENV PORT=3000
ENV BACKEND_IP=0.0.0.0

EXPOSE 3000

# Health-check: wget is available on Alpine
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/livez || exit 1

CMD ["node", "dist/index.js"]
