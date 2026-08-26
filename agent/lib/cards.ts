/**
 * Card texts for the Telegram channel.
 *
 * The confirmation and result cards are rendered as HTML (`parse_mode: HTML`)
 * so amounts and account lists read cleanly. Every dynamic string is escaped
 * in `escapeHtml` before it reaches Telegram to avoid broken markup or
 * injection from model- or user-derived text.
 */

/** Escape a string for safe inclusion in Telegram HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Structural subset of eve's InputRequest; avoids importing internal types. */
export type CommitApprovalRequest = {
  kind: string;
  action?: { toolName?: string; input?: { message?: unknown } } | null;
};

export function isCommitApproval(request: CommitApprovalRequest): boolean {
  return (
    request.kind === "tool-approval" && request.action?.toolName === "commit_entry"
  );
}

export function commitMessageOf(request: CommitApprovalRequest): string {
  const raw = request.action?.input?.message;
  return typeof raw === "string" ? raw : "(sin descripción)";
}

function transactionEmoji(amount: string): string {
  const trimmed = amount.trim();
  if (trimmed.startsWith("-")) {
    return "💸";
  }
  return "💰";
}

/**
 * Renders the commit approval card as HTML. The `message` is one line per
 * pending entry in the strict form `fecha | descripción | monto | cuentas`.
 * When every line parses, each entry becomes its own block; if any line
 * deviates we fall back to a single `<pre>` block so a malformed summary
 * never throws.
 */
export function commitApprovalCard(message: string): string {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = lines.map((line) => line.split("|").map((part) => part.trim()));
  const wellFormed = parsed.every((parts) => parts.length === 4);

  if (!wellFormed) {
    return `🧾 <b>Confirmar lote</b>\n\n<pre>${escapeHtml(message)}</pre>\n\n¿Confirmás? Se commitea y pushea al repo.`;
  }

  const entries = parsed
    .map(([fecha, descripcion, monto, cuentas]) => {
      const emoji = transactionEmoji(monto);
      return (
        `${emoji} <b>${escapeHtml(descripcion)}</b>\n` +
        `   <code>${escapeHtml(monto)}</code> · ${escapeHtml(fecha)}\n` +
        `   <i>${escapeHtml(cuentas)}</i>`
      );
    })
    .join("\n\n");

  const n = lines.length;
  return (
    `🧾 <b>Confirmar lote</b> — ${n} entrada${n === 1 ? "" : "s"}\n\n` +
    `${entries}\n\n¿Confirmás? Se commitea y pushea al repo.`
  );
}

import type { CommitOutput } from "../tools/commit_entry";

export type { CommitOutput };

export function commitResultCard(output: CommitOutput): string {
  if (!output.committed) {
    return `ℹ️ No hay nada para commitear (${escapeHtml(output.reason)}).`;
  }
  if (output.pushed) {
    return `✅ <b>Entrada registrada</b>\n\nCommit <code>${escapeHtml(output.sha ?? "?")}</code> pusheado al repo.`;
  }
  return [
    `⚠️ <b>Commit creado pero el push falló</b>`,
    ``,
    `Commit: <code>${escapeHtml(output.sha ?? "?")}</code>`,
    output.detail ? `<pre>${escapeHtml(output.detail.slice(0, 400))}</pre>` : "",
    ``,
    `Probá de nuevo en unos minutos; si sigue fallando revisá el token del forge.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function commitRejectedCard(): string {
  return "❌ <b>Ingesta cancelada</b>, no se tocó el repo.";
}
