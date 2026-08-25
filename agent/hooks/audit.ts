import { defineHook } from "eve/hooks";
import { log } from "../lib/log";

/**
 * Audit trail for nook: structured log lines captured by `docker logs`
 *  Observe-only
 */
export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      const principalId = ctx.session.auth.current?.principalId;
      if (!principalId) {
        log.error({
          audit: "session.started",
          sessionId: ctx.session.id,
          msg: "session without authenticated principal",
        });
        return;
      }

      log.info({
        audit: "session.started",
        sessionId: ctx.session.id,
        principalId,
      });
    },
    async "action.result"(event, ctx) {
      const action = event.data.result;
      if (action.kind !== "tool-result" || action.toolName !== "commit_entry") {
        return;
      }

      const output =
        typeof action.output === "object" && action.output !== null
          ? (action.output as Record<string, unknown>)
          : {};

      const principalId = ctx.session.auth.current?.principalId;
      if (!principalId) {
        log.error({
          audit: "ledger.commit",
          sessionId: ctx.session.id,
          status: event.data.status,
          msg: "commit result observed without authenticated principal",
        });
        return;
      }

      log.info({
        audit: "ledger.commit",
        sessionId: ctx.session.id,
        principalId,
        status: event.data.status,
        sha: output.sha ?? null,
        pushed: output.pushed ?? false,
      });
    },
  },
});
