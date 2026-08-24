/**
 * Card texts for the Telegram channel. Plain text only: the channel posts
 * without parse_mode by default, and keeping that consistency avoids any
 * markup-injection surface from model- or user-derived strings.
 */

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

export function commitApprovalCard(message: string): string {
  return [
    "🧾 Confirmar ingesta",
    "",
    message,
    "",
    "¿Confirmás este asiento? Se commitea y pushea al repo.",
  ].join("\n");
}

export type CommitOutput = {
  committed?: boolean;
  reason?: string;
  sha?: string;
  pushed?: boolean;
  detail?: string;
};

export function commitResultCard(output: CommitOutput): string {
  if (!output.committed) {
    return `ℹ️ Nada para commitear (${output.reason ?? "sin cambios"}).`;
  }
  if (output.pushed) {
    return ["✅ Entrada registrada", "", `Commit ${output.sha ?? "?"} pusheado al repo.`].join(
      "\n",
    );
  }
  return [
    "⚠️ Commit creado pero el push falló",
    "",
    `Commit: ${output.sha ?? "?"}`,
    output.detail ? `\`${output.detail.slice(0, 400)}\`` : "",
    "",
    "Probá de nuevo en unos minutos; si sigue fallando revisá el token del forge.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function commitRejectedCard(): string {
  return "❌ Ingesta cancelada, no se tocó el repo.";
}
