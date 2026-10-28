export type LogFields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", fields: LogFields): void {
  const ts = new Date().toISOString();
  try {
    console[level](JSON.stringify({ ...fields, ts, level }));
  } catch {
    // Logging must never fail a turn, even when a field is not serializable.
    console[level](
      JSON.stringify({ ts, level, event: "log.serialization_failed" }),
    );
  }
}

export const log = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
};
