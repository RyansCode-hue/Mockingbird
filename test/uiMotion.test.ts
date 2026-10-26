import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { D } from "../src/renderer/motion";
import { tempDir } from "./helpers";

// Motion, played in the UI preview in real headless Chrome: local only (CI runners have no desktop); the script
// passes a mock keychain. ?motionAudit (src/preview/stub.ts) minimizes a workspace into its folder and restores
// it, opens and closes a dialog, and shows and dismisses a toast, finishing each animation instead of waiting on
// real time, and reports the end states: tests read those, never frames caught in flight.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type State = { folderOpen: boolean; cells: string[]; ghosts: number; holding: number; named: number };
type Audit = {
  before: State;
  inFlight: State & { move: string | null; images: { cell: string; same: boolean; oldOpacity: string; newAnimation: string }[] };
  minimized: State;
  lidOpening: State;
  restored: State;
  dialogOpen: number;
  dialogClosing: { real: number; ghosts: number };
  dialogClosed: State;
  toastGone: State & { toasts: number };
  waitingPulse: string | null;
  transitions: number;
  longest: number;
  mode: string;
};

async function audit(motion: "full" | "reduce"): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query: `motion=${motion}&motionAudit`, outDir: path.join(tempDir("motion"), "out"), read: `document.getElementById("mb-motion-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its motion audit");
  return JSON.parse(json);
}

const settled = (s: State) => {
  expect(s.ghosts).toBe(0); // no exit copies left behind
  expect(s.holding).toBe(0); // no animation left holding a frame (a stuck fill)
  expect(s.named).toBe(0); // no View Transition names left on panes
};

describe.skipIf(!local)("the interface's motion", () => {
  it("minimizes a workspace into its open folder, closing the lid after, and restores it out of the opened folder", async () => {
    const a = await audit("full");
    expect(a.mode).toBe("full");
    const ws = "ws:5101/api";
    expect(a.before.folderOpen).toBe(true);
    expect(a.before.cells).toContain(ws);
    // in flight: the pane has left the grid and the folder is still open for it
    expect(a.inFlight.move).toBe("minimize");
    expect(a.inFlight.cells).not.toContain(ws);
    expect(a.inFlight.folderOpen).toBe(true);
    // the pane keeping its size shows only its live terminal, never its stale snapshot faded across it; the
    // resized one cross-fades, as its text reflows
    expect(a.inFlight.images).toContainEqual({ cell: "s1", same: true, oldOpacity: "0", newAnimation: "none" });
    expect(a.inFlight.images.find((i) => i.cell === "s4")).toMatchObject({ same: false, newAnimation: expect.stringContaining("fade-in") });
    // landed: the lid has closed
    expect(a.minimized.folderOpen).toBe(false);
    settled(a.minimized);
    // restoring: the lid opens first, with the pane not yet back
    expect(a.lidOpening.folderOpen).toBe(true);
    expect(a.lidOpening.cells).not.toContain(ws);
    expect(a.restored.cells).toContain(ws);
    expect(a.restored.folderOpen).toBe(true);
    settled(a.restored);
    expect(a.transitions).toBeGreaterThanOrEqual(2);
    // a dialog closes at once; its exit plays on a copy that then goes
    expect(a.dialogOpen).toBe(1);
    expect(a.dialogClosing).toEqual({ real: 0, ghosts: 1 });
    settled(a.dialogClosed);
    expect(a.toastGone.toasts).toBe(0);
    settled(a.toastGone);
    // the genie is the longest animation there is
    expect(a.longest).toBeLessThanOrEqual(D.genie);
  }, 120_000);

  it("under reduce, runs no View Transitions, only fades of 120 ms or less, and no waiting pulse", async () => {
    const a = await audit("reduce");
    expect(a.mode).toBe("reduce");
    expect(a.transitions).toBe(0);
    expect(a.longest).toBeLessThanOrEqual(120);
    expect(a.minimized.folderOpen).toBe(false);
    expect(a.restored.cells).toContain("ws:5101/api");
    expect(a.restored.folderOpen).toBe(true);
    for (const s of [a.minimized, a.restored, a.dialogClosed, a.toastGone]) settled(s);
    expect(a.waitingPulse).toBe("none");
  }, 120_000);
});

// ?motionMoments (src/preview/stub.ts) plays the second round's moments and logs every animation started: what it
// moved, its properties and duration. The checks read that log and the end states, never frames in flight.
type Started = { what: string; pseudo: string | null; props: string[]; ms: number };
type Left = { ghosts: number; holding: number; running: number };
type Moments = {
  error?: string;
  mode: string;
  barsOpened: { started: number; drawn: number[] };
  barsTick: { started: Started[] };
  barsChanged: Left & { started: Started[]; drawn: number[] };
  samOnline: Left & { started: Started[]; ghostBadges: number; badge: string | null };
  samOffline: Left & { started: Started[]; badge: string | null };
  history: { entries: number; started: Started[] };
  memberOnline: Left & { started: Started[] };
  arrival: Left & { id: string; started: Started[]; opacity: string | null; transform: string | null };
  own: { sent: boolean; started: Started[] };
  burst: { started: Started[] };
  handedOver: Left & { started: Started[]; note: boolean };
  tookOver: Left & { started: Started[] };
  terminal: number;
  props: string[];
  longest: number;
  total: number;
};

async function moments(motion: "full" | "reduce" | "off"): Promise<Moments> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query: `motion=${motion}&motionMoments`, outDir: path.join(tempDir("moments"), "out"), read: `document.getElementById("mb-motion-moments")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish playing the motion moments");
  const m: Moments = JSON.parse(json);
  expect(m.error).toBeUndefined();
  return m;
}

const clean = (l: Left) => expect({ ghosts: l.ghosts, holding: l.holding, running: l.running }).toEqual({ ghosts: 0, holding: 0, running: 0 });
const names = (s: Started[]) => s.map((x) => (x.pseudo ? `${x.what}${x.pseudo}` : x.what));
const SAM = "5a5a5a5a6b6b6b6b7c7c7c7c8d8d8d8d";

/** What every mode lands on, however much moved getting there. */
function landed(m: Moments) {
  // the context bar (s1: 520k of 1M) and the 5-hour limit (64%) at their new values
  expect(m.barsChanged.drawn[0]).toBeCloseTo(52, 0);
  expect(m.barsChanged.drawn[1]).toBeCloseTo(64, 0);
  expect(m.samOnline.badge).not.toContain("away");
  expect(m.samOffline.badge).toContain("away");
  expect(m.own.sent).toBe(true);
  expect(m.handedOver.note).toBe(true);
  for (const l of [m.barsChanged, m.samOnline, m.samOffline, m.memberOnline, m.arrival, m.handedOver, m.tookOver]) clean(l);
  // nothing ever moves a terminal or a pane itself, or any property but transform and opacity
  expect(m.terminal).toBe(0);
  for (const p of m.props) expect(["opacity", "transform"]).toContain(p);
  // history, your own message, a burst of catching up, and a report or poll that changed nothing start nothing
  expect(m.barsOpened.started).toBe(0);
  expect(m.barsTick.started).toEqual([]);
  expect(m.history.entries).toBeGreaterThan(3);
  expect(m.history.started).toEqual([]);
  expect(m.own.started).toEqual([]);
  expect(m.burst.started).toEqual([]);
}

describe.skipIf(!local)("the interface's motion, round two", () => {
  it("springs bars only on a real change, turns presence, slides a teammate's message in, and pulses a pane that changed hands", async () => {
    const m = await moments("full");
    expect(m.mode).toBe("full");
    landed(m);
    // bars: both spring by transform, from their old width
    expect(names(m.barsChanged.started).sort()).toEqual(["bar:context", "bar:usage"]);
    for (const s of m.barsChanged.started) expect(s.props).toEqual(["transform"]);
    // Sam connecting: the Connected line's dot grows in, his owner badge crossfades (old copy out, new in)
    expect(names(m.samOnline.started)).toEqual(expect.arrayContaining(["connected::before", "connected", "badge", "badge:old"]));
    expect(m.samOnline.ghostBadges).toBe(1);
    expect(names(m.samOffline.started)).toEqual(expect.arrayContaining(["connected::before", "badge", "badge:old"]));
    // ...and in the room's chat, his initials turn and his name eases in
    expect(names(m.memberOnline.started).sort()).toEqual([`dot:${SAM}`, `member:${SAM}`]);
    // Nick's message slides up and fades in, and ends in place
    expect(m.arrival.started).toEqual([{ what: `chat:${m.arrival.id}`, pseudo: null, props: ["opacity", "transform"], ms: 300 }]);
    expect(m.arrival).toMatchObject({ opacity: "1", transform: "none" });
    // handed over: s1's ring pulses once (its ::after, over the terminal) and the note eases in; s4, taken over here, pulses
    expect(names(m.handedOver.started).sort()).toEqual(["note:s1", "pane:s1::after"]);
    expect(names(m.tookOver.started)).toEqual(["pane:s4::after"]);
    expect(m.longest).toBeLessThanOrEqual(D.genie);
  }, 120_000);

  it("under reduce, only fades of 120 ms or less: bars land, and a hand-over only fades its note in", async () => {
    const m = await moments("reduce");
    expect(m.mode).toBe("reduce");
    landed(m);
    expect(m.barsChanged.started).toEqual([]);
    expect(m.props).toEqual(["opacity"]);
    expect(m.longest).toBeLessThanOrEqual(120);
    expect(names(m.arrival.started)).toEqual([`chat:${m.arrival.id}`]);
    expect(names(m.handedOver.started)).toEqual(["note:s1"]);
    expect(m.tookOver.started).toEqual([]);
  }, 120_000);

  it("with motion off, nothing animates and everything lands", async () => {
    const m = await moments("off");
    expect(m.mode).toBe("off");
    landed(m);
    expect(m.total).toBe(0);
  }, 120_000);
});
