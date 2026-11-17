/**
 * Bounded retry for idempotent GETs made from tools.
 *
 * eve never retries a tool call itself: a thrown error goes straight to the
 * model. For safe, idempotent reads (public price APIs) a short in-tool retry
 * absorbs transient network blips and 5xx/429 answers so the model only sees
 * an error when the upstream is really down. Never use it for writes.
 */

export type FetchRetryOptions = {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Base backoff; grows linearly per attempt. */
  backoffMs?: number;
  /** Aborts the whole operation (pass the tool call's `abortSignal`). */
  signal?: AbortSignal;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchJsonWithRetry<T>(
  url: string,
  options: FetchRetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    timeoutMs = 8_000,
    backoffMs = 500,
    signal,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = options;

  let lastError = "sin intentos";
  let made = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    made = attempt;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: "application/json" },
      });
      if (response.ok) {
        return (await response.json()) as T;
      }
      lastError = `respondió ${response.status}`;
      if (!isRetryableStatus(response.status)) {
        break;
      }
    } catch (err) {
      // The caller's abort wins: stop at once instead of retrying.
      if (signal?.aborted) {
        throw err;
      }
      lastError =
        timeout.aborted
          ? `sin respuesta en ${timeoutMs} ms`
          : err instanceof Error
            ? err.message
            : String(err);
    }
    if (attempt < attempts) {
      await sleep(backoffMs * attempt);
    }
  }

  const host = new URL(url).host;
  throw new Error(`${host} ${lastError} (tras ${made} intento(s))`);
}
