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

# Install system deps needed by native modules (heic-convert, bcryptjs, etc.)
RUN apk add --no-cache python3 make g++ vips-dev

# Enable pnpm via corepack (matches packageManager in package.json)
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /app

# ─────────────────────────────────────────────────────────────
# Stage 2 — dependencies: install ALL deps (dev+prod) for build
# ─────────────────────────────────────────────────────────────
FROM base AS dependencies

COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# ─────────────────────────────────────────────────────────────
# Stage 3 — build: compile TypeScript → dist/ via tsup
# ─────────────────────────────────────────────────────────────
FROM base AS build

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

# Generate Prisma client before building (required for type-safe queries)
RUN pnpm exec prisma generate

# Compile TypeScript
RUN pnpm run build

# ─────────────────────────────────────────────────────────────
# Stage 4 — migration: one-shot release image with Prisma CLI + compiled repair job
# Never run migrations from the long-lived API container. CI/CD or an operator
# runs this target exactly once before application rollout.
# ─────────────────────────────────────────────────────────────
FROM build AS migration

ENV NODE_ENV=production
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ─────────────────────────────────────────────────────────────
# Stage 5 — prod-dependencies: only production deps (no devDeps)
# ─────────────────────────────────────────────────────────────
FROM base AS prod-dependencies

COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ─────────────────────────────────────────────────────────────
# Stage 6 — production: lean runtime image
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Runtime native-module system deps
RUN apk add --no-cache vips wget

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what is needed at runtime
COPY --from=prod-dependencies /app/node_modules ./node_modules
COPY --from=build             /app/dist          ./dist
COPY --from=build             /app/package.json  ./

# Copy Prisma schema + generated client (needed by @prisma/client at runtime)
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src/generated ./src/generated

# Copy EJS email templates used by nodemailer
COPY --from=build /app/src/lib/templates ./src/lib/templates

# Hand ownership to non-root user
RUN chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production
ENV PORT=3000
ENV BACKEND_IP=0.0.0.0

EXPOSE 3000

# Health-check: wget is available on Alpine
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/livez || exit 1

CMD ["node", "dist/index.js"]

# ─────────────────────────────────────────────────────────────
# Stage 7 — development: hot-reload via tsx --watch
# ─────────────────────────────────────────────────────────────
FROM base AS development

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

ENV PORT=3000
ENV BACKEND_IP=0.0.0.0
ENV NODE_ENV=development

EXPOSE 3000
CMD ["pnpm", "run", "dev"]
