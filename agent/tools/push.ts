import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import {
  outcomeSchema,
  pushPending,
  type LedgerOutcome,
} from "../lib/ledger-repo.ts";
import type { LogFields } from "../lib/log.ts";
import { sessionOwner } from "../lib/owner.ts";
import { getUserByPrincipal } from "../lib/users.ts";

/**
 * The only door to the network. Local git (add, commit, rebase --continue…)
 * is free via `bash`; this tool only rebases onto the remote and pushes,
 * with credentials injected per operation. Approval is blind by design
 * (option C): the card just says "push pending commits?", the user trusts
 * the agent's criteria for what is in them.
 */
export const outputSchema = outcomeSchema;
export type PushOutput = LedgerOutcome;

/** Audit fields for the ledger.push row; throws when output drifts off-contract. */
export function auditProjection(raw: unknown): LogFields {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("push output did not match its schema");
  }
  const out = parsed.data;
  switch (out.status) {
    case "pushed":
      return { status: out.status, sha: out.sha, pushed: true };
    case "push_failed":
      return { status: out.status, sha: out.sha, pushed: false };
    case "conflict":
      return { status: out.status, pushed: false, files: out.files };
    case "blocked":
    case "clean":
      return { status: out.status, pushed: false, reason: out.reason };
    case "pulled":
      return { status: out.status, pushed: false, sha: out.sha };
    case "pull_failed":
      return { status: out.status, pushed: false, reason: out.detail };
  }
}

export default defineTool({
  description:
    "Pushea al remoto del ledger en /workspace/ledger: rebasea los commits locales sobre el remoto y los pushea (pide aprobación, a ciegas: no muestra el contenido). El git local (add, commit, resolver conflictos) lo hacés vos con bash. Devuelve un status estructurado; nunca pongas credenciales ni toques el remote a mano.",
  inputSchema: z.object({}),
  outputSchema,
  approval: always(),
  async execute(_input, ctx) {
    // Credentials are injected per operation (post-approval); resolving the
    // user here means a removed principal fails closed before any git work.
    // Telegram approval responses resume the turn anonymously, so session
    // auth alone is not enough — fall back to the captured owner.
    const principalId =
      ctx.session.auth.current?.principalId ?? sessionOwner.get();

    if (!principalId) {
      throw new Error("push: no se pudo resolver el principal de la sesión");
    }

    const user = getUserByPrincipal(principalId);
    if (!user) {
      throw new Error(
        `push: el principal ${principalId} no está en el registro de usuarios`,
      );
    }

    const sb = await ctx.getSandbox();
    return await pushPending(sb, user);
  },
});
