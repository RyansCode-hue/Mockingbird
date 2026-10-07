import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { appE2E, e2eSignaling, launchApp, mainLog, quitApp, root, routes, untilTrue, type AppInstance } from "./e2e/appInstance";
import type { LivePanesState } from "../src/shared/team/livePanes";
import type { TakeoverPlan, TakeoverView } from "../src/shared/team/takeover";
import type { PlanView } from "../src/shared/team/plan";
import type { RoomChatView as ChatView } from "../src/shared/team/chat";

/**
 * Team rooms between two real Mockingbird instances on one Mac (separate HOME
 * and userData, real WebRTC), through the local signaling server or the
 * deployed Worker at MB_E2E_SIGNALING_URL. Ryan shares a group; Nick joins.
 * Live panes (a shared terminal Nick watches and types into), the team chat,
 * the plan board, a room session's backup after an agent turn, and Nick
 * taking it over once Ryan's Mockingbird has quit — then Ryan's coming back
 * to it taken over. The agent is a stand-in for Claude Code (FAKE_CLAUDE):
 * nothing calls a model. Windows open on screen while it runs, so it's opt-in:
 *
 *   MB_E2E_APP=1 npx vitest run test/teamLiveApp.e2e.test.ts
 *
 * Against a deployed Worker (its ALLOWED_CREATORS must hold the fingerprint
 * `npm run team:e2e-fingerprint` prints), with a variant that allows only
 * TURN relay candidates, so the fallback carries everything:
 *
 *   MB_E2E_APP=1 MB_E2E_SIGNALING_URL=https://… npx vitest run test/teamLiveApp.e2e.test.ts
 */

const CONV = "e2e00000-0000-4000-8000-000000000001";
/**
 * Claude Code's stand-in: says how it was started, then runs a "turn" for each
 * line typed into it — the hook events Mockingbird reads (as hook.sh leaves
 * them), a line in notes.txt and one in its conversation's transcript.
 */
const FAKE_CLAUDE = `#!/bin/bash
conv=${CONV}
if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code stand-in)"; exit 0; fi
echo "fake-claude started: $*"
cwd=$(pwd -P)
dir="$HOME/.claude/projects/$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$dir"
transcript="$dir/$conv.jsonl"
events="$HOME/.mockingbird/events"
emit() {
  mkdir -p "$events"
  tmp=$(mktemp "$events/.tmp.XXXXXXXX") || return
  printf '{"event":"%s","ts":%s,"pane":"%s","payload":{"session_id":"%s","cwd":"%s","transcript_path":"%s","prompt":"%s"}}\\n' "$1" "$(date +%s)" "$MOCKINGBIRD_SESSION" "$conv" "$cwd" "$transcript" "$2" > "$tmp"
  mv -f "$tmp" "$events/$(date +%s)-\${tmp##*.}.json"
}
while IFS= read -r line; do
  line=\${line//[^A-Za-z0-9 -]/}
  emit UserPromptSubmit "$line"
  printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"%s"}}\\n' "$conv" "$cwd" "$line" >> "$transcript"
  echo "$line" >> notes.txt
  echo "did: $line"
  sleep 1
  emit Stop ""
done
`;

const live = (a: AppInstance) => a.evaluate<LivePanesState>("window.mb.teamLive()");
const takeovers = (a: AppInstance) => a.evaluate<TakeoverView>("window.mb.teamTakeover()");
const buffer = (a: AppInstance, id: string) => a.evaluate<string>(`window.mb.sessionBuffer(${JSON.stringify(id)})`);
/** What a pane's terminal shows in a window, as text. */
const screenOf = (a: AppInstance, id: string) =>
  a.evaluate<string>(`(() => { const e = window.__mbTerms?.get(${JSON.stringify(id)}); if (!e) return ""; const b = e.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ""); return out.join("\\n"); })()`);
/** A sidebar row's text and controls, by its session's title. */
const row = (title: string) => `[...document.querySelectorAll(".sess-item")].find((r) => r.textContent.includes(${JSON.stringify(title)}))`;

/** A bare origin and each laptop's clone of it, in a folder its Mockingbird indexes. */
function repos() {
  const seed = makeRepo({ "README.md": "backoffice\n", "src/donors.ts": "export const donors = [];\n" }, "backoffice");
  const bare = path.join(tempDir("origin"), "backoffice.git");
  execFileSync("git", ["clone", "--bare", "-q", seed, bare]);
  const code = (who: string) => {
    const dir = tempDir(`${who}-code`);
    execFileSync("git", ["clone", "-q", bare, path.join(dir, "backoffice")]);
    return { dir, clone: path.join(dir, "backoffice") };
  };
  return { bare, ryan: code("ryan"), nick: code("nick") };
}

async function connect(signal: { url: string; real: boolean; creatorHome?: string }, ryan: AppInstance, nick: AppInstance) {
  const share = await ryan.evaluate<{ roomId: string; invite: string; error?: string }>(`window.mb.teamShareGroup("5110", "#5110 Donor entities")`);
  expect(share.error).toBeUndefined();
  await untilTrue("Ryan's signaling", async () => (await ryan.status()).rooms[0]?.signaling === "online");
  await nick.evaluate(`window.mb.teamJoin(${JSON.stringify(share.invite)})`);
  await untilTrue("both connected", async () => (await ryan.status()).rooms[0]?.online.length === 1 && (await nick.status()).rooms[0]?.online.length === 1, 90_000);
  const paths = await routes(ryan, nick);
  if (signal.real) console.log(`[e2e] connected through ${signal.url}: Ryan's link ${paths[0]}, Nick's ${paths[1]}`);
  for (const p of paths) expect(p).toMatch(signal.real ? /^(direct|turn)$/ : /^direct$/);
  return { roomId: share.roomId, paths };
}

describe("team rooms between two Mockingbird instances", () => {
  it.skipIf(!appE2E)(
    "live panes, chat, the plan board, a backed-up turn, and a take-over while the owner is away",
    async () => {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "ignore" });
      const signal = await e2eSignaling();
      const r = repos();
      const stub = path.join(tempDir("bin"), "claude");
      fs.writeFileSync(stub, FAKE_CLAUDE, { mode: 0o755 });
      const settings = (code: string) => ({ claudeBin: stub, repoRoots: [code] });
      let ryan = await launchApp("Ryan", signal.url, { home: signal.creatorHome, settings: settings(r.ryan.dir) });
      const nick = await launchApp("Nick", signal.url, { settings: settings(r.nick.dir) });
      try {
        const { roomId } = await connect(signal, ryan, nick);
        const nickId = (await nick.status()).self!.id;
        const ryanId = (await ryan.status()).self!.id;

        // ---- live panes: Ryan's terminal in the shared group, watched and typed into by Nick
        const sh = await ryan.evaluate<{ id: string; error?: string }>(`window.mb.createSession({ repoPath: null, useWorktree: false, shell: true, taskGroup: "5110", title: "shared shell" })`);
        expect(sh.error).toBeUndefined();
        await new Promise((res) => setTimeout(res, 1500)); // the login shell starts
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(sh.id)}, "echo ready-$((40+2))\\r")`);
        await untilTrue("Ryan's output", async () => (await buffer(ryan, sh.id)).includes("ready-42"));
        let paneId = "";
        await untilTrue("the session on Nick's side", async () => {
          paneId = (await live(nick)).remote.find((x) => x.room?.sessionId === sh.id)?.id ?? "";
          return !!paneId;
        });
        await untilTrue("Nick's sidebar row", async () => nick.evaluate<boolean>(`${row("shared shell")}?.querySelector(".team-owner")?.textContent === "R"`));
        await nick.evaluate(`${row("shared shell")}.click()`);
        await untilTrue("the scrollback in Nick's pane", async () => (await screenOf(nick, paneId)).includes("ready-42"));
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(sh.id)}, "echo live-$((50+5))\\r")`);
        await untilTrue("live output in Nick's pane", async () => (await screenOf(nick, paneId)).includes("live-55"));
        await nick.evaluate(`(() => { const t = window.__mbTerms.get(${JSON.stringify(paneId)}).term; t.element.closest(".pane").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); t.focus(); })()`);
        await nick.send("Input.insertText", { text: "echo from-nick-$((6*7))" });
        await nick.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await nick.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await untilTrue("Nick's typing in Ryan's shell", async () => (await buffer(ryan, sh.id)).includes("from-nick-42"));
        await untilTrue("the result back in Nick's pane", async () => (await screenOf(nick, paneId)).includes("from-nick-42"));
        await untilTrue("Nick's initials on Ryan's session", async () => (await live(ryan)).own[sh.id]?.lookers.some((l) => l.name === "Nick" && l.focused) ?? false);
        expect((await live(ryan)).own[sh.id]).toMatchObject({ cols: 120, rows: 32 });
        expect(fs.readFileSync(path.join(ryan.home, ".mockingbird", "pty-audit.log"), "utf8")).toMatch(/remote-input session=\S+ from="Nick"/);

        // ---- the team chat: Nick's message reaches Ryan
        expect(await nick.evaluate(`window.mb.teamChatPost(${JSON.stringify(roomId)}, "morning, taking the export")`)).not.toHaveProperty("error");
        await untilTrue("Nick's message at Ryan's", async () =>
          (await ryan.evaluate<ChatView>(`window.mb.teamChatView(${JSON.stringify(roomId)})`)).entries.some((e) => e.kind === "message" && e.text === "morning, taking the export" && e.author === nickId)
        );

        // ---- the plan board: Ryan proposes a package, Nick claims it, Ryan sees whose it is
        const created = await ryan.evaluate<{ pkg: string }>(`window.mb.planApply(${JSON.stringify(roomId)}, { kind: "create", title: "Donor export", paths: ["src/export/"] })`);
        expect(created.pkg).toMatch(/^p-/);
        await untilTrue("the package at Nick's", async () => (await nick.evaluate<PlanView>(`window.mb.planGet(${JSON.stringify(roomId)})`)).plan.packages.some((p) => p.id === created.pkg));
        expect(await nick.evaluate(`window.mb.planApply(${JSON.stringify(roomId)}, { kind: "claim", id: ${JSON.stringify(created.pkg)} })`)).not.toHaveProperty("error");
        await untilTrue("Nick's claim at Ryan's", async () =>
          (await ryan.evaluate<PlanView>(`window.mb.planGet(${JSON.stringify(roomId)})`)).plan.packages.find((p) => p.id === created.pkg)?.owner === nickId
        );

        // ---- an agent session of Ryan's in the room: a turn ends, it's backed up, Nick sees how fresh
        const s = await ryan.evaluate<{ id: string; cwd: string; error?: string }>(
          `window.mb.createSession({ repoPath: ${JSON.stringify(r.ryan.clone)}, useWorktree: true, branchName: "5110-donors", agent: "claude", taskGroup: "5110", title: "Donor entities" })`
        );
        expect(s.error).toBeUndefined();
        await untilTrue("the agent to start", async () => (await buffer(ryan, s.id)).includes("fake-claude started"), 20_000);
        expect(await buffer(ryan, s.id)).toMatch(/--append-system-prompt/); // the room's plan, carried in the launch
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(s.id)}, "add the donor notes\\r")`);
        await untilTrue("the turn", async () => (await buffer(ryan, s.id)).includes("did: add the donor notes"));
        await untilTrue(
          "the backup on origin, its snapshot and conversation at Nick's",
          async () => {
            const b = (await takeovers(nick)).sessions.find((v) => v.sessionId === s.id && v.owner === ryanId);
            return !!b?.pushed && !!b.peerCopy && (b.transcript?.have ?? 0) > 0;
          },
          60_000
        );
        expect(git(r.bare, "for-each-ref", "--format=%(refname)", "refs/mockingbird/rooms")).toContain(`/${s.id}`);
        await untilTrue("the freshness on Nick's row", async () => /^backed up/.test(await nick.evaluate<string>(`${row("Donor entities")}?.querySelector(".tk-fresh")?.textContent ?? ""`)));
        expect(await nick.evaluate<boolean>(`!!${row("Donor entities")}?.querySelector(".tk-btn")`)).toBe(true);

        // ---- Ryan's Mockingbird quits; Nick takes the session over from his sidebar
        ryan.close();
        await quitApp(ryan.child);
        await untilTrue("Ryan offline at Nick's", async () => (await nick.status()).rooms[0]?.online.length === 0, 60_000);
        await untilTrue("Take over, prominent", async () => nick.evaluate<boolean>(`!!${row("Donor entities")}?.querySelector(".tk-btn.primary")`));
        const plan = await nick.evaluate<TakeoverPlan>(`window.mb.teamTakeoverPlan(${JSON.stringify(roomId)}, ${JSON.stringify(s.id)}, null)`);
        expect(plan).toMatchObject({ ownerOnline: false, branch: "5110-donors", conversation: { kind: "full" }, latestMissing: false });
        expect(fs.realpathSync(plan.clone!)).toBe(fs.realpathSync(r.nick.clone));
        await nick.evaluate(`${row("Donor entities")}.querySelector(".tk-btn").click()`);
        await untilTrue("the dialog's plan", async () => nick.evaluate<boolean>(`(() => { const b = [...document.querySelectorAll(".tk-dlg button.primary")].find((x) => x.textContent === "Take over"); return !!b && !b.disabled; })()`));
        await nick.evaluate(`[...document.querySelectorAll(".tk-dlg button.primary")].find((x) => x.textContent === "Take over").click()`);
        await untilTrue("the take-over done", async () => /Running here now/.test(await nick.evaluate<string>(`document.querySelector(".tk-dlg")?.textContent ?? ""`)), 60_000);
        const view = (await takeovers(nick)).sessions.find((v) => v.sessionId === s.id)!;
        expect(view.takenOver).toMatchObject({ by: nickId, conversation: "full" });
        const mine = (await nick.evaluate<{ id: string; cwd: string; branch: string | null; taskGroup: string | null }[]>("window.mb.listSessions()")).find((x) => x.id === view.takenOver!.newSessionId)!;
        // the work in a worktree of Nick's clone, on the session's branch, the conversation resumed
        expect(mine).toMatchObject({ branch: "5110-donors", taskGroup: "5110" });
        expect(fs.readFileSync(path.join(mine.cwd, "notes.txt"), "utf8")).toBe("add the donor notes\n");
        expect(git(mine.cwd, "rev-parse", "--show-toplevel")).not.toBe(fs.realpathSync(r.nick.clone));
        await untilTrue("the resumed agent", async () => (await buffer(nick, mine.id)).includes(`fake-claude started: --resume ${CONV}`), 20_000);
        // the room's session is Nick's now; Ryan's copy no longer shows
        expect((await live(nick)).own[mine.id]).toMatchObject({ roomId, remote: false });
        expect((await live(nick)).remote.some((x) => x.room?.sessionId === s.id)).toBe(false);
        await untilTrue("the old row gone from Nick's sidebar", async () => !(await nick.evaluate<boolean>(`[...document.querySelectorAll(".sess-item")].some((x) => x.textContent.includes("Donor entities") && x.querySelector(".team-owner")?.textContent === "R")`)));

        // ---- Ryan's Mockingbird starts again: his copy has left the room, taken over by Nick
        ryan = await launchApp("Ryan", signal.url, { home: ryan.home, keepState: true });
        await untilTrue("Ryan back", async () => (await ryan.status()).rooms[0]?.online.length === 1, 90_000);
        await untilTrue("Ryan's copy marked taken over", async () => (await live(ryan)).own[s.id]?.takenOver?.byName === "Nick", 30_000);
        await untilTrue("Nick's session at Ryan's", async () => (await live(ryan)).remote.some((x) => x.room?.sessionId === mine.id && x.room.owner === nickId));
        await untilTrue("Ryan's row says so", async () => /taken over by Nick/.test(await ryan.evaluate<string>(`[...document.querySelectorAll(".sess-item")].filter((x) => x.textContent.includes("Donor entities")).map((x) => x.textContent).join("|")`)));
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- Ryan's log ---\n${mainLog(ryan).slice(-4000)}\n--- Nick's log ---\n${mainLog(nick).slice(-4000)}`);
      } finally {
        ryan.close();
        nick.close();
        await Promise.all([quitApp(ryan.child), quitApp(nick.child)]);
        await signal.close();
      }
    },
    360_000
  );

  it.skipIf(!appE2E || !process.env.MB_E2E_SIGNALING_URL)(
    "connects through the Worker's TURN relay when only relayed paths are allowed, and the room works over it",
    async () => {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "ignore" });
      const signal = await e2eSignaling();
      const env = { MOCKINGBIRD_E2E_RELAY_ONLY: "1" };
      const ryan = await launchApp("Ryan", signal.url, { home: signal.creatorHome, env });
      const nick = await launchApp("Nick", signal.url, { env });
      try {
        const { roomId, paths } = await connect(signal, ryan, nick);
        expect(paths).toEqual(["turn", "turn"]);
        const nickId = (await nick.status()).self!.id;
        await nick.evaluate(`window.mb.teamChatPost(${JSON.stringify(roomId)}, "over the relay")`);
        await untilTrue("Nick's message at Ryan's", async () =>
          (await ryan.evaluate<ChatView>(`window.mb.teamChatView(${JSON.stringify(roomId)})`)).entries.some((e) => e.text === "over the relay" && e.author === nickId)
        );
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- Ryan's log ---\n${mainLog(ryan).slice(-4000)}\n--- Nick's log ---\n${mainLog(nick).slice(-4000)}`);
      } finally {
        ryan.close();
        nick.close();
        await Promise.all([quitApp(ryan.child), quitApp(nick.child)]);
        await signal.close();
      }
    },
    180_000
  );
});
