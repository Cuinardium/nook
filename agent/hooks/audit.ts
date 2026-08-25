import { defineHook } from "eve/hooks";
import { log } from "../lib/log";
import { sessionOwner } from "../lib/owner";
import { auditProjection as commitEntryAudit } from "../tools/commit_entry";
import { auditProjection as updatePricesAudit } from "../tools/update_prices";

/**
 * Audit trail for nook: structured log lines captured by `docker logs`.
 * Observe-only.
 *
 * A tool gets an audit row when it registers here. Its module exports an
 * `auditProjection(output)` mapping a successful output to extra fields;
 * rejected and failed outcomes get a generic row automatically.
 */
const AUDITED = [
  { name: "commit_entry", tag: "ledger.commit", project: commitEntryAudit },
  { name: "update_prices", tag: "ledger.prices", project: updatePricesAudit },
];

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
      if (action.kind !== "tool-result") {
        return;
      }

      const principalId =
        ctx.session.auth.current?.principalId ?? sessionOwner.get();

      if (!principalId) {
        log.error({
          audit: "tool",
          toolName: action.toolName,
          sessionId: ctx.session.id,
          status: event.data.status,
          msg: "tool result observed without authenticated principal",
        });
        return;
      }

      const entry = AUDITED.find(
        (candidate) => candidate.name === action.toolName,
      );
      if (!entry) {
        return;
      }

      const logBase = {
        audit: entry.tag,
        toolName: entry.name,
        sessionId: ctx.session.id,
        principalId,
        status: event.data.status,
      };

      // No tool output exists for keyboard rejections or thrown refusals.
      if (event.data.status === "rejected") {
        log.info(logBase);
        return;
      }
      if (event.data.status === "failed" || event.data.error) {
        log.warn({
          ...logBase,
          msg: event.data.error?.message ?? "la tool falló",
        });
        return;
      }

      try {
        log.info({ ...logBase, ...entry.project(action.output) });
      } catch (err) {
        log.warn({
          ...logBase,
          msg: err instanceof Error ? err.message : String(err),
          output: action.output,
        });
      }
    },
  },
});
