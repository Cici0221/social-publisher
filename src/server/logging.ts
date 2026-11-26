import { AsyncLocalStorage } from "node:async_hooks";

type LogContext = { taskId?: string; platform?: string };
const context = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(fields: LogContext, run: () => T): T {
  return context.run(fields, run);
}

export function logError(event: string, fields: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ level: "error", event, ...context.getStore(), ...fields }));
}

export function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error };
  const code: unknown = "code" in error ? error.code : undefined;
  // Exception messages from drivers can include credentials, request bodies, and raw SQL.
  const frames = error.stack?.match(/^\s+at [^\r\n]+:\d+:\d+\)?$/gm)?.slice(0, 8);
  return {
    type: /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(error.name) ? error.name : "Error",
    code: typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined,
    frames,
    cause: error.cause && depth < 2 ? errorDetails(error.cause, depth + 1) : undefined,
  };
}
