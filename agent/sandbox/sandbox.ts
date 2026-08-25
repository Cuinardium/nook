import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { getUserByPrincipal } from "../lib/users";

// NOTE: the Docker backend honors only "allow-all"/"deny-all" network policies.
// We keep the default allow-all and rely on keeping secrets out of the sandbox:
// the forge token lives in ~/.git-credentials outside /workspace, and nothing
// else sensitive is ever injected.

const PRICE_FILL = [
  "set -e",
  "cd /workspace/ledger",
  "ls *.journal >/dev/null 2>&1 || exit 0",
  // Plain journals (no price includes) need nothing; generated prices are out of scope for the bot.
  "grep -q '^include precios/' *.journal || exit 0",
  "mkdir -p precios",
  "F=$(date +%F)",
  "curl -fsS https://dolarapi.com/v1/dolares \\",
  '| jq -r --arg f "$F" \'',
  '  def tipo: if . == "bolsa" then "MEP" elif . == "contadoconliqui" then "CCL" else ascii_upcase end;',
  '  (.[] | select(.venta != null) | "P \\($f) USD_\\(.casa | tipo) \\(.venta) ARS"),',
  '  ("P \\($f) USD \\([.[] | select(.casa == "bolsa") | .venta][0]) $"),',
  '  ("P \\($f) ARS 1 $")\' > precios/dolares.journal',
  "touch precios/stocks.journal",
].join("\n");

export default defineSandbox({
  backend: docker({
    env: {
      TZ: process.env.NOOK_TIMEZONE ?? "America/Argentina/Buenos_Aires",
      LC_ALL: "C.UTF-8",
    },
  }),
  revalidationKey: () => "hledger-v1",

  async bootstrap({ use }) {
    const s = await use();
    await s.run({
      command:
        "(sudo apt-get update -qq && sudo apt-get install -y -qq hledger jq curl) || " +
        "(apt-get update -qq && apt-get install -y -qq hledger jq curl)",
    });
    await s.run({ command: "hledger --version && jq --version" });
  },

  async onSession({ use, ctx }) {
    const s = await use();

    const principal = ctx.session.auth.current?.principalId;
    const user = getUserByPrincipal(principal);
    // Fallback for `eve dev` TUI sessions without an allowlisted principal.
    const devRepo = process.env.NOOK_DEV_REPO;
    if (!user && !devRepo) return;

    const repoUrl = user?.repoUrl ?? devRepo!;

    // Forge credentials go to ~/.git-credentials (outside /workspace); every git
    // operation uses the clean URL so the token never appears in commands.
    if (user) {
      const token = process.env[user.forgeTokenEnv];
      if (!token) {
        throw new Error(`Missing ${user.forgeTokenEnv} for principal ${user.principalId}`);
      }
      const url = new URL(repoUrl);
      const host = url.host;
      // Gitea expects the token's owning username in basic auth; the repo
      // owner segment matches it for personal repos like /cuini/ledger.git.
      const forgeUser = url.pathname.split("/").filter(Boolean)[0] ?? principal ?? "nook";
      const home = (await s.run({ command: "echo $HOME" })).stdout.trim() || "/root";
      await s.writeTextFile({
        path: `${home}/.git-credentials`,
        content: `https://${forgeUser}:${token}@${host}\n`,
      });
      await s.run({
        command: `git config --global credential.helper store && chmod 600 ${home}/.git-credentials`,
      });
    }

    await s.run({
      command: `rm -rf /workspace/ledger && git clone ${repoUrl} /workspace/ledger`,
    });
    await s.run({
      command:
        'git -C /workspace/ledger config user.name "nook" && ' +
        `git -C /workspace/ledger config user.email "${
          process.env.NOOK_COMMIT_EMAIL ?? "santiago.balleri@gmail.com"
        }"`,
    });

    await s.run({ command: PRICE_FILL });

    const head = await s.run({
      command: "git -C /workspace/ledger log --oneline -1 && ls /workspace/ledger/*.journal",
    });
    console.log(`[nook] sandbox ready for ${principal ?? "dev"}:\n${head.stdout}`);
  },
});
