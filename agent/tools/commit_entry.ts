import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  abortRebase,
  commitAndSync,
  continueRebase,
  intentSchema,
  type LedgerOutcome,
  outcomeSchema,
  syncOnly,
} from "../lib/ledger-repo.ts";
import type { LogFields } from "../lib/log.ts";
import { sessionOwner } from "../lib/owner.ts";
import { getUserByPrincipal } from "../lib/users.ts";

/**
 * The only door to git. Thin on purpose: it resolves who is asking, then
 * dispatches to the ledger state machine in `lib/ledger-repo`.
 *
 *   commit   → stage root journals, commit, rebase, push (needs approval)
 *   sync     → no commit; rebase and push what is pending
 *   continue → finish a rebase the agent just resolved, then push
 *   abort    → drop a stuck rebase, keeping the local commit
 *
 * The recovery intents exist so the agent never improvises plumbing
 * (`reset --soft`, a manual `push`) when the happy path breaks.
 */
export const outputSchema = outcomeSchema;
export type CommitOutput = LedgerOutcome;

/** Audit fields for the ledger.commit row; throws when output drifts off-contract. */
export function auditProjection(raw: unknown): LogFields {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("commit_entry output did not match its schema");
  }
  const out = parsed.data;
  switch (out.status) {
    case "committed_pushed":
    case "pushed_only":
      return { status: out.status, sha: out.sha, pushed: true };
    case "push_failed":
      return { status: out.status, sha: out.sha, pushed: false };
    case "conflict":
      return { status: out.status, pushed: false, files: out.files };
    case "blocked":
      return { status: out.status, pushed: false, reason: out.reason };
    default:
      return { status: out.status, pushed: false, reason: out.reason };
  }
}

export default defineTool({
  description:
    "Única puerta a git en /workspace/ledger. intent=commit: staged de los *.journal raíz, commit y push (pide aprobación). intent=sync: sin commit, rebasea y pushea lo pendiente. intent=continue: cierra un rebase cuyos conflictos ya resolviste. intent=abort: descarta un rebase trabado sin perder el commit local. Devuelve un status estructurado; nunca hagas git a mano.",
  inputSchema: z.object({
    intent: intentSchema.describe(
      "commit (default) | sync | continue | abort. Ver la descripción de la tool.",
    ),
    message: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Solo para intent=commit. Una línea por entrada: `AAAA-MM-DD | descripción | monto | cuentas`.",
      ),
  }),
  outputSchema,
  // Only a new commit needs a human: it is the step that authors content. The
  // recovery intents move or push work the user already approved, and none of
  // them can create a commit out of a dirty worktree.
  approval: ({ toolInput }) => {
    const intent = (toolInput as { intent?: string } | undefined)?.intent;
    return intent === undefined || intent === "commit"
      ? "user-approval"
      : "not-applicable";
  },
  async execute({ intent = "commit", message }, ctx) {
    // Credentials are injected per operation (post-approval); resolving the
    // user here means a removed principal fails closed before any git work.
    // Telegram approval responses resume the turn anonymously, so session
    // auth alone is not enough — fall back to the captured owner.
    const principalId =
      ctx.session.auth.current?.principalId ?? sessionOwner.get();

    if (!principalId) {
      throw new Error(
        "commit_entry: no se pudo resolver el principal de la sesión",
      );
    }

    const user = getUserByPrincipal(principalId);
    if (!user) {
      throw new Error(
        `commit_entry: el principal ${principalId} no está en el registro de usuarios`,
      );
    }

    const sb = await ctx.getSandbox();

    switch (intent) {
      case "abort":
        return await abortRebase(sb);
      case "continue":
        return await continueRebase(sb, user);
      case "sync":
        return await syncOnly(sb, user);
      default: {
        if (!message) {
          throw new Error("commit_entry: intent=commit requiere `message`");
        }
        return await commitAndSync(sb, user, message);
      }
    }
  },
});
