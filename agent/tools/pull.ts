import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  outcomeSchema,
  pullOnly,
  type LedgerOutcome,
} from "../lib/ledger-repo.ts";
import type { LogFields } from "../lib/log.ts";
import { sessionOwner } from "../lib/owner.ts";
import { getUserByPrincipal } from "../lib/users.ts";

/**
 * The read side of the network door. Brings remote changes in (fetch +
 * rebase) without pushing anything, with credentials injected per operation.
 * No approval: it never publishes local work. Local commits (if any) are
 * rebased onto the remote and left unpushed — run `push` afterwards.
 */
export const outputSchema = outcomeSchema;
export type PullOutput = LedgerOutcome;

/** Audit fields for the ledger.pull row; throws when output drifts off-contract. */
export function auditProjection(raw: unknown): LogFields {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("pull output did not match its schema");
  }
  const out = parsed.data;
  switch (out.status) {
    case "pulled":
      return { status: out.status, sha: out.sha, pushed: false };
    case "pull_failed":
      return { status: out.status, pushed: false, reason: out.detail };
    case "conflict":
      return { status: out.status, pushed: false, files: out.files };
    case "blocked":
    case "clean":
      return { status: out.status, pushed: false, reason: out.reason };
    case "pushed":
    case "push_failed":
      return { status: out.status, pushed: false, sha: out.sha };
  }
}

export default defineTool({
  description:
    "Trae lo nuevo del remoto del ledger en /workspace/ledger sin pushear nada: fetch + rebase para analizar lo que se pusheó desde otra máquina. No necesita aprobación. Si hay commits locales sin pushear, los rebasea encima y los deja sin pushear (después usá push). Devuelve un status estructurado.",
  inputSchema: z.object({}),
  outputSchema,
  async execute(_input, ctx) {
    // Same principal resolution as push: fail closed before any git work.
    const principalId =
      ctx.session.auth.current?.principalId ?? sessionOwner.get();

    if (!principalId) {
      throw new Error("pull: no se pudo resolver el principal de la sesión");
    }

    const user = getUserByPrincipal(principalId);
    if (!user) {
      throw new Error(
        `pull: el principal ${principalId} no está en el registro de usuarios`,
      );
    }

    const sb = await ctx.getSandbox();
    return await pullOnly(sb, user);
  },
});
