import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The landscape (Settings → Labs) in the UI preview, in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?landscapeAudit (src/preview/stub.ts) pans, zooms, types, moves a
// placement and focuses, and reports what each step did once it settles; never frames caught in flight.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

interface Placed {
  id: string;
  want: string;
  term: string;
  pty: string | null;
  holder: string | null;
  room: string;
}
interface Audit {
  placed: Placed[];
  panZoom: { resized: string[]; wheel: boolean; wheelOver: boolean; space: boolean; middle: boolean; pinch: { zoomIn: boolean; drift: number | null }; cmdScroll: boolean; fit: number | null; hundred: number | null; sizes: string[] };
  typing: { camera: boolean; focused: boolean; selected: string | null };
  placement: { sent: string[]; want: string; term: string };
  focusOwn: { entered: boolean; sent: string[]; want: string; keyboard: boolean };
  escInTerminal: { stillFocused: boolean; wroteEsc: number };
  back: { left: boolean; sent: string[]; want: string; keyboard: boolean };
  cmdE: { entered: boolean; leftByEsc: boolean };
  focusRemote: { id: string; entered: boolean; font: number | null; size: string; fontBefore: number | null; ownerSize: string; left: boolean; sent: string[]; fontAfter: number | null };
  nearest: { selected: string | null; moved: boolean };
  error?: string;
}

async function page<T>(query: string, read: string, name: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query, outDir: path.join(tempDir(name), "out"), read });
  if (!json) throw new Error(`the preview didn't answer (${query})`);
  return JSON.parse(json);
}

describe.skipIf(!local)("the landscape", () => {
  it("sizes each terminal from its placement, never from pan or zoom, reflows your own in focus and only scales a teammate's", async () => {
    const a = await page<Audit>("labs=landscape&landscapeAudit", `document.getElementById("mb-landscape-audit")?.textContent ?? null`, "ls-audit");
    expect(a.error).toBeUndefined();

    // panning (wheel, over a workspace that isn't selected, Space-drag, middle-drag) and zooming (pinch, ⌘-scroll,
    // ⌘0, ⌘1) resize nothing, and move the camera
    const pz = a.panZoom;
    expect(pz.resized).toEqual([]);
    expect([pz.wheel, pz.wheelOver, pz.space, pz.middle, pz.pinch.zoomIn, pz.cmdScroll]).toEqual([true, true, true, true, true, true]);
    expect(pz.pinch.drift).toBeLessThan(0.05);
    expect(pz.fit).toBeLessThan(1);
    expect(pz.hundred).toBe(1);

    // each of your workspaces: colsRows of its placement at the measured cell, told to its pty, and its holder exactly
    // the room the frame leaves (WORKSPACE_CHROME matches WorkspaceNode); still so after all that panning and zooming
    expect(a.placed.map((p) => p.id)).toEqual(["s1", "s2", "s4", "s5", "s7", "s8"]);
    for (const p of a.placed) {
      expect(p.term, p.id).toBe(p.want);
      expect(p.pty, p.id).toBe(`${p.id} ${p.want}`);
      expect(p.holder, p.id).toBe(p.room);
    }
    expect(pz.sizes).toEqual(a.placed.map((p) => p.want));

    // keys typed in a terminal, and the wheel over the selected workspace's, are the terminal's
    expect(a.typing).toEqual({ camera: true, focused: false, selected: "s1" });

    // a placement change tells the pty once, with its new size
    expect(a.placement.sent).toEqual([a.placement.want]);
    expect(`s1 ${a.placement.term}`).toBe(a.placement.want);

    // focus on your own workspace: its pty takes the window's size, and the keyboard goes to it
    expect(a.focusOwn).toEqual({ entered: true, sent: [a.focusOwn.want], want: a.focusOwn.want, keyboard: true });
    expect(a.focusOwn.want).not.toBe(a.placement.want);
    // Esc typed in its terminal reaches the agent and stays in focus; ⌘Esc leaves, resizing it back to its placement
    expect(a.escInTerminal).toEqual({ stillFocused: true, wroteEsc: 1 });
    expect(a.back).toEqual({ left: true, sent: [a.placement.want], want: a.placement.want, keyboard: true });
    // ⌘E focuses, and Esc outside the terminal leaves
    expect(a.cmdE).toEqual({ entered: true, leftByEsc: true });

    // a teammate's workspace in focus is scaled, at its owner's size, and nothing is resized
    const r = a.focusRemote;
    expect(r.id).toMatch(/^r~/);
    expect([r.entered, r.left]).toEqual([true, true]);
    expect(r.size).toBe(r.ownerSize);
    expect(r.font!).toBeGreaterThan(r.fontBefore!);
    expect(r.fontAfter).toBe(r.fontBefore);
    expect(r.sent).toEqual([]);

    // ⌥→ from s1: the stack to its right, brought into the middle
    expect(a.nearest).toEqual({ selected: "ws:5101/api", moved: true });
  }, 120_000);

  it("is there only with the Labs flag on, and never reads landscape.json with it off: the grid renders as before", async () => {
    const read = `(() => {
      const start = (window.__lsStart ??= Date.now());
      if (!document.querySelector(".grid .xterm, .ls-world .xterm") && Date.now() - start < 20000) return null;
      if (Date.now() - start < 1500) return null;
      return JSON.stringify({
        grid: [...document.querySelectorAll(".grid > [data-cell]")].map((e) => e.getAttribute("data-cell")),
        gridTerms: document.querySelectorAll(".grid .xterm").length,
        landscape: !!document.querySelector(".ls-viewport"),
        workspaces: document.querySelectorAll(".ls-world .ls-node").length,
        layoutButton: !!document.querySelector(".lay-wrap"),
        read: window.__mbCalls.filter((c) => c.fn.startsWith("landscape")).map((c) => c.fn),
      });
    })()`;
    const off = await page<Record<string, unknown>>("", read, "ls-off");
    expect(off).toEqual({ grid: ["s1", "ws:5101/api", "s4"], gridTerms: 3, landscape: false, workspaces: 0, layoutButton: true, read: [] });
    const on = await page<Record<string, unknown>>("labs=landscape", read, "ls-on");
    expect(on).toMatchObject({ grid: [], gridTerms: 0, landscape: true, layoutButton: false });
    expect(on.workspaces).toBeGreaterThan(8);
    expect(on.read).toContain("landscapeGet");
  }, 120_000);

  it("turned off in Settings → Labs, brings the grid back as it was, its layout prefs untouched", async () => {
    const read = `(() => {
      window.__lsFlip ??= (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await sleep(100); return f(); };
        const prefs = () => Object.fromEntries(["mb.shown", "mb.trees", "mb.groupLayouts", "mb.pinned", "mb.wsTabs"].map((k) => [k, localStorage.getItem(k)]));
        await until(() => document.querySelector(".ls-world .xterm"));
        await sleep(500);
        const before = prefs();
        const tab = (t) => [...document.querySelectorAll(".tabs .tab")].find((b) => b.textContent.startsWith(t));
        tab("Settings").click();
        await until(() => document.querySelector(".set-nav"));
        [...document.querySelectorAll(".set-nav button")].find((b) => b.textContent === "Labs").click();
        await until(() => document.querySelector('[role=switch][aria-label="Landscape"]'));
        const sw = document.querySelector('[role=switch][aria-label="Landscape"]');
        const wasOn = sw.getAttribute("aria-checked");
        sw.click();
        await sleep(300);
        tab("Sessions").click();
        await until(() => document.querySelector(".grid .xterm"));
        await sleep(800);
        window.__lsResult = JSON.stringify({
          wasOn,
          saved: window.__mbCalls.filter((c) => c.fn === "setSettings").map((c) => c.args[0]),
          grid: [...document.querySelectorAll(".grid > [data-cell]")].map((e) => e.getAttribute("data-cell")),
          landscape: !!document.querySelector(".ls-viewport"),
          prefsKept: JSON.stringify(prefs()) === JSON.stringify(before),
          hint: localStorage.getItem("mb.labs.landscape"),
        });
      })();
      return window.__lsResult ?? null;
    })()`;
    const r = await page<Record<string, unknown>>("labs=landscape", read, "ls-flip");
    expect(r).toEqual({ wasOn: "true", saved: [{ labs: { landscape: false } }], grid: ["s1", "ws:5101/api", "s4"], landscape: false, prefsKept: true, hint: "false" });
  }, 120_000);

  it("reads the grid's layout in the first time, once, and shows a stand-in's read problem as a banner without reading it in", async () => {
    const read = `(() => {
      const start = (window.__lsStart ??= Date.now());
      if (Date.now() - start < 3000) return null;
      const updates = window.__mbCalls.filter((c) => c.fn === "landscapeUpdate").map((c) => c.args[0]);
      return JSON.stringify({
        migrations: updates.filter((p) => p.migratedAt).map((p) => ({ areas: Object.keys(p.areas ?? {}).sort(), workspaces: Object.keys(p.workspaces ?? {}).sort(), stacks: Object.keys(p.stacks ?? {}) })),
        others: updates.filter((p) => !p.migratedAt).length,
        workspaces: document.querySelectorAll(".ls-world .ls-node").length,
        banners: [...document.querySelectorAll(".ls-banner .t")].map((e) => e.textContent),
      });
    })()`;
    const fresh = await page<{ migrations: { areas: string[]; workspaces: string[]; stacks: string[] }[]; others: number; workspaces: number; banners: string[] }>("labs=landscape&landscape=fresh", read, "ls-fresh");
    expect(fresh.migrations).toHaveLength(1);
    expect(fresh.migrations[0].areas).toEqual(["5101", "5102", "5110"]);
    expect(fresh.migrations[0].stacks).toEqual(["5101/api"]);
    // the previous run's session is read in too, so relaunching it finds its place
    expect(fresh.migrations[0].workspaces).toEqual(expect.arrayContaining(["s1", "s4", "s5", "s7", "s8", "p1"]));
    expect(fresh.others).toBe(0);
    expect(fresh.workspaces).toBeGreaterThan(8);
    expect(fresh.banners).toEqual([]);

    const unreadable = await page<{ migrations: unknown[]; others: number; workspaces: number; banners: string[] }>("labs=landscape&landscape=unreadable", read, "ls-unreadable");
    expect(unreadable.migrations).toEqual([]);
    // shown, placed where there's room, and nothing saved over the file meanwhile
    expect(unreadable.others).toBe(0);
    expect(unreadable.workspaces).toBeGreaterThan(8);
    expect(unreadable.banners).toEqual(["The layout file can't be read", "Your grid's layout isn't read in yet"]);
  }, 120_000);
});
