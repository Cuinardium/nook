import { defineHook } from "eve/hooks";

/**
 * Audit trail for nook: structured log lines captured by `docker logs` /
 * journald. Observe-only; the Telegram channel owns user-facing cards.
 */
export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      console.info(
        JSON.stringify({
          audit: "session.started",
          sessionId: ctx.session.id,
          principalId: ctx.session.auth.current?.principalId ?? null,
        }),
      );
    },
    async "action.result"(event, ctx) {
      const action = event.data.result;
      if (action.kind !== "tool-result" || action.toolName !== "commit_entry") return;
      const output =
        typeof action.output === "object" && action.output !== null
          ? (action.output as Record<string, unknown>)
          : {};
      console.info(
        JSON.stringify({
          audit: "ledger.commit",
          sessionId: ctx.session.id,
          principalId: ctx.session.auth.current?.principalId ?? null,
          status: event.data.status,
          sha: output.sha ?? null,
          pushed: output.pushed ?? false,
        }),
      );
    },
  },
});
