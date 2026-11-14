import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Messaging, mcpLaunch, removeMcpTokenFiles, retireMcpLaunch, type McpLaunch } from "../src/main/messaging";
import { SessionManager } from "../src/main/sessions";
import { cliTurnRunner } from "../src/main/collab";
import { DEFAULT_SETTINGS, type NewSessionRequest, type SessionInfo, type Settings } from "../src/shared/types";
import type { CollabParticipant } from "../src/shared/types";
import { askRaw, startServer, testLaunch } from "./mcpClient";
import { tempDir, write } from "./helpers";

/**
 * Every launch of the MCP server, through what starts it: a pane's real session manager and a Council turn's real
 * runner, the real script and socket, and only the pty faked or the agent CLI a stand-in.
 */

type FakePty = { args: string[]; env: Record<string, string>; killed: boolean; exit(code: number): void; data(text: string): void };
const ptys: FakePty[] = [];
let spawnFails = false;
/** The pid a fake pty runs as: this test's own, so the servers it starts descend from it, unless a test says otherwise. */
let ptyPid = process.pid;
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[], opts: { env: Record<string, string> }) => {
    if (spawnFails) throw new Error("posix_spawnp failed");
    let onExit: (e: { exitCode: number }) => void = () => {};
    let onData: (text: string) => void = () => {};
    const p: FakePty = { args, env: opts.env, killed: false, exit: (exitCode) => onExit({ exitCode }), data: (text) => onData(text) };
    ptys.push(p);
    return { onData: (cb: any) => ((onData = cb), { dispose() {} }), onExit: (cb: any) => ((onExit = cb), { dispose() {} }), write() {}, resize() {}, kill: () => void (p.killed = true), pid: ptyPid };
  },
}));

const TOKENS = path.join(os.homedir(), ".mockingbird", "mcp-tokens");
const sock = mcpLaunch("unused").env.MOCKINGBIRD_SOCK;
const tokenFiles = () => (fs.existsSync(TOKENS) ? fs.readdirSync(TOKENS) : []);
const roomHandler = vi.fn(async (_room: string, _seat: string, op: string, args: Record<string, unknown>) => ({ result: `answered ${op} ${JSON.stringify(args)}` }));

let sessions: SessionManager;
let relay: Messaging;
/** What the store holds, as SessionManager sees it; a save fails while `saveFails` is set, after the change, as the real store's does. */
let records: { sessions: SessionInfo[] };
let saveFails: (() => void) | null = null;
const REFUSED = /^Mockingbird doesn't recognise this tool server/;

/** The launch a pty's command line carries, for the agent's real MCP server, as each CLI would read it from its arguments. */
function launchIn(p: FakePty): McpLaunch {
  const line = p.args.join(" ");
  const claude = /'--mcp-config' '(\{.*?\}\}\}\})'/.exec(line);
  if (claude) {
    const m = JSON.parse(claude[1]).mcpServers.mockingbird;
    return { command: m.command, args: m.args, env: m.env };
  }
  const command = JSON.parse(/mcp_servers\.mockingbird\.command=("[^"]*")/.exec(line)![1]);
  const args = JSON.parse(/mcp_servers\.mockingbird\.args=(\[[^\]]*\])/.exec(line)![1]);
  const env = Object.fromEntries([.../(\w+)="([^"]*)"/g[Symbol.matchAll](/mcp_servers\.mockingbird\.env=\{([^}]*)\}/.exec(line)![1])].map((m) => [m[1], m[2]]));
  return { command, args, env };
}
const tokenIn = (p: FakePty) => fs.readFileSync(launchIn(p).env.MOCKINGBIRD_TOKEN_FILE, "utf8");
const calledWith = (token: string) => askRaw(sock, JSON.stringify({ op: "list_sessions", token }));
const start = (req: Partial<NewSessionRequest> = {}) => sessions.create({ repoPath: null, useWorktree: false, agent: "claude", title: "pane", ...req } as NewSessionRequest);

beforeAll(async () => {
  const wt = tempDir("wt");
  const settings: Settings = { ...DEFAULT_SETTINGS, claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: wt };
  const store = {
    settings,
    state: { sessions: [] as SessionInfo[] },
    upsertSession(i: SessionInfo) {
      const k = this.state.sessions.findIndex((x) => x.id === i.id);
      if (k >= 0) this.state.sessions[k] = structuredClone(i);
      else this.state.sessions.push(structuredClone(i));
      saveFails?.();
    },
    removeSession(id: string) {
      this.state.sessions = this.state.sessions.filter((x) => x.id !== id);
    },
    save() {},
  };
  records = store.state;
  sessions = new SessionManager(store as any);
  sessions.scrollbackDir = path.join(wt, "scrollback");
  relay = new Messaging(sessions, () => true, () => {});
  relay.setRoomHandler(roomHandler);
  relay.start();
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
});
afterAll(() => fs.rmSync(sock, { force: true }));

describe("a pane's launch", () => {
  it.each(["claude", "codex"] as const)("%s: its argv and pty carry only a path, and its real server answers as that pane", async (agent) => {
    const s = await start({ agent });
    const p = ptys.at(-1)!;
    const launch = launchIn(p);
    const token = tokenIn(p);
    expect(launch.env.MOCKINGBIRD_SESSION).toBe(s.id);
    expect(p.args.join(" ")).toContain(launch.env.MOCKINGBIRD_TOKEN_FILE);
    expect(p.args.join(" ")).not.toContain(token);
    expect(JSON.stringify(p.env)).not.toContain(token);
    expect(p.env.MOCKINGBIRD_TOKEN_FILE).toBeUndefined();
    const server = startServer(launch);
    try {
      expect(JSON.parse((await server.call("list_sessions")).content[0].text).you.id).toBe(s.id);
      expect(fs.readFileSync(launch.env.MOCKINGBIRD_TOKEN_FILE, "utf8")).toBe(token);
    } finally {
      await server.stop();
      sessions.kill(s.id, true);
    }
    expect(fs.existsSync(launch.env.MOCKINGBIRD_TOKEN_FILE)).toBe(false);
  });

  it("gets a token that stops when it's restarted, and a new one that works", async () => {
    const s = await start();
    const first = ptys.at(-1)!;
    const before = tokenIn(first);
    const file = launchIn(first).env.MOCKINGBIRD_TOKEN_FILE;
    expect((await calledWith(before)).result.you.id).toBe(s.id);
    await sessions.restart(s.id);
    const second = ptys.at(-1)!;
    expect(second).not.toBe(first);
    const after = tokenIn(second);
    expect(after).not.toBe(before);
    expect((await calledWith(before)).error).toMatch(REFUSED);
    expect((await calledWith(after)).result.you.id).toBe(s.id);
    expect(fs.existsSync(file)).toBe(false);
    // the real script: started again from the old launch it's refused, saying why; the new launch's works, every time
    const stale = startServer(launchIn(first));
    const fresh = [startServer(launchIn(second)), startServer(launchIn(second))];
    try {
      expect((await stale.call("list_sessions")).content[0].text).toMatch(/: its token file is gone/);
      for (const f of fresh) expect(JSON.parse((await f.call("list_sessions")).content[0].text).you.id).toBe(s.id);
    } finally {
      await stale.stop();
      for (const f of fresh) await f.stop();
    }
    sessions.kill(s.id, true);
  });

  it("gets a new token when a closed session is relaunched, and when a dead one is resumed", async () => {
    const s = await start();
    const first = ptys.at(-1)!;
    const one = tokenIn(first);
    sessions.kill(s.id, false);
    expect((await calledWith(one)).error).toMatch(REFUSED);
    await sessions.relaunch(s.id);
    const second = ptys.at(-1)!;
    const two = tokenIn(second);
    expect((await calledWith(two)).result.you.id).toBe(s.id);
    second.exit(1);
    await new Promise((r) => setImmediate(r));
    expect((await calledWith(two)).error).toMatch(REFUSED);
    const r = await sessions.resume(s.id);
    expect(r).not.toHaveProperty("refused");
    const three = tokenIn(ptys.at(-1)!);
    expect((await calledWith(three)).result.you.id).toBe(s.id);
    sessions.kill(s.id, true);
  });

  it("gives up its token at once when it's closed, though its pty hasn't gone yet", async () => {
    const s = await start();
    const p = ptys.at(-1)!;
    const token = tokenIn(p);
    const file = launchIn(p).env.MOCKINGBIRD_TOKEN_FILE;
    sessions.kill(s.id, false);
    expect(p.killed).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect((await calledWith(token)).error).toMatch(REFUSED);
    sessions.kill(s.id, true);
  });

  it("gives up its token when its process exits, and removes a file its server never read", async () => {
    const s = await start();
    const p = ptys.at(-1)!;
    const file = launchIn(p).env.MOCKINGBIRD_TOKEN_FILE;
    const token = fs.readFileSync(file, "utf8");
    p.exit(1);
    expect(fs.existsSync(file)).toBe(false);
    expect((await calledWith(token)).error).toMatch(REFUSED);
    sessions.kill(s.id, true);
  });

  it("isn't touched by the exit of the pty it replaced", async () => {
    const s = await start();
    const first = ptys.at(-1)!;
    await sessions.restart(s.id);
    const token = tokenIn(ptys.at(-1)!);
    first.exit(0);
    expect((await calledWith(token)).result.you.id).toBe(s.id);
    sessions.kill(s.id, true);
  });

  it("replacing a pane still running under its id stops the old token and leaves the new one working", async () => {
    const s = await start();
    const first = ptys.at(-1)!;
    const before = tokenIn(first);
    await sessions.create({ repoPath: null, useWorktree: false, agent: "claude", title: "pane", reuseId: s.id });
    const after = tokenIn(ptys.at(-1)!);
    expect(first.killed).toBe(true);
    expect((await calledWith(before)).error).toMatch(REFUSED);
    expect((await calledWith(after)).result.you.id).toBe(s.id);
    sessions.kill(s.id, true);
  });

  it("that fails to start leaves no token, and a pane still running keeps its own", async () => {
    const s = await start();
    const running = tokenIn(ptys.at(-1)!);
    const files = tokenFiles();
    spawnFails = true;
    try {
      await expect(sessions.create({ repoPath: null, useWorktree: false, agent: "claude", title: "pane", reuseId: s.id })).rejects.toThrow(/Failed to launch.*posix_spawnp/);
      await expect(start()).rejects.toThrow(/Failed to launch/);
    } finally {
      spawnFails = false;
    }
    expect(tokenFiles()).toEqual(files);
    expect((await calledWith(running)).result.you.id).toBe(s.id);
    sessions.kill(s.id, true);
  });

  it("refused on its way makes no token, a take-over heard while it was being prepared included", async () => {
    const s = await start();
    sessions.kill(s.id, false);
    const files = tokenFiles();
    // relaunch's own check passes; create's, just before the pty, hears of the take-over
    let checks = 0;
    sessions.relaunchGuard = () => (++checks > 1 ? "Nick continues it" : null);
    try {
      await expect(sessions.relaunch(s.id)).rejects.toThrow(/Nick continues it/);
    } finally {
      sessions.relaunchGuard = null;
    }
    expect(tokenFiles()).toEqual(files);
    sessions.kill(s.id, true);
  });

  it("that can't be saved is stopped with its token, and the records, panes and messages it owes are as they were", async () => {
    const s = await start();
    // owed to the pane being replaced: its sender was told it's queued
    expect(sessions.deliverAgentMessage(s.id, "the API changed", true, "front")).toMatch(/^queued/);
    const before = structuredClone(records.sessions);
    const files = tokenFiles();
    let token = "";
    saveFails = () => {
      token = tokenIn(ptys.at(-1)!);
      throw new Error("disk full");
    };
    try {
      await expect(start({ title: "unsaved" })).rejects.toThrow(/^“unsaved” couldn't be saved \(disk full\), so it was stopped$/);
      // replacing a pane that's running: the old one has gone, as it would for any replacement, and its record stays
      await expect(sessions.create({ repoPath: null, useWorktree: false, agent: "claude", title: "pane", reuseId: s.id })).rejects.toThrow(/couldn't be saved/);
    } finally {
      saveFails = null;
    }
    const [unsaved, replacement] = ptys.slice(-2);
    expect(unsaved.killed && replacement.killed).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await calledWith(token)).error).toMatch(REFUSED);
    expect(tokenFiles().length).toBe(files.length - 1); // the replaced pane's went with it
    expect(records.sessions).toEqual(before);
    expect(sessions.list().map((x) => x.title)).not.toContain("unsaved");
    expect(sessions.list().find((x) => x.id === s.id)).toBeUndefined();
    // their exits, later, touch nothing
    unsaved.exit(1);
    replacement.exit(1);
    await new Promise((r) => setImmediate(r));
    expect(records.sessions).toEqual(before);
    // the next launch that's saved still owes the message
    await sessions.create({ repoPath: null, useWorktree: false, agent: "claude", title: "pane", reuseId: s.id });
    expect(sessions.overdueMessages(Date.now() + 3_600_000, 0)).toEqual([expect.objectContaining({ from: "front", to: s.id })]);
    sessions.kill(s.id, true);
  });

  it("that can't be saved on its way back keeps a debrief's interview so far for its next launch", async () => {
    const d = await start({ debrief: true, title: "debrief" });
    ptys.at(-1)!.data("Q1: what went well?\r\n");
    sessions.kill(d.id, false);
    expect(sessions.closedOutput(d.id)).toContain("Q1: what went well?");
    saveFails = () => {
      throw new Error("disk full");
    };
    try {
      await expect(sessions.create({ repoPath: null, useWorktree: false, agent: "claude", title: "debrief", debrief: true, reuseId: d.id })).rejects.toThrow(/couldn't be saved/);
    } finally {
      saveFails = null;
    }
    expect(sessions.closedOutput(d.id)).toContain("Q1: what went well?");
    sessions.kill(d.id, true);
  });

  it("runs as its pty's process: its token answers nothing outside that process and what it starts", async () => {
    const pane = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    ptyPid = pane.pid!;
    try {
      const s = await start();
      expect((await calledWith(tokenIn(ptys.at(-1)!))).error).toMatch(/^Mockingbird refused this call: the process calling isn't one of its workspace's own/);
      sessions.kill(s.id, true);
    } finally {
      ptyPid = process.pid;
      pane.kill();
      await new Promise((r) => pane.once("exit", r));
    }
  });

  it("isn't started without its token, and says why", async () => {
    const before = ptys.length;
    const aside = `${TOKENS}.aside`;
    fs.renameSync(TOKENS, aside);
    fs.writeFileSync(TOKENS, "a file where the folder goes");
    try {
      await expect(start()).rejects.toThrow(/couldn't give this agent its tools: no token could be written in .*mcp-tokens \(EEXIST/);
    } finally {
      fs.rmSync(TOKENS);
      fs.renameSync(aside, TOKENS);
    }
    expect(ptys.length).toBe(before);
  });

  it("makes no token for a terminal, or for a terminal bringing an agent back", async () => {
    const files = tokenFiles();
    const a = await start({ shell: true, agent: undefined });
    expect(ptys.at(-1)!.args.join(" ")).not.toContain("MOCKINGBIRD_TOKEN_FILE");
    const b = await start({ shell: true, agent: undefined, shellResume: { agent: "claude", id: "conv" } });
    expect(ptys.at(-1)!.args.join(" ")).not.toContain("MOCKINGBIRD_TOKEN_FILE");
    expect(tokenFiles()).toEqual(files);
    sessions.kill(a.id, true);
    sessions.kill(b.id, true);
  });

  it("leaves no files behind once every pane has closed", async () => {
    const s = await start();
    const t = await start({ agent: "codex" });
    expect(tokenFiles().length).toBeGreaterThanOrEqual(2);
    sessions.kill(s.id, true);
    sessions.kill(t.id, true);
    retireAllStrays();
    expect(tokenFiles()).toEqual([]);
  });
});

/** What this file's helpers minted directly: not a pane's or a turn's, so nothing else gives them up. */
const retireAllStrays = () => {
  for (const f of tokenFiles()) retireMcpLaunch({ command: "", args: [], env: { MOCKINGBIRD_TOKEN_FILE: path.join(TOKENS, f) } });
};

describe("quitting", () => {
  it("removes every token file left, whether a server has read it or not", async () => {
    const launch = testLaunch("a");
    const read = testLaunch("b");
    const server = startServer(read);
    await server.request("initialize", { protocolVersion: "2025-06-18" });
    await server.stop();
    removeMcpTokenFiles();
    expect(fs.existsSync(launch.env.MOCKINGBIRD_TOKEN_FILE)).toBe(false);
    expect(fs.existsSync(read.env.MOCKINGBIRD_TOKEN_FILE)).toBe(false);
    expect(tokenFiles()).toEqual([]);
    retireMcpLaunch(read);
    retireMcpLaunch(launch);
  });
});

/**
 * A stand-in for Claude and Codex in a Council turn: it finds the MCP server in its arguments as the CLI would, starts
 * the real script with what they say, reads the prompt from stdin for which tool to call and how long to take, calls it,
 * and leaves what happened in a file. Its reply is in each CLI's format.
 */
const FAKE = String.raw`
const { spawn } = require("child_process");
const fs = require("fs");
const argv = process.argv.slice(2);
function launch() {
  const i = argv.indexOf("--mcp-config");
  if (i >= 0) return JSON.parse(argv[i + 1]).mcpServers.mockingbird;
  const value = (k) => argv.find((a) => a.startsWith("mcp_servers.mockingbird." + k + "="))?.slice(("mcp_servers.mockingbird." + k + "=").length);
  if (!value("command")) return null;
  const env = Object.fromEntries([...value("env").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { command: JSON.parse(value("command")), args: JSON.parse(value("args")), env };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // Codex's MCP servers, read before a Codex turn to switch them off: one of the user's
  if (argv.join(" ") === "mcp list --json") return console.log(JSON.stringify([{ name: "users-own", enabled: true }]));
  let input = "";
  for await (const d of process.stdin) input += d;
  const ask = JSON.parse(input);
  const m = launch();
  const seen = { server: !!m, argv };
  if (m) {
    seen.token = fs.readFileSync(m.env.MOCKINGBIRD_TOKEN_FILE, "utf8");
    if (ask.stealTo) fs.writeFileSync(ask.stealTo, seen.token);
    const p = spawn(process.execPath, m.args, { env: { ...process.env, ...m.env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const reply = async (id) => {
      for (let i = 0; i < 400; i++) {
        const line = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === id);
        if (line) return line;
        await wait(10);
      }
      throw new Error("the server didn't answer " + id);
    };
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    seen.tools = (await reply(1)).result.tools.map((t) => t.name);
    await wait(ask.delay || 0);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: ask.tool, arguments: ask.args || {} } }) + "\n");
    seen.answer = (await reply(2)).result;
    p.kill();
  }
  fs.writeFileSync(ask.record, JSON.stringify(seen));
  const o = argv.indexOf("-o");
  if (o >= 0) {
    fs.writeFileSync(argv[o + 1], "codex says hi");
    console.log(JSON.stringify({ thread_id: "thread-1" }));
  } else console.log(JSON.stringify({ result: "claude says hi", session_id: "conv-1" }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
`;

describe("a Council turn's launch", () => {
  const seat = (agent: "claude" | "codex"): CollabParticipant => ({ key: "s", label: "Seat", agent, model: "m", conversationId: null, lastSeen: 0 }) as unknown as CollabParticipant;
  const dir = tempDir("council");
  const record = (n: string) => path.join(dir, `${n}.json`);
  const seen = (n: string) => JSON.parse(fs.readFileSync(record(n), "utf8"));
  const bin = path.join(dir, "fake-cli");
  const run = () => cliTurnRunner(() => bin);
  const prompt = (n: string, tool: string, args: Record<string, unknown> = {}, delay = 0) => JSON.stringify({ record: record(n), tool, args, delay });
  const turn = (over: { agent?: "claude" | "codex"; askTool?: boolean; tag?: string; text: string; signal?: AbortSignal }) =>
    run()(seat(over.agent ?? "claude"), over.text, { cwd: dir, signal: over.signal ?? new AbortController().signal, tag: over.tag ?? "collab-r1.s", askTool: over.askTool ?? true });

  beforeAll(() => {
    write(dir, { "fake.js": FAKE });
    fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "fake.js"))} "$@"\n`, { mode: 0o755 });
    retireAllStrays();
    roomHandler.mockClear();
  });

  it.each(["claude", "codex"] as const)("%s: its real server's call reaches the room as its seat, and its token goes with the turn", async (agent) => {
    roomHandler.mockClear();
    const r = await turn({ agent, text: prompt(agent, "ask_code_reader", { question: "where?", from: "collab-other.seat" }) });
    expect(r.text).toMatch(/says hi/);
    const s = seen(agent);
    expect(s.tools).toContain("ask_code_reader");
    expect(s.answer.isError).toBe(false);
    expect(s.answer.content[0].text).toBe('answered ask_code_reader {"question":"where?","from":"collab-other.seat"}');
    expect(roomHandler).toHaveBeenCalledWith("r1", "s", "ask_code_reader", { question: "where?", from: "collab-other.seat" });
    expect(tokenFiles()).toEqual([]);
    expect((await askRaw(sock, JSON.stringify({ op: "ask_code_reader", token: s.token, args: { question: "after" } }))).error).toMatch(REFUSED);
    expect(s.argv.join(" ")).not.toContain(s.token);
    // the user's own servers, read from Codex, are switched off for the turn
    if (agent === "codex") expect(s.argv).toContain('mcp_servers={"users-own"={enabled=false}}');
  });

  it("gives Claude its permission tool, which reaches the room", async () => {
    roomHandler.mockClear();
    await turn({ text: prompt("permit", "approve_permission", { tool_name: "Bash", input: { command: "ls" } }), askTool: false });
    const s = seen("permit");
    expect(s.tools).toEqual(["approve_permission"]);
    expect(roomHandler).toHaveBeenCalledWith("r1", "s", "approve_permission", { tool_name: "Bash", input: { command: "ls" } });
  });

  it("starts no server for a Codex seat with nothing to ask, and makes no token", async () => {
    const r = await turn({ agent: "codex", askTool: false, text: prompt("plain", "unused") });
    expect(r.text).toMatch(/says hi/);
    expect(seen("plain").server).toBe(false);
    expect(tokenFiles()).toEqual([]);
  });

  it("runs as its turn's shell: the token answers the turn's own server, never a process outside it", async () => {
    roomHandler.mockClear();
    const stolen = path.join(dir, "stolen");
    const running = turn({ text: JSON.stringify({ record: record("stolen"), tool: "ask_code_reader", args: { question: "own" }, delay: 1500, stealTo: stolen }) });
    for (let i = 0; i < 200 && !fs.existsSync(stolen); i++) await new Promise((r) => setTimeout(r, 20));
    const r = await askRaw(sock, JSON.stringify({ op: "ask_code_reader", token: fs.readFileSync(stolen, "utf8"), args: { question: "from outside" } }));
    expect(r.error).toMatch(/^Mockingbird refused this call: the process calling isn't one of its workspace's own/);
    await running;
    expect(seen("stolen").answer.isError).toBe(false);
    expect(roomHandler.mock.calls.map((c) => c[3])).toEqual([{ question: "own" }]);
  });

  it("keeps two turns of one seat apart: the first ending doesn't stop the second's token", async () => {
    roomHandler.mockClear();
    await Promise.all([
      turn({ text: prompt("quick", "ask_code_reader", { question: "quick" }) }),
      turn({ text: prompt("slow", "ask_code_reader", { question: "slow" }, 1500) }),
    ]);
    expect(seen("quick").answer.isError).toBe(false);
    expect(seen("slow").answer.isError).toBe(false);
    expect(seen("slow").token).not.toBe(seen("quick").token);
    expect(tokenFiles()).toEqual([]);
  });

  it("fails a Codex turn whose user's MCP servers can't be named, rather than run them, saying why but nothing Codex printed", async () => {
    const broken = path.join(dir, "fake-cli-broken");
    fs.writeFileSync(broken, `#!/bin/sh\nif [ "$1" = mcp ]; then echo 'bearer_token = "sk-secretvalue"' >&2; exit 1; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "fake.js"))} "$@"\n`, { mode: 0o755 });
    const ran = record("broken");
    const r = cliTurnRunner(() => broken)(seat("codex"), prompt("broken", "ask_code_reader"), { cwd: dir, signal: new AbortController().signal, tag: "collab-r1.s", askTool: true });
    await expect(r).rejects.toThrow(/couldn't read which MCP servers your Codex config names, to switch them off for the turn \(`codex mcp list` exited with code 1\)/);
    await expect(r).rejects.not.toThrow(/secretvalue/);
    expect(fs.existsSync(ran)).toBe(false);
    expect(tokenFiles()).toEqual([]);
  });

  it("leaves no token when its agent isn't installed, or its run fails or is stopped", async () => {
    await expect(cliTurnRunner(() => "claude")(seat("claude"), "x", { cwd: dir, signal: new AbortController().signal, tag: "collab-r1.s", askTool: true })).rejects.toThrow(/isn't installed/);
    expect(tokenFiles()).toEqual([]);
    await expect(turn({ text: "not json, so the stand-in fails" })).rejects.toThrow();
    expect(tokenFiles()).toEqual([]);
    const stop = new AbortController();
    const stopped = turn({ text: prompt("stopped", "ask_code_reader", { question: "q" }, 5000), signal: stop.signal });
    await new Promise((r) => setTimeout(r, 300));
    stop.abort();
    await expect(stopped).rejects.toThrow();
    expect(tokenFiles()).toEqual([]);
  });
});
