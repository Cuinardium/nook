/**
 * Card texts for the Telegram channel.
 *
 * Cards are rendered as HTML (`parse_mode: HTML`). Every dynamic string is
 * escaped in `escapeHtml` before it reaches Telegram to avoid broken markup
 * or injection from model- or user-derived text.
 *
 * Design rule: the card carries the summary, the detail hides inside an
 * expandable blockquote. Nothing raw from git ever reaches the user — the
 * tool hands over a status and a short detail, and each status gets its own
 * card here.
 */

import type { LedgerOutcome as CommitOutput } from "./ledger-repo.ts";

export type { CommitOutput };

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
  action?: {
    toolName?: string;
    input?: { message?: unknown; intent?: unknown };
  } | null;
};

export function isCommitApproval(request: CommitApprovalRequest): boolean {
  return (
    request.kind === "tool-approval" &&
    request.action?.toolName === "commit_entry"
  );
}

export function commitMessageOf(request: CommitApprovalRequest): string {
  const raw = request.action?.input?.message;
  return typeof raw === "string" ? raw : "(sin descripción)";
}

type Entry = {
  fecha: string;
  descripcion: string;
  monto: string;
  cuentas: string;
};

function transactionEmoji(amount: string): string {
  return amount.trim().startsWith("-") ? "💸" : "💰";
}

/** The non-numeric part of an amount (`$`, `USD`, …), or "" when there is none. */
function currencyOf(amount: string): string {
  return amount.replace(/[\d.,\s+-]/g, "").trim();
}

/**
 * Parses an amount into a number. Handles both `1.234,56` and `1,234.56`:
 * whichever separator comes last is the decimal one. Returns `null` when the
 * string has no digits, which keeps a malformed line from poisoning a total.
 */
function amountValue(amount: string): number | null {
  const digits = amount.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(digits)) {
    return null;
  }
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    normalized = digits
      .split(thousands)
      .join("")
      .replace(decimal, ".");
  } else {
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
    // A single separator with exactly three trailing digits is a thousands
    // separator (`4.500`); anything else is a decimal point.
    normalized = !sep
      ? digits
      : /[.,]\d{3}$/.test(digits)
        ? digits.split(sep).join("")
        : digits.replace(sep, ".");
  }
  const value = Number.parseFloat(normalized);
  return Number.isNaN(value) ? null : value;
}

function formatAmount(value: number, currency: string): string {
  const body = new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  const sign = value < 0 ? "-" : "";
  return currency ? `${sign}${currency}${body}` : `${sign}${body}`;
}

/**
 * Net of the batch, or `null` when the entries mix commodities or any amount
 * fails to parse — a wrong total is worse than no total.
 */
/** The amount as the card shows it: grouped like es-AR, raw when unparseable. */
function displayAmount(amount: string): string {
  const value = amountValue(amount);
  return value === null ? amount : formatAmount(value, currencyOf(amount));
}

function netTotal(entries: Entry[]): string | null {
  const currencies = new Set(entries.map((e) => currencyOf(e.monto)));
  if (currencies.size !== 1) {
    return null;
  }
  let sum = 0;
  for (const entry of entries) {
    const value = amountValue(entry.monto);
    if (value === null) {
      return null;
    }
    sum += value;
  }
  return formatAmount(sum, [...currencies][0] ?? "");
}

function parseEntries(message: string): Entry[] | null {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = lines.map((line) => line.split("|").map((p) => p.trim()));
  if (parsed.length === 0 || parsed.some((parts) => parts.length !== 4)) {
    return null;
  }
  return parsed.map(([fecha, descripcion, monto, cuentas]) => ({
    fecha: fecha ?? "",
    descripcion: descripcion ?? "",
    monto: monto ?? "",
    cuentas: cuentas ?? "",
  }));
}

/** `<blockquote expandable>`: collapsed by default, one tap for the detail. */
function details(body: string): string {
  return `<blockquote expandable>${body}</blockquote>`;
}

/**
 * The commit approval card. `message` is one line per pending entry in the
 * strict form `fecha | descripción | monto | cuentas`. The card shows one
 * short line per entry plus the net, and folds dates and account legs into an
 * expandable block. A malformed summary falls back to a `<pre>` dump so the
 * card never throws.
 */
export function commitApprovalCard(message: string): string {
  const entries = parseEntries(message);

  if (!entries) {
    return (
      `🧾 <b>Confirmar lote</b>\n\n<pre>${escapeHtml(message)}</pre>\n\n` +
      `Confirmá y lo commiteo y pusheo.`
    );
  }

  const n = entries.length;
  const lines = entries
    .map(
      (e) =>
        `${transactionEmoji(e.monto)} <b>${escapeHtml(e.descripcion)}</b> · <code>${escapeHtml(displayAmount(e.monto))}</code>`,
    )
    .join("\n");

  const total = netTotal(entries);
  const dates = [...new Set(entries.map((e) => e.fecha))];
  const header =
    dates.length === 1
      ? `<i>${n} entrada${n === 1 ? "" : "s"} · ${escapeHtml(dates[0] ?? "")}</i>`
      : `<i>${n} entrada${n === 1 ? "" : "s"}</i>`;

  const legs = entries
    .map(
      (e) =>
        `${escapeHtml(e.descripcion)} · ${escapeHtml(e.fecha)}\n${escapeHtml(e.cuentas)}`,
    )
    .join("\n\n");

  return [
    `🧾 <b>Confirmar lote</b>`,
    header,
    ``,
    lines,
    ...(total && n > 1 ? [``, `Neto <code>${escapeHtml(total)}</code>`] : []),
    ``,
    details(legs),
    `Confirmá y lo commiteo y pusheo.`,
  ].join("\n");
}

function fileList(files: string[]): string {
  return files
    .slice(0, 10)
    .map((f) => `• ${escapeHtml(f)}`)
    .join("\n");
}

/** One card per tool status. Intermediate states read as progress, not error. */
export function commitResultCard(output: CommitOutput): string {
  switch (output.status) {
    case "committed_pushed":
      return (
        `✅ <b>Asentado</b> · <code>${escapeHtml(output.sha)}</code>\n` +
        `<i>commiteado y pusheado</i>`
      );

    case "pushed_only":
      return (
        `✅ <b>Push al día</b> · <code>${escapeHtml(output.sha)}</code>\n` +
        `<i>ya estaba commiteado, faltaba pushear</i>`
      );

    case "conflict":
      return [
        `🔀 <b>Conflicto con el remoto</b>`,
        `<i>otro dispositivo pusheó antes; lo estoy resolviendo</i>`,
        output.files.length ? `\n${fileList(output.files)}` : "",
        output.detail ? details(escapeHtml(output.detail)) : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "push_failed":
      return [
        `⚠️ <b>Commit local, push pendiente</b>`,
        `<code>${escapeHtml(output.sha)}</code> quedó guardado acá; el remoto no lo tiene todavía.`,
        output.detail ? details(escapeHtml(output.detail)) : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "clean":
      return `ℹ️ Nada para hacer — ${escapeHtml(output.reason)}.`;

    case "blocked":
      return [
        `🚫 <b>Frené el commit</b>`,
        escapeHtml(output.reason),
        output.files.length ? details(fileList(output.files)) : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "aborted":
      return `↩️ <b>Rebase descartado</b>\n<i>${escapeHtml(output.reason)}</i>`;
  }
}

/**
 * Rejection copy depends on what is already on disk: a commit from a failed
 * push survives a cancelation, and saying "no se tocó el repo" then would be
 * a lie.
 */
export function commitRejectedCard(pendingSha?: string): string {
  if (pendingSha) {
    return (
      `❌ <b>Cancelado</b>\n` +
      `El commit <code>${escapeHtml(pendingSha)}</code> sigue local, sin pushear.`
    );
  }
  return "❌ <b>Cancelado</b>, no se tocó el repo.";
}
