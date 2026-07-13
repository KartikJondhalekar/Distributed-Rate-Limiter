# ---- Build stage: compile TypeScript to dist/ ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install all deps (incl. dev) for the tsc build. Copy manifests first so
# this layer caches unless dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: slim image, production deps only ----
FROM node:20-alpine AS runtime
WORKDIR /app

# tini gives us a real PID 1 so SIGTERM reaches Node and graceful shutdown runs.
RUN apk add --no-cache tini

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Drop root.
USER node

EXPOSE 3000 9090

# Liveness: any HTTP response from /health means the process is up. A 503
# (Redis down) still counts as alive — fail-open keeps the app serving.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.API_PORT||3000)+'/health',()=>process.exit(0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]