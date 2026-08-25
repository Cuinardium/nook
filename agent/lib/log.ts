type LogFields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", fields: LogFields): void {
  console[level](JSON.stringify(fields));
}

export const log = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
};
