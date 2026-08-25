import { DatabaseSync } from "node:sqlite";

export type ForgeKind = "gitea" | "github";

export type NookUser = {
  /** Stable principal stamped into session auth, e.g. "cuini". */
  principalId: string;
  /** Numeric Telegram user id allowed to talk to the bot. */
  telegramUserId: string;
  /** HTTPS clone URL of this user's hledger repository. */
  repoUrl: string;
  /** Which git provider hosts the repo; drives auth quirks. */
  forge: ForgeKind;
  /** Basic-auth username the forge expects for token auth. */
  forgeUsername: string;
  /** Forge token used as the HTTPS git password. */
  token: string;
};

/**
 * User registry backed by SQLite (see scripts/users.ts for the admin CLI).
 * The database lives on a mounted volume; every lookup reads fresh, so alta
 * and baja take effect immediately without restarting the server.
 */
const DB_PATH = process.env.NOOK_DB_PATH ?? "./nook.db";

let db: DatabaseSync | undefined;

function openDb(): DatabaseSync {
  if (db) {
    return db;
  }
  const opened = new DatabaseSync(DB_PATH);
  opened.exec(`
    CREATE TABLE IF NOT EXISTS users (
      principal_id   TEXT PRIMARY KEY,
      telegramUserId TEXT UNIQUE NOT NULL,
      repoUrl        TEXT NOT NULL,
      forge          TEXT NOT NULL CHECK (forge IN ('gitea', 'github')),
      forgeUsername  TEXT NOT NULL,
      token          TEXT NOT NULL,
      createdAt      TEXT NOT NULL
    )
  `);
  seedFromLegacyEnv(opened);
  db = opened;
  return opened;
}

/**
 * One-time migration: if the table is empty and the legacy NOOK_USERS env
 * JSON is set, import those entries (resolving each forgeTokenEnv reference)
 * so existing deployments upgrade without manual steps.
 */
function seedFromLegacyEnv(db: DatabaseSync): void {
  const raw = process.env.NOOK_USERS;
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM users")
    .get();
  if (!raw || Number(count?.n ?? 0) > 0) {
    return;
  }

  let legacy: Array<{
    principalId: string;
    telegramUserId: string;
    repoUrl: string;
    forgeTokenEnv?: string;
  }>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("not an array");
    }
    legacy = parsed as typeof legacy;
  } catch {
    console.warn(
      JSON.stringify({
        module: "users",
        msg: "NOOK_USERS set but unparsable; legacy seed skipped",
      }),
    );
    return;
  }

  const insert = db.prepare(
    `INSERT INTO users
       (principal_id, telegramUserId, repoUrl, forge, forgeUsername, token, createdAt)
     VALUES (?, ?, ?, 'gitea', ?, ?, ?)`,
  );
  let seeded = 0;
  for (const u of legacy) {
    const token = u.forgeTokenEnv ? process.env[u.forgeTokenEnv] : undefined;
    if (!token) {
      console.warn(
        JSON.stringify({
          module: "users",
          msg: `legacy seed skipped ${u.principalId}: missing ${u.forgeTokenEnv}`,
        }),
      );
      continue;
    }
    insert.run(
      u.principalId,
      u.telegramUserId,
      u.repoUrl,
      forgeUsernameOf(u.repoUrl),
      token,
      new Date().toISOString(),
    );
    seeded++;
  }
  if (seeded > 0) {
    console.warn(
      JSON.stringify({
        module: "users",
        msg: `seeded ${seeded} user(s) from legacy NOOK_USERS; the env var can be removed`,
      }),
    );
  }
}

/** Legacy fallback: personal-repo owner segment (Gitea convention). */
export function forgeUsernameOf(repoUrl: string): string {
  try {
    return (
      new URL(repoUrl).pathname.split("/").filter(Boolean)[0] ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

function rowToUser(row: Record<string, unknown>): NookUser {
  const forge = row.forge;
  if (forge !== "gitea" && forge !== "github") {
    throw new Error(`users: unknown forge kind ${String(forge)}`);
  }
  return {
    principalId: String(row.principal_id),
    telegramUserId: String(row.telegramUserId),
    repoUrl: String(row.repoUrl),
    forge,
    forgeUsername: String(row.forgeUsername),
    token: String(row.token),
  };
}

export function getUsers(): NookUser[] {
  return openDb()
    .prepare("SELECT * FROM users ORDER BY principal_id")
    .all()
    .map((row) => rowToUser(row as Record<string, unknown>));
}

export function getUserByTelegramId(telegramUserId: string): NookUser | null {
  return (
    getUsers().find((u) => u.telegramUserId === telegramUserId) ?? null
  );
}

export function getUserByPrincipal(
  principalId: string | undefined,
): NookUser | null {
  if (!principalId) {
    return null;
  }
  return getUsers().find((u) => u.principalId === principalId) ?? null;
}

/** Alta. Throws on duplicate principal or Telegram id. */
export function addUser(user: NookUser): void {
  openDb()
    .prepare(
      `INSERT INTO users
         (principal_id, telegramUserId, repoUrl, forge, forgeUsername, token, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.principalId,
      user.telegramUserId,
      user.repoUrl,
      user.forge,
      user.forgeUsername,
      user.token,
      new Date().toISOString(),
    );
}

/** Baja. Returns false when the principal did not exist. */
export function removeUser(principalId: string): boolean {
  const result = openDb()
    .prepare("DELETE FROM users WHERE principal_id = ?")
    .run(principalId);
  return Number(result.changes) > 0;
}
