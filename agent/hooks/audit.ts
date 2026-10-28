import { defineHook, type HookContext } from "eve/hooks";
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
 * Every line carries `ts`, `level`, `event`, `eventId` (the durable event id)
 * and the principal/session coordinates. Content stays out by default:
 * tool inputs are compacted and redacted, tool outputs are reduced to shape
 * and byte counts. The domain rows (`ledger.push`, `ledger.pull`,
 * `ledger.prices`) add the outcome fields the UI and evals care about.
 */
const AUDITED = [
  { name: "push", tag: "ledger.push", project: pushAudit },
  { name: "pull", tag: "ledger.pull", project: pullAudit },
  { name: "update_prices", tag: "ledger.prices", project: updatePricesAudit },
];

const callStartedAt = new Map<string, number>();
const turnStartedAt = new Map<string, number>();
const MAX_TRACKED = 2_000;

function scopedKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`;
}

function remember(
  map: Map<string, number>,
  key: string,
  value: number,
): void {
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

function elapsedMs(
  map: Map<string, number>,
  key: string,
  endMs: number,
): number | undefined {
  const start = map.get(key);
  if (start === undefined) {
    return undefined;
  }
  map.delete(key);
  return Math.max(0, endMs - start);
}

function eventMs(event: { readonly meta: { readonly at: string } }): number {
  const parsed = Date.parse(event.meta.at);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function principalIdOf(ctx: HookContext): string | undefined {
  return ctx.session.auth.current?.principalId ?? sessionOwner.get() ?? undefined;
}

function traceBase(
  event: { readonly meta: { readonly id: string } },
  ctx: HookContext,
  name: string,
): LogFields {
  return {
    event: name,
    eventId: event.meta.id,
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

function auditDomainTool(
  event: {
    readonly data: {
      readonly status: string;
      readonly error?: { readonly message: string } | undefined;
    };
  },
  action: { readonly toolName: string; readonly output: unknown },
  base: LogFields,
): void {
  const entry = AUDITED.find(
    (candidate) => candidate.name === action.toolName,
  );
  if (!entry) {
    return;
  }

  const domainBase: LogFields = {
    ...base,
    event: entry.tag,
    toolName: entry.name,
  };

  if (event.data.status === "rejected") {
    log.info(domainBase);
    return;
  }
  if (event.data.status === "failed" || event.data.error) {
    log.warn({
      ...domainBase,
      msg: event.data.error
        ? truncateText(event.data.error.message, 500)
        : "la tool falló",
    });
    return;
  }

  try {
    log.info({ ...domainBase, ...entry.project(action.output) });
  } catch (err) {
    log.warn({
      ...domainBase,
      msg: errorMessage(err),
      output: summarizeToolOutput(entry.name, action.output),
    });
  }
}

export default defineHook({
  events: {
    "session.started"(event, ctx) {
      safe("session.started", () => {
        log.info({
          ...traceBase(event, ctx, "session.started"),
          authenticated: Boolean(ctx.session.auth.current?.principalId),
        });
      });
    },

    "message.received"(event, ctx) {
      safe("message.received", () => {
        const attachments: Array<{ mediaType: string; bytes?: number }> = [];
        for (const part of event.data.parts ?? []) {
          if (part.type === "file") {
            attachments.push({
              mediaType: part.mediaType,
              bytes: part.size,
            });
          }
        }

        // The text itself stays out of the log: it is personal finance data.
        log.info({
          ...traceBase(event, ctx, "message.received"),
          turnId: event.data.turnId,
          sequence: event.data.sequence,
          chars: event.data.message.length,
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
          eventMs(event),
        );
        log.info({
          ...traceBase(event, ctx, "turn.started"),
          turnId: event.data.turnId,
          sequence: event.data.sequence,
        });
      });
    },

    "actions.requested"(event, ctx) {
      safe("actions.requested", () => {
        const base: LogFields = {
          ...traceBase(event, ctx, "action.requested"),
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          sequence: event.data.sequence,
          batchSize: event.data.actions.length,
        };

        for (const [index, action] of event.data.actions.entries()) {
          remember(
            callStartedAt,
            scopedKey(ctx.session.id, action.callId),
            eventMs(event),
          );

          switch (action.kind) {
            case "tool-call":
              log.info({
                ...base,
                event: "tool.requested",
                actionIndex: index,
                toolName: action.toolName,
                callId: action.callId,
                input: summarizeToolInput(action.toolName, action.input),
              });
              break;
            case "subagent-call":
              log.info({
                ...base,
                event: "subagent.requested",
                actionIndex: index,
                callId: action.callId,
                subagentName: action.subagentName,
                name: action.name,
                nodeId: action.nodeId,
                inputBytes: approxBytes(action.input),
              });
              break;
            case "remote-agent-call":
              log.info({
                ...base,
                event: "remote_agent.requested",
                actionIndex: index,
                callId: action.callId,
                remoteAgentName: action.remoteAgentName,
                name: action.name,
                nodeId: action.nodeId,
                inputBytes: approxBytes(action.input),
              });
              break;
            case "load-skill":
              log.info({
                ...base,
                event: "skill.requested",
                actionIndex: index,
                callId: action.callId,
                name: action.name,
                input: summarizeToolInput("load_skill", action.input),
              });
              break;
            case "workflow-tool-call":
              log.info({
                ...base,
                event: "tool.requested",
                actionIndex: index,
                toolName: action.toolName,
                callId: action.callId,
                workflowId: action.workflowId,
                input: summarizeToolInput(action.toolName, action.input),
              });
              break;
          }
        }
      });
    },

    "action.result"(event, ctx) {
      safe("action.result", () => {
        const action = event.data.result;
        const base: LogFields = {
          ...traceBase(event, ctx, "action.result"),
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          sequence: event.data.sequence,
          status: event.data.status,
          callId: action.callId,
          actionKind: action.kind,
          ms: elapsedMs(
            callStartedAt,
            scopedKey(ctx.session.id, action.callId),
            eventMs(event),
          ),
          errorCode: event.data.error?.code,
          errorMessage: event.data.error
            ? truncateText(event.data.error.message, 500)
            : undefined,
        };

        switch (action.kind) {
          case "tool-result":
            log.info({
              ...base,
              event: "tool.result",
              toolName: action.toolName,
              errorName: action.errorName,
              output: summarizeToolOutput(action.toolName, action.output),
            });
            auditDomainTool(event, action, base);
            break;
          case "subagent-result":
            log.info({
              ...base,
              event: "subagent.result",
              subagentName: action.subagentName,
              isError: action.isError === true,
              usage: "usage" in action ? action.usage : undefined,
              output: summarizeToolOutput("", action.output),
            });
            break;
          case "load-skill-result":
            log.info({
              ...base,
              event: "skill.result",
              name: action.name,
              isError: action.isError === true,
              output: summarizeToolOutput("", action.output),
            });
            break;
        }
      });
    },

    "input.requested"(event, ctx) {
      safe("input.requested", () => {
        for (const request of event.data.requests) {
          log.info({
            ...traceBase(event, ctx, "input.requested"),
            turnId: event.data.turnId,
            stepIndex: event.data.stepIndex,
            sequence: event.data.sequence,
            callId: event.data.callId,
            taskId: event.data.taskId,
            ...summarizeInputRequest(request),
          });
        }
      });
    },

    "input.resolved"(event, ctx) {
      safe("input.resolved", () => {
        for (const resolution of event.data.resolutions) {
          log.info({
            ...traceBase(event, ctx, "input.resolved"),
            turnId: event.data.turnId,
            stepIndex: event.data.stepIndex,
            sequence: event.data.sequence,
            ...summarizeInputResolution(resolution),
          });
        }
      });
    },

    "approval.settled"(event, ctx) {
      safe("approval.settled", () => {
        log.info({
          ...traceBase(event, ctx, "approval.settled"),
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          sequence: event.data.sequence,
          requestId: event.data.requestId,
          outcome: event.data.outcome,
          responderPrincipalId: event.data.responderPrincipalId,
        });
      });
    },

    "step.completed"(event, ctx) {
      safe("step.completed", () => {
        const usage = event.data.usage;
        log.info({
          ...traceBase(event, ctx, "step.completed"),
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          sequence: event.data.sequence,
          finishReason: event.data.finishReason,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          cacheReadTokens: usage?.cacheReadTokens,
          cacheWriteTokens: usage?.cacheWriteTokens,
          costUsd: usage?.costUsd,
        });
      });
    },

    "step.failed"(event, ctx) {
      safe("step.failed", () => {
        log.warn({
          ...traceBase(event, ctx, "step.failed"),
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          sequence: event.data.sequence,
          code: event.data.code,
          msg: truncateText(event.data.message, 500),
        });
      });
    },

    "turn.completed"(event, ctx) {
      safe("turn.completed", () => {
        log.info({
          ...traceBase(event, ctx, "turn.completed"),
          turnId: event.data.turnId,
          sequence: event.data.sequence,
          ms: elapsedMs(
            turnStartedAt,
            scopedKey(ctx.session.id, event.data.turnId),
            eventMs(event),
          ),
        });
      });
    },

    "turn.failed"(event, ctx) {
      safe("turn.failed", () => {
        log.warn({
          ...traceBase(event, ctx, "turn.failed"),
          turnId: event.data.turnId,
          sequence: event.data.sequence,
          code: event.data.code,
          msg: truncateText(event.data.message, 500),
          ms: elapsedMs(
            turnStartedAt,
            scopedKey(ctx.session.id, event.data.turnId),
            eventMs(event),
          ),
        });
      });
    },

    "turn.cancelled"(event, ctx) {
      safe("turn.cancelled", () => {
        log.info({
          ...traceBase(event, ctx, "turn.cancelled"),
          turnId: event.data.turnId,
          sequence: event.data.sequence,
          ms: elapsedMs(
            turnStartedAt,
            scopedKey(ctx.session.id, event.data.turnId),
            eventMs(event),
          ),
        });
      });
    },

    "session.failed"(event, ctx) {
      safe("session.failed", () => {
        log.error({
          ...traceBase(event, ctx, "session.failed"),
          code: event.data.code,
          msg: truncateText(event.data.message, 500),
        });
      });
    },

    "session.completed"(event, ctx) {
      safe("session.completed", () => {
        log.info(traceBase(event, ctx, "session.completed"));
      });
    },
  },
});
