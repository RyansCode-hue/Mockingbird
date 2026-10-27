import { execFile, execFileSync } from "child_process";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { acceptInWindow, appE2E, e2eSignaling, launchApp, mainLog, quitApp, root, routes, untilTrue, type AppInstance } from "./e2e/appInstance";
import type { LivePanesState } from "../src/shared/team/livePanes";
import type { TakeoverPlan, TakeoverView } from "../src/shared/team/takeover";
import type { HouseView } from "../src/shared/team/house";
import { builderHome, fakeHouse } from "./fakeHouse";
import type { RoomChatView as ChatView } from "../src/shared/team/chat";
import type { MigrationsView } from "../src/shared/team/migrations";
import type { OverlapsFile } from "../src/shared/team/overlaps";

/** A Mockingbird MCP tool call, as an agent in session `from` makes it: through the app's own socket. */
const tool = (a: AppInstance, from: string, op: string, args: Record<string, unknown> = {}) =>
  new Promise<{ result?: string; error?: string }>((resolve, reject) => {
    const c = net.createConnection(path.join(a.home, ".mockingbird", "mb.sock"));
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    c.on("error", reject);
    c.end(JSON.stringify({ op, args, from }));
  });

/** An agent's edit (Claude Code's PreToolUse) through an instance's installed hook script: what it answers. */
const editHook = (a: AppInstance, sessionId: string, cwd: string, toolName: "Edit" | "Write", file: string) =>
  new Promise<string>((resolve, reject) => {
    const input = toolName === "Write" ? { file_path: path.join(cwd, file), content: "-- x\n" } : { file_path: path.join(cwd, file), old_string: "a", new_string: "b" };
    const child = execFile(path.join(a.home, ".mockingbird", "hook.sh"), ["PreToolUse"], { cwd, env: { HOME: a.home, PATH: "/usr/bin:/bin", MOCKINGBIRD_SESSION: sessionId } }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin!.end(JSON.stringify({ session_id: `conv-${sessionId}`, cwd, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input }));
  });

/**
 * Team rooms between two real Mockingbird instances on one Mac (separate HOME
 * and userData, real WebRTC), through the local signaling server or the
 * deployed Worker at MB_E2E_SIGNALING_URL. Ryan shares a group; Nick joins.
 * Live panes (a shared terminal Nick watches and types into), the team chat,
 * the Radley House board (against a fake House over https on this Mac, each
 * member with their own token), a room session's backup after an agent turn, Nick asking
 * for a session while Ryan is connected and Ryan handing it over from his
 * prompt (his agent stops, Nick's continues), and Nick taking one over once
 * Ryan's Mockingbird has quit — then Ryan's coming back to it, his copy
 * stopped even though it ran again at start. The agent is a stand-in for Claude Code (FAKE_CLAUDE):
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

/** The stand-in's conversation for a session started fresh: its own, as Claude's would be. */
const convOf = (sessionId: string) => `e2e-${sessionId}`;
/**
 * Claude Code's stand-in: says how it was started, then runs a "turn" for each
 * line typed into it — the hook events Mockingbird reads (as hook.sh leaves
 * them), a line in notes.txt and one in its conversation's transcript. Started
 * with --resume, it carries on that conversation. A pasted message (a
 * take-over's brief) is read whole and runs no turn.
 */
const FAKE_CLAUDE = `#!/bin/bash
conv="e2e-$MOCKINGBIRD_SESSION"
if [ "$1" = "--resume" ]; then conv="$2"; fi
if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code stand-in)"; exit 0; fi
echo "fake-claude started: $* (inline=\${CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:-no})"
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
paste=
while IFS= read -r line; do
  # a pasted message (a take-over's brief) is read whole and runs no turn
  if [[ "$line" == *$'\\e[200~'* ]]; then paste=1; fi
  if [ -n "$paste" ]; then
    if [[ "$line" == *$'\\e[201~'* ]]; then paste=; echo "fake-claude got a brief"; fi
    continue
  fi
  line=\${line//[^A-Za-z0-9 -]/}
  [ -z "$line" ] && continue
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
/**
 * A teammate's session row, as a person finds it: teammates' sessions are in
 * the Team room view, opened from the Sessions view's Connected sessions line
 * (with one room, straight on it). Opens the view when it isn't showing.
 */
const teamRow = (title: string) =>
  `(() => { if (!document.querySelector(".room-sess-body")) document.querySelector(".connected-line")?.click(); return [...document.querySelectorAll(".room-sess-body .sess-item")].find((r) => r.textContent.includes(${JSON.stringify(title)})); })()`;
/** The words under a room session's name: whose it is, whether it runs, who's looking. */
const whoLine = (title: string) => `(${teamRow(title)}?.querySelector(".br.who")?.textContent ?? "")`;
/** A row's Take over button (shown on hover or focus; clicking it works either way). */
const takeOverOf = (title: string) => `${teamRow(title)}?.querySelector('.lbtn[data-action="takeover"]')`;
/** For a failure: the dialogs open in an instance's window, each with its title and buttons; or that it shows none, or can't be read (a closed connection never answers). */
const dialogsOf = (a: AppInstance) =>
  Promise.race([
    a
      .evaluate<string[]>(
        `[...document.querySelectorAll(".modal")].map((m) => \`\${m.className}: \${m.querySelector("h3")?.textContent ?? ""} [\${[...m.querySelectorAll("button")].map((b) => b.textContent + (b.disabled ? " (disabled)" : "")).join(", ")}]\`)`
      )
      .then((d) => (d.length ? d.join("\n") : "(none)"))
      .catch((err) => `(unreadable: ${(err as Error).message})`),
    new Promise<string>((r) => setTimeout(() => r("(unreadable: no answer within 3 s)"), 3000)),
  ]);

/** A bare origin and each laptop's clone of it, in a folder its Mockingbird indexes. */
function repos(extra: Record<string, string> = {}) {
  const seed = makeRepo({ "README.md": "backoffice\n", "src/donors.ts": "export const donors = [];\n", ...extra }, "backoffice");
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
  await acceptInWindow(ryan, nick, share.roomId);
  await untilTrue("both connected", async () => (await ryan.status()).rooms[0]?.online.length === 1 && (await nick.status()).rooms[0]?.online.length === 1, 90_000);
  const paths = await routes(ryan, nick);
  if (signal.real) console.log(`[e2e] connected through ${signal.url}: Ryan's link ${paths[0]}, Nick's ${paths[1]}`);
  for (const p of paths) expect(p).toMatch(signal.real ? /^(direct|turn)$/ : /^direct$/);
  return { roomId: share.roomId, paths };
}

describe("team rooms between two Mockingbird instances", () => {
  it.skipIf(!appE2E)(
    "live panes, chat, the House board, a backed-up turn, a hand-over from the owner's prompt, and a take-over while the owner is offline, with no grant",
    async () => {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "ignore" });
      const signal = await e2eSignaling();
      const r = repos();
      const stub = path.join(tempDir("bin"), "claude");
      fs.writeFileSync(stub, FAKE_CLAUDE, { mode: 0o755 });
      const settings = (code: string) => ({ claudeBin: stub, repoRoots: [code] });
      // the House: https with a certificate made for this run, trusted by the apps through NODE_EXTRA_CA_CERTS
      const tls = tempDir("house-tls");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
      const house = await fakeHouse({ "tok-ryan-e2e": "Ryan", "tok-nick-e2e": "Nick" }, { tls: { key: fs.readFileSync(path.join(tls, "key.pem"), "utf8"), cert: fs.readFileSync(path.join(tls, "cert.pem"), "utf8") } });
      house.item(141, { title: "Donor entities", status: "ready" });
      house.item(140, { title: "Donor list endpoint", status: "done", priority: "high" });
      const houseEnv = { NODE_EXTRA_CA_CERTS: path.join(tls, "cert.pem") };
      const ryanHome = signal.creatorHome ?? tempDir("ryan");
      builderHome("atticus-backoffice", house, "tok-ryan-e2e", "", ryanHome);
      const nickHome = builderHome("atticus-backoffice", house, "tok-nick-e2e", "", tempDir("nick"));
      let ryan = await launchApp("Ryan", signal.url, { home: ryanHome, settings: settings(r.ryan.dir), env: houseEnv });
      const nick = await launchApp("Nick", signal.url, { home: nickHome, settings: settings(r.nick.dir), env: houseEnv });
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
        // Nick finds it in the Team room view; its row names Ryan as the owner
        await untilTrue("Nick's room row", async () => /^Ryan's session · live/.test(await nick.evaluate<string>(whoLine("shared shell"))));
        await nick.evaluate(`${teamRow("shared shell")}.click()`);
        await untilTrue("the scrollback in Nick's pane", async () => (await screenOf(nick, paneId)).includes("ready-42"));
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(sh.id)}, "echo live-$((50+5))\\r")`);
        await untilTrue("live output in Nick's pane", async () => (await screenOf(nick, paneId)).includes("live-55"));
        const typeAsNick = async (text: string) => {
          await nick.evaluate(`(() => { const t = window.__mbTerms.get(${JSON.stringify(paneId)}).term; t.element.closest(".pane").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); t.focus(); })()`);
          await nick.send("Input.insertText", { text });
          await nick.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
          await nick.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        };
        // Nick's copy is view-only: his typing is refused on Ryan's Mac, he's told why, and Ryan is asked
        await untilTrue("Nick's copy marked view-only", async () => /View only · Ask to type/.test(await nick.evaluate<string>(`document.querySelector(".pane .chip.view-only")?.textContent ?? ""`)));
        await typeAsNick("echo refused-$((6*7))");
        await untilTrue("why at Nick's", async () => /Ryan hasn't allowed|Waiting for Ryan to let you type/.test(await nick.evaluate<string>(`document.querySelector(".typing-refused")?.textContent ?? ""`)));
        await untilTrue("the ask at Ryan's", async () => !!(await live(ryan)).own[sh.id]?.typingAsks?.some((a) => a.name === "Nick"));
        await ryan.evaluate(`${row("shared shell")}?.click()`); // the pane, as the ask's notification brings it up
        await untilTrue("the ask on Ryan's pane", async () => /Nick wants to type in “shared shell”/.test(await ryan.evaluate<string>(`document.querySelector(".typing-ask")?.textContent ?? ""`)), 30_000);
        expect(await buffer(ryan, sh.id)).not.toContain("refused-");
        // Ryan allows it from the prompt; Nick's typing then goes through
        await ryan.evaluate(`[...document.querySelectorAll(".typing-ask button")].find((b) => b.textContent === "Allow for this session").click()`);
        await untilTrue("Nick told he can type", async () => (await live(nick)).remote.find((x) => x.id === paneId)?.room?.typing?.state === "allowed");
        await untilTrue("Ryan's pane says Nick can type", async () => /Nick can type/.test(await ryan.evaluate<string>(`document.querySelector(".chip.typist")?.textContent ?? ""`)));
        await typeAsNick("echo from-nick-$((6*7))");
        await untilTrue("Nick's typing in Ryan's shell", async () => (await buffer(ryan, sh.id)).includes("from-nick-42"));
        expect(await buffer(ryan, sh.id)).not.toContain("refused-");
        await untilTrue("the result back in Nick's pane", async () => (await screenOf(nick, paneId)).includes("from-nick-42"));
        await untilTrue("Nick's initials on Ryan's session", async () => (await live(ryan)).own[sh.id]?.lookers.some((l) => l.name === "Nick" && l.focused) ?? false);
        // the session keeps the size of Ryan's own pane: Nick's copy never resizes it
        const ryanSize = await ryan.evaluate<{ cols: number; rows: number }>(`(() => { const t = window.__mbTerms.get(${JSON.stringify(sh.id)}).term; return { cols: t.cols, rows: t.rows }; })()`);
        await untilTrue("the session at the size of Ryan's pane", async () => {
          const own = (await live(ryan)).own[sh.id];
          return own?.cols === ryanSize.cols && own?.rows === ryanSize.rows;
        });
        expect(fs.readFileSync(path.join(ryan.home, ".mockingbird", "pty-audit.log"), "utf8")).toMatch(/remote-input session=\S+ from="Nick"/);
        // the audit log of remote actions: the ask and the allowance, by name, never what was typed
        const auditLog = path.join(ryan.home, ".mockingbird", "team", "audit.log");
        expect(fs.readFileSync(auditLog, "utf8")).toMatch(/"kind":"typing.asked"[^\n]*"member":"Nick"[^\n]*"title":"shared shell"/);
        expect(fs.readFileSync(auditLog, "utf8")).toMatch(/"kind":"typing.allowed"[^\n]*"until":null/);
        expect(fs.readFileSync(auditLog, "utf8")).not.toMatch(/refused-|from-nick/);
        expect(fs.statSync(auditLog).mode & 0o777).toBe(0o600);

        // ---- Nick scrolls his copy of Ryan's shell; nothing reaches Ryan's, even while Ryan's program asks for the mouse.
        // cat -v shows whatever arrives: a mouse report or an arrow key as ^[[…
        const term = `window.__mbTerms.get(${JSON.stringify(paneId)}).term`;
        const copyView = () => nick.evaluate<{ viewportY: number; baseY: number; type: string }>(`(() => { const b = ${term}.buffer.active; return { viewportY: b.viewportY, baseY: b.baseY, type: b.type }; })()`);
        const wheel = async (deltaY: number) => {
          const at = await nick.evaluate<{ x: number; y: number }>(`(() => { const r = ${term}.element.querySelector(".xterm-screen").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          for (let i = 0; i < 3; i++) await nick.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY });
        };
        const key = async (k: { key: string; code: string; keyCode: number; ctrl?: boolean }) => {
          await nick.evaluate(`${term}.focus()`);
          for (const type of ["keyDown", "keyUp"]) await nick.send("Input.dispatchKeyEvent", { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.ctrl ? 2 : 0 });
        };
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(sh.id)}, "echo scroll-start; seq 1 200; printf '\\\\033[?1000h\\\\033[?1002h\\\\033[?1006h'; cat -v\\r")`);
        await untilTrue("the history in Nick's pane", async () => (await screenOf(nick, paneId)).includes("\n200"));
        await new Promise((res) => setTimeout(res, 500)); // the mouse request reaches Nick's copy
        await wheel(-120);
        await untilTrue("Nick's copy scrolled up", async () => {
          const v = await copyView();
          return v.type === "normal" && v.viewportY < v.baseY - 5;
        });
        const scrolledTo = (await copyView()).viewportY;
        // Ryan's output keeps coming: Nick's copy stays where he scrolled to
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(sh.id)}, "ryan-typing\\r")`);
        await untilTrue("Ryan's output in Nick's copy", async () => (await screenOf(nick, paneId)).includes("ryan-typing"));
        expect((await copyView()).viewportY).toBe(scrolledTo);
        // redrawn from Ryan's scrollback (Repaint, or a gap in the stream), it stays there too
        const topRow = () => nick.evaluate<string>(`(() => { const b = ${term}.buffer.active; return b.getLine(b.viewportY)?.translateToString(true) ?? ""; })()`);
        const top = await topRow();
        await nick.evaluate(`(() => { const core = ${term}._core; const reset = core.reset.bind(core); window.__redraws = 0; core.reset = () => (window.__redraws++, reset()); })()`);
        await nick.evaluate(`window.mb.teamPaneResync(${JSON.stringify(paneId)})`);
        await untilTrue("the redraw", async () => (await nick.evaluate<number>("window.__redraws")) > 0);
        await untilTrue("Nick's copy where he had it", async () => {
          const v = await copyView();
          return v.viewportY < v.baseY && (await topRow()) === top;
        });
        // full screen: nothing here to scroll, and Nick is told why
        await key({ key: "c", code: "KeyC", keyCode: 67, ctrl: true });
        await untilTrue("Nick's Ctrl-C ending Ryan's cat", async () => /\^C/.test(await buffer(ryan, sh.id)));
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(sh.id)}, "printf '\\\\033[?1049h'; cat -v\\r")`);
        await untilTrue("Nick's copy on the alternate screen", async () => (await copyView()).type === "alternate");
        await wheel(-120);
        await wheel(120);
        await key({ key: "PageUp", code: "PageUp", keyCode: 33 });
        await key({ key: "PageDown", code: "PageDown", keyCode: 34 });
        await untilTrue("the full-screen note", async () => /Ryan's session is full screen/.test(await nick.evaluate<string>(`document.querySelector(".scroll-toast")?.textContent ?? ""`)));
        // Nick's typing still arrives, after everything above: none of the scrolling did
        await nick.send("Input.insertText", { text: "scroll-done" });
        await key({ key: "Enter", code: "Enter", keyCode: 13 });
        await untilTrue("Nick's typing after scrolling", async () => (await buffer(ryan, sh.id)).includes("scroll-done"));
        const sinceStart = (await buffer(ryan, sh.id)).split("scroll-start").at(-1)!;
        expect(sinceStart).not.toMatch(/\^\[\[<|\^\[\[[AB56]|\^\[O[AB]|\x1b\[</);
        await key({ key: "c", code: "KeyC", keyCode: 67, ctrl: true });
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(sh.id)}, "printf '\\\\033[?1049l\\\\033[?1000l\\\\033[?1002l\\\\033[?1006l'\\r")`);
        await untilTrue("Nick's copy back on the normal screen", async () => (await copyView()).type === "normal");

        // ---- the team chat: Nick's message reaches Ryan
        expect(await nick.evaluate(`window.mb.teamChatPost(${JSON.stringify(roomId)}, "morning, taking the export")`)).not.toHaveProperty("error");
        await untilTrue("Nick's message at Ryan's", async () =>
          (await ryan.evaluate<ChatView>(`window.mb.teamChatView(${JSON.stringify(roomId)})`)).entries.some((e) => e.kind === "message" && e.text === "morning, taking the export" && e.author === nickId)
        );

        // ---- the House board: Ryan (the admin) connects the project, Nick claims #141 with his own token, Ryan's board shows it
        const rid = JSON.stringify(roomId);
        expect(await ryan.evaluate(`window.mb.houseWrite(${rid}, { kind: "project", project: "atticus-backoffice" })`)).not.toHaveProperty("error");
        // Nick's Mockingbird asks before using his token for the room, and reads nothing with it until he allows it
        await untilTrue("Nick to be asked for his token", async () => (await nick.evaluate<{ roomId: string }[]>(`window.mb.housePendingConsents()`)).some((a) => a.roomId === roomId));
        await untilTrue("the consent toast at Nick's", async () => /Use your atticus-backoffice builder token for room/.test(await nick.evaluate<string>(`document.querySelector(".house-toast.consent")?.textContent ?? ""`)));
        expect((await nick.evaluate<HouseView>(`window.mb.houseRefresh(${rid})`)).connection).toEqual({ state: "consent", declined: false });
        expect(house.requests.filter((x) => x.token === "tok-nick-e2e")).toEqual([]);
        await nick.evaluate(`[...document.querySelectorAll(".house-toast.consent button")].find((b) => b.textContent === "Allow").click()`);
        await untilTrue("the open backlog on Nick's board", async () => ((await nick.evaluate<HouseView>(`window.mb.houseRefresh(${rid})`)).open ?? []).some((x) => x.n === 141 && x.ticket?.title === "Donor entities"));
        expect((await nick.evaluate<HouseView>(`window.mb.houseGet(${rid})`)).open?.map((x) => x.n)).toEqual([141]); // #140 is done
        expect(await nick.evaluate(`window.mb.houseWrite(${rid}, { kind: "claim", n: 141, branch: "5110-donors" })`)).not.toHaveProperty("error");
        await untilTrue("Nick's claim on Ryan's board", async () => (await ryan.evaluate<HouseView>(`window.mb.houseGet(${rid})`)).open?.find((x) => x.n === 141)?.owner?.name === "Nick");
        expect(house.requests.filter((x) => x.path.endsWith("/work-items/141/claim")).map((x) => x.token)).toEqual(["tok-nick-e2e"]);
        expect(house.requests.every((x) => x.token === "tok-ryan-e2e" || x.token === "tok-nick-e2e")).toBe(true);
        expect(JSON.stringify(await nick.evaluate(`window.mb.houseGet(${rid})`))).not.toContain("tok-nick-e2e");

        // ---- an agent session of Ryan's in the room: a turn ends, it's backed up, Nick sees how fresh
        const s = await ryan.evaluate<{ id: string; cwd: string; error?: string }>(
          `window.mb.createSession({ repoPath: ${JSON.stringify(r.ryan.clone)}, useWorktree: true, branchName: "5110-donors", agent: "claude", taskGroup: "5110", title: "Donor entities" })`
        );
        expect(s.error).toBeUndefined();
        await untilTrue("the agent to start", async () => (await buffer(ryan, s.id)).includes("fake-claude started"), 20_000);
        expect(await buffer(ryan, s.id)).toMatch(/--append-system-prompt/); // the room's House board, carried in the launch
        // the House's reads are pre-allowed; its writes are left to Claude's permission prompt in the pane
        expect(await buffer(ryan, s.id)).toContain("mcp__mockingbird__list_house_tickets");
        expect(await buffer(ryan, s.id)).not.toContain("mcp__mockingbird__claim_house_ticket");
        expect(await buffer(ryan, s.id)).toContain("mcp__mockingbird__read_room_artifact");
        expect(await buffer(ryan, s.id)).toContain("(inline=1)"); // a room session runs inline, so Nick's copy holds its history
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(s.id)}, "add the donor notes\\r")`);
        await untilTrue("the turn", async () => (await buffer(ryan, s.id)).includes("did: add the donor notes"));
        await untilTrue(
          "the backup's snapshot and conversation at Nick's",
          async () => {
            const b = (await takeovers(nick)).sessions.find((v) => v.sessionId === s.id && v.owner === ryanId);
            return !!b?.peerCopy && (b.transcript?.have ?? 0) > 0;
          },
          60_000
        );
        // a room keeps its backups peer to peer unless its admin turns on backups to origin: nothing reaches origin
        expect((await takeovers(nick)).sessions.find((v) => v.sessionId === s.id)).toMatchObject({ toOrigin: false, pushed: null });
        expect(git(r.bare, "for-each-ref", "--format=%(refname)", "refs/mockingbird")).toBe("");
        await untilTrue("the freshness on Nick's row", async () => /^copied here/.test(await nick.evaluate<string>(`${teamRow("Donor entities")}?.querySelector(".tk-fresh")?.textContent ?? ""`)));
        await untilTrue("the freshness on Ryan's row", async () => /^copied to Nick/.test(await ryan.evaluate<string>(`${row("Donor entities")}?.querySelector(".tk-fresh")?.textContent ?? ""`)));
        expect(await nick.evaluate<boolean>(`!!${takeOverOf("Donor entities")}`)).toBe(true);

        // ---- Ryan online: Nick asks for another of his sessions, Ryan hands it over from his prompt
        const ex = await ryan.evaluate<{ id: string; cwd: string; error?: string }>(
          `window.mb.createSession({ repoPath: ${JSON.stringify(r.ryan.clone)}, useWorktree: true, branchName: "5110-export", agent: "claude", taskGroup: "5110", title: "Gift export" })`
        );
        expect(ex.error).toBeUndefined();
        await untilTrue("the export agent to start", async () => (await buffer(ryan, ex.id)).includes("fake-claude started"), 20_000);
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(ex.id)}, "write the gift export\\r")`);
        await untilTrue("the export turn", async () => (await buffer(ryan, ex.id)).includes("did: write the gift export"));
        await untilTrue(
          "the export's backup and conversation at Nick's",
          async () => {
            const b = (await takeovers(nick)).sessions.find((v) => v.sessionId === ex.id && v.owner === ryanId);
            return !!b?.peerCopy && (b.transcript?.have ?? 0) > 0;
          },
          60_000
        );
        await untilTrue("Take over on Nick's export row", async () => nick.evaluate<boolean>(`!!${takeOverOf("Gift export")}`));
        await nick.evaluate(`${takeOverOf("Gift export")}.click()`);
        const askButton = `[...document.querySelectorAll(".tk-dlg button.primary")].find((x) => x.textContent === "Ask Ryan")`;
        await untilTrue("Ask Ryan in Nick's dialog", async () => nick.evaluate<boolean>(`(() => { const b = ${askButton}; return !!b && !b.disabled; })()`));
        await nick.evaluate(`${askButton}.click()`);
        await untilTrue("Ryan's prompt", async () => /Nick wants to take over “Gift export”/.test(await ryan.evaluate<string>(`document.querySelector(".tk-ask")?.textContent ?? ""`)));
        expect(await ryan.evaluate<string[]>(`[...document.querySelectorAll(".tk-ask button")].map((b) => b.textContent)`)).toEqual(expect.arrayContaining(["Hand over", "Keep it"]));
        await untilTrue("Nick told he's waiting", async () => /Waiting for Ryan to answer/.test(await nick.evaluate<string>(`document.querySelector(".tk-dlg")?.textContent ?? ""`)));
        await ryan.evaluate(`[...document.querySelectorAll(".tk-ask button.primary")].find((x) => x.textContent === "Hand over").click()`);
        await untilTrue("the hand-over done", async () => /Running here now/.test(await nick.evaluate<string>(`document.querySelector(".tk-dlg")?.textContent ?? ""`)), 90_000);
        // Ryan's agent stopped, his worktree as it was; Nick continues from exactly the snapshot handed over
        const ryanEx = (await ryan.evaluate<{ id: string; status: string }[]>("window.mb.listSessions()")).find((x) => x.id === ex.id);
        expect(ryanEx?.status).toBe("dead");
        expect(fs.readFileSync(path.join(ex.cwd, "notes.txt"), "utf8")).toBe("write the gift export\n");
        const exView = (await takeovers(nick)).sessions.find((v) => v.sessionId === ex.id)!;
        // the room took it on Ryan's signed hand-over, checked on both Macs
        expect(exView.takenOver).toMatchObject({ by: nickId, conversation: "full", snapshot: { sha: exView.latest.sha }, grant: "handover" });
        await untilTrue("Ryan's Mac to record the hand-over", async () => (await takeovers(ryan)).sessions.find((v) => v.sessionId === ex.id)?.takenOver?.grant === "handover");
        const nickEx = (await nick.evaluate<{ id: string; cwd: string }[]>("window.mb.listSessions()")).find((x) => x.id === exView.takenOver!.newSessionId)!;
        expect(fs.readFileSync(path.join(nickEx.cwd, "notes.txt"), "utf8")).toBe("write the gift export\n");
        // a new conversation on Nick's account, briefed; Ryan's whole conversation saved in the worktree for reference
        await untilTrue("Nick's export agent briefed", async () => (await buffer(nick, nickEx.id)).includes("fake-claude got a brief"), 30_000);
        expect(await buffer(nick, nickEx.id)).not.toContain("--resume");
        expect(fs.existsSync(path.join(nickEx.cwd, ".mockingbird", "takeover", `${convOf(ex.id)}.jsonl`))).toBe(true);
        await untilTrue("Ryan's row: continued on Nick's laptop", async () =>
          /continued on Nick's laptop/.test(await ryan.evaluate<string>(`[...document.querySelectorAll(".sess-item")].filter((x) => x.textContent.includes("Gift export")).map((x) => x.textContent).join("|")`))
        );
        expect(await ryan.evaluate(`window.mb.relaunchSession(${JSON.stringify(ex.id)})`)).toMatchObject({ error: expect.stringMatching(/continues on Nick's laptop/) });
        await nick.evaluate(`[...document.querySelectorAll(".tk-dlg button")].find((x) => x.textContent === "Close").click()`);

        // ---- Ryan's Mockingbird quits: with Ryan offline, Nick may take his session over without asking
        await untilTrue("Ryan to have caught Nick up", async () => !!(await takeovers(ryan)).sessions.find((v) => v.sessionId === s.id && v.self)?.heldBy.includes("Nick"), 60_000);
        ryan.close();
        expect(await quitApp(ryan.child)).toEqual({ killed: false, leftovers: [] }); // it quits on its own, its agents with it
        await untilTrue("Ryan offline at Nick's", async () => (await nick.status()).rooms[0]?.online.length === 0, 60_000);
        await untilTrue("Nick's row: Ryan offline", async () => /^Ryan's session · offline/.test(await nick.evaluate<string>(whoLine("Donor entities"))));

        // ---- Nick takes the session over from his sidebar: no grant, Ryan is offline
        await untilTrue("Take over, prominent", async () => nick.evaluate<boolean>(`!!${takeOverOf("Donor entities")}?.classList.contains("primary")`));
        const plan = await nick.evaluate<TakeoverPlan>(`window.mb.teamTakeoverPlan(${JSON.stringify(roomId)}, ${JSON.stringify(s.id)}, null)`);
        expect(plan).toMatchObject({ ownerOnline: false, branch: "5110-donors", conversation: { kind: "full" }, latestMissing: false, toOrigin: false, snapshot: { source: "peer" }, grant: { kind: "offline" } });
        expect(fs.realpathSync(plan.clone!)).toBe(fs.realpathSync(r.nick.clone));
        await nick.evaluate(`${takeOverOf("Donor entities")}.click()`);
        await untilTrue("the dialog's plan", async () => nick.evaluate<boolean>(`(() => { const b = [...document.querySelectorAll(".tk-dlg button.primary")].find((x) => x.textContent === "Take over"); return !!b && !b.disabled; })()`));
        await nick.evaluate(`[...document.querySelectorAll(".tk-dlg button.primary")].find((x) => x.textContent === "Take over").click()`);
        await untilTrue("the take-over done", async () => /Running here now/.test(await nick.evaluate<string>(`document.querySelector(".tk-dlg")?.textContent ?? ""`)), 60_000);
        const view = (await takeovers(nick)).sessions.find((v) => v.sessionId === s.id)!;
        expect(view.takenOver).toMatchObject({ by: nickId, conversation: "full", snapshot: { source: "peer" }, grant: "offline" });
        expect(git(r.bare, "for-each-ref", "--format=%(refname)", "refs/mockingbird")).toBe("");
        const mine = (await nick.evaluate<{ id: string; cwd: string; branch: string | null; taskGroup: string | null }[]>("window.mb.listSessions()")).find((x) => x.id === view.takenOver!.newSessionId)!;
        // the work in a worktree of Nick's clone, on the session's branch, a new conversation briefed from Ryan's
        expect(mine).toMatchObject({ branch: "5110-donors", taskGroup: "5110" });
        expect(fs.readFileSync(path.join(mine.cwd, "notes.txt"), "utf8")).toBe("add the donor notes\n");
        expect(git(mine.cwd, "rev-parse", "--show-toplevel")).not.toBe(fs.realpathSync(r.nick.clone));
        await untilTrue("the briefed agent", async () => (await buffer(nick, mine.id)).includes("fake-claude got a brief"), 30_000);
        expect(await buffer(nick, mine.id)).not.toContain("--resume");
        // the room's session is Nick's now; Ryan's copy no longer shows
        expect((await live(nick)).own[mine.id]).toMatchObject({ roomId, remote: false });
        expect((await live(nick)).remote.some((x) => x.room?.sessionId === s.id)).toBe(false);
        await untilTrue("the old row gone from Nick's Team room view", async () => !(await nick.evaluate<boolean>(`[...document.querySelectorAll(".sess-item")].some((x) => x.textContent.includes("Donor entities") && /^Ryan's session/.test(x.querySelector(".br.who")?.textContent ?? ""))`)));

        // ---- Ryan's Mockingbird starts again, and runs his session again at once (as an update restart brings
        // open sessions back), before the room has caught up: his copy stops as soon as it hears
        ryan = await launchApp("Ryan", signal.url, { home: ryan.home, keepState: true, env: houseEnv });
        const relaunched = await ryan.evaluate<{ id?: string; error?: string }>(`window.mb.relaunchSession(${JSON.stringify(s.id)})`);
        if (relaunched.error) expect(relaunched.error).toMatch(/continues on Nick's laptop/); // the room had caught up first
        console.log(`[e2e] Ryan's copy at start: ${relaunched.error ? "refused to run (the room had caught up)" : "running again, until the room catches up"}`);
        await untilTrue("Ryan back", async () => (await ryan.status()).rooms[0]?.online.length === 1, 90_000);
        expect((await ryan.status()).self?.id).toBe(ryanId); // the same identity after a restart (its key sealed with the test keychain)
        await untilTrue("Ryan's copy marked taken over", async () => (await live(ryan)).own[s.id]?.takenOver?.byName === "Nick", 30_000);
        await untilTrue(
          "Ryan's copy stopped",
          async () => {
            const x = (await ryan.evaluate<{ id: string; status: string }[]>("window.mb.listSessions()")).find((y) => y.id === s.id);
            return !x || x.status === "dead";
          },
          30_000
        );
        expect(await ryan.evaluate(`window.mb.relaunchSession(${JSON.stringify(s.id)})`)).toMatchObject({ error: expect.stringMatching(/continues on Nick's laptop/) });
        await untilTrue("Nick's session at Ryan's", async () => (await live(ryan)).remote.some((x) => x.room?.sessionId === mine.id && x.room.owner === nickId));
        await untilTrue("Ryan's row says so", async () =>
          /continued on Nick's laptop/.test(await ryan.evaluate<string>(`[...document.querySelectorAll(".sess-item")].filter((x) => x.textContent.includes("Donor entities")).map((x) => x.textContent).join("|")`))
        );
        expect((await takeovers(ryan)).left.map((l) => l.sessionId).sort()).toEqual([ex.id, s.id].sort());
        expect((await takeovers(ryan)).refused).toEqual([]);
      } catch (err) {
        const dialogs = `--- Ryan's dialogs ---\n${await dialogsOf(ryan)}\n--- Nick's dialogs ---\n${await dialogsOf(nick)}`;
        throw new Error(`${(err as Error).message}\n${dialogs}\n--- Ryan's log ---\n${mainLog(ryan).slice(-4000)}\n--- Nick's log ---\n${mainLog(nick).slice(-4000)}`);
      } finally {
        ryan.close();
        nick.close();
        await Promise.all([quitApp(ryan.child), quitApp(nick.child)]);
        await signal.close();
        await house.close();
      }
    },
    480_000
  );

  it.skipIf(!appE2E)(
    "migration numbers reserved through the agents' tools reach the teammate and hold back their file; uncommitted work on one Mac is a heads-up on the other",
    async () => {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "ignore" });
      const signal = await e2eSignaling();
      const r = repos({ "db/migrations/0001_init.sql": "-- init\n", "db/migrations/0002_donors.sql": "-- donors\n" });
      // a room session's record carries its origin as a URL (a bare path is never published): file:// here
      for (const c of [r.ryan.clone, r.nick.clone]) git(c, "remote", "set-url", "origin", `file://${r.bare}`);
      const stub = path.join(tempDir("bin"), "claude");
      fs.writeFileSync(stub, FAKE_CLAUDE, { mode: 0o755 });
      const settings = (code: string) => ({ claudeBin: stub, repoRoots: [code] });
      const ryan = await launchApp("Ryan", signal.url, { home: signal.creatorHome ?? tempDir("ryan"), settings: settings(r.ryan.dir) });
      const nick = await launchApp("Nick", signal.url, { settings: settings(r.nick.dir) });
      try {
        const { roomId } = await connect(signal, ryan, nick);
        const rid = JSON.stringify(roomId);
        for (const a of [ryan, nick]) expect(await a.evaluate(`window.mb.installHooks()`)).toMatchObject({ installed: true });
        const start = async (a: AppInstance, branch: string, title: string) => {
          const s = await a.evaluate<{ id: string; cwd: string; error?: string }>(
            `window.mb.createSession({ repoPath: ${JSON.stringify(a === ryan ? r.ryan.clone : r.nick.clone)}, useWorktree: true, branchName: ${JSON.stringify(branch)}, agent: "claude", taskGroup: "5110", title: ${JSON.stringify(title)} })`
          );
          expect(s.error).toBeUndefined();
          await untilTrue(`${title} to start`, async () => (await buffer(a, s.id)).includes("fake-claude started"), 20_000);
          return s;
        };
        const rs = await start(ryan, "5110-donors", "Donor entities");
        const ns = await start(nick, "5110-export", "Gift export");
        // the teammate tools that only read are pre-allowed in a room launch
        expect(await buffer(ryan, rs.id)).toContain("mcp__mockingbird__list_teammate_changes");
        expect(await buffer(ryan, rs.id)).not.toContain("mcp__mockingbird__reserve_migration_number");

        // ---- Ryan's agent reserves the next number; Nick's sees it, gets the one after, and is held back from Ryan's
        const reserved = await tool(ryan, rs.id, "reserve_migration_number", {});
        expect(reserved.result).toMatch(/^Reserved migration 0003 in "db\/migrations" for your user/);
        await untilTrue("Ryan's reservation at Nick's", async () => (await nick.evaluate<MigrationsView>(`window.mb.teamChangesView(${rid})`)).reservations.some((x) => x.label === "0003" && x.member === "Ryan"));
        expect((await tool(nick, ns.id, "list_migration_reservations")).result).toContain('"held_by": "Ryan"');
        expect((await tool(nick, ns.id, "reserve_migration_number", {})).result).toMatch(/^Reserved migration 0004 /);
        await untilTrue("both on Ryan's board line", async () => (await ryan.evaluate<MigrationsView>(`window.mb.teamChangesView(${rid})`)).reservations.map((x) => `${x.label} ${x.self ? "You" : x.member}`).join(", ") === "0003 You, 0004 Nick");
        const copyOf = (cwd: string, name: string) => (fs.existsSync(path.join(cwd, ".mockingbird", name)) ? fs.readFileSync(path.join(cwd, ".mockingbird", name), "utf8") : "");
        await untilTrue("Ryan's 0003 in Nick's worktree copy", async () => copyOf(ns.cwd, "migrations.json").includes('"label":"0003"')).catch((err) => {
          throw new Error(`${err.message}: ${ns.cwd} holds ${JSON.stringify(fs.existsSync(path.join(ns.cwd, ".mockingbird")) ? fs.readdirSync(path.join(ns.cwd, ".mockingbird")) : null)}, migrations.json ${copyOf(ns.cwd, "migrations.json")}, clone ${JSON.stringify(fs.existsSync(path.join(r.nick.clone, ".mockingbird")) ? fs.readdirSync(path.join(r.nick.clone, ".mockingbird")) : null)}`);
        });
        const held = JSON.parse(await editHook(nick, ns.id, ns.cwd, "Write", "db/migrations/0003_gift_export.sql"));
        expect(held.hookSpecificOutput.permissionDecision).toBe("deny");
        expect(held.hookSpecificOutput.permissionDecisionReason).toContain(`which Ryan's session "Donor entities" (branch 5110-donors) reserved`);
        expect(await editHook(nick, ns.id, ns.cwd, "Write", "db/migrations/0004_gift_export.sql")).toBe("");
        // Ryan gives his back: gone from Nick's side
        expect((await tool(ryan, rs.id, "release_migration_number", { number: 3 })).result).toBe('Released 0003 in "db/migrations".');
        await untilTrue("Ryan's release at Nick's", async () => (await nick.evaluate<MigrationsView>(`window.mb.teamChangesView(${rid})`)).reservations.map((x) => x.label).join() === "0004");

        // ---- uncommitted work: each turn writes notes.txt; after each side's backup reaches the other, an edit of it there is a heads-up
        const ryanId = (await ryan.status()).self!.id;
        const nickId = (await nick.status()).self!.id;
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(rs.id)}, "add the donor notes\\r")`);
        await nick.evaluate(`window.mb.sessionWrite(${JSON.stringify(ns.id)}, "add the export notes\\r")`);
        const mirrored = async (a: AppInstance, owner: string, sessionId: string) => !!(await takeovers(a)).sessions.find((v) => v.sessionId === sessionId && v.owner === owner)?.peerCopy;
        await untilTrue("Ryan's snapshot at Nick's", () => mirrored(nick, ryanId, rs.id), 60_000);
        await untilTrue("Nick's snapshot at Ryan's", () => mirrored(ryan, nickId, ns.id), 60_000);
        const told = (cwd: string, who: string) => {
          try {
            return (JSON.parse(fs.readFileSync(path.join(cwd, ".mockingbird", "overlaps.json"), "utf8")) as OverlapsFile).sessions.some((x) => x.member.name === who && x.uncommitted.includes("notes.txt"));
          } catch {
            return false;
          }
        };
        await untilTrue("Ryan's notes.txt in Nick's worktree copy", async () => told(ns.cwd, "Ryan"), 30_000);
        await untilTrue("Nick's notes.txt in Ryan's worktree copy", async () => told(rs.cwd, "Nick"), 30_000);
        const atNick = JSON.parse(await editHook(nick, ns.id, ns.cwd, "Edit", "notes.txt"));
        expect(atNick.hookSpecificOutput.additionalContext).toMatch(/^Heads-up from Mockingbird: Ryan's session "Donor entities" \(branch 5110-donors\), in uncommitted work on their Mac, is also changing "notes.txt"\./);
        expect(await editHook(nick, ns.id, ns.cwd, "Edit", "notes.txt")).toBe(""); // told once, for a while
        const atRyan = JSON.parse(await editHook(ryan, rs.id, rs.cwd, "Edit", "notes.txt"));
        expect(atRyan.hookSpecificOutput.additionalContext).toMatch(/^Heads-up from Mockingbird: Nick's session "Gift export" \(branch 5110-export\), in uncommitted work on their Mac, is also changing "notes.txt"\./);
        // and the agents can look: Nick's tools list Ryan's session with notes.txt, and show its diff
        const listed = (await tool(nick, ns.id, "list_teammate_changes")).result ?? "";
        const changes = JSON.parse(listed.slice(listed.indexOf("\n") + 1));
        expect(changes.sessions).toEqual([expect.objectContaining({ owner: "Ryan", title: "Donor entities", files: expect.arrayContaining([{ path: "notes.txt", committed: false, uncommitted: true, also_changed_here: true }]) })]);
        const diff = await tool(nick, ns.id, "read_teammate_diff", { session: changes.sessions[0].id, file: "notes.txt" });
        expect(diff.result).toMatch(/<teammate-diff>\n[^]*\+add the donor notes[^]*\n<\/teammate-diff>$/);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- Ryan's log ---\n${mainLog(ryan).slice(-4000)}\n--- Nick's log ---\n${mainLog(nick).slice(-4000)}`);
      } finally {
        ryan.close();
        nick.close();
        await Promise.all([quitApp(ryan.child), quitApp(nick.child)]);
        await signal.close();
      }
    },
    300_000
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
