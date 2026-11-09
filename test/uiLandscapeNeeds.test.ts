import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { LOOSE_GROUP } from "../src/shared/landscape";
import { tempDir } from "./helpers";

// Needs you and the cards' badges (S7) in the UI preview, in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?landscapeNeedsAudit (src/preview/needsYouAudit.ts) works the tray, N,
// Dismiss and Go there as a person would, keys pressed for real through Chrome (=a, =g), reads the badges as drawn at
// a zoom (=b), the tray's place (=c) and the top bar (=d).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Act = { key: string | null; label: string | null; disabled: boolean; title: string; filled: boolean };
type Item = { id: string | null; kind: string | null; on: boolean; meta: string | null; text: string | null; acts: Act[] };
type Tray = { open: boolean; head: string | null; items: Item[]; foot: string | null; undo: boolean; none: string | null; error: string | null };
type Button = { on: boolean; count: string | null; title: string | null };
type Step = { shift: boolean; ws: string | null; area: string | null; keyboard: string; moved: boolean; prompt: boolean };
interface TrayAudit {
  keys: string;
  button: Button;
  tree: Record<string, string | null>;
  tray: Tray;
  trayKeyboard: string;
  steps: Step[];
  litAfterSteps: string[];
  inTray: { ws: string | null; open: boolean; lit: string[]; keyboard: string; under: boolean; clear: boolean };
  escape: { open: boolean; keyboard: string };
  inField: { before: { ws: string | null; area: string | null }; ws: string | null; area: string | null; typed: string };
  inTerminal: { textarea: boolean; ws: string | null; keyboard: string; wrote: string[] };
  dismissed: { before: string[]; tray: Tray; button: Button; tree: Record<string, string | null>; keyboard: string };
  afterDismissN: { keyboard: string; moved: boolean; open: boolean };
  undone: { ids: string[]; foot: string | null };
  back: { ids: string[]; button: Button; foot: string | null };
  samePrompt: { ids: string[] };
  takenOver: { ids: string[]; button: Button };
  pill: { count: string | null; title: string | null };
  switcher: Record<string, string | null>;
  switcherTitle: string | null;
  treeTitle: string | null;
  error?: string;
}
interface GoAudit {
  keys: string;
  goTitle: string | null;
  goPermission: { open: boolean; ws: string | null; keyboard: string; terminal: boolean };
  goPermissionEnter: { terminal: boolean; focus: boolean };
  nStack: { before: string | null; front: string | null; ws: string | null; keyboard: string; farBefore: boolean; onScreen: boolean; note: string | null };
  nStackBack: { front: string | null; ws: string | null; keyboard: string };
  stackBefore: string | null;
  stackFar: boolean;
  goStack: { front: string | null; ws: string | null; keyboard: string; onScreen: boolean; note: string | null };
  goStackEnter: { terminal: boolean; focus: boolean };
  cardsBand: string | null;
  goCards: { ws: string | null; keyboard: string };
  goCardsEnter: { terminal: boolean; focus: boolean };
  goJoin: { open: boolean; area: string | null; ws: string | null; prompt: string | null };
  pickThenArea: { pickedBefore: number; picked: number; area: string | null };
  goFromTab: { tab: string | null; ws: string | null; keyboard: string };
  error?: string;
}
type Badge = { key: string | null; text: string | null; title: string; failed: boolean; shown: boolean; whole: boolean; cut: boolean; inCard: boolean; inArea: boolean };
type Ws = {
  id: string;
  mode: string;
  rowClips: boolean | null;
  rowInCard: boolean;
  rowInFoot: boolean;
  badges: Badge[];
  rows: { head: boolean; foot: { shown: boolean; whole: boolean }; did: { shown: boolean; whole: boolean } | null; tabs: { shown: boolean; whole: boolean } | null; wordsCut: boolean; acts: { label: string | null; whole: boolean }[] } | null;
  line: string | null;
  did: { text: string | null; title: string; failed: boolean; inCard: boolean; inArea: boolean } | null;
  diffCell: { text: string | null; title: string; failed: boolean; inNode: boolean; inArea: boolean } | null;
};
interface BadgeAudit {
  band: string | null;
  workspaces: Ws[];
  said: string[];
  stale: { before: { text: string | null; title: string } | null; after: { text: string | null; title: string } | null; said: string[]; again: { text: string | null; title: string } | null; asked: number };
  metersBack?: { failing: string[]; after: string[]; cost: string | null };
  error?: string;
}
type Counts = { ids: string[]; button: Button; tree: Record<string, string | null>; switcher: Record<string, string | null>; pill: string | null };
interface ClosedAudit {
  ghosts: string[];
  closedList: string | null;
  closedTabs: string[];
  before: Counts;
  reopened: Counts & { live: boolean; ghost: boolean; node: boolean };
  turnEnded: Counts;
  error?: string;
}
type Place = { items: number; underButton: boolean; coversButton: boolean; inWindow: boolean; scrolls: boolean; lastBorder: string | null };
interface PlaceAudit {
  few: Place;
  grown: Place;
  reopened: Place;
  filled: [string, boolean | null][];
  error?: string;
}
interface BarAudit {
  width: number;
  buttons: ({ text: string; oneLine: boolean; cut: boolean } | null)[];
  barOverflows: boolean;
  contrast?: number;
  error?: string;
}

/** The preview's audit part, run with `query` (motion off) at `size`. */
async function run<T>(part: string, query: string, size = "1440x900"): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size,
    query: `labs=landscape&motion=off&landscapeNeedsAudit=${part}&${query}`,
    outDir: path.join(tempDir(`needs-${part}`), "out"),
    read: `document.getElementById("mb-landscape-needs-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish part ${part}`);
  return JSON.parse(json);
}

/** The badges a workspace shows, in order. */
const shownKeys = (w: Ws) => w.badges.filter((b) => b.shown).map((b) => b.key);

/** Every badge and row drawn stays whole inside its workspace and its area; one that didn't fit isn't drawn at all. */
function expectContained(workspaces: Ws[]) {
  for (const w of workspaces) {
    for (const b of w.badges) {
      if (b.shown) expect({ id: w.id, badge: b.key, whole: b.whole, inCard: b.inCard, inArea: b.inArea, cut: b.cut }).toEqual({ id: w.id, badge: b.key, whole: true, inCard: true, inArea: true, cut: false });
      else expect({ id: w.id, badge: b.key, clipped: w.rowClips }).toEqual({ id: w.id, badge: b.key, clipped: true });
    }
    if (w.badges.length) expect({ id: w.id, rowInCard: w.rowInCard, rowInFoot: w.rowInFoot }).toEqual({ id: w.id, rowInCard: true, rowInFoot: true });
    if (w.rows) {
      expect({ id: w.id, head: w.rows.head, footWhole: w.rows.foot.whole }).toEqual({ id: w.id, head: true, footWhole: true });
      if (w.rows.did) expect({ id: w.id, didWhole: w.rows.did.whole }).toEqual({ id: w.id, didWhole: true });
      if (w.rows.tabs) expect({ id: w.id, tabsWhole: w.rows.tabs.whole }).toEqual({ id: w.id, tabsWhole: true });
      // the badges give way first: none shows while a word beside it is cut
      if (w.badges.some((b) => b.shown)) expect({ id: w.id, wordsCut: w.rows.wordsCut }).toEqual({ id: w.id, wordsCut: false });
      for (const a of w.rows.acts) expect({ id: w.id, act: a.label, whole: a.whole }).toEqual({ id: w.id, act: a.label, whole: true });
    }
    if (w.did) expect({ id: w.id, did: [w.did.inCard, w.did.inArea] }).toEqual({ id: w.id, did: [true, true] });
    if (w.diffCell) expect({ id: w.id, diffCell: [w.diffCell.inNode, w.diffCell.inArea] }).toEqual({ id: w.id, diffCell: [true, true] });
  }
}

// each part drives a page for half a minute or more, its keys pressed one by one
describe.skipIf(!local)("Needs you (S7)", { timeout: 150_000 }, () => {
  it("lists what waits on you, moves the view with N pressed for real, dismisses until a state changes, and undoes", async () => {
    const a = await run<TrayAudit>("a", "joinRequest=later&lsCamera=0,0,0.5");
    expect(a.error).toBeUndefined();
    expect(a.keys).toBe("real");

    // the button and the tray: s2's permission prompt, Lee's join request, then s8 finished; teammates' never
    expect(a.button).toMatchObject({ on: true, count: "3" });
    expect(a.button.title).toMatch(/^3 need you: /);
    expect(a.tray.open).toBe(true);
    expect(a.tray.head).toBe("Needs youN next · ⇧N back");
    expect(a.tray.items.map((i) => [i.kind, i.meta, i.text])).toEqual([
      ["permission", "Permission · #5101", "API: last org per user wants to use Bash"],
      ["join", "Join request · #5101", "Lee Park wants to join #5101 Org dropdowns remember the last org"],
      ["finished", "Finished · #5101", "Release notes for #5101 is done and idle"],
    ]);
    for (const i of a.tray.items) expect(i.acts.map((x) => [x.key, x.label, x.disabled])).toEqual([["go", "Go there", false], ["dismiss", "Dismiss", false]]);
    // only where something waits on your answer is the main action filled
    expect(a.tray.items.map((i) => i.acts[0].filled)).toEqual([true, true, false]);
    expect(a.trayKeyboard).toBe("tray");
    // each area's count is its items: the tree, a collapsed area's pill and the switcher agree, and say "need you"
    expect(a.tree).toMatchObject({ "5101": "3", "5102": null, "5110": null });
    expect(a.treeTitle).toBe("3 need you: see Needs you");
    expect(a.pill).toEqual({ count: "3", title: "3 need you: see Needs you" });
    expect(a.switcher).toMatchObject({ "5101": "3", "5102": null });
    expect(a.switcherTitle).toBe("3 need you: see Needs you");

    // N from the landscape: each item in turn, round the end, ⇧N back; the keyboard stays with the landscape, and a
    // join request's area is selected without its prompt
    expect(a.steps.map((s) => [s.shift ? "⇧N" : "N", s.ws ?? `area ${s.area}`])).toEqual([
      ["N", "s2"],
      ["N", "area 5101"],
      ["N", "s8"],
      ["N", "s2"],
      ["⇧N", "s8"],
    ]);
    for (const s of a.steps) expect(s).toMatchObject({ keyboard: "landscape", prompt: false });
    expect(a.steps.some((s) => s.moved)).toBe(true);
    expect(a.litAfterSteps).toEqual(["s:s8"]);
    // N in the tray, as soon as it opens: moves on with the tray kept open and its place lit, the item brought out
    // from under the tray
    expect(a.inTray).toEqual({ ws: "s2", open: true, lit: ["s:s2"], keyboard: "tray", under: true, clear: true });
    // Esc puts the tray away and gives the keyboard back to its button
    expect(a.escape).toEqual({ open: false, keyboard: "button" });
    // never in a text field or a terminal: there the key is the field's or the program's
    expect(a.inField).toEqual({ before: a.inField.before, ws: a.inField.before.ws, area: a.inField.before.area, typed: "n" });
    expect(a.inTerminal).toEqual({ textarea: true, ws: "s1", keyboard: "terminal", wrote: ["n"] });

    // Dismiss: off the list and the counts, said in the tray's foot with Undo; the keyboard stays in the tray, and the
    // second click of a double click, landing on the item that slid up, is let go
    expect(a.dismissed.before).toEqual(["s:s2", a.dismissed.before[1], "s:s8"]);
    expect(a.dismissed.tray.items.map((i) => i.id)).toEqual(a.dismissed.before.slice(0, 2));
    expect(a.dismissed.tray.foot).toBe("1 item dismissedUndo");
    expect(a.dismissed.tray.undo).toBe(true);
    expect(a.dismissed.button.count).toBe("2");
    expect(a.dismissed.tree["5101"]).toBe("2");
    expect(a.dismissed.keyboard).toBe("tray");
    expect(a.afterDismissN).toEqual({ keyboard: "tray", moved: true, open: true });
    expect(a.undone).toEqual({ ids: a.dismissed.before, foot: null });
    // dismissed again, it's back when its state changes
    expect(a.back.ids).toContain("s:s8");
    expect(a.back.button.count).toBe("3");
    expect(a.back.foot).toBeNull();
    // a second prompt worded like a dismissed one is a new item
    expect(a.samePrompt.ids).toContain("s:s2");
    // a copy a teammate took over leaves it
    expect(a.takenOver.ids).not.toContain("s:s8");
    expect(a.takenOver.button.count).toBe(String(a.takenOver.ids.length));
  });

  it("goes there with the keyboard kept off the agent's prompt: on a prompt, a stack's tab behind another, at the cards' zoom, a join request and from another tab", async () => {
    const g = await run<GoAudit>("g", "joinRequest=later&lsCamera=0,0,0.5");
    expect(g.error).toBeUndefined();
    expect(g.keys).toBe("real");
    expect(g.goTitle).toMatch(/the keyboard kept off its prompt .*Enter or a click on its terminal to answer it/);
    // selected and on the landscape's keyboard, never the terminal's; Enter then gives its terminal the keyboard
    expect(g.goPermission).toEqual({ open: false, ws: "s2", keyboard: "landscape", terminal: false });
    expect(g.goPermissionEnter).toEqual({ terminal: true, focus: true });
    // a stack's tab behind another comes to the front, by N or Go there, and into view from off screen, so the terminal
    // Enter gives the keyboard to is its; nothing said, as nothing failed
    expect(g.nStack).toEqual({ before: "s2", front: "s3", ws: "s3", keyboard: "landscape", farBefore: false, onScreen: true, note: null });
    expect(g.nStackBack).toEqual({ front: "s2", ws: "s2", keyboard: "landscape" });
    expect(g.stackBefore).toBe("s2");
    expect(g.stackFar).toBe(false);
    expect(g.goStack).toEqual({ front: "s3", ws: "s3", keyboard: "landscape", onScreen: true, note: null });
    expect(g.goStackEnter).toEqual({ terminal: true, focus: true });
    // at the cards' zoom, the same: Enter fills the window with it, its terminal live
    expect(g.cardsBand).toBe("cards");
    expect(g.goCards).toEqual({ ws: "s2", keyboard: "landscape" });
    expect(g.goCardsEnter).toEqual({ terminal: true, focus: true });
    // a join request: its room's area, and the admin's prompt for it
    expect(g.goJoin).toEqual({ open: false, area: "5101", ws: null, prompt: "Lee Park wants to join #5101 Org dropdowns remember the last org" });
    // an area selected lets go of the several picked before: one selection at a time
    expect(g.pickThenArea).toEqual({ pickedBefore: 2, picked: 0, area: "5101" });
    expect(g.goFromTab).toEqual({ tab: "Sessions", ws: "s8", keyboard: "landscape" });
  });

  it("draws the cards' badges inside their cards and areas at 15%, with what each source says, read once per folder", async () => {
    const b = await run<BadgeAudit>("b", "lsCamera=-200,-300,0.15");
    expect(b.error).toBeUndefined();
    expect(b.band).toBe("cards");
    const s1 = b.workspaces.find((w) => w.id === "s1")!;
    expect(s1.mode).toBe("card");
    expect(s1.badges.map((x) => [x.key, x.text])).toEqual([["diff", "+214 −38"], ["pr", "PR #88"], ["cost", "22M · 14%"]]);
    // in the foot after the agent's name and status, whole badges give way from the end, before the words do: beside
    // "Working" none fits at 15%, beside "Idle" the diff does
    expect(shownKeys(s1)).toEqual(["diff", "pr", "cost"].slice(0, shownKeys(s1).length));
    expect(s1.did).toMatchObject({ text: "I'll store the choice per user and preselect it.", failed: false });
    const s5 = b.workspaces.find((w) => w.id === "s5")!;
    expect(s5.badges.map((x) => [x.key, x.text])).toEqual([["diff", "+12 −4"], ["cost", "9.6M · 3.1%"]]);
    // a terminal has no transcript and no cost, a teammate's session no folder or meter here
    const s4 = b.workspaces.find((w) => w.id === "s4")!;
    expect([s4.did, s4.badges.filter((x) => x.key === "cost")]).toEqual([null, []]);
    expect(b.workspaces.find((w) => w.id.startsWith("r~"))!.badges).toEqual([]);
    // an idle agent's last output is its last message: said once, as what it did
    const s8 = b.workspaces.find((w) => w.id === "s8")!;
    expect(shownKeys(s8)[0]).toBe("diff");
    expect(s8.did?.text).toBe("Org pickers now open on the org you used last.");
    expect(s8.line).toBeNull();
    expect(s1.line).not.toBeNull();
    expectContained(b.workspaces);
    // the source failing: "diff —" with the reason, said in the console; read again, the value
    expect(b.stale.before?.text).toBe("+214 −38");
    expect(b.stale.after).toEqual({ text: "diff —", title: "Couldn't read its changes against its base: git merge-base: fatal: Not a valid object name origin/dev" });
    expect(b.stale.said).toEqual([expect.stringMatching(/^\[mockingbird\] a landscape card couldn't read its changes against its base for s1(, s\d)*: git merge-base: fatal: Not a valid object name origin\/dev$/)]);
    expect(b.stale.again?.text).toBe("+214 −38");
    // one read per folder for each change, however many cards are on it: the start, the failure, the value again
    expect(b.stale.asked).toBeLessThanOrEqual(3 * 3);
  });

  it("keeps every row whole at 1024×768's fit (11%), at 10% and at the wide fit, a stack's card's too: no badge or line cut, the actions fully shown", async () => {
    for (const [query, size] of [["lsFit", "1024x768"], ["lsCamera=-400,-500,0.1", "1440x900"], ["lsFit", "1440x900"]] as const) {
      const b = await run<BadgeAudit>("b", query, size);
      expect(b.error).toBeUndefined();
      expect(b.band).toBe("cards");
      expectContained(b.workspaces);
      // the exited cards still show both their actions
      const dead = b.workspaces.filter((w) => w.rows?.acts.length);
      expect(dead.map((w) => [w.id, w.rows!.acts.map((x) => x.label)])).toEqual(expect.arrayContaining([["s6", ["Resume", "Close & clean up"]]]));
      // the stack's card keeps its other tabs' names over what it did
      expect(b.workspaces.find((w) => w.id === "s2")!.rows!.tabs).toEqual({ shown: true, whole: true });
      // and exited, its actions over those, every row still whole
      const front = await run<BadgeAudit>("b", `deadFront&${query}`, size);
      expect(front.error).toBeUndefined();
      expectContained(front.workspaces);
      expect(front.workspaces.find((w) => w.id === "s2")!.rows!.acts).toEqual([{ label: "Resume", whole: true }, { label: "Close & clean up", whole: true }]);
    }
  });

  it("leaves closed sessions out of the tray and the counts, whatever their records say, and a reopened one until a turn ends in it", async () => {
    const e = await run<ClosedAudit>("e", "closedAsLeft&lsClosed=s3&joinRequest=later&lsCamera=0,0,0.5");
    expect(e.error).toBeUndefined();
    // all there: ghosts (loose, and in 5101 and 5102), the Closed sessions list (o1, o2) and the stack's closed tab
    expect(e.ghosts).toEqual(["g1", "g2", "p1"]);
    expect(e.closedList).toBe("(2)");
    expect(e.closedTabs).toEqual(["s3"]);
    // the same three items and counts as with none of them; g2 on an unanswered prompt, the others with a turn's end on record
    expect(e.before.ids).toEqual(["s:s2", expect.stringMatching(/^join:/), "s:s8"]);
    expect(e.before.button.count).toBe("3");
    expect(e.before.tree).toMatchObject({ "5101": "3", "5102": null, "5110": null, [LOOSE_GROUP]: null });
    expect(e.before.switcher).toMatchObject({ "5101": "3", "5102": null, "5110": null, [LOOSE_GROUP]: null });
    expect(e.before.pill).toBeNull();
    // reopened, it runs where its ghost was, and it isn't "finished": no turn has ended in it
    expect(e.reopened).toMatchObject({ live: true, ghost: false, node: true });
    expect(e.reopened.ids).toEqual(e.before.ids);
    expect(e.reopened.button.count).toBe("3");
    expect(e.reopened.tree).toMatchObject({ "5101": "3", "5102": null });
    expect(e.reopened.pill).toBeNull();
    // a turn ends in it: listed, and counted in its area
    expect(e.turnEnded.ids).toEqual(["s:s2", expect.stringMatching(/^join:/), "s:g1", "s:s8"]);
    expect(e.turnEnded.button.count).toBe("4");
    expect(e.turnEnded.tree).toMatchObject({ "5101": "3", "5102": "1" });
    expect(e.turnEnded.switcher).toMatchObject({ "5101": "3", "5102": "1" });
    expect(e.turnEnded.pill).toBe("1");
  });

  it("draws them inside at the fit's zoom and as the workspace footer's diff at 50% and 100%", async () => {
    const fit = await run<BadgeAudit>("b", "lsCamera=-40,-60,0.18");
    expect(fit.error).toBeUndefined();
    const s1 = fit.workspaces.find((w) => w.id === "s1")!;
    // wider than at 15%: the diff beside "Working" too
    expect(shownKeys(s1)).toEqual(["diff", "pr", "cost"].slice(0, Math.max(1, shownKeys(s1).length)));
    expectContained(fit.workspaces);
    for (const [zoom, band] of [["0.5", "readonly"], ["1", "live"]] as const) {
      const b = await run<BadgeAudit>("b", `lsCamera=-40,300,${zoom}`);
      expect(b.error).toBeUndefined();
      expect(b.band).toBe(band);
      const live = b.workspaces.find((w) => w.id === "s1")!;
      expect(live.mode).toBe("live");
      expect(live.diffCell).toMatchObject({ text: "+214 −38", failed: false });
      expectContained(b.workspaces);
      expect(b.stale.after?.text).toBe("—");
      expect(b.stale.again?.text).toBe("+214 −38");
    }
  });

  it("says which badge's source fails, why on hover and in the console, and never a value read before", async () => {
    const b = await run<BadgeAudit>("b", "badgeFail=diff,pr,reply,meters&lsCamera=-40,-60,0.18");
    expect(b.error).toBeUndefined();
    const s1 = b.workspaces.find((w) => w.id === "s1")!;
    expect(s1.badges.map((x) => [x.key, x.text, x.failed])).toEqual([["diff", "diff —", true], ["pr", "PR —", true], ["cost", "cost —", true]]);
    expect(s1.badges.map((x) => x.title)).toEqual([
      "Couldn't read its changes against its base: git merge-base: fatal: Not a valid object name origin/dev",
      "Couldn't read the ticket pipelines: ~/.mockingbird/pipeline.json: EACCES: permission denied",
      "Couldn't read the token meters: transcripts:sync: SQLITE_BUSY: database is locked",
    ]);
    expect(s1.did).toMatchObject({ text: "—", failed: true, title: "Couldn't read what it last said: the conversation index isn't available (SQLITE_CANTOPEN: unable to open database file)" });
    expectContained(b.workspaces);
    expect(b.said).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/a landscape card couldn't read its changes against its base for s1\b.*: git merge-base/),
        expect.stringContaining("a landscape card couldn't read what it last said for s1: the conversation index isn't available"),
        expect.stringContaining("Couldn't read the ticket pipelines: ~/.mockingbird/pipeline.json: EACCES"),
        expect.stringContaining("couldn't read the token meters"),
      ])
    );
    // each said once, not once for each card or each read
    expect(b.said.filter((m) => m.includes("Couldn't read the ticket pipelines"))).toHaveLength(1);
    // the meters' note has its own slot on the status bar, and goes once they're read, the badge with its value
    expect(b.metersBack).toEqual({ failing: ["Couldn't read the token meters: transcripts:sync: SQLITE_BUSY: database is locked"], after: [], cost: "22M · 14%" });
  });

  it("keeps the tray under its button at 1024×768 however long it grows, scrolling its items, opened again or not", async () => {
    const c = await run<PlaceAudit>("c", "joinRequest=later&lsCamera=0,0,0.3", "1024x768");
    expect(c.error).toBeUndefined();
    expect(c.few).toMatchObject({ items: 3, underButton: true, coversButton: false, inWindow: true, scrolls: false, lastBorder: "0px" });
    expect(c.grown).toMatchObject({ items: 7, underButton: true, coversButton: false, inWindow: true, scrolls: true, lastBorder: "0px" });
    expect(c.reopened).toMatchObject({ items: 7, underButton: true, coversButton: false, inWindow: true, scrolls: true });
    expect(c.filled.find(([kind]) => kind === "finished")?.[1]).toBe(false);
  });

  it("keeps the top bar's buttons on one line at 860 px, and the amber button readable in the light theme", async () => {
    const d = await run<BarAudit>("d", "joinRequest=later", "860x600");
    expect(d.error).toBeUndefined();
    expect(d.width).toBe(860);
    expect(d.buttons).toEqual([expect.objectContaining({ oneLine: true, cut: false }), expect.objectContaining({ oneLine: true, cut: false })]);
    expect(d.barOverflows).toBe(false);
    const light = await run<BarAudit>("d", "joinRequest=later&theme=light", "1440x900");
    expect(light.contrast).toBeGreaterThanOrEqual(4.5);
    const dark = await run<BarAudit>("d", "joinRequest=later", "1440x900");
    expect(dark.contrast).toBeGreaterThanOrEqual(4.5);
  });
});
