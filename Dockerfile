# syntax=docker/dockerfile:1

# The application is built on the host that runs it: `eve build` needs a Docker
# daemon to prepare the sandbox template image, and the prepared manifest only
# points at that daemon's local image. See README.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
WORKDIR /app
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends git ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*
# Sibling sandbox containers are driven through the host daemon's socket.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=deps /app/node_modules ./node_modules
# `eve start` resolves the app root from these markers (package.json + agent/)
# and the sandbox prewarm modules from the deployed source.
COPY package.json ./package.json
COPY agent ./agent
COPY scripts ./scripts
COPY .output ./.output

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    EVE_DOCKER_PATH=/usr/local/bin/docker \
    WORKFLOW_LOCAL_DATA_DIR=/app/.eve/.workflow-data

# Mount this path on persistent storage so durable sessions survive restarts.
VOLUME ["/app/.eve/.workflow-data"]

EXPOSE 3000
CMD ["./node_modules/.bin/eve", "start", "--host", "0.0.0.0"]
