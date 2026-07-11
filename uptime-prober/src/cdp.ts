// Minimal Chrome DevTools Protocol (CDP) client over a WebSocket.
//
// Page.captureScreenshot is a WS-only command, so this is the make-or-break
// capability for the in-job screenshot: the job must be able to open a
// WebSocket to the WebView's debug endpoint (getDebugUrl, see ./acurast-webview.ts).
// If the Acurast sandbox only exposes httpPOST (no sockets), this path fails and
// the capability probe (./capabilities.ts) will report it.

export type Log = (event: string, details?: Record<string, unknown>) => void;

interface MinimalWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}
type WebSocketCtor = new (url: string) => MinimalWebSocket;

export function webSocketCtor(): WebSocketCtor | undefined {
  return (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
}

/**
 * Turn a getDebugUrl() value into a CDP WebSocket URL.
 * - ws://… / wss://… → used directly.
 * - http://… / https://… → discovered via the DevTools /json[/list] endpoint
 *   (`webSocketDebuggerUrl` of the first `page` target).
 */
export interface CdpDiscoveryOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function resolveCdpWebSocketUrl(
  debugUrl: string,
  log: Log,
  options: CdpDiscoveryOptions = {}
): Promise<string> {
  const trimmed = debugUrl.trim();
  const parsed = safeUrl(trimmed);
  if (parsed && (parsed.protocol === "ws:" || parsed.protocol === "wss:") && parsed.pathname.startsWith("/devtools/")) {
    log("cdp.ws-url.direct", { endpointPath: parsed.pathname });
    return trimmed;
  }
  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("CDP target discovery requires global fetch");
  }
  if (!parsed || !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("getDebugUrl returned an unsupported DevTools origin");
  }
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  const base = parsed.toString().replace(/\/$/u, "");
  const timeoutMs = options.timeoutMs ?? 5_000;
  for (const path of ["/json/list", "/json"]) {
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      const contentType = res.headers.get("content-type")?.split(";", 1)[0]?.trim();
      const body = await res.text();
      const diagnostic = { endpointPath: path, status: res.status, contentType, responseBytes: Buffer.byteLength(body) };
      if (!res.ok) {
        log("cdp.ws-url.discovery-status", diagnostic);
        continue;
      }
      let targets: Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      try {
        const decoded: unknown = JSON.parse(body);
        if (!Array.isArray(decoded)) throw new Error("target list is not an array");
        targets = decoded;
      } catch {
        log("cdp.ws-url.discovery-malformed", diagnostic);
        continue;
      }
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) {
        const target = safeUrl(page.webSocketDebuggerUrl);
        if (!target || !["ws:", "wss:"].includes(target.protocol) || !target.pathname.startsWith("/devtools/")) {
          log("cdp.ws-url.discovery-malformed", diagnostic);
          continue;
        }
        log("cdp.ws-url.discovered", { ...diagnostic, targetPath: target.pathname });
        return page.webSocketDebuggerUrl;
      }
      log("cdp.ws-url.discovery-no-page", diagnostic);
    } catch (error) {
      log("cdp.ws-url.discovery-error", { endpointPath: path, error: safeError(error) });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("could not resolve a page CDP target from the DevTools origin");
}

export interface CdpScreenshotOptions {
  /** Optional deterministic viewport via Emulation.setDeviceMetricsOverride. */
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  timeoutMs?: number;
}

/** Open a CDP WebSocket, capture a PNG of the current page, and return the bytes. */
export function captureScreenshotViaCdp(
  wsUrl: string,
  options: CdpScreenshotOptions,
  log: Log
): Promise<Buffer> {
  const Ctor = webSocketCtor();
  if (!Ctor) {
    return Promise.reject(new Error("global WebSocket is unavailable — cannot speak CDP from this runtime"));
  }
  const timeoutMs = options.timeoutMs ?? 20_000;

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, (result: Record<string, unknown>) => void>();
    let ws: MinimalWebSocket;

    const timer = setTimeout(() => fail(new Error(`CDP screenshot timed out after ${timeoutMs}ms`)), timeoutMs);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      reject(error);
    }
    function done(png: Buffer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(png);
    }
    function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    try {
      ws = new Ctor(wsUrl);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    ws.onerror = (ev) => fail(new Error(`CDP WebSocket error: ${describe(ev)}`));
    ws.onclose = (ev) => fail(new Error(`CDP WebSocket closed before capture (code ${ev?.code ?? "?"})`));
    ws.onmessage = (ev) => {
      let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return; // CDP event, not a command reply
      const resolver = pending.get(msg.id);
      if (!resolver) return;
      pending.delete(msg.id);
      if (msg.error) {
        fail(new Error(`CDP error: ${msg.error.message ?? "unknown"}`));
        return;
      }
      resolver(msg.result ?? {});
    };

    ws.onopen = () => {
      void (async () => {
        try {
          log("cdp.connected", { endpointPath: safeUrl(wsUrl)?.pathname });
          await send("Page.enable");
          if (options.width && options.height) {
            await send("Emulation.setDeviceMetricsOverride", {
              width: options.width,
              height: options.height,
              deviceScaleFactor: options.deviceScaleFactor ?? 1,
              mobile: false
            });
          }
          const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          const data = result["data"];
          if (typeof data !== "string" || data.length === 0) {
            fail(new Error("Page.captureScreenshot returned no data"));
            return;
          }
          done(Buffer.from(data, "base64"));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    };
  });
}

function safeUrl(value: string): URL | undefined {
  try { return new URL(value); } catch { return undefined; }
}

function safeError(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) return { message: String(value) };
  const cause = value.cause as { code?: unknown } | undefined;
  return { name: value.name, message: value.message, causeCode: typeof cause?.code === "string" ? cause.code : undefined };
}

function describe(value: unknown): string {
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message?: unknown }).message);
  }
  return String(value);
}
