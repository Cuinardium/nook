import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortRebase,
  type CommandRunner,
  commitAndSync,
  continueRebase,
  syncOnly,
} from "./ledger-repo.ts";
import type { NookUser } from "./users.ts";

const USER: NookUser = {
  principalId: "cuini",
  telegramUserId: "1",
  repoUrl: "https://git.example.org/cuini/ledger",
  forge: "gitea",
  forgeUsername: "cuini",
  token: "t0ken",
};

type Reply = { stdout?: string; stderr?: string; exitCode?: number };
type Rule = { match: RegExp; replies: Reply[] };

/**
 * Scripted stand-in for the sandbox. Each rule answers the commands matching
 * its pattern, consuming one reply per call and repeating the last one, so a
 * test can express "dirty, then clean after `add`" without ordering by index.
 */
function fakeRunner(rules: Rule[]): CommandRunner & { commands: string[] } {
  const queues = rules.map((rule) => ({ ...rule, replies: [...rule.replies] }));
  const commands: string[] = [];
  return {
    commands,
    async run({ command }) {
      commands.push(command);
      const rule = queues.find((candidate) => candidate.match.test(command));
      if (!rule) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      const reply =
        rule.replies.length > 1 ? rule.replies.shift() : rule.replies[0];
      return {
        stdout: reply?.stdout ?? "",
        stderr: reply?.stderr ?? "",
        exitCode: reply?.exitCode ?? 0,
      };
    },
    async writeTextFile() {
      return undefined;
    },
    async removePath() {
      return undefined;
    },
  };
}

const NO_REBASE: Rule = { match: /^test -d/, replies: [{ exitCode: 1 }] };
const REBASING: Rule = { match: /^test -d/, replies: [{ exitCode: 0 }] };
const SHA: Rule = {
  match: /rev-parse --short HEAD/,
  replies: [{ stdout: "abc1234\n" }],
};
const STAGED_JOURNAL: Rule = {
  match: /diff --cached --name-only/,
  replies: [{ stdout: "2026.journal\n" }],
};
const PUSH_OK: Rule = { match: /push/, replies: [{ exitCode: 0 }] };
const PULL_OK: Rule = { match: /pull --rebase/, replies: [{ exitCode: 0 }] };

describe("commitAndSync", () => {
  it("commits the journal and pushes it", async () => {
    const sb = fakeRunner([
      NO_REBASE,
      {
        match: /status --porcelain/,
        replies: [{ stdout: " M 2026.journal\n" }, { stdout: "M  2026.journal\n" }],
      },
      STAGED_JOURNAL,
      SHA,
      PULL_OK,
      PUSH_OK,
    ]);

    const out = await commitAndSync(sb, USER, "2026-08-25 | Cafe | -4500 | x, y");

    assert.deepEqual(out, { status: "committed_pushed", sha: "abc1234" });
    assert.ok(sb.commands.some((c) => c.includes("commit -F")));
  });

  it("pushes instead of stalling when the entries are already committed", async () => {
    // The regression from the failed-push chat: the worktree is clean because
    // an earlier attempt committed, and the retry must push, not give up.
    const sb = fakeRunner([
      NO_REBASE,
      { match: /status --porcelain/, replies: [{ stdout: "" }] },
      { match: /rev-list --count/, replies: [{ stdout: "1\n" }] },
      SHA,
      PULL_OK,
      PUSH_OK,
    ]);

    const out = await commitAndSync(sb, USER, "cualquiera");

    assert.deepEqual(out, { status: "pushed_only", sha: "abc1234" });
    assert.ok(!sb.commands.some((c) => c.includes("commit -F")));
  });

  it("reports a conflict instead of leaking git output", async () => {
    const sb = fakeRunner([
      { match: /^test -d/, replies: [{ exitCode: 1 }, { exitCode: 0 }] },
      {
        match: /status --porcelain/,
        replies: [{ stdout: " M 2026.journal\n" }, { stdout: "M  2026.journal\n" }],
      },
      STAGED_JOURNAL,
      SHA,
      {
        match: /pull --rebase/,
        replies: [{ exitCode: 1, stderr: "CONFLICT (content): merge conflict\nhint: fix them up" }],
      },
      {
        match: /diff --name-only --diff-filter=U/,
        replies: [{ stdout: "2026.journal\n" }],
      },
    ]);

    const out = await commitAndSync(sb, USER, "Cafe");

    assert.equal(out.status, "conflict");
    assert.deepEqual(out.status === "conflict" ? out.files : [], [
      "2026.journal",
    ]);
  });

  it("retries the cycle when the remote moved mid-push", async () => {
    const sb = fakeRunner([
      NO_REBASE,
      {
        match: /status --porcelain/,
        replies: [{ stdout: " M 2026.journal\n" }, { stdout: "M  2026.journal\n" }],
      },
      STAGED_JOURNAL,
      SHA,
      PULL_OK,
      {
        match: /push/,
        replies: [
          { exitCode: 1, stderr: "! [rejected] main -> main (non-fast-forward)" },
          { exitCode: 0 },
        ],
      },
    ]);

    const out = await commitAndSync(sb, USER, "Cafe");

    assert.equal(out.status, "committed_pushed");
    assert.equal(sb.commands.filter((c) => c.includes("pull --rebase")).length, 2);
  });

  it("keeps a failed push as a local commit", async () => {
    const sb = fakeRunner([
      NO_REBASE,
      {
        match: /status --porcelain/,
        replies: [{ stdout: " M 2026.journal\n" }, { stdout: "M  2026.journal\n" }],
      },
      STAGED_JOURNAL,
      SHA,
      PULL_OK,
      {
        match: /push/,
        replies: [{ exitCode: 1, stderr: "fatal: Authentication failed" }],
      },
    ]);

    const out = await commitAndSync(sb, USER, "Cafe");

    assert.equal(out.status, "push_failed");
    assert.equal(out.status === "push_failed" ? out.sha : "", "abc1234");
    // One failed auth is not worth three attempts.
    assert.equal(sb.commands.filter((c) => c.includes("push")).length, 1);
  });

  it("refuses changes outside the root journals", async () => {
    const sb = fakeRunner([
      NO_REBASE,
      {
        match: /status --porcelain/,
        replies: [
          { stdout: " M bin/tool.sh\n" },
          { stdout: " M bin/tool.sh\n" },
        ],
      },
    ]);

    const out = await commitAndSync(sb, USER, "Cafe");

    assert.equal(out.status, "blocked");
    assert.ok(sb.commands.some((c) => c.endsWith("reset")));
  });
});

describe("continueRebase", () => {
  it("refuses while conflict markers survive", async () => {
    const sb = fakeRunner([
      REBASING,
      {
        match: /diff --name-only --diff-filter=U/,
        replies: [{ stdout: "2026.journal\n" }],
      },
      { match: /^grep -lE/, replies: [{ stdout: "/workspace/ledger/2026.journal\n" }] },
    ]);

    const out = await continueRebase(sb, USER);

    assert.equal(out.status, "blocked");
    assert.deepEqual(out.status === "blocked" ? out.files : [], [
      "2026.journal",
    ]);
    assert.ok(!sb.commands.some((c) => c.includes("rebase --continue")));
  });

  it("finishes the rebase and pushes once the journal is clean", async () => {
    const sb = fakeRunner([
      { match: /^test -d/, replies: [{ exitCode: 0 }] },
      {
        match: /diff --name-only --diff-filter=U/,
        replies: [{ stdout: "2026.journal\n" }],
      },
      { match: /^grep -lE/, replies: [{ stdout: "" }] },
      SHA,
      PULL_OK,
      PUSH_OK,
    ]);

    const out = await continueRebase(sb, USER);

    assert.deepEqual(out, { status: "pushed_only", sha: "abc1234" });
    assert.ok(sb.commands.some((c) => c.includes("rebase --continue")));
  });
});

describe("syncOnly", () => {
  it("blocks on a dirty worktree", async () => {
    const sb = fakeRunner([
      { match: /status --porcelain/, replies: [{ stdout: " M 2026.journal\n" }] },
    ]);

    const out = await syncOnly(sb, USER);

    assert.equal(out.status, "blocked");
  });

  it("reports a repo that is already in sync", async () => {
    const sb = fakeRunner([
      { match: /status --porcelain/, replies: [{ stdout: "" }] },
      { match: /rev-list --count/, replies: [{ stdout: "0\n" }] },
    ]);

    const out = await syncOnly(sb, USER);

    assert.equal(out.status, "clean");
  });
});

describe("abortRebase", () => {
  it("is a no-op when no rebase is running", async () => {
    const sb = fakeRunner([NO_REBASE]);

    const out = await abortRebase(sb);

    assert.equal(out.status, "clean");
    assert.ok(!sb.commands.some((c) => c.includes("rebase --abort")));
  });

  it("drops a stuck rebase and keeps the commit", async () => {
    const sb = fakeRunner([REBASING]);

    const out = await abortRebase(sb);

    assert.equal(out.status, "aborted");
    assert.ok(sb.commands.some((c) => c.includes("rebase --abort")));
  });
});
