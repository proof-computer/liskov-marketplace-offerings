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
}

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
    log("screenshot.debug-url", { debugUrl });
    if (!debugUrl) {
      throw new Error("getDebugUrl() returned an empty value");
    }

    const wsUrl = await resolveCdpWebSocketUrl(debugUrl, log);
    const png = await captureScreenshotViaCdp(wsUrl, options.cdp ?? {}, log);
    log("screenshot.captured", { bytes: png.length });
    return { png, debugUrl, wsUrl, capturedAtMs: Date.now() };
  } finally {
    if (tab) {
      try { tab.stopRefreshLoop(); } catch { /* ignore */ }
      try { await tab.close(); } catch { /* ignore */ }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
