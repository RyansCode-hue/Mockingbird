import { execFileSync } from "child_process";
import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { startLocalSignaling } from "../signaling/src/local/server";
import { electronBin, launchApp, mainLog, quitApp, root, untilTrue, type AppInstance } from "./e2e/appInstance";
import type { LivePanesState } from "../src/shared/team/livePanes";

/**
 * Live panes between two real Mockingbird instances on one Mac (separate
 * HOME and userData, the local signaling server, real WebRTC): Ryan shares a
 * group and starts a terminal in it; Nick sees it in his sidebar, opens it,
 * watches Ryan's output arrive, and types into it. Windows open on screen
 * while it runs, so it's opt-in:
 *
 *   MB_E2E_APP=1 npx vitest run test/teamLiveApp.e2e.test.ts
 */

const live = (a: AppInstance) => a.evaluate<LivePanesState>("window.mb.teamLive()");
/** What a pane's terminal shows in a window, as text. */
const screenOf = (a: AppInstance, id: string) =>
  a.evaluate<string>(`(() => { const e = window.__mbTerms?.get(${JSON.stringify(id)}); if (!e) return ""; const b = e.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ""); return out.join("\\n"); })()`);

describe("live panes between two Mockingbird instances", () => {
  it.skipIf(!process.env.MB_E2E_APP || !!process.env.CI || !electronBin || !fs.existsSync(electronBin))(
    "a session in a shared group shows live on the teammate's Mockingbird, and they can type into it",
    async () => {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "ignore" });
      const signal = await startLocalSignaling({ log: () => undefined });
      const ryan = await launchApp("Ryan", signal.url);
      const nick = await launchApp("Nick", signal.url);
      try {
        const share = await ryan.evaluate<{ roomId: string; invite: string; error?: string }>(`window.mb.teamShareGroup("5110", "#5110 Donor entities")`);
        expect(share.error).toBeUndefined();
        await untilTrue("Ryan's signaling", async () => (await ryan.status()).rooms[0]?.signaling === "online");
        await nick.evaluate(`window.mb.teamJoin(${JSON.stringify(share.invite)})`);
        await untilTrue("both connected", async () => (await ryan.status()).rooms[0]?.online.length === 1 && (await nick.status()).rooms[0]?.online.length === 1);

        // Ryan starts a terminal in the shared group and runs something in it
        const s = await ryan.evaluate<{ id: string; error?: string }>(`window.mb.createSession({ repoPath: null, useWorktree: false, shell: true, taskGroup: "5110", title: "shared shell" })`);
        expect(s.error).toBeUndefined();
        await new Promise((r) => setTimeout(r, 1500)); // the login shell starts
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(s.id)}, "echo ready-$((40+2))\\r")`);
        await untilTrue("Ryan's output", async () => (await ryan.evaluate<string>(`window.mb.sessionBuffer(${JSON.stringify(s.id)})`)).includes("ready-42"));

        // Nick has it in his sidebar, tagged with Ryan's initials
        let paneId = "";
        await untilTrue("the session on Nick's side", async () => {
          paneId = (await live(nick)).remote.find((r) => r.room?.sessionId === s.id)?.id ?? "";
          return !!paneId;
        });
        await untilTrue("Nick's sidebar row", async () =>
          nick.evaluate<boolean>(`[...document.querySelectorAll(".sess-item")].some((r) => r.textContent.includes("shared shell") && r.querySelector(".team-owner")?.textContent === "R")`)
        );

        // Nick opens it: Ryan's earlier output, then what Ryan runs next, live
        await nick.evaluate(`[...document.querySelectorAll(".sess-item")].find((r) => r.textContent.includes("shared shell")).click()`);
        await untilTrue("the scrollback in Nick's pane", async () => (await screenOf(nick, paneId)).includes("ready-42"));
        await ryan.evaluate(`window.mb.sessionWrite(${JSON.stringify(s.id)}, "echo live-$((50+5))\\r")`);
        await untilTrue("live output in Nick's pane", async () => (await screenOf(nick, paneId)).includes("live-55"));

        // Nick clicks into it and types, as a person does: the keystrokes run in Ryan's shell
        await nick.evaluate(`(() => { const t = window.__mbTerms.get(${JSON.stringify(paneId)}).term; t.element.closest(".pane").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); t.focus(); })()`);
        await nick.send("Input.insertText", { text: "echo from-nick-$((6*7))" });
        await nick.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await nick.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await untilTrue("Nick's typing in Ryan's shell", async () => (await ryan.evaluate<string>(`window.mb.sessionBuffer(${JSON.stringify(s.id)})`)).includes("from-nick-42"));
        await untilTrue("the result back in Nick's pane", async () => (await screenOf(nick, paneId)).includes("from-nick-42"));

        // Ryan sees Nick in it; Nick's differently sized pane never resized Ryan's terminal
        await untilTrue("Nick's initials on Ryan's session", async () => (await live(ryan)).own[s.id]?.lookers.some((l) => l.name === "Nick" && l.focused) ?? false);
        expect((await live(ryan)).own[s.id]).toMatchObject({ cols: 120, rows: 32 });
        const audit = `${ryan.home}/.mockingbird/pty-audit.log`;
        expect(fs.existsSync(audit) ? fs.readFileSync(audit, "utf8") : "").toMatch(/remote-input session=\S+ from="Nick"/);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- Ryan's log ---\n${mainLog(ryan).slice(-3000)}\n--- Nick's log ---\n${mainLog(nick).slice(-3000)}`);
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
