# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# eve CLI lives in devDependencies; the build compiles agent/ into .output/
RUN npx eve build

FROM node:24-slim
WORKDIR /app
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends git ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*
# Sibling sandbox containers are driven through the host daemon's socket.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/node_modules ./node_modules
# `eve start` resolves the app root from these markers (package.json + agent/)
# before it can prewarm sandbox templates.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/agent ./agent
# Admin CLI for the user registry, run via `docker compose exec`:
#   node scripts/users.ts list|add|remove
COPY --from=builder /app/scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    EVE_DOCKER_PATH=/usr/local/bin/docker

EXPOSE 3000
# `eve start` prewarms sandbox templates (builds the hledger template image on
# the host daemon) BEFORE spawning the Nitro server; a bare `node index.mjs`
# would serve traffic with no provisioned template.
CMD ["./node_modules/.bin/eve", "start", "--host", "0.0.0.0"]
