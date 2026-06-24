// Type declarations + helpers for the Acurast NodeJS runtime WebView API.
//
// These are NOT provided by @proof-computer/liskov-runtime (it only types
// _STD_.env/job/device/net/signers). Shapes transcribed from the Acurast docs:
// https://docs.acurast.com/developers/build/nodejs-runtime-environment#webview
//
// There is no direct screenshot function. The screenshot is taken over Chrome
// DevTools Protocol against the endpoint returned by getDebugUrl(); see ./cdp.ts.

export interface AcurastWebViewTab {
  readonly id: string;
  getUrl(): Promise<string>;
  getTrigger(): Promise<"manual" | "auto">;
  close(options?: unknown): Promise<void>;
  /** Forces the WebView to keep painting. Docs: "in preparation for taking a screenshot". */
  startRefreshLoop(options?: unknown): void;
  stopRefreshLoop(options?: unknown): void;
}

export interface AcurastWebView {
  newTab(
    url: string,
    onSuccess: (tab: AcurastWebViewTab) => void,
    onError: (error: string) => void
  ): void;
  close(onSuccess: () => void, onError: (error: string) => void): void;
  getOpenTabs(
    onSuccess: (tabs: AcurastWebViewTab[]) => void,
    onError: (error: string) => void
  ): void;
  useProxy(url: string, config: unknown, onSuccess: () => void, onError: (error: string) => void): void;
  removeProxy(onSuccess: () => void, onError: (error: string) => void): void;
  /** @since 1.9.2 (Android) The WebView's remote-debugging (DevTools/CDP) endpoint. */
  getDebugUrl(): string;
}

/** Resolve the WebView API off the Acurast `_STD_` global (or an injected std for tests). */
export function resolveWebView(std?: unknown): AcurastWebView | undefined {
  const source = (std ?? (globalThis as { _STD_?: unknown })._STD_) as
    | { webview?: AcurastWebView }
    | undefined;
  return source?.webview;
}

/** Promise wrapper over the callback-style `webview.newTab`. */
export function openTab(webview: AcurastWebView, url: string): Promise<AcurastWebViewTab> {
  return new Promise((resolve, reject) => {
    try {
      webview.newTab(
        url,
        (tab) => resolve(tab),
        (error) => reject(new Error(`webview.newTab failed: ${error}`))
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
