import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The keys the UI preview's driver presses (scripts/ui-preview.mjs) end in the page: one nothing there consumes never
// reaches Chrome's window, where macOS answers it with the alert sound, on the speakers of whoever runs the tests.
// Real headless Chrome, so local only (CI runners have no desktop); the script passes a mock keychain. What Chrome
// asked to play is read from the unified log, where systemsoundserverd notes each request with the asking pid.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && process.platform === "darwin" && fs.existsSync(chrome);

/** Typed keys the page doesn't consume with nothing focused: each one played the alert sound when it reached Chrome. */
const UNCONSUMED = ["a", "s", "d", "f", "Enter", "q", "w", "Enter"];

/**
 * A `log stream` of system-sound requests, started and proven live before anything is pressed: a marker this test
 * logs has to come through it, or the test fails saying so, since a log that can't be read would show no sounds.
 */
async function soundLog() {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { stopChild } = await import("../scripts/ui-preview.mjs");
  const token = `mb-sound-guard-${process.pid}-${Date.now()}`;
  const predicate = `(process == "systemsoundserverd" AND eventMessage CONTAINS "Incoming Request") OR (process == "logger" AND eventMessage CONTAINS "${token}")`;
  const stream = spawn("/usr/bin/log", ["stream", "--style", "compact", "--predicate", predicate], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let ended: string | null = null;
  stream.stdout.on("data", (d) => (out += d));
  stream.stderr.on("data", (d) => (out += d));
  stream.on("error", (err) => (ended = `couldn't start: ${err.message}`));
  stream.on("exit", (code, signal) => (ended ??= `exited ${code ?? signal}`));
  const lines = () => out.split("\n");
  const until = async (what: string, seen: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !seen(); await new Promise((r) => setTimeout(r, 100))) {
      if (ended || Date.now() > end) throw new Error(`can't read the unified log: log stream ${ended ?? `ran ${ms / 1000} s`} without ${what}: ${out.trim().slice(-400) || "it printed nothing"}`);
    }
  };
  /** Logs `name` and waits for it to come through: everything logged before it has been read. */
  const mark = async (name: string) => {
    execFileSync("/usr/bin/logger", [`${token} ${name}`]);
    await until(`this test's marker "${name}"`, () => lines().some((l) => l.includes("logger[") && l.includes(`${token} ${name}`)));
  };
  try {
    await until("starting to filter", () => out.includes("Filtering the log data"));
    await mark("start");
  } catch (err) {
    await stopChild(stream);
    throw err;
  }
  return {
    mark,
    /** The sound requests process `pid` made, as the log has them. */
    requestsFrom: (pid: number) => lines().filter((l) => l.includes("Incoming Request") && l.includes(`inClientPID ${pid}(`)),
    stop: () => stopChild(stream),
  };
}

describe("keys pressed through DevTools", () => {
  it("never carry a native key code, which hands a key the page didn't consume to the OS window (the UI preview's driver, the app tests')", () => {
    const root = path.resolve(__dirname, "..");
    const self = path.resolve(__filename);
    const files = [path.join(root, "scripts/ui-preview.mjs"), ...fs.readdirSync(path.join(root, "test"), { recursive: true, encoding: "utf8" }).map((f) => path.join(root, "test", f))];
    const carrying = files.filter((f) => f !== self && /\.(ts|mjs|cjs|js)$/.test(f) && /nativeVirtualKeyCode\s*:/.test(fs.readFileSync(f, "utf8")));
    expect(carrying.map((f) => path.relative(root, f))).toEqual([]);
    // the driver still presses keys: a check that found no key presses at all would pass on nothing
    expect(fs.readFileSync(files[0], "utf8")).toContain('"Input.dispatchKeyEvent"');
  });
});

describe.skipIf(!local)("keys the preview's driver presses", () => {
  it("that nothing on the page consumes reach the page, and make the headless Chrome play no system sound", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageResult } = await import("../scripts/ui-preview.mjs");
    const read = `(() => {
      const w = window;
      if (!w.__sgRun) {
        if (!document.querySelector(".app .topbar")) return null;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const seen = [];
        window.addEventListener("keydown", (e) => seen.push([e.key, e.defaultPrevented]));
        w.__sgRun = (async () => {
          document.activeElement?.blur?.();
          const keys = ${JSON.stringify(UNCONSUMED)}.map((key) => ({ key }));
          (w.__mbKeys ||= []).push(...keys);
          for (let i = 0; i < 400 && (w.__mbKeysDone || 0) < keys.length; i++) await sleep(25);
          // a sound is asked for as the key comes back unconsumed: give the last one time to
          await sleep(500);
          return { seen, focus: document.activeElement === document.body ? "body" : document.activeElement?.tagName };
        })().then((v) => (w.__sgOut = JSON.stringify(v)), (e) => (w.__sgOut = JSON.stringify({ failed: String(e && e.stack || e) })));
      }
      return w.__sgOut ?? null;
    })()`;
    const log = await soundLog();
    let pid = 0;
    try {
      const out = JSON.parse(await pageResult({ query: "motion=off", outDir: path.join(tempDir("soundGuard"), "out"), read, onChrome: (p: number) => (pid = p) }));
      expect(out.failed).toBeUndefined();
      // every key reached the page, none consumed, with nothing focused: the kind that played the alert sound
      expect(out).toEqual({ seen: UNCONSUMED.map((k) => [k, false]), focus: "body" });
      expect(pid).toBeGreaterThan(0);
      await log.mark("end");
      expect(log.requestsFrom(pid), `headless Chrome (pid ${pid}) asked macOS for system sounds`).toEqual([]);
    } finally {
      await log.stop();
    }
  }, 120_000);
});
