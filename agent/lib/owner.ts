import { defineState } from "eve/context";

/**
 * Principal that owns the current session's sandbox, captured whenever auth
 * is present (session start, sandbox setup). Needed because eve delivers
 * Telegram approval responses with auth: null — after an approval pause,
 * ctx.session.auth.current is null for the rest of the turn, so tools that
 * must know whose credentials to use fall back to this.
 *
 * App-runtime durable state: the sandbox cannot read or rewrite it.
 */
export const sessionOwner = defineState(
  "nook.session-owner",
  (): string | null => null,
);
