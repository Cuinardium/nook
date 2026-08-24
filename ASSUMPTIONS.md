# Assumptions (autonomous session)

Decisions taken without feedback while wiring cards/hooks. Each is cheap to
reverse — say the word and it changes.

## Presentation

1. **Confirm buttons come from the framework's HITL renderer**, not hand-rolled
   callbacks. `commit_entry` keeps `approval: always()`, so Approve/Reject are
   inline-keyboard buttons wired to the durable pause/resume protocol
   (`input.requested` / `inputResponses`). Custom `callback_data` was rejected:
   Telegram caps it at 64 bytes and eve owns the compact-id state mapping.
2. **Only `commit_entry` approvals get the custom card** ("🧾 Confirmar
   ingesta"). Other prompts (`ask_question`, session-limit notices) use eve's
   stock rendering untouched.
3. **Result cards on every `action.result` of `commit_entry`**: ✅ committed +
   pushed (with short sha), ⚠️ commit created but push failed (with stderr
   excerpt), ℹ️ nothing to commit, ❌ rejected at the keyboard.
4. **Plain-text cards, no `parse_mode`.** Matches the channel default and keeps
   model/user-derived strings injection-proof. Monospace transaction blocks
   would need HTML/MarkdownV2 — trivial to add if wanted.

## Hooks

5. **Audit hook** (`agent/hooks/audit.ts`) logs JSON lines to stdout
   (`session.started`, every `commit_entry` outcome with principal/sha/pushed).
   Sink is `docker logs` / journald only — no external destination configured.
6. **Framework error messages left as-is**: `turn.failed` / `session.failed`
   already post actionable error cards; overriding them adds maintenance for no
   visible gain.

## Runtime behavior

7. **Sandboxes stay warm between turns** — no auto-stop hook. Docker containers
   have no idle cost on your box and follow-ups stay instant. A
   stop-after-turn hook is the documented alternative if you'd rather reclaim
   memory.
8. **Reconnects/replayed turns can re-post a card.** The event stream replays
   durably recorded events; per-card idempotency wasn't attempted (needs
   message-id bookkeeping in channel state). Worst case: a duplicate confirm
   card whose second tap resolves as stale.
9. **The model still posts the full drafted transaction as ordinary chat text**
   before calling `commit_entry`; the card beneath it repeats only the commit
   message. Duplication is intentional: block = full detail to read, card =
   what will be committed + the buttons.
