// Orchestration: bootstrap the Liskov runtime, read config, run the capability
// spike once, then the fixed 5-minute tick (probe -> screenshot -> Telegram).
//
// Observability (background workers must be observable): we log on spawn (config +
// capability verdict) and on every tick, not just on activity.

import {
  bootstrapSlipwayRuntime,
  createAcurastHttpPostFetch,
  resolveRuntimeStd
} from "@proof-computer/liskov-runtime";

import { probeCapabilities } from "./capabilities.js";
import { ENV, readConfig, type ProberConfig } from "./config.js";
import type { Log } from "./cdp.js";
import { probeHost } from "./probe.js";
import { captureHostScreenshot } from "./screenshot.js";
import { formatCaption, sendMessage, sendPhoto } from "./telegram.js";

const COMPONENT = "uptime-prober";

interface ProberRuntime {
  get(name: string): string | undefined;
  log: Log;
  stop(): void;
}

export interface ProberHandle {
  stop(): void;
}

export async function startUptimeProber(): Promise<ProberHandle> {
  const std = resolveRuntimeStd();
  const runtime = await bootstrapRuntime();
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
    return { stop: () => runtime.stop() };
  }
  if (report.verdict !== "go") {
    log("degraded", { verdict: report.verdict, errors: report.errors });
  }

  let stopped = false;
  const tick = () =>
    runTick(runtime, config, std, log).catch((error) => log("tick.error", { error: String(error) }));

  await tick(); // immediate first delivery
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, config.tickMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      runtime.stop();
    }
  };
}

async function runTick(runtime: ProberRuntime, config: ProberConfig, std: unknown, log: Log): Promise<void> {
  const botToken = runtime.get(ENV.botToken);
  const probe = await probeHost(config.host);
  log("tick", { host: config.host, probeOk: probe.ok, status: probe.status, latencyMs: probe.latencyMs });

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
      await sendPhoto({ botToken, chatId: config.chatId, png, caption });
    } else {
      await sendMessage({ botToken, chatId: config.chatId, text: caption });
    }
    log("tick.delivered", { withPhoto: Boolean(png), bytes: png?.length });
  } catch (error) {
    log("tick.delivery-failed", { error: String(error) });
  }
}

/** Bootstrap the SDK runtime; degrade to a console/process-env runtime if unavailable (local spike). */
async function bootstrapRuntime(): Promise<ProberRuntime> {
  const fetchImpl = createAcurastHttpPostFetch() ?? (globalThis as { fetch?: typeof fetch }).fetch;
  try {
    const handle = await bootstrapSlipwayRuntime({
      appId: COMPONENT,
      component: COMPONENT,
      fetchImpl,
      secrets: { mode: "background" },
      logging: { mode: "background" }
    });
    const log: Log = (event, details) => {
      consoleLog(event, details);
      void handle.log(`uptime.${event}`, details, { labels: { component: COMPONENT } }).catch(() => undefined);
    };
    return { get: (name) => handle.env.get(name), log, stop: () => handle.stop() };
  } catch (error) {
    consoleLog("bootstrap.fallback", { error: String(error) });
    return {
      get: (name) => process.env[name],
      log: (event, details) => consoleLog(event, details),
      stop: () => undefined
    };
  }
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
