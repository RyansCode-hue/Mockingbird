import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The landscape's areas (S4) in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. ?landscapeAreasAudit (src/preview/stub.ts) works areas as a person would — the tree,
// collapsing, a marquee, drags, locking, renaming, the switcher, Members ▾ — and reports what each step left once it
// settled, with the calls each made to the main process (window.__mbCalls); never frames caught in flight.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

const NICK = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const ROOM = "R5101aaaaaaaaaaaaaaaaa";
const N1 = "r~0f1e2d3c4b5a~n1";
const N7 = "r~0f1e2d3c4b5a~n7";

type Change = { fn: string; args: unknown[] };
type Call = { fn: string; args: unknown[] } | null;
/** The minimap's areas' keys, its loose workspaces' keys, its dots, and how many marks it has but the view. */
type Minimap = { areas: string[]; loose: string[]; dots: number | null; marks: number | null };
interface Audit {
  tree: { key: string; title: string | null; waiting: string | null; count: string | null; online: string[]; rows: string[] }[];
  atFit: { streams: string[] };
  minimap: Minimap;
  flyTree: { inView: boolean; centred: boolean; streams: string[] };
  collapse: { stored: boolean; pill: string | null; hidden: string[]; streams: string[]; tree: string | null };
  expand: { stored: boolean; hidden: number; streams: string[] };
  switcherLoose: { last: { area: string | null; text: string | null } | null; on: string | null; centred: boolean; clearOfIt: boolean };
  make: { during: { marquee: boolean; picked: string[] }; bar: string | null; dialog: string | null; changes: Change[]; area: unknown; inside: boolean; group: string | null; drawn: boolean; cleared: boolean; apart: boolean; minimap: Minimap };
  dragIn: { hot: boolean; changes: Change[]; inside: boolean; group: string | null; translate: string | null; apart: boolean };
  refused: { note: string | null; changes: Change[]; translate: string | null; group: string | null };
  lock: { stored: boolean; note: string | null; changes: Change[]; translate: string | null; locked: boolean; unlocked: boolean };
  rename: { items: string[]; changes: string[]; same: boolean; gone: boolean; drawn: boolean; s5: boolean; apart: boolean };
  remoteLands: { saved: boolean; inside: boolean; drawn: boolean; apart: boolean };
  areaMove: { moved: boolean; withIt: boolean; onGrid: boolean; apart: boolean; translate: string | null };
  switcher: { tree: boolean; areas: string[]; on: string | null; centred: boolean; clearOfIt: boolean; back: boolean };
  members: { rows: { id: string; role: string | null; presence: string | null }[]; buttons: string[]; lines: string[]; fromMenu: Call; fromRoomView: Call; handOver: Call; leave: Call; roomGone: boolean };
  error?: string;
}

async function audit(): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1400x900",
    query: "motion=off&landscapeAreasAudit",
    outDir: path.join(tempDir("ls-areas"), "out"),
    read: `document.getElementById("mb-landscape-areas-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error("the preview didn't finish its areas audit");
  return JSON.parse(json);
}

describe.skipIf(!local)("the landscape's areas", () => {
  it("are worked as a person would: tree, collapse, marquee, drags, lock, rename, a teammate's session, the switcher and Members ▾", async () => {
    const a = await audit();
    expect(a.error).toBeUndefined();

    // the area tree: the areas in the landscape's order, waiting counts, who's online in a room's, loose last
    expect(a.tree.map((t) => t.key)).toEqual(["5101", "5102", "5110", "ungrouped"]);
    expect(a.tree[0]).toMatchObject({ title: "#5101 Org dropdowns remember the last org", waiting: "2", online: ["N"] });
    // a stack once, its front tab's row; a teammate's workspace too
    expect(a.tree[0].rows).toEqual(["s1", "s2", "s4", "s8", N1]);
    expect(a.tree[1]).toMatchObject({ count: "2", rows: ["s5", "s6"], online: [] });
    expect(a.tree[2].rows).toEqual(["y1", N7]);
    expect(a.tree[3]).toMatchObject({ title: "Loose", count: "1", rows: [] });

    // the minimap: a block per area, one for the loose assistant and one for the loose closed session's ghost; no dots,
    // and no mark for a workspace in an area
    expect(a.minimap).toEqual({ areas: ["5101", "5102", "5110"], loose: ["s7", "ghost:p1"], dots: 0, marks: 5 });

    // teammates stream what's on screen: everything at fit, then what the fly to 5110 shows
    expect(a.atFit.streams).toEqual(expect.arrayContaining([N1, N7, "s1", "y1"]));
    expect(a.flyTree.inView).toBe(true);
    expect(a.flyTree.centred).toBe(true);
    expect(a.flyTree.streams).toEqual(expect.arrayContaining(["y1", N7]));
    expect(a.flyTree.streams).not.toContain("s1");

    // collapsed: a pill keeping its counts, its workspaces off screen and not streamed; opened again, back
    expect(a.collapse).toMatchObject({ stored: true, hidden: [N7, "y1"].sort() });
    expect(a.collapse.pill).toContain("2 workspaces");
    expect(a.collapse.streams).not.toContain(N7);
    expect(a.collapse.streams).not.toContain("y1");
    expect(a.collapse.tree).toContain("collapsed");
    expect(a.expand).toMatchObject({ stored: false, hidden: 0 });
    expect(a.expand.streams).toEqual(expect.arrayContaining([N7, "y1"]));

    // with the tree put away, the switcher ends with Loose while a workspace is in none, and goes to it
    expect(a.switcherLoose).toEqual({ last: { area: "ungrouped", text: "Loose" }, on: "ungrouped", centred: true, clearOfIt: true });

    // a marquee round the loose assistant, M, a name: the area's place saved first, then the group set
    expect(a.make.during).toEqual({ marquee: true, picked: ["s7"] });
    expect(a.make.bar).toContain("1 selected");
    expect(a.make.dialog).toBe("Make an area of 1 workspace");
    expect(a.make.changes.map((c) => c.fn)).toEqual(["landscapeUpdate", "setGroup"]);
    expect(a.make.changes[1].args).toEqual(["s7", "Spike"]);
    expect(a.make).toMatchObject({ inside: true, group: "Spike", drawn: true, cleared: true, apart: true });
    // in an area now, the assistant has no block of its own: its area has one (the loose ghost keeps its own)
    expect(a.make.minimap).toEqual({ areas: ["5101", "5102", "5110", "Spike"], loose: ["ghost:p1"], dots: 0, marks: 5 });

    // dragged across 5102's edge: it lights up, the place is saved, then the group set; areas pushed aside stay apart
    expect(a.dragIn.hot).toBe(true);
    expect(a.dragIn.changes.map((c) => c.fn)).toEqual(["landscapeUpdate", "setGroup"]);
    expect(a.dragIn.changes[1].args).toEqual(["s4", "5102"]);
    expect(a.dragIn).toMatchObject({ inside: true, group: "5102", translate: "", apart: true });

    // a teammate's workspace to another area: refused, said, nothing saved, back in place
    expect(a.refused.note).toBe("Nick Smith's workspace moves to another area only on their Mac");
    expect(a.refused).toMatchObject({ changes: [], translate: "", group: "5110" });

    // locked: drawn so, its workspaces don't move (said), and it unlocks
    expect(a.lock).toMatchObject({ stored: true, locked: true, changes: [], translate: "", unlocked: true });
    expect(a.lock.note).toMatch(/is locked: unlock it to move its workspaces$/);

    // renamed from its ⋯: the same place under the new name, its workspaces in it, whichever change came first
    expect(a.rename.items).toEqual(expect.arrayContaining(["Rename…", "Collapse to a pill", "Agent message log…", "Share as a team room…", "New session here…", "Ask for status"]));
    expect(a.rename.changes[0]).toBe("renameGroup");
    expect(a.rename).toMatchObject({ same: true, gone: true, drawn: true, s5: true, apart: true });

    // a teammate's new session in their room lands in its area, and its place is saved
    expect(a.remoteLands).toEqual({ saved: true, inside: true, drawn: true, apart: true });

    // an area dragged by its name moves on the grid with its workspaces, clear of the others
    expect(a.areaMove).toEqual({ moved: true, withIt: true, onGrid: true, apart: true, translate: "" });

    // ⌘\ puts the tree away: the switcher goes to an area, which lands below it; ⌘\ brings the tree back
    expect(a.switcher).toMatchObject({ tree: false, on: "5101", centred: true, clearOfIt: true, back: true });
    expect(a.switcher.areas).toEqual(expect.arrayContaining(["5101", "5110", "Spike", "Pathways"]));
    // the assistant has its own area now: no workspace is loose, so neither is the switcher's last stop
    expect(a.switcher.areas).not.toContain("ungrouped");

    // Members ▾: presence and roles, the room's lines and buttons
    expect(a.members.rows.map((r) => r.role)).toEqual(["owner", "admin", "member"]);
    expect(a.members.rows[1]).toMatchObject({ id: NICK, presence: "online · watching Org dropdowns remember the last org" });
    expect(a.members.rows[2].presence).toMatch(/^offline/);
    expect(a.members.buttons).toEqual(["Invite…", "Follow Nick", "Leave room…"]);
    expect(a.members.lines[0]).toMatch(/^Backups go to teammates/);
    // its actions reach the same room call, with the same room and member, as the room view's own menu
    expect(a.members.fromMenu).toEqual({ fn: "teamSetAdmin", args: [ROOM, NICK, false] });
    expect(a.members.fromRoomView).toEqual({ fn: "teamSetAdmin", args: [ROOM, NICK, true] });
    expect(a.members.handOver).toEqual({ fn: "teamHandOver", args: [ROOM, NICK] });
    expect(a.members.leave).toEqual({ fn: "teamLeaveRoom", args: [ROOM] });
    expect(a.members.roomGone).toBe(true);
  }, 180_000);
});
