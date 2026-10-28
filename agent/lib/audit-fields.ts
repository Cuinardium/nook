/**
 * Pure projections for the audit log.
 *
 * The audit trail is metadata-first: tool arguments are truncated and
 * secrets are redacted, while tool outputs are reduced to shape and size.
 * Journal contents and raw tool output never reach `docker logs` by default.
 */
import type { LogFields } from "./log.ts";

const MAX_COMMAND_CHARS = 500;
const MAX_URL_CHARS = 300;
const MAX_KEYS = 12;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function textBytes(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function keysOf(record: Record<string, unknown>): string[] {
  return Object.keys(record).slice(0, MAX_KEYS);
}

function textLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

export function truncateText(value: string, max = MAX_COMMAND_CHARS): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function errorMessage(error: unknown): string {
  return truncateText(
    error instanceof Error ? error.message : String(error),
    500,
  );
}

const SECRET_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY)/i;

/**
 * Removes values of secret-looking environment variables and the common
 * credential encodings from a log field. Cheap insurance: the agent should
 * never see forge tokens, but a `bash` command is still model-authored text.
 */
export function redactSecrets(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(env)) {
    if (!secret || secret.length < 8 || !SECRET_ENV_NAME.test(name)) {
      continue;
    }
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(https?:\/\/[^\s:@/]+):[^\s@/]+@/g, "$1:[REDACTED]@")
    .replace(
      /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      "$1 [REDACTED]",
    )
    .replace(/\b(authorization\s*:\s*)\S+/gi, "$1[REDACTED]");
}

export function approxBytes(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return -1;
  }
}

/** Compact tool input: enough to reconstruct an action, not its content. */
export function summarizeToolInput(
  toolName: string,
  input: unknown,
): LogFields {
  const record = asRecord(input);

  switch (toolName) {
    case "bash": {
      const command = stringField(record, "command");
      return command === undefined
        ? { argKeys: keysOf(record), argBytes: approxBytes(input) }
        : { command: truncateText(redactSecrets(command)) };
    }
    case "read_file":
      return {
        path: stringField(record, "filePath"),
        offset: numberField(record, "offset"),
        limit: numberField(record, "limit"),
      };
    case "write_file":
      return {
        path: stringField(record, "filePath"),
        contentBytes: textBytes(record.content),
      };
    case "web_fetch": {
      const url = stringField(record, "url");
      return {
        url:
          url === undefined
            ? undefined
            : truncateText(redactSecrets(url), MAX_URL_CHARS),
        format: stringField(record, "format"),
      };
    }
    case "ask_question":
      return {
        promptChars: textLength(record.prompt),
        optionCount: arrayLength(record.options),
        allowFreeform: booleanField(record, "allowFreeform"),
      };
    case "load_skill":
      return { skill: stringField(record, "skill") };
    case "todo":
      return { itemCount: arrayLength(record.todos) };
    default:
      return { argKeys: keysOf(record), argBytes: approxBytes(input) };
  }
}

/** Compact tool output: shape and sizes, never stdout or journal content. */
export function summarizeToolOutput(
  toolName: string,
  output: unknown,
): LogFields {
  const record = asRecord(output);
  const base: LogFields = { outputBytes: approxBytes(output) };

  switch (toolName) {
    case "bash":
      return {
        ...base,
        exitCode: numberField(record, "exitCode"),
        stdoutBytes: textBytes(record.stdout),
        stderrBytes: textBytes(record.stderr),
        truncated: booleanField(record, "truncated"),
      };
    case "read_file":
      return {
        ...base,
        path: stringField(record, "path"),
        totalLines: numberField(record, "totalLines"),
        truncated: booleanField(record, "truncated"),
      };
    case "write_file":
      return {
        ...base,
        path: stringField(record, "path"),
        existed: booleanField(record, "existed"),
      };
    case "web_fetch":
      return {
        ...base,
        url: stringField(record, "url"),
        contentType: stringField(record, "contentType"),
        truncated: booleanField(record, "truncated"),
      };
    case "ask_question":
      return {
        ...base,
        status: stringField(record, "status"),
        optionId: stringField(record, "optionId"),
      };
    default:
      return {
        ...base,
        outputKeys: keysOf(record),
        outputItems: Array.isArray(output) ? output.length : undefined,
      };
  }
}

export function summarizeInputRequest(request: {
  readonly kind: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly action?: {
    readonly toolName?: string;
    readonly callId?: string;
  } | null;
  readonly options?: readonly unknown[] | undefined;
  readonly allowFreeform?: boolean | undefined;
  readonly display?: string | undefined;
}): LogFields {
  return {
    requestId: request.requestId,
    inputKind: request.kind,
    toolName: request.action?.toolName,
    callId: request.action?.callId,
    promptChars: request.prompt.length,
    optionCount: request.options?.length,
    allowFreeform: request.allowFreeform,
    display: request.display,
  };
}

export function summarizeInputResolution(resolution: {
  readonly kind: string;
  readonly requestId: string;
  readonly outcome: string;
  readonly response?:
    | {
        readonly optionId?: string | undefined;
        readonly text?: string | undefined;
      }
    | undefined;
}): LogFields {
  return {
    requestId: resolution.requestId,
    inputKind: resolution.kind,
    outcome: resolution.outcome,
    optionId: resolution.response?.optionId,
    responseChars: resolution.response?.text?.length ?? 0,
  };
}

export type SandboxReadiness = {
  headSha?: string;
  headSubject?: string;
  journals?: string[];
};

/**
 * Splits the readiness probe (`git log --oneline -1` followed by
 * `ls /workspace/ledger/*.journal`) into queryable fields. The raw stdout is
 * a multi-line blob and belongs in no log line.
 */
export function parseSandboxReadiness(stdout: string): SandboxReadiness {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [headLine = "", ...journalLines] = lines;
  const readiness: SandboxReadiness = {};

  const head = /^([0-9a-f]{7,40})\s+(.*)$/i.exec(headLine);
  if (head) {
    readiness.headSha = head[1];
    readiness.headSubject = truncateText(head[2], 200);
  } else if (headLine.length > 0) {
    readiness.headSubject = truncateText(headLine, 200);
  }

  if (journalLines.length > 0) {
    readiness.journals = journalLines
      .map((line) => line.split("/").pop() ?? line)
      .slice(0, 50);
  }

  return readiness;
}
