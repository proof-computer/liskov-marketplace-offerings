import { installLiskovRuntimeProcessFailureHandlers } from "@proof-computer/liskov-runtime";

import { bootstrapLocalRuntime } from "./local-runtime.js";
import { startUptimeProber } from "./runtime.js";

const processFailures = installLiskovRuntimeProcessFailureHandlers({
  component: "uptime-prober-local",
  unhandledRejection: "exit",
  onStageZeroError(_kind, error) {
    console.error("[uptime] local startup failed", error);
  }
});

void processFailures.runMain(async () => {
  await startUptimeProber({ runtimeBootstrap: bootstrapLocalRuntime });
});
