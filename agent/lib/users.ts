export type NookUser = {
  /** Stable principal stamped into session auth, e.g. "cuini". */
  principalId: string;
  /** Numeric Telegram user id allowed to talk to the bot. */
  telegramUserId: string;
  /** HTTPS clone URL of this user's hledger repository. */
  repoUrl: string;
  /** Name of the env var holding this user's forge token (password for HTTPS git). */
  forgeTokenEnv: string;
};

/**
 * User registry is injected via env so it never lands in image layers:
 * NOOK_USERS='[{"principalId":"cuini","telegramUserId":"111","repoUrl":"https://git.cuini.me/cuini/ledger.git","forgeTokenEnv":"NOOK_TOKEN_CUINI"}]'
 */
export function getUsers(): NookUser[] {
  const raw = process.env.NOOK_USERS;
  if (!raw) {
    console.warn("[nook] NOOK_USERS is not set: allowlist is empty, all Telegram messages are dropped");
    return [];
  }
  const users: unknown = JSON.parse(raw);
  if (!Array.isArray(users)) {
    throw new Error("NOOK_USERS must be a JSON array");
  }
  return users as NookUser[];
}

export function getUserByTelegramId(telegramUserId: string): NookUser | null {
  return getUsers().find((u) => u.telegramUserId === telegramUserId) ?? null;
}

export function getUserByPrincipal(principalId: string | undefined): NookUser | null {
  if (!principalId) return null;
  return getUsers().find((u) => u.principalId === principalId) ?? null;
}
