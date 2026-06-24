// Bundle the app to a single CJS artifact for the Acurast NodeJSWithBundle runtime.
// Mirrors liskov-diagnostic's esbuild build (minified, no sourcemap, node target).

import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/app.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  sourcemap: false,
  logLevel: "info"
});

console.log("built dist/app.cjs");
