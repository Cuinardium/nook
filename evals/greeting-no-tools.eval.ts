import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Saludo simple: responde sin tocar herramientas ni intentar acceder al repositorio.",
  async test(t) {
    await t.send("Hola, que hacés?");
    t.succeeded();
    t.usedNoTools();
  },
});
