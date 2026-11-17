import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchJsonWithRetry } from "./fetch-retry.ts";

const URL_ = "https://prices.example/v1";
const noSleep = async () => undefined;

function scripted(replies: Array<Response | Error>) {
  let calls = 0;
  const fetchImpl = (async () => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("fetchJsonWithRetry", () => {
  it("returns the body on the first success", async () => {
    const s = scripted([json([{ casa: "bolsa" }])]);
    const data = await fetchJsonWithRetry(URL_, {
      fetchImpl: s.fetchImpl,
      sleep: noSleep,
    });
    assert.deepEqual(data, [{ casa: "bolsa" }]);
    assert.equal(s.calls(), 1);
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const s = scripted([
      json({}, 503),
      new TypeError("fetch failed"),
      json({ ok: true }),
    ]);
    const data = await fetchJsonWithRetry(URL_, {
      fetchImpl: s.fetchImpl,
      sleep: noSleep,
    });
    assert.deepEqual(data, { ok: true });
    assert.equal(s.calls(), 3);
  });

  it("does not retry a 4xx and reports the real attempt count", async () => {
    const s = scripted([json({}, 404)]);
    await assert.rejects(
      fetchJsonWithRetry(URL_, { fetchImpl: s.fetchImpl, sleep: noSleep }),
      /prices\.example respondió 404 \(tras 1 intento\(s\)\)/,
    );
    assert.equal(s.calls(), 1);
  });

  it("gives up after the configured attempts", async () => {
    const s = scripted([json({}, 500)]);
    await assert.rejects(
      fetchJsonWithRetry(URL_, {
        fetchImpl: s.fetchImpl,
        sleep: noSleep,
        attempts: 2,
      }),
      /respondió 500 \(tras 2 intento\(s\)\)/,
    );
    assert.equal(s.calls(), 2);
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const s = scripted([json({})]);
    await assert.rejects(
      fetchJsonWithRetry(URL_, {
        fetchImpl: s.fetchImpl,
        sleep: noSleep,
        signal: controller.signal,
      }),
    );
    assert.equal(s.calls(), 0);
  });
});
