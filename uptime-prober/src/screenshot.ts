// Orchestrates a single in-job screenshot:
//   newTab(host) -> startRefreshLoop -> getDebugUrl -> CDP Page.captureScreenshot -> stopRefreshLoop
//
// startRefreshLoop is required: Android WebViews throttle painting when not
// foregrounded, so without it the captured frame is blank/stale (per the Acurast
// docs note tying startRefreshLoop to "preparation for taking a screenshot").

import { openTab, resolveWebView, type AcurastWebViewTab } from "./acurast-webview.js";
import { captureScreenshotViaCdp, resolveCdpWebSocketUrl, type CdpScreenshotOptions, type Log } from "./cdp.js";

export interface ScreenshotOptions {
  host: string;
  std?: unknown;
  /** Time to let the page load + paint before capture. */
  settleMs?: number;
  cdp?: CdpScreenshotOptions;
  log: Log;
}

export interface ScreenshotResult {
  png: Buffer;
  debugUrl: string;
  wsUrl: string;
  capturedAtMs: number;
  width: number;
  height: number;
}

export const SCREENSHOT_VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 } as const;

export async function captureHostScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
  const { host, std, log } = options;
  const settleMs = options.settleMs ?? 8_000;

  const webview = resolveWebView(std);
  if (!webview) {
    throw new Error("_STD_.webview is unavailable in this runtime");
  }

  let tab: AcurastWebViewTab | undefined;
  try {
    log("screenshot.newtab", { host });
    tab = await openTab(webview, host);
    tab.startRefreshLoop();
    log("screenshot.refresh-loop-started", { tabId: tab.id, settleMs });

    await delay(settleMs);

    const debugUrl = webview.getDebugUrl();
    log("screenshot.debug-url", { endpointPath: safeEndpointPath(debugUrl) });
    if (!debugUrl) {
      throw new Error("getDebugUrl() returned an empty value");
    }

    const wsUrl = await resolveCdpWebSocketUrl(debugUrl, log);
    const cdp = { ...SCREENSHOT_VIEWPORT, ...options.cdp };
    const png = await captureScreenshotViaCdp(wsUrl, cdp, log);
    const dimensions = validatePng(png);
    if (dimensions.width !== cdp.width || dimensions.height !== cdp.height) {
      throw new Error(`screenshot dimensions ${dimensions.width}x${dimensions.height} did not match viewport ${cdp.width}x${cdp.height}`);
    }
    log("screenshot.captured", { bytes: png.length, ...dimensions });
    return { png, debugUrl, wsUrl, capturedAtMs: Date.now(), ...dimensions };
  } finally {
    if (tab) {
      try { tab.stopRefreshLoop(); } catch { /* ignore */ }
      try { await tab.close(); } catch { /* ignore */ }
    }
  }
}

export function validatePng(png: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature)) throw new Error("screenshot is not a PNG");
  if (png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("screenshot PNG has no valid IHDR");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) throw new Error("screenshot PNG dimensions are invalid");
  return { width, height };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEndpointPath(value: string): string | undefined {
  try { return new URL(value).pathname || "/"; } catch { return undefined; }
}
