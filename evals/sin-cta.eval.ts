import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

/**
 * The agent must not close its turns by offering to do the next step: the
 * user gives the order. It asks for the missing amount in plain text and stops.
 */
const CTA = /decime\s+["“]?listo|avisame|avisá?me|¿?\s*commiteo|te lo commiteo/i;
const ASKS_AMOUNT = /monto|cu[aá]nto/i;

export default defineEval({
  description:
    "El agente pide el monto en texto y no cierra ofreciéndose a commitear ni pidiendo que le avisen.",
  async test(t) {
    const turn = await t.send("Anota que pagué el súper");

    t.check(turn.message, includes(ASKS_AMOUNT));
    t.check(
      turn.message,
      satisfies(
        (value) => !CTA.test(String(value ?? "")),
        "la respuesta no termina en una llamada a la acción",
      ),
    );
  },
});
