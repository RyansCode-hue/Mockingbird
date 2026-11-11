import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The landscape's wires (W4a) in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. ?landscapeWiresAudit (src/preview/wiresAudit.ts) reads the wires board (?lsWires) as
// drawn, drags Builder and pinches, and reports each step once it has settled.
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

async function audit(query: string, size = "1600x1000"): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size,
    query: `motion=off&lsWires&${query}`,
    outDir: path.join(tempDir("ls-wires"), "out"),
    read: `document.getElementById("mb-landscape-wires-audit")?.textContent ?? null`,
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

  it("are lifted with a dragged area over its patch, on its workspaces, and let down once it's dropped", async () => {
    const a = (await audit("lsCamera=-1200,-600,0.13&landscapeWiresAudit=area")) as unknown as Record<"before" | "during" | "after", { lifted: string[]; builder: Box; sent: { from: Pt; to: Pt } }>;
    expect(a.before.lifted).toEqual(["auto", "5"]);
    expect(a.during.lifted).toEqual(["6", "6"]);
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
