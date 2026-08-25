import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { config } from "../lib/config";
import { gitAuthFlag, withForgeCredentials } from "../lib/forge";
import { getUserByPrincipal } from "../lib/users";
import { log } from "../lib/log";

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
      TZ: config.timezone,
      LC_ALL: "C.UTF-8",
    },
  }),
  revalidationKey: () => "hledger-v1",

  async bootstrap({ use }) {
    const s = await use();

    const install = (sudo: boolean) =>
      s.run({
        command:
          `${sudo ? "sudo " : ""}apt-get update -qq && ` +
          `${sudo ? "sudo " : ""}apt-get install -y -qq hledger jq curl`,
      });

    let attempt = await install(true);
    if (attempt.exitCode !== 0) {
      attempt = await install(false);
    }

    if (attempt.exitCode !== 0) {
      throw new Error(
        `bootstrap: apt-get failed:\n${attempt.stderr || attempt.stdout}`,
      );
    }

    const versions = await s.run({
      command: "hledger --version && jq --version",
    });
    if (versions.exitCode !== 0) {
      throw new Error(
        `bootstrap: hledger/jq unavailable after install:\n${versions.stderr || versions.stdout}`,
      );
    }
  },

  async onSession({ use, ctx }) {
    const s = await use();

    const principal = ctx.session.auth.current?.principalId;
    const user = getUserByPrincipal(principal);

    if (!user) {
      throw new Error(
        `sandbox: refusing session for unregistered principal ${principal ?? "(none)"}`,
      );
    }

    // Clean repo start. The clone runs with per-operation credential
    // injection (lib/forge): nothing auth-related persists in the container,
    // so the agent can read files but never the token or remote access.
    await withForgeCredentials(s, user, async () => {
      await s.run({
        command:
          `rm -rf /workspace/ledger && ` +
          `git ${gitAuthFlag()} clone ${user.repoUrl} /workspace/ledger`,
      });
    });

    await s.run({
      command:
        `git -C /workspace/ledger config user.name "nook" && git -C /workspace/ledger config user.email "${config.commitEmail}"`,
    });

    await s.run({ command: PRICE_FILL });

    // Readiness smoke test before declaring the session ready: surfaces an
    // empty clone, wrong path, or missing journals at startup instead of
    // mid-conversation when the agent first tries to operate.
    const head = await s.run({
      command:
        "git -C /workspace/ledger log --oneline -1 && ls /workspace/ledger/*.journal",
    });
    if (head.exitCode !== 0) {
      throw new Error(
        `sandbox: ledger clone failed readiness check:\n${head.stderr || head.stdout}`,
      );
    }

    log.info({
      module: "sandbox",
      event: "ready",
      principal: principal,
      head: head.stdout,
    });
  },
});
