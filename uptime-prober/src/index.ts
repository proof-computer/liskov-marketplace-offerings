// Entry point for the uptime-prober Acurast app.
// See BKLG-20260624-002 + the catalog schema spec for the offering contract.

import { startUptimeProber, type ProberHandle } from "./runtime.js";

let handle: ProberHandle | undefined;

process.on("unhandledRejection", (reason) => {
  console.error("[uptime] unhandledRejection", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[uptime] uncaughtException", error);
  process.exitCode = 1;
});
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

void main();

async function main(): Promise<void> {
  try {
    handle = await startUptimeProber();
  } catch (error) {
    console.error("[uptime] failed to start", error);
    process.exitCode = 1;
  }
}

function shutdown(signal: string): void {
  console.log(`[uptime] ${signal} received, stopping`);
  try {
    handle?.stop();
  } finally {
    process.exit(0);
  }
}
