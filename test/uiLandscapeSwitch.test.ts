import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// What the grid offered that the landscape has to (docs/landscape-phase1.md, S8's audit), worked in the UI preview in
// real headless Chrome: local only (CI runners have no desktop); the script passes a mock keychain. ?landscapeSwitchAudit
// (src/preview/switchAudit.ts) reports what each did; nothing real runs.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function run(part: string, extra = ""): Promise<any> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1400x900",
    query: `motion=off&landscapeSwitchAudit=${part}${extra}`,
    outDir: path.join(tempDir(`switch-${part}`), "out"),
    read: `document.getElementById("mb-landscape-switch-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish part ${part}`);
  const a = JSON.parse(json);
  expect(a.error).toBeUndefined();
  return a;
}

describe.skipIf(!local)("a stack's and a workspace's tabs, on the landscape", () => {
  it("offers New tab, Rename and Unstack on a stack, in its ⋯ and its tree row, and each does what its row says", async () => {
    const a = await run("stack", "&lsCamera=0,0,0.5");
    const rows = ["# Stack", "New tab in “api”…", "Rename “api”…", "Unstack its tabs"];
    expect(a.stackMenu.join("|")).toContain(rows.join("|"));
    expect(a.treeMenu.join("|")).toContain(rows.join("|"));

    // a new tab is one of the stack's, where the stack is
    expect(a.newTab).toEqual({ dialog: "New session", where: expect.stringContaining("api → opens as a tab") });
    expect(a.newTabMade).toMatchObject({ group: "5101/api", tabbed: true, ownPlace: false });
    expect(a.newTabMade.placement).toEqual(a.newTabMade.was);

    // renamed: under its new key, in the same place, from its ⋯ and from a double-click on its name
    expect(a.rename).toEqual({ dialog: "Rename stack", initial: "api" });
    expect(a.renamed).toMatchObject({ calls: [["5101/api", "5101/api2"]], keyed: true, oldGone: true, tile: true });
    expect(a.renamed.placement).toEqual(a.newTabMade.was);
    expect(a.renameByName).toEqual({ dialog: "Rename stack", initial: "api2", focused: false });

    // with a teammate's tab in it: that stays, the stack where it was, and this Mac's each go where there's room
    expect(a.unstackTheirs.moved.map((m: string[]) => m[1])).toEqual(["5101", "5101", "5101"]);
    expect(a.unstackTheirs.stackStays).toEqual(a.unstackTheirs.was);
    expect(a.unstackTheirs.tabs).toHaveLength(1);
    expect(a.unstackTheirs.placed).toEqual([true, true, true]);
    expect(a.unstackTheirs.clear).toBe(true);

    // with none: the front tab takes the stack's place and moves last; the other is placed in the area, clear of it
    expect(a.unstackMine.order.at(-1)).toEqual([a.unstackMine.front, "5101"]);
    for (const m of a.unstackMine.order) expect(m[1]).toBe("5101");
    expect(a.unstackMine.stackGone).toBe(true);
    expect(a.unstackMine.frontAt).toEqual(a.unstackMine.was);
    expect(a.unstackMine).toMatchObject({ otherInArea: true, clear: true, fronts: [true, true] });

    // a workspace of its own: New tab starts a stack, only once the session exists
    expect(a.loneMenu).toContain("New tab…");
    expect(a.loneDialog).toEqual({ dialog: "New session", where: expect.stringContaining("new workspace") });
    expect(a.loneCancelled).toEqual({ setGroup: 0, same: true });
    expect(a.loneMade).toMatchObject({ count: 1, front: true, s1PlaceLetGo: true });
    expect(a.loneMade.key).toMatch(/^5101\/tabs/);
    expect(a.loneMade.s1Group).toBe(a.loneMade.key);
    expect(a.loneMade.placement).toEqual(a.loneMade.was);
    expect(a.loneMade.tabs).toHaveLength(2);
  }, 120_000);

  it("in a locked area has them off, saying why, but a new tab in a stack, which moves nothing", async () => {
    const a = await run("locked", "&lsLocked=5101");
    expect(a.stack).toEqual({ off: true, why: expect.stringMatching(/locked: unlock it to take tabs out/), newTab: true });
    expect(a.lone).toEqual({ off: true, why: expect.stringMatching(/locked: unlock it to stack/) });
  }, 90_000);
});

describe.skipIf(!local)("⌘K on the landscape", () => {
  it("offers Focus, its room rows for the selected area, and nothing of the grid's: no pin, no columns, no pane numbers", async () => {
    // whatever side bar view the grid last left, the tree shows, and ⌘K's row says it hides it
    const a = await run("palette", "&staleSideView=scm");
    expect(a.none).toEqual({ room: [], grid: [], numbered: [] });
    expect(a.treeRow).toBe("Hide the area tree");
    expect(a.room).toEqual({ room: [expect.stringMatching(/^Invite a teammate to #5101/), expect.stringMatching(/^House board — #5101/)], grid: [], numbered: [], focus: "⌘E" });
    expect(a.focused).toEqual({ front: "s1" });
    expect(a.plain).toEqual([expect.stringMatching(/^Share #5102 .* as a team room$/)]);
    expect(a.share).toMatch(/5102/);
    expect(a.legacyKeysUnchanged).toBe(true);
  }, 90_000);
});

describe.skipIf(!local)("what the grid's Sessions view and group bar said", () => {
  it("is said on the landscape: Ask for status, a note off it, room problems, a room nobody's online in, the Team view's stack", async () => {
    const a = await run("notes", "&lsCamera=0,0,0.5");
    // the status bar counts areas, whatever the tree's filter leaves showing
    expect(a.areas).toEqual({ said: String(a.areas.file), file: 3 });
    expect(a.areasFiltered).toBe("3");
    expect(a.asked).toMatch(/^Asked \d+ sessions?/);
    expect(a.offLandscape).toMatch(/^Reopened \d+ of \d+/);
    expect(a.problems).toEqual(["Couldn't publish “Org dropdowns” to the room: the record is too large"]);
    // a room with someone online shows them; one with nobody still says it's shared; an area that's no room says neither
    expect(a.rooms).toEqual(expect.arrayContaining([{ area: "5101", online: 1, shared: null }, { area: "5102", online: 0, shared: null }]));
    expect(a.roomsEmpty).toEqual(expect.arrayContaining([{ area: "5101", online: 0, shared: "shared" }, { area: "5102", online: 0, shared: null }]));
    expect(a.teamStack).toEqual({ row: "5101/api", selected: "ws:5101/api", keysUnchanged: true });
  }, 90_000);
});

describe.skipIf(!local)("what goes on from a workspace", () => {
  it("Continue in lands beside it, closed behind it as its ghost, and is brought into view; a dialog cancelled lets that go", async () => {
    const a = await run("handoff", "&lsCamera=0,0,0.5");
    // beside s5, not the first free spot, which is two rows up
    expect(a.handoff.at).toMatchObject({ x: a.handoff.of.x + a.handoff.of.w + 16, y: a.handoff.of.y });
    expect(a.handoff).toMatchObject({ made: true, selected: true, dialog: false, killed: [["s5", false]] });
    // cancelled: the next new one goes to the first free spot
    expect(a.afterCancel.at.y).toBeLessThan(a.afterCancel.first.y);
  }, 90_000);

  it("a second opinion lands beside what it reviews", async () => {
    const a = await run("review", "&lsCamera=0,0,0.5");
    expect(a.review.at).toMatchObject({ x: a.review.of.x + a.review.of.w + 16, y: a.review.of.y });
    expect(a.review).toMatchObject({ made: true, drawn: true });
  }, 90_000);

  it("Import brings the first it opened into view and writes nothing of the grid's", async () => {
    const a = await run("import");
    expect(a.imported).toEqual({ opened: true, placed: true, selected: true, dialog: false, keysUnchanged: true });
  }, 90_000);
});

describe.skipIf(!local)("a stack's tabs, right-clicked", () => {
  it("act on the tab clicked: a back tab's Rename… and Close… are its own session's, never the front one's", async () => {
    const a = await run("tabs", "&lsCamera=0,0,0.5");
    expect(a.front).toBe("s2");
    expect(a.renameBack).toBe("API tests");
    expect(a.renameFront).toBe("API: last org per user");
    // a closed session's work is asked about or it's closed: either way it's s3, and s2 is untouched
    expect(a.close.dialog === null ? a.close.named.length > 0 : /API tests/.test(a.close.dialog)).toBe(true);
    expect(a.close.named.filter((n: string) => n.endsWith(":s2"))).toEqual([]);
    expect(a.frontAfter).toBe("s2");
    // picked with s1, the stack's front tab opens the picked ones' menu, as its header does, and keeps the pick
    expect(a.pickedBefore).toBe(2);
    expect(a.pickedFrontRows[0]).toBe("# 2 selected");
    expect(a.pickedAfter).toBe(2);
  }, 90_000);
});

describe.skipIf(!local)("a Search window, on the landscape", () => {
  it("keeps the options it last set for the next one", async () => {
    // at 100%, where a window shows its body rather than its compact card
    const a = await run("search", "&lsCamera=0,0,1");
    expect(a.first).toEqual({ open: true, files: "false", matchCase: null });
    expect(a.saved).toMatchObject({ scope: "files", matchCase: true });
    expect(a.closed).toBe(true);
    expect(a.next).toEqual({ open: true, files: "true", matchCase: "true" });
  }, 90_000);
});
