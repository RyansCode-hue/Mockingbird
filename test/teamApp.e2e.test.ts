import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { acceptInWindow, appE2E, e2eSignaling, launchApp, mainLog, quitApp, root, routes, untilTrue } from "./e2e/appInstance";
import { tempDir } from "./helpers";

/**
 * Two real Mockingbird instances (this checkout's build) on one Mac, each with
 * its own HOME and userData, share and join a room over the local signaling
 * server (or the deployed Worker at MB_E2E_SIGNALING_URL): the whole app path
 * — IPC, the service, the hidden peer host inside the app, the sidebar badge.
 * Their windows open on screen while it runs, so it's opt-in:
 *
 *   MB_E2E_APP=1 npx vitest run test/teamApp.e2e.test.ts
 */

describe("team rooms between two Mockingbird instances", () => {
  it.skipIf(!appE2E)(
    "shares a group on one, joins it on the other, both show the room and each other; removing and leaving delete it",
    async () => {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "ignore" });
      const signal = await e2eSignaling();
      const ryan = await launchApp("Ryan", signal.url, { home: signal.creatorHome });
      const nick = await launchApp("Nick", signal.url);
      try {
        const share = await ryan.evaluate<{ roomId: string; invite: string; error?: string }>(`window.mb.teamShareGroup("5110", "#5110 Donor entities")`);
        expect(share.error).toBeUndefined();
        await untilTrue("Ryan's signaling", async () => (await ryan.status()).rooms[0]?.signaling === "online");
        const join = await nick.evaluate<{ roomId: string; error?: string }>(`window.mb.teamJoin(${JSON.stringify(share.invite)})`);
        expect(join).toMatchObject({ roomId: share.roomId });
        // Nick waits at the door until Ryan, the room's admin, accepts him from the prompt in his window
        await acceptInWindow(ryan, nick, share.roomId);
        await untilTrue("both connected", async () => (await ryan.status()).rooms[0]?.online.length === 1 && (await nick.status()).rooms[0]?.online.length === 1, 60_000);
        const [r, n] = [await ryan.status(), await nick.status()];
        // on one Mac through the local server the path is direct; through a Worker it may be relayed
        const route = signal.real ? expect.stringMatching(/^(direct|turn)$/) : "direct";
        expect(r.peers).toEqual([expect.objectContaining({ name: "Nick", state: route })]);
        expect(n.peers).toEqual([expect.objectContaining({ name: "Ryan", state: route })]);
        if (signal.real) console.log(`[e2e] connected through ${signal.url}: Ryan→Nick ${(await routes(ryan, nick)).join(", Nick→Ryan ")}`);
        expect(n.rooms[0]).toMatchObject({ name: "#5110 Donor entities", groupKey: "5110", members: [{ name: "Ryan" }, { name: "Nick", self: true }] });
        // the Sessions view: one line for the rooms, naming the teammate online
        await untilTrue("Nick's connected line", async () => (await nick.evaluate<string>(`document.querySelector(".connected-line")?.textContent ?? ""`)).includes("Ryan online"));
        await untilTrue("Ryan's connected line", async () => (await ryan.evaluate<string>(`document.querySelector(".connected-line")?.textContent ?? ""`)).includes("Nick online"));
        // the hidden peer host never became the app's window
        expect(await ryan.evaluate<string>("document.title")).toBe("Mockingbird");

        // artifacts: a note and a file Ryan adds reach Nick over the real connection, the file
        // byte-identical; a message naming the note shows as a chip in Nick's Team room
        const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"), Buffer.alloc(4096, 7)]);
        const pngPath = path.join(ryan.home, "mock.png");
        fs.writeFileSync(pngPath, png);
        const rid = JSON.stringify(share.roomId);
        const note = await ryan.evaluate<{ id: string; error?: string }>(`window.mb.artifactsAddNote(${rid}, "API spec", "# API\\nGET /api/donors/:id")`);
        expect(note.error).toBeUndefined();
        const added = await ryan.evaluate<{ added: { id: string }[]; refused: unknown[]; error?: string }>(`window.mb.artifactsAddFiles(${rid}, [${JSON.stringify(pngPath)}])`);
        expect(added).toMatchObject({ refused: [] });
        const fileId = added.added[0].id;
        await untilTrue(
          "Nick's copy of Ryan's file and note",
          async () => {
            const v = await nick.evaluate<{ items: { id: string; local?: { state: string } }[] }>(`window.mb.artifactsList(${rid})`);
            return v.items.some((i) => i.id === fileId && i.local?.state === "present") && v.items.some((i) => i.id === note.id);
          },
          60_000
        );
        const got = await nick.evaluate<{ view: string; bytes: number[] }>(`window.mb.artifactsRead(${rid}, ${JSON.stringify(fileId)}).then((c) => ({ view: c.view, bytes: Array.from(c.bytes ?? []) }))`);
        expect(got.view).toBe("image");
        expect(Buffer.from(got.bytes).equals(png)).toBe(true);
        expect(await nick.evaluate<{ view: string; text: string }>(`window.mb.artifactsRead(${rid}, ${JSON.stringify(note.id)})`)).toMatchObject({ view: "note", text: "# API\nGET /api/donors/:id" });
        await ryan.evaluate(`window.mb.teamChatPost(${rid}, ${JSON.stringify(`Spec is in #[API spec](artifact:${note.id})`)})`);
        await nick.evaluate(`document.querySelector('.ab-btn[aria-label="Team room"]')?.click()`);
        await untilTrue("the note's chip in Nick's Team room", async () => (await nick.evaluate<string>(`[...document.querySelectorAll(".rc-artifact")].map((b) => b.textContent).join("|")`)).includes("API spec"), 30_000);

        // Ryan (the creator, so the admin) removes Nick: Nick's app deletes the room, his group stays a local one
        const roomDir = path.join(nick.home, ".mockingbird", "team", "rooms", share.roomId);
        expect(fs.existsSync(roomDir)).toBe(true);
        const removed = await ryan.evaluate<{ name: string; delivered: boolean; worker: string | null; error?: string }>(`window.mb.teamRemoveMember(${JSON.stringify(share.roomId)}, ${JSON.stringify(n.self!.id)})`);
        expect(removed).toMatchObject({ name: "Nick", delivered: true });
        if (!signal.real) expect(removed.worker).toBeNull(); // the deployed Worker may be older: then it says to redeploy
        await untilTrue("Nick's copy of the room to go", async () => (await nick.status()).rooms.length === 0 && !fs.existsSync(roomDir));
        expect((await nick.status()).notices).toMatchObject([{ kind: "removed", by: "Ryan", roomName: "#5110 Donor entities" }]);
        expect((await ryan.status()).rooms[0]).toMatchObject({ members: [{ name: "Ryan" }], former: [{ name: "Nick" }] });
        // back with a new code; then Nick leaves himself
        const again = await ryan.evaluate<{ invite: string }>(`window.mb.teamCreateInvite(${JSON.stringify(share.roomId)})`);
        await nick.evaluate(`window.mb.teamJoin(${JSON.stringify(again.invite)})`);
        await acceptInWindow(ryan, nick, share.roomId);
        await untilTrue("Nick back, and both connected", async () => (await nick.status()).rooms[0]?.online.length === 1 && (await ryan.status()).rooms[0]?.online.length === 1, 60_000);
        const left = await nick.evaluate<{ told: string[]; worker: string | null; problems: string[]; error?: string }>(`window.mb.teamLeaveRoom(${JSON.stringify(share.roomId)})`);
        expect(left).toMatchObject({ told: ["Ryan"], problems: [] });
        expect(fs.existsSync(roomDir)).toBe(false);
        await untilTrue("Ryan to see Nick leave", async () => (await ryan.status()).rooms[0]?.members.length === 1);

        // a copy of Ryan's identity and rooms starts on "another Mac": Ryan's app is told its key connected from somewhere else
        const elsewhereHome = tempDir("ryan-elsewhere");
        fs.cpSync(path.join(ryan.home, ".mockingbird", "team"), path.join(elsewhereHome, ".mockingbird", "team"), { recursive: true });
        const elsewhere = await launchApp("Ryan elsewhere", signal.url, { home: elsewhereHome });
        try {
          await untilTrue("Ryan to be told", async () => !!(await ryan.status()).rooms[0]?.warnings?.some((w) => w.key === "replaced"), 60_000);
          expect((await ryan.status()).rooms[0].warnings!.find((w) => w.key === "replaced")!.text).toMatch(/^Your room identity connected from another place; this Mac was disconnected\./);
          await ryan.evaluate(`document.querySelector('.ab-btn[aria-label="Team room"]')?.click()`);
          await untilTrue("the warning under the room in Ryan's Team room", async () => (await ryan.evaluate<string>(`document.querySelector(".room-warning")?.textContent ?? ""`)).includes("Your room identity connected from another place"), 30_000);
        } finally {
          elsewhere.close();
          await quitApp(elsewhere.child);
        }
        expect(mainLog(ryan)).toMatch(/the same key connected again from somewhere else/);
      } finally {
        ryan.close();
        nick.close();
        await Promise.all([quitApp(ryan.child), quitApp(nick.child)]);
        await signal.close();
      }
      expect([mainLog(ryan), mainLog(nick)].join("\n")).toMatch(/team: connected to/);
    },
    180_000
  );
});
