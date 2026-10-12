import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Messaging, mcpLaunch } from "../src/main/messaging";
import type { SessionInfo } from "../src/shared/types";
import { HOUSE_TOOL_NAMES } from "../src/shared/team/house";

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
const launch = mcpLaunch("front");
const sock = launch.env.MOCKINGBIRD_SOCK;

/** One request over the socket, the way the MCP server sends it. */
function ask(req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => resolve(JSON.parse(buf)));
    c.on("error", reject);
    c.end(JSON.stringify(req));
  });
}

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
    await new Promise((r) => setTimeout(r, 1500));
    p.kill();
    const byId = Object.fromEntries(out.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    expect(byId[1].result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "mockingbird" } });
    expect(byId[2].result.tools.map((t: any) => t.name)).toEqual(["list_sessions", "send_message", ...HOUSE_TOOL_NAMES]);
    expect(byId[3].result.isError).toBe(false);
    expect(JSON.parse(byId[3].result.content[0].text).you.id).toBe("front");
    expect(byId[4].result).toMatchObject({ isError: true, content: [{ text: "That is your own session." }] });
    expect(byId[5].error.code).toBe(-32601);
    // the House board's tools reach Mockingbird, which says why it can't act here
    expect(byId[6].result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/House board isn't running/) }] });
  });
  it("offers a room model only the ask_code_reader tool", async () => {
    const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env, MOCKINGBIRD_SESSION: "collab-r1.fable" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 800));
    p.kill();
    expect(JSON.parse(out.trim()).result.tools.map((t: any) => t.name)).toEqual(["ask_code_reader"]);
  });
  it("offers a room model the tools its launch names", async () => {
    const list = async (tools: string) => {
      const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env, MOCKINGBIRD_SESSION: "collab-r1.opus", MOCKINGBIRD_TOOLS: tools } });
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
  it("explains itself when the app isn't running", async () => {
    const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env, MOCKINGBIRD_SOCK: "/tmp/mb-no-such.sock" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions" } }) + "\n");
    await new Promise((r) => setTimeout(r, 800));
    p.kill();
    expect(JSON.parse(out.trim()).result.content[0].text).toMatch(/Mockingbird is not reachable/);
  });
});
