import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { appE2E, launchApp, untilTrue, type AppInstance } from "./e2e/appInstance";
import { AREA_HEADER, LOOSE_GROUP, overlaps, type Landscape, type LandscapeState, type Rect } from "../src/shared/landscape";

/**
 * The real app (dist/, under Electron, with a throwaway HOME) started over a layout the grid left: its session list and
 * its localStorage, and no landscape.json. Opt-in, like the other app tests:
 *
 *   npm run build && MB_E2E_APP=1 npx vitest run test/landscapeMigrateApp.e2e.test.ts
 */

const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;

/** Quit as app.quit() would: the window's localStorage is saved by the time it's exited. */
async function quit(app: AppInstance) {
  app.close();
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => app.child.once("exit", (code, signal) => resolve({ code, signal })));
  app.child.kill("SIGTERM");
  expect(await exit).toEqual({ code: 0, signal: null });
}

const landscapeOf = (app: AppInstance) => app.evaluate<LandscapeState>("window.mb.landscapeGet()");
const migrated = async (app: AppInstance): Promise<Landscape> => {
  await untilTrue("the landscape read in", async () => !!(await landscapeOf(app)).landscape.migratedAt, 30_000);
  return (await landscapeOf(app)).landscape;
};
const prefsOf = (app: AppInstance, keys: string[]) => app.evaluate<Record<string, string | null>>(`Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, localStorage.getItem(k)]))`);

describe.skipIf(!appE2E)("the real app started over the grid's layout", () => {
  it("makes its groups areas, its panes workspaces in the grid's arrangement and its sub-groups stacks, loses nothing, and leaves the grid's prefs as they were", async () => {
    // the sessions the grid knew: a group with two panes and a sub-group, another group, one in no group, and one in
    // no tree (closed by the quit below, so the Closed sessions list's, not the landscape's)
    const first = await launchApp("Legacy", "");
    const home = first.home;
    const made: Record<string, string> = {};
    for (const [name, group] of [["a1", "5101"], ["a2", "5101"], ["t1", "5101/api"], ["t2", "5101/api"], ["b1", "5102"], ["loose", null], ["unseen", "5102"]] as const) {
      const s = await first.evaluate<{ id: string; error?: string }>(`window.mb.createSession({ repoPath: null, useWorktree: false, shell: true, title: ${JSON.stringify(name)} })`);
      expect(s.error).toBeUndefined();
      made[name] = s.id;
      if (group) expect(await first.evaluate(`window.mb.setGroup(${JSON.stringify(s.id)}, ${JSON.stringify(group)})`)).toMatchObject({});
    }
    await untilTrue("the terminals running", async () => (await first.evaluate<number>(`window.mb.listSessions().then((l) => l.filter((s) => s.status !== "dead").length)`)) === 7);

    // 5101's tree: a1 on the left, a2 above the stack on the right; t2 the stack's front tab
    const stackCell = "ws:5101/api";
    const leaf = (key: string) => ({ kind: "leaf", key });
    const prefs: Record<string, unknown> = {
      "mb.shown": [made.a1, made.a2, made.t1, made.t2],
      "mb.activeGroup": "5101",
      "mb.trees": {
        "5101": { kind: "split", dir: "row", sizes: [0.5, 0.5], children: [leaf(made.a1), { kind: "split", dir: "col", sizes: [0.5, 0.5], children: [leaf(made.a2), leaf(stackCell)] }] },
        "5102": leaf(made.b1),
        [LOOSE_GROUP]: leaf(made.loose),
      },
      "mb.groupLayouts": { "5101": [made.a1, made.a2, made.t1, made.t2], "5102": [made.b1], [LOOSE_GROUP]: [made.loose] },
      "mb.wsTabs": { "5101/api": made.t2 },
      "mb.pinned": [],
      "mb.wsOpen": { "5101/api": true },
      "mb.collapsed": ["5102"],
      "mb.sideView": "scm",
    };
    await first.evaluate(`(() => { for (const [k, v] of Object.entries(${JSON.stringify(prefs)})) localStorage.setItem(k, JSON.stringify(v)); })()`);
    const keys = Object.keys(prefs);
    await quit(first);

    // no landscape yet, as on an install that never had one
    fs.rmSync(path.join(home, ".mockingbird", "landscape.json"), { force: true });

    const app = await launchApp("Legacy", "", { home, keepState: true });
    try {
      const l = await migrated(app);

      // areas from groups; an ungrouped session stays out of them
      expect(Object.keys(l.areas).sort()).toEqual(["5101", "5102"]);
      expect(l.areas).not.toHaveProperty(LOOSE_GROUP);

      // the tree's arrangement: a1 left of a2, a2 above the stack, all in the area, none overlapping
      const a1 = l.workspaces[made.a1];
      const a2 = l.workspaces[made.a2];
      const stack = l.stacks["5101/api"];
      expect(stack.active).toBe(made.t2);
      expect(a1.x + a1.w).toBeLessThanOrEqual(a2.x);
      expect(a2.y + a2.h).toBeLessThanOrEqual(stack.placement.y);
      expect(a2.x).toBe(stack.placement.x);
      expect(a1.y).toBe(a2.y);
      for (const r of [a1, a2, stack.placement]) expect(inside(r, l.areas["5101"])).toBe(true);
      expect(a1.y).toBeGreaterThanOrEqual(l.areas["5101"].y + AREA_HEADER);
      expect(overlaps(a1, a2)).toBe(false);
      expect(overlaps(a2, stack.placement)).toBe(false);
      expect(inside(l.workspaces[made.b1], l.areas["5102"])).toBe(true);
      expect(l.workspaces[made.t1]).toBeUndefined();

      // the one in no group has a place of its own, outside every area
      const loose = l.workspaces[made.loose];
      expect(loose).toBeDefined();
      for (const a of Object.values(l.areas)) expect(overlaps(loose, a)).toBe(false);

      // nothing lost: every session's on the landscape or in the Closed sessions list
      const closed = await app.evaluate<{ id: string; title: string }[]>("window.mb.resumableSessions()");
      expect(closed.map((s) => s.id).sort()).toEqual(Object.values(made).sort());
      expect(l.workspaces[made.unseen]).toBeUndefined();

      // and it's what the window draws, with nothing said to be wrong
      await untilTrue("the window's landscape", async () => await app.evaluate<boolean>(`!!document.querySelector(".ls-viewport") && document.querySelectorAll(".ls-world .ls-area").length === 2`), 30_000);
      expect(await app.evaluate<string[]>(`[...document.querySelectorAll(".ls-banner .t")].map((e) => e.textContent)`)).toEqual([]);

      // what the grid left is as it left it: a downgrade comes back to it
      await new Promise((r) => setTimeout(r, 1500));
      expect(await prefsOf(app, keys)).toEqual(Object.fromEntries(keys.map((k) => [k, JSON.stringify(prefs[k])])));

      // a place changed after the read-in, as a drag would: a second read-in would put it back where the grid had it
      const moved = { ...a1, y: a1.y + 8000 };
      expect(await app.evaluate(`window.mb.landscapeUpdate(${JSON.stringify({ workspaces: { [made.a1]: moved } })})`)).not.toHaveProperty("error");
      await new Promise((r) => setTimeout(r, 1000));
      await quit(app);

      // started again: never read in twice, once the window has drawn and its lists have had time to load
      const again = await launchApp("Legacy", "", { home, keepState: true });
      try {
        await untilTrue("the window's landscape again", async () => await again.evaluate<boolean>(`!!document.querySelector(".ls-viewport") && document.querySelectorAll(".ls-world .ls-area").length === 2`), 30_000);
        await new Promise((r) => setTimeout(r, 3000));
        const l2 = (await landscapeOf(again)).landscape;
        expect(l2.migratedAt).toBe(l.migratedAt);
        expect(l2.workspaces[made.a1]).toEqual(moved);
        expect(await prefsOf(again, keys)).toEqual(Object.fromEntries(keys.map((k) => [k, JSON.stringify(prefs[k])])));
      } finally {
        await quit(again);
      }
    } catch (err) {
      if (app.child.exitCode === null) await quit(app);
      throw err;
    }
  }, 180_000);

  it("says what it couldn't read of a spoiled layout, draws every session, and leaves the spoiled pref as it found it", async () => {
    const first = await launchApp("Spoiled", "");
    const home = first.home;
    const s = await first.evaluate<{ id: string; error?: string }>(`window.mb.createSession({ repoPath: null, useWorktree: false, shell: true, title: "kept" })`);
    expect(s.error).toBeUndefined();
    await first.evaluate(`window.mb.setGroup(${JSON.stringify(s.id)}, "5101")`);
    await first.evaluate(`localStorage.setItem("mb.trees", "{not json"); localStorage.setItem("mb.shown", ${JSON.stringify(JSON.stringify([s.id]))})`);
    await quit(first);
    fs.rmSync(path.join(home, ".mockingbird", "landscape.json"), { force: true });

    const app = await launchApp("Spoiled", "", { home, keepState: true });
    try {
      const l = await migrated(app);
      expect(l.areas).toHaveProperty("5101");
      await untilTrue("what it says", async () => (await app.evaluate<string>(`document.querySelector(".ls-banner .m")?.textContent ?? ""`)).startsWith("mb.trees couldn't be read"), 30_000);
      expect(await app.evaluate<string>(`localStorage.getItem("mb.trees")`)).toBe("{not json");
    } finally {
      await quit(app);
    }
  }, 120_000);
});
