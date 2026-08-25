import type { SandboxSession } from "eve/sandbox";
import type { NookUser } from "./users";

/**
 * Git-forge auth abstraction. Each forge has its own basic-auth quirks; the
 * token itself never travels in a command string (commands land in the
 * durable event stream) — it is materialized as a credential-store file via
 * writeTextFile for the duration of a single network operation.
 */

const CREDS_FILE = "/tmp/.nook-git-credentials";

function credentialsLine(user: NookUser): string {
  // Gitea expects the token's owning username in basic auth. GitHub PATs use
  // the fixed "x-access-token" username instead.
  const username =
    user.forge === "github" ? "x-access-token" : user.forgeUsername;
  return `https://${encodeURIComponent(username)}:${encodeURIComponent(user.token)}@${new URL(user.repoUrl).host}\n`;
}

/** Per-command git flag pointing at the temporary credential file. */
export function gitAuthFlag(): string {
  return `-c "credential.helper=store --file=${CREDS_FILE}"`;
}

/**
 * Runs fn while forge credentials are briefly present in the sandbox and
 * removes them afterwards, even when fn throws. Nothing auth-related
 * persists in the container between operations.
 */
export async function withForgeCredentials<T>(
  sb: Pick<SandboxSession, "writeTextFile" | "removePath">,
  user: NookUser,
  fn: () => Promise<T>,
): Promise<T> {
  await sb.writeTextFile({
    path: CREDS_FILE,
    content: credentialsLine(user),
  });
  try {
    return await fn();
  } finally {
    await sb.removePath({ path: CREDS_FILE, force: true });
  }
}
