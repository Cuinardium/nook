import { defineHook, type HookContext } from "eve/hooks";
import { delivery } from "eve/events";
import {
  approxBytes,
  errorMessage,
  summarizeInputRequest,
  summarizeInputResolution,
  summarizeToolInput,
  summarizeToolOutput,
  truncateText,
} from "../lib/audit-fields";
import { log, type LogFields } from "../lib/log";
import { sessionOwner } from "../lib/owner";
import { auditProjection as pushAudit } from "../tools/push";
import { auditProjection as pullAudit } from "../tools/pull";
import { auditProjection as updatePricesAudit } from "../tools/update_prices";

/**
 * Structured activity trail for nook, captured by `docker logs`.
 * Observe-only.
 *
 * Every line carries `ts`, `level`, `event`, `eventId` (the committed line and
 * its index, which is the event's stable position on the session stream) and
 * the principal/session coordinates. Content stays out by default: tool inputs
 * are compacted and redacted, tool outputs are reduced to shape and byte
 * counts. The domain rows (`ledger.push`, `ledger.pull`, `ledger.prices`) add
 * the outcome fields the UI and evals care about.
 *
 * The stream is session-events v27: one event ends each item with an
 * `outcome`, calls are `call.requested`/`call.settled`, and token usage comes
 * from `usage.recorded`.
 */
const AUDITED = [
  { name: "push", tag: "ledger.push", project: pushAudit },
  { name: "pull", tag: "ledger.pull", project: pullAudit },
  { name: "update_prices", tag: "ledger.prices", project: updatePricesAudit },
];

type CallIdentity = {
  kind: string;
  name: string;
  remote: boolean;
};

const callStartedAt = new Map<string, number>();
const callIdentity = new Map<string, CallIdentity>();
const turnStartedAt = new Map<string, number>();
const runStartedAt = new Map<string, { at: number; attempt: number }>();
const interactionKind = new Map<string, string>();
const responseDelivery = new Map<string, string>();
const MAX_TRACKED = 2_000;

function scopedKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`;
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

function take<T>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
  }
  return value;
}

function elapsedMs(
  map: Map<string, number>,
  key: string,
): number | undefined {
  const start = take(map, key);
  if (start === undefined) {
    return undefined;
  }
  return Math.max(0, Date.now() - start);
}

/** Who answered a request: the principal of the delivery the answer arrived in. */
function responderPrincipal(
  ctx: HookContext,
  deliveryId: string,
): string | undefined {
  return delivery(ctx.view, deliveryId)?.principal?.id;
}

function principalIdOf(ctx: HookContext): string | undefined {
  return (
    ctx.session.auth.current?.principalId ?? sessionOwner.get() ?? undefined
  );
}

/** Stable, ordered coordinate of the event on the session stream. */
function eventIdOf(ctx: HookContext): string {
  return `${ctx.position.line}.${ctx.position.index}`;
}

function traceBase(ctx: HookContext, name: string): LogFields {
  return {
    event: name,
    eventId: eventIdOf(ctx),
    sessionId: ctx.session.id,
    principalId: principalIdOf(ctx) ?? null,
    channel: ctx.channel.kind,
  };
}

function safe(auditEvent: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    log.error({
      event: "audit.failed",
      auditEvent,
      msg: errorMessage(err),
    });
  }
}

function errorFields(error: { code: string; message: string } | undefined) {
  return {
    errorCode: error?.code,
    errorMessage: error ? truncateText(error.message, 500) : undefined,
  };
}

function auditDomainTool(
  toolName: string,
  outcome: string,
  output: unknown,
  base: LogFields,
): void {
  const entry = AUDITED.find((candidate) => candidate.name === toolName);
  if (!entry) {
    return;
  }

  const domainBase: LogFields = {
    ...base,
    event: entry.tag,
    toolName,
  };

  if (outcome === "rejected") {
    log.info(domainBase);
    return;
  }
  if (outcome !== "completed") {
    log.warn({
      ...domainBase,
      msg: `la tool terminó con outcome ${outcome}`,
    });
    return;
  }

  try {
    log.info({ ...domainBase, ...entry.project(output) });
  } catch (err) {
    log.warn({
      ...domainBase,
      msg: errorMessage(err),
      output: summarizeToolOutput(toolName, output),
    });
  }
}

export default defineHook({
  events: {
    "session.started"(event, ctx) {
      safe("session.started", () => {
        log.info({
          ...traceBase(ctx, "session.started"),
          authenticated: Boolean(ctx.session.auth.current?.principalId),
          eveVersion: event.data.runtime?.eveVersion,
          replaced: event.data.predecessor?.sessionId,
        });
      });
    },

    "delivery.consumed"(event, ctx) {
      safe("delivery.consumed", () => {
        const attachments: Array<{ mediaType: string; bytes?: number }> = [];
        let chars = 0;
        for (const part of event.data.parts) {
          if (part.kind === "text") {
            chars += part.text.length;
          } else if (part.kind === "file") {
            attachments.push({ mediaType: part.mediaType, bytes: part.size });
          }
        }

        // The text itself stays out of the log: it is personal finance data.
        log.info({
          ...traceBase(ctx, "message.received"),
          turnId: event.data.turnId,
          deliveryId: event.data.deliveryId,
          chars,
          attachmentCount: attachments.length,
          attachments,
        });
      });
    },

    "turn.started"(event, ctx) {
      safe("turn.started", () => {
        remember(
          turnStartedAt,
          scopedKey(ctx.session.id, event.data.turnId),
          Date.now(),
        );
        log.info({
          ...traceBase(ctx, "turn.started"),
          turnId: event.data.turnId,
          follows: event.data.follows,
        });
      });
    },

    "call.requested"(event, ctx) {
      safe("call.requested", () => {
        const { callId, capability } = event.data;
        const name = capability.name;
        const remote = capability.remote === true;
        remember(callIdentity, callId, {
          kind: capability.kind,
          name,
          remote,
        });
        remember(
          callStartedAt,
          scopedKey(ctx.session.id, callId),
          Date.now(),
        );

        const base: LogFields = {
          ...traceBase(ctx, "tool.requested"),
          turnId: event.scope?.turnId,
          runId: event.scope?.runId,
          callId,
          capabilityKind: capability.kind,
          hidden: capability.hidden === true,
          label: capability.label,
          inputError: event.data.inputError?.code,
        };

        switch (capability.kind) {
          case "tool":
            log.info({
              ...base,
              toolName: name,
              input: summarizeToolInput(name, event.data.input),
            });
            return;
          case "agent":
            log.info({
              ...base,
              event: remote ? "remote_agent.requested" : "subagent.requested",
              subagentName: name,
              inputBytes: approxBytes(event.data.input),
            });
            return;
          case "skill":
            log.info({
              ...base,
              event: "skill.requested",
              name,
              inputBytes: approxBytes(event.data.input),
            });
            return;
          default:
            log.info({ ...base, event: "control.requested", name });
        }
      });
    },

    "call.settled"(event, ctx) {
      safe("call.settled", () => {
        const { callId, outcome, output } = event.data;
        const identity = callIdentity.get(callId);
        const base: LogFields = {
          ...traceBase(ctx, "tool.result"),
          turnId: event.scope?.turnId,
          runId: event.scope?.runId,
          status: outcome,
          callId,
          capabilityKind: identity?.kind,
          ms: elapsedMs(callStartedAt, scopedKey(ctx.session.id, callId)),
          ...errorFields(event.data.error),
          outputOf: event.data.outputOf?.callId,
        };

        if (!identity) {
          log.info({ ...base, event: "call.settled" });
          return;
        }

        switch (identity.kind) {
          case "tool":
            log.info({
              ...base,
              toolName: identity.name,
              output: summarizeToolOutput(identity.name, output),
            });
            auditDomainTool(identity.name, outcome, output, base);
            return;
          case "agent":
            log.info({
              ...base,
              event: identity.remote
                ? "remote_agent.result"
                : "subagent.result",
              subagentName: identity.name,
              label: event.data.label,
              output: summarizeToolOutput("", output),
            });
            return;
          case "skill":
            log.info({
              ...base,
              event: "skill.result",
              name: identity.name,
              label: event.data.label,
            });
            return;
          default:
            log.info({ ...base, event: "control.settled", name: identity.name });
        }
      });
    },

    "interaction.opened"(event, ctx) {
      safe("interaction.opened", () => {
        const { interactionId, request, subject } = event.data;
        const callId = "callId" in subject ? subject.callId : undefined;
        remember(interactionKind, interactionId, request.kind);

        log.info({
          ...traceBase(ctx, "input.requested"),
          turnId: ctx.turn?.id,
          interactionId,
          callId,
          toolName: callId ? callIdentity.get(callId)?.name : undefined,
          ...summarizeInputRequest({
            interactionId,
            kind: request.kind,
            prompt: request.prompt,
            options: request.options,
            allowFreeform: request.allowFreeform,
            display: request.display,
          }),
        });
      });
    },

    "response.submitted"(event) {
      safe("response.submitted", () => {
        remember(
          responseDelivery,
          event.data.interactionId,
          event.data.deliveryId,
        );
      });
    },

    "interaction.settled"(event, ctx) {
      safe("interaction.settled", () => {
        const kind = take(interactionKind, event.data.interactionId);
        const deliveryId = take(responseDelivery, event.data.interactionId);
        const responderId =
          deliveryId === undefined
            ? undefined
            : responderPrincipal(ctx, deliveryId);

        log.info({
          ...traceBase(ctx, "input.resolved"),
          interactionId: event.data.interactionId,
          reason: event.data.reason,
          responderPrincipalId: responderId,
          ...summarizeInputResolution({
            interactionId: event.data.interactionId,
            kind,
            outcome: event.data.outcome,
            response: event.data.response,
          }),
        });

        if (kind === "approval" || kind === "budget") {
          log.info({
            ...traceBase(ctx, "approval.settled"),
            interactionId: event.data.interactionId,
            inputKind: kind,
            outcome: event.data.outcome,
            responderPrincipalId: responderId,
          });
        }
      });
    },

    "model.started"(event, ctx) {
      safe("model.started", () => {
        remember(
          runStartedAt,
          scopedKey(ctx.session.id, event.data.runId),
          { at: Date.now(), attempt: event.data.attempt },
        );
      });
    },

    "model.settled"(event, ctx) {
      safe("model.settled", () => {
        const key = scopedKey(ctx.session.id, event.data.runId);
        const started = take(runStartedAt, key);
        const base: LogFields = {
          ...traceBase(ctx, "step.completed"),
          turnId: event.scope?.turnId,
          runId: event.data.runId,
          attempt: started?.attempt,
          ms: started === undefined ? undefined : Date.now() - started.at,
          finishReason: event.data.finishReason,
        };

        if (event.data.outcome === "completed") {
          log.info(base);
          return;
        }
        log.warn({
          ...base,
          event: "step.failed",
          outcome: event.data.outcome,
          ...errorFields(event.data.error),
        });
      });
    },

    "model.retried"(event, ctx) {
      safe("model.retried", () => {
        log.warn({
          ...traceBase(ctx, "step.retried"),
          turnId: event.scope?.turnId,
          runId: event.data.runId,
          attempt: event.data.attempt,
          ...errorFields(event.data.error),
        });
      });
    },

    "usage.recorded"(event, ctx) {
      safe("usage.recorded", () => {
        const owner = event.data.owner;
        log.info({
          ...traceBase(ctx, "usage"),
          turnId: event.scope?.turnId,
          runId: owner && "runId" in owner ? owner.runId : undefined,
          usageKind: event.data.kind,
          inputTokens: event.data.usage.inputTokens,
          outputTokens: event.data.usage.outputTokens,
          cacheReadTokens: event.data.usage.cacheReadTokens,
          cacheWriteTokens: event.data.usage.cacheWriteTokens,
          costUsd: event.data.usage.costUsd,
        });
      });
    },

    "delivery.settled"(event, ctx) {
      safe("delivery.settled", () => {
        log.info({
          ...traceBase(ctx, "message.settled"),
          turnId: event.data.turnId,
          deliveryId: event.data.deliveryId,
          outcome: event.data.outcome,
          reason: event.data.reason,
        });
      });
    },

    "turn.settled"(event, ctx) {
      safe("turn.settled", () => {
        const turnId = event.data.turnId;
        const base: LogFields = {
          ...traceBase(ctx, "turn.completed"),
          turnId,
          ms: elapsedMs(turnStartedAt, scopedKey(ctx.session.id, turnId)),
          replyParts: event.data.reply?.length,
        };

        switch (event.data.outcome) {
          case "completed":
            log.info(base);
            return;
          case "cancelled":
            log.info({ ...base, event: "turn.cancelled" });
            return;
          default:
            log.warn({
              ...base,
              event: "turn.failed",
              ...errorFields(event.data.error),
            });
        }
      });
    },

    "session.ended"(event, ctx) {
      safe("session.ended", () => {
        if (event.data.outcome === "completed") {
          log.info(traceBase(ctx, "session.completed"));
          return;
        }
        log.error({
          ...traceBase(ctx, "session.failed"),
          ...errorFields(event.data.error),
        });
      });
    },

    "context.settled"(event, ctx) {
      safe("context.settled", () => {
        const base: LogFields = {
          ...traceBase(ctx, "context.settled"),
          contextKind: event.data.kind,
          outcome: event.data.outcome,
          ...errorFields(event.data.error),
        };
        if (event.data.outcome === "completed") {
          log.info(base);
          return;
        }
        log.warn(base);
      });
    },
  },
});
