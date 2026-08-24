import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Sin monto no se asienta: el agente pregunta con ask_question antes de escribir en el journal.",
  async test(t) {
    await t.send("Anota que pagué el súper");
    const request = t.requireInputRequest({ toolName: "ask_question" });
    await t.respond([{ requestId: request.requestId, text: "23450" }]);
    t.succeeded();
  },
});
