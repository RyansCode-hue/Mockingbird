import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { loginShell, userShell, userShellWithInput, which, whichSync, quote } from "../src/main/shell";

// an interactive rc that talks, as nvm and shell themes do; `hang` makes it block
// on a child that would outlive the shell if only the shell were killed
const home = os.homedir();
const rcSurvived = path.join(home, "rc-survived");
fs.writeFileSync(
  path.join(home, ".zshrc"),
  `echo "rc banner"\necho "rc warning" >&2\nif [[ -f "$HOME/hang" ]]; then sh -c 'sleep 1.5; touch "$HOME/rc-survived"'; fi\n`
);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const marker = (name: string) => path.join(home, `${name}-${Date.now()}`);

describe("userShell", () => {
  it("returns the command's output and exit code, fenced from rc-file noise", async () => {
    expect(await userShell("printf 'line one\\nline two'; exit 3")).toEqual({ code: 3, out: "line one\nline two" });
  });
  it("succeeds with empty output", async () => {
    expect(await userShell("true")).toEqual({ code: 0, out: "" });
  });
});

describe("stopping a command", () => {
  it("on a timeout, stops it and everything it started", async () => {
    const done = marker("timeout");
    const t0 = Date.now();
    const r = await userShell(`sh -c 'sleep 1.5; touch ${quote(done)}'`, 300);
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/timed out/);
    await pause(1800);
    expect(fs.existsSync(done)).toBe(false);
  });

  it("when aborted, stops it and everything it started", async () => {
    const done = marker("abort");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const r = await userShellWithInput(`sh -c 'sleep 1.5; touch ${quote(done)}'`, "", { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(r.out).toMatch(/stopped/);
    await pause(1800);
    expect(fs.existsSync(done)).toBe(false);
  });

  it("kills what ignores SIGTERM once the grace period is up", async () => {
    const done = marker("stubborn");
    const r = await userShell(`sh -c 'trap "" TERM; sleep 3; touch ${quote(done)}'`, 300);
    expect(r.out).toMatch(/timed out/);
    await pause(3500);
    expect(fs.existsSync(done)).toBe(false);
  });

  it("leaves a command that finishes in time alone", async () => {
    const done = marker("quick");
    expect((await userShell(`touch ${quote(done)}`, 5000)).code).toBe(0);
    expect(fs.existsSync(done)).toBe(true);
  });
});

describe("loginShell", () => {
  it("streams everything the shell prints, without the fence, and returns the command's own output", async () => {
    const chunks: string[] = [];
    const r = await loginShell("printf 'v22.1.0'", { onOut: (s) => chunks.push(s) });
    expect(r).toMatchObject({ code: 0, out: "v22.1.0" });
    const streamed = chunks.join("");
    expect(streamed).toContain("rc banner");
    expect(streamed).toContain("v22.1.0");
    expect(streamed).not.toContain("MOCKINGBIRD_OUT");
  });

  it("pipes input to the command", async () => {
    expect((await loginShell("tr a-z A-Z", { input: "piped" })).out).toBe("PIPED");
  });
});

describe("which", () => {
  it("finds commands without blocking, and returns null for missing ones", async () => {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 1);
    const ls = await which("ls");
    clearInterval(tick);
    expect(ls).toMatch(/^\/.*\/ls$/);
    expect(ticks).toBeGreaterThan(0);
    expect(await which("definitely-not-a-command-mb")).toBeNull();
  });
});

describe("whichSync", () => {
  it("finds commands on the shell's PATH and returns null for missing ones", () => {
    expect(whichSync("ls")).toMatch(/^\/.*\/ls$/);
    expect(whichSync("definitely-not-a-command-mb")).toBeNull();
  });

  it("gives up at its timeout, and what the rc files started goes with the shell", async () => {
    fs.writeFileSync(path.join(home, "hang"), "");
    try {
      const t0 = Date.now();
      expect(whichSync("ls", 300)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1200);
    } finally {
      fs.rmSync(path.join(home, "hang"));
    }
    await pause(1800);
    expect(fs.existsSync(rcSurvived)).toBe(false);
  });
});

describe("quote", () => {
  it("survives spaces and single quotes", async () => {
    const tricky = "it's a path with spaces";
    expect((await userShell(`printf %s ${quote(tricky)}`)).out).toBe(tricky);
  });
});
