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
  presets: { s1: string; s4: string };
  panZoom: { cardsAtFit: number; resized: string[]; wheel: boolean; wheelOver: boolean; space: boolean; middle: boolean; pinch: { zoomIn: boolean; drift: number | null }; cmdScroll: boolean; fit: number | null; hundred: number | null; sizes: string[] };
  typing: { camera: boolean; focused: boolean; selected: string | null };
  placement: { sent: string[]; want: string; term: string };
  focusOwn: { entered: boolean; sent: string[]; want: string; keyboard: boolean };
  escInTerminal: { stillFocused: boolean; wroteEsc: number };
  back: { left: boolean; sent: string[]; want: string; keyboard: boolean };
  cmdE: { entered: boolean; leftByEsc: boolean };
  focusRemote: { id: string; entered: boolean; font: number | null; size: string; fontBefore: number | null; ownerSize: string; ownerRoom: string | null; left: boolean; sent: string[]; fontAfter: number | null };
  stackTab: { front: string | null; left: boolean; sent: string[]; want: string[]; sizes: string[]; stackSize: string };
  cmdEAnywhere: { fromSidebar: string | null; fromTerminal: string | null; left: boolean };
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
    // the fit went through the cards band and back, which resized nothing either
    expect(pz.cardsAtFit).toBeGreaterThan(8);

    // each of your workspaces: colsRows of its placement at the measured cell, told to its pty, and its holder exactly
    // the room the frame leaves (WORKSPACE_CHROME matches WorkspaceNode); still so after all that panning and zooming
    expect(a.placed.map((p) => p.id)).toEqual(["s1", "s2", "s4", "s5", "s7", "s8"]);
    for (const p of a.placed) {
      expect(p.term, p.id).toBe(p.want);
      expect(p.pty, p.id).toBe(`${p.id} ${p.want}`);
      expect(p.holder, p.id).toBe(p.room);
    }
    expect(pz.sizes).toEqual(a.placed.map((p) => p.want));
    // the M presets hold exactly their sizes at the cell xterm measures
    expect(a.presets).toEqual({ s1: "140×42", s4: "120×24" });

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
    expect(r.size).toBe(r.ownerRoom);
    expect(r.ownerSize).toBe(r.ownerRoom);
    expect(r.font!).toBeGreaterThan(r.fontBefore!);
    expect(r.fontAfter).toBe(r.fontBefore);
    expect(r.sent).toEqual([]);

    // a stack's tab switched in focus: the member leaving the front goes back to the stack's size at once, the one
    // coming in fills the window, and leaving focus puts it back too
    const st = a.stackTab;
    expect([st.front, st.left]).toEqual(["s3", true]);
    expect(st.sent).toEqual(st.want);
    expect(st.sizes).toEqual([st.stackSize, st.stackSize]);

    // ⌘E from anywhere: right after picking a session in the side bar, and from a terminal whose workspace isn't selected
    expect(a.cmdEAnywhere).toEqual({ fromSidebar: "s5", fromTerminal: "s8", left: true });

    // ⌥→ from s1: the stack to its right, brought into the middle
    expect(a.nearest).toEqual({ selected: "ws:5101/api", moved: true });
  }, 120_000);

  it("gives a terminal the mouse only at 100%: away from it a press selects its workspace, and nothing is selected or reported", async () => {
    interface Mouse {
      drag: { zoom: number | null; on: string; selection: { start: { col: number; row: number }; end: { col: number; row: number } } | null; selected: string | null; keyboard: boolean };
      report: { mode: string; sent: string[] };
      hint: { text: string | null; over: string | null; off: string | null };
      dblclick: { focused: boolean };
      error?: string;
    }
    const at = (zoom: number) => page<Mouse>(`labs=landscape&lsCamera=0,0,${zoom}&landscapeMouseAudit`, `document.getElementById("mb-landscape-mouse-audit")?.textContent ?? null`, `ls-mouse-${zoom}`);
    for (const zoom of [0.5, 1.5]) {
      const m = await at(zoom);
      expect(m.error).toBeUndefined();
      // the press lands on the terminal's holder, never xterm: the workspace is selected, and the keyboard goes to its
      // terminal where terminals take keys (75% and up); at 50%, read-only, the landscape keeps it
      expect(m.drag, `at ${zoom}`).toEqual({ zoom, on: "holder", selection: null, selected: "s1", keyboard: zoom >= 0.75 });
      // a program that asked for the mouse is sent nothing
      expect(m.report, `at ${zoom}`).toEqual({ mode: "vt200", sent: [] });
      expect(m.hint, `at ${zoom}`).toEqual({ text: "Zoom to 100% or focus to select text", over: "1", off: "0" });
      expect(m.dblclick, `at ${zoom}`).toEqual({ focused: true });
    }
    const m = await at(1);
    expect(m.error).toBeUndefined();
    // at 100%, a drag selects the cells it went across, and a click is reported at the cell it was on (1-based)
    expect(m.drag).toEqual({ zoom: 1, on: "xterm", selection: { start: { col: 60, row: 6 }, end: { col: 80, row: 9 } }, selected: "s1", keyboard: true });
    expect(m.report).toEqual({ mode: "vt200", sent: ["\x1b[<0;11;4M", "\x1b[<0;11;4m"] });
    expect(m.hint.over).toBe("0");
    // and a double-click is the terminal's (a word selected), not focus
    expect(m.dblclick).toEqual({ focused: false });
  }, 180_000);

  it("is there only with the Labs flag on, and never reads landscape.json with it off: the grid renders as before", async () => {
    const read = `(() => {
      const start = (window.__lsStart ??= Date.now());
      if (!document.querySelector(".grid .xterm, .ls-world .ls-node") && Date.now() - start < 20000) return null;
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

  it("turned off and on again in Settings → Labs, brings the grid back as it was, the grid's layout prefs untouched", async () => {
    const read = `(() => {
      window.__lsFlip ??= (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await sleep(100); return f(); };
        const prefs = () => Object.fromEntries(Object.keys(window.__mbPrefsAtLoad).map((k) => [k, localStorage.getItem(k)]));
        const tab = (t) => [...document.querySelectorAll(".tabs .tab")].find((b) => b.textContent.startsWith(t));
        const flip = async () => {
          tab("Settings").click();
          await until(() => document.querySelector(".set-nav"));
          [...document.querySelectorAll(".set-nav button")].find((b) => b.textContent === "Labs").click();
          await until(() => document.querySelector('[role=switch][aria-label="Landscape"]'));
          const sw = document.querySelector('[role=switch][aria-label="Landscape"]');
          const was = sw.getAttribute("aria-checked");
          sw.click();
          await sleep(300);
          (tab("Sessions") ?? tab("Landscape")).click();
          return was;
        };
        await until(() => document.querySelector(".ls-world .ls-node"));
        await sleep(800);
        const whileOn = prefs();
        const wasOn = await flip();
        await until(() => document.querySelector(".grid .xterm"));
        await sleep(800);
        const afterOff = prefs();
        const grid = [...document.querySelectorAll(".grid > [data-cell]")].map((e) => e.getAttribute("data-cell"));
        const wasOff = await flip();
        await until(() => document.querySelector(".ls-world .ls-node"));
        await sleep(800);
        window.__lsResult = JSON.stringify({
          wasOn,
          wasOff,
          saved: window.__mbCalls.filter((c) => c.fn === "setSettings").map((c) => c.args[0]),
          grid,
          landscape: !!document.querySelector(".ls-viewport"),
          atLoad: window.__mbPrefsAtLoad,
          whileOn,
          afterOff,
          afterOn: prefs(),
          hint: localStorage.getItem("mb.labs.landscape"),
        });
      })();
      return window.__lsResult ?? null;
    })()`;
    const r = await page<Record<string, unknown>>("labs=landscape", read, "ls-flip");
    expect(r).toMatchObject({ wasOn: "true", wasOff: "false", saved: [{ labs: { landscape: false } }, { labs: { landscape: true } }], grid: ["s1", "ws:5101/api", "s4"], landscape: true, hint: "true" });
    // the landscape writes none of the grid's prefs, from the page's load on: only the empty defaults the app writes at
    // start for one that isn't there, grid or not
    const set = (p: unknown) => Object.fromEntries(Object.entries(p as Record<string, string | null>).flatMap(([k, v]) => (v === null || ["null", "[]", "{}"].includes(v) ? [] : [[k, JSON.parse(v)]])));
    expect(set(r.whileOn)).toEqual(set(r.atLoad));
    expect(r.afterOn).toEqual(r.afterOff);
    // and the grid, back, keeps them as it does with the landscape never shown
    const gridOnly = await page<Record<string, string | null>>(
      "",
      `(() => {
        const start = (window.__lsStart ??= Date.now());
        if (!document.querySelector(".grid .xterm") || Date.now() - start < 3000) return null;
        return JSON.stringify(Object.fromEntries(Object.keys(window.__mbPrefsAtLoad).map((k) => [k, localStorage.getItem(k)])));
      })()`,
      "ls-grid-prefs"
    );
    expect(r.afterOff).toEqual(gridOnly);
  }, 180_000);

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
    // the closed sessions the grid's layout didn't name (its Previous) get no place: the Closed sessions list holds
    // them, and 5150, which only o2 is in, gets no area
    expect(fresh.migrations[0].workspaces).toEqual(expect.arrayContaining(["s1", "s4", "s5", "s7", "s8"]));
    for (const id of ["p1", "g1", "g2", "o1", "o2"]) expect([id, fresh.migrations[0].workspaces.includes(id)]).toEqual([id, false]);
    expect(fresh.others).toBe(0);
    expect(fresh.workspaces).toBeGreaterThan(8);
    expect(fresh.banners).toEqual([]);

    const unreadable = await page<{ migrations: unknown[]; others: number; workspaces: number; banners: string[] }>("labs=landscape&landscape=unreadable", read, "ls-unreadable");
    expect(unreadable.migrations).toEqual([]);
    // shown, placed where there's room, and nothing saved over the file meanwhile
    expect(unreadable.others).toBe(0);
    expect(unreadable.workspaces).toBeGreaterThan(8);
    expect(unreadable.banners).toEqual(["The layout file can't be read", "Your grid's layout isn't read in yet"]);

    // a corrupt file moved aside: the layout really starts over, so the grid's is read in, and only the reset is said
    const corrupt = await page<{ migrations: unknown[]; others: number; workspaces: number; banners: string[] }>("labs=landscape&landscape=corrupt", read, "ls-corrupt");
    expect(corrupt.migrations).toHaveLength(1);
    expect(corrupt.banners).toEqual(["The layout was reset"]);
  }, 120_000);

  it("reads a file it couldn't read again on its own, and on Read it again, dropping what was changed meanwhile", async () => {
    const read = (change: boolean) => `(() => {
      window.__lsReread ??= (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const until = async (f) => { for (let i = 0; i < 150 && !f(); i++) await sleep(100); return f(); };
        const banners = () => [...document.querySelectorAll(".ls-banner")].map((b) => ({ title: b.querySelector(".t").textContent, actions: [...b.querySelectorAll("button.outline")].map((x) => x.textContent) }));
        const gets = () => window.__mbCalls.filter((c) => c.fn === "landscapeGet").length;
        await until(() => banners().some((b) => b.title === "The layout file can't be read") && document.querySelector(".ls-world .ls-tab"));
        await sleep(300);
        const before = banners();
        if (${change}) {
          // a change made to the stand-in: a stack's other tab to the front
          const tab = [...document.querySelectorAll(".ls-world .ls-tab")].find((t) => !t.classList.contains("on"));
          tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
          tab.click();
          await sleep(300);
        }
        const g0 = gets();
        await sleep(1200);
        const reread = gets() - g0;
        window.__lsFileReadable = true;
        if (!${change}) [...document.querySelectorAll(".ls-banner button.outline")].find((b) => b.textContent === "Read it again").click();
        await until(() => !banners().some((b) => b.title === "The layout file can't be read"));
        await sleep(500);
        const l = (await window.mb.landscapeGet()).landscape;
        window.__lsResult = JSON.stringify({
          before,
          reread,
          after: banners().map((b) => b.title),
          migrations: window.__mbCalls.filter((c) => c.fn === "landscapeUpdate" && c.args[0].migratedAt).length,
          fileLayout: !!l.migratedAt && Object.keys(l.areas).sort(),
          s1: document.querySelector('.ls-world [data-front="s1"]')?.style.left === l.workspaces.s1.x + "px",
        });
      })();
      return window.__lsResult ?? null;
    })()`;
    type Reread = { before: { title: string; actions: string[] }[]; reread: number; after: string[]; migrations: number; fileLayout: string[] | false; s1: boolean };
    // asked again every so often (shortened here): it comes back once it can be read, and the stand-in's change is dropped, said so
    const timer = await page<Reread>("labs=landscape&landscape=unreadable&lsRereadMs=300&lsCamera=0,0,0.5", read(true), "ls-reread");
    expect(timer.before).toEqual([
      { title: "The layout file can't be read", actions: ["Read it again"] },
      { title: "Your grid's layout isn't read in yet", actions: [] },
    ]);
    expect(timer.reread).toBeGreaterThanOrEqual(2);
    expect(timer.after).toEqual(["Layout changes were dropped"]);
    // the file's layout, already read in, shown as it was saved
    expect(timer).toMatchObject({ migrations: 0, fileLayout: ["5101", "5102", "5110"], s1: true });
    // Read it again: at once, and with nothing changed meanwhile nothing is dropped
    const button = await page<Reread>("labs=landscape&landscape=unreadable&lsCamera=0,0,0.5", read(false), "ls-read-again");
    expect(button.reread).toBe(0);
    expect(button).toMatchObject({ after: [], migrations: 0, fileLayout: ["5101", "5102", "5110"], s1: true });
  }, 180_000);

  it("waits for teammates' sessions to read the grid's layout in, and says so when they don't load: tried again, or read in without them", async () => {
    const read = (choice: string) => `(() => {
      window.__lsTeam ??= (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const until = async (f) => { for (let i = 0; i < 150 && !f(); i++) await sleep(100); return f(); };
        const banners = () => [...document.querySelectorAll(".ls-banner")].map((b) => ({ title: b.querySelector(".t").textContent, actions: [...b.querySelectorAll("button.outline")].map((x) => x.textContent) }));
        const updates = () => window.__mbCalls.filter((c) => c.fn === "landscapeUpdate").map((c) => c.args[0]);
        const infos = [];
        const info = console.info;
        console.info = (...a) => (infos.push(a), info.apply(console, a));
        await until(() => banners().some((b) => b.title === "Teammates' sessions didn't load"));
        await sleep(500);
        const waiting = { banners: banners(), migrations: updates().filter((p) => p.migratedAt).length, loading: document.querySelector(".ls-loading")?.textContent ?? null };
        [...document.querySelectorAll(".ls-banner button.outline")].find((b) => b.textContent === "${choice}").click();
        await until(() => updates().some((p) => p.migratedAt));
        await sleep(500);
        const m = updates().find((p) => p.migratedAt);
        const later = { remote: Object.keys(m.workspaces).filter((id) => id.startsWith("r~")).sort(), banners: banners().map((b) => b.title) };
        const n = updates().length;
        window.__mbTeamLiveBack();
        await sleep(800);
        window.__lsResult = JSON.stringify({
          waiting,
          later,
          logs: infos.map((a) => [String(a[0]), a[1]]),
          placedLater: updates().slice(n).flatMap((p) => Object.keys(p.workspaces ?? {})).filter((id) => id.startsWith("r~")).sort(),
        });
      })();
      return window.__lsResult ?? null;
    })()`;
    type Team = { waiting: { banners: { title: string; actions: string[] }[]; migrations: number; loading: string | null }; later: { remote: string[]; banners: string[] }; logs: [string, string[]][]; placedLater: string[] };
    // the grid showed Nick's session (the stub's remotePaneId(NICK, "n1")), so its layout names it
    const nick = "r~0f1e2d3c4b5a~n1";
    const shownNick = `shown=s1,s2,s3,s4,${nick}`;
    const tried = await page<Team>(`labs=landscape&landscape=fresh&teamLiveFail&${shownNick}`, read("Try again"), "ls-team-retry");
    expect(tried.waiting.banners).toEqual([{ title: "Teammates' sessions didn't load", actions: ["Try again", "Continue without teammates' sessions"] }]);
    expect(tried.waiting.migrations).toBe(0);
    expect(tried.waiting.loading).toMatch(/waiting for teammates' sessions/);
    // read again, they're read in with everything else
    expect(tried.later.remote.length).toBeGreaterThan(0);
    expect(tried.later.banners).toEqual([]);
    expect(tried.placedLater).toEqual([]);

    const without = await page<Team>(`labs=landscape&landscape=fresh&teamLiveFail=always&${shownNick}`, read("Continue without teammates' sessions"), "ls-team-without");
    expect(without.waiting.migrations).toBe(0);
    expect(without.later).toEqual({ remote: [], banners: [] });
    // the grid's places for them aren't counted as gone: they're placed where there's room once they come
    const dropped = without.logs.find(([m]) => m.includes("dropped ids that name no session"));
    expect(dropped?.[1] ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^r~/)]));
    const placedAsTheyCome = without.logs.find(([m]) => m.includes("without teammates' sessions"));
    expect(placedAsTheyCome?.[1]).toEqual([nick]);
    expect(tried.later.remote).toContain(nick);
    expect(without.placedLater).toEqual(tried.later.remote);
  }, 180_000);
});
