import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPushApproval,
  pushApprovalCard,
  pushRejectedCard,
  syncResultCard,
} from "./cards.ts";

describe("pushApprovalCard", () => {
  it("asks for the push without showing content", () => {
    const card = pushApprovalCard();
    assert.match(card, /Confirmar push/);
    assert.match(card, /Confirmá y lo pusheo/);
  });

  it("never offers to do the thing it is already asking about", () => {
    assert.ok(!/decime|avisame|¿pusheo/i.test(pushApprovalCard()));
  });
});

describe("isPushApproval", () => {
  it("matches only push tool approvals", () => {
    assert.equal(
      isPushApproval({ kind: "tool-approval", action: { toolName: "push" } }),
      true,
    );
    assert.equal(
      isPushApproval({ kind: "tool-approval", action: { toolName: "pull" } }),
      false,
    );
    assert.equal(
      isPushApproval({ kind: "question", action: { toolName: "push" } }),
      false,
    );
  });
});

describe("syncResultCard", () => {
  it("announces a push", () => {
    assert.match(
      syncResultCard({ status: "pushed", sha: "d3f207a" }),
      /Pusheado/,
    );
  });

  it("reads a conflict as progress and hides the git detail", () => {
    const card = syncResultCard({
      status: "conflict",
      files: ["2026.journal"],
      detail: "CONFLICT (content): merge conflict in 2026.journal",
    });

    assert.match(card, /resolvelo con git/);
    assert.match(card, /<blockquote expandable>CONFLICT/);
  });

  it("announces a pull without implying a push", () => {
    const card = syncResultCard({ status: "pulled", sha: "bbb2222" });

    assert.match(card, /Remoto al día/);
    assert.match(card, /<code>bbb2222<\/code>/);
    assert.match(card, /sin pushear/);
    assert.ok(!/Pusheado/i.test(card));
  });

  it("says the local repo was left alone when the pull failed", () => {
    const card = syncResultCard({
      status: "pull_failed",
      detail: "fatal: Authentication failed",
    });

    assert.match(card, /No pude traer del remoto/);
    assert.match(card, /quedó como estaba/);
  });

  it("says where a commit stands when the push failed", () => {
    const card = syncResultCard({
      status: "push_failed",
      sha: "4e622ee",
      detail: "fatal: Authentication failed",
    });

    assert.match(card, /<code>4e622ee<\/code>/);
    assert.match(card, /sigue local/);
  });

  it("reads a blocked remote as a stop, not an error", () => {
    const card = syncResultCard({
      status: "blocked",
      reason: "origin apunta a otro lado",
      files: [],
    });

    assert.match(card, /Frené la operación/);
    assert.match(card, /origin apunta/);
  });

  it("escapes a detail that carries markup", () => {
    const card = syncResultCard({
      status: "push_failed",
      sha: "4e622ee",
      detail: "hint: <not-a-tag>",
    });

    assert.ok(!card.includes("<not-a-tag>"));
  });
});

describe("pushRejectedCard", () => {
  it("tells the truth about a denied push", () => {
    assert.match(pushRejectedCard(), /no se pusheó nada/);
  });
});
