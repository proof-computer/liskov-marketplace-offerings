// The spike. Resolves the three runtime-capability unknowns BEFORE we trust the
// full loop, and logs a structured verdict. Run standalone via UPTIME_PROBER_MODE=spike;
// also run once on the first tick of a normal "run" so prod logs always carry the verdict.
//
//   1. WebView + getDebugUrl  — is _STD_.webview present and does getDebugUrl() return a URL?
//   2. WebSocket + CDP        — can we open a WS to that endpoint and capture a PNG?
//   3. Telegram multipart      — are fetch + FormData + Blob available for sendPhoto?

import { resolveWebView } from "./acurast-webview.js";
import { webSocketCtor, type Log } from "./cdp.js";
import { captureHostScreenshot } from "./screenshot.js";
import { telegramMultipartAvailable } from "./telegram.js";

export interface CapabilityReport {
  webviewPresent: boolean;
  webSocketPresent: boolean;
  telegramMultipart: boolean;
  debugUrl?: string;
  screenshotBytes?: number;
  screenshotOk: boolean;
  errors: string[];
  verdict: "go" | "no-go";
}

export interface CapabilityProbeOptions {
  host: string;
  std?: unknown;
  settleMs?: number;
  log: Log;
}

export async function probeCapabilities(options: CapabilityProbeOptions): Promise<CapabilityReport> {
  const { host, std, log } = options;
  const errors: string[] = [];

  const webviewPresent = resolveWebView(std) !== undefined;
  const webSocketPresent = webSocketCtor() !== undefined;
  const telegramMultipart = telegramMultipartAvailable();

  if (!webviewPresent) errors.push("_STD_.webview missing");
  if (!webSocketPresent) errors.push("global WebSocket missing (CDP needs it)");
  if (!telegramMultipart) errors.push("fetch/FormData/Blob missing (sendPhoto needs them)");

  let debugUrl: string | undefined;
  let screenshotBytes: number | undefined;
  let screenshotOk = false;

  if (webviewPresent && webSocketPresent) {
    try {
      const shot = await captureHostScreenshot({ host, std, settleMs: options.settleMs, log });
      debugUrl = shot.debugUrl;
      screenshotBytes = shot.png.length;
      screenshotOk = shot.png.length > 0;
    } catch (error) {
      errors.push(`screenshot failed: ${String(error)}`);
    }
  }

  const verdict: "go" | "no-go" = screenshotOk && telegramMultipart ? "go" : "no-go";
  const report: CapabilityReport = {
    webviewPresent,
    webSocketPresent,
    telegramMultipart,
    debugUrl,
    screenshotBytes,
    screenshotOk,
    errors,
    verdict
  };
  log("capabilities.report", { ...report });
  return report;
}
