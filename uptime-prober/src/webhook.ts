import { createAcurastHttpPostFetch } from "@proof-computer/liskov-runtime";

const WEBHOOK_URL_ENV = "UPTIME_PROBER_WEBHOOK_URL";
const DEFAULT_PUBLIC_WEBHOOK_URL = "https://webhook.site/a5e40853-4f81-4185-b27b-0f64c2158012";
const WEBHOOK_TIMEOUT_MS = 2_500;

let sequence = 0;
const runId = [
  "uptime",
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 10)
].join("-");
const pending = new Set<Promise<void>>();

export function emitWebhookEvent(phase: string, details?: Record<string, unknown>): void {
  const url = resolveWebhookUrl();
  if (!url) return;
  const fetchImpl = createAcurastHttpPostFetch() ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return;

  const send = postWebhookEvent(fetchImpl, url, phase, details);
  pending.add(send);
  send.finally(() => pending.delete(send)).catch(() => undefined);
}

export async function flushWebhookEvents(): Promise<void> {
  await Promise.allSettled([...pending]);
}

export function webhookRunId(): string {
  return runId;
}

async function postWebhookEvent(
  fetchImpl: typeof fetch,
  url: string,
  phase: string,
  details?: Record<string, unknown>
): Promise<void> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
    : undefined;
  timeout?.unref?.();
  try {
    await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        domain: "proof.liskov.uptime-prober.webhook.v1",
        runId,
        sequence: ++sequence,
        sentAt: new Date().toISOString(),
        phase,
        details: sanitize(details)
      }),
      signal: controller?.signal
    });
  } catch {
    // Public webhook diagnostics are best-effort and must not affect the job.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resolveWebhookUrl(): string | undefined {
  const fromEnv = process.env[WEBHOOK_URL_ENV]?.trim();
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
