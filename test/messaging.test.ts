import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Messaging, mcpLaunch, retireMcpLaunch } from "../src/main/messaging";
import { claudeMcpConfig, codexMcpSettings } from "../src/main/agents";
import type { SessionInfo } from "../src/shared/types";
import { HOUSE_READ_TOOLS, HOUSE_TOOL_NAMES, HOUSE_WRITE_TOOLS } from "../src/shared/team/house";
import { askAs, askRaw, startServer, tokenFor } from "./mcpClient";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, repoPath: `/code/${id}`, branch: `${id}-branch`, taskGroup: "5038/api", status: "idle", agent: "claude", cwd: `/w/${id}`, kind: "work", ...over }) as SessionInfo;

const live = [
  session("front", { taskGroup: "5038/web", ticketTitle: "Filter orgs" }),
  session("back", { agent: "codex", status: "working" }),
  session("other", { taskGroup: "9999" }),
  session("term", { shell: true }),
  session("brief", { debrief: true }),
  session("gone", { status: "dead" }),
];
const delivered: { to: string; text: string; submit: boolean }[] = [];
const loops: string[] = [];
const logged: any[] = [];
const askedFor: string[] = [];
let submit = true;
let relay: Messaging;
const sock = mcpLaunch("front").env.MOCKINGBIRD_SOCK;

/** One request over the socket, the way the MCP server sends it for session `from`. */
const ask = (req: { op: string; from: string; args?: Record<string, unknown> }): Promise<any> => askAs(sock, req);

beforeAll(async () => {
  const fakeSessions = {
    list: () => live,
    deliverAgentMessage: (to: string, text: string, sub: boolean) => {
      delivered.push({ to, text, submit: sub });
      return sub ? "delivered" : "placed in its prompt for the user to send";
    },
  };
  relay = new Messaging(
    fakeSessions as any,
    (target) => (askedFor.push(target.id), submit),
    (a, b) => loops.push(`${a.id}->${b.id}`),
    (m) => logged.push(m)
  );
  relay.start();
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
});
afterAll(() => fs.rmSync(sock, { force: true }));

describe("relay", () => {
  it("binds an owner-only socket", async () => {
    // permissions are tightened in the listen callback, just after the file appears
    for (let i = 0; i < 50 && (fs.statSync(sock).mode & 0o777) !== 0o600; i++) await new Promise((r) => setTimeout(r, 20));
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });
  it("lists other live agent sessions — no shells, debriefs, dead ones or yourself — marking your group", async () => {
    const r = await ask({ op: "list_sessions", from: "front" });
    expect(r.result.you).toEqual({ id: "front", title: "Filter orgs" });
    expect(r.result.sessions.map((s: any) => [s.id, s.agent, s.same_group])).toEqual([
      ["back", "codex", true],
      ["other", "claude", false],
    ]);
  });
  it("delivers a message labelled with its sender and marked as agent-written", async () => {
    const r = await ask({ op: "send_message", from: "front", args: { to: "back", message: "orgId is now organizationId" } });
    expect(r.result).toMatch(/^Delivered to "back"/);
    const d = delivered.at(-1)!;
    expect(d).toMatchObject({ to: "back", submit: true });
    expect(d.text).toMatch(/^\[Message from Mockingbird session "Filter orgs" \(id front, claude · front · front-branch\)/);
    expect(d.text).toMatch(/not by the user/);
    expect(d.text.endsWith("orgId is now organizationId")).toBe(true);
    // the delivery choice is asked per recipient (a group can override it), and the send is logged
    expect(askedFor.at(-1)).toBe("back");
    expect(logged.at(-1)).toMatchObject({ from: "front", fromTitle: "Filter orgs", to: "back", toTitle: "back", text: "orgId is now organizationId", outcome: "delivered" });
  });
  it("leaves the message in the prompt when auto-send is off", async () => {
    submit = false;
    const r = await ask({ op: "send_message", from: "front", args: { to: "other", message: "hi" } });
    submit = true;
    expect(r.result).toMatch(/placed in its prompt/);
    expect(delivered.at(-1)!.submit).toBe(false);
  });
  it.each([
    [{ to: "front", message: "x" }, /your own session/],
    [{ to: "nope", message: "x" }, /No running session with id "nope"/],
    [{ to: "term", message: "x" }, /No running session/],
    [{ to: "brief", message: "x" }, /debrief interview/],
    [{ to: "back", message: "   " }, /empty/],
    [{ to: "back", message: "x".repeat(8001) }, /limit is 8000/],
  ])("refuses %j", async (args, err) => {
    const r = await ask({ op: "send_message", from: "front", args });
    expect(r.error).toMatch(err);
  });
  it("refuses callers it doesn't know and tools it doesn't have", async () => {
    expect((await ask({ op: "list_sessions", from: "ghost" })).error).toMatch(/not known/);
    expect((await ask({ op: "rm_rf", from: "front" })).error).toMatch(/Unknown tool/);
  });
  it("stops a ping-pong at 8 messages per pair per 5 minutes and tells the user", async () => {
    // "other" <-> "back" has had no traffic yet in either direction
    const send = (from: string, to: string) => ask({ op: "send_message", from, args: { to, message: "ping" } });
    for (let i = 0; i < 4; i++) {
      expect((await send("other", "back")).result).toBeDefined();
      expect((await send("back", "other")).result).toBeDefined();
    }
    const ninth = await send("other", "back");
    expect(ninth.error).toMatch(/Paused: 8 messages/);
    expect(loops).toContain("other->back");
    expect(logged.at(-1)).toMatchObject({ from: "other", to: "back", refused: true, outcome: expect.stringMatching(/message limit/) });
  });
});

describe("room requests", () => {
  it("are routed to Collaborate by their collab-<room>.<seat> tag", async () => {
    const seen: any[] = [];
    relay.setRoomHandler(async (room, seat, op, args) => {
      seen.push([room, seat, op, args]);
      return { result: "found it in src/x.ts" };
    });
    expect(await ask({ op: "ask_code_reader", from: "collab-r1.fable", args: { question: "where?" } })).toEqual({ result: "found it in src/x.ts" });
    expect(seen).toEqual([["r1", "fable", "ask_code_reader", { question: "where?" }]]);
  });
});

describe("MCP server script", () => {
  it("speaks JSON-RPC over stdio and relays tool calls", async () => {
    const launch = mcpLaunch("front");
    const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const w = (m: object) => p.stdin.write(JSON.stringify(m) + "\n");
    w({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    w({ jsonrpc: "2.0", method: "notifications/initialized" });
    w({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    w({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sessions", arguments: {} } });
    w({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send_message", arguments: { to: "front", message: "x" } } });
    w({ jsonrpc: "2.0", id: 5, method: "nope" });
    w({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "claim_house_ticket", arguments: { n: 141 } } });
    w({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_room_artifact", arguments: { id: "x" } } });
    await new Promise((r) => setTimeout(r, 1500));
    p.kill();
    const byId = Object.fromEntries(out.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    expect(byId[1].result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "mockingbird" } });
    expect(byId[2].result.tools.map((t: any) => t.name)).toEqual([
      "list_sessions",
      "send_message",
      "list_links",
      ...HOUSE_TOOL_NAMES,
      "list_room_artifacts",
      "read_room_artifact",
      "list_teammate_changes",
      "read_teammate_diff",
      "reserve_migration_number",
      "list_migration_reservations",
      "release_migration_number",
    ]);
    // the House's writes need a person's OK on every call (Claude Code, in any permission mode); its reads are read-only
    const listed = Object.fromEntries(byId[2].result.tools.map((t: any) => [t.name, t]));
    for (const tool of HOUSE_WRITE_TOOLS) expect(listed[tool]).toMatchObject({ _meta: { "anthropic/requiresUserInteraction": true }, annotations: { readOnlyHint: false } });
    for (const tool of [...HOUSE_READ_TOOLS, "list_teammate_changes", "read_teammate_diff", "list_migration_reservations"]) {
      expect(listed[tool].annotations).toEqual({ readOnlyHint: true });
      expect(listed[tool]).not.toHaveProperty("_meta");
    }
    expect(byId[3].result.isError).toBe(false);
    expect(JSON.parse(byId[3].result.content[0].text).you.id).toBe("front");
    expect(byId[4].result).toMatchObject({ isError: true, content: [{ text: "That is your own session." }] });
    expect(byId[5].error.code).toBe(-32601);
    // the House board's tools reach Mockingbird, which says why it can't act here
    expect(byId[6].result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/House board isn't running/) }] });
    // so do the room artifacts' tools
    expect(byId[7].result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/team rooms aren't running/) }] });
  });
  it("offers a room model only the ask_code_reader tool", async () => {
    const launch = mcpLaunch("collab-r1.fable");
    const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 800));
    p.kill();
    expect(JSON.parse(out.trim()).result.tools.map((t: any) => t.name)).toEqual(["ask_code_reader"]);
  });
  it("offers a room model the tools its launch names", async () => {
    const list = async (tools: string) => {
      const launch = mcpLaunch("collab-r1.opus", tools.split(","));
      const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
      await new Promise((r) => setTimeout(r, 800));
      p.kill();
      return JSON.parse(out.trim()).result.tools.map((t: any) => t.name);
    };
    expect(await list("approve_permission")).toEqual(["approve_permission"]);
    expect(await list("ask_code_reader,approve_permission")).toEqual(["ask_code_reader", "approve_permission"]);
  });
  it("outlives the app restarting: calls while it's down say so, and calls after reach the new app", async () => {
    const appSock = path.join(os.homedir(), "restart.sock");
    /** The app, as far as the MCP server can tell: whatever answers on the socket. */
    const startApp = (n: number) =>
      new Promise<net.Server>((resolve) => {
        fs.rmSync(appSock, { force: true }); // as Messaging.start clears a previous run's socket
        const server = net.createServer({ allowHalfOpen: true }, (c) => c.on("data", () => {}).on("end", () => c.end(JSON.stringify({ result: `app run ${n}` }))));
        server.listen(appSock, () => resolve(server));
      });
    const launch = mcpLaunch("front");
    const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env, MOCKINGBIRD_SOCK: appSock } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    let exited = false;
    p.on("exit", () => (exited = true));
    const call = async (id: number) => {
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_sessions", arguments: {} } }) + "\n");
      for (let i = 0; i < 100 && !out.includes(`"id":${id},`); i++) await new Promise((r) => setTimeout(r, 20));
      const line = out.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === id);
      return line?.result.content[0].text as string | undefined;
    };
    try {
      const first = await startApp(1);
      expect(await call(1)).toBe("app run 1");
      await new Promise((r) => first.close(r)); // the app quits
      expect(await call(2)).toMatch(/Mockingbird is not reachable/);
      const second = await startApp(2); // and comes back
      expect(await call(3)).toBe("app run 2");
      await new Promise((r) => second.close(r));
      expect(exited).toBe(false);
    } finally {
      p.kill();
    }
  });
  it("explains itself when the app isn't running", async () => {
    const launch = mcpLaunch("front");
    const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env, MOCKINGBIRD_SOCK: "/tmp/mb-no-such.sock" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions" } }) + "\n");
    await new Promise((r) => setTimeout(r, 800));
    p.kill();
    expect(JSON.parse(out.trim()).result.content[0].text).toMatch(/Mockingbird is not reachable/);
  });
});

describe("who's calling", () => {
  const NO_ANSWER = /has no valid token.*Restart this workspace/;
  afterEach(() => {
    vi.restoreAllMocks();
    relay.setRoomHandler(async () => ({ error: "no room handler in this test" }));
  });

  it("gives no answer to a request without a token, whoever its `from` says it is", async () => {
    const sent = delivered.length;
    for (const req of [
      { op: "list_sessions", from: "front" },
      { op: "send_message", from: "front", args: { to: "back", message: "as front" } },
      { op: "list_links", from: "front" },
      { op: "claim_house_ticket", from: "front", args: { n: 1 } },
      { op: "read_room_artifact", from: "front", args: { id: "x" } },
    ]) {
      expect((await askRaw(sock, JSON.stringify(req))).error, req.op).toMatch(NO_ANSWER);
    }
    expect(delivered.length).toBe(sent);
  });

  it("gives no answer to a token it doesn't know, or to one that isn't a string", async () => {
    for (const token of ["f".repeat(64), "", 7, null, { a: 1 }, ["x"]]) {
      expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", token, from: "front" }))).error, JSON.stringify(token)).toMatch(NO_ANSWER);
    }
  });

  it("never reaches a room's handler from a forged collab tag", async () => {
    const handler = vi.fn(async () => ({ result: "answered" }));
    relay.setRoomHandler(handler);
    expect((await askRaw(sock, JSON.stringify({ op: "approve_permission", from: "collab-r1.fable", args: { tool_name: "Bash", input: {} } }))).error).toMatch(NO_ANSWER);
    expect(handler).not.toHaveBeenCalled();
    // a session's own token can't be turned into a room model's by naming one
    expect((await askRaw(sock, JSON.stringify({ op: "ask_code_reader", from: "collab-r1.fable", token: tokenFor("front"), args: { question: "q" } }))).error).toMatch(/Unknown tool/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("takes a room model's seat from its token, not from what it says", async () => {
    const handler = vi.fn(async () => ({ result: "answered" }));
    relay.setRoomHandler(handler);
    await askRaw(sock, JSON.stringify({ op: "ask_code_reader", from: "collab-other.seat", token: tokenFor("collab-r1.fable"), args: { question: "q", from: "collab-other.seat" } }));
    expect(handler).toHaveBeenCalledWith("r1", "fable", "ask_code_reader", { question: "q", from: "collab-other.seat" });
  });

  it("goes by the token when `from` names someone else: the send is labelled and logged as the token's session", async () => {
    const r = await askRaw(sock, JSON.stringify({ op: "send_message", from: "other", token: tokenFor("front"), args: { to: "back", message: "whose?" } }));
    expect(r.result).toMatch(/^Delivered to "back"/);
    expect(delivered.at(-1)!.text).toMatch(/^\[Message from Mockingbird session "Filter orgs" \(id front,/);
    expect(logged.at(-1)).toMatchObject({ from: "front", to: "back" });
    expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", from: "other", token: tokenFor("front") }))).result.you.id).toBe("front");
  });

  it("ignores a `from` in a tool's arguments", async () => {
    const r = await ask({ op: "send_message", from: "front", args: { from: "other", to: "back", message: "args" } });
    expect(r.result).toMatch(/^Delivered/);
    expect(delivered.at(-1)!.text).toMatch(/^\[Message from Mockingbird session "Filter orgs" \(id front,/);
    expect(logged.at(-1)).toMatchObject({ from: "front" });
    expect((await ask({ op: "list_sessions", from: "front", args: { from: "other" } })).result.you.id).toBe("front");
  });

  it("stops answering a launch's token once it's retired, and leaves no file behind", async () => {
    const launch = mcpLaunch("front");
    const file = launch.env.MOCKINGBIRD_TOKEN_FILE;
    const token = fs.readFileSync(file, "utf8");
    expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", token }))).result.you.id).toBe("front");
    retireMcpLaunch(launch);
    expect(fs.existsSync(file)).toBe(false);
    expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", token }))).error).toMatch(NO_ANSWER);
    retireMcpLaunch(launch); // twice is fine: a kill and its pty's exit both do it
  });

  it("keeps another launch of the same session working when one is retired", async () => {
    const one = mcpLaunch("front");
    const two = mcpLaunch("front");
    const token = fs.readFileSync(two.env.MOCKINGBIRD_TOKEN_FILE, "utf8");
    retireMcpLaunch(one);
    expect((await askRaw(sock, JSON.stringify({ op: "list_sessions", token }))).result.you.id).toBe("front");
    retireMcpLaunch(two);
  });

  it("refuses what isn't a JSON object, and never says back what it was sent", async () => {
    // JSON.parse's own message quotes the first few characters of what it was given
    const SECRET = "0123456789abcdef".repeat(4);
    for (const body of [`{"op":"list_sessions","token":"${SECRET}"`, `x${SECRET}`, `"${SECRET}`, "null", "[]", "5", ""]) {
      const r = await askRaw(sock, body);
      expect(r.error, body).toMatch(/^Bad request/);
      expect(JSON.stringify(r), body).not.toContain(SECRET.slice(0, 6));
    }
  });

  it("logs a refusal without the token, and not on every request", async () => {
    const SECRET = "d".repeat(64);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (relay as any).lastNoToken = 0;
    for (let i = 0; i < 3; i++) await askRaw(sock, JSON.stringify({ op: "list_sessions", token: SECRET }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/refused a request with no valid token \("list_sessions"\)/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("carries only a path to the token in a launch, which is what ends up in an agent's argv", () => {
    const launch = mcpLaunch("front");
    const file = launch.env.MOCKINGBIRD_TOKEN_FILE;
    const token = fs.readFileSync(file, "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(path.dirname(file)).toBe(path.join(os.homedir(), ".mockingbird", "mcp-tokens"));
    expect(path.basename(file)).not.toContain(token);
    expect(JSON.stringify(launch)).not.toContain(token);
    expect(claudeMcpConfig(launch)).toContain(file);
    expect(claudeMcpConfig(launch)).not.toContain(token);
    expect(codexMcpSettings(launch).join(" ")).toContain(file);
    expect(codexMcpSettings(launch).join(" ")).not.toContain(token);
    retireMcpLaunch(launch);
  });

  it("keeps tokens in an owner-only folder, each owner-only", () => {
    const dir = path.join(os.homedir(), ".mockingbird", "mcp-tokens");
    fs.chmodSync(dir, 0o755); // a folder from before, or a looser umask
    const launch = mcpLaunch("front");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(launch.env.MOCKINGBIRD_TOKEN_FILE).mode & 0o777).toBe(0o600);
    retireMcpLaunch(launch);
  });
});

describe("the real MCP server's token", () => {
  const asRoot = process.getuid?.() === 0;

  it("is read once at its start and its file removed, and every call goes as that launch's session", async () => {
    const launch = mcpLaunch("back");
    const file = launch.env.MOCKINGBIRD_TOKEN_FILE;
    const token = fs.readFileSync(file, "utf8");
    const server = startServer(launch);
    try {
      await server.request("initialize", { protocolVersion: "2025-06-18" });
      expect(fs.existsSync(file)).toBe(false);
      expect(JSON.parse((await server.call("list_sessions")).content[0].text).you.id).toBe("back");
      const sent = await server.call("send_message", { to: "front", message: "from the real server", from: "other" });
      expect(sent.isError).toBe(false);
      expect(delivered.at(-1)!.text).toMatch(/\(id back, codex/);
      expect(server.stderr()).not.toContain(token);
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
    }
  });

  it("isn't there for a server started a second time from the same launch: its tools are listed and each call says to restart", async () => {
    const launch = mcpLaunch("front");
    const first = startServer(launch);
    await first.request("initialize", { protocolVersion: "2025-06-18" });
    await first.stop();
    const again = startServer(launch);
    try {
      expect((await again.request("tools/list")).result.tools.map((t: any) => t.name)).toContain("send_message");
      const r = await again.call("list_sessions");
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/has no valid token.*Restart this workspace/);
    } finally {
      await again.stop();
      retireMcpLaunch(launch);
    }
  });

  it("stops working for a server from before a relaunch, which is told to restart", async () => {
    const launch = mcpLaunch("front");
    const server = startServer(launch);
    try {
      expect((await server.call("list_sessions")).isError).toBe(false);
      retireMcpLaunch(launch);
      const r = await server.call("list_sessions");
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/Restart this workspace/);
    } finally {
      await server.stop();
    }
  });

  it("can't be read from a file that isn't one: a link isn't followed, a pipe doesn't hang it, and the reason is given", async () => {
    const launch = mcpLaunch("front");
    const file = launch.env.MOCKINGBIRD_TOKEN_FILE;
    const real = `${file}.real`;
    fs.renameSync(file, real);
    fs.symlinkSync(real, file);
    const linked = startServer(launch);
    try {
      const r = await linked.call("list_sessions");
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/couldn't be read: (ELOOP|EMLINK)/);
      expect(fs.existsSync(real)).toBe(true);
    } finally {
      await linked.stop();
    }
    fs.rmSync(file);
    fs.rmSync(real);
    const fifo = spawn("/usr/bin/mkfifo", [file]);
    await new Promise((res) => fifo.on("exit", res));
    const piped = startServer(launch);
    try {
      expect((await piped.call("list_sessions")).content[0].text).toMatch(/couldn't be read: ENOTFILE/);
    } finally {
      await piped.stop();
      retireMcpLaunch(launch);
    }
  });

  it.skipIf(asRoot)("says it couldn't read a token file it isn't allowed to, as a sandbox would have it", async () => {
    const launch = mcpLaunch("front");
    const file = launch.env.MOCKINGBIRD_TOKEN_FILE;
    fs.chmodSync(file, 0o000);
    const server = startServer(launch);
    try {
      const r = await server.call("list_sessions");
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/couldn't be read: EACCES/);
      expect(server.stderr()).toMatch(/couldn't read its token file \(EACCES\)/);
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
    }
  });

  it("is never in what the app logs or the message log", async () => {
    const said: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void said.push(JSON.stringify(a)));
    const launch = mcpLaunch("other");
    const token = fs.readFileSync(launch.env.MOCKINGBIRD_TOKEN_FILE, "utf8");
    const server = startServer(launch);
    try {
      await server.call("send_message", { to: "back", message: "logged" });
      await server.call("send_message", { to: "nope", message: "refused" });
      await server.call("nonsense");
      await askRaw(sock, `{"op":"list_sessions","token":"${token}"`);
      expect(said.join("\n")).not.toContain(token);
      expect(JSON.stringify(logged)).not.toContain(token);
      expect(JSON.stringify(delivered)).not.toContain(token);
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
      vi.restoreAllMocks();
    }
  });
});
