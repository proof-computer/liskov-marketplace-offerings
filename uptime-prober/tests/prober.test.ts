import assert from "node:assert/strict";
import { test } from "node:test";

import { readConfig } from "../src/config.js";
import { formatCaption } from "../src/telegram.js";
import { resolveCdpWebSocketUrl } from "../src/cdp.js";

const noopLog = () => undefined;

test("readConfig requires host + chatId and validates the URL", () => {
  const missing = readConfig(() => undefined);
  assert.equal(missing.ok, false);

  const badUrl = readConfig((n) => (n === "UPTIME_PROBER_HOST" ? "example.com" : n === "UPTIME_PROBER_TG_CHAT_ID" ? "123" : undefined));
  assert.equal(badUrl.ok, false);

  const ok = readConfig((n) =>
    n === "UPTIME_PROBER_HOST" ? "https://example.com" : n === "UPTIME_PROBER_TG_CHAT_ID" ? "123456" : undefined
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.host, "https://example.com");
    assert.equal(ok.config.chatId, "123456");
    assert.equal(ok.config.tickMs, 300_000); // fixed 5-minute default
    assert.equal(ok.config.mode, "run");
  }
});

test("formatCaption reflects probe outcome", () => {
  const up = formatCaption("https://example.com", { ok: true, status: 200, latencyMs: 42 }, 0);
  assert.match(up, /✅ https:\/\/example\.com/);
  assert.match(up, /HTTP 200 · 42ms/);

  const down = formatCaption("https://example.com", { ok: false, latencyMs: 99, error: "timeout" }, 0);
  assert.match(down, /⚠️ https:\/\/example\.com/);
  assert.match(down, /timeout · 99ms/);
});

test("resolveCdpWebSocketUrl passes through ws urls untouched", async () => {
  const ws = await resolveCdpWebSocketUrl("ws://127.0.0.1:9222/devtools/page/abc", noopLog);
  assert.equal(ws, "ws://127.0.0.1:9222/devtools/page/abc");
});
