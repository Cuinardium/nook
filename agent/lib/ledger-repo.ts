/**
 * Every networked git operation nook performs on /workspace/ledger.
 *
 * Local git (add, commit, status, rebase --continue…) is free: the agent runs
 * it via `bash` and nook trusts its criteria. Only the network goes through
 * here, wrapped in per-operation credentials, with one hard enforcement the
 * agent cannot talk its way around: the `origin` remote must point at the
 * user's own repo. That keeps a tampered remote (`remote set-url`, an extra
 * push URL) from exfiltrating the ledger on an approved push.
 *
 * Contract: no caller of this module ever sees raw git output. Each entry
 * point returns a `LedgerOutcome`, and the channel renders one card per
 * status.
 */

import { z } from "zod";
import { gitAuthFlag, withForgeCredentials } from "./forge.ts";
import type { NookUser } from "./users.ts";

export const REPO = "/workspace/ledger";

/**
 * Paths the agent may leave dirty without blocking a push/pull.
 * - `precios/` holds local price caches (dolares.journal, stocks.journal)
 *   that `update_prices` rewrites but must never be pushed.
 * - `.gitignore` itself stays a manual user concern.
 */
function isIgnoredDirtyPath(path: string): boolean {
  return path === ".gitignore" || path.startsWith("precios/");
}

function isRelevantDirtyLine(line: string): boolean {
  // porcelain: XY<space>path[ -> orig] ; worktree column is line[1]
  if (line.length < 3 || line[1] === " ") {
    return false;
  }
  const raw = line.slice(3).trim();
  // Handle renames: "R  old -> new" — check the destination.
  const arrow = raw.indexOf(" -> ");
  const path = arrow >= 0 ? raw.slice(arrow + 4).trim() : raw;
  const unquoted =
    path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  return !isIgnoredDirtyPath(unquoted);
}

/** Rebase+push cycles before giving up on a remote that keeps moving. */
const PUSH_ATTEMPTS = 3;

export const outcomeSchema = z.discriminatedUnion("status", [
  /** Pending commits were rebased onto the remote and pushed. */
  z.object({ status: z.literal("pushed"), sha: z.string() }),
  /** Remote changes were fetched and rebased; nothing was pushed. */
  z.object({ status: z.literal("pulled"), sha: z.string() }),
  /** Nothing to push, or the remote brought nothing new. */
  z.object({ status: z.literal("clean"), reason: z.string() }),
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
  /** The fetch/rebase side of a pull failed (network/auth/no upstream). */
  z.object({ status: z.literal("pull_failed"), detail: z.string() }),
  /** Refused: wrong remote, or a dirty worktree that would block the rebase. */
  z.object({
    status: z.literal("blocked"),
    reason: z.string(),
    files: z.array(z.string()),
  }),
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

function normalizeRemote(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * The one enforcement the agent cannot waive: `origin` (fetch and push URLs)
 * must point at the user's own repo. Returns a reason when it does not.
 */
async function remoteMismatch(
  sb: CommandRunner,
  user: NookUser,
): Promise<string | null> {
  const expected = normalizeRemote(user.repoUrl);
  const fetch = await runGit(sb, "remote get-url origin");
  if (fetch.code !== 0) {
    return "el repo no tiene remote `origin`";
  }
  if (normalizeRemote(fetch.stdout) !== expected) {
    return `origin apunta a ${fetch.stdout.trim()}, esperaba ${user.repoUrl}`;
  }
  const push = await runGit(sb, "remote get-url --push origin");
  if (push.code === 0 && normalizeRemote(push.stdout) !== expected) {
    return `el push-URL de origin apunta a ${push.stdout.trim()}, esperaba ${user.repoUrl}`;
  }
  return null;
}

async function relevantDirty(sb: CommandRunner): Promise<string[]> {
  return lines((await runGit(sb, "status --porcelain")).stdout).filter(
    isRelevantDirtyLine,
  );
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
 * the user. On conflict the repo is deliberately left mid-rebase for the
 * agent to resolve with local git (edit, `add`, `rebase --continue`).
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

/** Push pending commits: rebase onto the remote, then push. */
export async function pushPending(
  sb: CommandRunner,
  user: NookUser,
): Promise<LedgerOutcome> {
  const mismatch = await remoteMismatch(sb, user);
  if (mismatch) {
    return { status: "blocked", reason: mismatch, files: [] };
  }

  const dirty = await relevantDirty(sb);
  if (dirty.length > 0) {
    return {
      status: "blocked",
      reason: "hay cambios sin commitear; commitealos con git antes de pushear",
      files: dirty,
    };
  }

  if ((await aheadCount(sb)) === 0) {
    return { status: "clean", reason: "el repo ya está sincronizado" };
  }

  const sha = await headSha(sb);
  const result = await rebaseAndPush(sb, user);
  if (result.kind === "pushed") {
    // The rebase may have rewritten our commits, so read HEAD again.
    return { status: "pushed", sha: await headSha(sb) };
  }
  if (result.kind === "conflict") {
    return { status: "conflict", files: result.files, detail: result.detail };
  }
  return { status: "push_failed", sha, detail: result.detail };
}

/**
 * Bring remote changes in without pushing anything. For reviewing work pushed
 * from another machine: fetch + rebase, then stop. Local commits (if any)
 * are rebased onto the remote and left unpushed — run `push` afterwards to
 * push them. On conflict the repo is left mid-rebase for the agent to
 * resolve with local git, same as the push path.
 */
export async function pullOnly(
  sb: CommandRunner,
  user: NookUser,
): Promise<LedgerOutcome> {
  const mismatch = await remoteMismatch(sb, user);
  if (mismatch) {
    return { status: "blocked", reason: mismatch, files: [] };
  }

  if (await rebaseInProgress(sb)) {
    return {
      status: "conflict",
      files: await unmergedFiles(sb),
      detail: "hay un rebase en curso de un intento anterior",
    };
  }

  const dirty = await relevantDirty(sb);
  if (dirty.length > 0) {
    return {
      status: "blocked",
      reason: "hay cambios sin commitear; commitealos con git antes de traer",
      files: dirty,
    };
  }

  const before = await headSha(sb);

  let pull: GitResult | null = null;
  await withForgeCredentials(sb as never, user, async () => {
    pull = await runGit(sb, `${gitAuthFlag()} pull --rebase`);
  });
  const result = pull as GitResult | null;
  if (result?.code !== 0) {
    const detail = firstLines(
      result?.stderr || result?.stdout || "el pull no se intentó",
      4,
    );
    if (await rebaseInProgress(sb)) {
      return {
        status: "conflict",
        files: await unmergedFiles(sb),
        detail,
      };
    }
    return { status: "pull_failed", detail };
  }

  const after = await headSha(sb);
  if (after === before) {
    return { status: "clean", reason: "el remoto no trajo nada nuevo" };
  }
  return { status: "pulled", sha: after };
}
