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
type StackRow = { count: string | null; title: string; label: string | null } | null;
interface TrayAudit {
  keys: string;
  button: Button;
  tree: Record<string, string | null>;
  stackRow: StackRow;
  stackRowDismissed: StackRow;
  nOnButton: { moved: boolean; keyboard: string; open: boolean };
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
  goJoinAfter: { prompt: boolean; keyboard: string };
  pickThenArea: { pickedBefore: number; picked: number; area: string | null };
  goFromFocus: { inFocus: boolean; focus: boolean; ws: string | null; keyboard: string };
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
  rows: {
    head: boolean;
    foot: { shown: boolean; whole: boolean };
    did: { shown: boolean; whole: boolean } | null;
    line: { shown: boolean; whole: boolean } | null;
    owner: { shown: boolean; whole: boolean } | null;
    tabs: { shown: boolean; whole: boolean } | null;
    wordsCut: boolean;
    acts: { label: string | null; whole: boolean }[];
  } | null;
  line: string | null;
  did: { text: string | null; title: string; failed: boolean; inCard: boolean; inArea: boolean } | null;
  diffCell: { text: string | null; title: string; failed: boolean; inNode: boolean; inArea: boolean } | null;
};
interface BadgeAudit {
  band: string | null;
  workspaces: Ws[];
  said: string[];
  stale: { before: { text: string | null; title: string } | null; after: { text: string | null; title: string } | null; said: string[]; again: { text: string | null; title: string } | null; asked: number };
  metersBack?: { failing: string[]; todayFailing: boolean; after: string[]; cost: string | null; today: boolean; pushed: { note: string[]; cost: string | null; today: boolean } };
  error?: string;
}
type Counts = { ids: string[]; button: Button; tree: Record<string, string | null>; switcher: Record<string, string | null>; pill: string | null };
interface ClosedAudit {
  ghosts: string[];
  closedList: string | null;
  closedTabs: string[];
  before: Counts;
  reopened: Counts & { live: boolean; ghost: boolean; node: boolean };
  oneTitle: string | null;
  turnEnded: Counts;
  error?: string;
}
type Place = { items: number; underButton: boolean; coversButton: boolean; inWindow: boolean; scrolls: boolean; lastBorder: string | null };
interface PlaceAudit {
  few: Place;
  grown: Place;
  reopened: Place;
  filled: [string, boolean | null][];
  litKept: { last: boolean; scrollTop: number; inView: boolean };
  fitSteps?: { ws: string; covered: boolean; inView: boolean }[];
  error?: string;
}
type Bar = { needs: number | null; bottom: number | null; neighbour: number | null };
interface AroundAudit {
  keys: string;
  barWithCount: Bar;
  barNoCount: Bar;
  all: string[];
  last: string;
  keyboardDismiss: { gone: string; ids: string[]; keyboard: string };
  doubleClick: { before: number | null; presses: { inTray: boolean; height: number | null }[]; open: boolean; ids: string[]; selection: boolean; camera: boolean; keyboard: string };
  afterGuard: { height: number | null; held: string | null };
  empty: { none: string | null; error: string | null; title: string | null; foot: string | null };
  undone: { ids: string[]; keyboard: string };
  undoneN: { moved: boolean; keyboard: string; open: boolean };
  dialog: { tray: boolean; dialog: boolean };
  dialogClosed: { dialog: boolean; keyboard: string };
  palette: { tray: boolean; palette: boolean };
  paletteClosed: { palette: boolean; keyboard: string };
  quickOpen: { tray: boolean; open: boolean };
  quickOpenClosed: { open: boolean; keyboard: string };
  error?: string;
}
type StackShown = { card: string | null; front: string | null; stackRow: string | null; button: string | null };
interface StackAudit {
  tabs: string | null;
  before: StackShown;
  waiting: StackShown;
  dismissed: StackShown;
  secondPrompt: StackShown;
  finished: StackShown;
  teammate: string;
  teammateWaiting: StackShown & { status: string };
  error?: string;
}
type Made = { fn: string; args: unknown[] }[];
type Safety = { links: { text: string | null; href: string | null }[]; images: number; agentButtons: number; ran: boolean };
type PrFormSeen = {
  asked: string | null;
  from: string | null;
  title: string | null;
  titleBy: string | null;
  description: string | null;
  descriptionBy: string | null;
  gate: string | null;
  checks: { label: string | null; checked: boolean }[];
  notes: { item: string | null; text: string | null; elements: string[] }[];
  push: { disabled: boolean } | null;
  warnings: (string | null)[];
};
interface PrRequestAudit {
  keys: string;
  tray: Tray;
  button: Button;
  doubleDismiss: { gone: string; ids: string[]; under: { item: string | null; action: string | null } | null; dialog: boolean; calls: Made };
  opened: { tray: boolean; dialog: string | null; keyboard: string; form: PrFormSeen | null; safety: Safety; calls: Made };
  edited: { title: string | null; titleBy: string | null; keyboard: string; calls: Made };
  closed: { dialog: boolean; keyboard: string; calls: Made };
  dismissAsked: { tray: boolean; head: string | null; keyboard: string; field: string | null; calls: Made };
  cancelled: { dialog: boolean; ids: string[]; keyboard: string; calls: Made };
  dismissed: { dialog: boolean; keyboard: string; note: string | null; calls: Made };
  dismissedTray: string[];
  beforePush: { form: PrFormSeen | null; calls: Made };
  pushed: { form: boolean; shown: { title: string | null; description: string | null }; calls: Made };
  afterPush: string[];
  stakeholder: { dialog: string | null; keyboard: string; steps: string[]; calls: Made };
  approved: { said: string | null; stage: string | null; calls: Made };
  approvedClosed: { keyboard: string };
  error?: string;
}
type NotesPanel = { head: string | null; by: string | null; text: string | null; buttons: string[]; listed: string[]; steps: string[] };
interface PatchNotesAudit {
  keys: string;
  tray: Tray;
  opened: { dialog: string | null; keyboard: string; panel: NotesPanel; safety: Safety; calls: Made };
  edited: { panel: NotesPanel; calls: Made };
  posted: { calls: Made; panel: boolean };
  closed: { keyboard: string };
  error?: string;
}
interface ArrivalAudit {
  keys: string;
  runs: { item: string; action: string; how?: "double" | "quick" | "soon" | "late"; on?: string | null; dialog?: boolean; under?: string | null; cue?: (string | null)[]; calls?: Made; missing?: boolean }[];
  aimed: { button: string | null; calls: Made };
  error?: string;
}
interface OtherBranchAudit {
  keys: string;
  shown: { say: string | null; ticked: boolean | null; push: boolean | null };
  ticked: { ticked: boolean | null; push: boolean | null };
  pushed: { calls: Made };
  error?: string;
}
interface FormWarningsAudit {
  keys: string;
  opened: { from: string | null; options: string[]; notes: (string | null)[]; push: boolean; calls: Made };
  picked: { form: PrFormSeen | null; hooks: string | null; branchSay: string | null; lengths: [string, string][]; rows: number | null; long: string | null; calls: Made };
  short: { rows: number | null; long: boolean; lengths: [string, string][] };
  error?: string;
}
type NotesSeen = { text: string | null; newer: string | null; post: boolean | null; discard: boolean | null; by: string | null; calls: Made };
interface NewerNotesAudit {
  keys: string;
  rewritten: NotesSeen;
  shown: NotesSeen;
  kept: NotesSeen;
  error?: string;
}
type WireAct = { key: string | null; label: string | null; filled: boolean; tab: number };
type WireTrayItem = { id: string | null; kind: string | null; meta: string | null; text: string | null; acts: WireAct[] };
type Called = { fn: string; args: unknown[] }[];
type FinishSeen = { title: string | null; mark: string | null; body: string | null; verdicts: string[]; lines: string[][]; finish: { disabled: boolean; title: string } | null; hint: boolean; err: string | null } | null;
interface WireNeedsAudit {
  keys: string;
  tray: WireTrayItem[];
  finishedItem: WireTrayItem | null;
  finishOpened: { tray: boolean; keyboard: string; pop: FinishSeen; calls: Called };
  finishEarly: { pop: FinishSeen; calls: Called };
  finished: { open: boolean; keyboard: string; note: string | null; calls: Called; loop: string | null; held: unknown };
  costEsc: { typedIn: string; asked: boolean; popGone: boolean; dialog: boolean; keyboard: string; calls: Called };
  keySend: { tab: number | null; calls: Called };
  changedUnder: { off: boolean; text: string | null; calls: Called };
  raced: { calls: Called; pop: boolean; ends: string | null; note: string | null };
  sentLoop: { calls: Called; item: boolean; delivery: string | null };
  movedUnder: { off: boolean; calls: Called };
  sentGhost: { calls: Called; item: boolean };
  shown: { tray: boolean; face: string | null; ends: string | null; keyboard: string; calls: Called };
  shownClosed: { open: boolean; keyboard: string; calls: Called };
  checked: { calls: Called; note: string | null };
  markAsked: { tray: boolean; question: string | null; keyboard: string; hint: boolean; calls: Called };
  markReread: { question: string | null; open: boolean; err: string | null; calls: Called };
  marked: { open: boolean; keyboard: string; note: string | null; calls: Called };
  header: { focus: boolean; button: { label: string | null; disabled: boolean } | null };
  headerPop: { open: boolean; under: boolean; keyboard: string; calls: Called };
  headerClosed: { open: boolean; keyboard: string };
  menu: string[];
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
    query: `motion=off&landscapeNeedsAudit=${part}&${query}`,
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
      // the terminal's line shows whole lines or none, and goes first: then what it did, then the foot
      if (w.rows.line) expect({ id: w.id, lineWhole: w.rows.line.whole }).toEqual({ id: w.id, lineWhole: true });
      if (w.rows.line?.shown && w.rows.did) expect({ id: w.id, did: w.rows.did.shown }).toEqual({ id: w.id, did: true });
      if (w.rows.line?.shown || w.rows.did?.shown) expect({ id: w.id, foot: w.rows.foot.shown }).toEqual({ id: w.id, foot: true });
      // the badges and a teammate's name give way first: none shows while the status beside it is cut
      if (w.badges.some((b) => b.shown) || w.rows.owner?.shown) expect({ id: w.id, wordsCut: w.rows.wordsCut }).toEqual({ id: w.id, wordsCut: false });
      if (w.rows.owner) expect({ id: w.id, ownerWhole: w.rows.owner.whole }).toEqual({ id: w.id, ownerWhole: true });
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
    // a stack's row counts its items, labelled as the area's is, and not one you've dismissed
    expect(a.stackRow).toEqual({ count: "1", title: "1 needs you: see Needs you", label: "1 needs you" });
    expect(a.stackRowDismissed).toBeNull();
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
    // where N goes on to the next, as the button's title says
    expect(a.nOnButton).toEqual({ moved: true, keyboard: "button", open: false });
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
    // answered, the keyboard is the landscape's, what had it before having gone with the tray
    expect(g.goJoinAfter).toEqual({ prompt: false, keyboard: "landscape" });
    // an area selected lets go of the several picked before: one selection at a time
    expect(g.pickThenArea).toEqual({ pickedBefore: 2, picked: 0, area: "5101" });
    // from focus on another workspace: focus ends, and the keyboard isn't left on the overlay that went with it
    expect(g.goFromFocus).toEqual({ inFocus: true, focus: false, ws: "s8", keyboard: "landscape" });
    expect(g.goFromTab).toEqual({ tab: "Landscape", ws: "s8", keyboard: "landscape" });
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

  it("lets a card's rows go in order, whole, from 10% to 13%: never the terminal's line without what it did, nor a teammate's name beside a cut status", async () => {
    for (const zoom of ["0.105", "0.11", "0.13"]) {
      const b = await run<BadgeAudit>("b", `lsCamera=-400,-500,${zoom}`);
      expect(b.error).toBeUndefined();
      expect(b.band).toBe("cards");
      expectContained(b.workspaces);
      // at 13% "Working" fits on its own: a teammate's name has given way whole, rather than each taking part of the line
      if (zoom === "0.13") expect(b.workspaces.find((w) => w.id.startsWith("r~"))!.rows).toMatchObject({ owner: { shown: false, whole: true }, wordsCut: false });
    }
    // with the room, the name shows beside the whole status
    const wide = await run<BadgeAudit>("b", "lsCamera=-400,-500,0.22");
    expect(wide.workspaces.find((w) => w.id.startsWith("r~"))!.rows).toMatchObject({ owner: { shown: true, whole: true }, wordsCut: false });
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
    expect(e.oneTitle).toBe("1 needs you: see Needs you");
  });

  it("draws them inside at the fit's zoom and as the workspace footer's diff at 50% and 100%", async () => {
    const fit = await run<BadgeAudit>("b", "lsCamera=-40,-60,0.18");
    expect(fit.error).toBeUndefined();
    const s1 = fit.workspaces.find((w) => w.id === "s1")!;
    // wider than at 15%: the diff beside "Working" too
    expect(shownKeys(s1)).toEqual(["diff", "pr", "cost"].slice(0, Math.max(1, shownKeys(s1).length)));
    // with the room, what it did and the terminal's line both show
    expect([s1.rows!.did?.shown, s1.rows!.line?.shown]).toEqual([true, true]);
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
    const meters = "Couldn't read the token meters: the conversation index isn't available (transcripts:sync: SQLITE_BUSY: database is locked)";
    expect(s1.badges.map((x) => x.title)).toEqual([
      "Couldn't read its changes against its base: git merge-base: fatal: Not a valid object name origin/dev",
      "Couldn't read the ticket pipelines: ~/.mockingbird/pipeline.json: EACCES: permission denied",
      meters,
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
    // the meters' note has its own slot on the status bar, and goes once they're read, the badge with its value. A
    // failure pushed after that (a sync failing) brings the note back, and what's shown from the meters goes with it
    expect(b.metersBack).toEqual({ failing: [meters], todayFailing: false, after: [], cost: "22M · 14%", today: true, pushed: { note: [meters], cost: "cost —", today: false } });
  });

  it("keeps the tray under its button at 1024×768 however long it grows, scrolling its items, opened again or not", async () => {
    const c = await run<PlaceAudit>("c", "joinRequest=later&lsCamera=0,0,0.3", "1024x768");
    expect(c.error).toBeUndefined();
    expect(c.few).toMatchObject({ items: 3, underButton: true, coversButton: false, inWindow: true, scrolls: false, lastBorder: "0px" });
    expect(c.grown).toMatchObject({ items: 7, underButton: true, coversButton: false, inWindow: true, scrolls: true, lastBorder: "0px" });
    expect(c.reopened).toMatchObject({ items: 7, underButton: true, coversButton: false, inWindow: true, scrolls: true });
    expect(c.filled.find(([kind]) => kind === "finished")?.[1]).toBe(false);
  });

  it("keeps the item N lights in the list's view on a short window, the list following it", async () => {
    const c = await run<PlaceAudit>("c", "joinRequest=later&lsCamera=0,0,0.3", "1024x600");
    expect(c.error).toBeUndefined();
    expect(c.litKept.last).toBe(true);
    expect(c.litKept.scrollTop).toBeGreaterThan(0);
    expect(c.litKept.inView).toBe(true);
  });

  it("brings the card N goes to clear of the tray at 1024×768's fit, in the room left of it", async () => {
    const c = await run<PlaceAudit>("c", "joinRequest=later&lsFit", "1024x768");
    expect(c.error).toBeUndefined();
    expect(c.fitSteps!.length).toBeGreaterThanOrEqual(5);
    for (const s of c.fitSteps!) expect(s).toMatchObject({ covered: false, inView: true });
  });

  it("keeps the mouse and keyboard in the tray round a Dismiss: a double click on the last item, Undo, and the button's height", async () => {
    const f = await run<AroundAudit>("f", "joinRequest=later&lsCamera=0,0,0.5");
    expect(f.error).toBeUndefined();
    expect(f.keys).toBe("real");
    // the item with the Dismiss furthest down: Lee's request, its text on two lines
    expect(f.last).toMatch(/^join:/);
    // the keyboard stays in the tray when Dismiss's button leaves
    expect(f.keyboardDismiss).toEqual({ gone: f.keyboardDismiss.gone, ids: f.all.filter((id) => id !== f.keyboardDismiss.gone), keyboard: "tray" });
    // both presses of a double click land in the tray, which holds its height for the second; the landscape never hears it
    const h = f.doubleClick.before;
    expect(f.doubleClick.presses).toEqual([{ inTray: true, height: h }, { inTray: true, height: h }]);
    expect(f.doubleClick).toMatchObject({ open: true, ids: [], selection: true, camera: true, keyboard: "tray" });
    // and lets it go after
    expect(f.afterGuard.held).toBe("");
    expect(f.afterGuard.height!).toBeLessThan(h!);
    expect(f.empty).toEqual({ none: "Nothing needs you right now.", error: null, title: "Nothing needs you right now", foot: "3 items dismissedUndo" });
    // Undo's button leaves too: the keyboard stays in the tray, where N still works
    expect(f.undone).toEqual({ ids: [f.last], keyboard: "tray" });
    expect(f.undoneN).toEqual({ moved: true, keyboard: "tray", open: true });
    // the button is one height beside its neighbour, with its count or without, so the tray under it never moves
    expect(f.barWithCount.needs).toBe(24);
    expect(f.barWithCount.needs).toBe(f.barWithCount.neighbour);
    expect(f.barNoCount).toEqual(f.barWithCount);
    // a dialog or the palette opening puts the tray away, and Esc leaves the keyboard on its button
    expect(f.dialog).toEqual({ tray: false, dialog: true });
    expect(f.dialogClosed).toEqual({ dialog: false, keyboard: "button" });
    expect(f.palette).toEqual({ tray: false, palette: true });
    expect(f.paletteClosed).toEqual({ palette: false, keyboard: "button" });
    expect(f.quickOpen).toEqual({ tray: false, open: true });
    expect(f.quickOpenClosed).toEqual({ open: false, keyboard: "button" });
  });

  it("counts a stack card's other tabs as the tray and the tree do: not one you dismissed, nor a teammate's", async () => {
    const s = await run<StackAudit>("s", "lsCamera=-200,-300,0.15");
    expect(s.error).toBeUndefined();
    // the fixture's stack: s2 in front on its prompt (an item, the card's own status), s3 and Sam's tab behind
    expect(s.before).toEqual({ card: null, front: "s2", stackRow: "1", button: "2" });
    // s3 on a prompt: one more everywhere, the card counting it
    expect(s.waiting).toEqual({ card: "1 needs you", front: "s2", stackRow: "2", button: "3" });
    // dismissed: gone everywhere, and the card can't be left saying it
    expect(s.dismissed).toEqual({ card: null, front: "s2", stackRow: "1", button: "2" });
    expect(s.secondPrompt).toEqual({ card: "1 needs you", front: "s2", stackRow: "2", button: "3" });
    // finished is an item too, as the tray and the tree count it
    expect(s.finished).toEqual({ card: "1 needs you", front: "s2", stackRow: "2", button: "3" });
    // a teammate's tab on a prompt waits on them: counted nowhere here, though the tab is in the stack and waiting
    expect(s.tabs).toContain("Last-org API tests");
    expect(s.teammate).toMatch(/^r~/);
    expect(s.teammateWaiting).toEqual({ card: null, front: "s2", stackRow: "1", button: "2", status: "waiting" });
  });

  it("with the rooms unreadable, says that rather than that nothing needs you", async () => {
    const f = await run<AroundAudit>("f", "teamFail&lsCamera=0,0,0.5");
    expect(f.error).toBeUndefined();
    const why = "Couldn't read the rooms' join requests: ~/.mockingbird/team.json: EACCES: permission denied";
    expect(f.all).toEqual(["s:s2", "s:s8"]);
    expect(f.empty).toEqual({ none: null, error: why, title: why, foot: "2 items dismissedUndo" });
  });

  // W15: what ?prRequest=hostile's agents wrote holds this, as their words would if they tried
  const MARKUP = ' <a href="https://example.invalid/x">Approve here</a> <button data-agent>Push now</button> [docs](javascript:alert(1)) <img src=x onerror="window.__mbAgentRan=1">';
  const NO_HARM: Safety = { links: [{ text: "PR 88", href: null }, { text: "Check now", href: null }], images: 0, agentButtons: 0, ran: false };

  it("opens an agent's PR request as the PR form filled from it, marked as the agent's, and makes nothing until Push and open PR", async () => {
    const p = await run<PrRequestAudit>("p", "prRequest=hostile&lsCamera=0,0,0.5");
    expect(p.error).toBeUndefined();
    expect(p.keys).toBe("real");
    // the request with the prompts, the ticket at your stage after them: in Mockingbird's words, none of the agent's
    expect(p.tray.items.map((i) => [i.id, i.kind, i.meta, i.text])).toEqual([
      ["s:s2", "permission", "Permission · #5101", "API: last org per user wants to use Bash"],
      ["pr:5101:dev", "pr", "Pull request · #5101", "Coder asks to open the PR to dev · #5101"],
      ["ticket:5102", "ticket", "Ticket · #5102", "#5102 is ready for your stakeholder testing"],
      ["s:s8", "finished", "Finished · #5101", "Release notes for #5101 is done and idle"],
    ]);
    expect(p.tray.items[1].acts.map((a) => [a.key, a.label, a.filled])).toEqual([["open", "Open", true], ["dismissRequest", "Dismiss…", false]]);
    expect(p.tray.items[2].acts.map((a) => [a.key, a.label, a.filled])).toEqual([["open", "Open", true], ["dismiss", "Dismiss", false]]);
    expect(p.button.count).toBe("4");
    // a double click's second click, landing on the request's row as it slides up, is let go
    expect(p.doubleDismiss).toEqual({ gone: "s:s2", ids: ["pr:5101:dev", "ticket:5102", "s:s8"], under: { item: "pr:5101:dev", action: expect.stringMatching(/^(open|dismissRequest)$/) }, dialog: false, calls: [] });

    // Open: the PR form in the pipeline dialog, the keyboard in it, on the session that asked (main's record, not the
    // request's own `session`), its words the agent's and marked so
    expect(p.opened).toMatchObject({ tray: false, dialog: "#5101 Org dropdowns remember the last org", keyboard: "dialog" });
    const form = p.opened.form!;
    expect(form.from).toBe("s3");
    expect(form.asked).toMatch(/^Asked for by Coder's agent, .+\. Nothing is pushed or opened until you press Push and open PR\.$/);
    expect([form.title, form.titleBy, form.descriptionBy]).toEqual(["#5101 Org dropdowns remember the last org", "written by Coder's agent", "written by Coder's agent"]);
    expect(form.description).toMatch(/^## Summary\n/);
    expect(form.description).toContain(MARKUP);
    // its checklist is dev's, the agent's notes beside each item as text, its tick said as its
    expect(form.gate).toBe("dev");
    expect(form.notes.map((n) => [n.item, n.text])).toEqual([
      // a forged "Ticked by you" line in the note stays on its line, after whose words they are
      ["dev:tests", "Coder's agent: npm test: 212 pass, 0 fail Ticked by you · verified"],
      ["dev:smoke", `Coder's agent ticked it: Clicked through the org picker as three users; each opened on their last org${MARKUP}`],
      ["dev:security-doc", "Coder's agent: Not written yet: doc/features has no 5101 folder"],
    ]);
    for (const n of form.notes) expect(n.elements).toEqual(["span.pl-by"]);
    expect(form.push).toEqual({ disabled: false });
    // the agent's markup is no link, control or image in the window, and none of it ran
    expect(p.opened.safety).toEqual(NO_HARM);
    // opening read the branch, and made nothing
    expect(p.opened.calls).toEqual([{ fn: "pipelinePrPreflight", args: ["s3", "5101", "dev"] }]);
    // the user's edit: no longer the agent's words as written; still nothing made, and Esc gives the keyboard back to
    // the Needs you button, never a terminal
    expect(p.edited).toEqual({ title: "#5101 Org dropdowns remember the last orgx", titleBy: "changed since Coder's agent wrote it", keyboard: "dialog", calls: [] });
    expect(p.closed).toEqual({ dialog: false, keyboard: "button", calls: [] });

    // Dismiss…: a note asked for, Cancel dropping nothing; then main's one call, with the note, the item gone
    expect(p.dismissAsked).toEqual({ tray: false, head: "Dismiss the request for a pull request to dev/UAT", keyboard: "dialog", field: "TEXTAREA", calls: [] });
    expect(p.cancelled).toEqual({ dialog: false, ids: ["pr:5101:dev", "ticket:5102", "s:s8"], keyboard: "button", calls: [] });
    expect(p.dismissed).toEqual({ dialog: false, keyboard: "button", note: "Request dismissed. UI preview: no agent is told", calls: [{ fn: "pipelineRequestDismiss", args: ["5101", "req-dev-1", "Rebase on dev first"] }] });
    expect(p.dismissedTray).toEqual(["ticket:5102", "s:s8"]);

    // Push and open PR: the one call that pushes and opens, main's, with the asker's session, the form's target, the base
    // main's preflight read and the words shown; none of the request's other fields (its branch, base, repo, session)
    expect(p.beforePush.calls).toEqual([{ fn: "pipelinePrPreflight", args: ["s3", "5101", "dev"] }]);
    expect(p.pushed.calls).toEqual([
      { fn: "pipelinePrCreate", args: ["s3", "5101", { target: "dev", base: "dev", title: p.pushed.shown.title, description: p.pushed.shown.description, ticketTitle: "Org dropdowns remember the last org" }] },
    ]);
    expect(p.pushed.shown.description).toContain(MARKUP);
    expect(p.pushed.form).toBe(false);
    expect(p.afterPush).toEqual(["ticket:5102", "s:s8"]);

    // the ticket at your stakeholder testing: Open shows its pipeline and makes nothing; Approve is pipeline:approve
    expect(p.stakeholder).toEqual({ dialog: "#5102 Pathways quick view freezes", keyboard: "dialog", steps: ["Record feedback…", "Approve"], calls: [] });
    expect(p.approved).toEqual({ said: "Approved. UI preview: no agent is told", stage: "Approved", calls: [{ fn: "pipelineApprove", args: ["5102"] }] });
    expect(p.approvedClosed).toEqual({ keyboard: "button" });
  });

  it("opens the Patch notes panel on the agent's draft, marked as the Verifier's, and posts only from Post to ADO", async () => {
    const t = await run<PatchNotesAudit>("t", "prRequest=notes,hostile&lsCamera=0,0,0.5");
    expect(t.error).toBeUndefined();
    expect(t.tray.items.find((i) => i.id === "ticket:5102")).toMatchObject({ kind: "ticket", meta: "Ticket · #5102", text: "#5102's patch notes are drafted" });
    expect(t.opened).toMatchObject({ dialog: "#5102 Pathways quick view freezes", keyboard: "dialog", calls: [] });
    expect(t.opened.panel).toMatchObject({ by: "drafted by Verifier's agent", buttons: ["Copy", "Discard", "Post to ADO"], listed: [], steps: ["Done"] });
    expect(t.opened.panel.text).toMatch(/^Pathways' quick view no longer freezes/);
    expect(t.opened.panel.text).toContain(MARKUP);
    expect(t.opened.safety).toEqual({ ...NO_HARM, links: [] });
    // the user's edit makes it theirs (main drops who drafted it), and the panel stays on it
    expect(t.edited.panel).toMatchObject({ by: null, buttons: ["Copy", "Discard", "Post to ADO"], listed: [] });
    expect(t.edited.calls.map((c) => [c.fn, c.args[0], c.args[1]])).toEqual([["pipelineDraftEdit", "5102", "d-notes"]]);
    expect(t.posted.calls).toEqual([{ fn: "pipelineDraftPost", args: ["5102", "d-notes"] }]);
    expect(t.closed).toEqual({ keyboard: "button" });
  });

  // W15 review: each size puts one of the dialog's buttons that make something under the tray's button that opened it
  const LANDINGS = [
    { query: "prRequest", size: "1440x660", item: "ticket:5102", action: "open", on: "Approve" },
    { query: "prRequest", size: "1440x800", item: "ticket:5102", action: "open", on: "Done" },
    { query: "prRequest", size: "1440x420", item: "pr:5101:dev", action: "dismissRequest", on: "Dismiss the request" },
    { query: "prRequest=notes", size: "1440x520", item: "ticket:5102", action: "open", on: "Post to ADO" },
    { query: "prRequest=notes", size: "1440x880", item: "ticket:5102", action: "open", on: "Done" },
  ] as const;

  it(
    "takes no click a dialog opened from the tray wasn't aimed at: a double click's second, a quick second click or a late double click's, landing on Approve, Done, Post to ADO or Dismiss the request",
    async () => {
      for (const l of LANDINGS) {
        const h = await run<ArrivalAudit>("h", `${l.query}&lsCamera=0,0,0.5`, l.size);
        expect(h.error, l.size).toBeUndefined();
        expect(h.keys).toBe("real");
        expect(h.runs.filter((r) => r.missing), l.size).toEqual([]);
        // the clicks land where the dialog draws the button that makes something, and it's still there after them
        const landed = h.runs.filter((r) => r.item === l.item && r.action === l.action);
        expect(landed.map((r) => [r.how, r.on, r.under]), l.size).toEqual(["double", "quick", "soon", "late"].map((how) => [how, l.on, l.on]));
        // a separate click let go shows on its button, as the strip's do (off until a click there would count); a double
        // click's second, whose first counted, shows nothing. Two clicks back to back can land the second before the
        // dialog is drawn, on what was there: then nothing in the dialog was clicked at all.
        const cueOf = (how: string) => landed.find((r) => r.how === how)?.cue;
        expect([cueOf("soon"), cueOf("late")], l.size).toEqual([["true"], [null]]);
        expect([["true"], ["outside"]], `${l.size} quick`).toContainEqual(cueOf("quick"));
        expect([[null], ["outside"]], `${l.size} double`).toContainEqual(cueOf("double"));
        // and nothing is made by any of them, at any of the tray's actions
        for (const r of h.runs) expect({ size: l.size, item: r.item, action: r.action, how: r.how, dialog: r.dialog, calls: r.calls }).toEqual({ size: l.size, item: r.item, action: r.action, how: r.how, dialog: true, calls: [] });
        // a click aimed at the ticket's button, past the guard, makes its call
        expect(h.aimed, l.size).toEqual(
          l.query === "prRequest" ? { button: "Approve", calls: [{ fn: "pipelineApprove", args: ["5102"] }] } : { button: "Post to ADO", calls: [{ fn: "pipelineDraftPost", args: ["5102", "d-notes"] }] }
        );
      }
    },
    LANDINGS.length * 90_000
  );

  it("picks no session when the one that asked has moved to another ticket, and blocks a base branch's push, saying what the push won't run and what ADO cuts", async () => {
    const q = await run<FormWarningsAudit>("q", "prRequest=moved,basebranch,hooks,long&lsCamera=0,0,0.5");
    expect(q.error).toBeUndefined();
    // the Coder is on #5098 now: said so, no session picked for the user, no branch read until one is
    expect(q.opened).toEqual({
      from: "",
      options: ["", "s1", "s2", "s4", "s8"],
      notes: ["Coder is on #5098 now: pick the session the pull request comes from.", "Pick the session the pull request comes from."],
      push: false,
      calls: [],
    });
    expect(q.picked.calls).toEqual([{ fn: "pipelinePrPreflight", args: ["s1", "5101", "dev"] }]);
    const form = q.picked.form!;
    expect(form.from).toBe("s1");
    // a worktree on dev would push straight to origin's dev: Push is off, and the form says why
    expect(form.push).toEqual({ disabled: true });
    expect(form.warnings).toContain("The worktree is on dev, a base branch's name: pushing it would update origin's dev directly. Move the work to a branch of its own first.");
    // what a room session's push runs, and what it doesn't
    expect(q.picked.hooks).toBe(
      "Your global pre-push in ~/.githooks runs; the one in .git/hooks doesn't, for a room session's push: this repository's hooks can run files its agent writes (a hook manager's config, its scripts). Its Git LFS files are uploaded first, with git lfs push."
    );
    // dev isn't the branch the session was made on either: the say-so asked
    expect(q.picked.branchSay).toBe("The worktree is on dev, not 5101-orgDropdowns, the branch this session was made on: pushing it updates origin's dev. Push dev anyway");
    // the lengths, the box grown to the description, and ADO's limit said
    expect(q.picked.lengths).toEqual([
      ["title", "41 characters"],
      ["description", "332 lines · 4662 characters"],
    ]);
    expect(q.picked.rows).toBe(24);
    expect(q.picked.long).toBe('Azure DevOps keeps 4,000 characters of a description: this one is cut short, at about 3,980, and ends "(shortened)".');
    expect(q.short).toEqual({ rows: 6, long: false, lengths: [["title", "41 characters"], ["description", "2 lines · 17 characters"]] });
  });

  it("asks before pushing a branch the session wasn't made on, and carries the say-so for that branch to main", async () => {
    const o = await run<OtherBranchAudit>("o", "prRequest=otherbranch&lsCamera=0,0,0.5");
    expect(o.error).toBeUndefined();
    expect(o.shown).toEqual({
      say: "The worktree is on release/2.1, not 5101-orgDropdowns, the branch this session was made on: pushing it updates origin's release/2.1. Push release/2.1 anyway",
      ticked: false,
      push: true,
    });
    expect(o.ticked).toEqual({ ticked: true, push: false });
    expect(o.pushed.calls).toEqual([{ fn: "pipelinePrCreate", args: ["s3", "5101", expect.objectContaining({ target: "dev", base: "dev", confirmBranch: "release/2.1" })] }]);
  });

  it("says under Source Control's bar what a room session's push ran: the user's global pre-push, not the repository's, its LFS files first", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageResult } = await import("../scripts/ui-preview.mjs");
    const read = `(() => {
      window.__t0 ??= Date.now();
      if (Date.now() - window.__t0 < 3000) return null;
      if (!window.__reached) { window.__reached = 1; document.querySelector('.area-tree .lt-ws[data-sid="s1"]')?.click(); return null; }
      const b = [...document.querySelectorAll(".sc-sync button")].find((x) => /Push|Publish/.test(x.textContent || ""));
      if (!b) return Date.now() - window.__t0 > 20000 ? JSON.stringify({ error: "no Push button" }) : null;
      if (!window.__pushed) { window.__pushed = 1; window.__before = document.querySelector("[data-push-hooks]")?.textContent ?? null; b.click(); return null; }
      const l = document.querySelector("[data-push-hooks]");
      return l ? JSON.stringify({ before: window.__before, line: l.textContent }) : null;
    })()`;
    const json: string | null = await pageResult({ size: "1400x900", query: "motion=off&view=scm&roomPushHooks", outDir: path.join(tempDir("needs-sc"), "out"), read });
    expect(JSON.parse(json!)).toEqual({
      before: null,
      line: "Your global pre-push in ~/.githooks runs; the one in .git/hooks doesn't, for a room session's push: this repository's hooks can run files its agent writes (a hook manager's config, its scripts). Its Git LFS files are uploaded first, with git lfs push.",
    });
  });

  it("asks before Source Control pushes a room session's branch that isn't its own, naming it, and pushes nothing when told no", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageResult } = await import("../scripts/ui-preview.mjs");
    const read = `(() => {
      window.__t0 ??= Date.now();
      if (Date.now() - window.__t0 < 3000) return null;
      if (!window.__reached) { window.__reached = 1; document.querySelector('.area-tree .lt-ws[data-sid="s1"]')?.click(); return null; }
      const b = [...document.querySelectorAll(".sc-sync button")].find((x) => /Push|Publish/.test(x.textContent || ""));
      if (!b) return Date.now() - window.__t0 > 20000 ? JSON.stringify({ error: "no Push button" }) : null;
      const pushes = () => window.__mbCalls.filter((c) => c.fn === "scmPush").map((c) => c.args);
      if (!window.__asked) {
        window.__asked = [];
        window.confirm = (m) => (window.__asked.push(m), window.__asked.length > 1);
        b.click();
        return null;
      }
      if (window.__asked.length === 1 && !window.__no) {
        if (b.disabled) return null;
        window.__no = { pushes: pushes(), line: !!document.querySelector("[data-push-hooks]") };
        b.click();
        return null;
      }
      const l = document.querySelector("[data-push-hooks]");
      return l ? JSON.stringify({ asked: window.__asked, no: window.__no, pushes: pushes(), line: !!l }) : null;
    })()`;
    const json: string | null = await pageResult({ size: "1400x900", query: "motion=off&view=scm&roomPushHooks&pushConfirm", outDir: path.join(tempDir("needs-sc-ask"), "out"), read });
    const ask = "The worktree is on release/2.1, not 5101-orgDropdowns, the branch this session was made on: pushing it updates origin's release/2.1.\n\nPush release/2.1 to origin anyway?";
    expect(JSON.parse(json!)).toEqual({
      asked: [ask, ask],
      // told no: asked once, nothing pushed, nothing said
      no: { pushes: [["s1"]], line: false },
      // told yes: asked again with the branch it named
      pushes: [["s1"], ["s1"], ["s1", "release/2.1"]],
      line: true,
    });
  });

  it("asks before Close session's Push branch pushes a room session's base-named branch, naming it, and sends the branch it showed", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageResult } = await import("../scripts/ui-preview.mjs");
    const read = `(() => {
      window.__t0 ??= Date.now();
      if (Date.now() - window.__t0 < 3000) return null;
      const late = () => (Date.now() - window.__t0 > 25000 ? JSON.stringify({ error: window.__step ?? "nothing" }) : null);
      if (!window.__menu) {
        const n = document.querySelector('.ls-world .ls-node[data-front="s1"]');
        if (!n) return late();
        const r = n.getBoundingClientRect();
        n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.3 }));
        window.__menu = 1;
        window.__step = "menu";
        return null;
      }
      if (!window.__closing) {
        const b = [...document.querySelectorAll(".mb-ctx button")].find((x) => x.querySelector(".mb-ctx-t")?.textContent === "Close…");
        if (!b) return late();
        b.click();
        window.__closing = 1;
        window.__step = "dialog";
        return null;
      }
      if (!window.__asked) {
        const push = [...document.querySelectorAll(".close-dlg .opt")].find((x) => /Push branch, then remove worktree/.test(x.textContent || ""));
        if (!push) return late();
        push.click();
        window.__asked = [];
        window.confirm = (m) => (window.__asked.push(m), true);
        setTimeout(() => document.querySelector(".close-dlg .primary")?.click(), 300);
        window.__step = "confirm";
        return null;
      }
      const cleanups = window.__mbCalls.filter((c) => c.fn === "worktreeCleanup").map((c) => c.args.slice(2));
      if (cleanups.length < 2 || document.querySelector(".close-dlg")) return late();
      return JSON.stringify({ asked: window.__asked, cleanups });
    })()`;
    const json: string | null = await pageResult({ size: "1400x900", query: "motion=off&cleanupConfirm", outDir: path.join(tempDir("needs-close"), "out"), read });
    expect(JSON.parse(json!)).toEqual({
      asked: ["The worktree is on develop, a base branch's name: pushing it would update origin's develop directly. Move the work to a branch of its own first.\n\nPush develop to origin anyway?"],
      // first with the branch the dialog showed, then with the say-so naming the one main read
      cleanups: [
        ["push", { shown: "5101-orgDropdowns" }],
        ["push", { shown: "develop", confirmBranch: "develop" }],
      ],
    });
  });

  it("keeps the user's unsaved patch notes edit when the agent's newer draft arrives, saving nothing over it until they pick", async () => {
    const r = await run<NewerNotesAudit>("r", "prRequest=notes&lsCamera=0,0,0.5");
    expect(r.error).toBeUndefined();
    // the edit stays and isn't saved over the newer draft, even on leaving the box; Post and Discard wait on the choice
    expect(r.rewritten).toMatchObject({ text: "My own notes.", post: true, discard: true, by: "drafted by Verifier's agent", calls: [] });
    expect(r.rewritten.newer).toMatch(/^A newer draft by Verifier's agent arrived while you were editing\. Your text is still here, not saved\./);
    // Show the newer draft: the edit dropped, nothing saved
    expect(r.shown).toEqual({ text: "The Verifier's second draft.", newer: null, post: false, discard: false, by: "drafted by Verifier's agent", calls: [] });
    // Keep mine: the user's words saved onto the newest draft, which is theirs from then on
    expect(r.kept).toEqual({ text: "Mine, kept.", newer: null, post: false, discard: false, by: null, calls: [{ fn: "pipelineDraftEdit", args: ["5102", "d-notes-3", "Mine, kept."] }] });
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

  // W5: ?lsWires&lsGates's gates: Fixtures → Spike (closed) and Reviewer → Builder's changes ready, Builder → Reviewer
  // may have arrived, and 5120's PR 11 to dev unreadable three times
  it("lists the wires waiting on you and a pull request it can't read, sends only what an item named, and finishes a step only from Finish step", async () => {
    const w = await run<WireNeedsAudit>("w", "lsWires&lsGates&lsCamera=0,3040,1", "1600x1000");
    expect(w.error).toBeUndefined();
    expect(w.keys).toBe("real");
    const pr = "https://dev.azure.com/acme/Backoffice/_git/backoffice/pullrequest/11";
    const acts = (...a: [string, boolean, number][]) => a.map(([key, filled, tab]) => ({ key, label: expect.any(String), filled, tab }));
    // the wires and the pull request, in Mockingbird's words: Send only from a pointer (no Tab stop), Show and Check now
    expect(w.tray.filter((i) => i.kind === "wire" || i.kind === "merge").map((i) => [i.id, i.meta, i.text])).toEqual([
      ["wire:wb-ghost", "Wire ready · #5120", "Fixtures → Spike: streaming: ready to send (sending reopens it)"],
      ["wire:wb-loop", "Wire ready · #5120", "Reviewer → Builder: ready to send (round 2 of 3)"],
      ["wire:wb-sending", "Wire may have arrived · #5120", "Builder → Reviewer: it may have arrived"],
      [`merge:5120:${pr}`, "Pull request · #5120", "Can't tell whether PR 11 to dev merged · #5120"],
    ]);
    const byId = Object.fromEntries(w.tray.map((i) => [i.id, i.acts]));
    expect(byId["wire:wb-loop"]).toEqual(acts(["send", true, -1], ["show", false, 0], ["dismiss", false, 0]));
    expect(byId["wire:wb-sending"]).toEqual(acts(["show", true, 0], ["dismiss", false, 0]));
    expect(byId[`merge:5120:${pr}`]).toEqual(acts(["check", true, 0], ["markMerged", false, 0], ["dismiss", false, 0]));
    // the pull-request-merged wire waiting on that PR, and the handoff held for approve, wait on nothing of yours at their gates
    expect(w.tray.map((i) => i.id)).not.toContain("wire:wb-sent");
    expect(w.tray.map((i) => i.id)).not.toContain("wire:wb-held");

    // Finish step… on Reviewer's Finished item: its latest message, the agent's; a burst begun before it opened presses
    // nothing; Finish step off till a verdict is picked
    expect(w.finishedItem?.acts.map((a) => a.key)).toEqual(["go", "finish", "dismiss"]);
    expect(w.finishOpened).toMatchObject({ tray: false, keyboard: "finish", calls: [{ fn: "wiresLastMessage", args: ["wb-reviewer"] }] });
    expect(w.finishOpened.pop).toMatchObject({
      title: "Finish Reviewer's step",
      mark: "From its latest message. Its agent wrote this, not you.",
      body: "Two changes before merge:\n1. The stream is disposed before the response ends.\n2. The email column needs the DonorPII grant.",
      verdicts: ["Changes", "Approve"],
      lines: [],
      finish: { disabled: true, title: "Pick a verdict first" },
      hint: true,
    });
    // Changes picked: where each wire goes and what it does; Finish step clicked straight after takes nothing
    expect(w.finishEarly.pop?.verdicts).toEqual(["Changes*", "Approve"]);
    expect(w.finishEarly.pop?.lines).toEqual([
      ["Builder", "its gate opens · round 2 of 3", "t-ready"],
      ["Tester", "blocked till approve, then its gate opens", "t-held"],
    ]);
    expect(w.finishEarly.calls).toEqual([]);
    // then the one finish, with the words and the verdict shown; the keyboard back on the Needs you button
    expect(w.finished.calls).toEqual([{ fn: "wiresFinish", args: ["wb-reviewer", w.finishOpened.pop!.body, "changes"] }]);
    expect(w.finished).toMatchObject({ open: false, keyboard: "button", note: "Finished Reviewer's step: Builder: waits at its gate; Tester: blocked till approve.", held: null });

    const ghost = ["wb-ghost", "pd-fixtures", "The streaming fixtures are in fixtures/stream: 40k donors, one with no email."];
    // the cost question asked from a send popover opened as Builder's terminal was typed in: with the popover gone, Esc
    // gives the keyboard to the landscape, not the terminal, and sends nothing
    expect(w.costEsc).toEqual({ typedIn: "terminal", asked: true, popGone: true, dialog: false, keyboard: "landscape", calls: [{ fn: "wiresSend", args: [...ghost, null] }, { fn: "resumeCost", args: ["wb-spike"] }] });
    // Send: Enter on it presses nothing; a click as a newer finish lands under it is let go; then the one send of what's
    // shown now, under its pending
    expect(w.keySend).toEqual({ tab: -1, calls: [] });
    expect(w.changedUnder.calls).toEqual([]);
    // one landing in the same task as the click, before the tray has drawn it: nothing sent, the gate shown with it
    expect(w.raced).toMatchObject({ calls: [], pop: true, note: "What waits there now is newer than what you were shown: nothing was sent." });
    expect(w.sentLoop.calls).toEqual([{ fn: "wiresSend", args: ["wb-loop", "pd-finish-1-newer-raced", "1. Dispose the stream after the response.\n2. Gate the email column on DonorPII.", null] }]);
    expect(w.sentLoop.item).toBe(false);
    // a click on a row that moved up a moment ago takes nothing; a double click once it's still sends once, its closed
    // end's cost asked between main's refusal and the send that reopens it
    expect(w.movedUnder.calls).toEqual([]);
    expect(w.sentGhost.calls).toEqual([
      { fn: "wiresSend", args: [...ghost, null] },
      { fn: "resumeCost", args: ["wb-spike"] },
      { fn: "wiresSend", args: [...ghost, { start: true }] },
    ]);

    // Show: the send popover on what may have arrived, the tray away; Esc gives the keyboard back to the button
    expect(w.shown).toEqual({ tray: false, face: "f-unconfirmed", ends: "Builder → Reviewer", keyboard: "popover", calls: [] });
    expect(w.shownClosed).toEqual({ open: false, keyboard: "button", calls: [] });

    // the pull request: Check now's one call, its error said
    expect(w.checked).toEqual({ calls: [{ fn: "pipelinePrCheck", args: ["5120", pr] }], note: "Couldn't check PR 11 to dev: UI preview: no pull request is read" });
    // Mark merged… asks, naming it; a burst's keys press nothing; a click as a re-read changes the question is let go
    expect(w.markAsked).toMatchObject({ tray: false, keyboard: "dialog", hint: true, calls: [] });
    expect(w.markAsked.question).toMatch(/^Mark PR 11 to dev in backoffice merged\? Mockingbird can't read whether it merged\./);
    expect(w.markReread.question).toMatch(/^Mark PR 11 to dev in backoffice merged\? Its provider says it was closed without merging\./);
    // a click as the re-read lands, before it's drawn, marks nothing and says so; one just after it's drawn is let go
    expect(w.markReread).toMatchObject({ open: true, err: "It changed as you clicked: nothing was marked. Read what it says now.", calls: [] });
    expect(w.marked).toEqual({ open: false, keyboard: "button", note: "Marked PR 11 to dev merged: #5120 and its wires go on as for a merge, their gates asking first.", calls: [{ fn: "pipelinePrMarkMerged", args: ["5120", pr] }] });

    // in focus: the header's Finish step, its popover under it, nothing finished by opening or Esc; the menu has it too
    expect(w.header).toEqual({ focus: true, button: { label: "Finish step", disabled: false } });
    expect(w.headerPop).toEqual({ open: true, under: true, keyboard: "finish", calls: [{ fn: "wiresLastMessage", args: ["wb-reviewer"] }] });
    expect(w.headerClosed.open).toBe(false);
    expect(w.headerClosed.keyboard).not.toBe("terminal");
    expect(w.menu).toEqual(["Connect…", "Finish step…"]);
  }, 150_000);
});
