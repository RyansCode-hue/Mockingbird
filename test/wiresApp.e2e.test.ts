import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { appE2E, launchApp, mainLog, quitApp, untilTrue, type AppInstance } from "./e2e/appInstance";
import type { McpLaunch } from "../src/main/messaging";
import type { WireChange, WireReply, WireState } from "../src/shared/wires";
import { askRaw, startServer } from "./mcpClient";
import { tempDir } from "./helpers";

/**
 * The wire book and who's calling, in the real app (dist/, under Electron): its IPC, the `sessions:kill` hook, the quit
 * step and the start's sweep, none of which a unit test reaches, and the real MCP script run by Electron's own binary
 * from what each CLI's arguments say, as the CLI would. The agents are a stand-in that keeps its arguments: nothing
 * calls a model. Windows open on screen while it runs, so it's opt-in:
 *
 *   npm run build && MB_E2E_APP=1 npx vitest run test/wiresApp.e2e.test.ts
 */

const FAKE_AGENT = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2.1.0 (stand-in)"; exit 0; fi
if [ -z "$MOCKINGBIRD_SESSION" ]; then exit 0; fi
mkdir -p "$HOME/argv"
printf '%s\\0' "$@" > "$HOME/argv/$MOCKINGBIRD_SESSION.tmp"
mv -f "$HOME/argv/$MOCKINGBIRD_SESSION.tmp" "$HOME/argv/$MOCKINGBIRD_SESSION"
echo "agent started"
while IFS= read -r line; do echo "got: $line"; done
`;

/** The MCP server's launch, read from a CLI's arguments as that CLI would read it. */
function launchFrom(argv: string[]): McpLaunch {
  const i = argv.indexOf("--mcp-config");
  if (i >= 0) {
    const m = JSON.parse(argv[i + 1]).mcpServers.mockingbird;
    return { command: m.command, args: m.args, env: m.env };
  }
  const value = (k: string) => argv.find((a) => a.startsWith(`mcp_servers.mockingbird.${k}=`))!.slice(`mcp_servers.mockingbird.${k}=`.length);
  const env = Object.fromEntries([...value("env").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { command: JSON.parse(value("command")), args: JSON.parse(value("args")), env };
}

const argvFile = (a: AppInstance, id: string) => path.join(a.home, "argv", id);
const tokensIn = (home: string) => {
  const dir = path.join(home, ".mockingbird", "mcp-tokens");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const onDisk = (home: string) => JSON.parse(fs.readFileSync(path.join(home, ".mockingbird", "landscape.json"), "utf8"));
const sockOf = (home: string) => path.join(home, ".mockingbird", "mb.sock");
const parsed = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

async function launchOf(a: AppInstance, id: string, not?: string): Promise<McpLaunch> {
  const read = () => (fs.existsSync(argvFile(a, id)) ? fs.readFileSync(argvFile(a, id), "utf8") : null);
  await untilTrue(`${id}'s agent started`, async () => read() !== null && read() !== not);
  return launchFrom(read()!.split("\0"));
}

const session = (a: AppInstance, agent: "claude" | "codex", title: string) => a.evaluate<{ id: string; error?: string }>(`window.mb.createSession({ repoPath: null, useWorktree: false, agent: ${JSON.stringify(agent)}, title: ${JSON.stringify(title)} })`);

describe.skipIf(!appE2E)("wires in the real app", () => {
  it("knows each pane's server by its token alone, keeps the book in landscape.json, drops a forgotten session's wires, and leaves no token behind", async () => {
    const dir = tempDir("wires-agent");
    const agent = path.join(dir, "agent");
    fs.writeFileSync(agent, FAKE_AGENT, { mode: 0o755 });
    let app = await launchApp("Wires", "", { settings: { claudeBin: agent, codexBin: agent } });
    const { home } = app;
    try {
      const builder = await session(app, "claude", "Builder");
      const reviewer = await session(app, "codex", "Reviewer");
      expect(builder.error ?? reviewer.error).toBeUndefined();

      // each CLI's arguments hold a path, and the real script, run by Electron's binary, answers as that pane
      const claudeLaunch = await launchOf(app, builder.id);
      const codexLaunch = await launchOf(app, reviewer.id);
      expect(claudeLaunch.command).toBe(codexLaunch.command);
      const claudeToken = fs.readFileSync(claudeLaunch.env.MOCKINGBIRD_TOKEN_FILE, "utf8");
      expect(fs.readFileSync(argvFile(app, builder.id), "utf8")).not.toContain(claudeToken);
      const claude = startServer(claudeLaunch);
      const codex = startServer(codexLaunch);
      try {
        const listed = parsed(await claude.call("list_sessions"));
        expect(listed.you.id).toBe(builder.id);
        expect(listed.sessions.map((s: any) => [s.id, s.agent])).toEqual([[reviewer.id, "codex"]]);
        expect(parsed(await codex.call("list_sessions")).you.id).toBe(reviewer.id);
        expect(fs.readFileSync(claudeLaunch.env.MOCKINGBIRD_TOKEN_FILE, "utf8")).toBe(claudeToken);
        expect((await claude.call("send_message", { to: reviewer.id, message: "hello" })).content[0].text).toMatch(/^Delivered to "Reviewer"/);
        // nothing else gets an answer: not a forged `from`, and not a server without a token
        expect((await askRaw(sockOf(home), JSON.stringify({ op: "list_sessions", from: builder.id }))).error).toMatch(/^Mockingbird doesn't recognise this tool server/);
        // a second and a third server from the same launch (a sub-agent's, a reconnect) answer as it too
        for (let i = 0; i < 2; i++) {
          const again = startServer(claudeLaunch);
          try {
            expect(parsed(await again.call("list_sessions")).you.id).toBe(builder.id);
          } finally {
            await again.stop();
          }
        }

        // no wires yet, and the tool says so
        expect(parsed(await claude.call("list_links"))).toEqual({ you: { id: builder.id, title: "Builder" }, links: [], note: "This workspace has no wires." });

        // a wire, through the window's IPC, saved at once beside the layout
        await app.evaluate(`(window.__wires = [], window.mb.onWiresChanged((c) => window.__wires.push(c)), 1)`);
        const before = await app.evaluate<{ rev: number }>(`window.mb.landscapeGet()`);
        const made = await app.evaluate<WireReply & { id: string }>(`window.mb.wiresAdd(${JSON.stringify(builder.id)}, ${JSON.stringify(reviewer.id)}, "handoff")`);
        expect(made).not.toHaveProperty("refused");
        expect(onDisk(home)).toMatchObject({ v: 3, wires: { wv: 1, links: { [made.id]: { from: builder.id, to: reviewer.id, type: "handoff", gate: "ask" } } } });
        expect((await app.evaluate<{ rev: number }>(`window.mb.landscapeGet()`)).rev).toBe(before.rev);
        expect(parsed(await claude.call("list_links")).links).toEqual([{ wire: made.id, direction: "out", type: "handoff", other: { id: reviewer.id, title: "Reviewer", where: "running" }, state: "idle" }]);
        expect(parsed(await codex.call("list_links")).links[0]).toMatchObject({ wire: made.id, direction: "in" });
        expect(await app.evaluate<{ refused?: string }>(`window.mb.wiresAdd(${JSON.stringify(builder.id)}, "r~abc", "handoff")`)).toEqual({ refused: expect.stringMatching(/teammate's session/) });

        // a window can't write the book through a layout patch
        expect(await app.evaluate<{ error?: string }>(`window.mb.landscapeUpdate({ wires: { wv: 1, links: {}, notes: {} } })`)).toEqual({ error: expect.stringMatching(/doesn't know \(wires\)/) });

        // a restart rotates the token: the old server is told, a new one works, and the wire doesn't notice
        const seen = fs.readFileSync(argvFile(app, builder.id), "utf8");
        expect(await app.evaluate<{ failed: unknown[] }>(`window.mb.restartAllSessions(true)`)).toMatchObject({ failed: [] });
        const again = await launchOf(app, builder.id, seen);
        expect(again.env.MOCKINGBIRD_TOKEN_FILE).not.toBe(claudeLaunch.env.MOCKINGBIRD_TOKEN_FILE);
        const old = await claude.call("list_sessions");
        expect(old.isError).toBe(true);
        expect(old.content[0].text).toMatch(/: its token is from a launch that has ended/);
        // one started from the ended launch is refused, saying its file has gone; main.log has the old server refused as
        // not from the pane's running launch, which it can't speak for
        const late = startServer(claudeLaunch);
        try {
          expect((await late.call("list_sessions")).content[0].text).toMatch(/: its token file is gone/);
        } finally {
          await late.stop();
        }
        await untilTrue("the ended launch's server logged", async () => /messaging: A tool server naming "Builder" \(.+\), not from its running launch, was refused: its token is from a launch that has ended/.test(mainLog(app)));
        // the running launch's own server, kept from its file, is the one that lost its tools
        fs.chmodSync(again.env.MOCKINGBIRD_TOKEN_FILE, 0o000);
        const blocked = startServer(again);
        try {
          expect((await blocked.call("list_sessions")).content[0].text).toMatch(/: its token file couldn't be read \(EACCES\)\./);
        } finally {
          await blocked.stop();
          fs.chmodSync(again.env.MOCKINGBIRD_TOKEN_FILE, 0o600);
        }
        await untilTrue("the lost tools logged", async () => /messaging: The tool server of "Builder" \(.+\) lost its Mockingbird tools: its token file couldn't be read \(EACCES\)/.test(mainLog(app)));
        const fresh = startServer(again);
        try {
          expect(parsed(await fresh.call("list_links")).links[0]).toMatchObject({ wire: made.id, direction: "out" });
        } finally {
          await fresh.stop();
        }

        // Forget takes its wires with it, and the window hears which
        expect(await app.evaluate<{ error?: string } | undefined>(`window.mb.killSession(${JSON.stringify(reviewer.id)}, true)`)).toBeFalsy();
        expect((await app.evaluate<WireState>(`window.mb.wiresGet()`)).book!.links).toEqual({});
        expect(onDisk(home).wires.links).toEqual({});
        const told = await app.evaluate<WireChange[]>(`window.__wires`);
        expect(told.at(-1)!.dropped!.map((d) => d.id)).toEqual([made.id]);
      } finally {
        await claude.stop();
        await codex.stop();
      }

      // a launch whose server never starts: its file is there until the app quits, and not after
      const unread = await session(app, "claude", "Unread");
      await launchOf(app, unread.id);
      expect(tokensIn(home).length).toBeGreaterThan(0);
      await app.evaluate<WireReply>(`window.mb.wiresAdd(${JSON.stringify(builder.id)}, ${JSON.stringify(unread.id)}, "context")`);
      expect(fs.statSync(path.join(home, ".mockingbird", "mcp-tokens")).mode & 0o777).toBe(0o700);
      app.close();
      expect((await quitApp(app.child)).leftovers).toEqual([]);
      expect(mainLog(app)).not.toMatch(/[0-9a-f]{64}/);
      expect(tokensIn(home)).toEqual([]);

      // what a crash would have left goes when the app next starts, and the book reads back
      const stray = path.join(home, ".mockingbird", "mcp-tokens", "f".repeat(32));
      fs.writeFileSync(stray, "from a run that crashed", { mode: 0o600 });
      app = await launchApp("Wires", "", { home, keepState: true, settings: { claudeBin: agent, codexBin: agent } });
      await untilTrue("the stray token swept", async () => !fs.existsSync(stray));
      const state = await app.evaluate<WireState>(`window.mb.wiresGet()`);
      expect(Object.values(state.book!.links)).toEqual([expect.objectContaining({ from: builder.id, to: unread.id, type: "context" })]);
      expect(state).toMatchObject({ refused: null, problems: [] });
    } finally {
      app.close();
      await quitApp(app.child);
    }
  }, 120_000);
});
