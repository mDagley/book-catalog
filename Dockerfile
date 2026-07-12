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

# ---- runner: minimal production image ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

# Next.js standalone output: pruned node_modules + minimal server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The prisma CLI (needed at startup to run `prisma migrate deploy`) is a
# devDependency Next's output tracing never sees, since no app code imports
# it — and its own dependency tree runs deep (e.g. @prisma/config pulls in
# the unrelated `effect` package). Rather than chase transitive deps one
# ENOENT at a time, replace the standalone output's pruned node_modules
# with the full one from the builder stage, which is guaranteed complete.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/node_modules ./node_modules

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p uploads \
    && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
