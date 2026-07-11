const APP_ENTRYPOINT = ["./app", ".cjs"].join("");

void runStage0();

async function runStage0(): Promise<void> {
  emitStage0("stage0-entered", {
    hasProcess: typeof process !== "undefined",
    hasFetch: typeof globalThis.fetch === "function",
    hasHttpPost: typeof (globalThis as { httpPOST?: unknown }).httpPOST === "function",
    hasStd: typeof (globalThis as { _STD_?: unknown })._STD_ === "object"
  });

  await import(APP_ENTRYPOINT).catch((error: unknown) => {
    emitStage0("stage0-import-failed", {
      error: describeUnknown(error)
    });
    if (typeof process !== "undefined") {
      process.exitCode = 1;
    }
  });
}

function emitStage0(phase: string, details?: unknown): void {
  const event = {
    domain: "proof.liskov.uptime-prober.stage0.v1",
    phase,
    timestamp: new Date().toISOString(),
    details: sanitize(details)
  };
  try {
    console.log(JSON.stringify(event));
  } catch {
    // Stage-zero diagnostics are best-effort only.
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

function sanitize(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return truncate(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    out[key] = /secret|token|key|private|password|seed|bearer|authorization|ciphertext|signature/i.test(key)
      ? "[redacted]"
      : sanitize(item);
  }
  return out;
}

function truncate(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
