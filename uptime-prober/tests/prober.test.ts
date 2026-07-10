import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readConfig } from "../src/config.js";
import { formatCaption } from "../src/telegram.js";
import { resolveCdpWebSocketUrl } from "../src/cdp.js";
import { traceBootstrapFetch, traceBootstrapIdentity } from "../src/runtime.js";

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

test("marketplace policy template preserves diagnostic placement flags", () => {
  const entry = JSON.parse(readFileSync(new URL("../../proof/uptime-prober.json", import.meta.url), "utf8"));
  const acurast = entry.policyTemplate.acurast;

  assert.equal(acurast.verifiedOnly, false);
  assert.equal(acurast.managerId, "9470");
  assert.equal(acurast.assignmentStrategy, "single");
  assert.equal(acurast.processorSelection.mode, "open-market");
  assert.equal(acurast.processorSelection.requireScheduleClear, true);
  assert.equal(acurast.processorSelection.requireConsumerAccess, true);

  assert.equal(entry.policyTemplate.blackbox.enabled, true);
  assert.equal(entry.policyTemplate.blackbox.configSource, "operator.lockbox");
  assert.equal(entry.policyTemplate.blackbox.profileId, undefined);
  assert.ok(
    entry.policyTemplate.secrets.declarations.some(
      (decl: { secretId?: string; name?: string; bundleId?: string }) =>
        decl.secretId === "blackbox-log-config" &&
        decl.name === "BLACKBOX_LOG_CONFIG" &&
        decl.bundleId === "blackbox-log-config"
    )
  );
  assert.ok(
    entry.policyTemplate.environment.variables.some(
      (variable: { name?: string; source?: string; value?: string }) =>
        variable.name === "UPTIME_PROBER_WEBHOOK_URL" &&
        variable.source === "literal" &&
        variable.value?.startsWith("https://webhook.site/")
    )
  );
  assert.equal(entry.artifact.cid, "ipfs://QmS85JpnFbyP3bSzCJr6QNFzXJt1bUZQ5aohyDbnVpxart");
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
