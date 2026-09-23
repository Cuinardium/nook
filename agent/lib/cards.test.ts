import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPushApproval, pushApprovalCard } from "./cards.ts";

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
