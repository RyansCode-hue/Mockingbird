import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { appE2E, e2eSignaling, launchApp, mainLog, quitApp, root, routes, untilTrue } from "./e2e/appInstance";

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
    "shares a group on one, joins it on the other, and both show the room and each other",
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
        await untilTrue("both connected", async () => (await ryan.status()).rooms[0]?.online.length === 1 && (await nick.status()).rooms[0]?.online.length === 1, 60_000);
        const [r, n] = [await ryan.status(), await nick.status()];
        // on one Mac through the local server the path is direct; through a Worker it may be relayed
        const path = signal.real ? expect.stringMatching(/^(direct|turn)$/) : "direct";
        expect(r.peers).toEqual([expect.objectContaining({ name: "Nick", state: path })]);
        expect(n.peers).toEqual([expect.objectContaining({ name: "Ryan", state: path })]);
        if (signal.real) console.log(`[e2e] connected through ${signal.url}: Ryan→Nick ${(await routes(ryan, nick)).join(", Nick→Ryan ")}`);
        expect(n.rooms[0]).toMatchObject({ name: "#5110 Donor entities", groupKey: "5110", members: [{ name: "Ryan" }, { name: "Nick", self: true }] });
        // the sidebar: the room is a group with the shared badge and the teammate's initials
        await untilTrue("Nick's sidebar badge", async () => (await nick.evaluate<string>(`document.querySelector(".team-badge")?.textContent ?? ""`)) === "sharedR");
        await untilTrue("Ryan's sidebar badge", async () => (await ryan.evaluate<string>(`document.querySelector(".team-badge")?.textContent ?? ""`)) === "sharedN");
        // the hidden peer host never became the app's window
        expect(await ryan.evaluate<string>("document.title")).toBe("Mockingbird");
      } finally {
        ryan.close();
        nick.close();
        await Promise.all([quitApp(ryan.child), quitApp(nick.child)]);
        await signal.close();
      }
      expect([mainLog(ryan), mainLog(nick)].join("\n")).toMatch(/team: connected to/);
    },
    120_000
  );
});
