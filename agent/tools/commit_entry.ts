import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { gitAuthFlag, withForgeCredentials } from "../lib/forge";
import type { LogFields } from "../lib/log";
import { sessionOwner } from "../lib/owner";
import { getUserByPrincipal } from "../lib/users";

const JOURNAL_PATH = /^[\w.-]+\.journal$/;

export const outputSchema = z.discriminatedUnion("committed", [
  z.object({
    committed: z.literal(false),
    reason: z.string(),
  }),
  z.object({
    committed: z.literal(true),
    sha: z.string(),
    pushed: z.boolean(),
    detail: z.string(),
  }),
]);

export type CommitOutput = z.infer<typeof outputSchema>;

/** Audit fields for the ledger.commit row; throws when output drifts off-contract. */
export function auditProjection(raw: unknown): LogFields {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("commit_entry output did not match its schema");
  }
  return parsed.data.committed
    ? { sha: parsed.data.sha, pushed: parsed.data.pushed }
    : { sha: null, pushed: false, reason: parsed.data.reason };
}

export default defineTool({
  description:
    "Comitea y pushea en /workspace/ledger los cambios ya validados y mostrados al usuario. Solo commitea los *.journal de la raíz; si hay otros cambios pendientes, rechaza. Requiere aprobación.",
  inputSchema: z.object({
    message: z
      .string()
      .min(1)
      .describe("Mensaje del commit; usa la descripción de la transacción"),
  }),
  outputSchema,
  approval: always(),
  async execute({ message }, ctx) {
    const sb = await ctx.getSandbox();
    const repo = "/workspace/ledger";

    // Credentials are injected per operation (post-approval); resolving the
    // user here means a removed principal fails closed before any git work.
    // Telegram approval responses resume the turn anonymously, so session
    // auth alone is not enough — fall back to the captured owner.
    const principalId =
      ctx.session.auth.current?.principalId ??
      sessionOwner.get()

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

    const status = await sb.run({
      command: `git -C ${repo} status --porcelain`,
    });
    if (!status.stdout.trim()) {
      return { committed: false, reason: "no hay cambios para commitear" };
    }

    // The message travels as a file so it is never shell-interpolated.
    await sb.writeTextFile({
      path: "/workspace/.commit-msg",
      content: `${message}\n`,
    });

    // Only commit top level *.journal
    await sb.run({
      command: `git -C ${repo} add -- ':(top)*.journal'`,
    });

    // Anything still dirty was not staged: foreign dirt refuses the commit
    // and rolls the index back. Detection only — lines are never parsed.
    const leftover = await sb.run({
      command: `git -C ${repo} status --porcelain`,
    });
    if (leftover.stdout.trim()) {
      await sb.run({ command: `git -C ${repo} reset` });
      throw new Error(
        `commit_entry: hay cambios por fuera de los journals raíz:\n${leftover.stdout.trim()}`,
      );
    }

    // Verify what is actually staged before committing.
    const staged = await sb.run({
      command: `git -C ${repo} diff --cached --name-only`,
    });

    const stagedPaths = staged.stdout.split("\n").filter((line) => line.trim());
    const invalidIndex =
      stagedPaths.length === 0 ||
      stagedPaths.some((p) => !JOURNAL_PATH.test(p));

    if (invalidIndex) {
      await sb.run({ command: `git -C ${repo} reset` });
      throw new Error(
        `commit_entry: el índice quedó con cambios inesperados:\n${stagedPaths.join("\n")}`,
      );
    }

    await sb.run({
      command: `git -C ${repo} commit -F /workspace/.commit-msg`,
    });
    await sb.run({ command: "rm -f /workspace/.commit-msg" });
    const sha = (
      await sb.run({ command: `git -C ${repo} rev-parse --short HEAD` })
    ).stdout.trim();

    // Rebase first so concurrent pushes from other machines never block the
    // user. Network ops run with per-operation credential injection.
    let pushed = false;
    let detail = "";
    await withForgeCredentials(sb, user, async () => {
      const auth = gitAuthFlag();
      const push = await sb.run({
        command:
          `git -C ${repo} ${auth} pull --rebase --autostash && ` +
          `git -C ${repo} ${auth} push`,
      });
      pushed = push.exitCode === 0;
      detail = pushed ? push.stdout : push.stderr;
    });;

    return {
      committed: true,
      sha,
      pushed,
      detail,
    };
  },
});
