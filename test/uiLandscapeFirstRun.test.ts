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

async function run(part: string, query = "", size = "1440x900", limitMs?: number): Promise<Out> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const id = "mb-landscape-first-run-audit";
  const json: string | null = await pageResult({
    size,
    query: `${/motion=/.test(query) ? "" : "motion=off&"}landscapeFirstRunAudit=${part}${query ? `&${query}` : ""}`,
    outDir: path.join(tempDir(`${id}-${part}`), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
    limitMs,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}=${part}&${query}`);
  const out = JSON.parse(json) as Out;
  expect(out.error).toBeUndefined();
  return out;
}

/** Run `read` in the preview with `query` until it answers something other than null: its answer, parsed. */
async function look(query: string, read: string, size = "1440x900"): Promise<Out> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size, query, outDir: path.join(tempDir("mb-arming-look"), "out"), read });
  if (!json) throw new Error(`the preview gave nothing for ${query}`);
  return JSON.parse(json) as Out;
}

const CREATE = ["Claude…", "Codex…", "Terminal…", "From a ticket…", "Resume a conversation…", "Import conversations…"];
/** What swallowed keys say (once), with nothing selected and with a workspace selected. */
const HINT = "Click the landscape, or press ⌘E, to use its keys";
/** With a workspace selected: naming the tab ⌘E types in. */
const hintSelected = (title: string) => `Click the landscape to use its keys; ⌘E types in ${title}`;

describe.skipIf(!local)("the shortcuts sheet", () => {
  it("lists only what a real key press was seen to do, every row driven", async () => {
    // needsMany: three or more in Needs you, so ⇧N going back can't pass for N going on. Every row driven takes a
    // minute or more, the wires' rows waiting out the picker's and the step dialog's pause: Chrome gets three
    const k = await run("k", "lsCamera=0,0,0.5&needsMany", "1440x900", 180_000);
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
    // with the keyboard on the page (the landscape blurred: no typing target went, so not the holder), keys do nothing
    // and leave it there
    expect(k.nowhere).toEqual({ at: "body", keyboard: "body", sheet: false, selected: true, focus: false, writes: 0 });
    // in a text field and in a terminal, `?` is theirs
    expect(k.questionInField.sheet).toBe(false);
    expect(k.questionInField.value).toBe("?");
    expect(k.questionInTerminal.keyboard).toBe("terminal");
    expect(k.questionInTerminal.sheet).toBe(false);
    expect(k.questionInTerminal.typed).toBeGreaterThan(0);
    // the wires' rows: a handoff from s1 to s8 picked with ↵, and the step dialog for what follows s1
    expect(k.connected.ends).toMatch(/→ Release notes for #5101$/);
    expect(k.nextStep.head).toMatch(/^Next step\s*after /);
  }, 240_000);
});

describe.skipIf(!local)("the migration tour", () => {
  it("walks four steps on the real thing, then is done for good", async () => {
    const t = await run("t", "lsTour&do=done");
    expect(t.first).toMatchObject({ step: "areas", title: "Your groups are now areas", count: "1 of 4", buttons: ["Next", "Skip the tour"], keyboard: "tour", cardInWindow: true, cardOverRing: false });
    expect(t.first.next).toBe("Next: zooming and focus · wires · what needs you");
    expect(t.ringAroundAnArea).toBe(true);
    expect(t.ringInView).toBe(true);
    // everything's in view at the fit, so the camera stays
    expect(t.cameraMoved).toBe(false);

    // the dim takes presses, and Tab goes round the card's buttons, never to what's behind
    expect(t.afterPressAndTabs).toEqual({ tabbed: Array(5).fill("tour"), selection: true, tour: true });
    expect(t.focusSentAway).toBe("tour");

    expect(t.steps.map((s: Out) => s.step)).toEqual(["areas", "zoom", "wires", "needs"]);
    expect(t.steps.map((s: Out) => s.count)).toEqual(["1 of 4", "2 of 4", "3 of 4", "4 of 4"]);
    for (const s of t.steps.slice(1)) {
      expect([s.step, s.ringHolds]).toEqual([s.step, true]);
      expect([s.step, s.cardInWindow]).toEqual([s.step, true]);
      expect([s.step, s.cardOverRing]).toEqual([s.step, false]);
      expect([s.step, s.keyboard]).toEqual([s.step, "tour"]);
    }
    // with no wires yet, the wires step rings an agent's edge dot in the first step's area, shown for it alone, and
    // selects nothing
    expect(t.steps[2]).toMatchObject({ title: "Wire workspaces into a pipeline", handleOn: "s1", selected: null });
    expect(t.steps.filter((s: Out) => s.handleOn).map((s: Out) => s.step)).toEqual(["wires"]);
    // the last says Done, with nothing to skip
    expect(t.steps[3]).toMatchObject({ title: "What needs you is in one place", next: null, buttons: ["Done"] });

    expect(t.after).toEqual({ tour: false, scrim: false, tourDone: true, keyboard: "landscape", cameraBack: true });
    expect(t.handleAfter).toBe(null);
  }, 120_000);

  it("rings the selected workspace's edge dot on the wires step, bringing it into view, and changes nothing", async () => {
    // a terminal selected as the tour comes up, zoomed out past where a workspace carries a dot
    const u = await run("u", "case=handle&lsCamera=0,0,0.08");
    expect(u.dotBefore).toBe(false);
    expect(u.wires).toMatchObject({ step: "wires", handleOn: "s4", selected: "s4", ringHolds: true, cardInWindow: true, cardOverRing: false, keyboard: "tour" });
    expect(u.movedForIt).toBe(true);
    expect(u.after).toEqual({ tour: false, selected: "s4", handle: null, cameraBack: true, keyboard: "landscape", writes: 0 });
  }, 120_000);

  it("rings the first wire drawn, both its ends, once there are wires", async () => {
    const t = await run("t", "lsTour&do=done&lsWires");
    expect(t.steps[2]).toMatchObject({ step: "wires", handleOn: null, ringHolds: true, cardInWindow: true, cardOverRing: false });
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
    expect(t.steps.map((s: Out) => s.step)).toEqual(["areas", "zoom", "wires", "needs"]);
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
    expect(t.steps.map((s: Out) => s.step)).toEqual(["areas", "zoom", "wires", "needs"]);
    // only ghosts: no workspace carries an edge dot, so the wires step points at nothing, its card whole in the window
    expect(t.steps[2]).toMatchObject({ handleOn: null, ring: null, cardInWindow: true });
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
    expect(u.dropped).toBe("nowhere");
    // what's typed is swallowed, said once in the note
    expect(u.afterTyping).toEqual({ keyboard: "nowhere", calls: [], selected: true, camera: true, focus: false, sheet: false, note: HINT });
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
      expect(a.atEnd).toBe("nowhere");
      // nothing of the burst reached s1 either, its Tab and Enter included: s1 gets the keyboard once keys pause
      expect(a.after).toMatchObject({ ...nothingRan, s1Got: "" });
      expect(a.typedAfter).toEqual(["s1"]);
    }, 120_000);

  it("ends the tour's hold on the keyboard at a press, and gives the terminal nothing after it", async () => {
    const a = await run("a", "case=tour&how=click&lsCamera=0,0,1&needsMany", "1024x768");
    expect(a.tourUp).toEqual({ tour: true, terminalsTakeKeys: false });
    // the press on the bar's bare middle leaves the keyboard on the page, by the user's own act
    expect(a.afterClick).toEqual({ spacer: true, atPress: "nowhere", keyboard: "body", s1HadKeys: [] });
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

  it("runs the tour's hold to its cap when the terminal can't take the keyboard, each key holding it longer, then leaves it nowhere and logs it", async () => {
    const a = await run("a", "case=cap&lsCamera=0,0,1", "1024x768");
    expect(a.before).toBe(true);
    expect(a.tourUp).toBe(true);
    expect(a.beforeCap).toEqual({ said: 0, keyboard: "nowhere" });
    expect(a.afterCap).toEqual({ said: 1, keyboard: "nowhere", tour: false });
  }, 120_000);

  it("leaves focus at Esc on its frame only once a press armed it, not with the keyboard given it by code", async () => {
    const a = await run("a", "case=frame");
    expect(a.entered).toBe(true);
    expect(a.byCode).toEqual({ focus: true, keyboard: "frame" });
    expect(a.pressed).toBe("frame");
    expect(a.byPress).toEqual({ focus: false });
  }, 120_000);

  it("takes nothing typed on after a zoom out moves the keyboard from a terminal to it", async () => {
    const a = await run("a", "case=zoomOut&lsCamera=0,0,1&needsMany");
    expect(a.afterZoom).toEqual({ inS1: true, terminalsTakeKeys: false, keyboard: "landscape", moved: false });
  }, 120_000);

  const nothingReached = { walked: ["nowhere"], reached: [], keyboard: "nowhere", acts: [], focus: false, sheet: false, dialog: false, menu: false, palette: false };
  it("keeps Shift+Tab and what's typed after from every control when the terminal being typed in goes", async () => {
    const a = await run("a", "case=walk&how=closed&lsCamera=0,0,1&needsMany");
    expect(a.before).toBe(true);
    expect(a.gone).toEqual({ s1: true, keyboard: "nowhere" });
    // Shift+Tab ×5, then "do it" and Enter: no ghost forgotten, no button pressed, no terminal reached
    expect(a.after).toEqual(nothingReached);
  }, 120_000);

  it("keeps Tab from walking into the next workspace's terminal when the terminal being typed in goes", async () => {
    const a = await run("a", "case=walk&how=closedTab&lsCamera=0,0,1&needsMany");
    expect(a.gone).toEqual({ s1: true, keyboard: "nowhere" });
    // Tab ×9, then y: nothing written to s2, no control given the keyboard
    expect(a.after).toEqual(nothingReached);
  }, 120_000);

  it("leaves a press on nothing the page's, where Tab goes on from the press", async () => {
    const a = await run("a", "case=pressNothing");
    expect(a.pressed).toBe("body");
    expect(a.tabbed).toMatch(/^topbar:/);
  }, 120_000);

  it("keeps Shift+Tab from the status bar's buttons when the tour ends with nowhere to give the keyboard back", async () => {
    const a = await run("a", "case=walk&how=tour&lsCamera=0,0,1&needsMany");
    expect(a.tourUp).toBe(true);
    expect(a.ended).toEqual({ tour: false, keyboard: "nowhere" });
    expect(a.after).toEqual(nothingReached);
  }, 120_000);
});

describe.skipIf(!local)("the landscape armed as it mounts only by the user's choice", () => {
  const disarmed = { sheet: false, moved: false, acts: [], focus: false };
  it("isn't armed mounted by a ⌘K jump from the tab the window opened on, zoomed out past the terminal", async () => {
    const a = await run("a", "case=mount&how=jump&tab=dashboard&lsCamera=0,0,0.2&needsMany");
    expect(a.startedOn).toEqual({ landscape: false, tab: "dashboard" });
    expect(a.mounted).toEqual({ landscape: true, keyboard: "landscape", selected: "s4" });
    // "?", then N, Enter and y: no sheet, no session moved to, focused or written to; said once
    expect(a.after).toEqual({ ...disarmed, note: hintSelected("test runner") });
  }, 120_000);

  it("isn't armed mounted by a notification's jump, though nothing was pressed since the window opened", async () => {
    const a = await run("a", "case=mount&how=notified&tab=dashboard&lsCamera=0,0,0.2&needsMany");
    expect(a.startedOn).toEqual({ landscape: false, tab: "dashboard" });
    expect(a.mounted).toMatchObject({ landscape: true, keyboard: "landscape" });
    expect(a.after).toMatchObject(disarmed);
  }, 120_000);

  it("isn't armed mounted by ⌥⇥ after the Dashboard tab was pressed", async () => {
    const a = await run("a", "case=mount&how=cycle&lsCamera=0,0,0.2&needsMany");
    expect(a.startedOn).toEqual({ landscape: false, keyboard: "topbar:Dashboard" });
    expect(a.mounted).toMatchObject({ landscape: true, keyboard: "landscape" });
    expect(a.after).toMatchObject(disarmed);
  }, 120_000);

  it("isn't armed mounted by ⌘K's Landscape row, which gives the keyboard back to the Dashboard tab's button", async () => {
    const a = await run("a", "case=mount&how=paletteRow&tab=dashboard&needsMany");
    expect(a.startedOn).toEqual({ landscape: false, keyboard: "topbar:Dashboard" });
    expect(a.mounted).toMatchObject({ landscape: true, keyboard: "landscape" });
    expect(a.after).toMatchObject(disarmed);
  }, 120_000);

  it("is armed mounted by its own tab pressed", async () => {
    const a = await run("a", "case=mount&how=tabClick&tab=dashboard&needsMany");
    expect(a.mounted).toMatchObject({ landscape: true, keyboard: "landscape" });
    expect(a.after).toMatchObject({ sheet: true, moved: true });
  }, 120_000);
});

describe.skipIf(!local)("the landscape's buttons and swallowed keys", () => {
  it("arms the landscape at a press on the zoom HUD, so a peek's Space keeps the peek, and Tab still reaches the buttons", async () => {
    const a = await run("a", "case=hud&lsCamera=0,0,0.625");
    expect(a.pressed).toEqual({ keyboard: "landscape", zoomedOut: true });
    expect(a.peek).toEqual({ of: "ws:5101/api", pinned: false });
    expect(a.space).toEqual({ peek: { of: "ws:5101/api", pinned: true }, zoomSame: true, keyboard: "landscape" });
    expect(a.tab).toEqual({ button: true, inLandscape: true });
  }, 120_000);

  it("says once why typed keys do nothing, disarmed and with the keyboard nowhere, and ⌘E with nothing selected arms it", async () => {
    // the camera with both s1's and the API stack's terminals on screen, clear of the side bar
    const a = await run("a", "case=hint&needsMany&lsCamera=500,0,0.75");
    expect(a.start).toEqual({ keyboard: "landscape", selected: null });
    // N, T, Tab and X: said once
    expect(a.disarmed).toEqual({ notes: [HINT], keyboard: "landscape", selected: null });
    expect(a.cmdE).toEqual({ sheet: true });
    // armed since, then the keyboard nowhere: X, Y and Z said once more
    expect(a.nowhere).toEqual({ notes: [HINT, HINT], keyboard: "nowhere" });
    // and once more the next time it goes there, though nothing was armed between (s2 closed as it's typed in, its
    // selection going with it)
    expect(a.inS2).toBe(true);
    expect(a.s2Selected).toBe("s2");
    expect(a.again).toEqual({ notes: [HINT, HINT, HINT], keyboard: "nowhere", selected: null, front: "s3" });
  }, 120_000);
});

describe.skipIf(!local)("a landscape button pressed while a terminal is typed in", () => {
  const none = { others: [], moved: false, sheet: false, dialog: false, menu: false, palette: false };
  for (const btn of ["hud", "chip", "typist", "head"] as const)
    it(`leaves the keyboard in the terminal, which gets the rest of the line (${btn === "head" ? "its own header, off its buttons" : btn})`, async () => {
      const a = await run("a", `case=button&btn=${btn}&lsCamera=0,0,1`);
      expect(a.before).toBe(true);
      expect(a.pressed).toEqual({ keyboard: "terminal", inS1: true });
      // "ok ", the press, then n, Enter and y: all of it s1's, nothing anyone else's; the diff chip opens its window
      expect(a.after).toMatchObject({ ...none, keyboard: "terminal", s1Got: "ok n\ry", focus: false });
      if (btn !== "chip") expect(a.after.changes).toEqual([]);
    }, 120_000);

  it("leaves the keyboard in the terminal in focus, its frame's button pressed, and Esc after it the terminal's", async () => {
    const a = await run("a", "case=frameButton&lsCamera=0,0,1");
    expect(a.inFocus).toEqual({ focus: true, keyboard: "terminal" });
    expect(a.pressed).toEqual({ keyboard: "terminal", inS1: true });
    expect(a.after).toMatchObject({ ...none, keyboard: "terminal", s1Got: "ok \u001bn\ry", focus: true, changes: [] });
  }, 120_000);

  it("selects another workspace pressed on its header, and arms the landscape", async () => {
    const a = await run("a", "case=headOther&lsCamera=0,0,1");
    expect(a.before).toBe(true);
    expect(a.pressed).toEqual({ keyboard: "landscape", selected: true });
    expect(a.armed).toEqual({ sheet: true });
  }, 120_000);
});

describe.skipIf(!local)("a move of the keyboard that waited on main", () => {
  for (const how of ["go", "side"] as const)
    it(`is dropped once the user typed in a terminal meanwhile (${how === "go" ? "Go there" : "a double-click in the side bar"}, main is slow)`, async () => {
      const a = await run("a", `case=lag&how=${how}&lsCamera=0,0,1${how === "go" ? "&needsMany" : ""}`);
      expect(a.before).toBe(true);
      // s3 brought forward late takes neither the keyboard nor focus: every key typed reached s1
      expect(a.afterLag).toEqual({ keyboard: "terminal", inS1: true, focus: false });
      expect(a.after).toEqual({ others: [], s1Got: how === "go" ? "abn\ry" : "please run the testsn\ry", focus: false });
    }, 120_000);

  it("is dropped when a dialog came up on its own meanwhile, nothing typed: the dialog keeps its keys", async () => {
    const a = await run("a", "case=lag&how=dialog&needsMany&joinRequest=later&lsCamera=0,0,1");
    expect(a.promptUp).toEqual({ prompt: true, keyboard: "dialog" });
    // s3 brought forward under the prompt, the keyboard left in it; Enter and y reach no session
    expect(a.afterLag).toEqual({ keyboard: "dialog", front: "s3", focus: false, prompt: true });
    expect(a.after).toEqual({ writes: [], keyboard: "dialog" });
  }, 120_000);

  it("is dropped when a dialog came and went on its own meanwhile: the landscape it hands back to stays disarmed", async () => {
    const a = await run("a", "case=lag&how=dialogGone&needsMany&joinRequest=later&lsCamera=0,0,1");
    expect(a.promptUp).toEqual({ prompt: true, keyboard: "dialog" });
    expect(a.promptGone).toEqual({ prompt: false, keyboard: "landscape" });
    expect(a.afterLag).toEqual({ keyboard: "landscape", front: "s3", focus: false, prompt: false });
    // Go there's arming was dropped with the move: ? opens no sheet
    expect(a.after).toEqual({ sheet: false, writes: [] });
  }, 120_000);

  it("is dropped for a session started from a preset once the user typed in a terminal meanwhile (main is slow)", async () => {
    const a = await run("a", "case=preset&how=typed&lsCamera=500,0,0.75&needsMany");
    expect(a.before).toBe(true);
    // the preset's session (s2) shown, but every key typed reached s1
    expect(a.afterLag).toEqual({ keyboard: "terminal", in: "s1" });
    expect(a.after).toEqual({ others: [], s1Got: "abn\ry" });
  }, 120_000);

  it("still gives a session started from a preset the keyboard when nothing happened meanwhile", async () => {
    const a = await run("a", "case=preset&how=idle&lsCamera=500,0,0.75&needsMany");
    expect(a.afterLag).toEqual({ keyboard: "terminal", in: "s2" });
  }, 120_000);

  it("still moves it when nothing happened meanwhile: Go there's landscape armed once s3 is in front", async () => {
    const a = await run("a", "case=lag&how=idle&needsMany&lsCamera=0,0,1");
    expect(a.afterLag).toEqual({ keyboard: "landscape", front: "s3", focus: false, prompt: false });
    expect(a.after).toEqual({ sheet: true, writes: [] });
  }, 120_000);
});

describe.skipIf(!local)("the join prompt gives the landscape its keyboard", () => {
  const disarmed = { sheet: false, moved: false, writes: [], focus: false };
  it("disarmed when the request goes from under it", async () => {
    const a = await run("a", "case=join&how=withdrawn&joinRequest=later&lsCamera=0,0,1");
    expect(a.prompt).toBe(true);
    expect(a.closed).toEqual({ prompt: false, keyboard: "landscape" });
    // ?, then N, Enter and y: no sheet, nothing moved to, focused or written to
    expect(a.after).toEqual(disarmed);
  }, 120_000);

  it("disarmed when Accept is pressed with Enter", async () => {
    const a = await run("a", "case=join&how=enter&joinRequest=later&lsCamera=0,0,1");
    expect(a.onAccept).toBe(true);
    expect(a.closed).toEqual({ prompt: false, keyboard: "landscape" });
    expect(a.after).toEqual(disarmed);
  }, 120_000);

  it("disarmed when it comes up and goes on its own, though the user had armed the landscape before it", async () => {
    const a = await run("a", "case=selfClose&joinRequest=later&lsCamera=0,0,0.4");
    expect(a.armedAt).toBe("landscape");
    expect(a.up).toEqual({ prompt: true, keyboard: "dialog" });
    expect(a.gone).toEqual({ prompt: false, keyboard: "landscape" });
    expect(a.after).toEqual(disarmed);
  }, 120_000);

  it("armed when the user leaves it with Esc", async () => {
    const a = await run("a", "case=join&how=esc&joinRequest=later&lsCamera=0,0,1");
    expect(a.closed).toEqual({ prompt: false, keyboard: "landscape" });
    expect(a.after).toMatchObject({ sheet: true, moved: true });
  }, 120_000);
});

describe.skipIf(!local)("Tab with nothing typed in gone", () => {
  for (const [label, query] of [
    ["a fresh window on Dashboard", "case=tabWalk&how=fresh&tab=dashboard"],
    ["a fresh window on Settings", "case=tabWalk&how=fresh&tab=settings"],
    ["⌘K's Dashboard row", "case=tabWalk&how=palette"],
    ["the side bar's Reopen pressed with Enter", "case=tabWalk&how=reopen"],
  ] as const)
    it(`walks the window's controls as any browser's, after ${label}`, async () => {
      const a = await run("a", query);
      expect(a.start.keyboard).toBe("body");
      // never held: four Tabs reach at least two controls
      expect(a.walked).not.toContain("nowhere");
      expect(new Set(a.walked.filter((k: string) => k !== "body")).size).toBeGreaterThanOrEqual(2);
    }, 120_000);
});

describe.skipIf(!local)("the holder", () => {
  for (const shift of [false, true])
    it(`leaves the holder for the top bar's ${shift ? "last" : "first"} control at ${shift ? "Shift+Tab" : "Tab"} once keys pause, never where the terminal was`, async () => {
      const a = await run("a", `case=escape&how=${shift ? "shift" : "tab"}&lsCamera=0,0,1`);
      expect(a.before).toBe(true);
      // x, Tab and y straight after s1 went: held
      expect(a.held).toBe("nowhere");
      expect(a.left).toMatchObject({ isStart: true });
      expect(a.left.keyboard).toMatch(/^topbar:/);
    }, 120_000);

  const noneReached = { writes: [], acts: [], focus: false, sheet: false, dialog: false, menu: false, palette: false };
  it("takes the keyboard when focus's frame goes with its session, so Shift+Tab starts at the top bar, never where the frame was", async () => {
    const a = await run("a", "case=frameGone&lsCamera=0,700,0.75");
    expect(a.inFocus).toEqual({ focus: true, keyboard: "frame" });
    expect(a.gone).toEqual({ focus: false, keyboard: "nowhere", warned: [] });
    // keys had paused: Shift+Tab ×5 walk back from the top bar's last control, and y after them reaches nothing
    expect(a.after.reached.length).toBeGreaterThan(0);
    expect(a.after.reached.every((k: string) => k.startsWith("topbar:"))).toBe(true);
    expect(a.after).toMatchObject(noneReached);
  }, 120_000);

  it("takes the keyboard after ⌘K to a session whose terminal isn't there, and says so in the log", async () => {
    const a = await run("a", "case=jumpCards&lsCamera=0,0,0.2");
    expect(a.gone).toEqual({
      focus: false,
      keyboard: "nowhere",
      warned: ["[mockingbird] s4's terminal couldn't take the keyboard as it was gone to: it waits on the holder until a click or ⌘E"],
    });
    // straight after the palette's Enter: Shift+Tab ×5 and y held, nothing reached
    expect(a.after).toEqual({ reached: [], ...noneReached });
  }, 120_000);
});

describe.skipIf(!local)("the empty landscape", () => {
  it("offers what exists, and right-click works everywhere it says", async () => {
    const e = await run("e", "lsOnly=nothing");
    expect(e.state).toMatchObject({ kind: "empty", title: "An empty landscape", hud: false, closed: null });
    expect(e.state.tiles).toEqual(EMPTY_TILES.map((t) => `${t.title} / ${t.sub}`));
    expect(e.state.tiles.join()).not.toMatch(/collab|house/i);
    // three to a row, the last two centred under them
    expect(e.tileRows).toEqual([3, 2]);
    expect(e.tileRowsCentred).toBe(true);
    expect(e.state.foot).toContain("Join a room…");
    expect(e.state.foot).not.toMatch(/team tab/i);
    expect(e.keyboardAtStart).toBe("landscape");
    expect(e.questionMark).toBe(true);
    expect(e.keyboardAfterSheet).toBe("landscape");
    for (const [where, rows] of Object.entries(e.menus as Record<string, string[]>)) expect([where, rows.filter((r) => CREATE.includes(r))]).toEqual([where, CREATE]);
    expect(Object.keys(e.menus)).toHaveLength(7);
    expect(e.keyboardAfterMenus).toBe("landscape");
    expect(e.marqueeFromWords).toBe(true);
    // keys with the landscape given the keyboard by code press no tile: a burst is swallowed, and Tab after a pause
    // leaves the landscape past its tiles
    expect(e.tilesDisarmedAt).toBe("landscape");
    expect(e.tilesDisarmed).toEqual({ opened: false, keyboard: "landscape" });
    expect(e.tabPastTiles).toEqual({ onTile: false, offLandscape: true });
    expect(e.tilesOpen["new:ticket"]).toMatchObject({ launch: "Claude", mode: "New", ticket: true });
    expect(e.tilesOpen["new:claude"]).toMatchObject({ launch: "Claude", mode: "New" });
    expect(e.tilesOpen["new:import"]).toMatchObject({ mode: "Import" });
    // the template picker, saying there are none, as it does from the menu
    expect(e.tilesOpen["new:pipeline"]).toMatchObject({ picker: true });
    expect(e.tilesOpen["new:pipeline"].none).toMatch(/^No templates yet/);
    expect(e.keyboardAfterDialog).toBe("landscape");
    expect(e.joinDialog).toMatch(/join/i);
  }, 120_000);

  it("starts the Helpdesk tasks workspace from its tile, as New workspace → Helpdesk tasks… does, leaving the keyboard on the landscape", async () => {
    const e = await run("e", "lsOnly=nothing&tile=helpdesk");
    // the jump finds the new workspace's terminal not yet there to take the keyboard, so it stays where it was
    expect(e.helpdesk).toEqual({ started: ["builtin:helpdesk"], created: ["Helpdesk"], empty: false, workspace: "tasks", said: [], keyboard: "landscape" });
  }, 120_000);

  for (const twice of ["double", "apart"])
    it(`starts one Helpdesk tasks workspace for a ${twice === "double" ? "double click" : "second click 400 ms later"} while the first is starting, the tile saying so`, async () => {
      const e = await run("e", `lsOnly=nothing&tile=helpdesk&twice=${twice}&createMs=1500`);
      // the second press runs the row, which is off and says why
      expect(e.helpdeskDuring).toMatchObject({ busy: "true", sub: "Opening…" });
      expect(e.helpdeskDuring.note).toMatch(/^Opening the Helpdesk tasks workspace…/);
      expect(e.helpdesk).toMatchObject({ started: ["builtin:helpdesk"], created: ["Helpdesk"], empty: false, workspace: "tasks", said: [] });
    }, 120_000);

  it("refuses the Helpdesk tasks workspace where its area is a team room's, saying why", async () => {
    const e = await run("e", "lsOnly=nothing&tile=helpdesk&lsHelpdeskRoom");
    expect(e.helpdesk).toMatchObject({ started: ["builtin:helpdesk"], created: [], empty: true });
    expect(e.helpdesk.said).toEqual([expect.stringMatching(/^Couldn't start the Helpdesk tasks workspace: .*never runs in a team room's area/)]);
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
    // closed by its own button, it goes back to the terminal as well
    expect(b.dialogPressed).toBe("New session");
    expect(b.afterDialogPressed).toEqual({ keyboard: "terminal", typed: 1 });
    // ⌘K, then a command that opens nothing: typing reaches the terminal again, each way
    expect(b.afterCommand).toEqual({ keyboard: "terminal", typed: 1 });
    expect(b.afterCommandBack).toEqual({ keyboard: "terminal", typed: 1 });
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

describe.skipIf(!local)("a jump to a session", () => {
  it("from a notification while a dialog is open shows the session but leaves the dialog its keyboard", async () => {
    const a = await run("a", "case=jumpOver&how=dialog&joinRequest=later&lsCamera=500,0,0.75&needsMany");
    expect(a.promptUp).toEqual({ prompt: true, keyboard: "dialog" });
    expect(a.jumped).toEqual({ keyboard: "dialog", in: null, selected: "s2", prompt: true });
    expect(a.after).toEqual({ writes: [] });
  }, 120_000);

  it("from a notification with nothing open gives its terminal the keyboard", async () => {
    const a = await run("a", "case=jumpOver&how=none&lsCamera=500,0,0.75&needsMany");
    expect(a.jumped).toEqual({ keyboard: "terminal", in: "s2", selected: "s2", prompt: false });
    expect(a.after).toEqual({ writes: ["s2:y"] });
  }, 120_000);

  it("from ⌘K gives its terminal the keyboard once the palette has gone, as before", async () => {
    const a = await run("a", "case=jumpOver&how=palette&lsCamera=500,0,0.75&needsMany");
    expect(a.jumped).toEqual({ keyboard: "terminal", in: "s2", selected: "s2", prompt: false });
    expect(a.after).toEqual({ writes: ["s2:y"] });
  }, 120_000);
});

describe.skipIf(!local)("the right-click menu", () => {
  it("gives the landscape its keyboard back armed when the user left it with Esc, though it does so a frame later", async () => {
    const a = await run("a", "case=menuEsc&lsCamera=0,0,0.4");
    expect(a.menu).toEqual({ open: true, keyboard: "menu" });
    expect(a.left).toEqual({ menu: false, keyboard: "landscape" });
    expect(a.armed).toEqual({ sheet: true });
  }, 120_000);
});

describe.skipIf(!local)("the preview's driver", () => {
  it("presses Esc as a key only: with the app's Esc cut off, the sheet stays open, the page in front and the window never blurred", async () => {
    const a = await run("a", "case=escMask");
    expect(a.open).toBe(true);
    expect(a.afterEsc).toEqual({ open: true, visibility: "visible", blurs: 0 });
    // and the app's own Esc, once it's let through, closes it
    expect(a.closed).toBe(true);
  }, 120_000);
});

describe.skipIf(!local)("a session started from a dialog while main is slow to start it", () => {
  // The New menu's row, the dialog's row to pick and its button that starts it, and its field to type in meanwhile.
  const flows = [
    ["Import conversations…", ".import-dlg .pick-list .item:not(.blocked)", ".import-dlg button.primary", ".import-dlg .import-search"],
    ["Resume a conversation…", ".modal.ns .pick-list .item:not(.blocked)", ".modal.ns button.primary.cta", ".modal.ns input[type=text]"],
  ] as const;
  for (const [row, pick, go, field] of flows)
    it(`leaves what's typed meanwhile out of it after ${row}: the jump to it moves no keyboard`, async () => {
      const read = `(() => {
        const t = (window.__t ??= { step: 0, typed: 0 });
        const push = (k) => (window.__mbKeys ??= []).push(k);
        const pressOn = (el) => { const r = el.getBoundingClientRect(); push({ mouse: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickCount: 1 } }); };
        if (t.step === 0) {
          const b = document.querySelector(".topbar > button.primary");
          if (!b || !document.querySelector(".ls-world .ls-node")) return null;
          pressOn(b);
          t.step = 1;
          return null;
        }
        if (t.step === 1) {
          const r = [...document.querySelectorAll(".mb-ctx:not(.mb-ghost) button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === ${JSON.stringify(row)});
          if (!r) return null;
          pressOn(r);
          t.step = 2;
          return null;
        }
        if (t.step === 2) {
          const item = document.querySelector(${JSON.stringify(pick)});
          if (!item) return null;
          pressOn(item);
          t.step = 3;
          return null;
        }
        if (t.step === 3) {
          const b = document.querySelector(${JSON.stringify(go)});
          if (!b || b.disabled) return null;
          t.mark = window.__mbCalls.length;
          pressOn(b);
          t.step = 4;
          return null;
        }
        if (t.step === 4) {
          // started (?createMs keeps main busy 1.5 s): the user goes on typing in the dialog, through its closing
          const f = document.querySelector(${JSON.stringify(field)});
          if (f) pressOn(f);
          t.step = 5;
          return null;
        }
        if (t.step === 5) {
          if (t.typed < 12) {
            push({ key: "abcdefghijkl"[t.typed++] });
            return null;
          }
          t.step = 6;
          t.at = Date.now();
          return null;
        }
        if (Date.now() - t.at < 600) return null;
        const since = window.__mbCalls.slice(t.mark);
        return JSON.stringify({ started: since.filter((c) => c.fn === "createSession" || c.fn === "relaunchSession").length, dialog: !!document.querySelector(".modal-back:not(.mb-ghost)"), writes: since.filter((c) => c.fn === "sessionWrite").map((c) => c.args[0]) });
      })()`;
      const r = await look("motion=off&lsCamera=0,0,1&createMs=1500", read);
      expect(r).toEqual({ started: 1, dialog: false, writes: [] });
    }, 120_000);

  it("leaves what's typed meanwhile out of a session started from a Dashboard ticket: the jump to it moves no keyboard", async () => {
    const read = `(() => {
      const t = (window.__t ??= { step: 0, typed: 0 });
      const push = (k) => (window.__mbKeys ??= []).push(k);
      const pressOn = (el) => { const r = el.getBoundingClientRect(); push({ mouse: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickCount: 1 } }); };
      const start = () => [...document.querySelectorAll(".bdetail button.primary")].find((b) => b.textContent.trim() === "Start session");
      if (t.step === 0) {
        const card = document.querySelector(".board .bcard");
        if (!card) return null;
        pressOn(card);
        t.step = 1;
        return null;
      }
      if (t.step === 1) {
        // the ticket's repo, from the New session picker
        const pick = [...document.querySelectorAll(".bdetail .mb-select")].find((b) => b.textContent.includes("repo…"));
        if (!pick) return null;
        pick.click();
        t.step = 1.5;
        return null;
      }
      if (t.step === 1.5) {
        const repo = document.querySelectorAll(".mb-listbox [role=option]")[1];
        if (!repo) return null;
        repo.click();
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        const b = start();
        if (!b || b.disabled) return null;
        t.mark = window.__mbCalls.length;
        pressOn(b);
        t.step = 3;
        return null;
      }
      if (t.step === 3) {
        // started (?createMs keeps main busy 1.5 s): the user goes on typing
        if (t.typed < 12) {
          push({ key: "abcdefghijkl"[t.typed++] });
          return null;
        }
        t.step = 4;
        t.at = Date.now();
        return null;
      }
      if (Date.now() - t.at < 600) return null;
      const since = window.__mbCalls.slice(t.mark);
      return JSON.stringify({ started: since.filter((c) => c.fn === "createSession").length, tab: document.querySelector(".topbar .tab.on")?.dataset.tab ?? null, writes: since.filter((c) => c.fn === "sessionWrite").map((c) => c.args[0]) });
    })()`;
    expect(await look("tab=dashboard&motion=off&lsCamera=0,0,1&createMs=1500", read)).toEqual({ started: 1, tab: "sessions", writes: [] });
  }, 120_000);
});

describe.skipIf(!local)("Tab on the landscape disarmed", () => {
  it("leaves it once keys have paused, for the stop after it or, with Shift (pressed first, on its own), the one before; a burst's stays swallowed", async () => {
    const read = `(() => {
      const t = (window.__t ??= { step: 0 });
      const vp = document.querySelector(".ls-viewport");
      const push = (...k) => (window.__mbKeys ??= []).push(...k);
      const where = () => {
        const a = document.activeElement;
        if (!a || a === document.body) return "body";
        if (a === vp) return "landscape";
        if (vp.contains(a)) return "in the landscape";
        return vp.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before";
      };
      // the keyboard on the landscape by code: disarmed
      const disarmed = () => {
        vp.blur();
        vp.focus();
        t.at = Date.now();
      };
      if (t.step === 0) {
        if (!vp || !document.querySelector(".ls-world .ls-node")) return null;
        disarmed();
        t.start = where();
        t.step = 1;
        return null;
      }
      if (t.step === 1) {
        if (Date.now() - t.at < 1300) return null;
        push({ key: "Tab" });
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        t.tab = where();
        disarmed();
        t.step = 3;
        return null;
      }
      if (t.step === 3) {
        if (Date.now() - t.at < 1300) return null;
        // as a keyboard sends it: Shift down on its own a moment before Tab
        push({ key: "Shift", shift: true, hold: "down" }, { pause: 90 }, { key: "Tab", shift: true }, { key: "Shift", hold: "up" });
        t.step = 4;
        return null;
      }
      if (t.step === 4) {
        t.shiftTab = where();
        disarmed();
        t.step = 5;
        return null;
      }
      if (t.step === 5) {
        if (Date.now() - t.at < 1300) return null;
        push({ key: "a" }, { key: "Tab" }, { key: "Tab", shift: true });
        t.step = 6;
        t.at = Date.now();
        return null;
      }
      if (Date.now() - t.at < 500) return null;
      return JSON.stringify({ start: t.start, tab: t.tab, shiftTab: t.shiftTab, burst: where(), writes: window.__mbCalls.filter((c) => c.fn === "sessionWrite").length });
    })()`;
    expect(await look("motion=off&lsCamera=0,0,1", read)).toEqual({ start: "landscape", tab: "after", shiftTab: "before", burst: "landscape", writes: 0 });
  }, 120_000);
});
