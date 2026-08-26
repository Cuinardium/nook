import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commitApprovalCard,
  commitRejectedCard,
  commitResultCard,
} from "./cards.ts";

const BATCH = [
  "2026-08-25 | Cafe | -4500 | gastos:salidas:comida, activos:cash:ARS",
  "2026-08-25 | Remera | -69000 | gastos:ropa, activos:bancos:bbva:ARS",
].join("\n");

describe("commitApprovalCard", () => {
  it("keeps one short line per entry and folds the legs away", () => {
    const card = commitApprovalCard(BATCH);
    const visible = card.split("<blockquote expandable>")[0] ?? "";

    assert.match(visible, /💸 <b>Cafe<\/b> · <code>-4\.500<\/code>/);
    assert.match(visible, /💸 <b>Remera<\/b> · <code>-69\.000<\/code>/);
    // Account legs belong in the collapsed part, not in the card body.
    assert.ok(!visible.includes("gastos:salidas:comida"));
    assert.match(card, /<blockquote expandable>[\s\S]*gastos:ropa/);
  });

  it("adds the net of the batch when the commodity is shared", () => {
    assert.match(commitApprovalCard(BATCH), /Neto <code>-73\.500<\/code>/);
  });

  it("skips the net when the entries mix commodities", () => {
    const mixed = [
      "2026-08-25 | Cafe | -$4500 | a, b",
      "2026-08-25 | Server | -USD20 | c, d",
    ].join("\n");

    assert.ok(!commitApprovalCard(mixed).includes("Neto"));
  });

  it("uses an income emoji for a positive amount", () => {
    const card = commitApprovalCard("2026-08-25 | Sueldo | +900000 | a, b");
    assert.match(card, /💰 <b>Sueldo<\/b>/);
  });

  it("falls back to a raw block when a line is malformed", () => {
    const card = commitApprovalCard("esto no tiene el formato");
    assert.match(card, /<pre>esto no tiene el formato<\/pre>/);
  });

  it("escapes model-derived text", () => {
    const card = commitApprovalCard("2026-08-25 | <b>x</b> | -1 | a, b");
    assert.ok(!card.includes("<b>x</b>"));
    assert.match(card, /&lt;b&gt;x&lt;\/b&gt;/);
  });

  it("never offers to do the thing it is already asking about", () => {
    assert.ok(!/decime|avisame|¿commiteo/i.test(commitApprovalCard(BATCH)));
  });
});

describe("commitResultCard", () => {
  it("distinguishes a fresh commit from a late push", () => {
    assert.match(
      commitResultCard({ status: "committed_pushed", sha: "d3f207a" }),
      /Asentado/,
    );
    assert.match(
      commitResultCard({ status: "pushed_only", sha: "d3f207a" }),
      /Push al día/,
    );
  });

  it("reads a conflict as progress and hides the git detail", () => {
    const card = commitResultCard({
      status: "conflict",
      files: ["2026.journal"],
      detail: "CONFLICT (content): merge conflict in 2026.journal",
    });

    assert.match(card, /lo estoy resolviendo/);
    assert.match(card, /<blockquote expandable>CONFLICT/);
  });

  it("says where a commit stands when the push failed", () => {
    const card = commitResultCard({
      status: "push_failed",
      sha: "4e622ee",
      detail: "fatal: Authentication failed",
    });

    assert.match(card, /<code>4e622ee<\/code>/);
    assert.match(card, /push pendiente/);
  });

  it("escapes a detail that carries markup", () => {
    const card = commitResultCard({
      status: "push_failed",
      sha: "4e622ee",
      detail: "hint: <not-a-tag>",
    });

    assert.ok(!card.includes("<not-a-tag>"));
  });
});

describe("commitRejectedCard", () => {
  it("tells the truth about a commit that stayed local", () => {
    assert.match(commitRejectedCard("4e622ee"), /sigue local, sin pushear/);
    assert.match(commitRejectedCard(), /no se tocó el repo/);
  });
});
