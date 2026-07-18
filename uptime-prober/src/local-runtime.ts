import { bootstrapRuntime, type ProberRuntime } from "./runtime.js";

/** Local-only ambient fallback. The production entrypoint never imports this module. */
export async function bootstrapLocalRuntime(): Promise<ProberRuntime> {
  try {
    return await bootstrapRuntime();
  } catch (error) {
    console.log(`[uptime] local bootstrap fallback: ${String(error)}`);
    return {
      get: (name) => process.env[name],
      log: (event, details) => {
        console.log(`[uptime] ${event}${details ? ` ${safeJson(details)}` : ""}`);
      },
      flush: async () => ({ ok: false, state: "local", flushed: 0, pending: 0, dropped: 0 }),
      stop: async () => undefined
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
