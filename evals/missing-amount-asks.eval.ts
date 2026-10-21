import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "Sin monto no se asienta: el agente pregunta el monto en texto antes de escribir en el journal.",
  async test(t) {
    const turn = await t.send("Anota que pagué el súper");
    t.succeeded();
    t.check(turn.message, includes(/monto|cu[aá]nto/i));
  },
});
