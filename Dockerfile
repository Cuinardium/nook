# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# eve CLI lives in devDependencies; the build compiles agent/ into .output/
RUN npx eve build
# Runtime deps kept external as insurance for non-bundled requires.
RUN npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends git ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*
# Sibling sandbox containers are driven through the host daemon's socket.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    EVE_DOCKER_PATH=/usr/local/bin/docker

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
