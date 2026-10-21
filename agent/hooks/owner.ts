import { defineHook } from "eve/hooks";
import { log } from "../lib/log";
import { sessionOwner } from "../lib/owner";

/**
 * Records who owns each session while auth is present at session start.
 * Tools that must know whose credentials to use fall back to this captured
 * owner when the current turn carries no auth. Kept as defense in depth:
 * eve 0.82 preserves `ctx.session.auth.current` across approvals.
 */
export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      const principalId = ctx.session.auth.current?.principalId;
      if (!principalId) {
        return;
      }

      // A thrown hook surfaces as turn.failed; never let bookkeeping kill
      // the session.
      try {
        sessionOwner.update(() => principalId);
      } catch (err) {
        log.error({
          hook: "owner",
          sessionId: ctx.session.id,
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },
});
