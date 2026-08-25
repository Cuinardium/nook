/**
 * Admin CLI for the nook user registry (SQLite). Run on the host:
 *
 *   NOOK_DB_PATH=/data/nook.db node scripts/users.ts <command>
 *
 * Commands:
 *   list
 *   add   --principal cuini --telegram-id 111 --repo https://host/u/ledger.git
 *         [--forge gitea|github] [--forge-username cuini]
 *         (--token TOKEN | --token-env NAME)
 *   remove <principalId>
 *
 * Tokens passed here are stored in the database (chmod 600 the file / volume).
 * Never paste tokens into a Telegram conversation: chat content lands in the
 * durable event stream.
 */
import {
  addUser,
  forgeUsernameOf,
  getUsers,
  removeUser,
  type ForgeKind,
  type NookUser,
} from "../agent/lib/users.ts";

function usage(): never {
  console.log(
    "usage:\n" +
      "  users.ts list\n" +
      "  users.ts add --principal P --telegram-id ID --repo URL \\\n" +
      "       [--forge gitea|github] [--forge-username U] \\\n" +
      "       (--token T | --token-env ENV_NAME)\n" +
      "  users.ts remove PRINCIPAL",
  );
  process.exit(1);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      usage();
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "list": {
      for (const u of getUsers()) {
        console.log(
          [
            u.principalId,
            u.telegramUserId,
            u.forge,
            u.forgeUsername,
            u.repoUrl,
            `token:${u.token ? "set" : "EMPTY"}`,
          ].join("\t"),
        );
      }
      return 0;
    }

    case "add": {
      const f = parseFlags(rest);
      const repoUrl = f.repo;
      if (
        !f.principal ||
        !f["telegram-id"] ||
        !repoUrl
      ) {
        usage();
      }
      let token = "";
      if (f.token) {
        token = f.token;
      } else if (f["token-env"]) {
        token = process.env[f["token-env"]] ?? "";
        if (!token) {
          console.error(`env var ${f["token-env"]} is not set`);
          return 1;
        }
      } else {
        console.error("one of --token or --token-env is required");
        return 1;
      }
      if (
        f.forge !== undefined &&
        f.forge !== "gitea" &&
        f.forge !== "github"
      ) {
        usage();
      }
      const forge: ForgeKind = f.forge === "github" ? "github" : "gitea";
      const user: NookUser = {
        principalId: f.principal,
        telegramUserId: f["telegram-id"],
        repoUrl,
        forge,
        forgeUsername: f["forge-username"] ?? forgeUsernameOf(repoUrl),
        token,
      };
      addUser(user);
      console.log(`added ${user.principalId} (${user.forge})`);
      return 0;
    }

    case "remove": {
      const principalId = rest[0];
      if (!principalId) {
        usage();
      }
      if (removeUser(principalId)) {
        console.log(`removed ${principalId}`);
        return 0;
      }
      console.error(`${principalId} not found`);
      return 1;
    }

    default:
      usage();
  }
}

process.exitCode = await main();
