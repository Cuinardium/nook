/**
 * Every git operation nook performs on /workspace/ledger, as one small state
 * machine over a command runner.
 *
 * It lives apart from the tool so the interesting part — what happens when a
 * push races another machine — is exercisable without a sandbox, a real repo,
 * or an approval round trip. The tool layer only resolves the user and picks
 * an intent.
 *
 * Contract: no caller of this module ever sees raw git output. Each entry
 * point returns a `LedgerOutcome`, and the channel renders one card per
 * status.
 */

import { z } from "zod";
import { gitAuthFlag, withForgeCredentials } from "./forge.ts";
import type { NookUser } from "./users.ts";

export const REPO = "/workspace/ledger";
const JOURNAL_PATH = /^[\w.-]+\.journal$/;
/** Rebase+push cycles before giving up on a remote that keeps moving. */
const PUSH_ATTEMPTS = 3;

export const intentSchema = z
  .enum(["commit", "sync", "continue", "abort"])
  .default("commit");

export type LedgerIntent = z.infer<typeof intentSchema>;

export const outcomeSchema = z.discriminatedUnion("status", [
  /** New commit created and pushed. */
  z.object({ status: z.literal("committed_pushed"), sha: z.string() }),
  /** Nothing new to commit; commits that were pending got pushed. */
  z.object({ status: z.literal("pushed_only"), sha: z.string() }),
  /** Rebase stopped on conflicts. The repo is mid-rebase, awaiting a fix. */
  z.object({
    status: z.literal("conflict"),
    files: z.array(z.string()),
    detail: z.string(),
  }),
  /** The rebase landed but the network/auth side of the push failed. */
  z.object({
    status: z.literal("push_failed"),
    sha: z.string(),
    detail: z.string(),
  }),
  /** Nothing to commit and nothing to push. */
  z.object({ status: z.literal("clean"), reason: z.string() }),
  /** Refused: changes outside the root journals, or markers still unresolved. */
  z.object({
    status: z.literal("blocked"),
    reason: z.string(),
    files: z.array(z.string()),
  }),
  /** A stuck rebase was dropped; the local commit survives, unpushed. */
  z.object({ status: z.literal("aborted"), reason: z.string() }),
]);

export type LedgerOutcome = z.infer<typeof outcomeSchema>;
export type LedgerStatus = LedgerOutcome["status"];

/** The slice of a sandbox session this module needs. */
export type CommandRunner = {
  run(options: { command: string }): PromiseLike<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  writeTextFile(options: {
    path: string;
    content: string;
  }): PromiseLike<unknown>;
  removePath(options: { path: string; force?: boolean }): PromiseLike<unknown>;
};

type GitResult = { stdout: string; stderr: string; code: number };

async function runGit(sb: CommandRunner, args: string): Promise<GitResult> {
  const res = await sb.run({ command: `git -C ${REPO} ${args}` });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.exitCode ?? 0,
  };
}

/** Runs a git command and throws when it fails; for steps with no recovery. */
async function git(sb: CommandRunner, args: string): Promise<string> {
  const res = await runGit(sb, args);
  if (res.code !== 0) {
    throw new Error(
      `ledger: \`git ${args}\` falló (${res.code}): ${firstLines(res.stderr || res.stdout, 3)}`,
    );
  }
  return res.stdout;
}

function firstLines(text: string, count: number): string {
  return text.trim().split("\n").slice(0, count).join("\n");
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim());
}

async function rebaseInProgress(sb: CommandRunner): Promise<boolean> {
  const probe = await sb.run({
    command: `test -d ${REPO}/.git/rebase-merge -o -d ${REPO}/.git/rebase-apply`,
  });
  return (probe.exitCode ?? 1) === 0;
}

async function unmergedFiles(sb: CommandRunner): Promise<string[]> {
  return lines((await runGit(sb, "diff --name-only --diff-filter=U")).stdout);
}

async function headSha(sb: CommandRunner): Promise<string> {
  return (await git(sb, "rev-parse --short HEAD")).trim();
}

/** Commits ahead of the upstream; `null` when there is no upstream to compare. */
async function aheadCount(sb: CommandRunner): Promise<number | null> {
  const res = await runGit(sb, "rev-list --count @{u}..HEAD");
  if (res.code !== 0) {
    return null;
  }
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

type SyncResult =
  | { kind: "pushed" }
  | { kind: "conflict"; files: string[]; detail: string }
  | { kind: "failed"; detail: string };

/**
 * Rebase onto the remote, then push. Retries the whole cycle when someone
 * pushed between our rebase and our push, so an ordinary race never reaches
 * the user. On conflict the repo is deliberately left mid-rebase: that is the
 * state `continueRebase` expects, and the only one from which the agent can
 * resolve the journal by hand.
 */
async function rebaseAndPush(
  sb: CommandRunner,
  user: NookUser,
): Promise<SyncResult> {
  let outcome: SyncResult = { kind: "failed", detail: "el push no se intentó" };

  await withForgeCredentials(sb as never, user, async () => {
    const auth = gitAuthFlag();
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
      const pull = await runGit(sb, `${auth} pull --rebase`);
      if (pull.code !== 0) {
        outcome = (await rebaseInProgress(sb))
          ? {
              kind: "conflict",
              files: await unmergedFiles(sb),
              detail: firstLines(pull.stderr || pull.stdout, 4),
            }
          : { kind: "failed", detail: firstLines(pull.stderr || pull.stdout, 4) };
        return;
      }

      const push = await runGit(sb, `${auth} push`);
      if (push.code === 0) {
        outcome = { kind: "pushed" };
        return;
      }
      outcome = {
        kind: "failed",
        detail: firstLines(push.stderr || push.stdout, 4),
      };
      // Only a non-fast-forward is worth another cycle; anything else (auth,
      // network) will fail the same way on a retry.
      if (!/non-fast-forward|fetch first|rejected/i.test(push.stderr)) {
        return;
      }
    }
  });

  return outcome;
}

/** Turns a sync result into an outcome, given whether we just committed. */
async function finish(
  sb: CommandRunner,
  user: NookUser,
  committed: boolean,
): Promise<LedgerOutcome> {
  const sha = await headSha(sb);
  const result = await rebaseAndPush(sb, user);
  if (result.kind === "pushed") {
    // The rebase may have rewritten our commit, so read HEAD again.
    const finalSha = await headSha(sb);
    return committed
      ? { status: "committed_pushed", sha: finalSha }
      : { status: "pushed_only", sha: finalSha };
  }
  if (result.kind === "conflict") {
    return { status: "conflict", files: result.files, detail: result.detail };
  }
  return { status: "push_failed", sha, detail: result.detail };
}

/** Push what is already committed; refuses to touch a dirty worktree. */
export async function syncOnly(
  sb: CommandRunner,
  user: NookUser,
): Promise<LedgerOutcome> {
  const dirty = lines((await runGit(sb, "status --porcelain")).stdout);
  if (dirty.length > 0) {
    return {
      status: "blocked",
      reason:
        "hay cambios sin commitear; usá intent=commit para asentarlos primero",
      files: dirty,
    };
  }

  if ((await aheadCount(sb)) === 0) {
    return { status: "clean", reason: "el repo ya está sincronizado" };
  }

  return await finish(sb, user, false);
}

/**
 * Stage the root journals, commit them, and sync. A worktree with nothing new
 * is not a dead end: the entries may already be committed from an attempt
 * whose push failed, so it falls through to a push.
 */
export async function commitAndSync(
  sb: CommandRunner,
  user: NookUser,
  message: string,
): Promise<LedgerOutcome> {
  if (await rebaseInProgress(sb)) {
    return {
      status: "conflict",
      files: await unmergedFiles(sb),
      detail: "hay un rebase en curso de un intento anterior",
    };
  }

  const status = await runGit(sb, "status --porcelain");
  if (!status.stdout.trim()) {
    return await syncOnly(sb, user);
  }

  // The message travels as a file so it is never shell-interpolated.
  await sb.writeTextFile({
    path: "/workspace/.commit-msg",
    content: `${message}\n`,
  });

  await git(sb, "add -- ':(top)*.journal'");

  // Anything still dirty in the WORKTREE column was not staged by the glob.
  const leftover = await runGit(sb, "status --porcelain");
  const unstaged = leftover.stdout
    .split("\n")
    .filter((line) => line.length >= 2 && line[1] !== " ");

  if (unstaged.length > 0) {
    await git(sb, "reset");
    return {
      status: "blocked",
      reason: "hay cambios por fuera de los journals raíz",
      files: unstaged,
    };
  }

  // Verify what is actually staged before committing.
  const staged = lines(await git(sb, "diff --cached --name-only"));
  if (staged.length === 0 || staged.some((p) => !JOURNAL_PATH.test(p))) {
    await git(sb, "reset");
    return {
      status: "blocked",
      reason: "el índice quedó con cambios inesperados",
      files: staged,
    };
  }

  await git(sb, "commit -F /workspace/.commit-msg");
  await sb.removePath({ path: "/workspace/.commit-msg", force: true });

  return await finish(sb, user, true);
}

/**
 * Close a rebase whose conflicts the agent already resolved in the journal.
 * Refuses while markers survive: a committed `<<<<<<<` breaks every later
 * hledger run.
 */
export async function continueRebase(
  sb: CommandRunner,
  user: NookUser,
): Promise<LedgerOutcome> {
  if (!(await rebaseInProgress(sb))) {
    // Nothing to continue: push whatever is pending instead of erroring.
    return await syncOnly(sb, user);
  }

  const unmerged = await unmergedFiles(sb);
  const offJournal = unmerged.filter((p) => !JOURNAL_PATH.test(p));
  if (offJournal.length > 0) {
    return {
      status: "blocked",
      reason: "el conflicto toca archivos fuera de los journals raíz",
      files: offJournal,
    };
  }

  const markers = await sb.run({
    command: `grep -lE '^(<<<<<<<|=======|>>>>>>>)' ${REPO}/*.journal || true`,
  });
  const unresolved = lines(markers.stdout ?? "");
  if (unresolved.length > 0) {
    return {
      status: "blocked",
      reason: "todavía quedan marcadores de conflicto sin resolver",
      files: unresolved.map((p) => p.replace(`${REPO}/`, "")),
    };
  }

  if (unmerged.length > 0) {
    await git(sb, `add -- ${unmerged.map((p) => `'${p}'`).join(" ")}`);
  }

  const cont = await runGit(sb, "-c core.editor=true rebase --continue");
  if (cont.code !== 0) {
    if (await rebaseInProgress(sb)) {
      return {
        status: "conflict",
        files: await unmergedFiles(sb),
        detail: firstLines(cont.stderr || cont.stdout, 4),
      };
    }
    return {
      status: "blocked",
      reason: `no se pudo continuar el rebase: ${firstLines(cont.stderr, 2)}`,
      files: [],
    };
  }

  return await finish(sb, user, false);
}

/** Drop a rebase the agent could not resolve. The local commit survives. */
export async function abortRebase(sb: CommandRunner): Promise<LedgerOutcome> {
  if (!(await rebaseInProgress(sb))) {
    return { status: "clean", reason: "no había ningún rebase en curso" };
  }
  await git(sb, "rebase --abort");
  return {
    status: "aborted",
    reason: "rebase descartado; el commit local sigue sin pushear",
  };
}
