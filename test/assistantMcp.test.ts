import * as fs from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ASSISTANT_ONLY, Messaging, mcpLaunch, type McpLaunch } from "../src/main/messaging";
import type { SessionInfo } from "../src/shared/types";
import type { AssistantWindowAction } from "../src/shared/assistant";
import type { AssistantDeps, AssistantSession } from "../src/main/assistant/deps";
import { buildRegistry } from "../src/main/assistant/registry";
import * as groups from "../src/main/assistant/tools";
import { AssistantService, CARD_SHOWN } from "../src/main/assistant/service";
import { cliSpawner } from "../src/main/assistant/launch";
import { ASSISTANT_RULES } from "../src/main/assistant/turns";
import type { ShellRunner } from "../src/main/headless";
import { askAs, askRaw, startServer, testLaunch } from "./mcpClient";

/** This Mac's panes, as messaging sees them. */
const panes = [{ id: "front", title: "front", ticketTitle: null, repoPath: "/code/front", branch: "b", taskGroup: "5038", status: "idle", agent: "claude", cwd: "/w/front", kind: "work" } as SessionInfo];
const delivered: string[] = [];
const sock = mcpLaunch("front").env.MOCKINGBIRD_SOCK;

/** The Assistant's view of the app, and what its tools did to it. */
const world: AssistantSession[] = [
  { id: "a1b2c3d4", title: "api-fix", agent: "claude", status: "working", waitingReason: null, waitingSince: null, group: "atticus", room: null, repo: "atticus", branch: "fix", model: "sonnet", permissionMode: "default", mine: true, helpdesk: false },
];
const did: string[] = [];
const deps: AssistantDeps = {
  sessions: () => world,
  groups: () => [{ key: "atticus", stacks: [], sessions: 1, room: null, area: true }],
  rooms: () => [],
  toWindow: (a: AssistantWindowAction) => void did.push(`window ${JSON.stringify(a)}`),
  rename: (id, title) => {
    did.push(`rename ${id} ${title}`);
    world.find((s) => s.id === id)!.title = title;
  },
  relaunchRefusal: () => null,
  relaunch: async (id) => void did.push(`relaunch ${id}`),
};

/** What the fake claude saw: its command, environment and token, and what its MCP server answered. */
let seen: { cmd: string; env: Record<string, string>; token: string; listed: string[]; answers: Record<string, any> } | null = null;
/** The calls the fake claude's model makes, by tool name. */
let calls: [string, Record<string, unknown>][] = [];

/**
 * `claude -p` played by the test: bound as the launch's process (this one), it starts the real MCP server from the
 * --mcp-config it was given, lists its tools and makes `calls` through it, as Claude Code would.
 */
const fakeClaude: ShellRunner = async (cmd, _input, opts) => {
  opts.onSpawn?.(process.pid);
  const cfg = JSON.parse(/--mcp-config '([^']*)'/.exec(cmd)![1]);
  const launch: McpLaunch = cfg.mcpServers.mockingbird;
  const server = startServer(launch);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18" });
    const listed = (await server.request("tools/list")).result.tools.map((t: { name: string }) => t.name);
    const answers: Record<string, any> = {};
    for (const [name, args] of calls) answers[name] = await server.call(name, args);
    seen = { cmd, env: opts.env, token: fs.readFileSync(launch.env.MOCKINGBIRD_TOKEN_FILE, "utf8"), listed, answers };
  } finally {
    await server.stop();
  }
  return { code: 0, out: JSON.stringify({ result: "Done.", is_error: false, session_id: "conv-1" }) };
};

const audit: unknown[] = [];
const log: string[] = [];
const registry = buildRegistry(deps, Object.values(groups));
const svc = new AssistantService({
  registry,
  claudeBin: async () => "/opt/fake/claude",
  spawn: cliSpawner({ run: fakeClaude, env: () => ({ PATH: process.env.PATH ?? "" }) }),
  world: deps,
  audit: { record: (kind, who, more) => void audit.push({ kind, ...who, ...more }) },
  emit: () => {},
  log: (c, e) => void log.push(`${c}: ${e instanceof Error ? e.message : String(e)}`),
});
let relay: Messaging;

/** Run one Assistant turn whose model makes `c`, and wait for it. */
async function turn(c: typeof calls) {
  calls = c;
  seen = null;
  const r = await svc.ask("do it");
  if ("error" in r) throw new Error(r.error);
  for (let i = 0; i < 400; i++) {
    const t = (await svc.view()).turns.find((x) => x.id === r.turnId);
    if (t?.state === "done" || t?.state === "error") return t;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("the turn didn't finish");
}

beforeAll(async () => {
  relay = new Messaging({ list: () => panes, deliverAgentMessage: (to: string) => (delivered.push(to), "delivered") } as any, () => true, () => {}, () => {}, { log: (c, e) => void log.push(`${c}: ${String(e)}`) });
  relay.start();
  relay.setAssistant(svc);
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
});
afterAll(() => fs.rmSync(sock, { force: true }));
beforeEach(() => {
  did.length = 0;
  delivered.length = 0;
});

describe("the Assistant as its own MCP caller", () => {
  it("a turn's server lists only the registry's tools, and its calls go by their tier", async () => {
    const t = await turn([
      ["list_sessions", {}],
      ["rename_session", { session: "a1b2c3d4", title: "api" }],
      ["relaunch_session", { session: "a1b2c3d4" }],
      ["send_message", { to: "front", message: "hello" }],
    ]);
    expect(t).toMatchObject({ state: "done", reply: "Done." });
    expect(seen!.listed.sort()).toEqual(registry.names().sort());
    expect(seen!.listed).not.toContain("send_message");

    // the registry's list_sessions, not a pane's
    const listed = JSON.parse(seen!.answers.list_sessions.content[0].text);
    expect(listed.you).toBeUndefined();
    expect(listed.sessions[0]).toMatchObject({ id: "a1b2c3d4", mine: true, permissionMode: "default" });
    expect(seen!.answers.rename_session.isError).toBe(false);
    expect(seen!.answers.relaunch_session).toMatchObject({ isError: false, content: [{ text: CARD_SHOWN }] });
    // a pane's tool, from the Assistant: refused, and nothing delivered
    expect(seen!.answers.send_message.isError).toBe(true);
    expect(seen!.answers.send_message.content[0].text).toBe("\"send_message\" isn't one of the Assistant's tools.");
    expect(delivered).toEqual([]);
    expect(did).toEqual(["rename a1b2c3d4 api"]);

    // the card ran nothing; Do it does
    const card = (await svc.view()).cards.find((c) => c.tool === "relaunch_session")!;
    expect(await svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(did).toEqual(["rename a1b2c3d4 api", "relaunch a1b2c3d4"]);
  });

  it("runs claude -p with no built-in tools, only Mockingbird's server, only the Assistant's tools allowed, and nothing saved", async () => {
    await turn([]);
    const cmd = seen!.cmd;
    expect(cmd.startsWith("'/opt/fake/claude' -p --model 'sonnet' --output-format json --tools '' --strict-mcp-config --mcp-config '")).toBe(true);
    const allowed = /--allowedTools '([^']*)'/.exec(cmd)![1].split(",");
    expect(allowed.sort()).toEqual(registry.names().map((n) => `mcp__mockingbird__${n}`).sort());
    expect(cmd).toContain(`--append-system-prompt '${ASSISTANT_RULES.replace(/'/g, `'\\''`)}'`);
    expect(cmd.endsWith(" --no-session-persistence")).toBe(true);
    const cfg = JSON.parse(/--mcp-config '([^']*)'/.exec(cmd)![1]);
    expect(Object.keys(cfg.mcpServers)).toEqual(["mockingbird"]);
    expect(cfg.mcpServers.mockingbird.env.MOCKINGBIRD_SESSION).toMatch(/^assistant-t-/);
    // the run's own tag names no pane, so Mockingbird's hooks never take its events for one
    expect(seen!.env.MOCKINGBIRD_SESSION).toMatch(/^app-assistant-mb-app-assistant-/);
    expect(seen!.env.MOCKINGBIRD_SESSION).not.toMatch(/^[0-9a-f]{8}$/);
    expect(seen!.env.ENABLE_TOOL_SEARCH).toBe("false");
  });

  it("a turn's token stops with its turn", async () => {
    await turn([]);
    const after = await askRaw(sock, JSON.stringify({ op: "list_sessions", args: {}, token: seen!.token }));
    expect(after.error).toMatch(/doesn't recognise this tool server/);
  });

  it("an Assistant token whose turn isn't running gets no tools", async () => {
    const stale = testLaunch("assistant-t-stale");
    const token = fs.readFileSync(stale.env.MOCKINGBIRD_TOKEN_FILE, "utf8");
    expect(await askRaw(sock, JSON.stringify({ op: "list_sessions", args: {}, token }))).toEqual({ error: expect.stringContaining("turn has ended") });
    const server = startServer(stale);
    try {
      await server.request("initialize", {});
      expect((await server.request("tools/list")).error.message).toContain("turn has ended");
    } finally {
      await server.stop();
    }
    expect(did).toEqual([]);
  });

  it("a pane's or a Council seat's token can't use the Assistant's tools, and keeps its own", async () => {
    expect(await askAs(sock, { from: "front", op: "rename_session", args: { session: "a1b2c3d4", title: "x" } })).toEqual({ error: ASSISTANT_ONLY });
    expect(await askAs(sock, { from: "front", op: "relaunch_session", args: { session: "a1b2c3d4" } })).toEqual({ error: ASSISTANT_ONLY });
    expect(await askAs(sock, { from: "collab-room1.seat1", op: "focus_session", args: { session: "a1b2c3d4" } })).toEqual({ error: ASSISTANT_ONLY });
    expect(did).toEqual([]);
    // list_sessions is the pane's own tool too: it gets its own
    expect((await askAs(sock, { from: "front", op: "list_sessions" })).result.you).toEqual({ id: "front", title: "front" });
    // and its server lists none of the Assistant's
    const server = startServer(testLaunch("front"));
    try {
      await server.request("initialize", {});
      const names = (await server.request("tools/list")).result.tools.map((t: { name: string }) => t.name);
      for (const n of ["rename_session", "relaunch_session", "focus_session", "list_groups"]) expect(names).not.toContain(n);
    } finally {
      await server.stop();
    }
  });
});
