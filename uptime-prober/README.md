# uptime-prober

The first public **`proof/` Marketplace offering**. An Acurast app that, every
**5 minutes**, screenshots a user-given page **entirely inside the TEE WebView** and
delivers it to the user's **own Telegram bot**.

Design + decisions: `BKLG-20260624-002` and the catalog schema spec in the
`liskov-agent-orchestrator` docs (ADR-0006 §A1). No PROOF bot, no provider secret —
the user supplies `host` (config) + their own `bot_token`/`chat_id` (secret-options).

## How the screenshot works (and why it's spike-first)

There is **no direct screenshot function** in the Acurast runtime. The path is Chrome
DevTools Protocol against the WebView's debug endpoint
([docs](https://docs.acurast.com/developers/build/nodejs-runtime-environment#webview)):

```
newTab(host) → startRefreshLoop() → getDebugUrl() → CDP Page.captureScreenshot → stopRefreshLoop()
```

`startRefreshLoop` is required — Android WebViews throttle painting when not
foregrounded, so without it the capture is blank.

Three runtime capabilities are **unproven** and gate the whole offering, so the app
**validates them first** (`src/capabilities.ts`) and logs a `go`/`no-go` verdict:

1. **WebView + `getDebugUrl()`** returns a usable debug URL.
2. **WebSocket → CDP**: the job can open a WS to that endpoint and get a PNG.
   (`Page.captureScreenshot` is WS-only; the SDK leans on an `httpPOST` shim, so raw
   socket access is the real unknown.)
3. **Telegram multipart**: `fetch` + `FormData` + `Blob` exist for `sendPhoto`.

Run the spike alone (`UPTIME_PROBER_MODE=spike`) — it does steps 1–3 once and exits.
A normal run also logs the verdict on its first tick.

## Module map

| File | Role |
| --- | --- |
| `src/index.ts` | entry + signal handling |
| `src/runtime.ts` | SDK bootstrap, config read, spike, the 5-min loop |
| `src/capabilities.ts` | the spike (3 capability probes → verdict) |
| `src/acurast-webview.ts` | `_STD_.webview` types (not in the SDK) + `newTab` promisify |
| `src/cdp.ts` | minimal CDP-over-WebSocket client + ws-url resolution |
| `src/screenshot.ts` | WebView → CDP orchestration for one capture |
| `src/probe.ts` | HTTP status/latency probe (caption) |
| `src/telegram.ts` | `sendPhoto`/`sendMessage` via the user's bot |
| `src/config.ts` | env var names + validation |

## Config (marketplace mapping)

| Env var | Marketplace option | Notes |
| --- | --- | --- |
| `UPTIME_PROBER_HOST` | user config (`env`) | URL to probe + screenshot |
| `UPTIME_PROBER_TG_CHAT_ID` | user config (`env`) | numeric chat id (after `/start`ing your bot) |
| `UPTIME_PROBER_TG_BOT_TOKEN` | user secret-option (`secret` → Lockbox → env) | the user's own bot token |
| `UPTIME_PROBER_MODE` | — | `run` (default) \| `spike` |
| `UPTIME_PROBER_TICK_MS` | — | default `300000` (5 min, fixed) |

## Local checks

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build            # → dist/app.cjs (esbuild)
```

The spike needs a real Acurast processor (the WebView + CDP path); locally,
`bootstrapSlipwayRuntime` degrades to a process-env/console runtime and the capability
probe will report `webview missing` — expected off-device.

## Build → attest → deploy (to port from liskov-diagnostic)

This app deliberately reuses `liskov-diagnostic`'s deploy plumbing. **Still to add**
(mechanical port, tracked in BKLG-20260624-002):

- `scripts/upload-ipfs.ts` — pin `dist/app.cjs` to IPFS (no-spend), write the manifest.
- `scripts/post-slipway-pin.ts` — post the GitHub-OIDC-attested pin to
  `/api/applications/uptime-prober/artifact-pins/github`.
- `.github/workflows/uptime-prober-ipfs.yml` — typecheck → test → build → pin → attest
  (mirror `diagnostic-ipfs.yml`; note `ACURAST_MAX_NETWORK_REQUESTS` must be **> 0** here).

Then fill `.liskov/uptime-prober.policy.json` `artifact.cid`/`digest` and register.

## Open validations (do the spike before trusting the loop)

- [ ] `getDebugUrl()` returns a CDP-speakable endpoint; `Page.captureScreenshot` works.
- [ ] A WebSocket from the job reaches that endpoint in-sandbox.
- [ ] `fetch`+`FormData`+`Blob` multipart `sendPhoto` egress to `api.telegram.org`.
- [ ] `runtime.resources.networkRequests` (set to 256 here) is the right cap shape/limit
      for arbitrary-`host` + Telegram egress (the diagnostic ran `0`).
- [ ] Memory/storage sizing (512/64) under real WebView rendering.
