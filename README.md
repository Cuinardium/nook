# nook

Nook is a personal bookkeeping assistant on Telegram, built with the [eve](https://eve.dev/docs) agent framework. You message it in Spanish (rioplatense); it records your purchases, income, and gains as hledger transactions in your own ledger repo, one approved entry = one commit + push.

## How it works

- **Channel**: Telegram (`agent/channels/telegram.ts`). Confirmations use inline Approve/Reject buttons via eve's human-in-the-loop rendering.
- **Model**: OpenCode Go models through an OpenAI-compatible endpoint (`agent/agent.ts`).
- **Sandbox**: each turn runs in a Docker sandbox with the user's ledger repo cloned at `/workspace/ledger` and `hledger` available.
- **Approval flow**: the assistant drafts the full transaction in chat first and commits locally with git; `push` (`agent/tools/push.ts`) is gated by `approval: { request: always(), prompt }` and rebases + pushes via the user's forge token. `pull` (`agent/tools/pull.ts`) fetches + rebases without pushing. Both verify `origin` still points at the user's repo before touching the network.
- **Prices**: `update_prices` (`agent/tools/update_prices.ts`) refreshes commodity prices before valuing positions in ARS.
- **Attachments**: Telegram photos, screenshots and PDFs up to 10 MB are accepted and read natively by the model (verified against OpenCode Go for JPEG and PDF, including scanned ones). They cover receipts and multi-row extracts such as homebanking movements or broker (ALyC) operations; each movement becomes its own hledger entry.
- **Hooks**: `agent/hooks/audit.ts` writes the activity trail to stdout; `agent/hooks/owner.ts` captures the session owner.
- **Skill**: `agent/skills/hledger-entry` holds the journal-writing conventions.
- **Users**: allowlisted principals map Telegram IDs to ledger repos (`NOOK_USERS`), managed with `node scripts/users.ts list|add|remove`.

## Logs

`agent/hooks/audit.ts` writes one JSON object per line to stdout. Every line
carries `ts`, `level`, `event`, `eventId`, `sessionId`, and `principalId` (null
when the session has no authenticated principal). `eventId` is the event's
position on the session stream, `<line>.<index>`; it is stable and ordered but
no longer a framework event id, which session-events v27 does not have.

| `event` | What it records |
| --- | --- |
| `session.started` / `sandbox.ready` | session principal and the ledger commit the sandbox opened (`headSha`, `headSubject`, `journals`) |
| `message.received` / `message.settled` | who wrote, on which channel, the message size (no text), and how the delivery ended |
| `tool.requested` / `tool.result` | every tool call: compact input, `status` (the call's outcome), duration, exit code and output shape |
| `subagent.*` / `remote_agent.*` / `skill.*` / `control.*` | delegated work, remote agents, skill loads, and task-control calls |
| `input.requested` / `input.resolved` / `approval.settled` | questions, sign-ins, and who approved a push |
| `step.completed` / `step.failed` / `step.retried` | one row per model run: finish reason, attempts, duration, failure |
| `usage` | tokens and cost per model run, from `usage.recorded` |
| `context.settled` | compaction outcome |
| `turn.completed` / `turn.failed` / `turn.cancelled` | turn duration and failure, keyed on the turn's `outcome` |
| `ledger.push` / `ledger.pull` / `ledger.prices` | domain outcome of the three network/pricing tools |
| `session.failed` / `session.completed` | terminal session outcome |

Tool arguments are truncated and secret-looking values are redacted. Tool
outputs are reduced to shape, byte counts, and exit codes: journal text and
stdout never land in the logs. The `ledger.*` rows add the domain outcome.

On the host:

```sh
# Every tool call of the last day, with its compact input.
docker logs nook-nook-1 --since 24h 2>&1 | grep -a '^{' \
  | jq -c 'select(.event == "tool.requested") | {principalId, toolName, input}'

# How a single session spent its time.
docker logs nook-nook-1 --since 24h 2>&1 | grep -a '^{' \
  | jq -c 'select(.sessionId == "wrun_...") | {ts, event, toolName, ms, status}'
```

The `grep` drops the multi-line harness errors that share the stream; without it
`jq` stops at the first one.

### Unknown senders

A message the channel drops never opens a session, so the audit trail has no
row for it. The channel emits its own `message.rejected` warning instead, with
the sender's Telegram id, username and name:

```sh
# Who tried to reach the bot without being registered.
docker logs nook-nook-1 --since 24h 2>&1 | grep -a '^{' \
  | jq -c 'select(.event == "message.rejected") | {ts, reason, telegramUserId, telegramUsername, chatType}'
```

That is the id `scripts/users.ts add --telegram-id` expects. A `reason` of
`not-allowlisted` means the user is unknown; `not-private-chat` means the
message came from a group, where nook does not answer.

Docker's default `json-file` driver does not rotate. Bound it in `compose.yaml`:

```yaml
services:
  nook:
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
```

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
must share the daemon. The host needs Node 24 — `eve build` exits with
`eve requires Node.js >=24` on anything older, so check `node -v` first — plus
the Docker CLI and daemon, and network access (the sandbox `prepare` runs
`apt-get`).

On the host:

```sh
cd ~/services/nook/src
git pull
npm ci
npx eve build          # prepares the sandbox template in the host daemon
docker build -t nook . # packages .output into the app image
cd ..
docker compose up -d   # or the docker run below
```

### Upgrading eve

The working clone of the ledger lives in each session's sandbox container, so
an upgrade must not take local work with it. In order:

```sh
# 1. From the bot: push the ledger, and confirm the remote is clean.
# 2. Keep a copy of the old sessions and the activity trail, then wipe.
docker compose down
docker run --rm -v nook_workflows:/sessions -v /tmp:/out alpine \
  tar czf /out/nook-workflows-pre-upgrade.tgz -C /sessions .
docker run --rm -v nook_workflows:/sessions alpine sh -c 'rm -rf /sessions/*'
docker rm -f $(docker ps -aq --filter label=eve.sandbox=1)  # session sandboxes

# 3. Build and start the new version, then smoke-test a conversation.
npx eve build && docker build -t nook . && docker compose up -d
```

Sessions are disposable here: the next Telegram message starts a fresh one with
a clean clone and a clean context. Sandbox containers are labelled
`eve.sandbox=1`, so the prune only touches eve's own containers.

`eve build` leaves the template in the daemon, so `eve start` finds it with no
artifact transport, and later builds reuse it unless the sandbox definition, the
skill files, or the generated Dockerfile change. The container needs the host
socket and two persistent volumes:

```yaml
services:
  nook:
    image: nook:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - nook_state:/app/.eve
      # Sessions live here. A mount at /app/.eve alone leaves them on an
      # anonymous volume that `docker compose down -v` deletes silently.
      - nook_workflows:/app/.eve/.workflow-data
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  nook_state:
  nook_workflows:
    name: nook_workflows
```

Or without compose:

```sh
docker run -d --name nook -p 3000:3000 \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=volume,source=nook_state,target=/app/.eve \
  --mount type=volume,source=nook_workflows,target=/app/.eve/.workflow-data \
  --env-file .env nook
```

Both mounts matter: `/app/.eve/.workflow-data` holds the sessions and
`/app/.eve` holds the sandbox cache. Restarts and image rebuilds keep them; an
**eve upgrade does not**. A run belongs to the eve version that created it, so
the next message retires the old session and starts a fresh one, and that
conversation's history is gone. Since eve 0.83 the retirement is automatic, and a
session whose recorded sandbox no longer matches the prepared template starts a
fresh sandbox instead of failing every tool call until the session times out.

On eve 1.0 a session from 0.69–0.83 moves to the new deployment on its next
message instead of starting over: eve compacts the earlier conversation into a
summary and resets remembered approvals and usage limits. Checkpoints go to v19,
so an older deployment refuses to take a session back. nook does not rely on
that migration — the upgrade wipes the volume, which makes the rollback a wipe
and redeploy too. **Push the ledger before an upgrade**: the working clone lives
in the session's sandbox container, so a wiped session takes uncommitted edits
and unpushed commits with it.

Without Docker, install `git`, `jq`, and `curl` on the host and run
`node_modules/.bin/eve start` under systemd instead.
