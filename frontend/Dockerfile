# Hermes Agency Hub — website image.
#
# NEXT_PUBLIC_ values are compiled into the browser bundle, so they are build
# args and changing one means rebuilding. PORTAL_HUB_URL is read on the server
# at runtime and is set by compose, not here.
FROM node:24-slim AS build

WORKDIR /app

ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_BASE_DOMAIN=
ARG NEXT_PUBLIC_TENANT_SLOTS=20

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_BASE_DOMAIN=$NEXT_PUBLIC_BASE_DOMAIN \
    NEXT_PUBLIC_TENANT_SLOTS=$NEXT_PUBLIC_TENANT_SLOTS

# Dependencies before source, so editing code does not invalidate the
# (slow) install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone server does not serve .next/static unless it is copied in.
# There is no public/ folder to copy.
COPY --chown=node:node --from=build /app/.next/standalone ./
COPY --chown=node:node --from=build /app/.next/static ./.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
