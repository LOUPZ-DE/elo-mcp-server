# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Home for the encrypted state file (STATE_FILE=/data/state.json), so DCR
# registrations, refresh tokens and signed-in ELO sessions survive a redeploy.
#
# Runs as root, before USER below, so the directory belongs to `node` (uid 1000).
# A *named* volume inherits that ownership; a *bind mount* does not — there the
# host directory's owner wins, and the server will refuse to start rather than
# discover the problem at the next restart, when the state would already be gone.
RUN mkdir -p /data && chown -R node:node /data && chmod 700 /data
VOLUME /data

EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
