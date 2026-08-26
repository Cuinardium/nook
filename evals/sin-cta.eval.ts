import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * The agent must not close its turns by offering to do the next step: the
 * user gives the order. This runs without the sandbox — it parks on the
 * question before any repo access — so it stays cheap enough to keep in CI.
 */
const CTA = /decime\s+["“]?listo|avisame|avisá?me|¿?\s*commiteo|te lo commiteo/i;

export default defineEval({
  description:
    "El agente no cierra ofreciéndose a commitear ni pidiendo que le avisen.",
  async test(t) {
    await t.send("Anota que pagué el súper");
    const request = t.requireInputRequest({ toolName: "ask_question" });
    await t.respond([{ requestId: request.requestId, text: "23450" }]);

    t.check(
      t.reply,
      satisfies(
        (value) => !CTA.test(String(value ?? "")),
        "la respuesta no termina en una llamada a la acción",
      ),
    );
  },
});
