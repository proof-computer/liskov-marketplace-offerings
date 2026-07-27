import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readConfig } from "../src/config.js";
import { formatCaption, safeTransportError, sendPhoto } from "../src/telegram.js";
import { resolveCdpWebSocketUrl } from "../src/cdp.js";
import {
  bootstrapRuntime,
  createBootstrapTraceLifecycle,
  recordEarlyRuntimeEvent,
  resetRuntimeStateForTest,
  traceBootstrapFetch,
  traceBootstrapIdentity
} from "../src/runtime.js";
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

test("marketplace template pins its release while the repository manifest retains build authority", () => {
  const entry = JSON.parse(readFileSync(new URL("../../proof/uptime-prober.json", import.meta.url), "utf8"));
  const templateSelection = entry.policyTemplate.deployment.placement.processorSelection;
  const sourceManifest = JSON.parse(
    readFileSync(new URL("../.liskov/uptime-prober.policy.json", import.meta.url), "utf8")
  );

  assert.equal(entry.policyTemplate.schema, "proof.liskov.application-manifest");
  assert.equal(entry.policyTemplate.release.mode, "pinned");
  assert.equal(entry.policyTemplate.release.artifact.kind, "ipfs_bundle");
  assert.equal(entry.policyTemplate.release.artifact.cid, entry.artifact.cid);
  assert.equal(entry.policyTemplate.release.artifact.digest, entry.artifact.digest);
  assert.equal(entry.policyTemplate.release.artifact.encryption.mode, "none");
  assert.equal(entry.artifact.requiredEncryptionMode, "none");
  assert.equal("builder" in entry.policyTemplate.release, false);
  assert.equal("build" in entry.policyTemplate, false);
  assert.equal(templateSelection.mode, "open_market");
  assert.equal(templateSelection.requireScheduleClear, true);
  assert.equal(templateSelection.requireConsumerAccess, true);
  assert.equal(entry.policyTemplate.deployment.schedule.durationMs, 1_800_000);
  assert.deepEqual(entry.policyTemplate.ingress, {});

  assert.equal(sourceManifest.schema, "proof.liskov.application-manifest");
  assert.equal(sourceManifest.release.mode, "build");
  assert.equal(sourceManifest.release.artifact.kind, "ipfs_bundle");
  assert.equal(sourceManifest.release.artifact.encryption.mode, "none");
  assert.equal(
    sourceManifest.release.builder.workflowRef,
    "proof-computer/liskov-marketplace-offerings/.github/workflows/uptime-prober.yml@refs/heads/main"
  );
  assert.equal(sourceManifest.deployment.schedule.durationMs, 1_800_000);
  assert.deepEqual(sourceManifest.ingress, {});

  assert.equal(entry.optionsSchema.host.delivery, "slipway");
  assert.equal(entry.optionsSchema.telegramChatId.delivery, "slipway");

  assert.equal(entry.policyTemplate.observability.logs.enabled, true);
  assert.deepEqual(entry.policyTemplate.configuration.secrets, []);
  assert.deepEqual(entry.policyTemplate.configuration.variables, []);
  assert.equal(entry.artifact.cid, "ipfs://QmQCpRJ593xRyKko9smvtFixzfAGwDuG6gXBemRtUeSe4U");
  assert.equal(entry.artifact.digest, "sha256:7545ffe44288c548ff4dea09ef0c0dc318a8dd490c5dc822becec3ff0d307d57");
});

test("artifact workflow ships the stage0 wrapper and app bundle", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/uptime-prober.yml", import.meta.url), "utf8");

  assert.match(workflow, /entrypoint:\s+bundle\.cjs/u);
  assert.match(workflow, /extra-files:\s+app\.cjs/u);
});

test("manifest workflow imports a draft through the reusable GitHub-OIDC route", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/uptime-prober-policy.yml", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /permissions:\s*\n\s+id-token:\s+write/u);
  assert.match(workflow, /liskov-github-actions\/\.github\/workflows\/policy-sync\.yml@main/u);
  assert.match(workflow, /application-id:\s+uptime-prober/u);
  assert.match(workflow, /manifest-path:\s+uptime-prober\/\.liskov\/uptime-prober\.policy\.json/u);
  assert.doesNotMatch(workflow, /\bpublish:/u);
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

test("bootstrap fetch tracing is restricted to the four exact POST control-plane paths", async () => {
  const events: Array<{ phase: string; details?: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const traced = traceBootstrapFetch((async (input) => {
    calls.push(String(input));
    return Response.json({ ok: true });
  }) as typeof fetch, (phase, details) => events.push({ phase, details }));
  const approved = [
    "/api/jobs/runtime-bootstrap",
    "/api/jobs/secret-bootstrap",
    "/api/jobs/secret-requests",
    "/api/jobs/runtime-env"
  ];
  for (const path of approved) {
    await traced(`https://liskov.example${path}`, { method: "POST", body: "credential-material" });
  }
  const excluded = [
    "https://logging.example/v1/sink-factories/factory-secret/job-sinks",
    "https://logging.example/v1/sinks/sink-secret/events",
    "https://liskov.example/api/jobs/runtime-diagnostics",
    "https://api.telegram.org/bot123:token-secret/sendPhoto",
    "https://target.example/private?token=target-secret"
  ];
  for (const url of excluded) await traced(url, { method: "POST", body: "secret-body" });
  await traced("https://liskov.example/api/jobs/runtime-bootstrap", { method: "GET" });

  assert.equal(calls.length, 10);
  assert.deepEqual(events.map((event) => event.phase), approved.flatMap(() => [
    "bootstrap-fetch-started",
    "bootstrap-fetch-completed"
  ]));
  assert.deepEqual(events.filter((_, index) => index % 2 === 0).map((event) => event.details?.urlPath), approved);
  const serialized = JSON.stringify(events);
  for (const secret of ["factory-secret", "sink-secret", "token-secret", "target-secret", "credential-material", "secret-body"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test("closing bootstrap tracing makes wrapped fetch and identity operations transparent", async () => {
  const events: string[] = [];
  const calls: string[] = [];
  const lifecycle = createBootstrapTraceLifecycle((phase) => events.push(phase));
  const fetchImpl = lifecycle.fetch((async (input) => {
    calls.push(`fetch:${String(input)}`);
    return Response.json({ ok: true });
  }) as typeof fetch);
  const identity = lifecycle.identity({
    async resolveIdentity() {
      calls.push("identity");
      return { jobId: "job", processorId: "processor" };
    },
    async sign() {
      calls.push("sign");
      return "signature";
    },
    async decryptGrantPayload() {
      calls.push("decrypt");
      return Buffer.from("plaintext");
    }
  });
  lifecycle.close();

  await fetchImpl("https://liskov.example/api/jobs/runtime-bootstrap", { method: "POST" });
  await identity.resolveIdentity();
  await identity.sign(Buffer.from("request"));
  await identity.decryptGrantPayload({ senderPublicKey: "sender", saltHex: "salt", ciphertextHex: "00" });

  assert.deepEqual(events, []);
  assert.deepEqual(calls, ["fetch:https://liskov.example/api/jobs/runtime-bootstrap", "identity", "sign", "decrypt"]);
});

test("logging-origin diagnostics stay console-only while other diagnostics enter the ordered application log", async (t) => {
  resetRuntimeStateForTest();
  t.after(resetRuntimeStateForTest);
  const writes: string[] = [];
  const consoleLines: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
  t.after(() => { console.log = originalConsoleLog; });
  const handle = fakeRuntimeHandle({ writes });
  const bootstrap = (async (options: { diagnostics?: (event: Record<string, unknown>) => void }) => {
    options.diagnostics?.({
      phase: "slipway_logging",
      stage: "write",
      status: "failed",
      ok: false,
      code: "slipway_logging_write_failed",
      message: "POST https://api.telegram.org/bot123:token-secret/sendPhoto failed"
    });
    options.diagnostics?.({ phase: "runtime_env", stage: "load", status: "ready", ok: true, code: "ready" });
    return handle;
  }) as never;

  await bootstrapRuntime({ bootstrap, std: undefined, fetchImpl: async () => Response.json({ ok: true }), identityProvider: fakeIdentity() });

  assert.ok(writes.includes("uptime.runtime-diagnostic"));
  assert.equal(writes.filter((event) => event === "uptime.runtime-diagnostic").length, 1);
  assert.match(consoleLines.join("\n"), /slipway_logging/u);
  assert.doesNotMatch(consoleLines.join("\n"), /token-secret/u);
});

test("production bootstrap fails closed and never selects ambient process env", async (t) => {
  resetRuntimeStateForTest();
  t.after(resetRuntimeStateForTest);
  process.env.SOURCE = "ambient-must-not-win";
  t.after(() => { delete process.env.SOURCE; });
  const original = new Error("signed bootstrap rejected");
  await assert.rejects(
    bootstrapRuntime({
      bootstrap: (async () => { throw original; }) as never,
      fetchImpl: async () => Response.json({ ok: true }),
      identityProvider: fakeIdentity()
    }),
    (error) => error === original
  );
});

test("attaches diagnostics immediately after SDK bootstrap before logging handoff", async (t) => {
  resetRuntimeStateForTest();
  t.after(resetRuntimeStateForTest);
  recordEarlyRuntimeEvent("before-bootstrap");
  const order: string[] = [];
  const diagnostics = { report: async () => undefined, fatal: async () => undefined };
  const handle = fakeRuntimeHandle({
    async log(event) { order.push(event); }
  }) as unknown as { diagnostics: typeof diagnostics };
  handle.diagnostics = diagnostics;
  await bootstrapRuntime({
    bootstrap: (async () => handle) as never,
    fetchImpl: async () => Response.json({ ok: true }),
    identityProvider: fakeIdentity(),
    onDiagnostics(value) {
      assert.equal(value, diagnostics);
      order.push("diagnostics-attached");
    }
  });
  assert.equal(order[0], "diagnostics-attached");
  assert.ok(order.includes("uptime.before-bootstrap"));
});

test("bootstrap drains early events sequentially and flushes bootstrap-succeeded before returning", async (t) => {
  resetRuntimeStateForTest();
  t.after(resetRuntimeStateForTest);
  recordEarlyRuntimeEvent("early-one");
  recordEarlyRuntimeEvent("early-two");
  const writes: string[] = [];
  let active = 0;
  let maxActive = 0;
  let flushes = 0;
  const handle = fakeRuntimeHandle({
    writes,
    async log(event) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      writes.push(event);
      active -= 1;
    },
    async flush() {
      flushes += 1;
      return { ok: true };
    }
  });

  await bootstrapRuntime({
    bootstrap: (async () => handle) as never,
    fetchImpl: async () => Response.json({ ok: true }),
    identityProvider: fakeIdentity()
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(writes, [
    "uptime.early-one",
    "uptime.early-two",
    "uptime.bootstrap-started",
    "uptime.bootstrap-succeeded"
  ]);
  assert.equal(flushes, 1);
});

test("runtime flush and stop wait for all previously queued application logs", async (t) => {
  resetRuntimeStateForTest();
  t.after(resetRuntimeStateForTest);
  const writes: string[] = [];
  let blockEvent: string | undefined;
  let release!: () => void;
  let blocked = Promise.resolve();
  let flushes = 0;
  let stops = 0;
  const handle = fakeRuntimeHandle({
    writes,
    async log(event) {
      if (event === blockEvent) await blocked;
      writes.push(event);
    },
    async flush() {
      flushes += 1;
      return { ok: true };
    },
    stop() { stops += 1; }
  });
  const runtime = await bootstrapRuntime({
    bootstrap: (async () => handle) as never,
    fetchImpl: async () => Response.json({ ok: true }),
    identityProvider: fakeIdentity()
  });
  assert.equal(flushes, 1);

  blockEvent = "uptime.queued-before-flush";
  blocked = new Promise<void>((resolve) => { release = resolve; });
  runtime.log("queued-before-flush");
  const flushing = runtime.flush();
  await Promise.resolve();
  assert.equal(flushes, 1);
  release();
  await flushing;
  assert.equal(flushes, 2);

  blockEvent = "uptime.queued-before-stop";
  blocked = new Promise<void>((resolve) => { release = resolve; });
  runtime.log("queued-before-stop");
  const stopping = runtime.stop();
  await Promise.resolve();
  assert.equal(stops, 0);
  release();
  await stopping;
  assert.equal(stops, 1);
  assert.ok(writes.includes("uptime.queued-before-stop"));
});

test("a logging handoff failure keeps the usable SDK runtime instead of selecting process env fallback", async (t) => {
  resetRuntimeStateForTest();
  t.after(resetRuntimeStateForTest);
  recordEarlyRuntimeEvent("handoff-will-fail");
  const handle = fakeRuntimeHandle({
    envValue: "sdk-value",
    async log() { throw new Error("background sink unavailable"); },
    async flush() { throw new Error("background flush unavailable"); }
  });
  const runtime = await bootstrapRuntime({
    bootstrap: (async () => handle) as never,
    fetchImpl: async () => Response.json({ ok: true }),
    identityProvider: fakeIdentity()
  });

  assert.equal(runtime.get("SOURCE"), "sdk-value");
});

function fakeIdentity() {
  return {
    async resolveIdentity() { return { jobId: "job", processorId: "processor" }; },
    async sign() { return "signature"; },
    async decryptGrantPayload() { return Buffer.from("plaintext"); }
  };
}

function fakeRuntimeHandle(overrides: {
  writes?: string[];
  envValue?: string;
  log?: (event: string) => Promise<void>;
  flush?: () => Promise<unknown>;
  stop?: () => void;
} = {}) {
  const writes = overrides.writes ?? [];
  return {
    env: { get: () => overrides.envValue },
    log: overrides.log ?? (async (event: string) => { writes.push(event); }),
    flush: overrides.flush ?? (async () => ({ ok: true })),
    stop: overrides.stop ?? (() => undefined)
  } as never;
}
