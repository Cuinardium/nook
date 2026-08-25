type LogFields = Record<string, unknown>;

function emit(level: "info" | "warn", fields: LogFields): void {
  console[level](JSON.stringify(fields));
}

export const log = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
};
