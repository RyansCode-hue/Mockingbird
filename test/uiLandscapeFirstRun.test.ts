import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { EMPTY_TILES } from "../src/renderer/landscapeFirstRun";
import { SHORTCUTS, shortcutIds } from "../src/renderer/landscapeShortcuts";
import { tempDir } from "./helpers";

// S8's first run in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the script passes a
// mock keychain. ?landscapeFirstRunAudit (src/preview/firstRunAudit.ts) presses keys and the mouse for real, through
// the driver in scripts/ui-preview.mjs, and reports what each did.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

async function run(part: string, query = "", size = "1440x900"): Promise<Out> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const id = "mb-landscape-first-run-audit";
  const json: string | null = await pageResult({
    size,
    query: `labs=landscape${/motion=/.test(query) ? "" : "&motion=off"}&landscapeFirstRunAudit=${part}${query ? `&${query}` : ""}`,
    outDir: path.join(tempDir(`${id}-${part}`), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}=${part}&${query}`);
  const out = JSON.parse(json) as Out;
  expect(out.error).toBeUndefined();
  return out;
}

const CREATE = ["Claude…", "Codex…", "Terminal…", "From a ticket…", "Import…"];

describe.skipIf(!local)("the shortcuts sheet", () => {
  it("lists only what a real key press was seen to do, every row driven", async () => {
    // needsMany: three or more in Needs you, so ⇧N going back can't pass for N going on
    const k = await run("k", "lsCamera=0,0,0.5&needsMany");
    expect(k.why).toEqual({});
    const ids = shortcutIds();
    expect(Object.keys(k.driven).sort()).toEqual([...ids].sort());
    for (const id of ids) expect([id, k.driven[id]]).toEqual([id, true]);

    // the sheet draws the module's rows, in its three sections, under its button and inside the window
    expect(k.sheetRows).toEqual(SHORTCUTS.flatMap((s) => s.rows.map((r) => r.id)));
    expect(k.sheetSections).toEqual(["Move around", "Work", "Build"]);
    expect(k.sheetBox.y).toBeGreaterThanOrEqual(k.keysBtn.y + k.keysBtn.h);
    expect(k.sheetBox.y + k.sheetBox.h).toBeLessThanOrEqual(900);

    // ? toggles it, and Esc gives the keyboard back to the landscape it came from
    expect(k.sheetAfterToggle).toEqual({ open: false, keyboard: "landscape" });
    expect(k.sheetAfterEsc).toEqual({ open: false, keyboard: "landscape" });

    // the landscape has the keyboard from the start; nothing was clicked first
    expect(k.keyboardAtStart).toBe("landscape");
    // the palette clicked away gives the keyboard back to the landscape, so `?` works straight after
    expect(k.afterScrim).toEqual({ palette: false, keyboard: "landscape", sheet: true });
    // with the keyboard nowhere, keys do nothing and leave it there
    expect(k.nowhere).toEqual({ at: "body", keyboard: "body", sheet: false, selected: true, focus: false, writes: 0 });
    // in a text field and in a terminal, `?` is theirs
    expect(k.questionInField.sheet).toBe(false);
    expect(k.questionInField.value).toBe("?");
    expect(k.questionInTerminal.keyboard).toBe("terminal");
    expect(k.questionInTerminal.sheet).toBe(false);
    expect(k.questionInTerminal.typed).toBeGreaterThan(0);
  }, 180_000);
});

describe.skipIf(!local)("the migration tour", () => {
  it("walks four steps on the real thing, then is done for good", async () => {
    const t = await run("t", "lsTour&do=done");
    expect(t.first).toMatchObject({ step: "areas", title: "Your groups are now areas", count: "1 of 4", buttons: ["Next", "Skip the tour"], keyboard: "tour", cardInWindow: true, cardOverRing: false });
    expect(t.first.next).toBe("Next: zooming and focus · tool windows · what needs you");
    expect(t.ringAroundAnArea).toBe(true);
    expect(t.ringInView).toBe(true);
    // everything's in view at the fit, so the camera stays
    expect(t.cameraMoved).toBe(false);

    // the dim takes presses, and Tab goes round the card's buttons, never to what's behind
    expect(t.afterPressAndTabs).toEqual({ tabbed: Array(5).fill("tour"), selection: true, tour: true });
    expect(t.focusSentAway).toBe("tour");

    expect(t.steps.map((s: Out) => s.step)).toEqual(["areas", "zoom", "tools", "needs"]);
    expect(t.steps.map((s: Out) => s.count)).toEqual(["1 of 4", "2 of 4", "3 of 4", "4 of 4"]);
    for (const s of t.steps.slice(1)) {
      expect([s.step, s.ringHolds]).toEqual([s.step, true]);
      expect([s.step, s.cardInWindow]).toEqual([s.step, true]);
      expect([s.step, s.cardOverRing]).toEqual([s.step, false]);
      expect([s.step, s.keyboard]).toEqual([s.step, "tour"]);
    }
    // the last says Done, with nothing to skip
    expect(t.steps[3]).toMatchObject({ title: "What needs you is in one place", next: null, buttons: ["Done"] });

    expect(t.after).toEqual({ tour: false, scrim: false, tourDone: true, keyboard: "landscape", cameraBack: true });
  }, 120_000);

  it("stays gone after a restart, however it ended", async () => {
    // lsPersist keeps the landscape across a reload, read back through the file's own checks
    for (const how of ["skip", "esc", "done"]) {
      const t = await run("t", `lsTour&lsPersist&do=${how}&second=${how}`);
      expect([how, t.afterRestart]).toEqual([how, { tour: false, tourDone: true }]);
    }
  }, 180_000);

  it("fits and stays beside what it points at at 1024×768", async () => {
    const t = await run("t", "lsTour&do=done", "1024x768");
    for (const s of t.steps) {
      expect([s.step, s.cardInWindow]).toEqual([s.step, true]);
      expect([s.step, s.cardOverRing]).toEqual([s.step, false]);
      expect(s.card.y).toBeGreaterThanOrEqual(40);
    }
  }, 120_000);

  it("brings an area off screen into view, and puts the camera back", async () => {
    const t = await run("t", "lsTour&do=done&lsCamera=9000,9000,1");
    expect(t.cameraMoved).toBe(true);
    expect(t.ringAroundAnArea).toBe(true);
    expect(t.ringInView).toBe(true);
    expect(t.first.cardInWindow).toBe(true);
    expect(t.after.cameraBack).toBe(true);
  }, 120_000);

  it("ends at the same place with motion on", async () => {
    const t = await run("t", "lsTour&do=done&lsCamera=9000,9000,1&motion=full");
    expect(t.ringAroundAnArea).toBe(true);
    expect(t.after.cameraBack).toBe(true);
    expect(t.cardEnd).toEqual({ opacity: "1", transform: "none" });
    expect(t.steps.map((s: Out) => s.step)).toEqual(["areas", "zoom", "tools", "needs"]);
    expect(t.after.tourDone).toBe(true);
  }, 120_000);

  it("gives a fresh install the empty landscape, with no tour then or later", async () => {
    const e = await run("e", "lsTour&landscape=fresh&lsOnly=nothing&make");
    expect(e.state.kind).toBe("empty");
    expect(e.tour).toBe(false);
    expect(e.tourDone).toBe(true);
    expect(e.made).toMatchObject({ empty: false, workspace: true, inView: true, tour: false, tourDone: true });
  }, 120_000);

  it("takes someone migrating on a tour after their layout is read in", async () => {
    const t = await run("t", "lsTour&landscape=fresh&do=skip");
    expect(t.first.step).toBe("areas");
    expect(t.after.tourDone).toBe(true);
  }, 120_000);

  it("says workspaces, not groups, when nothing became an area", async () => {
    const t = await run("t", "lsTour&lsOnly=ghosts&do=done");
    expect(t.first.title).toBe("Your sessions are now workspaces");
    expect(t.ringInView).toBe(true);
    expect(t.steps.map((s: Out) => s.step)).toEqual(["areas", "zoom", "tools", "needs"]);
  }, 120_000);

  it("doesn't start, or settle that there's nothing to tour, until everything has been read", async () => {
    for (const q of ["landscape=unreadable&lsOnly=nothing", "lsOnly=nothing&lsListFail=1000", "lsOnly=nothing&lsClosedReadFails=1000", "lsOnly=nothing&teamLiveFail=always", "landscape=unreadable"]) {
      const e = await run("e", `lsTour&${q}`);
      expect([q, e.tour, e.tourDone]).toEqual([q, false, false]);
    }
  }, 300_000);

  it("says so when it can't save that it was seen, and doesn't come back in this run", async () => {
    const t = await run("t", "lsTour&do=skip&lsTourSaveFails&lookAgain");
    expect(t.after).toMatchObject({ tour: false, tourDone: false });
    expect(t.note).toMatch(/may show again next time.*ENOSPC/);
    // a flag that couldn't be saved isn't a problem with the layout
    expect(t.banners.join()).not.toMatch(/ENOSPC/);
    expect(t.backAgain).toBe(false);
  }, 120_000);

  it("isn't settled, either way, while the grid's layout hasn't been read in", async () => {
    const e = await run("e", "lsTour&landscape=fresh&lsMigrateFails");
    expect(e.state.saysEmpty).toBe(false);
    expect(e.tour).toBe(false);
    expect(e.tourDone).toBe(false);
  }, 120_000);

  it("holds the window's keys off under it: ⌘E focuses nothing behind it", async () => {
    const u = await run("u", "case=keys");
    expect(u.cmdE).toEqual({ focus: false, tour: true });
    expect(u.afterEsc).toEqual({ tour: false, selected: "s1", focus: false });
  }, 120_000);

  it("gives the keyboard back to the field that had it", async () => {
    const u = await run("u", "case=field");
    expect(u.before).toBe("input");
    expect(u.after).toEqual({ tour: false, keyboard: "input", field: true });
  }, 120_000);

  it("leaves no ring behind when what a step points at isn't on screen", async () => {
    const u = await run("u", "case=ring");
    expect(u.zoomStep).toEqual({ step: "zoom", ring: true });
    expect(u.targetGone).toEqual({ ring: false, cardInWindow: true });
  }, 120_000);

  it("leaves a Tidy's Undo working: saving that it was seen changes nothing to undo", async () => {
    const u = await run("u", "case=undo");
    expect(u.tidied).toEqual({ note: true, moved: true });
    expect(u.tourUp).toBe(true);
    expect(u.tourDone).toBe(true);
    expect(u.undoOffered).toBe(true);
    expect(u.undone.back).toBe(true);
    expect(u.undone.note ?? "").not.toMatch(/changed since/);
  }, 120_000);

  it("gives a terminal that had the keyboard its keyboard back, having typed nothing into it", async () => {
    const u = await run("u", "case=terminal&lsCamera=0,0,1");
    expect(u.before).toBe("terminal");
    expect(u.during).toBe("tour");
    expect(u.typedIntoTerminal).toBe(0);
    // what was typed on as it came up pressed none of its buttons: still its first step, unseen
    expect(u.stepAfterTyping).toEqual({ step: u.firstStep, tourDone: false, keyboard: "tour", onButton: false });
    expect(u.firstStep).toBe("areas");
    // once the keys stop, Tab reaches its buttons
    expect(u.tabAfterPause).toBe("next");
    expect(u.after).toMatchObject({ tour: false, keyboard: "terminal", tourDone: true });
    expect(u.typedAfter).toBe(1);
  }, 120_000);

  it("takes nothing pressed just before it came up", async () => {
    const u = await run("u", "case=typing");
    expect(u.came).toEqual({ tour: true, keyboard: "tour", onButton: false });
    expect(u.afterKeys).toEqual({ step: "areas", tourDone: false });
  }, 120_000);

  it("waits for a dialog open as it comes due", async () => {
    const u = await run("u", "case=dialog");
    expect(u.withDialog).toEqual({ tour: false, dialog: true });
    expect(u.afterDialog).toEqual({ tour: true, keyboard: "tour", tourDone: false });
  }, 120_000);

  it("goes under the palette, which gives it the keyboard and Esc back", async () => {
    const u = await run("u", "case=palette");
    expect(u.palette).toEqual({ was: "tour", keyboard: "palette", onTop: true, tour: true });
    expect(u.afterPalette).toEqual({ palette: false, tour: true, keyboard: "tour", tourDone: false });
    expect(u.afterSecondEsc).toEqual({ tour: false, tourDone: true, keyboard: "landscape" });
  }, 120_000);

  it("waits out focus, and for the Needs you tray", async () => {
    const f = await run("u", "case=focus");
    expect(f.inFocus).toEqual({ focus: true, tour: false });
    expect(f.afterFocus).toEqual({ focus: false, tour: true, keyboard: "tour" });
    const n = await run("u", "case=tray");
    expect(n.withTray).toEqual({ tray: true, tour: false });
    expect(n.afterTray).toEqual({ tray: false, tour: true, keyboard: "tour" });
    expect(n.pressOnDimmedButton).toEqual({ tray: false, tour: true });
  }, 180_000);
});

describe.skipIf(!local)("the tour's camera", () => {
  const far = "lsTour&lsCamera=9000,9000,1";
  const start = { x: 9000, y: 9000, zoom: 1 };
  for (const how of ["esc", "skip"])
    it(`goes back where it was when the tour is ended (${how}) during its first flight`, async () => {
      const c = await run("c", `${far}&case=${how}&motion=full`);
      expect(c.flying).toBe(true);
      expect(c.endedFlying).toBe(true);
      expect(c.end).toEqual({ tour: false, camera: start, saved: start, kept: "null" });
    }, 120_000);

  it("goes back after a tab away and back during the tour, and was never saved as the tour's", async () => {
    const c = await run("c", `${far}&case=tab`);
    expect(c.during.camera).not.toEqual(start);
    expect(c.during.saved).toEqual(start);
    expect(c.tourAgain).toBe(true);
    expect(c.end).toEqual({ tour: false, camera: start, saved: start, kept: "null" });
  }, 120_000);

  it("opens where it was after a restart during the tour, and goes back there when it ends", async () => {
    const c = await run("c", `${far}&case=restart`);
    expect(c.openedAt).toEqual(start);
    expect(c.tourAgain).toBe(true);
    expect(c.end).toEqual({ camera: start, saved: start, kept: "null" });
  }, 120_000);

  it("stays where ⌘K's Go to took it during the tour", async () => {
    const c = await run("c", `${far}&case=goto`);
    expect(c.gotoRow).toMatch(/^Go to #?51\d\d/);
    expect(c.gotoRow).not.toContain(c.tourShows ?? "none");
    expect(c.wentTo).not.toEqual(start);
    expect(c.during.camera).not.toEqual(c.wentTo);
    expect(c.end).toEqual({ tour: false, camera: c.wentTo, saved: c.wentTo, kept: "null" });
  }, 120_000);
});

describe.skipIf(!local)("keys after a terminal goes", () => {
  it("runs nothing typed on after the terminal with the keyboard goes, and sends it to no other session", async () => {
    const u = await run("u", "case=dropped&lsCamera=0,0,1");
    expect(u.before).toBe("terminal");
    expect(u.dropped).toBe("body");
    expect(u.afterTyping).toEqual({ keyboard: "body", calls: [], selected: true, camera: true, focus: false, sheet: false, note: null });
  }, 120_000);
});

describe.skipIf(!local)("the landscape's typed keys act only once the user arms it", () => {
  const nothingRan = { tour: false, others: [], changes: [], selected: true, focus: false, sheet: false, dialog: false, menu: false, palette: false };
  for (const [how, motion] of [
    ["esc", "off"],
    ["skip", "full"],
  ] as const)
    it(`runs nothing typed straight after the tour ends (${how}) as its camera comes back, and sends it to no other session`, async () => {
      const a = await run("a", `case=tour&how=${how}&motion=${motion}&lsCamera=0,0,1&needsMany`, "1024x768");
      expect(a.before).toBe(true);
      expect(a.tourUp).toEqual({ tour: true, terminalsTakeKeys: false });
      // the tour's end gives the landscape no keyboard: it's nowhere until s1's terminal takes it
      expect(a.atEnd).toBe("body");
      expect(a.after).toMatchObject(nothingRan);
      expect(a.typedAfter).toEqual(["s1"]);
    }, 120_000);

  it("ends the tour's hold on the keyboard at a press, and gives the terminal nothing after it", async () => {
    const a = await run("a", "case=tour&how=click&lsCamera=0,0,1&needsMany", "1024x768");
    expect(a.tourUp).toEqual({ tour: true, terminalsTakeKeys: false });
    expect(a.afterClick).toEqual({ spacer: true, atPress: "body", keyboard: "body", s1HadKeys: [] });
  }, 120_000);

  it("keeps a peek's Space and Enter out of a terminal elsewhere being typed in", async () => {
    const a = await run("a", "case=peekLog&lsCamera=0,0,0.5");
    expect(a.before).toBe(true);
    expect(a.peek).toEqual({ of: "ws:5101/api", pinned: false });
    // every key typed reached the log's terminal, Space and both Enters included
    expect(a.after).toEqual({ peek: { of: "ws:5101/api", pinned: false }, focus: false, sessionWrites: [], inLog: true, logData: "h x\ryes\r" });
  }, 120_000);

  it("keeps a peek's Space and Enter from acting with the keyboard nowhere", async () => {
    const a = await run("a", "case=peekGone&lsCamera=0,0,0.5");
    expect(a.before).toBe(true);
    expect(a.peek).toEqual({ of: "ws:5101/api", pinned: false });
    expect(a.after).toEqual({ peek: { of: "ws:5101/api", pinned: false }, focus: false, sessionWrites: [], inLog: false, logData: "" });
  }, 120_000);

  it("leaves the view where ⌘K went during the tour, and gives the terminal left nothing typed after", async () => {
    const a = await run("a", "case=jumpInTour&lsCamera=0,0,1");
    expect(a.before).toBe(true);
    expect(a.tourUp).toBe(true);
    expect(a.jumped).toEqual({ selected: "s4", tour: true });
    expect(a.after).toMatchObject({ tour: false, selected: "s4", cameraBack: false, toS1: 0 });
  }, 120_000);

  it("gives the session left nothing typed straight after ⌘K's Enter on another", async () => {
    const a = await run("a", "case=jumpKeys&lsCamera=0,0,1");
    expect(a.before).toBe(true);
    expect(a.after).toEqual({ s1HadKeys: [], toS1: 0, last: "s4", selected: "s4" });
  }, 120_000);

  it("takes nothing typed while it has the keyboard by code, until a press arms it", async () => {
    const a = await run("a", "case=press&needsMany");
    const none = { moved: false, focus: false, sheet: false, dialog: false, menu: false, palette: false };
    expect(a.byCode).toEqual({ keyboard: "landscape", ...none });
    expect(a.afterPalette).toEqual({ keyboard: "landscape", ...none });
    expect(a.byPress).toEqual({ keyboard: "landscape", moved: true });
    expect(a.afterPalette2).toEqual({ sheet: true });
  }, 120_000);

  it("takes nothing typed on after a zoom out moves the keyboard from a terminal to it", async () => {
    const a = await run("a", "case=zoomOut&lsCamera=0,0,1&needsMany");
    expect(a.afterZoom).toEqual({ inS1: true, terminalsTakeKeys: false, keyboard: "landscape", moved: false });
  }, 120_000);
});

describe.skipIf(!local)("the empty landscape", () => {
  it("offers what exists, and right-click works everywhere it says", async () => {
    const e = await run("e", "lsOnly=nothing");
    expect(e.state).toMatchObject({ kind: "empty", title: "An empty landscape", hud: false, closed: null });
    expect(e.state.tiles).toEqual(EMPTY_TILES.map((t) => `${t.title} / ${t.sub}`));
    expect(e.state.tiles.join()).not.toMatch(/pipeline|collab|house/i);
    expect(e.state.foot).toContain("Join a room…");
    expect(e.state.foot).not.toMatch(/team tab/i);
    expect(e.keyboardAtStart).toBe("landscape");
    expect(e.questionMark).toBe(true);
    expect(e.keyboardAfterSheet).toBe("landscape");
    for (const [where, rows] of Object.entries(e.menus as Record<string, string[]>)) expect([where, rows.filter((r) => CREATE.includes(r))]).toEqual([where, CREATE]);
    expect(Object.keys(e.menus)).toHaveLength(7);
    expect(e.keyboardAfterMenus).toBe("landscape");
    expect(e.marqueeFromWords).toBe(true);
    expect(e.tilesOpen["new:ticket"]).toMatchObject({ launch: "Claude", mode: "New", ticket: true });
    expect(e.tilesOpen["new:claude"]).toMatchObject({ launch: "Claude", mode: "New" });
    expect(e.tilesOpen["new:import"]).toMatchObject({ mode: "Import" });
    expect(e.keyboardAfterDialog).toBe("landscape");
    expect(e.joinDialog).toMatch(/join/i);
  }, 120_000);

  it("isn't shown over ghosts, a placed tool window or an area, each brought into view", async () => {
    for (const only of ["ghosts", "windows", "area"]) {
      const e = await run("e", `lsOnly=${only}`);
      expect([only, e.state.kind, e.state.saysEmpty]).toEqual([only, null, false]);
      expect([only, e.drawn?.inView]).toEqual([only, true]);
      expect([only, e.state.hud]).toEqual([only, true]);
    }
  }, 180_000);

  it("is shown beside a docked window, which isn't on it", async () => {
    const e = await run("e", "lsOnly=docked");
    expect(e.state.kind).toBe("empty");
  }, 120_000);

  it("names the Closed list when closed sessions are all there is, and shows it from there", async () => {
    const e = await run("e", "lsOnly=closed");
    expect(e.state).toMatchObject({ kind: "empty", closed: "2 closed sessions can be reopened from the Closed list in the side bar." });
    expect(e.showItWithTree).toBe(false);
    expect(e.showItWithoutTree).toBe(true);
    expect(e.treeBack).toBe(true);
    // the side bar showing Team rooms: the same, Show it bringing the area tree back
    const t = await run("e", "lsOnly=closed&team");
    expect(t.team).toEqual({ title: "Team rooms", showIt: true, after: "Landscape" });
  }, 120_000);

  it("scrolls in a view too short for it, its title first", async () => {
    const e = await run("e", "lsOnly=nothing&tall", "640x420");
    expect(e.tall).toEqual({ scrolls: true, titleShown: true, footShown: true });
  }, 120_000);

  it("gives a fresh install whose 'nothing to tour' wasn't saved no tour later in the run, and no layout problem", async () => {
    const e = await run("e", "lsTour&landscape=fresh&lsOnly=nothing&lsTourSaveFails&addArea");
    expect(e.state.kind).toBe("empty");
    expect(e.note).toMatch(/may show again next time.*ENOSPC/);
    expect(e.afterArea).toEqual({ area: true, tour: false, tourDone: false });
  }, 120_000);

  it("never says empty over what couldn't be read", async () => {
    const unreadable = await run("e", "landscape=unreadable&lsOnly=nothing");
    expect(unreadable.state).toMatchObject({ kind: "broken", title: "The layout file can't be read", tiles: [], saysEmpty: false });
    // why, in the panel itself: the banner saying it too can be put away
    expect(unreadable.state.text).toMatch(/couldn't be read/);

    const reset = await run("e", "landscape=corrupt&lsOnly=nothing");
    expect(reset.state).toMatchObject({ kind: "reset", title: "The layout was reset", saysEmpty: false });
    expect(reset.state.text).toMatch(/moved to \S+\.bad-/);
    expect(reset.state.tiles).toHaveLength(EMPTY_TILES.length);

    const list = await run("e", "lsOnly=nothing&lsListFail=1000&retry");
    expect(list.state).toMatchObject({ kind: "broken", title: "Couldn't read your sessions", saysEmpty: false });
    expect(list.hasRetry).toBe(true);

    const closed = await run("e", "lsOnly=nothing&lsClosedReadFails=1000");
    expect(closed.state).toMatchObject({ kind: "broken", title: "Couldn't read your closed sessions", saysEmpty: false });

    const team = await run("e", "lsOnly=nothing&teamLiveFail=always");
    expect(team.state).toMatchObject({ kind: "broken", title: "Couldn't read teammates' sessions", saysEmpty: false });
  }, 240_000);

  it("says empty once a list that failed is read, on Try again", async () => {
    const e = await run("e", "lsOnly=nothing&lsListFail=1&retry");
    expect(e.state.kind).toBe("broken");
    expect(e.afterRetry.kind).toBe("empty");
  }, 120_000);
});

describe.skipIf(!local)("the top bar", () => {
  const whole = (b: Out) => {
    expect(b.oneLine).toBe(true);
    expect(b.inWindow).toBe(true);
    expect(b.apart).toBe(true);
    expect(b.notCut).toBe(true);
    expect(b.scrollsSideways).toBe(false);
    expect(b.whatsNew).toBe(true);
  };

  it("has the tabs, Needs you, ? Shortcuts and + New, whose menu opens at the view's centre", async () => {
    const b = await run("b");
    whole(b);
    expect(b.tabs).toEqual(["Landscape", "Dashboard", "WorkTracker", "Council", "Settings"]);
    expect(b.keys).toBe(true);
    expect(b.more).toBe(null);
    expect(b.height).toBeLessThanOrEqual(41);
    expect(b.items.slice(-3)).toEqual([expect.stringMatching(/^Needs you/), "? Shortcuts", "+ New"]);
    expect(b.newMenu.rows.filter((r: string) => CREATE.includes(r))).toEqual(CREATE);
    expect(Math.abs(b.newMenu.at.x - b.newMenu.centre.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.newMenu.at.y - b.newMenu.centre.y)).toBeLessThanOrEqual(1);
    expect(b.newMenu.keyboard).toBe("menu");
    expect(b.afterNewMenu).toMatch(/^topbar:\+ New/);
    // what it makes lands clear of what's there, in the area under the centre when there's one
    expect(b.made.id).toBeTruthy();
    expect(b.made.overlaps).toEqual([]);
    expect(b.made.group ?? null).toBe(b.centreInArea);
    // in focus too, over it
    expect(b.newInFocus).toEqual({ focus: true, menu: true, onTop: true });
    // a row's dialog has the keyboard
    expect(b.newDialogKeyboard).toBe("dialog");
    // in focus on #5102, what it makes is 5102's and lands in 5102, whatever's at the landscape's centre behind it
    expect(b.focusDialog).toMatchObject({ focus: true, says5102: true, says5101: false });
    expect(b.madeInFocus).toEqual({ group: "5102", inArea: true });
  }, 120_000);

  for (const [size, tab] of [["560x700", "sessions"], ["575x700", "sessions"], ["558x700", "settings"], ["563x700", "settings"]] as const)
    it(`fits its items inside the window at ${size} on ${tab}`, async () => {
      const b = await run("b", `case=edges&tab=${tab}`, size);
      whole(b);
      expect(b.rightEdge).toBeLessThanOrEqual(b.window.w);
    }, 120_000);

  it("gives the keyboard back past the palette or the menu a sheet or a dialog was opened from", async () => {
    const b = await run("b", "case=handback&lsCamera=0,0,1");
    expect(b.start).toBe("terminal");
    expect(b.sheetFromPalette).toBe(true);
    expect(b.afterSheetFromPalette).toEqual({ keyboard: "terminal", typed: 1 });
    expect(b.dialogFromPalette).toBe("New session");
    expect(b.afterDialogFromPalette).toEqual({ keyboard: "terminal", typed: 1 });
    expect(b.dialogFromMenu).toEqual({ dialog: "New session", keyboard: "dialog" });
    expect(b.afterDialogFromMenu).toBe("landscape");
    expect(b.focusStart).toBe("terminal");
    expect(b.afterSheetInFocus).toEqual({ keyboard: "terminal", typed: 1, focus: true });
  }, 120_000);

  it("keeps » and the sheet under it where they are as Needs you's count changes", async () => {
    const b = await run("b", "case=foldsheet", "700x800");
    expect(b.countChanged.needs[0]).not.toEqual(b.countChanged.needs[1]);
    expect(b.countChanged).toMatchObject({ sameMore: true, sheetStayed: true, sheetUnderMore: true, keyboard: "sheet" });
    expect(b.afterEsc).toMatch(/^topbar:» \d more/);
    expect(b.afterSecondChange).toEqual({ keyboard: expect.stringMatching(/^topbar:» \d more/), sameMore: true });
    expect(b.tOnMore).toBe(null);
  }, 120_000);

  for (const size of ["1024x768", "860x700"])
    it(`keeps everything whole at ${size}`, async () => {
      const b = await run("b", "", size);
      whole(b);
      expect(b.tabs).toHaveLength(5);
      expect(b.keys).toBe(true);
    }, 120_000);

  it("folds what doesn't fit behind » in a narrower window, nothing lost", async () => {
    const b = await run("b", "case=fold", "640x700");
    whole(b);
    expect(b.more).toMatch(/^» \d more/);
    expect(b.tabs).toContain("Landscape");
    expect(b.items.at(-1)).toBe("+ New");
    expect(b.foldMenu).toContain("? Shortcuts");
    // every tab is either on the bar or in the menu
    for (const t of ["Dashboard", "WorkTracker", "Council", "Settings"]) expect([t, b.tabs.includes(t) || b.foldMenu.includes(t)]).toEqual([t, true]);
    expect(b.sheetFolded).toEqual({ open: true, inWindow: true });
    expect(b.hadShortcutRow).toBe(true);
    expect(b.toSettings).toBe(true);
  }, 120_000);

  it("+ New on another tab opens New session, and the Landscape tab gives the landscape the keyboard", async () => {
    const b = await run("b", "case=tab");
    expect(b.fromDashboard).toEqual({ dialog: "New session", menu: false, tab: "Dashboard" });
    expect(b.backOnTab).toEqual({ tab: "Landscape", keyboard: "landscape" });
    expect(b.questionAfterTabClick).toBe(true);
  }, 120_000);

  it("has the sheet whole at 1024×768, and takes turns with the tray and the palette", async () => {
    // headless Chrome's --window-size counts 87 px of its own above the page
    const b = await run("b", "case=sheet", "1024x855");
    expect(b.window).toEqual({ w: 1024, h: 768 });
    expect(b.sheet).toEqual({ open: true, inWindow: true, scrolls: false, keyboard: "sheet" });
    expect(b.sheetToggled).toEqual({ open: false, keyboard: "topbar:? Shortcuts" });
    expect(b.sheetOverTray).toEqual({ sheet: true, tray: false });
    expect(b.trayOverSheet).toEqual({ sheet: false, tray: true });
    expect(b.paletteOverSheet).toEqual({ sheet: false, palette: true });
    expect(b.afterPalette).toEqual({ sheet: false, keyboard: "landscape" });
    expect(b.fromPalette).toEqual({ sheet: true, palette: false });
  }, 120_000);

  it("is the same whole in the light theme", async () => {
    whole(await run("b", "theme=light&case=tab", "1024x768"));
  }, 120_000);
});

