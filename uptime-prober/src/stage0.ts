const WEBHOOK_URL_ENV = "UPTIME_PROBER_WEBHOOK_URL";
const DEFAULT_PUBLIC_WEBHOOK_URL = "https://webhook.site/a5e40853-4f81-4185-b27b-0f64c2158012";
const STAGE0_TIMEOUT_MS = 2_500;
const APP_ENTRYPOINT = ["./app", ".cjs"].join("");

type HttpPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
  onSuccess: (response: string, certificate?: string) => void,
  onError: (error: string) => void
) => void;

const stage0RunId = [
  "uptime-stage0",
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 10)
].join("-");

void runStage0();

async function runStage0(): Promise<void> {
  await emitStage0("stage0-entered", {
    hasProcess: typeof process !== "undefined",
    hasFetch: typeof globalThis.fetch === "function",
    hasHttpPost: typeof (globalThis as { httpPOST?: HttpPost }).httpPOST === "function",
    hasStd: typeof (globalThis as { _STD_?: unknown })._STD_ === "object"
  });

  await import(APP_ENTRYPOINT).catch(async (error: unknown) => {
    await emitStage0("stage0-import-failed", {
      error: describeUnknown(error)
    });
    if (typeof process !== "undefined") {
      process.exitCode = 1;
    }
  });
}

async function emitStage0(phase: string, details?: unknown): Promise<void> {
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
  await postStage0Webhook(event);
}

async function postStage0Webhook(event: unknown): Promise<void> {
  const url = resolveWebhookUrl();
  if (!url) return;
  const body = JSON.stringify({
    domain: "proof.liskov.uptime-prober.stage0.webhook.v1",
    runId: stage0RunId,
    sentAt: new Date().toISOString(),
    event
  });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  const httpPOST = (globalThis as { httpPOST?: HttpPost }).httpPOST;
  if (typeof httpPOST === "function") {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, STAGE0_TIMEOUT_MS);
      timeout.unref?.();
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      try {
        httpPOST(url, body, headers, finish, finish);
      } catch {
        finish();
      }
    });
    return;
  }
  if (typeof globalThis.fetch !== "function") return;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), STAGE0_TIMEOUT_MS)
    : undefined;
  timeout?.unref?.();
  try {
    await globalThis.fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller?.signal
    });
  } catch {
    // Public webhook diagnostics must not affect runtime startup.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resolveWebhookUrl(): string | undefined {
  const fromEnv = typeof process !== "undefined" ? process.env[WEBHOOK_URL_ENV]?.trim() : undefined;
  if (fromEnv === "off" || fromEnv === "none" || fromEnv === "false") return undefined;
  const candidate = fromEnv || DEFAULT_PUBLIC_WEBHOOK_URL;
  return safeHttpsUrl(candidate);
}

function safeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
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
