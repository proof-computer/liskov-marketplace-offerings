import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readConfig } from "../src/config.js";
import { formatCaption, safeTransportError, sendPhoto } from "../src/telegram.js";
import { resolveCdpWebSocketUrl } from "../src/cdp.js";
import { traceBootstrapFetch, traceBootstrapIdentity } from "../src/runtime.js";
import { validatePng } from "../src/screenshot.js";
import { startFixedCadenceScheduler } from "../src/scheduler.js";

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

test("resolveCdpWebSocketUrl discovers bare ws origins and falls back to /json", async () => {
  const calls: string[] = [];
  const events: Array<Record<string, unknown> | undefined> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/json/list")) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    return Response.json([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1" }]);
  }) as typeof fetch;
  const resolved = await resolveCdpWebSocketUrl("ws://127.0.0.1:9222", (_event, details) => events.push(details), { fetchImpl });
  assert.equal(resolved, "ws://127.0.0.1:9222/devtools/page/page-1");
  assert.deepEqual(calls, ["http://127.0.0.1:9222/json/list", "http://127.0.0.1:9222/json"]);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /missing/u);
  assert.match(serialized, /responseBytes/u);
});

test("resolveCdpWebSocketUrl rejects malformed target lists", async () => {
  const fetchImpl = (async () => Response.json({ webSocketDebuggerUrl: "ws://secret/devtools/page/x" })) as typeof fetch;
  await assert.rejects(resolveCdpWebSocketUrl("http://127.0.0.1:9222", noopLog, { fetchImpl }), /could not resolve/u);
});

test("validatePng checks signature, IHDR, and dimensions", () => {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  assert.deepEqual(validatePng(png), { width: 1280, height: 720 });
  assert.throws(() => validatePng(Buffer.alloc(33)), /not a PNG/u);
});

test("fixed cadence scheduler runs immediately, serializes ticks, and stops", async () => {
  let active = 0;
  let maxActive = 0;
  const contexts: Array<{ sequence: number; scheduledAtMs: number }> = [];
  const scheduler = startFixedCadenceScheduler({
    cadenceMs: 10,
    async tick(context) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      contexts.push(context);
      await new Promise((resolve) => setTimeout(resolve, 18));
      active -= 1;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 58));
  await scheduler.stop();
  assert.equal(maxActive, 1);
  assert.ok(contexts.length >= 2);
  assert.equal(contexts[0]?.sequence, 1);
  assert.ok((contexts[1]?.scheduledAtMs ?? 0) > (contexts[0]?.scheduledAtMs ?? 0));
  await scheduler.done;
});

test("Telegram sendPhoto returns a safe receipt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    ok: true,
    result: {
      message_id: 44,
      caption: "caption",
      chat: { type: "private" },
      photo: [{ file_id: "small", width: 90, height: 50 }, { file_id: "large", width: 1280, height: 720 }]
    }
  })) as typeof fetch;
  try {
    const receipt = await sendPhoto({ botToken: "123:secret", chatId: "1", png: Buffer.from("png"), caption: "caption" });
    assert.deepEqual(receipt, {
      operation: "sendPhoto", messageId: 44, caption: "caption", chatType: "private",
      photo: { fileId: "large", width: 1280, height: 720 }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram transport errors redact token URLs and preserve safe cause codes", () => {
  const error = new Error("fetch https://api.telegram.org/bot123:secret/sendPhoto failed", { cause: { code: "ENOTFOUND" } });
  const summary = JSON.stringify(safeTransportError(error));
  assert.doesNotMatch(summary, /123:secret/u);
  assert.match(summary, /ENOTFOUND/u);
});

test("marketplace policy template preserves diagnostic placement flags", () => {
  const entry = JSON.parse(readFileSync(new URL("../../proof/uptime-prober.json", import.meta.url), "utf8"));
  const acurast = entry.policyTemplate.acurast;

  assert.equal(acurast.verifiedOnly, false);
  assert.equal(acurast.managerId, "9470");
  assert.equal(acurast.assignmentStrategy, "single");
  assert.equal(acurast.processorSelection.mode, "open-market");
  assert.equal(acurast.processorSelection.requireScheduleClear, true);
  assert.equal(acurast.processorSelection.requireConsumerAccess, true);

  assert.equal(entry.optionsSchema.host.delivery, "slipway");
  assert.equal(entry.optionsSchema.telegramChatId.delivery, "slipway");

  assert.equal(entry.policyTemplate.blackbox.configSource, "liskov.builtin");
  assert.deepEqual(entry.policyTemplate.secrets.declarations, []);
  assert.deepEqual(entry.policyTemplate.environment.variables, []);
  assert.equal(entry.artifact.cid, "ipfs://QmWGGdtzq5RuVK71GptZmnsjLdzjBYKeMttdh3RTKR9eks");
  assert.equal(
    entry.policyTemplate.artifactAutomation.github.workflowRef,
    "proof-computer/liskov-marketplace-offerings/.github/workflows/uptime-prober.yml@refs/heads/main"
  );
});

test("artifact workflow ships the stage0 wrapper and app bundle", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/uptime-prober.yml", import.meta.url), "utf8");

  assert.match(workflow, /entrypoint:\s+bundle\.cjs/u);
  assert.match(workflow, /extra-files:\s+app\.cjs/u);
});

test("bootstrap tracing reports safe identity and HTTP milestones", async () => {
  const events: Array<{ phase: string; details?: Record<string, unknown> }> = [];
  const trace = (phase: string, details?: Record<string, unknown>) => events.push({ phase, details });
  const identity = traceBootstrapIdentity({
    async resolveIdentity() {
      return { jobId: "job-secret", processorId: "processor-secret" };
    },
    async sign() {
      return "signature-secret";
    },
    async decryptGrantPayload() {
      return Buffer.from("plaintext-secret");
    }
  }, trace);
  const fetchImpl = traceBootstrapFetch((async () => new Response("{}", { status: 200 })) as typeof fetch, trace);

  await identity.resolveIdentity();
  await identity.sign(Buffer.from("request"));
  await identity.decryptGrantPayload({
    senderPublicKey: "sender-secret",
    saltHex: "salt-secret",
    ciphertextHex: "001122"
  });
  await fetchImpl("https://liskov.example/api/jobs/runtime-bootstrap", {
    method: "POST",
    body: "request-secret"
  });

  assert.deepEqual(events.map((event) => event.phase), [
    "bootstrap-identity-started",
    "bootstrap-identity-completed",
    "bootstrap-sign-started",
    "bootstrap-sign-completed",
    "bootstrap-decrypt-started",
    "bootstrap-decrypt-completed",
    "bootstrap-fetch-started",
    "bootstrap-fetch-completed"
  ]);
  const serialized = JSON.stringify(events);
  for (const secret of ["job-secret", "processor-secret", "signature-secret", "plaintext-secret", "request-secret"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.match(serialized, /runtime-bootstrap/);
});
