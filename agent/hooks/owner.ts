import { defineHook } from "eve/hooks";
import { log } from "../lib/log";
import { sessionOwner } from "../lib/owner";

/**
 * Records who owns each session while auth is present at session start.
 * Telegram approval responses resume turns anonymously (callback queries
 * are delivered with auth: null), so tools that must know whose credentials
 * to use fall back to this captured owner.
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
