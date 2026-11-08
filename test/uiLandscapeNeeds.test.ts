import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Needs you and the cards' badges (S7) in the UI preview, in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?landscapeNeedsAudit (src/preview/needsYouAudit.ts) works the tray, N,
// Dismiss and Go there as a person would (=a), and reads the badges as drawn at a zoom (=b).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Act = { key: string | null; label: string | null; disabled: boolean; title: string };
type Item = { id: string | null; kind: string | null; on: boolean; meta: string | null; text: string | null; acts: Act[] };
type Tray = { open: boolean; head: string | null; items: Item[]; foot: string | null; none: string | null };
type Button = { on: boolean; count: string | null; title: string | null };
type Step = { shift: boolean; ws: string | null; area: string | null; keyboard: string; moved: boolean; prompt: boolean };
interface TrayAudit {
  button: Button;
  tree: Record<string, string | null>;
  tray: Tray;
  trayKeyboard: string;
  steps: Step[];
  litAfterSteps: string[];
  inTray: { ws: string | null; open: boolean; lit: string[] };
  inField: { before: { ws: string | null; area: string | null }; ws: string | null; area: string | null };
  inTerminal: { textarea: boolean; ws: string | null; keyboard: string; wrote: string[] };
  dismissed: { tray: Tray; button: Button; tree: Record<string, string | null> };
  back: { ids: string[]; button: Button; foot: string | null };
  takenOver: { ids: string[]; button: Button };
  pill: { count: string | null; title: string | null };
  switcher: Record<string, string | null>;
  goPermission: { open: boolean; ws: string | null; terminal: boolean };
  goJoin: { open: boolean; area: string | null; ws: string | null; prompt: string | null };
  goFromTab: { tab: string | null; ws: string | null };
  error?: string;
}
type Badge = { key: string | null; text: string | null; title: string; failed: boolean; shown: boolean; cut: boolean; inCard: boolean; inArea: boolean };
type Ws = {
  id: string;
  mode: string;
  rowClips: boolean | null;
  rowInCard: boolean;
  badges: Badge[];
  did: { text: string | null; title: string; failed: boolean; inCard: boolean; inArea: boolean } | null;
  diffCell: { text: string | null; title: string; failed: boolean; inNode: boolean; inArea: boolean } | null;
};
interface BadgeAudit {
  band: string | null;
  workspaces: Ws[];
  said: string[];
  stale: { before: { text: string | null; title: string } | null; after: { text: string | null; title: string } | null; said: string[]; again: { text: string | null; title: string } | null };
  error?: string;
}

/** The preview's audit part, run with `query` (motion off, 1440 × 900). */
async function run<T>(part: string, query: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1440x900",
    query: `labs=landscape&motion=off&landscapeNeedsAudit=${part}&${query}`,
    outDir: path.join(tempDir(`needs-${part}`), "out"),
    read: `document.getElementById("mb-landscape-needs-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish part ${part}`);
  return JSON.parse(json);
}

/** Every badge drawn stays inside its workspace and its area; one that didn't fit isn't drawn (its row clips it). */
function expectContained(workspaces: Ws[]) {
  for (const w of workspaces) {
    for (const b of w.badges) {
      if (b.shown) expect({ id: w.id, badge: b.key, inCard: b.inCard, inArea: b.inArea }).toEqual({ id: w.id, badge: b.key, inCard: true, inArea: true });
      else expect({ id: w.id, badge: b.key, clipped: w.rowClips }).toEqual({ id: w.id, badge: b.key, clipped: true });
    }
    if (w.badges.length) expect({ id: w.id, rowInCard: w.rowInCard }).toEqual({ id: w.id, rowInCard: true });
    if (w.did) expect({ id: w.id, did: [w.did.inCard, w.did.inArea] }).toEqual({ id: w.id, did: [true, true] });
    if (w.diffCell) expect({ id: w.id, diffCell: [w.diffCell.inNode, w.diffCell.inArea] }).toEqual({ id: w.id, diffCell: [true, true] });
  }
}

describe.skipIf(!local)("Needs you (S7)", () => {
  it("lists what waits on you, moves the view with N, dismisses until a state changes, and goes there", async () => {
    const a = await run<TrayAudit>("a", "joinRequest=later&lsCamera=0,0,0.5");
    expect(a.error).toBeUndefined();

    // the button and the tray: s2's permission prompt, Lee's join request, then s8 finished; teammates' never
    expect(a.button).toMatchObject({ on: true, count: "3" });
    expect(a.tray.open).toBe(true);
    expect(a.tray.head).toBe("Needs youN next · ⇧N back");
    expect(a.tray.items.map((i) => [i.kind, i.meta, i.text])).toEqual([
      ["permission", "Permission · #5101", "API: last org per user wants to use Bash"],
      ["join", "Join request · #5101", "Lee Park wants to join #5101 Org dropdowns remember the last org"],
      ["finished", "Finished · #5101", "Release notes for #5101 is done and idle"],
    ]);
    for (const i of a.tray.items) expect(i.acts.map((x) => [x.key, x.label, x.disabled])).toEqual([["go", "Go there", false], ["dismiss", "Dismiss", false]]);
    expect(a.trayKeyboard).toBe("tray");
    // each area's count is its items: the tree, a collapsed area's pill and the switcher agree
    expect(a.tree).toMatchObject({ "5101": "3", "5102": null, "5110": null });
    expect(a.pill).toEqual({ count: "3", title: "3 waiting on you: see Needs you" });
    expect(a.switcher).toMatchObject({ "5101": "3", "5102": null });

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
    // the view moves to an item out of sight (one already in view is left where it is)
    expect(a.steps.some((s) => s.moved)).toBe(true);
    expect(a.litAfterSteps).toEqual(["s:s8"]);
    // N in the tray moves on, the tray kept open with its new place lit
    expect(a.inTray).toEqual({ ws: "s2", open: true, lit: ["s:s2"] });
    // never in a text field or a terminal: there the key is the field's or the program's
    expect(a.inField).toEqual({ before: a.inField.before, ws: a.inField.before.ws, area: a.inField.before.area });
    expect(a.inTerminal).toEqual({ textarea: true, ws: "s1", keyboard: "terminal", wrote: ["n"] });

    // Dismiss: off the list and the counts, said in the tray's foot, back when its state changes
    expect(a.dismissed.tray.items.map((i) => i.id)).not.toContain("s:s8");
    expect(a.dismissed.tray.foot).toBe("1 item dismissed");
    expect(a.dismissed.button.count).toBe("2");
    expect(a.dismissed.tree["5101"]).toBe("2");
    expect(a.back.ids).toContain("s:s8");
    expect(a.back.button.count).toBe("3");
    expect(a.back.foot).toBeNull();
    // a copy a teammate took over leaves it
    expect(a.takenOver.ids).not.toContain("s:s8");
    expect(a.takenOver.button.count).toBe("2");

    // Go there: the workspace selected with its terminal's keyboard; a join request's area and its prompt; from
    // another tab, back on the landscape
    expect(a.goPermission).toEqual({ open: false, ws: "s2", terminal: true });
    expect(a.goJoin).toEqual({ open: false, area: "5101", ws: null, prompt: "Lee Park wants to join #5101 Org dropdowns remember the last org" });
    expect(a.goFromTab).toEqual({ tab: "Sessions", ws: "s8" });
  });

  it("draws the cards' badges inside their cards and areas at 15%, with what each source says", async () => {
    const b = await run<BadgeAudit>("b", "lsCamera=-200,-300,0.15");
    expect(b.error).toBeUndefined();
    expect(b.band).toBe("cards");
    const s1 = b.workspaces.find((w) => w.id === "s1")!;
    expect(s1.mode).toBe("card");
    expect(s1.badges.map((x) => [x.key, x.text])).toEqual([["diff", "+214 −38"], ["pr", "PR #88"], ["cost", "22M · 14%"]]);
    expect(s1.badges[0]).toMatchObject({ shown: true, cut: false });
    expect(s1.did).toMatchObject({ text: "I'll store the choice per user and preselect it.", failed: false });
    const s5 = b.workspaces.find((w) => w.id === "s5")!;
    expect(s5.badges.map((x) => [x.key, x.text, x.shown])).toEqual([["diff", "+12 −4", true], ["cost", "9.6M · 3.1%", true]]);
    // a terminal has no transcript, a teammate's session no folder or meter here
    expect(b.workspaces.find((w) => w.id === "s4")!.did).toBeNull();
    expect(b.workspaces.find((w) => w.id.startsWith("r~"))!.badges).toEqual([]);
    expectContained(b.workspaces);
    // the source failing: "—" with the reason, said in the console; read again, the value
    expect(b.stale.before?.text).toBe("+214 −38");
    expect(b.stale.after).toEqual({ text: "—", title: "Couldn't read its changes against its base: git merge-base: fatal: Not a valid object name origin/dev" });
    expect(b.stale.said).toEqual(["[mockingbird] a landscape card couldn't read its changes against its base for s1: git merge-base: fatal: Not a valid object name origin/dev"]);
    expect(b.stale.again?.text).toBe("+214 −38");
  });

  it("draws them inside at the fit's zoom and as the workspace footer's diff at 50% and 100%", async () => {
    const fit = await run<BadgeAudit>("b", "lsCamera=-40,-60,0.18");
    expect(fit.error).toBeUndefined();
    const s1 = fit.workspaces.find((w) => w.id === "s1")!;
    // at the fit's zoom all three fit beside each other
    expect(s1.badges.map((x) => [x.key, x.shown])).toEqual([["diff", true], ["pr", true], ["cost", true]]);
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

  it("shows — for every badge whose source fails, says why on hover and in the console, and never a value read before", async () => {
    const b = await run<BadgeAudit>("b", "badgeFail=diff,pr,reply,meters&lsCamera=-40,-60,0.18");
    expect(b.error).toBeUndefined();
    const s1 = b.workspaces.find((w) => w.id === "s1")!;
    expect(s1.badges.map((x) => [x.key, x.text, x.failed])).toEqual([["diff", "—", true], ["pr", "—", true], ["cost", "—", true]]);
    expect(s1.badges.map((x) => x.title)).toEqual([
      "Couldn't read its changes against its base: git merge-base: fatal: Not a valid object name origin/dev",
      "Couldn't read the ticket pipelines: ~/.mockingbird/pipeline.json: EACCES: permission denied",
      "Couldn't read the token meters: transcripts:sync: SQLITE_BUSY: database is locked",
    ]);
    expect(s1.did).toMatchObject({ text: "—", failed: true, title: "Couldn't read what it last said: the conversation index isn't available (SQLITE_CANTOPEN: unable to open database file)" });
    expectContained(b.workspaces);
    expect(b.said).toEqual(
      expect.arrayContaining([
        expect.stringContaining("a landscape card couldn't read its changes against its base for s1: git merge-base"),
        expect.stringContaining("a landscape card couldn't read what it last said for s1: the conversation index isn't available"),
        expect.stringContaining("Couldn't read the ticket pipelines: ~/.mockingbird/pipeline.json: EACCES"),
        expect.stringContaining("couldn't read the token meters"),
      ])
    );
  });
});
