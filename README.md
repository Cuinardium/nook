# nook

Nook is a personal bookkeeping assistant on Telegram, built with the [eve](https://eve.dev/docs) agent framework. You message it in Spanish (rioplatense); it records your purchases, income, and gains as hledger transactions in your own ledger repo, one approved entry = one commit + push.

## How it works

- **Channel**: Telegram (`agent/channels/telegram.ts`). Confirmations use inline Approve/Reject buttons via eve's human-in-the-loop rendering.
- **Model**: OpenCode Go models through an OpenAI-compatible endpoint (`agent/agent.ts`).
- **Sandbox**: each turn runs in a Docker sandbox with the user's ledger repo cloned at `/workspace/ledger` and `hledger` available.
- **Approval flow**: the assistant drafts the full transaction in chat first and commits locally with git; `push` (`agent/tools/push.ts`) is gated by `approval: { request: always(), prompt }` and rebases + pushes via the user's forge token. `pull` (`agent/tools/pull.ts`) fetches + rebases without pushing. Both verify `origin` still points at the user's repo before touching the network.
- **Prices**: `update_prices` (`agent/tools/update_prices.ts`) refreshes commodity prices before valuing positions in ARS.
- **Attachments**: Telegram photos, screenshots and PDFs up to 10 MB are accepted and read natively by the model (verified against OpenCode Go for JPEG and PDF, including scanned ones). They cover receipts and multi-row extracts such as homebanking movements or broker (ALyC) operations; each movement becomes its own hledger entry.
- **Hooks**: `agent/hooks/audit.ts` logs JSON audit lines to stdout; `agent/hooks/owner.ts` handles owner notifications.
- **Skill**: `agent/skills/hledger-entry` holds the journal-writing conventions.
- **Users**: allowlisted principals map Telegram IDs to ledger repos (`NOOK_USERS`), managed with `node scripts/users.ts list|add|remove`.

## Getting started

```sh
npm install
cp .env.example .env   # fill in model + Telegram + forge credentials
npm run dev            # eve dev server
```

Lint and typecheck:

```sh
npm run lint
npm run typecheck
```

Evals live in `evals/`. The attachment eval stages a file in the session
sandbox, so it needs a target where the session principal is registered in the
user registry — the local eval server runs as `local-dev`, which nook refuses by
design. It stays skipped unless you opt in, pointing at a provisioned target:

```sh
NOOK_EVAL_ATTACHMENTS=1 npx eve eval --tag attachments --url https://nook.example.com
```

## Deployment

Nook is self-hosted, and the build runs on the same host that serves it. `eve
build` needs a Docker daemon to prepare the sandbox template image, and the
prepared manifest only points at that daemon's local image, so build and runtime
must share the daemon. The host needs Node 24, the Docker CLI and daemon, and
network access (the sandbox `prepare` runs `apt-get`).

On the host:

```sh
git pull
npm ci
npx eve build          # prepares the sandbox template in the host daemon
docker build -t nook . # packages .output into the app image
docker compose up -d   # or the docker run below
```

`eve build` leaves the template in the daemon, so `eve start` finds it with no
artifact transport. The container needs the host socket and a persistent volume:

```sh
docker run -d --name nook -p 3000:3000 \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=volume,source=nook-workflows,target=/app/.eve/.workflow-data \
  --env-file .env nook
```

Mount `/app/.eve/.workflow-data` on persistent storage so durable sessions
survive container restarts. Sessions created before an upgrade do not survive a
self-hosted upgrade: the next message starts a new session.

Without Docker, install `git`, `jq`, and `curl` on the host and run
`node_modules/.bin/eve start` under systemd instead.
