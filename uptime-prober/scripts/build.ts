// Bundle the app plus a canary-style stage0 wrapper for the Acurast NodeJSWithBundle runtime.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const stage0Outfile = path.join(distDir, "bundle.cjs");
const appOutfile = path.join(distDir, "app.cjs");

await mkdir(distDir, { recursive: true });
await build({
  entryPoints: [path.join(rootDir, "src", "index.ts")],
  outfile: appOutfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none"
});

await build({
  entryPoints: [path.join(rootDir, "src", "stage0.ts")],
  outfile: stage0Outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none"
});

console.log(`built ${stage0Outfile}`);
console.log(`built ${appOutfile}`);
