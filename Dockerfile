# syntax=docker/dockerfile:1.7

FROM node:22.22.0-bookworm-slim AS build-base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

FROM scratch AS workspace-manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/espn-bridge/package.json apps/espn-bridge/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/connector-espn/package.json packages/connector-espn/package.json
COPY packages/connector-yahoo/package.json packages/connector-yahoo/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/engine-draft/package.json packages/engine-draft/package.json
COPY packages/engine-lineup/package.json packages/engine-lineup/package.json
COPY packages/engine-trade/package.json packages/engine-trade/package.json
COPY packages/engine-waiver/package.json packages/engine-waiver/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/league-analytics/package.json packages/league-analytics/package.json
COPY packages/projections/package.json packages/projections/package.json
COPY packages/rankings/package.json packages/rankings/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/source-ffc/package.json packages/source-ffc/package.json
COPY packages/source-nflverse/package.json packages/source-nflverse/package.json
COPY packages/source-sleeper/package.json packages/source-sleeper/package.json
COPY packages/testkit/package.json packages/testkit/package.json

FROM build-base AS dependencies
COPY --from=workspace-manifests / /app/
RUN --mount=type=cache,id=laces-out-npm-build,target=/root/.npm,sharing=locked npm ci

FROM node:22.22.0-alpine3.22 AS runtime-base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

FROM runtime-base AS api-production-dependencies
COPY --from=workspace-manifests / /app/
RUN --mount=type=cache,id=laces-out-npm-api,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --workspace @fantasy/api

FROM runtime-base AS worker-production-dependencies
COPY --from=workspace-manifests / /app/
RUN --mount=type=cache,id=laces-out-npm-worker,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --workspace @fantasy/worker

FROM dependencies AS builder
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
# "true" makes the browser bundle call /v1 on whatever domain served the page, so one image can be
# served from more than one domain. Anything not a browser still uses NEXT_PUBLIC_API_URL.
ARG NEXT_PUBLIC_API_SAME_ORIGIN=false
ARG NEXT_PUBLIC_CONTACT_EMAIL=
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_YAHOO_ACCESS_STATUS=pending
ARG NEXT_PUBLIC_CLOUDFLARE_ANALYTICS=disabled
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_API_SAME_ORIGIN=${NEXT_PUBLIC_API_SAME_ORIGIN} \
    NEXT_PUBLIC_CLOUDFLARE_ANALYTICS=${NEXT_PUBLIC_CLOUDFLARE_ANALYTICS} \
    NEXT_PUBLIC_CONTACT_EMAIL=${NEXT_PUBLIC_CONTACT_EMAIL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_YAHOO_ACCESS_STATUS=${NEXT_PUBLIC_YAHOO_ACCESS_STATUS} \
    NEXT_TELEMETRY_DISABLED=1
COPY --chown=node:node . .
RUN npm run build

FROM runtime-base AS api
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
COPY --from=api-production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]

FROM api AS migrate
COPY --from=builder --chown=node:node /app/packages/db/migrations ./packages/db/migrations
CMD ["node", "apps/api/dist/migrate.js"]

FROM runtime-base AS worker
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
COPY --from=worker-production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder --chown=node:node /app/apps/worker/dist ./apps/worker/dist
USER node
CMD ["node", "apps/worker/dist/worker.js"]

FROM runtime-base AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
