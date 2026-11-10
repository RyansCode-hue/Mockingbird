import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Messaging, bindMcpLaunch, mcpLaunch, retireMcpLaunch, type McpLaunch, type ToolsLost } from "../src/main/messaging";
import { MAX_RUNNING, MAX_WAITING, PEER_CHECK_MS, systemExec, systemPeerCheck, TOOL_ENV, type Exec, type LaunchRoot, type PeerCheck } from "../src/main/peerCheck";
import type { SessionInfo } from "../src/shared/types";
import { askRaw, startServer } from "./mcpClient";

/**
 * Who's calling, by process (W20): a live token answers only a process that is its launch's own or descends from it.
 * With real processes standing in for panes (each a `node` the test starts, the real mcp.js run under it), and the
 * system's ps and lsof; then each way the check can fail, with their output stood in for.
 */

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, repoPath: `/code/${id}`, branch: "b", taskGroup: "5038", status: "idle", agent: "claude", cwd: `/w/${id}`, kind: "work", createdAt: 1, ...over }) as SessionInfo;
const live = [session("front", { ticketTitle: "Filter orgs" }), session("back")];
const mainLog: string[] = [];
const told: ToolsLost[] = [];
const sock = mcpLaunch("unused").env.MOCKINGBIRD_SOCK;
/** What the relay checks callers with: the system's, unless a test puts another in. */
let peers: PeerCheck | undefined;
const started: ChildProcess[] = [];

beforeAll(async () => {
  const relay = new Messaging({ list: () => live, deliverAgentMessage: () => "delivered" } as any, () => true, () => {}, () => {}, {
    log: (c, e) => void mainLog.push(`${c}: ${e instanceof Error ? e.message : String(e)}`),
    onToolsLost: (e) => void told.push(e),
  });
  // the hooks are read at each call, so a test can swap the check in and out
  Object.defineProperty((relay as any).hooks, "peers", { get: () => peers });
  relay.start();
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
});
afterAll(() => {
  for (const p of started) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  fs.rmSync(sock, { force: true });
});

/** Runs what follows it in argv as its own child, stdio passed through: a pane whose agent starts the server. */
const PANE = `const c = require("child_process").spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" }); c.on("exit", (code) => process.exit(code ?? 1)); process.on("SIGTERM", () => c.kill());`;
/** `launch`'s server, started under `depth` stand-in panes: what's bound is the outermost one's pid. */
function underPane(launch: McpLaunch, depth = 1, env: Record<string, string> = {}) {
  let command = launch.command;
  let args = launch.args;
  for (let i = 0; i < depth; i++) [command, args] = [process.execPath, ["-e", PANE, command, ...args]];
  const server = startServer({ command, args, env: { ...launch.env, ...env } });
  started.push(server.p);
  return server;
}
/** A process that only stays alive, as a pane with nothing running yet. */
function idlePane(): ChildProcess {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  started.push(p);
  return p;
}
const youOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text).you.id;
const OUTSIDE = "Mockingbird refused this call: the process calling isn't one of its workspace's own.";
/** What a caller whose check couldn't run is told next. */
const RETRY = "This is usually brief: try the call again in a moment. If it keeps failing, tell your user; Mockingbird has logged it for them.";

describe("a launch's token, by the process calling", () => {
  it("answers a server under its launch's own process: a child, and a grandchild as a sub-agent's or a reconnect's would be", async () => {
    const launch = mcpLaunch("front");
    const child = underPane(launch, 1);
    bindMcpLaunch(launch, child.p.pid);
    try {
      expect(youOf(await child.call("list_sessions"))).toBe("front");
      // a second launch's grandchild: bound to its own outer pane
      const second = mcpLaunch("front");
      const outer = underPane(second, 2);
      bindMcpLaunch(second, outer.p.pid);
      expect(youOf(await outer.call("list_sessions"))).toBe("front");
      await outer.stop();
      retireMcpLaunch(second);
    } finally {
      await child.stop();
      retireMcpLaunch(launch);
    }
  });

  it("refuses its live token from any other process: another pane's server, a plain shell's, this one's; logged, and the user isn't told", async () => {
    const pane = idlePane();
    const launch = mcpLaunch("front");
    bindMcpLaunch(launch, pane.pid);
    const before = { log: mainLog.length, told: told.length };
    // another pane's agent with this launch's token file: under a process bound to a different launch
    const other = mcpLaunch("back");
    const theirs = underPane({ ...other, env: { ...other.env, MOCKINGBIRD_TOKEN_FILE: launch.env.MOCKINGBIRD_TOKEN_FILE } }, 1);
    bindMcpLaunch(other, theirs.p.pid);
    // a plain shell's, started outside any pane
    const shell = startServer({ command: "/bin/sh", args: ["-c", `exec "$0" "$@"`, launch.command, ...launch.args], env: launch.env });
    started.push(shell.p);
    try {
      for (const s of [theirs, shell]) {
        const r = await s.call("send_message", { to: "back", message: "as front" });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toBe(
          `${OUTSIDE} Only the workspace's agent, and what it starts, can use its tools. A Claude teammate in split-pane (tmux) mode runs under tmux, outside the pane, so it gets none of them: Mockingbird's tools work for in-process teammates. Mockingbird has logged this for the user.`
        );
      }
      // this process is the panes' parent, not one of theirs
      const token = fs.readFileSync(launch.env.MOCKINGBIRD_TOKEN_FILE, "utf8");
      expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", token }))).error).toMatch(/^Mockingbird refused this call: the process calling isn't one of its workspace's own/);
    } finally {
      await theirs.stop();
      await shell.stop();
      retireMcpLaunch(other);
      retireMcpLaunch(launch);
      pane.kill();
    }
    expect(mainLog.slice(before.log)).toEqual([
      expect.stringMatching(/^messaging: A call with the token of "Filter orgs" \(front\) was refused: the process calling isn't one of its workspace's own \(asked for "send_message"\)$/),
    ]);
    expect(told.length).toBe(before.told);
  });

  it("refuses once its launch's process has ended, before the launch is retired", async () => {
    const pane = idlePane();
    const launch = mcpLaunch("front");
    bindMcpLaunch(launch, pane.pid);
    const server = underPane(launch, 1);
    try {
      pane.kill("SIGKILL");
      await new Promise((r) => pane.once("exit", r));
      const r = await server.call("list_sessions");
      expect(r.content[0].text).toBe(
        "Mockingbird refused this call: its workspace's own process has ended. That launch is over, so its tools have stopped. If the workspace is still open, your user can restart it in Mockingbird to get them back."
      );
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
    }
  });

  it("refuses a token whose launch has no process yet, as a test that mints one and never starts it", async () => {
    const launch = mcpLaunch("front");
    const token = fs.readFileSync(launch.env.MOCKINGBIRD_TOKEN_FILE, "utf8");
    try {
      expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", token }))).error).toBe(
        `Mockingbird refused this call: Mockingbird couldn't check which process is calling (its launch has no process to check against). ${RETRY}`
      );
      bindMcpLaunch(launch, 1); // launchd: everything descends from it, so it's never a launch's root
      expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", token }))).error).toMatch(/its launch has no process to check against/);
    } finally {
      retireMcpLaunch(launch);
    }
  });

  it("refuses when the check can't be made, saying so in the log and once to the user, and never answers on the token alone; says when it works again", async () => {
    const launch = mcpLaunch("front");
    const server = underPane(launch, 1);
    bindMcpLaunch(launch, server.p.pid);
    const before = { log: mainLog.length, told: told.length };
    const failing: PeerCheck = { root: (pid) => ({ pid, started: async () => ({ at: "x" }) }), check: async () => ({ ok: false, failed: "lsof took too long" }) };
    peers = failing;
    try {
      for (let i = 0; i < 3; i++) {
        const r = await server.call("list_sessions");
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toBe(`Mockingbird refused this call: Mockingbird couldn't check which process is calling (lsof took too long). ${RETRY}`);
      }
    } finally {
      peers = undefined;
    }
    try {
      expect(mainLog.slice(before.log)).toEqual([expect.stringMatching(/^messaging: A call with the token of "Filter orgs" \(front\) was refused: Mockingbird couldn't check which process is calling \(lsof took too long\)/)]);
      expect(told.slice(before.told)).toEqual([{ session: expect.objectContaining({ id: "front" }), why: "Mockingbird couldn't check which process is calling (lsof took too long)" }]);
      // and with the system's check back, the same server answers, the log says so, and a later failure is told again
      expect(youOf(await server.call("list_sessions"))).toBe("front");
      expect(mainLog.at(-1)).toBe("messaging: Mockingbird can check who's calling with the token of front again, so its tools answer again");
      peers = failing;
      await server.call("list_sessions");
      expect(told.slice(before.told)).toHaveLength(2);
    } finally {
      peers = undefined;
      await server.stop();
      retireMcpLaunch(launch);
    }
  });

  it("refuses when the check itself throws, logging what it threw and telling the user once", async () => {
    const launch = mcpLaunch("back");
    const server = underPane(launch, 1);
    bindMcpLaunch(launch, server.p.pid);
    const before = { log: mainLog.length, told: told.length };
    peers = { root: (pid) => ({ pid, started: async () => ({ at: "x" }) }), check: async () => Promise.reject(new Error("lsof's output broke the parser")) };
    try {
      for (let i = 0; i < 2; i++) expect((await server.call("list_sessions")).content[0].text).toMatch(/^Mockingbird refused this call: Mockingbird couldn't check which process is calling \(the check itself failed\)\./);
    } finally {
      peers = undefined;
      await server.stop();
      retireMcpLaunch(launch);
    }
    expect(mainLog.slice(before.log)).toEqual([
      "messaging: checking which process is calling: lsof's output broke the parser",
      expect.stringMatching(/^messaging: A call with the token of "back" \(back\) was refused: Mockingbird couldn't check which process is calling \(the check itself failed\)/),
      "messaging: checking which process is calling: lsof's output broke the parser",
    ]);
    expect(told.slice(before.told)).toEqual([{ session: expect.objectContaining({ id: "back" }), why: "Mockingbird couldn't check which process is calling (the check itself failed)" }]);
  });

  it("answers a launch that ended while its caller was checked as ended, whatever the check said", async () => {
    const launch = mcpLaunch("front");
    const server = underPane(launch, 1);
    bindMcpLaunch(launch, server.p.pid);
    peers = {
      root: (pid) => ({ pid, started: async () => ({ at: "x" }) }),
      check: async () => {
        retireMcpLaunch(launch);
        return { ok: true, pid: server.p.pid! };
      },
    };
    try {
      expect((await server.call("list_sessions")).content[0].text).toMatch(/: its token is from a launch that has ended/);
    } finally {
      peers = undefined;
      await server.stop();
      retireMcpLaunch(launch);
    }
  });

  it("costs one ps and one lsof a call: measured here", async () => {
    const launch = mcpLaunch("front");
    const server = underPane(launch, 1);
    bindMcpLaunch(launch, server.p.pid);
    const check = systemPeerCheck();
    const times: number[] = [];
    let ms = 0;
    peers = {
      root: check.root,
      check: async (fd, root) => {
        const t = performance.now();
        const v = await check.check(fd, root);
        ms = performance.now() - t;
        return v;
      },
    };
    let allAtOnce = 0;
    try {
      for (let i = 0; i < 10; i++) {
        expect(youOf(await server.call("list_sessions"))).toBe("front");
        times.push(ms);
      }
      // and ten at once, as an agent's parallel tool calls come: each its own ps and lsof, all running together
      const t = performance.now();
      const answers = await Promise.all(Array.from({ length: 10 }, () => server.call("list_sessions")));
      allAtOnce = performance.now() - t;
      expect(answers.map(youOf)).toEqual(Array(10).fill("front"));
    } finally {
      peers = undefined;
      await server.stop();
      retireMcpLaunch(launch);
    }
    times.sort((a, b) => a - b);
    console.info(`[W20] caller check over 10 calls: median ${times[5].toFixed(0)} ms, slowest ${times[9].toFixed(0)} ms; 10 at once all answered in ${allAtOnce.toFixed(0)} ms`);
    expect(times[9]).toBeLessThan(PEER_CHECK_MS);
    expect(allAtOnce).toBeLessThan(PEER_CHECK_MS);
  });
});

describe("the system's check, with what ps and lsof answer stood in for", () => {
  const SELF = 500;
  const ROOT = 600;
  const START = "Mon Nov  9 16:58:01 2026";
  /** When the stand-in roots are bound: after every start in PS_OK. */
  const BOUND = Date.UTC(2026, 10, 9, 17, 0, 0);
  const PS_OK = [`  ${SELF}     1 Mon Nov  9 09:00:00 2026`, `  ${ROOT}   ${SELF} ${START}`, `  601   ${ROOT} Mon Nov  9 16:58:02 2026`, `  602   601 Mon Nov  9 16:58:03 2026`, `  700   ${SELF} Mon Nov  9 16:59:00 2026`].join("\n");
  const lsofWith = (peer: number, fd = 13) => [`p${SELF}`, `f${fd}`, "d0xabc0", "n/Users/x/.mockingbird/mb.sock", `p${peer}`, "f12", "d0xdef0", "n->0xabc0", ""].join("\n");
  type Answer = string | Error;
  /** What each tool answers: the root's start (a list: one per read, the last repeated), the table, lsof, and the line back to the root (by default, the table's rows for the pids asked). */
  type Answers = { start?: Answer | Answer[]; ps?: Answer; lsof?: Answer; confirm?: Answer };
  type Seen = { file: string; args: string[]; ms: number; env: Readonly<Record<string, string>> }[];
  const rowsOf = (table: string, pids: string) => table.split("\n").filter((l) => pids.split(",").includes(l.trim().split(/\s+/)[0])).join("\n");
  const execOf = (answers: Answers, seen: Seen = []): Exec => {
    let starts = 0;
    return async (file, args, o) => {
      seen.push({ file, args, ms: o.timeoutMs, env: o.env });
      const start = !Array.isArray(answers.start) ? answers.start : args[1] === "lstart=" ? answers.start[Math.min(starts++, answers.start.length - 1)] : undefined;
      const a = file.endsWith("lsof")
        ? answers.lsof
        : args.includes("-A")
          ? answers.ps
          : args[1] === "pid=,ppid=,lstart="
            ? (answers.confirm ?? (typeof answers.ps === "string" ? rowsOf(answers.ps, args[3]) : ""))
            : (start ?? START);
      if (a instanceof Error) throw a;
      return a ?? "";
    };
  };
  const err = (o: Record<string, unknown>) => Object.assign(new Error("failed"), o);
  const checkerWith = (answers: Answers, seen?: Seen) => systemPeerCheck({ exec: execOf(answers, seen), self: SELF, now: () => BOUND });
  const checkWith = (answers: Answers, seen?: Seen) => {
    const c = checkerWith(answers, seen);
    return c.check(13, c.root(ROOT));
  };
  const kindOf = (s: Seen[number]) => (s.file.endsWith("lsof") ? "lsof" : s.args.includes("-A") ? "table" : s.args[1] === "lstart=" ? "start" : "confirm");
  const reads = (seen: Seen, what: "start" | "table" | "lsof" | "confirm") => seen.filter((s) => kindOf(s) === what);

  it("finds the caller in the root's tree, by the address its socket names, then sees its line back to the root unchanged, with fixed tool paths and nothing else in their environment", async () => {
    const seen: Seen = [];
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602) }, seen)).toEqual({ ok: true, pid: 602 });
    expect(seen.map((s) => s.file)).toEqual(["/bin/ps", "/bin/ps", "/usr/sbin/lsof", "/bin/ps"]);
    // only main and the root's tree are listed: never anything outside it
    expect(seen[2].args).toEqual(["-a", "-U", "-F", "pfdn", "-p", `${SELF},${ROOT},601,602`]);
    expect(seen[3].args).toEqual(["-o", "pid=,ppid=,lstart=", "-p", `602,601,${ROOT}`]);
    expect(seen.every((s) => s.ms > 0 && s.ms <= PEER_CHECK_MS)).toBe(true);
    expect(seen.every((s) => s.env === TOOL_ENV)).toBe(true);
    expect(TOOL_ENV).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" });
  });
  it("runs the tools with exactly that environment, none of Mockingbird's own", async () => {
    process.env.MB_PEER_CHECK_SENTINEL = "leaked";
    try {
      const env = Object.fromEntries((await systemExec("/usr/bin/env", [], { timeoutMs: PEER_CHECK_MS, env: TOOL_ENV })).trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
      expect(env).toEqual(TOOL_ENV);
    } finally {
      delete process.env.MB_PEER_CHECK_SENTINEL;
    }
  });
  it("reads start times in UTC, so the Mac moving to another zone doesn't make a launch look ended", async () => {
    // a ps that writes each start in the zone its environment names, or else in the Mac's
    let macZoneHours = -6;
    const starts: Record<number, number> = { [SELF]: Date.UTC(2026, 10, 9, 9), [ROOT]: Date.UTC(2026, 10, 9, 16, 58, 1), 601: Date.UTC(2026, 10, 9, 16, 58, 2), 602: Date.UTC(2026, 10, 9, 16, 58, 3) };
    const parents: Record<number, number> = { [SELF]: 1, [ROOT]: SELF, 601: ROOT, 602: 601 };
    const lstart = (ms: number, zoneHours: number) => {
      const d = new Date(ms + zoneHours * 3_600_000);
      const [day, mon, date, time, year] = [d.toUTCString().slice(0, 3), d.toUTCString().slice(8, 11), d.getUTCDate(), d.toISOString().slice(11, 19), d.getUTCFullYear()];
      return `${day} ${mon} ${String(date).padStart(2)} ${time} ${year}`;
    };
    const exec: Exec = async (file, args, o) => {
      const zone = o.env.TZ === "UTC" ? 0 : macZoneHours;
      const row = (pid: number) => `${pid} ${parents[pid]} ${lstart(starts[pid], zone)}`;
      if (file.endsWith("lsof")) return lsofWith(602);
      if (args.includes("-A")) return Object.keys(starts).map((p) => row(Number(p))).join("\n");
      if (args[1] === "lstart=") return lstart(starts[Number(args[3])], zone);
      return args[3].split(",").map((p) => row(Number(p))).join("\n");
    };
    const c = systemPeerCheck({ exec, self: SELF, now: () => BOUND });
    const root = c.root(ROOT);
    expect(await c.check(13, root)).toEqual({ ok: true, pid: 602 });
    macZoneHours = 9;
    expect(await c.check(13, root)).toEqual({ ok: true, pid: 602 });
  });
  it("reads its own end only from Mockingbird's own process: a caller's descriptor of the same number isn't it", async () => {
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602).replace("f12", "f13") })).toEqual({ ok: true, pid: 602 });
  });
  it("takes an address written without its leading zeros as the same one", async () => {
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(601).replace("d0xabc0", "d0x0000abc0") })).toEqual({ ok: true, pid: 601 });
  });
  it("calls a caller outside the tree outside, whatever else lsof lists", async () => {
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(700) })).toEqual({ ok: false, outside: true });
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602).replace("n->0xabc0", "n->0xabc1") })).toEqual({ ok: false, outside: true });
    // a socket bound at a path that reads like a peer's isn't one
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602).replace("n->0xabc0", "n->0xabc0/x") })).toEqual({ ok: false, outside: true });
  });
  it("calls a root that has ended, or whose pid has gone to a process started later, gone", async () => {
    expect(await checkWith({ ps: PS_OK.replace(`  ${ROOT}   ${SELF} ${START}\n`, ""), lsof: lsofWith(602) })).toEqual({ ok: false, gone: true });
    expect(await checkWith({ ps: PS_OK.replace(START, "Mon Nov  9 17:30:00 2026"), lsof: lsofWith(602) })).toEqual({ ok: false, gone: true });
  });
  it("refuses a caller whose pid changed hands while it was looked at: its line back to the root has to be the table's", async () => {
    const changed = "a process in its workspace changed while it was being checked";
    // the caller's pid now another process's, started since
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602), confirm: rowsOf(PS_OK, "601,600") + "\n  602   601 Mon Nov  9 16:59:30 2026" })).toEqual({ ok: false, failed: changed });
    // its parent's pid another's, under another parent
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602), confirm: rowsOf(PS_OK, "602,600") + "\n  601   1 Mon Nov  9 16:58:02 2026" })).toEqual({ ok: false, failed: changed });
    // ended: ps lists the rest and exits 1
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602), confirm: err({ code: 1, stdout: rowsOf(PS_OK, "601,600") }) })).toEqual({ ok: false, failed: changed });
    // the root itself gone by then
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602), confirm: err({ code: 1, stdout: rowsOf(PS_OK, "602,601") }) })).toEqual({ ok: false, gone: true });
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602), confirm: err({ code: 2 }) })).toEqual({ ok: false, failed: "ps failed (exit 2)" });
    expect(await checkWith({ ps: PS_OK, lsof: lsofWith(602), confirm: "junk" })).toEqual({ ok: false, failed: "ps gave a line it couldn't read" });
  });
  it.each([
    ["ps isn't there", { ps: err({ code: "ENOENT" }) }, "ps isn't there"],
    ["ps is too slow", { ps: err({ killed: true, signal: "SIGTERM" }) }, "ps took too long"],
    ["ps fails", { ps: err({ code: 2 }) }, "ps failed (exit 2)"],
    ["ps answers junk", { ps: PS_OK + "\nnot a process line" }, "ps gave a line it couldn't read"],
    ["ps leaves Mockingbird out", { ps: PS_OK.split("\n").slice(1).join("\n") }, "ps didn't list Mockingbird itself"],
    ["lsof isn't there", { ps: PS_OK, lsof: err({ code: "ENOENT" }) }, "lsof isn't there"],
    ["lsof is too slow", { ps: PS_OK, lsof: err({ killed: true, signal: "SIGTERM", code: 1, stdout: lsofWith(602) }) }, "lsof took too long"],
    ["lsof fails", { ps: PS_OK, lsof: err({ code: 2, stdout: lsofWith(602) }) }, "lsof failed (exit 2)"],
    ["lsof leaves out Mockingbird's end", { ps: PS_OK, lsof: lsofWith(602, 14) }, "lsof didn't list Mockingbird's end of the connection"],
    ["lsof answers junk", { ps: PS_OK, lsof: "garbage\n->0xabc0\n" }, "lsof didn't list Mockingbird's end of the connection"],
    ["the root's start can't be read", { start: err({ code: 2 }), ps: PS_OK, lsof: lsofWith(602) }, "ps couldn't say when its workspace's process started: ps failed (exit 2)"],
    ["the root's start is empty", { start: " \n", ps: PS_OK, lsof: lsofWith(602) }, "ps gave no start for its workspace's process"],
    ["the root's start isn't a time", { start: "yesterday", ps: PS_OK, lsof: lsofWith(602) }, "ps gave a start for its workspace's process it couldn't read"],
  ])("refuses when %s, saying so", async (_what, answers, why) => {
    expect(await checkWith(answers as Answers)).toEqual({ ok: false, failed: why });
  });
  it("reads a root's start again while it isn't known: a read that failed, or found nothing running, is never final", async () => {
    const seen: Seen = [];
    const c = checkerWith({ start: [err({ code: 1, stdout: "" }), err({ killed: true, signal: "SIGTERM" }), START], ps: PS_OK, lsof: lsofWith(602) }, seen);
    const root: LaunchRoot = c.root(ROOT);
    expect(await c.check(13, root)).toEqual({ ok: false, gone: true });
    expect(await c.check(13, root)).toEqual({ ok: false, failed: "ps couldn't say when its workspace's process started: ps took too long" });
    expect(await c.check(13, root)).toEqual({ ok: true, pid: 602 });
    expect(await c.check(13, root)).toEqual({ ok: true, pid: 602 });
    // read at the bind and after each refusal; kept once known
    expect(reads(seen, "start")).toHaveLength(3);
  });
  it("calls a root whose start is from after it was bound gone for good: that pid is another process's", async () => {
    const seen: Seen = [];
    const later = "Mon Nov  9 17:00:05 2026";
    const c = checkerWith({ start: later, ps: PS_OK.replace(START, later), lsof: lsofWith(602) }, seen);
    const root = c.root(ROOT);
    expect(await c.check(13, root)).toEqual({ ok: false, gone: true });
    expect(await c.check(13, root)).toEqual({ ok: false, gone: true });
    expect(reads(seen, "start")).toHaveLength(1);
    expect(reads(seen, "table")).toHaveLength(0);
  });
  it("takes lsof's exit 1 (a pid with no socket to list) when it still lists Mockingbird's end", async () => {
    expect(await checkWith({ ps: PS_OK, lsof: err({ code: 1, stdout: lsofWith(602) }) })).toEqual({ ok: true, pid: 602 });
  });
  it("refuses without asking anything when there's no descriptor, or the root is no process of a launch's", async () => {
    const seen: Seen = [];
    const c = checkerWith({ ps: PS_OK, lsof: lsofWith(602) }, seen);
    expect(await c.check(undefined, c.root(ROOT))).toEqual({ ok: false, failed: "the connection has no descriptor to look up" });
    expect(await c.check(-1, c.root(ROOT))).toEqual({ ok: false, failed: "the connection has no descriptor to look up" });
    expect(await c.check(13, c.root(1))).toEqual({ ok: false, failed: "its launch has no process to check against" });
    expect([...reads(seen, "table"), ...reads(seen, "lsof")]).toEqual([]);
  });
  it("refuses a tree too big to search", async () => {
    const many = [PS_OK, ...Array.from({ length: 2001 }, (_, i) => `  ${10_000 + i}   ${ROOT} Mon Nov  9 16:58:05 2026`)].join("\n");
    expect(await checkWith({ ps: many, lsof: lsofWith(602) })).toEqual({ ok: false, failed: "its workspace runs more than 2000 processes, too many to check" });
  });
  it("gives each tool after the first only what's left of the time", async () => {
    let t = BOUND;
    const seen: Seen = [];
    const exec = execOf({ ps: PS_OK, lsof: lsofWith(602) }, seen);
    // each tool takes 700 ms
    const c = systemPeerCheck({ self: SELF, now: () => t, exec: async (file, args, o) => ((t += 700), exec(file, args, o)) });
    await c.check(13, c.root(ROOT));
    expect(reads(seen, "lsof")[0].ms).toBeLessThanOrEqual(PEER_CHECK_MS - 700);
    expect(reads(seen, "confirm")[0].ms).toBeLessThanOrEqual(PEER_CHECK_MS - 1400);
  });
  it(`runs ${MAX_RUNNING} checks at once and lines up ${MAX_WAITING} more; past that, a call is refused at once`, async () => {
    let running = 0;
    let most = 0;
    const gates: (() => void)[] = [];
    const answer = execOf({ ps: PS_OK, lsof: lsofWith(602) });
    // each check holds its table read until the test lets it go
    const exec: Exec = async (file, args, o) => {
      if (args.includes("-A")) {
        most = Math.max(most, ++running);
        await new Promise<void>((r) => gates.push(r));
        running--;
      }
      return answer(file, args, o);
    };
    const c = systemPeerCheck({ exec, self: SELF, now: () => BOUND });
    const root = c.root(ROOT);
    let settled = 0;
    const calls = Array.from({ length: MAX_RUNNING + MAX_WAITING }, () => c.check(13, root).finally(() => settled++));
    expect(await c.check(13, root)).toEqual({ ok: false, failed: "too many calls were being checked at once" });
    while (settled < calls.length) {
      await new Promise((r) => setTimeout(r, 1));
      gates.splice(0).forEach((go) => go());
    }
    expect(await Promise.all(calls)).toEqual(Array(MAX_RUNNING + MAX_WAITING).fill({ ok: true, pid: 602 }));
    expect(most).toBe(MAX_RUNNING);
  });
});
