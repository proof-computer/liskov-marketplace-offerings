import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(rootDir, "dist", "bundle.cjs");
const appPath = path.join(rootDir, "dist", "app.cjs");
assert.equal(
  (await readFile(appPath, "utf8")).includes("local bootstrap fallback"),
  false,
  "the production bundle must not contain the local ambient fallback"
);
const childSource = String.raw`
const fs = require("node:fs");
const jobId = "fixture-job-1";
const processorId = "fixture-processor-1";
const policyDigest = "1".repeat(64);
global._STD_ = {
  job: {
    getId: () => jobId,
    getEncryptionKeys: () => ({ p256: "02" + "ab".repeat(32) })
  },
  device: { getAddress: () => processorId },
  signers: {
    ed25519: { sign: () => "11".repeat(64) },
    secp256r1: { encrypt: () => "00", decrypt: () => "7b7d" }
  }
};
global.httpPOST = (url, body, _headers, onSuccess, onError) => {
  const request = JSON.parse(body);
  const pathname = new URL(url).pathname;
  const now = Date.now();
  let response;
  if (pathname === "/api/jobs/runtime-bootstrap") {
    response = {
      ok: true,
      domain: "proof.liskov.runtime-bootstrap-response.v1",
      applicationId: "uptime-prober",
      policyDigest,
      deploymentId: "fixture-deployment-1",
      jobId,
      processorId,
      slipwayUrl: "https://liskov.test",
      runtimeEnv: { enabled: true, url: "https://liskov.test" },
      secrets: { required: false, url: "https://secrets.liskov.test" }
    };
  } else if (pathname === "/api/jobs/secret-bootstrap") {
    response = {
      ok: true,
      domain: "proof.liskov.secret-bootstrap-response.v1",
      lockboxUrl: "https://secrets.liskov.test",
      applicationId: "uptime-prober",
      grantId: "fixture-grant-1",
      policyDigest,
      deploymentId: "fixture-deployment-1",
      jobId,
      processorId,
      requestedSecretIds: []
    };
  } else if (pathname === "/api/jobs/runtime-env") {
    response = {
      ok: true,
      domain: "proof.slipway.runtime-env-response.v1",
      requestId: "fixture-runtime-env-1",
      applicationId: "uptime-prober",
      policyDigest,
      jobId,
      deploymentId: "fixture-deployment-1",
      processorId,
      revision: "fixture-revision-1",
      issuedAtMs: now,
      expiresAtMs: now + 60000,
      refreshAfterMs: 30000,
      values: {}
    };
  } else if (pathname === "/api/jobs/runtime-diagnostics") {
    fs.writeSync(1, "FIXTURE_DIAGNOSTIC " + JSON.stringify(request) + "\n");
    response = { ok: true };
  } else if (pathname === "/api/jobs/secret-requests") {
    onError('HTTP Post failed with {"error":"not_expected"} (409)');
    return;
  } else {
    onError('HTTP Post failed with {"error":"unexpected_path"} (404)');
    return;
  }
  setImmediate(() => onSuccess(JSON.stringify(response), "fixture-cert"));
};
require(${JSON.stringify(bundlePath)});
`;

const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", childSource], {
    cwd: path.dirname(bundlePath),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PROOF_LISKOV_BOOTSTRAP_MODE: "signed",
      PROOF_LISKOV_BOOTSTRAP_RETRY_MAX_ATTEMPTS: "1",
      PROOF_LISKOV_BOOTSTRAP_RETRY_MAX_ELAPSED_MS: "1000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});

assert.equal(result.code, 1, `expected terminal exit; stderr=${result.stderr}\nstdout=${result.stdout}`);
const diagnostics = result.stdout
  .split("\n")
  .filter((line) => line.startsWith("FIXTURE_DIAGNOSTIC "))
  .map((line) => JSON.parse(line.slice("FIXTURE_DIAGNOSTIC ".length)) as Record<string, unknown>);
const fatal = diagnostics.find((event) => event.stage === "runtime.fatal.application_start");
assert.ok(fatal, `missing signed application-start fatal; stdout=${result.stdout}`);
assert.equal(fatal.domain, "proof.liskov.runtime-diagnostic.v2");
assert.equal(fatal.status, "failed");
assert.equal(fatal.code, "application_start_failed");
assert.equal(fatal.jobId, "fixture-job-1");
assert.equal(fatal.processorId, "fixture-processor-1");
assert.equal(typeof fatal.signature, "string");
assert.match(String(fatal.message), /invalid config/u);

console.log("bundled failure fixture observed signed fatal before exit 1");
