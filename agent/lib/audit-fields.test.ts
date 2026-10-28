import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSandboxReadiness,
  redactSecrets,
  summarizeInputRequest,
  summarizeInputResolution,
  summarizeToolInput,
  summarizeToolOutput,
  truncateText,
} from "./audit-fields.ts";

describe("truncateText", () => {
  it("keeps short values and marks clipped ones", () => {
    assert.equal(truncateText("hola", 10), "hola");
    assert.equal(truncateText("hola mundo", 6), "hola …");
  });
});

describe("redactSecrets", () => {
  it("removes secret env values and bearer/url credentials", () => {
    const env = { NOOK_TOKEN_CUINI: "super-secret-token" };
    const text =
      "git push https://cuini:super-secret-token@git.example.org/x.git " +
      "Authorization: Bearer not-a-real-token NOOK_TOKEN_CUINI=super-secret-token";

    const redacted = redactSecrets(text, env);

    assert.ok(!redacted.includes("super-secret-token"));
    assert.ok(!redacted.includes("not-a-real-token"));
    assert.match(redacted, /\[REDACTED\]/);
  });
});

describe("summarizeToolInput", () => {
  it("keeps the bash command but redacts secrets and truncates", () => {
    const previous = process.env.NOOK_TOKEN_CUINI;
    process.env.NOOK_TOKEN_CUINI = "super-secret-token";
    try {
      const input = summarizeToolInput("bash", {
        command: `echo super-secret-token ${"x".repeat(600)}`,
      });
      const command = input.command as string;

      assert.ok(command.length <= 501);
      assert.ok(command.endsWith("…"));
      assert.ok(!command.includes("super-secret-token"));
    } finally {
      if (previous === undefined) {
        delete process.env.NOOK_TOKEN_CUINI;
      } else {
        process.env.NOOK_TOKEN_CUINI = previous;
      }
    }
  });

  it("never copies write_file content", () => {
    const input = summarizeToolInput("write_file", {
      filePath: "/workspace/ledger/2026.journal",
      content: "2026-10-27 Cafe\n  gastos:cafe  $4.500",
    });

    assert.equal(input.path, "/workspace/ledger/2026.journal");
    assert.equal(input.contentBytes, Buffer.byteLength(
      "2026-10-27 Cafe\n  gastos:cafe  $4.500",
      "utf8",
    ));
    assert.ok(!JSON.stringify(input).includes("gastos:cafe"));
  });

  it("records question size, not the prompt", () => {
    const input = summarizeToolInput("ask_question", {
      prompt: "¿Cuánto salió el café?",
      options: [{ id: "a", label: "A" }],
    });

    assert.equal(input.promptChars, "¿Cuánto salió el café?".length);
    assert.equal(input.optionCount, 1);
    assert.ok(!JSON.stringify(input).includes("café"));
  });
});

describe("summarizeToolOutput", () => {
  it("reports bash sizes without stdout/stderr content", () => {
    const output = summarizeToolOutput("bash", {
      exitCode: 0,
      stdout: "2026-10-27 Cafe\n  gastos:cafe  $4.500\n",
      stderr: "",
      truncated: false,
    });

    assert.equal(output.exitCode, 0);
    assert.equal(output.stdoutBytes, Buffer.byteLength(
      "2026-10-27 Cafe\n  gastos:cafe  $4.500\n",
      "utf8",
    ));
    assert.equal(output.stderrBytes, 0);
    assert.ok(!JSON.stringify(output).includes("gastos:cafe"));
  });

  it("reports read_file metadata without its content", () => {
    const output = summarizeToolOutput("read_file", {
      content: "2026-10-27 Cafe\n",
      path: "/workspace/ledger/2026.journal",
      totalLines: 1,
      truncated: false,
    });

    assert.equal(output.path, "/workspace/ledger/2026.journal");
    assert.equal(output.totalLines, 1);
    assert.ok(!JSON.stringify(output).includes("Cafe"));
  });
});

describe("summarizeInputRequest", () => {
  it("does not log the prompt or option labels", () => {
    const summary = summarizeInputRequest({
      kind: "question",
      requestId: "req_1",
      prompt: "¿Confirmás el gasto de $4.500?",
      action: { toolName: "ask_question", callId: "call_1" },
      options: [{ label: "Sí" }, { label: "No" }],
    });

    assert.equal(summary.inputKind, "question");
    assert.equal(summary.toolName, "ask_question");
    assert.equal(summary.optionCount, 2);
    const json = JSON.stringify(summary);
    assert.ok(!json.includes("4.500"));
    assert.ok(!json.includes("Sí"));
  });
});

describe("summarizeInputResolution", () => {
  it("logs the outcome and option id, not the freeform text", () => {
    const summary = summarizeInputResolution({
      kind: "question",
      requestId: "req_1",
      outcome: "answered",
      response: { text: "fueron 4500" },
    });

    assert.equal(summary.outcome, "answered");
    assert.equal(summary.responseChars, 11);
    assert.ok(!JSON.stringify(summary).includes("4500"));
  });
});

describe("parseSandboxReadiness", () => {
  it("splits head and journals into fields", () => {
    const parsed = parseSandboxReadiness(
      "0a72c9c update 2026-10-27\n" +
        "/workspace/ledger/2026.journal\n" +
        "/workspace/ledger/precios/dolares.journal\n",
    );

    assert.deepEqual(parsed, {
      headSha: "0a72c9c",
      headSubject: "update 2026-10-27",
      journals: ["2026.journal", "dolares.journal"],
    });
  });

  it("tolerates a missing sha prefix", () => {
    assert.deepEqual(parseSandboxReadiness("no commits yet\n"), {
      headSubject: "no commits yet",
    });
  });
});
