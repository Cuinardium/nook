import { defineState } from "eve/context";

/**
 * Principal that owns the current session's sandbox, captured whenever auth
 * is present (session start, sandbox setup). Tools that must know whose
 * credentials to use fall back to this when `ctx.session.auth.current` is
 * absent for the turn. Defense in depth: eve 0.82 keeps session auth across
 * approvals.
 *
 * App-runtime durable state: the sandbox cannot read or rewrite it.
 */
export const sessionOwner = defineState(
  "nook.session-owner",
  (): string | null => null,
);
