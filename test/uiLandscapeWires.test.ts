import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { WIRED_COLUMN_GAP } from "../src/renderer/landscapeModel";
import { tempDir } from "./helpers";

// The landscape's wires (W4a) in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. ?landscapeWiresAudit (src/preview/wiresAudit.ts) reads the wires board (?lsWires) as
// drawn, drags Builder and pinches, and reports each step once it has settled. W4b's parts make wires with the mouse
// and keys pressed for real by the driver.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Pt = { x: number; y: number };
type Box = { l: number; t: number; r: number; b: number };
interface Drawn {
  id: string;
  look: string;
  arrow: boolean;
  dot: "ready" | "blocked" | "hidden" | null;
  glow: boolean;
  label: { text: string; shown: boolean; h: number } | null;
  tabs: { end: string; text: string }[];
  ends: { from: Pt; to: Pt } | null;
  width: number;
  dash: string;
}
interface Audit {
  zoom: number;
  wires: Drawn[];
  boxes: Record<string, Box>;
  docsTab: Box | null;
  order: { svg: number; labels: number; lastArea: number; firstGhost: number; firstNode: number };
  events: string[];
  pill: Box;
  before: { builder: Box; sent: { from: Pt; to: Pt } };
  during: { builder: Box; sent: { from: Pt; to: Pt }; tree: { from: Pt; to: Pt }; loop: { from: Pt; to: Pt }; translate: string };
  after: { builder: Box; sent: { from: Pt; to: Pt }; tree: { from: Pt; to: Pt }; loop: { from: Pt; to: Pt }; translate: string };
  pinched: { zoom: number; builder: Box; sent: { from: Pt; to: Pt } };
  calls: string[];
  error?: string;
}

async function audit(query: string, size = "1600x1000", limitMs = 60_000): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size,
    query: `motion=off&lsWires&${query}`,
    outDir: path.join(tempDir("ls-wires"), "out"),
    read: `document.getElementById("mb-landscape-wires-audit")?.textContent ?? null`,
    limitMs,
  });
  if (!json) throw new Error("the preview didn't finish its wires audit");
  const out = JSON.parse(json);
  expect(out.error).toBeUndefined();
  return out;
}

const near = (a: number, b: number, by = 1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(by);
const wire = (a: Audit, id: string) => {
  const w = a.wires.find((x) => x.id === `wb-${id}`);
  if (!w) throw new Error(`wire ${id} isn't drawn: ${a.wires.map((x) => x.id).join(", ")}`);
  return w;
};

describe.skipIf(!local)("the landscape's wires", () => {
  it("at 100%: each state as Inbox.dc.html draws it, at screen size, from box to box, between the areas and the workspaces", async () => {
    const a = await audit("lsCamera=0,3040,1&landscapeWiresAudit=near");
    expect(a.zoom).toBe(1);
    expect(a.wires.map((w) => [w.id.slice(3), w.look, w.arrow])).toEqual([
      ["sent", "sent", true],
      ["sending", "sending", true],
      ["loop", "ready", true],
      ["held", "blocked", true],
      ["tree", "tree", false],
      ["context", "context", false],
      ["ghost", "idle", true],
      ["pill", "context", false],
    ]);
    expect(wire(a, "loop")).toMatchObject({ dot: "ready", glow: true, label: { text: "Ready · round 2 of 3", shown: true }, width: 2.2 });
    expect(wire(a, "held")).toMatchObject({ dot: "blocked", label: { text: "needs approve", shown: true }, width: 1.6, dash: "4px, 4px" });
    expect(wire(a, "sending")).toMatchObject({ label: { text: "sending…", shown: true }, width: 1.8, dash: "5px, 4px" });
    expect(wire(a, "sent")).toMatchObject({ label: null, width: 1.5, dash: "none" });
    expect(wire(a, "tree")).toMatchObject({ width: 5 });
    // Docs is the stack's back tab: named where the context link reaches it
    expect(wire(a, "context").tabs).toEqual([{ end: "to", text: "Docs" }]);
    expect(wire(a, "ghost").tabs).toEqual([]);
    // labels at screen size: a pill's line and padding
    near(wire(a, "loop").label!.h, 19);

    // ends on the boxes: side to side, 2 px short of the arrow's box; down from the middle where boxes share a column;
    // a loop back under both
    const { shape, builder, reviewer, dev, tester, fixtures, spike } = a.boxes;
    const sent = wire(a, "sent").ends!;
    near(sent.from.x, shape.r);
    near(sent.to.x, builder.l - 2);
    near(sent.from.y, (shape.t + shape.b) / 2);
    const tree = wire(a, "tree").ends!;
    near(tree.from.y, builder.b);
    near(tree.to.y, dev.t - 2);
    near(tree.from.x, tree.to.x);
    const loop = wire(a, "loop").ends!;
    near(loop.from.y, reviewer.b);
    near(loop.to.y, builder.b + 2);
    expect(loop.to.x).toBeGreaterThan((builder.l + builder.r) / 2);
    near(wire(a, "held").ends!.to.y, tester.t - 2);
    near(wire(a, "context").ends!.to.y, fixtures.t - 2);
    near(wire(a, "ghost").ends!.to.y, spike.t - 2);

    // over the areas, under every ghost and workspace; nothing in it takes a pointer
    expect(a.order.svg).toBeGreaterThan(a.order.lastArea);
    expect(a.order.svg).toBeLessThan(a.order.firstGhost);
    expect(a.order.svg).toBeLessThan(a.order.firstNode);
    expect(a.events).toEqual(["none", "none"]);
  });

  it("zoomed out to 13%: lines alone, at screen size, to the cards as they're drawn", async () => {
    const a = await audit("lsCamera=-1200,-600,0.13&landscapeWiresAudit=far");
    expect(a.zoom).toBe(0.13);
    expect(a.wires).toHaveLength(8);
    for (const w of a.wires) {
      expect(w.label?.shown ?? false).toBe(false);
      expect(w.dot === null || w.dot === "hidden").toBe(true);
    }
    expect(wire(a, "sent").width).toBe(1.5);
    expect(wire(a, "loop").width).toBe(2);
    expect(wire(a, "tree").width).toBe(5);
    // dashes in landscape px, 4 on screen
    expect(wire(a, "held").dash.split(",").map((v) => Math.round(parseFloat(v) * a.zoom * 10) / 10)).toEqual([4, 4]);
    // each card is drawn a few px in from its place: the wire reaches it there
    const { shape, builder } = a.boxes;
    const sent = wire(a, "sent").ends!;
    near(sent.from.x, shape.r);
    near(sent.to.x, builder.l - 2);
  });

  it("follow a dragged workspace while it moves and once it's let go, and a pinch, with no terminal resized", async () => {
    const a = await audit("lsCamera=0,3040,1&landscapeWiresAudit=drag");
    expect(a.during.translate).not.toBe("");
    // moved by the drag (its translate), its wires' ends with it
    near(a.during.builder.l, a.before.builder.l + 64);
    near(a.during.sent.to.x, a.during.builder.l - 2);
    near(a.during.sent.from.y, a.before.sent.from.y + 20);
    near(a.during.tree.from.y, a.during.builder.b);
    near(a.during.loop.to.y, a.during.builder.b + 2);
    // let go: the layout has it there, and the wires stay on it
    expect(a.after.translate).toBe("");
    near(a.after.sent.to.x, a.after.builder.l - 2);
    near(a.after.tree.from.y, a.after.builder.b);
    // pinched: drawn again at the new zoom, still on its ends
    expect(a.pinched.zoom).toBeLessThan(0.75);
    near(a.pinched.sent.to.x, a.pinched.builder.l - 2);
    // the drop is saved; nothing resized a terminal
    expect(a.calls).toContain("landscapeUpdate");
    expect(a.calls).not.toContain("sessionResize");
  });

  it("follow a dragged area's workspaces, under every other workspace however it's dragged", async () => {
    const a = (await audit("lsCamera=-1200,-600,0.13&landscapeWiresAudit=area")) as unknown as Record<"before" | "during" | "after", { lifted: string[]; builder: Box; sent: { from: Pt; to: Pt } }>;
    expect(a.before.lifted).toEqual(["auto", "5"]);
    expect(a.during.lifted).toEqual(["auto", "5"]);
    expect(a.during.builder.l).toBeGreaterThan(a.before.builder.l);
    near(a.during.sent.to.x, a.during.builder.l - 2);
    expect(a.after.lifted).toEqual(["auto", "5"]);
    near(a.after.sent.to.x, a.after.builder.l - 2);
  });

  it("end at a collapsed area's pill", async () => {
    const a = await audit("lsCollapsed=5102&lsCamera=-1200,-600,0.13&landscapeWiresAudit=pill");
    const to = wire(a, "pill").ends!.to;
    expect(to.x).toBeGreaterThanOrEqual(a.pill.l);
    expect(to.x).toBeLessThanOrEqual(a.pill.r);
    near(to.y, a.pill.b + 2);
  });

  it("lay their area out when it's tidied (W10): each chain left to right, a shared terminal under its agent, and the note says so", async () => {
    const a = (await audit("lsCamera=-200,2700,0.45&landscapeWiresAudit=tidy")) as Audit & { said: string | null };
    expect(a.said).toMatch(/^Tidied #5120 along its wires/);
    const b = a.boxes;
    // Zoomed.dc.html's 50 px between a chain's columns at 45%
    for (const [l, r] of [["shape", "builder"], ["builder", "reviewer"], ["reviewer", "tester"]]) {
      near(b[r].l - b[l].r, WIRED_COLUMN_GAP * a.zoom, 2);
      near(b[l].t, b[r].t);
    }
    // Dev server shares Builder's worktree; Docs' stack is read by Shape export; Spike: streaming is handed to by the stack
    for (const [over, under] of [["builder", "dev"], ["shape", "fixtures"], ["dev", "spike"]]) {
      near(b[under].l, b[over].l);
      expect(b[under].t).toBeGreaterThan(b[over].b);
    }
    for (const id of ["sent", "sending", "loop", "held", "tree", "context", "ghost"]) expect(wire(a, id).ends).not.toBeNull();
  });

  it("leave panning and pinching at the display's rate with 20 of them (?landscapePerf, S6a's 16.7 ms p95)", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageResult } = await import("../scripts/ui-preview.mjs");
    const json: string | null = await pageResult({
      size: "1400x900",
      query: "landscapeMany=30&lsWires=20&landscapePerf",
      outDir: path.join(tempDir("ls-wires-perf"), "out"),
      read: `(() => { const t = document.getElementById("mb-landscape-perf"); return t ? JSON.stringify({ perf: JSON.parse(t.textContent), wires: document.querySelectorAll(".ls-wires g.ls-wire").length }) : null; })()`,
      limitMs: 150_000,
    });
    if (!json) throw new Error("the preview didn't finish ?landscapePerf");
    const { perf, wires } = JSON.parse(json);
    expect(perf.error).toBeUndefined();
    expect(wires).toBe(20);
    const p95s = [...perf.zooms.flatMap((z: { pan: { interval: { p95: number } }; pinch: { interval: { p95: number } } }) => [z.pan.interval.p95, z.pinch.interval.p95]), perf.sweep.interval.p95];
    // a frame at 60 Hz is 16.7 ms, read as 16.7–16.8 (S6a)
    for (const p of p95s) expect(p).toBeLessThanOrEqual(16.8);
  }, 200_000);
});

// ---- W4b: making wires (?landscapeWiresAudit=make|keys|menus) ----
type Shown = { ends: string; rows: { type: string; off: boolean; on: boolean; line: string }[]; foot: string; keyboard: boolean } | null;
type Draft = { line: boolean; hot: { box: Box; no: boolean } | null };
type Call = unknown[];
interface Make {
  drop: { during: Draft; picker: Shown; made: Call[]; afterPicker: Shown; drawn: number; keys: string };
  escDrag: { held: Draft; after: Draft; picker: Shown; made: Call[] };
  escPick: { open: Shown; picker: Shown; made: Call[]; keys: string };
  refused: { onto: string; hot: { no: boolean } | null; note: string | null; picker: Shown; made: Call[] };
  stack: { picker: Shown };
  stackTab?: { picker: Shown };
  writes: number;
}
interface Keys {
  before: string;
  control: number;
  dragKeys: string;
  burst: { dragging: { picker: Shown; draft: boolean }; writes: number; layout: number; picker: Shown; made: Call[] };
  paused: { made: Call[]; picker: Shown; keys: string };
  click: { early: { made: Call[]; off: boolean; picker: boolean }; byCode: { made: Call[]; picker: boolean }; made: Call[]; picker: Shown };
  connect: { picker: Shown; made: Call[]; after: Shown; keys: string };
  writes: string[];
}
interface Menus {
  wsMenu: string[];
  connect: string[];
  fromTree: string[] | string;
  wireMenu: string[];
  settings: { opened: Record<string, unknown>; set: Call[]; after: Record<string, unknown> };
  settingsClosed: { form: unknown; keys: string };
  treeMenu: string[];
  settingsBurst: { shown: { open: boolean; keyboard: string }; open: boolean; keyboard: boolean; set: Call[]; removed: Call[]; closed: boolean };
  remove: { removed: { calls: Call[]; note: string; drawn: boolean }; restore: Call[]; drawn: boolean };
}
const TEAMMATE = "That's a teammate's session: wires across Macs come later.";

describe.skipIf(!local)("making wires", () => {
  it.each([
    ["100%", "lsCamera=0,3040,1", "1600x1000", "builder"],
    ["60%", "lsCamera=-100,1850,0.6", "1600x1200", "nick"],
  ])("at %s: dragged from a handle and dropped, Esc while dragging and in the picker, a refused drop, and a drop onto a stack", async (_at, camera, size, refusedOnto) => {
    const m = (await audit(`${camera}&landscapeWiresAudit=make`, size, 120_000)) as unknown as Make;
    // the drag draws its line and outlines where it would go; the drop asks for a type, the keyboard in the picker
    expect(m.drop.during.line).toBe(true);
    expect(m.drop.during.hot?.no).toBe(false);
    expect(m.drop.picker).toMatchObject({ ends: "Shape donor export → Reviewer", foot: "↵ takes Handoff · Esc cancels, and the wire goes", keyboard: true });
    expect(m.drop.picker!.rows.map((r) => [r.type, r.off, r.on])).toEqual([["handoff", false, true], ["context", false, false], ["feedback", false, false], ["worktree", true, false]]);
    expect(m.drop.picker!.rows[0].line).toBe("Shape donor export's result becomes Reviewer's next prompt.");
    expect(m.drop.picker!.rows[3].line).toBe("A shared worktree wire runs from an agent to a terminal.");
    // ↵ after a pause makes the handoff, drawn from main's change notice; the keyboard back on the landscape
    expect(m.drop.made).toEqual([["wb-shape", "wb-reviewer", "handoff"]]);
    expect(m.drop.afterPicker).toBeNull();
    expect(m.drop.drawn).toBe(1);
    expect(m.drop.keys).toBe("landscape");
    // Esc while dragging: the line and the outline go, and no picker comes up when it's let go
    expect(m.escDrag.held.line).toBe(true);
    expect(m.escDrag.after).toEqual({ line: false, hot: null });
    expect(m.escDrag.picker).toBeNull();
    expect(m.escDrag.made).toEqual([]);
    // Esc in the picker; a type that's there already is off, saying so, and ↵ takes the first that can be made
    expect(m.escPick.open?.ends).toBe("Shape donor export → Builder");
    expect(m.escPick.open?.rows.find((r) => r.type === "handoff")).toMatchObject({ off: true, line: "There's a handoff wire between these two already." });
    expect(m.escPick.open?.foot).toBe("↵ takes Context link · Esc cancels, and the wire goes");
    expect(m.escPick.picker).toBeNull();
    expect(m.escPick.made).toEqual([]);
    expect(m.escPick.keys).toBe("landscape");
    // a drop no wire can take: outlined as refused while over it, and said, with no picker and nothing asked of main
    expect(m.refused.onto).toBe(refusedOnto);
    expect(m.refused.hot?.no).toBe(true);
    // (Dev server shares Builder's worktree already: the one wire they can have is there, which is what's said)
    expect(m.refused.note).toBe(refusedOnto === "nick" ? TEAMMATE : "There's a worktree wire between these two already.");
    expect(m.refused.picker).toBeNull();
    expect(m.refused.made).toEqual([]);
    // onto a stack: its front tab, or the tab dropped on
    expect(m.stack.picker?.ends).toBe("Shape donor export → Fixtures");
    if (camera.endsWith(",1")) {
      expect(m.stackTab?.picker?.ends).toBe("Shape donor export → Docs");
      expect(m.stackTab?.picker?.rows.find((r) => r.type === "context")).toMatchObject({ off: true, line: "There's a context wire between these two already." });
    } else expect(m.stackTab).toBeUndefined();
    expect(m.writes).toBe(0);
  }, 150_000);

  it("draws a handle only on a card with room for it: none at 13%, the bigger ones at 30%", async () => {
    // on a smaller card a press there moves it, as anywhere else on it (Connect… makes its wires)
    const at13 = (await audit("lsCamera=-1200,-600,0.13&landscapeWiresAudit=handles")) as unknown as { handles: string[] };
    expect(at13.handles).toEqual([]);
    const at30 = (await audit("lsCamera=-100,850,0.3&landscapeWiresAudit=handles")) as unknown as { handles: string[] };
    expect(at30.handles).toEqual(["shape", "builder", "reviewer", "fixtures"]);
  }, 150_000);

  it("take no key that wasn't for them: none typed while dragging acts, a burst's Enter makes no wire, nor a click on a row that just came up", async () => {
    const k = (await audit("lsCamera=0,3040,1&landscapeWiresAudit=keys", "1600x1000", 120_000)) as unknown as Keys;
    // Builder's terminal was being typed in (a key reached it); the press on Shape's handle gives the landscape the keyboard
    expect(k.before).toBe("terminal:wb-builder");
    expect(k.control).toBe(1);
    expect(k.dragKeys).toBe("landscape");
    // t, x, Tab and Enter while dragging: nothing typed into a terminal, no landscape key run, no picker yet
    expect(k.burst.dragging).toEqual({ picker: null, draft: true });
    expect(k.burst.writes).toBe(0);
    expect(k.burst.layout).toBe(0);
    // Enter straight after the drop is the same burst: no wire, and the picker says why
    expect(k.burst.picker).toMatchObject({ ends: "Shape donor export → Tester", keyboard: true, foot: "Keys typed just before this opened don't pick: pause, then ↵" });
    expect(k.burst.made).toEqual([]);
    // after a pause, ↵ makes it, and the keyboard goes back to the landscape, never to a terminal
    expect(k.paused.made).toEqual([["wb-shape", "wb-tester", "handoff"]]);
    expect(k.paused.picker).toBeNull();
    expect(k.paused.keys).toBe("landscape");
    // a click on a row that came up under the pointer is let go, its row off; the next, once it has settled, counts
    expect(k.click.early).toEqual({ made: [], off: true, picker: true });
    // a click with no pointer behind it picks nothing, however long the row has been there
    expect(k.click.byCode).toEqual({ made: [], picker: true });
    expect(k.click.made).toEqual([["wb-shape", "wb-reviewer", "context"]]);
    expect(k.click.picker).toBeNull();
    // Connect…'s row picked with Enter, then Enter again in the same burst: the picker is up, and nothing is made
    expect(k.connect.picker).toMatchObject({ ends: "Dev server → Tester", keyboard: true });
    expect(k.connect.picker!.rows.find((r) => r.type === "worktree")).toMatchObject({ off: false, on: true, line: "Dev server runs in Tester's worktree, and Tester reads its output." });
    expect(k.connect.made).toEqual([]);
    expect(k.connect.after).toBeNull();
    expect(k.connect.keys).toBe("landscape");
    // the one key that reached a terminal was the one typed into it on purpose
    expect(k.writes).toEqual(["wb-builder"]);
  }, 150_000);

  it("Connect… lists where a wire can go, saying why not; a wire's right-click opens its settings, saved as changed, and Remove has Undo", async () => {
    const m = (await audit("lsCamera=0,3040,1&landscapeWiresAudit=menus", "1600x1000", 120_000)) as unknown as Menus;
    expect(m.wsMenu.slice(-5)).toEqual(["-", "# Wires", "Connect…", "-", "Close…"]);
    // its own area first, each workspace a wire can't reach off with the reason
    expect(m.connect.slice(0, 9)).toEqual(["# Connect “Shape donor export” to", "# #5120", "Builder", "Reviewer", "Dev server", "Tester", "Fixtures", "Docs", "Spike: streaming (closed)"]);
    expect(m.connect).toContain(`off Donor export: CSV writer — ${TEAMMATE}`);
    expect(m.connect.some((r) => r.startsWith("off Org dropdowns remember the last org — Both ends have to be in the same team room"))).toBe(true);
    // the same menu from its row in the side bar's tree
    expect(m.fromTree).toEqual(m.connect);
    // a wire's right-click, a few px from its line
    expect(m.wireMenu).toEqual(["# Reviewer → Tester · Handoff", "Settings…", "-", "Remove the wire"]);
    expect(m.settings.opened).toMatchObject({ ends: "Reviewer → Tester", kind: "handoff · blocked", template: "{summary}", chips: ["+ summary", "add ticket", "add diff", "add files"], when: ["* When it says it's finished", "Only when I send", "When its PR merges"], auto: false, keyboard: true });
    expect(m.settings.set).toEqual([["wb-held", { when: "manual" }]]);
    expect(m.settings.after).toMatchObject({ when: ["When it says it's finished", "* Only when I send", "When its PR merges"] });
    expect(m.settingsClosed).toEqual({ form: null, keys: "landscape" });
    expect(m.treeMenu).toEqual(["# Builder → Dev server · Shared worktree", expect.stringMatching(/^off Settings… — A shared worktree wire has nothing to set/), "-", "Remove the wire"]);
    // Settings… picked with Enter, then Tab ×9 and Enter in the same burst: the keyboard stays on the popover, nothing pressed
    expect(m.settingsBurst).toEqual({ shown: { open: true, keyboard: "settings" }, open: true, keyboard: true, set: [], removed: [], closed: true });
    expect(m.remove.removed).toEqual({ calls: [["wb-held"]], note: "Removed the wire Reviewer → Tester", drawn: false });
    expect(m.remove.restore).toEqual([["wb-held"]]);
    expect(m.remove.drawn).toBe(true);
  }, 150_000);
});

interface Double {
  hit: { x: number; what: string } | null;
  double: { open: boolean; held: boolean; changed: Call[]; err: string | null };
  settled: { changed: number };
}
interface Guards {
  handle: { edge: string | null; handleRight: number };
  hover: { at: string | null; on: string | null; made: unknown[] };
  earlyEsc: { pressed: boolean; after: boolean; selected: string | null };
  lostRelease: { dragging: { gesture: boolean; draft: boolean }; lost: { gesture: boolean; draft: boolean }; writes: number; picker: boolean };
  blur: { before: boolean; after: boolean; draft: boolean };
  picker: boolean;
}
interface Lost {
  chip: { was: string | null; now: string | null; err: string | null };
  closed: { open: boolean; note: string | null };
}

describe.skipIf(!local)("what wasn't aimed at a wire's popovers or its drag", () => {
  // 1600 × 1000 inside the window (its frame is 87 px): the cameras put the wire near the window's foot, so its menu and
  // its settings both come up above the pointer, the form over the Settings… row
  it.each([
    ["Shape → Builder", "lsCamera=0,2340,1", "wb-sent"],
    ["Shape → Docs", "lsCamera=0,2470,1", "wb-context"],
  ])("a double click on %s's Settings… changes nothing on the form that comes up under it; settled, a click there counts", async (_w, camera, id) => {
    const d = (await audit(`${camera}&landscapeWiresAudit=double&dblWire=${id}`, "1600x1087", 120_000)) as unknown as Double;
    // the form comes up under the row: its second click lands on one of its controls
    expect(d.hit).not.toBeNull();
    expect(d.double).toEqual({ open: true, held: true, changed: [], err: null });
    expect(d.settled.changed).toBe(1);
  }, 150_000);

  it("the picker under a resting pointer, an Esc before the drag, a lost release and the window losing focus", async () => {
    const g = (await audit("lsCamera=0,3040,1&landscapeWiresAudit=guards", "1600x1000", 120_000)) as unknown as Guards;
    // the handle is just in from the right resize strip, which keeps the edge's middle
    expect(g.handle).toEqual({ edge: "r", handleRight: 6 });
    // Connect…'s picker comes up with the pointer on Context link: a tremble chooses nothing, and ↵ takes Handoff
    expect(g.hover).toEqual({ at: "context", on: "handoff", made: ["handoff"] });
    // Esc on a handle pressed but not dragged yet drops it, and doesn't reach the landscape (Builder stays selected)
    expect(g.earlyEsc).toEqual({ pressed: true, after: false, selected: "wb-builder" });
    // a drag whose release never came ends at the next move with no button down: the click after is a click, and typing
    // reaches the terminal
    expect(g.lostRelease).toEqual({ dragging: { gesture: true, draft: true }, lost: { gesture: false, draft: false }, writes: 1, picker: false });
    expect(g.blur).toEqual({ before: true, after: false, draft: false });
    expect(g.picker).toBe(false);
  }, 150_000);

  it("a refused chip goes back off the field, and a template refused as the settings close is said over the landscape", async () => {
    const l = (await audit("lsCamera=0,3040,1&landscapeWiresAudit=lost", "1600x1000", 120_000)) as unknown as Lost;
    expect(l.chip).toEqual({ was: "{summary}", now: "{summary}", err: "The wire book can't be written right now." });
    expect(l.closed).toEqual({ open: false, note: "Reviewer → Tester: the change made as its settings closed wasn't saved. The wire book can't be written right now." });
  }, 150_000);
});

interface Fresh {
  fresh: { dialog: boolean; made: string | null; ghost: boolean; wire: { from: string; to: string } | null; onSpike: number; rekey: Call[]; kill: Call[]; note: string | null };
}

describe.skipIf(!local)("Start fresh", () => {
  const run = async (as = "") => ((await audit(`lsCamera=0,3040,1&lsSpikeGone&landscapeWiresAudit=fresh${as}`, "1600x1000", 120_000)) as unknown as Fresh).fresh;

  it("gives the fresh session the old one's wires before the old one is let go, saying nothing", async () => {
    const f = await run();
    expect(f).toMatchObject({ dialog: true, ghost: false, onSpike: 0, note: null });
    expect(f.made).toBeTruthy();
    expect(f.wire).toEqual({ from: "wb-fixtures", to: f.made });
    // moved before the forget, which then finds nothing to drop
    expect(f.rekey[0]).toEqual(["wb-spike", f.made]);
    expect(f.kill).toEqual([["wb-spike", true]]);
  }, 150_000);

  it("says why when its wires can't move, and which went with the old session", async () => {
    // a terminal can't be a handoff's end, so the move is refused whole and the handoff goes with Spike
    const f = await run("&freshAs=terminal");
    expect(f).toMatchObject({ dialog: true, ghost: false, wire: null, onSpike: 0, kill: [["wb-spike", true]] });
    expect(f.note).toBe(
      "“Spike: streaming”'s wires couldn't move to the fresh session: “new session” isn't the same kind of workspace as “Spike: streaming”, so its wires can't move there. Its wire went with it: Fixtures → Spike: streaming (handoff)."
    );
  }, 150_000);
});

// W4c: the send popover, opened by a wire's gate dot (src/preview/wiresAudit.ts' send, gatekeys, dbl and gates parts)
interface Pop {
  face: string;
  ends: string;
  kind: string;
  whys: string[];
  body: string | null;
  flags: string[];
  buttons: string[];
  question: string | null;
  when: string[];
  err: string | null;
  hint: string | null;
  keyboard: boolean;
}
type Sends = [string, string, string, unknown][];
interface SendRun {
  opened: Pop;
  early: { sends: number; pop: Pop };
  byCode: { sends: number; open: boolean };
  notYet: { sends: number; pop: Pop | null; look: string; keys: string };
  send: { autoEarly: { set: number; checked: boolean | null }; edited: Pop; replaced: Pop; onArrival: { sends: number; pop: Pop }; shown: string; during: Pop; again: Pop; sends: Sends; pop: Pop | null; look: string; keys: string };
  sent: { look: string; sends: number };
}
interface KeysRun {
  before: string;
  burst: { pop: Pop; sends: number; writes: number };
  paused: { onSend: string; sends: Sends; pop: Pop | null; keys: string; writes: number };
  esc: { opened: string; pop: boolean; keys: string };
}
interface GatesRun {
  closed: { opened: Pop; calls: string[]; sends: Sends; pop: Pop | null };
  unconfirmed: { opened: Pop; calls: string[]; marked: string[][]; pop: Pop | null; look: string };
  merge: { opened: Pop; checked: Pop; asked: Pop; early: { marked: number; pop: Pop }; calls: string[]; check: string[][]; marked: string[][]; after: Pop; look: string };
  held: { early: { set: number; when: string[] | null }; opened: Pop; set: [string, unknown][]; after: Pop };
  limit: { opened: Pop; under: Pop; moreRounds: string[][]; sends: number };
}
const PR_URL = "https://dev.azure.com/acme/Backoffice/_git/backoffice/pullrequest/11";

describe.skipIf(!local)("the send popover", () => {
  it("sends exactly what it shows, once: no click as it opens, none made by code; Not yet leaves it waiting; a newer finish replaces what's shown", async () => {
    const s = (await audit("lsCamera=0,3040,1&landscapeWiresAudit=send", "1600x1000", 120_000)) as unknown as SendRun;
    // Cards.dc.html's popover: the ends, the loop's round, what it sends, Send and Not yet; the keyboard in it
    expect(s.opened).toMatchObject({ face: "ready", ends: "Reviewer → Builder", kind: "feedback loop · round 2 of 3", body: "1. The stream disposes early.\n2. Email needs DonorPII.", buttons: ["Send", "Not yet"], keyboard: true });
    // a click where Send came up, straight away, is let go and Send is off a moment; one made by code never counts
    expect(s.early.sends).toBe(0);
    expect(s.early.pop.buttons).toEqual(["off Send", "Not yet"]);
    expect(s.early.pop.keyboard).toBe(true);
    expect(s.byCode).toEqual({ sends: 0, open: true });
    // Not yet: nothing sent, it's still ready, and the landscape has the keyboard back
    expect(s.notYet).toEqual({ sends: 0, pop: null, look: "ready", keys: "landscape" });
    // reopened, Send automatically clicked as it came up: let go, unchanged
    expect(s.send.autoEarly).toEqual({ set: 0, checked: false });
    // edited, then Reviewer finishes again while it's open: the newer one replaces it, saying the edit was set aside,
    // and a click on Send as that lands is let go
    expect(s.send.edited.body).toBe("1. The stream disposes early.\n2. Email needs DonorPII. ok");
    expect(s.send.replaced.body).toBe("1. The stream still disposes early.\n2. Email needs DonorPII.\n3. Add a test for the cap.");
    expect(s.send.replaced.whys).toEqual(["Reviewer finished again: this is what it sends now, and your edit of the earlier one was set aside."]);
    expect(s.send.onArrival.sends).toBe(0);
    // Send double-clicked, then clicked again while main answers: one send, of the text shown, for the pending shown
    expect(s.send.during.buttons).toEqual(["off Sending…", "Not yet"]);
    expect(s.send.again.buttons).toEqual(["off Sending…", "Not yet"]);
    expect(s.send.shown).toBe("1. The stream still disposes early.\n2. Email needs DonorPII. ok\n3. Add a test for the cap.");
    expect(s.send.sends).toEqual([["wb-loop", "pd-review-again", s.send.shown, null]]);
    // it closes once main has it, the keyboard on the landscape, and the wire sends, then shows sent
    expect(s.send).toMatchObject({ pop: null, keys: "landscape" });
    expect(["sending", "sent"]).toContain(s.send.look);
    expect(s.sent).toEqual({ look: "sent", sends: 1 });
  }, 150_000);

  it("takes no key typed before it opened, sends from keys typed after a pause, and never gives the keyboard to a terminal", async () => {
    const k = (await audit("lsCamera=0,3040,1&landscapeWiresAudit=gatekeys", "1600x1000", 120_000)) as unknown as KeysRun;
    expect(k.before).toBe("terminal:wb-builder");
    // a key typed in Builder's terminal, the dot clicked, and Tab Tab Enter Space in the same burst: nothing pressed,
    // nothing more written there, and the popover says why
    expect(k.burst.sends).toBe(0);
    expect(k.burst.writes).toBe(1);
    expect(k.burst.pop).toMatchObject({ face: "ready", keyboard: true, hint: "Keys typed just before this opened don't press anything here: pause, then go on." });
    // after a pause, Tab Tab reaches Send and Enter sends it
    expect(k.paused.onSend).toBe("Send");
    expect(k.paused.sends).toEqual([["wb-loop", "pd-review", "1. The stream disposes early.\n2. Email needs DonorPII.", null]]);
    expect(k.paused).toMatchObject({ pop: null, keys: "landscape", writes: 1 });
    // opened after Builder's terminal had the keyboard, and closed with Esc: the landscape gets it, not the terminal
    expect(k.esc).toEqual({ opened: "popover", pop: false, keys: "landscape" });
  }, 150_000);

  it("presses nothing with a double click's second on its dot, where it flips up over the dot near the window's foot", async () => {
    const d = (await audit("lsCamera=0,3040,1&landscapeWiresAudit=dbl", "1600x1000", 120_000)) as unknown as { dbl: { under: string; sends: number; pop: Pop }; after: { sends: number; pop: Pop | null; keys: string } };
    expect(d.dbl.under).toBe("popover");
    expect(d.dbl.sends).toBe(0);
    expect(d.dbl.pop).toMatchObject({ face: "ready", buttons: ["Send", "Not yet"], keyboard: true });
    expect(d.after).toEqual({ sends: 1, pop: null, keys: "landscape" });
  }, 150_000);

  it("shows its other faces: a stopped end started once its cost is asked, Mark sent, Check now, Mark merged… behind its confirm, and a blocked wire's settings", async () => {
    const g = (await audit("lsGates&lsCamera=0,3040,1&landscapeWiresAudit=gates", "1600x1000", 120_000)) as unknown as GatesRun;
    // a handoff to Spike, closed: it says Send reopens it; main is asked, says it's stopped, its cost is asked, then it starts it
    expect(g.closed.opened).toMatchObject({ face: "ready", kind: "handoff · ready", whys: ["“Spike: streaming” is closed: sending reopens it, which rereads its conversation."] });
    expect(g.closed.calls).toEqual(["wiresSend", "resumeCost", "wiresSend"]);
    expect(g.closed.sends.map((x) => x[3])).toEqual([null, { start: true }]);
    expect(g.closed.pop).toBeNull();
    // what may have arrived: the why whole, Send again and Mark sent; Mark sent settles it
    expect(g.unconfirmed.opened).toMatchObject({ face: "unconfirmed", kind: "handoff · may have arrived", whys: ["It may have reached “Reviewer”: Mockingbird quit while it was being pasted."], buttons: ["Send again", "Mark sent", "Not yet"] });
    expect(g.unconfirmed.marked).toEqual([["wb-sending", "pd-build"]]);
    expect(g.unconfirmed).toMatchObject({ calls: ["wiresMarkSent"], pop: null, look: "sent" });
    // a pull request that can't be read: the why whole, Check now (its error said), Mark merged… asking first
    expect(g.merge.opened).toMatchObject({ face: "settings", kind: "handoff · blocked", buttons: ["Check now", "Mark merged…", "Remove"], when: ["When it says it's finished", "Only when I send", "* When its PR merges"] });
    expect(g.merge.opened.whys).toEqual(["Can't tell whether PR 11 to dev merged (3 tries): the provider answered 503 Service Unavailable."]);
    expect(g.merge.check).toEqual([["5120", PR_URL]]);
    expect(g.merge.checked.err).toBe("Couldn't check the pull request: UI preview: no pull request is read");
    expect(g.merge.asked.question).toBe("Mark PR 11 to dev in backoffice merged? Mockingbird can't read whether it merged. The ticket moves on as for a merge, and its wires get it, saying you marked it; their gates ask before anything is sent.");
    expect(g.merge.asked.buttons).toEqual(["Check now", "Mark merged", "Cancel", "Remove"]);
    // its confirm, clicked as it came up, is let go; once settled, it marks it, and the wire waits at its gate, flagged
    expect(g.merge.early.marked).toBe(0);
    expect(g.merge.early.pop.buttons).toContain("off Mark merged");
    expect(g.merge.marked).toEqual([["5120", PR_URL]]);
    expect(g.merge.calls).toEqual(["pipelinePrCheck", "pipelinePrMarkMerged"]);
    expect(g.merge.after).toMatchObject({ face: "ready", flags: ["You marked PR 11 to dev merged: Mockingbird couldn't read it."], buttons: ["Send", "Not yet"] });
    expect(g.merge.look).toBe("ready");
    // a blocked wire shows its settings with why. A click on its form as it opens is let go; then When its PR merges
    // and a chip are saved as they're changed
    expect(g.held.early).toEqual({ set: 0, when: ["* When it says it's finished", "Only when I send", "When its PR merges"] });
    expect(g.held.opened).toMatchObject({ face: "settings", kind: "handoff · blocked", whys: ["needs approve"], when: ["* When it says it's finished", "Only when I send", "When its PR merges"] });
    expect(g.held.set).toEqual([["wb-held", { when: "pr-merged" }], ["wb-held", { template: "{pr}\n\n{summary}\n{diff}" }]]);
    expect(g.held.after.when).toEqual(["When it says it's finished", "Only when I send", "* When its PR merges"]);
  }, 150_000);

  it("at its limit offers One more round, and the Send that comes up under it takes no click straight away", async () => {
    const g = (await audit("lsGates=limit&lsCamera=0,3040,1&landscapeWiresAudit=gates", "1600x1000", 120_000)) as unknown as GatesRun;
    expect(g.limit.opened).toMatchObject({ face: "limit", kind: "feedback loop · at the limit · 3 of 3", whys: ["At the limit: 3 of 3 rounds."], buttons: ["One more round", "Not yet"] });
    expect(g.limit.moreRounds).toEqual([["wb-loop"]]);
    // Send clicked where it came up, about 250 ms after: let go, and shown off a moment
    expect(g.limit.under).toMatchObject({ face: "ready", kind: "feedback loop · round 4 of 4", buttons: ["off Send", "Not yet"] });
    expect(g.limit.sends).toBe(0);
  }, 150_000);

  it("takes the keyboard off Send when a newer finish replaces what's shown, and keeps it when the face changes under it", async () => {
    const r = ((await audit("lsCamera=0,3040,1&landscapeWiresAudit=refocus", "1600x1000", 120_000)) as unknown as { refocus: { newer: { onSend: string; moved: string; sends: number; pop: Pop }; gone: { again: string; focus: string; pop: Pop } } }).refocus;
    // Send reached by keys; Reviewer finishes again; Enter just after: the keyboard had left Send, nothing is sent
    expect(r.newer).toMatchObject({ onSend: "Send", moved: "popover", sends: 0 });
    expect(r.newer.pop).toMatchObject({ face: "ready", body: "1. NEWER: not read yet.", whys: ["Reviewer finished again: this is what it sends now."], buttons: ["Send", "Not yet"] });
    // Send reached again, and what waited sent from elsewhere: Send goes with the face, the keyboard stays in the popover
    expect(r.gone).toMatchObject({ again: "Send", focus: "popover", pop: { face: "settings", kind: "feedback loop · sent" } });
  }, 150_000);

  it("holds a Send reached by keys as it comes up under One more round, and sends from keys after a pause", async () => {
    const r = ((await audit("lsGates=limit&lsCamera=0,3040,1&landscapeWiresAudit=limitkeys", "1600x1000", 120_000)) as unknown as { limitkeys: { onMore: string; burst: { sends: number; moreRounds: number; focus: string; pop: Pop }; onSend: string; sends: number; pop: Pop | null } }).limitkeys;
    expect(r.onMore).toBe("One more round");
    // Enter on One more round, then Tab Tab Enter straight on: the Send that just came up is held, and shown off
    expect(r.burst).toMatchObject({ sends: 0, moreRounds: 1, focus: "popover", pop: { face: "ready", kind: "feedback loop · round 4 of 4", buttons: ["off Send", "Not yet"] } });
    expect(r).toMatchObject({ onSend: "Send", sends: 1, pop: null });
  }, 150_000);

  it("takes no burst begun before it opened, a Shift in it too", async () => {
    const r = ((await audit("lsCamera=0,3040,1&landscapeWiresAudit=shift", "1600x1000", 120_000)) as unknown as { shift: { sends: number; writes: number; pop: Pop } }).shift;
    expect(r).toMatchObject({ sends: 0, writes: 1, pop: { face: "ready", hint: "Keys typed just before this opened don't press anything here: pause, then go on." } });
  }, 150_000);

  it("leaves the cost question unanswered by an Enter held on Send, and says so when Esc answers it", async () => {
    const r = ((await audit("lsGates&lsBigResume=wb-spike&lsCamera=0,3040,1&landscapeWiresAudit=costrepeat", "1600x1000", 120_000)) as unknown as {
      costrepeat: { onSend: string; asked: { dialog: boolean; focus: string }; held: { dialog: boolean; hint: string | null; sends: number }; sends: Sends; resumeCost: number; dialog: boolean; pop: Pop };
    }).costrepeat;
    expect(r.onSend).toBe("Send");
    expect(r.asked).toEqual({ dialog: true, focus: "Continue" });
    expect(r.held).toEqual({ dialog: true, hint: "Keys typed just before this opened don't press anything here: pause, then go on.", sends: 1 });
    // the one send was main's first, which asked about starting Spike: none went with { start: true }
    expect(r.sends.map((x) => x[3])).toEqual([null]);
    expect(r).toMatchObject({ resumeCost: 1, dialog: false, pop: { face: "ready", err: "Nothing was sent: “Spike: streaming” stays as it is.", keyboard: true } });
  }, 150_000);

  it("stays open while its cost is asked, says a refusal that comes once it has closed, and closes no other popover", async () => {
    const l = ((await audit("lsGates&lsBigResume=wb-spike&lsCamera=0,3040,1&landscapeWiresAudit=costlost", "1600x1000", 120_000)) as unknown as {
      costlost: { asked: { dialog: boolean; pop: boolean }; answered: { dialog: boolean; pop: Pop }; sends: Sends; pop: Pop; note: string | null };
    }).costlost;
    // a press on Continue is the question's: the popover stays, shows the newer finish, and says why main refused the earlier
    expect(l.asked).toEqual({ dialog: true, pop: true });
    expect(l.answered.pop).toMatchObject({ body: "Newer fixtures: 41k donors.", buttons: ["off Sending…", "Not yet"] });
    expect(l.sends.map((x) => [x[1], x[3]])).toEqual([["pd-fixtures", null], ["pd-fixtures", { start: true }]]);
    expect(l.pop).toMatchObject({ face: "ready", body: "Newer fixtures: 41k donors.", buttons: ["Send", "Not yet"], err: "What was waiting there has been replaced by something newer: send that instead." });
    const o = ((await audit("lsGates&lsBigResume=wb-spike&lsCamera=0,3040,1&landscapeWiresAudit=closeother", "1600x1000", 120_000)) as unknown as { closeother: { opened: string; after: string; sends: Sends; note: string | null } }).closeother;
    // Spike's popover closed for Tester's while its send ran: Tester's stays, and the refusal goes to the note
    expect(o).toMatchObject({ opened: "Reviewer → Tester", after: "Reviewer → Tester" });
    expect(o.sends).toHaveLength(2);
    expect(o.note).toBe("Fixtures → Spike: streaming: What was waiting there has been replaced by something newer: send that instead.");
  }, 250_000);
});

// ---- W8: Add next step and not-started workspaces (?landscapeWiresAudit=step, with ?lsPlanned) ----
type Card = { rows: string[]; buttons: number; line: string | null; status: string | null } | null;
interface Step {
  card: Card;
  cardMenu: string[] | null;
  burst: { opened: { dialog: boolean; head: string | null; name: string | null; focused: boolean; works: string[] }; early: { on: number; dialog: boolean }; writes: unknown[] };
  added: { filled: { on: number; name: string | null; note: string | null }; plan: Call[]; dialog: boolean; made: string | null; card: Card; wires: string[][]; note: string | null };
  dropped: { space: boolean; drop: Pt; dialog: boolean; head: string | null; picker: Shown; plan: Call[]; made: string | null; at: Pt | null; area: string | null; card: Card; wires: string[][] };
  stepSend: { opened: { face: string; ends: string; whys: string[]; body: string; buttons: string[] } | null; sends: unknown[][]; cost: number; pop: boolean; ghost: boolean; node: boolean; delivery: string | null };
  double: { dialog: boolean; under: string | null; closed: boolean };
  terminal: { dialog: boolean; note: string | null; plan: Call[] };
  started: { start: Call[]; ghost: boolean; node: boolean };
}

describe.skipIf(!local)("Add next step", () => {
  it("a not-started step's card and menu; a step added from a handle clicked and one dragged into space, its dialog taking no burst's key nor an early click; refused after a terminal; Start now", async () => {
    const s = (await audit("lsCamera=0,3040,1&lsPlanned&landscapeWiresAudit=step", "1600x1200", 150_000)) as unknown as Step;
    // Tester, as Inbox.dc.html draws it: no buttons, what starts it in place of a last line, where it will work as its foot
    expect(s.card).toEqual({ rows: ["head", "line", "foot"], buttons: 0, line: "Not started. Starts when Reviewer approves.", status: "backoffice · new worktree" });
    expect(s.cardMenu).toContain("Start now");
    expect(s.cardMenu).toContain("Forget it");
    expect(s.cardMenu!.some((r) => /Reopen/.test(r))).toBe(false);
    // Reviewer's handle clicked mid-burst: the dialog opens for a step after Reviewer, the burst's key and an early click untaken
    expect(s.burst.opened).toMatchObject({ dialog: true, name: "", focused: true, works: ["Its own folder", "Reviewer's folder"] });
    expect(s.burst.opened.head).toMatch(/^Next step.*after Reviewer/);
    expect(s.burst.early).toEqual({ on: 0, dialog: true });
    expect(s.burst.writes).toEqual(["wb-builder"]);
    // settled: Reviewer's folder, named, added; a not-started card after Reviewer, joined by a handoff
    expect(s.added.filled).toMatchObject({ on: 1, name: "qa" });
    expect(s.added.plan).toEqual([[expect.objectContaining({ after: "wb-reviewer", title: "qa", sharesFolder: true, taskGroup: "5120" })]]);
    expect(s.added.dialog).toBe(false);
    expect(s.added.made).toBeTruthy();
    // (Reviewer last finished with "changes", its feedback loop to Builder out: a handoff from it waits for its approve)
    expect(s.added.card).toMatchObject({ buttons: 0, line: "Not started. Starts when Reviewer approves.", status: "in Reviewer's folder" });
    expect(s.added.wires).toEqual([["wb-reviewer", "handoff"]]);
    expect(s.added.note).toBe("Added qa after Reviewer: it starts when Reviewer's handoff is sent, or with Start now in its menu");
    // dragged into the canvas under 5120: no picker, the dialog, and the step in no area, where it was let go
    expect(s.dropped).toMatchObject({ space: true, dialog: true, picker: null, area: "ungrouped" });
    expect(s.dropped.plan).toEqual([[expect.objectContaining({ after: "wb-shape", title: "docs", taskGroup: null })]]);
    expect(s.dropped.wires).toEqual([["wb-shape", "handoff"]]);
    expect(s.dropped.card).toMatchObject({ line: "Not started. Starts when Shape donor export hands off.", status: "backoffice · new worktree" });
    near(s.dropped.at!.x, s.dropped.drop.x, 8);
    near(s.dropped.at!.y, s.dropped.drop.y, 8);
    // Shape finished: the handoff's popover says sending starts the step; Send starts it, asking no cost, and sends what it showed
    expect(s.stepSend.opened).toMatchObject({ face: "ready", ends: "Shape donor export → docs", body: "The export streams now: test it against 40k donors.", buttons: ["Send", "Not yet"] });
    expect(s.stepSend.opened!.whys).toContain("“docs” hasn't started: sending starts it.");
    expect(s.stepSend.sends).toEqual([["The export streams now: test it against 40k donors.", null]]);
    expect(s.stepSend).toMatchObject({ cost: 0, pop: false, ghost: false, node: true });
    expect(["queued", "sent"]).toContain(s.stepSend.delivery);
    // a double click on a handle: its second press, on the backdrop, doesn't close what its first opened
    expect(s.double).toEqual({ dialog: true, under: "modal-back", closed: true });
    // a terminal's handle: said, no dialog, nothing made
    expect(s.terminal).toEqual({ dialog: false, note: "No step can follow Dev server: “Dev server” is a terminal: only a shared worktree wire can reach one.", plan: [] });
    // Start now: started under its id, a workspace where its card was
    expect(s.started).toEqual({ start: [["wb-tester"]], ghost: false, node: true });
  }, 200_000);
});
