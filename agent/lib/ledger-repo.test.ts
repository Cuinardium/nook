import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pullOnly,
  pushPending,
  type CommandRunner,
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
const REMOTE_OK: Rule[] = [
  {
    match: /remote get-url --push/,
    replies: [{ stdout: "https://git.example.org/cuini/ledger\n" }],
  },
  {
    match: /remote get-url/,
    replies: [{ stdout: "https://git.example.org/cuini/ledger\n" }],
  },
];
const CLEAN_TREE: Rule = {
  match: /status --porcelain/,
  replies: [{ stdout: "" }],
};
const PUSH_OK: Rule = { match: /push/, replies: [{ exitCode: 0 }] };
const PULL_OK: Rule = { match: /pull --rebase/, replies: [{ exitCode: 0 }] };

describe("pushPending", () => {
  it("rebases and pushes pending commits", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      CLEAN_TREE,
      { match: /rev-list --count/, replies: [{ stdout: "1\n" }] },
      SHA,
      PULL_OK,
      PUSH_OK,
    ]);

    const out = await pushPending(sb, USER);

    assert.deepEqual(out, { status: "pushed", sha: "abc1234" });
  });

  it("reports a repo that is already in sync", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      CLEAN_TREE,
      { match: /rev-list --count/, replies: [{ stdout: "0\n" }] },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "clean");
    assert.ok(!sb.commands.some((c) => c.includes("pull --rebase")));
  });

  it("blocks on a dirty worktree", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      { match: /status --porcelain/, replies: [{ stdout: " M 2026.journal\n" }] },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "blocked");
    assert.ok(!sb.commands.some((c) => c.includes("pull --rebase")));
  });

  it("ignores price caches and .gitignore when checking dirt", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      {
        match: /status --porcelain/,
        replies: [{ stdout: " M precios/dolares.journal\n M .gitignore\n" }],
      },
      { match: /rev-list --count/, replies: [{ stdout: "0\n" }] },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "clean");
  });

  it("blocks when origin points elsewhere", async () => {
    const sb = fakeRunner([
      {
        match: /remote get-url/,
        replies: [{ stdout: "https://evil.example.org/x/ledger\n" }],
      },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "blocked");
    assert.match(
      out.status === "blocked" ? out.reason : "",
      /origin apunta a/,
    );
    assert.ok(!sb.commands.some((c) => c.includes("pull --rebase")));
    assert.ok(!sb.commands.some((c) => /(^|\s)push(\s|$)/.test(c)));
  });

  it("blocks when the push URL diverges from the fetch URL", async () => {
    const sb = fakeRunner([
      {
        match: /remote get-url --push/,
        replies: [{ stdout: "https://evil.example.org/x/ledger\n" }],
      },
      {
        match: /remote get-url/,
        replies: [{ stdout: "https://git.example.org/cuini/ledger\n" }],
      },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "blocked");
    assert.match(
      out.status === "blocked" ? out.reason : "",
      /push-URL/,
    );
  });

  it("accepts a .git suffix on the remote", async () => {
    const sb = fakeRunner([
      {
        match: /remote get-url/,
        replies: [
          { stdout: "https://git.example.org/cuini/ledger.git\n" },
          { stdout: "https://git.example.org/cuini/ledger.git\n" },
        ],
      },
      CLEAN_TREE,
      { match: /rev-list --count/, replies: [{ stdout: "0\n" }] },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "clean");
  });

  it("reports a conflict instead of leaking git output", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      CLEAN_TREE,
      { match: /rev-list --count/, replies: [{ stdout: "1\n" }] },
      SHA,
      REBASING,
      {
        match: /pull --rebase/,
        replies: [{ exitCode: 1, stderr: "CONFLICT (content): merge conflict\nhint: fix them up" }],
      },
      {
        match: /diff --name-only --diff-filter=U/,
        replies: [{ stdout: "2026.journal\n" }],
      },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "conflict");
    assert.deepEqual(out.status === "conflict" ? out.files : [], [
      "2026.journal",
    ]);
  });

  it("retries the cycle when the remote moved mid-push", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      CLEAN_TREE,
      { match: /rev-list --count/, replies: [{ stdout: "1\n" }] },
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

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "pushed");
    assert.equal(sb.commands.filter((c) => c.includes("pull --rebase")).length, 2);
  });

  it("keeps a failed push as local commits", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      CLEAN_TREE,
      { match: /rev-list --count/, replies: [{ stdout: "1\n" }] },
      SHA,
      PULL_OK,
      {
        match: /push/,
        replies: [{ exitCode: 1, stderr: "fatal: Authentication failed" }],
      },
    ]);

    const out = await pushPending(sb, USER);

    assert.equal(out.status, "push_failed");
    assert.equal(out.status === "push_failed" ? out.sha : "", "abc1234");
    // One failed auth is not worth three attempts (`get-url --push` is a
    // remote check, not a push).
    assert.equal(sb.commands.filter((c) => / push$/.test(c)).length, 1);
  });
});

describe("pullOnly", () => {
  it("brings remote changes without pushing", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      NO_REBASE,
      CLEAN_TREE,
      {
        match: /rev-parse --short HEAD/,
        replies: [{ stdout: "aaa1111\n" }, { stdout: "bbb2222\n" }],
      },
      PULL_OK,
    ]);

    const out = await pullOnly(sb, USER);

    assert.deepEqual(out, { status: "pulled", sha: "bbb2222" });
    assert.ok(sb.commands.some((c) => c.includes("pull --rebase")));
    assert.ok(!sb.commands.some((c) => /(^|\s)push(\s|$)/.test(c)));
  });

  it("reports clean when the remote brought nothing new", async () => {
    const sb = fakeRunner([...REMOTE_OK, NO_REBASE, CLEAN_TREE, SHA, PULL_OK]);

    const out = await pullOnly(sb, USER);

    assert.equal(out.status, "clean");
  });

  it("blocks on a dirty worktree instead of rebasing over it", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      NO_REBASE,
      { match: /status --porcelain/, replies: [{ stdout: " M 2026.journal\n" }] },
    ]);

    const out = await pullOnly(sb, USER);

    assert.equal(out.status, "blocked");
    assert.ok(!sb.commands.some((c) => c.includes("pull --rebase")));
  });

  it("blocks when origin points elsewhere", async () => {
    const sb = fakeRunner([
      {
        match: /remote get-url/,
        replies: [{ stdout: "https://evil.example.org/x/ledger\n" }],
      },
    ]);

    const out = await pullOnly(sb, USER);

    assert.equal(out.status, "blocked");
    assert.ok(!sb.commands.some((c) => c.includes("pull --rebase")));
  });

  it("reports a conflict instead of leaking git output", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      { match: /^test -d/, replies: [{ exitCode: 1 }, { exitCode: 0 }] },
      CLEAN_TREE,
      SHA,
      {
        match: /pull --rebase/,
        replies: [{ exitCode: 1, stderr: "CONFLICT (content): merge conflict" }],
      },
      {
        match: /diff --name-only --diff-filter=U/,
        replies: [{ stdout: "2026.journal\n" }],
      },
    ]);

    const out = await pullOnly(sb, USER);

    assert.equal(out.status, "conflict");
  });

  it("keeps the local repo untouched when the fetch fails", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      NO_REBASE,
      CLEAN_TREE,
      SHA,
      {
        match: /pull --rebase/,
        replies: [{ exitCode: 1, stderr: "fatal: Authentication failed" }],
      },
    ]);

    const out = await pullOnly(sb, USER);

    assert.equal(out.status, "pull_failed");
  });

  it("surfaces a rebase left over from an earlier attempt", async () => {
    const sb = fakeRunner([
      ...REMOTE_OK,
      REBASING,
      {
        match: /diff --name-only --diff-filter=U/,
        replies: [{ stdout: "2026.journal\n" }],
      },
    ]);

    const out = await pullOnly(sb, USER);

    assert.equal(out.status, "conflict");
    assert.ok(!sb.commands.some((c) => c.includes("pull --rebase")));
  });
});
