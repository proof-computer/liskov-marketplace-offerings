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
  type LiskovRuntimeDiagnostics,
  type RuntimeIdentityProvider
} from "@proof-computer/liskov-runtime";

import { probeCapabilities } from "./capabilities.js";
import { ENV, readConfig, type ProberConfig } from "./config.js";
import type { Log } from "./cdp.js";
import { probeHost } from "./probe.js";
import { captureHostScreenshot } from "./screenshot.js";
import { formatCaption, sendMessage, sendPhoto } from "./telegram.js";
import { startFixedCadenceScheduler, type TickContext } from "./scheduler.js";

const COMPONENT = "uptime-prober";
const TRACED_BOOTSTRAP_PATHS = new Set([
  "/api/jobs/runtime-bootstrap",
  "/api/jobs/secret-bootstrap",
  "/api/jobs/secret-requests",
  "/api/jobs/runtime-env"
]);
const earlyRuntimeEvents: Array<{ event: string; details?: Record<string, unknown> }> = [];
let attachedRuntimeLog: Log | undefined;

type BootstrapTrace = (phase: string, details?: Record<string, unknown>) => void;

export interface ProberRuntime {
  get(name: string): string | undefined;
  log: Log;
  flush(): Promise<unknown>;
  stop(): Promise<void>;
}

export interface BootstrapRuntimeDependencies {
  bootstrap?: typeof bootstrapSlipwayRuntime;
  std?: ReturnType<typeof resolveRuntimeStd>;
  fetchImpl?: typeof fetch;
  identityProvider?: RuntimeIdentityProvider;
  onDiagnostics?: (diagnostics: LiskovRuntimeDiagnostics) => void;
}

export interface StartUptimeProberOptions {
  runtimeBootstrap?: () => Promise<ProberRuntime>;
  onDiagnostics?: (diagnostics: LiskovRuntimeDiagnostics) => void;
}

export interface ProberHandle {
  stop(): Promise<void>;
}

export async function startUptimeProber(options: StartUptimeProberOptions = {}): Promise<ProberHandle> {
  recordEarlyRuntimeEvent("runtime-start-entered");
  const std = resolveRuntimeStd();
  const runtime = await (options.runtimeBootstrap?.() ?? bootstrapRuntime({ onDiagnostics: options.onDiagnostics }));
  const log = runtime.log;

  const result = readConfig(runtime.get);
  if (!result.ok) {
    log("config.invalid", { issues: result.issues });
    throw new Error(`invalid config: ${result.issues.map((i) => `${i.field} ${i.message}`).join("; ")}`);
  }
  const config = result.config;
  log("started", { host: config.host, mode: config.mode, tickMs: config.tickMs, settleMs: config.settleMs });

  // Always run the spike once so prod logs carry the go/no-go verdict.
  const report = await probeCapabilities({ host: config.host, std, settleMs: config.settleMs, log });
  if (config.mode === "spike") {
    log("spike.done", { verdict: report.verdict, errors: report.errors });
    return { stop: async () => { await runtime.flush(); await runtime.stop(); } };
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
      await runtime.stop();
    }
  };
}

async function runTick(runtime: ProberRuntime, config: ProberConfig, std: unknown, log: Log, context: TickContext): Promise<void> {
  const botToken = runtime.get(ENV.botToken);
  const probe = await probeHost(config.host);
  log("tick", { ...context, host: config.host, probeOk: probe.ok, status: probe.status, latencyMs: probe.latencyMs });

  if (!botToken) {
    // Lockbox secret not installed yet (background load) — try again next tick.
    log("tick.no-token", { env: ENV.botToken });
    return;
  }

  let png: Buffer | undefined;
  try {
    const shot = await captureHostScreenshot({ host: config.host, std, settleMs: config.settleMs, log });
    png = shot.png;
  } catch (error) {
    log("tick.screenshot-failed", { error: String(error) });
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
  } catch (error) {
    log("tick.delivery-failed", { error: String(error) });
  }
}

/** Bootstrap the production SDK runtime. Any failure is terminal and propagates. */
export async function bootstrapRuntime(dependencies: BootstrapRuntimeDependencies = {}): Promise<ProberRuntime> {
  const trace: BootstrapTrace = (event, details) => {
    recordEarlyRuntimeEvent(event, details);
  };
  const tracing = createBootstrapTraceLifecycle(trace);
  const std = dependencies.std ?? resolveRuntimeStd();
  const baseFetchImpl = dependencies.fetchImpl ?? createAcurastHttpPostFetch() ?? (globalThis as { fetch?: typeof fetch }).fetch;
  const fetchImpl = typeof baseFetchImpl === "function"
    ? tracing.fetch(baseFetchImpl)
    : baseFetchImpl;
  const identityProvider = tracing.identity(dependencies.identityProvider ?? createAcurastRuntimeAdapter({ std }));
  let handle: Awaited<ReturnType<typeof bootstrapSlipwayRuntime>>;
  try {
    recordEarlyRuntimeEvent("bootstrap-started", {
      hasFetch: typeof fetchImpl === "function",
      hasStd: std !== undefined
    });
    handle = await (dependencies.bootstrap ?? bootstrapSlipwayRuntime)({
      appId: COMPONENT,
      component: COMPONENT,
      std,
      identityProvider,
      fetchImpl,
      bootstrap: { mode: "signed" },
      secrets: { mode: "background" },
      logging: { mode: "background" },
      diagnostics: (event) => {
        const diagnostic = {
          phase: event.phase,
          stage: event.stage,
          status: event.status,
          ok: event.ok,
          code: event.code,
          message: safeDiagnosticMessage(event.message)
        };
        if (event.phase === "slipway_logging") {
          consoleLog("runtime-diagnostic", diagnostic);
          return;
        }
        recordEarlyRuntimeEvent("runtime-diagnostic", diagnostic);
      }
    });
  } catch (error) {
    tracing.close();
    attachedRuntimeLog = undefined;
    consoleLog("bootstrap.failed", { error: String(error) });
    recordEarlyRuntimeEvent("bootstrap-failed", { error: String(error) });
    throw error;
  }
  dependencies.onDiagnostics?.(handle.diagnostics);
  tracing.close();

  while (earlyRuntimeEvents.length > 0) {
    const entry = earlyRuntimeEvents.shift()!;
    try {
      await handle.log(`uptime.${entry.event}`, entry.details, { labels: { component: COMPONENT, phase: "pre-bootstrap" } });
    } catch (error) {
      consoleLog("bootstrap.logging-handoff-failed", { event: entry.event, error: safeRuntimeError(error) });
    }
  }

  let applicationLogQueue = Promise.resolve();
  const awaitApplicationLogs = async (): Promise<void> => {
    await applicationLogQueue;
  };
  const log: Log = (event, details) => {
    consoleLog(event, details);
    const write = () => handle.log(`uptime.${event}`, details, { labels: { component: COMPONENT } });
    applicationLogQueue = applicationLogQueue.then(write, write).catch((error) => {
      consoleLog("logging.write-failed", { event, error: safeRuntimeError(error) });
    });
  };
  const runtime: ProberRuntime = {
    get: (name) => handle.env.get(name),
    log,
    async flush() {
      await awaitApplicationLogs();
      return handle.flush();
    },
    async stop() {
      await awaitApplicationLogs();
      handle.stop();
    }
  };
  attachedRuntimeLog = log;
  log("bootstrap-succeeded");
  try {
    await runtime.flush();
  } catch (error) {
    consoleLog("bootstrap.logging-handoff-failed", { event: "bootstrap-succeeded", error: safeRuntimeError(error) });
  }
  return runtime;
}

export function recordEarlyRuntimeEvent(event: string, details?: Record<string, unknown>): void {
  if (attachedRuntimeLog) {
    attachedRuntimeLog(event, details);
    return;
  }
  if (earlyRuntimeEvents.length >= 200) earlyRuntimeEvents.shift();
  earlyRuntimeEvents.push({ event, details });
}

/** Internal test seam; uptime-prober is bundled as an app and exposes no package API. */
export function resetRuntimeStateForTest(): void {
  earlyRuntimeEvents.length = 0;
  attachedRuntimeLog = undefined;
}

export function traceBootstrapFetch(
  fetchImpl: typeof fetch,
  trace: BootstrapTrace = recordEarlyRuntimeEvent,
  enabled: () => boolean = () => true
): typeof fetch {
  return (async (input, init) => {
    const target = enabled() ? bootstrapFetchTarget(input, init) : undefined;
    if (!target) return fetchImpl(input, init);
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
  trace: BootstrapTrace = recordEarlyRuntimeEvent,
  enabled: () => boolean = () => true
): RuntimeIdentityProvider {
  return {
    async resolveIdentity(options) {
      if (!enabled()) return identityProvider.resolveIdentity(options);
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
      if (!enabled()) return identityProvider.sign(message);
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
      if (!enabled()) return identityProvider.decryptGrantPayload(encrypted);
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

export function createBootstrapTraceLifecycle(trace: BootstrapTrace = recordEarlyRuntimeEvent): {
  fetch(fetchImpl: typeof fetch): typeof fetch;
  identity(identityProvider: RuntimeIdentityProvider): RuntimeIdentityProvider;
  close(): void;
} {
  let active = true;
  const enabled = () => active;
  return {
    fetch: (fetchImpl) => traceBootstrapFetch(fetchImpl, trace, enabled),
    identity: (identityProvider) => traceBootstrapIdentity(identityProvider, trace, enabled),
    close: () => { active = false; }
  };
}

function bootstrapFetchTarget(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Record<string, unknown> | undefined {
  const target = publicFetchTarget(input, init);
  if (target.method !== "POST" || typeof target.urlPath !== "string" || !TRACED_BOOTSTRAP_PATHS.has(target.urlPath)) {
    return undefined;
  }
  return target;
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
    method: String(init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase(),
    urlHost: url?.hostname,
    urlPath: url?.pathname,
    urlProtocol: url?.protocol.replace(/:$/u, ""),
    hasBody: init?.body !== undefined
  };
}

function safeDiagnosticMessage(message: unknown): string | undefined {
  if (typeof message !== "string" || message.length === 0) return undefined;
  return message
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-url]")
    .replace(/bot[0-9]+:[A-Za-z0-9_-]+/giu, "bot[redacted]")
    .slice(0, 300);
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
