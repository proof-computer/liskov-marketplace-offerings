// Orchestration: bootstrap the Liskov runtime, read config, run the capability
// spike once, then the fixed 5-minute tick (probe -> screenshot -> Telegram).
//
// Observability (background workers must be observable): we log on spawn (config +
// capability verdict) and on every tick, not just on activity.

import {
  bootstrapSlipwayRuntime,
  createAcurastHttpPostFetch,
  createAcurastRuntimeAdapter,
  resolveRuntimeStd,
  type RuntimeIdentityProvider
} from "@proof-computer/liskov-runtime";

import { probeCapabilities } from "./capabilities.js";
import { ENV, readConfig, type ProberConfig } from "./config.js";
import type { Log } from "./cdp.js";
import { probeHost } from "./probe.js";
import { captureHostScreenshot } from "./screenshot.js";
import { formatCaption, sendMessage, sendPhoto } from "./telegram.js";
import { emitWebhookEvent } from "./webhook.js";
import { startFixedCadenceScheduler, type TickContext } from "./scheduler.js";

const COMPONENT = "uptime-prober";
const earlyRuntimeEvents: Array<{ event: string; details?: Record<string, unknown> }> = [];

type BootstrapTrace = (phase: string, details?: Record<string, unknown>) => void;

interface ProberRuntime {
  get(name: string): string | undefined;
  log: Log;
  flush(): Promise<unknown>;
  stop(): void;
}

export interface ProberHandle {
  stop(): Promise<void>;
}

export async function startUptimeProber(): Promise<ProberHandle> {
  recordEarlyRuntimeEvent("runtime-start-entered");
  emitWebhookEvent("runtime-start-entered");
  const std = resolveRuntimeStd();
  const runtime = await bootstrapRuntime();
  const log = runtime.log;

  const result = readConfig(runtime.get);
  if (!result.ok) {
    log("config.invalid", { issues: result.issues });
    emitWebhookEvent("config-invalid", { issues: result.issues });
    throw new Error(`invalid config: ${result.issues.map((i) => `${i.field} ${i.message}`).join("; ")}`);
  }
  const config = result.config;
  log("started", { host: config.host, mode: config.mode, tickMs: config.tickMs, settleMs: config.settleMs });

  // Always run the spike once so prod logs carry the go/no-go verdict.
  const report = await probeCapabilities({ host: config.host, std, settleMs: config.settleMs, log });
  emitWebhookEvent("capabilities-report", {
    ...report,
    host: config.host
  });
  if (config.mode === "spike") {
    log("spike.done", { verdict: report.verdict, errors: report.errors });
    return { stop: async () => { await runtime.flush(); runtime.stop(); } };
  }
  if (report.verdict !== "go") {
    log("degraded", { verdict: report.verdict, errors: report.errors });
  }

  const scheduler = startFixedCadenceScheduler({
    cadenceMs: config.tickMs,
    tick: async (context) => {
      const startedAt = Date.now();
      try {
        await runTick(runtime, config, std, log, context);
      } catch (error) {
        log("tick.error", { ...context, error: safeRuntimeError(error) });
      } finally {
        log("tick.complete", { ...context, durationMs: Date.now() - startedAt });
        const flush = await runtime.flush().catch((error) => ({ ok: false, error: safeRuntimeError(error) }));
        consoleLog("tick.flush", { sequence: context.sequence, result: flush as Record<string, unknown> });
      }
    }
  });

  return {
    stop: async () => {
      await scheduler.stop();
      await runtime.flush();
      runtime.stop();
    }
  };
}

async function runTick(runtime: ProberRuntime, config: ProberConfig, std: unknown, log: Log, context: TickContext): Promise<void> {
  const botToken = runtime.get(ENV.botToken);
  const probe = await probeHost(config.host);
  log("tick", { ...context, host: config.host, probeOk: probe.ok, status: probe.status, latencyMs: probe.latencyMs });
  emitWebhookEvent("tick", { host: config.host, probeOk: probe.ok, status: probe.status, latencyMs: probe.latencyMs });

  if (!botToken) {
    // Lockbox secret not installed yet (background load) — try again next tick.
    log("tick.no-token", { env: ENV.botToken });
    emitWebhookEvent("tick-no-token", { env: ENV.botToken });
    return;
  }

  let png: Buffer | undefined;
  try {
    const shot = await captureHostScreenshot({ host: config.host, std, settleMs: config.settleMs, log });
    png = shot.png;
  } catch (error) {
    log("tick.screenshot-failed", { error: String(error) });
    emitWebhookEvent("tick-screenshot-failed", { error: String(error) });
  }

  const caption = formatCaption(config.host, probe, Date.now());
  try {
    if (png) {
      const receipt = await sendPhoto({ botToken, chatId: config.chatId, png, caption });
      log("tick.telegram-receipt", receipt as unknown as Record<string, unknown>);
    } else {
      const receipt = await sendMessage({ botToken, chatId: config.chatId, text: caption });
      log("tick.telegram-receipt", receipt as unknown as Record<string, unknown>);
    }
    log("tick.delivered", { withPhoto: Boolean(png), bytes: png?.length });
    emitWebhookEvent("tick-delivered", { withPhoto: Boolean(png), bytes: png?.length });
  } catch (error) {
    log("tick.delivery-failed", { error: String(error) });
    emitWebhookEvent("tick-delivery-failed", { error: String(error) });
  }
}

/** Bootstrap the SDK runtime; degrade to a console/process-env runtime if unavailable (local spike). */
async function bootstrapRuntime(): Promise<ProberRuntime> {
  const trace: BootstrapTrace = (event, details) => {
    emitWebhookEvent(event, details);
    recordEarlyRuntimeEvent(event, details);
  };
  const std = resolveRuntimeStd();
  const baseFetchImpl = createAcurastHttpPostFetch() ?? (globalThis as { fetch?: typeof fetch }).fetch;
  const fetchImpl = typeof baseFetchImpl === "function"
    ? traceBootstrapFetch(baseFetchImpl, trace)
    : baseFetchImpl;
  const identityProvider = traceBootstrapIdentity(createAcurastRuntimeAdapter({ std }), trace);
  try {
    emitWebhookEvent("bootstrap-started", {
      hasFetch: typeof fetchImpl === "function",
      hasStd: std !== undefined
    });
    const handle = await bootstrapSlipwayRuntime({
      appId: COMPONENT,
      component: COMPONENT,
      std,
      identityProvider,
      fetchImpl,
      bootstrap: { mode: "signed" },
      secrets: { mode: "background" },
      logging: { mode: "background" },
      diagnostics: (event) => {
        emitWebhookEvent("runtime-diagnostic", {
          phase: event.phase,
          stage: event.stage,
          status: event.status,
          ok: event.ok,
          code: event.code,
          message: event.message
        });
      }
    });
    for (const entry of earlyRuntimeEvents.splice(0)) {
      await handle.log(`uptime.${entry.event}`, entry.details, { labels: { component: COMPONENT, phase: "pre-bootstrap" } });
    }
    await handle.flush();
    const log: Log = (event, details) => {
      consoleLog(event, details);
      emitWebhookEvent(event, details);
      void handle.log(`uptime.${event}`, details, { labels: { component: COMPONENT } }).catch(() => undefined);
    };
    emitWebhookEvent("bootstrap-succeeded");
    return { get: (name) => handle.env.get(name), log, flush: () => handle.flush(), stop: () => handle.stop() };
  } catch (error) {
    consoleLog("bootstrap.fallback", { error: String(error) });
    emitWebhookEvent("bootstrap-fallback", { error: String(error) });
    return {
      get: (name) => process.env[name],
      log: (event, details) => {
        consoleLog(event, details);
        emitWebhookEvent(event, details);
      },
      flush: async () => ({ ok: false, state: "degraded", flushed: 0, pending: 0, dropped: 0 }),
      stop: () => undefined
    };
  }
}

export function recordEarlyRuntimeEvent(event: string, details?: Record<string, unknown>): void {
  if (earlyRuntimeEvents.length >= 200) earlyRuntimeEvents.shift();
  earlyRuntimeEvents.push({ event, details });
}

export function traceBootstrapFetch(
  fetchImpl: typeof fetch,
  trace: BootstrapTrace = emitWebhookEvent
): typeof fetch {
  return (async (input, init) => {
    const target = publicFetchTarget(input, init);
    trace("bootstrap-fetch-started", target);
    try {
      const response = await fetchImpl(input, init);
      trace("bootstrap-fetch-completed", {
        ...target,
        status: response.status,
        ok: response.ok
      });
      return response;
    } catch (error) {
      trace("bootstrap-fetch-failed", {
        ...target,
        error: errorSummary(error)
      });
      throw error;
    }
  }) as typeof fetch;
}

export function traceBootstrapIdentity(
  identityProvider: RuntimeIdentityProvider,
  trace: BootstrapTrace = emitWebhookEvent
): RuntimeIdentityProvider {
  return {
    async resolveIdentity(options) {
      trace("bootstrap-identity-started", {
        requireEncryptionKey: options?.requireEncryptionKey === true
      });
      try {
        const identity = await identityProvider.resolveIdentity(options);
        trace("bootstrap-identity-completed", {
          requireEncryptionKey: options?.requireEncryptionKey === true,
          hasJobId: identity.jobId.length > 0,
          hasProcessorId: identity.processorId.length > 0,
          hasResponseEncryptionKey: Boolean(identity.responseEncryptionKey)
        });
        return identity;
      } catch (error) {
        trace("bootstrap-identity-failed", {
          requireEncryptionKey: options?.requireEncryptionKey === true,
          error: errorSummary(error)
        });
        throw error;
      }
    },
    async sign(message) {
      trace("bootstrap-sign-started", { messageBytes: message.byteLength });
      try {
        const signature = await identityProvider.sign(message);
        trace("bootstrap-sign-completed", { hasSignature: signature.length > 0 });
        return signature;
      } catch (error) {
        trace("bootstrap-sign-failed", { error: errorSummary(error) });
        throw error;
      }
    },
    async decryptGrantPayload(encrypted) {
      trace("bootstrap-decrypt-started", {
        ciphertextBytes: Math.floor(encrypted.ciphertextHex.length / 2)
      });
      try {
        const plaintext = await identityProvider.decryptGrantPayload(encrypted);
        trace("bootstrap-decrypt-completed", { plaintextBytes: plaintext.byteLength });
        return plaintext;
      } catch (error) {
        trace("bootstrap-decrypt-failed", { error: errorSummary(error) });
        throw error;
      }
    }
  };
}

function publicFetchTarget(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Record<string, unknown> {
  let url: URL | undefined;
  try {
    if (typeof input === "string" || input instanceof URL) url = new URL(input);
    else if (typeof Request !== "undefined" && input instanceof Request) url = new URL(input.url);
  } catch {
    url = undefined;
  }
  return {
    method: init?.method ?? "GET",
    urlHost: url?.hostname,
    urlPath: url?.pathname,
    urlProtocol: url?.protocol.replace(/:$/u, ""),
    hasBody: init?.body !== undefined
  };
}

function errorSummary(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function safeRuntimeError(error: unknown): Record<string, unknown> {
  return errorSummary(error);
}

function consoleLog(event: string, details?: Record<string, unknown>): void {
  const line = details ? `${event} ${safeJson(details)}` : event;
  // eslint-disable-next-line no-console
  console.log(`[uptime] ${line}`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
