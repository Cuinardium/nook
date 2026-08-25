import { defineTool } from "eve/tools";
import { z } from "zod";
import { config } from "../lib/config";
import type { LogFields } from "../lib/log";

const outputSchema = z.discriminatedUnion("updated", [
  z.object({
    updated: z.literal(true),
    date: z.string(),
    entries: z.number().int().positive(),
  }),
  z.object({
    updated: z.literal(false),
    reason: z.string(),
  }),
]);

export type UpdatePricesOutput = z.infer<typeof outputSchema>;

/** Audit fields for the ledger.prices row; throws when output drifts off-contract. */
export function auditProjection(raw: unknown): LogFields {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("update_prices output did not match its schema");
  }
  return parsed.data.updated
    ? { date: parsed.data.date, entries: parsed.data.entries }
    : { reason: parsed.data.reason };
}

type DolarApiEntry = {
  casa: string;
  venta: number | null;
};

function priceKindOf(casa: string): string {
  if (casa === "bolsa") {
    return "MEP";
  }
  if (casa === "contadoconliqui") {
    return "CCL";
  }
  return casa.toUpperCase();
}

export default defineTool({
  description:
    "Actualiza precios/dolares.journal con las cotizaciones del día (dolarapi). Usalo antes de valorar posiciones en ARS, al registrar operaciones de cartera, o si hledger se queja de precios faltantes o desactualizados. No toca stocks.",
  inputSchema: z.object({}),
  outputSchema,
  async execute(_input, ctx) {
    const sb = await ctx.getSandbox();

    // Only journals that include precios/ need the file at all.
    const includes = await sb.run({
      command:
        "cd /workspace/ledger && ls *.journal >/dev/null 2>&1 && " +
        "grep -l '^include precios/' *.journal || true",
    });
    if (!includes.stdout.trim()) {
      return {
        updated: false,
        reason: "los journals raíz no incluyen precios/",
      };
    }

    const response = await fetch("https://dolarapi.com/v1/dolares");
    if (!response.ok) {
      throw new Error(`dolarapi respondió ${response.status}`);
    }
    const data = (await response.json()) as DolarApiEntry[];

    // Date in the user's timezone, matching what the journal expects.
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone,
    }).format(new Date());

    const bolsas = data.find((d) => d.casa === "bolsa");
    if (!bolsas || bolsas.venta == null) {
      throw new Error("dolarapi no devolvió cotización 'bolsa'");
    }

    const lines = [
      ...data
        .filter((d) => d.venta != null)
        .map((d) => `P ${date} USD_${priceKindOf(d.casa)} ${d.venta} ARS`),
      `P ${date} USD ${bolsas.venta} $`,
      `P ${date} ARS 1 $`,
    ];

    await sb.run({ command: "mkdir -p /workspace/ledger/precios" });
    await sb.writeTextFile({
      path: "/workspace/ledger/precios/dolares.journal",
      content: `${lines.join("\n")}\n`,
    });

    return { updated: true, date, entries: lines.length };
  },
});
