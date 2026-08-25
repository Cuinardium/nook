import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

const outputSchema = z.discriminatedUnion("committed", [
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

export default defineTool({
  description:
    "Comitea y pushea en /workspace/ledger los cambios ya validados y mostrados al usuario. Un commit por entrada. Requiere aprobación.",
  inputSchema: z.object({
    message: z.string().min(1).describe("Mensaje del commit; usa la descripción de la transacción"),
  }),
  outputSchema,
  approval: always(),
  async execute({ message }, ctx) {
    const sb = await ctx.getSandbox();
    const repo = "/workspace/ledger";

    const status = await sb.run({ command: `git -C ${repo} status --porcelain` });
    if (!status.stdout.trim()) {
      return { committed: false, reason: "no hay cambios para commitear" };
    }

    // The message travels as a file so it is never shell-interpolated.
    await sb.writeTextFile({ path: "/workspace/.commit-msg", content: `${message}\n` });
    await sb.run({
      command: `git -C ${repo} add -A && git -C ${repo} commit -F /workspace/.commit-msg`,
    });
    await sb.run({ command: "rm -f /workspace/.commit-msg" });
    const sha = (await sb.run({ command: `git -C ${repo} rev-parse --short HEAD` })).stdout.trim();

    // Rebase first so concurrent pushes from other machines never block the user.
    const push = await sb.run({
      command: `git -C ${repo} pull --rebase --autostash && git -C ${repo} push`,
    });
    const pushed = push.exitCode === 0;
    const detail = pushed ? push.stdout : push.stderr

    return {
      committed: true,
      sha,
      pushed,
      detail
    };
  },
});
