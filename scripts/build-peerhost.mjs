// The hidden peer-host window's files (team rooms' WebRTC connections):
// peerhost.html, peerhost.js and peerhost-preload.js, built into `outDir`.
// Used by esbuild.mjs (into dist/) and by the WebRTC end-to-end test.
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildPeerHost(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, "src/peerhost/host.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: path.join(outDir, "peerhost.js"),
    logLevel: "error",
  });
  await esbuild.build({
    entryPoints: [path.join(root, "src/peerhost/preload.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(outDir, "peerhost-preload.js"),
    external: ["electron"],
    logLevel: "error",
  });
  fs.copyFileSync(path.join(root, "src/peerhost/index.html"), path.join(outDir, "peerhost.html"));
}
