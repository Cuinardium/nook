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

export function pushApprovalCard(): string {
  return (
    `📤 <b>Confirmar push</b>\n` +
    `Pusheo los commits pendientes al remoto.\n\n` +
    `Confirmá y lo pusheo.`
  );
}
