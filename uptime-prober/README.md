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

### Telegram prerequisites

1. In Telegram, open the verified **@BotFather** account, send `/newbot`, and
   follow the prompts. Copy the HTTP API token BotFather returns.
2. Open the new bot's chat and send `/start`; Telegram will not let the bot
   message you until you do this.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` with that token and copy
   the numeric `result[].message.chat.id` value.
4. In the Liskov Marketplace wizard, paste the token only into the masked
   **Telegram bot token** field and the numeric id into **Telegram chat ID**.
   Liskov seals the token as a managed secret and never writes it into the policy.

| Env var | Marketplace option | Notes |
| --- | --- | --- |
| `UPTIME_PROBER_HOST` | user config (`env`) | URL to probe + screenshot |
| `UPTIME_PROBER_TG_CHAT_ID` | user config (`env`) | numeric chat id (after `/start`ing your bot) |
| `UPTIME_PROBER_TG_BOT_TOKEN` | user secret-option (`secret` → managed secret → env) | the user's own bot token |
| `UPTIME_PROBER_MODE` | — | `run` (default) \| `spike` |
| `UPTIME_PROBER_TICK_MS` | — | default `300000` (5 min, fixed) |

## Local checks

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build            # → dist/bundle.cjs (stage0) + dist/app.cjs (app)
```

The spike needs a real Acurast processor (the WebView + CDP path); locally,
`bootstrapSlipwayRuntime` degrades to a process-env/console runtime and the capability
probe will report `webview missing` — expected off-device.

## Build → upload → attest

`.github/workflows/uptime-prober.yml` runs on a push to `main` that touches this
directory or the workflow. It calls the released
`proof-computer/liskov-github-actions/.github/workflows/acurast-app.yml@v2`, which:

- typechecks, tests and builds the app, then packs the Acurast zip with `bundle.cjs`
  as the stage0 entrypoint and `app.cjs` as the app payload;
- uploads the zip through a single-use Liskov upload token issued to the workflow for
  the PROOF organization's `uptime-prober` publisher application;
- attests the artifact against `.liskov/uptime-prober.policy.json`.

`.liskov/uptime-prober.policy.json` is a Manifest V5 source document: the catalogue
entry's `policyTemplate` (`../proof/uptime-prober.json`) with `release` set to
`{"mode": "source"}`. The publisher's GitHub source binding names this path, this
repository, `refs/heads/main` and the workflow, and the attestation is accepted only
under that binding. The publisher application stays disabled; it runs no job.

The Marketplace listing's `artifact` (CID and digest) is not changed by a run.
Customer launches keep using the listed digest.

## Open validations (do the spike before trusting the loop)

- [ ] `getDebugUrl()` returns a CDP-speakable endpoint; `Page.captureScreenshot` works.
- [ ] A WebSocket from the job reaches that endpoint in-sandbox.
- [ ] `fetch`+`FormData`+`Blob` multipart `sendPhoto` egress to `api.telegram.org`.
- [ ] `runtime.resources.networkRequests` (set to 256 here) is the right cap shape/limit
      for arbitrary-`host` + Telegram egress (the diagnostic ran `0`).
- [ ] Memory/storage sizing (512/64) under real WebView rendering.
