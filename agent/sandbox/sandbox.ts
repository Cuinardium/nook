import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { getConfig } from "../lib/config";
import { gitAuthFlag, withForgeCredentials } from "../lib/forge";
import { getUserByPrincipal } from "../lib/users";
import { log } from "../lib/log";

// NOTE: the Docker backend honors only "allow-all"/"deny-all" network policies.
// We keep the default allow-all and rely on keeping secrets out of the sandbox:
// the forge token is injected per operation (lib/forge) and never persists.

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
        `git -C /workspace/ledger config user.name "nook" && ` +
        `git -C /workspace/ledger config user.email "${getConfig().commitEmail}"`,
    });

    // Existence guarantee only (no network): journals with `include precios/`
    // fail hledger until those files exist. Real data comes from the
    // update_prices tool when the agent needs fresh rates.
    await s.run({
      command:
        "mkdir -p /workspace/ledger/precios && " +
        "touch /workspace/ledger/precios/dolares.journal /workspace/ledger/precios/stocks.journal",
    });

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
