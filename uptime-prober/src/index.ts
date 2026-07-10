// Entry point for the uptime-prober Acurast app.
// See BKLG-20260624-002 + the catalog schema spec for the offering contract.

import { startUptimeProber, type ProberHandle } from "./runtime.js";
import { emitWebhookEvent, flushWebhookEvents, webhookRunId } from "./webhook.js";

let handle: ProberHandle | undefined;

emitWebhookEvent("process-start", {
  runId: webhookRunId(),
  pid: process.pid,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  hasFetch: typeof globalThis.fetch === "function",
  hasHttpPost: typeof (globalThis as { httpPOST?: unknown }).httpPOST === "function",
  hasStd: typeof (globalThis as { _STD_?: unknown })._STD_ === "object"
});

process.on("unhandledRejection", (reason) => {
  console.error("[uptime] unhandledRejection", reason);
  emitWebhookEvent("unhandled-rejection", { reason: describeUnknown(reason) });
});
process.on("uncaughtException", (error) => {
  console.error("[uptime] uncaughtException", error);
  emitWebhookEvent("uncaught-exception", { error: describeUnknown(error) });
  process.exitCode = 1;
});
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main();

async function main(): Promise<void> {
  try {
    emitWebhookEvent("main-entered");
    handle = await startUptimeProber();
    emitWebhookEvent("main-ready");
  } catch (error) {
    console.error("[uptime] failed to start", error);
    emitWebhookEvent("main-failed", { error: describeUnknown(error) });
    await flushWebhookEvents();
    process.exitCode = 1;
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[uptime] ${signal} received, stopping`);
  try {
    emitWebhookEvent("shutdown", { signal });
    handle?.stop();
  } finally {
    await flushWebhookEvents();
    process.exit(0);
  }
}

function describeUnknown(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  return { value: String(value) };
}
