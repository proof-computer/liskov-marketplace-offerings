// Entry point for the uptime-prober Acurast app.
// See BKLG-20260624-002 + the catalog schema spec for the offering contract.

import { installLiskovRuntimeProcessFailureHandlers } from "@proof-computer/liskov-runtime";
import { recordEarlyRuntimeEvent, startUptimeProber, type ProberHandle } from "./runtime.js";

let handle: ProberHandle | undefined;

recordEarlyRuntimeEvent("process-start", {
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  hasFetch: typeof globalThis.fetch === "function",
  hasHttpPost: typeof (globalThis as { httpPOST?: unknown }).httpPOST === "function",
  hasStd: typeof (globalThis as { _STD_?: unknown })._STD_ === "object"
});

const processFailures = installLiskovRuntimeProcessFailureHandlers({
  component: "uptime-prober",
  unhandledRejection: "exit",
  onStageZeroError(kind, error) {
    recordEarlyRuntimeEvent("process-failure-before-runtime", { kind, error: describeUnknown(error) });
  }
});
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void processFailures.runMain(async () => {
  recordEarlyRuntimeEvent("main-entered");
  handle = await startUptimeProber({
    onDiagnostics(diagnostics) {
      processFailures.attach(diagnostics);
    }
  });
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[uptime] ${signal} received, stopping`);
  try {
    recordEarlyRuntimeEvent("shutdown", { signal });
    await handle?.stop();
  } finally {
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
