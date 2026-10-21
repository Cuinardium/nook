import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// Resolved from the app root, which is the eval runner's working directory.
const RECEIPT = "evals/fixtures/receipt-verduleria.jpg";

/**
 * Attachment evals need a session whose principal is registered in the user
 * registry, because eve stages the file in that session's sandbox. The local
 * eval server runs as `local-dev`, which nook refuses by design, so this case
 * stays skipped unless the runner is pointed at a provisioned target.
 */
const ENABLED = process.env.NOOK_EVAL_ATTACHMENTS === "1";

export default defineEval({
  description:
    "Un comprobante adjunto se lee: extrae fecha, monto total y comercio sin escribir en el journal.",
  tags: ["attachments"],
  async test(t) {
    if (!ENABLED) {
      t.skip(
        "requiere NOOK_EVAL_ATTACHMENTS=1 y un target con un principal registrado",
      );
    }

    const session = await t.session();
    const turn = await session.sendFile(
      "Te mando el comprobante de la verdulería. No escribas nada todavía: decime fecha, monto total y comercio.",
      RECEIPT,
      "image/jpeg",
    );

    t.succeeded();
    t.check(turn.message, includes(/7[.,]450/));
    t.check(
      turn.message,
      includes(/20\/10\/2026|2026-10-20|20 de octubre/i),
    );
    t.check(turn.message, includes(/don pedro|verduler/i));
  },
});
