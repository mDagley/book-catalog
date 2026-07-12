# syntax=docker/dockerfile:1

# ---- deps: install all dependencies (incl. devDependencies, needed to build) ----
FROM node:24-alpine AS deps
WORKDIR /app
# prisma/ and prisma.config.ts must be present before `npm ci`, since its
# postinstall hook runs `prisma generate`, which reads prisma/schema.prisma.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# DATABASE_URL isn't connected to at generate/build time, but prisma.config.ts
# loads dotenv and reads it, so set a placeholder to avoid a missing-var warning.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN npm ci

# ---- builder: build the Next.js app ----
FROM node:24-alpine AS builder
WORKDIR /app
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- prod-deps: install a production-only node_modules for the runner ----
# Mirrors the deps stage's prerequisite-copying pattern, but runs
# `npm ci --omit=dev` instead of a full `npm ci`. Now that prisma (the CLI,
# needed at startup to run `prisma migrate deploy`) has been moved to
# "dependencies" in package.json, this prunes real devDependencies
# (typescript, eslint, vitest, tailwindcss, @types/*, etc.) while still
# installing prisma and its complete transitive tree (e.g. @prisma/config's
# dependency on the unrelated `effect` package) — `--omit=dev` only changes
# which dependency categories are installed, not whether lifecycle scripts
# run, so `postinstall` (`prisma generate`) still fires here too.
FROM node:24-alpine AS prod-deps
WORKDIR /app
# prisma/ and prisma.config.ts must be present before `npm ci`, since its
# postinstall hook runs `prisma generate`, which reads prisma/schema.prisma.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# DATABASE_URL isn't connected to at generate time, but prisma.config.ts
# loads dotenv and reads it, so set a placeholder to avoid a missing-var warning.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN npm ci --omit=dev

# ---- runner: production image (production-only node_modules) ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

# Next.js standalone output: server.js + an initial pruned node_modules,
# which is superseded wholesale by the production-only copy below.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The prisma CLI is a dependency Next's output tracing never sees, since no
# app code imports it directly. Rather than chase its transitive deps (e.g.
# effect, pulled in via @prisma/config) one ENOENT at a time, replace the
# standalone output's pruned node_modules wholesale with the production-only
# tree from the prod-deps stage, which is guaranteed complete — prisma/ and
# prisma.config.ts come from the same stage, since it already needed them.
COPY --from=prod-deps --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=prod-deps --chown=nextjs:nodejs /app/prisma.config.ts ./
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p uploads \
    && chown nextjs:nodejs uploads

USER nextjs
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
