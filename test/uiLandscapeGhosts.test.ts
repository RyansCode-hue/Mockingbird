import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Ghosts (S6b) in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the script passes a
// mock keychain. ?landscapeGhostAudit (src/preview/stub.ts) draws the closed sessions' ghosts at zooms through the
// cards band and at 45% and 100%, and measures what each one draws against its place, its area and the other areas.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type R = { x: number; y: number; w: number; h: number };
interface Audit {
  zooms: { zoom: number; band: string | null; ghosts: Record<string, { area: string; rows: string[]; rect: R; kind: boolean; line: string | null }> }[];
  problems: string[];
  error?: string;
}

async function run<T>(query: string, id: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1440x900",
    query: `motion=off&side=closed&lsCamera=-1900,-700,0.15&${query}`,
    outDir: path.join(tempDir(id), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}`);
  return JSON.parse(json);
}

describe.skipIf(!local)("ghosts on the landscape (UI preview)", () => {
  it("draw nothing past their place or their area at any zoom, giving up their last rows first", async () => {
    const a = await run<Audit>("landscapeGhostAudit&lsClosed=y1", "mb-landscape-ghost-audit");
    expect(a.error).toBeUndefined();
    expect(a.problems).toEqual([]);
    expect(a.zooms.map((z) => [z.zoom, z.band])).toEqual([
      [0.1, "ls-band-cards"],
      [0.13, "ls-band-cards"],
      [0.15, "ls-band-cards"],
      [0.2, "ls-band-cards"],
      [0.3, "ls-band-cards"],
      [0.45, "ls-band-readonly"],
      [1, "ls-band-live"],
    ]);
    // every closed session has its ghost at every zoom: p1 loose, g1 in 5102, g2 (its worktree gone) in 5101, and y1,
    // which a teammate continues, in 5110
    for (const z of a.zooms) expect(Object.fromEntries(Object.entries(z.ghosts).map(([id, g]) => [id, g.area]))).toEqual({ p1: "ungrouped", g1: "5102", g2: "5101", y1: "5110" });
    const at = (zoom: number) => a.zooms.find((z) => z.zoom === zoom)!.ghosts;
    // at 100% each shows all its rows: title, its actions under it, its last line, status with ticket and branch
    for (const g of Object.values(at(1))) expect(g.rows).toEqual(["head", "acts", "line", "foot"]);
    // zoomed out to cards the actions outlast the last line: g1, at its area's foot over 5110's name, keeps Reopen at 10%
    expect(at(0.15).g1.rows.slice(0, 2)).toEqual(["head", "acts"]);
    expect(at(0.1).g1.rows.slice(0, 2)).toEqual(["head", "acts"]);
  }, 120_000);

  it("include a step not started yet, drawn as a card with no buttons that keeps inside its place at any zoom", async () => {
    // g1 hasn't started (?lsStep=g1): its card in 5102, among the closed sessions' ghosts
    const a = await run<Audit>("landscapeGhostAudit&lsClosed=y1&lsStep=g1", "mb-landscape-ghost-audit");
    expect(a.error).toBeUndefined();
    expect(a.problems).toEqual([]);
    for (const z of a.zooms) expect(z.ghosts.g1?.area, `at ${z.zoom}`).toBe("5102");
    const at = (zoom: number) => a.zooms.find((z) => z.zoom === zoom)!.ghosts;
    // no actions row: what starts it stands in for a last line, where it will work as its foot
    expect(at(1).g1.rows).toEqual(["head", "line", "foot"]);
    expect(at(0.45).g1.rows).toEqual(["head", "line", "foot"]);
    // zoomed out its line is the short one, leaving room for its foot; the whole sentence at 100%
    expect(at(1).g1.line).toMatch(/^Not started\. /);
    expect(at(0.45).g1.line).toBe("Nothing hands off to it");
    expect(at(0.1).g1.rows[0]).toBe("head");
    expect(at(1).p1.rows).toEqual(["head", "acts", "line", "foot"]);
  }, 120_000);

  it("are left by closing, reopened where they were, started fresh, forgotten and cleared; Previous's actions all kept", async () => {
    type P = { x: number; y: number; h?: number | null };
    const a = await run<{
      foot: { previous: boolean; connected: boolean };
      palette: string[];
      closed: { kill: unknown[][]; ghost: boolean; node: boolean; stored: R; at: P; was: R };
      reopened: { relaunch: unknown[][]; ghost: boolean; node: boolean; nodeAt: P; stored: R };
      fresh: { dialog: boolean; title: string | null; mentions5101: boolean };
      forgot: { menu: string[]; kill: unknown[][]; ghost: boolean; stored: R | null };
      moreZoomedOut: boolean;
      cleared: { menu: string[]; asked: string[]; kill: unknown[][]; ghost: boolean };
      loose: { menu: string[]; relaunch: unknown[][]; ghost: boolean; node: boolean };
      error?: string;
    }>("landscapeGhostLifeAudit", "mb-landscape-ghost-life-audit");
    expect(a.error).toBeUndefined();
    // the area tree's foot has no Previous any more; its Connected line stays
    expect(a.foot).toEqual({ previous: false, connected: true });
    // ⌘K: every ghost at once, as Previous's restore all was
    // (Reopen all counts the two it can reopen: g2's worktree and branch are gone)
    expect(a.palette).toEqual(["Reopen all (2) — closed workspaces, everywhere on the landscape", "Clear ghosts (3)… — closed workspaces, everywhere on the landscape"]);
    // closing leaves it resumable, its ghost where the workspace was
    expect(a.closed).toMatchObject({ kill: [["s4", false]], ghost: true, node: false, stored: a.closed.was });
    expect(a.closed.at).toEqual({ x: a.closed.was.x, y: a.closed.was.y, h: a.closed.was.h });
    // Reopen relaunches it under its id, in the same place
    expect(a.reopened).toMatchObject({ relaunch: [["s4"]], ghost: false, node: true, stored: a.closed.was });
    expect([a.reopened.nodeAt.x, a.reopened.nodeAt.y]).toEqual([a.closed.was.x, a.closed.was.y]);
    // Start fresh, for the one whose worktree is gone: New session, for its area
    expect(a.fresh).toEqual({ dialog: true, title: "New session", mentions5101: true });
    // Forget from its menu, its right-click zoomed out to cards, where it has no ⋯: let go in main, and its place too
    expect(a.moreZoomedOut).toBe(false);
    expect(a.forgot).toEqual({ menu: ["Reopen", "Forget it"], kill: [], forget: [["g1"]], ghost: false, stored: null });
    // the area's Clear ghosts, asked first
    // (its one ghost can't be reopened here, so Reopen all is there, off)
    expect(a.cleared.menu).toEqual(expect.arrayContaining(["Tidy [T]", "# Ghosts", "Reopen all (off)", "Clear ghosts (1)…"]));
    expect(a.cleared).toMatchObject({ asked: ["Forget Spike: org cache? It can't be reopened after."], kill: [["g2", true]], ghost: false });
    // the loose ones' Reopen all, from the tree's Loose row
    expect(a.loose).toEqual({ menu: ["# Ghosts", "Reopen all (1)", "Clear ghosts (1)…"], relaunch: [["p1"]], ghost: false, node: true });
  }, 120_000);
});
