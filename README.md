# nook

Nook is a personal bookkeeping assistant on Telegram, built with the [eve](https://eve.dev/docs) agent framework. You message it in Spanish (rioplatense); it records your purchases, income, and gains as hledger transactions in your own ledger repo, one approved entry = one commit + push.

## How it works

- **Channel**: Telegram (`agent/channels/telegram.ts`). Confirmations use inline Approve/Reject buttons via eve's human-in-the-loop rendering.
- **Model**: OpenCode Go models through an OpenAI-compatible endpoint (`agent/agent.ts`).
- **Sandbox**: each turn runs in a Docker sandbox with the user's ledger repo cloned at `/workspace/ledger` and `hledger` available.
- **Approval flow**: the assistant drafts the full transaction in chat first, then calls `commit_entry` (`agent/tools/commit_entry.ts`), which is gated by `approval: always()` and runs `hledger check`, commits, and pushes via the user's forge token.
- **Prices**: `update_prices` (`agent/tools/update_prices.ts`) refreshes commodity prices before valuing positions in ARS.
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

Evals live in `evals/`.

## Deployment

The `Dockerfile` builds the agent with `eve build` into `.output/` and serves it via `eve start`, which prewarms the hledger sandbox template on the host daemon. Deploy to Vercel with:

```sh
eve link --non-interactive --project <name-or-id>
eve deploy --non-interactive --yes
```
