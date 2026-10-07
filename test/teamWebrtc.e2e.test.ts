import { spawn } from "child_process";
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

/**
 * Real WebRTC: two peer hosts (the app's hidden-window bundle, in Electron)
 * connect over the local signaling server; events, a request, a stream; the
 * hidden window crashing; signaling and the connection dropping as in sleep;
 * forged descriptions refused. The scenario is test/e2e/teamWebrtcScenario.ts.
 *
 * Needs the Electron binary and a desktop session: skipped under CI (its
 * runners skip the Electron download). Run alone with
 *   npx vitest run test/teamWebrtc.e2e.test.ts
 */

const root = path.resolve(__dirname, "..");
const electronDir = path.join(root, "node_modules", "electron");
const electronBin = (() => {
  try {
    return path.join(electronDir, "dist", fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim());
  } catch {
    return null;
  }
})();

describe("team rooms over real WebRTC", () => {
  it.skipIf(!!process.env.CI || !electronBin || !fs.existsSync(electronBin))(
    "two peer hosts connect, exchange events, a request and a stream, survive crashes and drops, and refuse forged descriptions",
    async () => {
      const out = path.join(tempDir("e2e"), "app");
      // @ts-expect-error — a plain .mjs build script, no type declarations
      const { buildPeerHost } = await import("../scripts/build-peerhost.mjs");
      await buildPeerHost(out);
      await esbuild.build({
        entryPoints: [path.join(root, "test/e2e/teamWebrtcScenario.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: path.join(out, "scenario.js"),
        external: ["electron"],
        logLevel: "error",
      });
      // a clean environment: nothing of this shell's (or Claude's) leaks into Electron
      const env = { HOME: process.env.HOME!, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", USER: process.env.USER ?? "", LANG: "en_US.UTF-8" };
      const child = spawn(electronBin!, [path.join(out, "scenario.js"), "--use-mock-keychain", "--password-store=basic"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const steps: { step?: string; ok?: boolean; ms?: number; detail?: unknown; error?: string; done?: boolean }[] = [];
      const logs: string[] = [];
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.startsWith("E2E ")) steps.push(JSON.parse(line.slice(4)));
          else logs.push(line);
        }
      });
      child.stderr.on("data", (d) => logs.push(String(d).trimEnd()));
      try {
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve(null);
          }, 170_000);
          child.on("exit", (c) => {
            clearTimeout(timer);
            resolve(c);
          });
        });
        const failed = steps.filter((s) => s.ok === false || s.error);
        if (code !== 0 || failed.length) {
          console.log(`Electron exited ${code}\n${logs.slice(-80).join("\n")}`);
        }
        for (const s of steps.filter((s) => s.step)) console.log(`${s.ok ? "✓" : "✗"} ${s.step} (${s.ms} ms)${s.detail ? ` ${JSON.stringify(s.detail).slice(0, 400)}` : ""}${s.error ? `\n${s.error}` : ""}`);
        expect(failed).toEqual([]);
        expect(steps.map((s) => s.step).filter(Boolean)).toHaveLength(7);
        expect(code).toBe(0);
        const connect = steps.find((s) => s.step?.startsWith("connect"))!.detail as { ryanSees: { state: string }[] };
        expect(connect.ryanSees[0].state).toBe("direct");
        const pinning = steps.find((s) => s.step?.startsWith("pinning"))!.detail as { forged: { changed: number; resigned: number }; refusals: string[] };
        expect(pinning.forged.changed).toBeGreaterThan(0);
        expect(pinning.forged.resigned).toBeGreaterThan(0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
    180_000
  );
});
