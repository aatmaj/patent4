# syntax=docker/dockerfile:1

# Cloud Run image for FormuGraph.
#
# Three stages so the runtime layer carries no build tooling, no dev
# dependencies and no source: deps installs, builder compiles, runner ships
# only Next's standalone output.
#
# Deliberately absent: any credential file. The runtime reads Application
# Default Credentials from the Cloud Run metadata server via the attached
# service account, so no key material exists in the image or the environment.
# See resolveCredentials() in src/lib/bigquery.js.

# ---- deps ----------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci needs the dev deps here because the builder stage runs next build.
RUN npm ci

# ---- builder -------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner --------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0

# Run as a non-root user. node:20-slim ships uid/gid 1000 as `node`.
USER node

# server.js does not serve `public` or `.next/static` on its own; they have to
# be placed inside the standalone tree, which is what these two copies do.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Cloud Run injects PORT and ignores EXPOSE; this is documentation for humans
# and for `docker run` locally.
EXPOSE 8080

CMD ["node", "server.js"]
