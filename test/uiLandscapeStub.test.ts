import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { overlaps, parseLandscape, stackKeyOf, type LandscapeChange, type LandscapeState, type Rect } from "../src/shared/landscape";
import { tempDir } from "./helpers";

// The UI preview's landscape (src/preview/stub.ts), read in real headless Chrome through window.mb as the
// renderer will: local only (CI runners have no desktop); the script passes a mock keychain.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

interface Probe {
  got: LandscapeState;
  updated: LandscapeState | { error: string };
  refused: LandscapeState | { error: string };
  changes: LandscapeChange[];
}

async function probe(query = ""): Promise<Probe> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  // polled until it answers: the stub's window.mb may not be there on the first poll, and a probe started without it would never answer
  const read = `(() => {
    if (!window.mb?.landscapeGet) return null;
    window.__lsProbe ??= (async () => {
      const changes = [];
      window.mb.onLandscapeChanged((c) => changes.push(c));
      const got = await window.mb.landscapeGet();
      const updated = await window.mb.landscapeUpdate({ areas: { "5101": { collapsed: true } } });
      const refused = await window.mb.landscapeUpdate({ areas: { "9999": { collapsed: true } } });
      window.__lsResult = JSON.stringify({ got, updated, refused, changes });
    })();
    return window.__lsResult ?? null;
  })()`;
  const json: string | null = await pageResult({ size: "1400x900", query, outDir: path.join(tempDir("landscape-ui"), "out"), read });
  if (!json) throw new Error("the preview didn't answer landscape:get");
  return JSON.parse(json);
}

const inside = (a: Rect, r: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;

describe.skipIf(!local)("the UI preview's landscape", () => {
  it("has three areas, one holding a stack and a teammate's session, a ghost and a loose workspace, and takes patches as main does", async () => {
    const { got, updated, refused, changes } = await probe();
    expect(parseLandscape(got.landscape)).toEqual(got.landscape);
    expect([got.rev, got.problems]).toEqual([0, []]);
    const l = got.landscape;
    expect(Object.keys(l.areas)).toEqual(["5101", "5102", "5110"]);
    expect(stackKeyOf({ taskGroup: "5101/api" })).toBe("5101/api");
    expect(inside(l.areas["5101"], l.stacks["5101/api"].placement)).toBe(true);
    const remote = Object.keys(l.workspaces).filter((id) => id.startsWith("r~"));
    expect(remote.some((id) => inside(l.areas["5101"], l.workspaces[id]))).toBe(true);
    expect(remote.some((id) => inside(l.areas["5110"], l.workspaces[id]))).toBe(true);
    expect(Object.values(l.ghosts).map((g) => g.group)).toEqual(["5102"]);
    expect(inside(l.areas["5102"], Object.values(l.ghosts)[0].placement)).toBe(true);
    expect(Object.values(l.areas).some((a) => overlaps(a, l.workspaces.s7))).toBe(false);
    const all = [...Object.values(l.workspaces), ...Object.values(l.stacks).map((s) => s.placement), ...Object.values(l.ghosts).map((g) => g.placement)];
    all.forEach((a, i) => all.forEach((b, j) => i < j && expect(overlaps(a, b)).toBe(false)));

    expect(updated).toMatchObject({ rev: 1, landscape: { areas: { "5101": { collapsed: true } } } });
    expect(refused).toEqual({ error: expect.stringContaining('areas["9999"] isn\'t on the landscape') });
    expect(changes).toEqual([{ rev: 1, patch: { areas: { "5101": { collapsed: true } } }, problems: [] }]);
  });

  it("starts over with a banner's problem under ?landscape=corrupt", async () => {
    const { got } = await probe("landscape=corrupt");
    expect(got.landscape.areas).toEqual({});
    expect(got.problems).toEqual([expect.objectContaining({ kind: "corrupt", movedTo: expect.stringMatching(/landscape\.json\.bad-\d+$/) })]);
  });
});
