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
 *
 * Push approval is blind by design: the card cannot show what will be
 * pushed (approval pauses before the tool runs), so it just asks for the
 * push and the user trusts the agent's criteria for the content.
 */

import type { LedgerOutcome as SyncOutput } from "./ledger-repo.ts";

export type { SyncOutput };

/** Escape a string for safe inclusion in Telegram HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Structural subset of eve's InputRequest; avoids importing internal types. */
export type PushApprovalRequest = {
  kind: string;
  action?: {
    toolName?: string;
  } | null;
};

export function isPushApproval(request: PushApprovalRequest): boolean {
  return (
    request.kind === "tool-approval" && request.action?.toolName === "push"
  );
}

function fileList(files: string[]): string {
  return files
    .slice(0, 10)
    .map((f) => `• ${escapeHtml(f)}`)
    .join("\n");
}

/** `<blockquote expandable>`: collapsed by default, one tap for the detail. */
function details(body: string): string {
  return `<blockquote expandable>${body}</blockquote>`;
}

/** The push approval card. Blind: no content preview, just the ask. */
export function pushApprovalCard(): string {
  return (
    `📤 <b>Confirmar push</b>\n` +
    `Pusheo los commits pendientes al remoto.\n\n` +
    `Confirmá y lo pusheo.`
  );
}

/** One card per tool status. Intermediate states read as progress, not error. */
export function syncResultCard(output: SyncOutput): string {
  switch (output.status) {
    case "pushed":
      return (
        `✅ <b>Pusheado</b> · <code>${escapeHtml(output.sha)}</code>\n` +
        `<i>el remoto ya lo tiene</i>`
      );

    case "conflict":
      return [
        `🔀 <b>Conflicto con el remoto</b>`,
        `<i>otro dispositivo pusheó antes; resolvelo con git y pusheá de nuevo</i>`,
        output.files.length ? `\n${fileList(output.files)}` : "",
        output.detail ? details(escapeHtml(output.detail)) : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "push_failed":
      return [
        `⚠️ <b>Push pendiente</b>`,
        `<code>${escapeHtml(output.sha)}</code> sigue local; el remoto no lo tiene todavía.`,
        output.detail ? details(escapeHtml(output.detail)) : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "pulled":
      return (
        `⬇️ <b>Remoto al día</b> · <code>${escapeHtml(output.sha)}</code>\n` +
        `<i>traje lo nuevo del remoto, sin pushear nada</i>`
      );

    case "pull_failed":
      return [
        `⚠️ <b>No pude traer del remoto</b>`,
        `el repo local quedó como estaba.`,
        output.detail ? details(escapeHtml(output.detail)) : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "clean":
      return `ℹ️ Nada para hacer — ${escapeHtml(output.reason)}.`;

    case "blocked":
      return [
        `🚫 <b>Frené la operación</b>`,
        escapeHtml(output.reason),
        output.files.length ? details(fileList(output.files)) : "",
      ]
        .filter(Boolean)
        .join("\n");
  }
}

/** Rejection copy: a denied push never touched the remote. */
export function pushRejectedCard(): string {
  return "❌ <b>Cancelado</b>, no se pusheó nada.";
}
