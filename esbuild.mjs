import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

mkdirSync("dist", { recursive: true });

// Main process
await esbuild.build({
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/main.js",
  external: ["electron", "node-pty"],
});

// Preload
await esbuild.build({
  entryPoints: ["src/main/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/preload.js",
  external: ["electron"],
});

// Renderer
await esbuild.build({
  entryPoints: ["src/renderer/main.tsx"],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: "dist/renderer.js",
  loader: { ".css": "css" },
});

writeFileSync("dist/index.html", readFileSync("src/renderer/index.html"));
console.log("build ok");
