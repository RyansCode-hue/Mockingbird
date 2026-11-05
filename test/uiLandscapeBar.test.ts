import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { STACK_COMING } from "../src/renderer/selectionBarModel";

// The selection bar (S6a) in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. ?landscapeBarAudit (src/preview/stub.ts) selects areas, workspaces and several as a
// person would, zooms, pans, drags, right-clicks and presses Esc, and reports what the bar and the menus showed at each
// step, with the calls each made to the main process (window.__mbCalls).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type R = { x: number; y: number; w: number; h: number };
interface Bar {
  name: string | null;
  status: string | null;
  row: string[];
  row2: string[];
  why: Record<string, string>;
  rect: R;
  inView: boolean;
  inWorld: boolean;
  visible: string;
}
type Over = { zoom: number; band: string | null; bar: Bar; areaW: number; gap: number; left: number };
type Menu = string[] | null;
interface A {
  zooms: Record<"5101" | "5102", Over[]>;
  handlers: { fromButton: unknown[][]; fromMenu: unknown[][]; more: Menu; tools: Menu; onBar: Menu; onArea: Menu };
  board: { boardFromButton: boolean; closed: boolean; boardFromMenu: boolean; stillSelected: string | null };
  slide: { before: R | null; slid: { bar: Bar; areaLeft: number; viewW: number } };
  drag: { during: string | null; after: string | null; name: string | null };
  esc: { menuOpen: boolean; afterFirst: { menu: boolean; bar: boolean; selected: boolean }; afterSecond: { bar: boolean; selected: boolean }; inBar: { bar: boolean; selected: boolean } };
  error?: string;
}
type Dialog = { title: string | null; launch: string | null; mode: string | null; group: string | null; repo: string | null; ticketOpen: boolean };
type Create = { at: { x: number; y: number }; rows: Menu; why: Record<string, string>; selected: string | null; dialog: Dialog; made: { id: string | null; group: string | null; placed: R | null } };
type Files = { windows: number; session: string | null; scope: string | null };
interface B {
  workspace: { ws30: Bar; more: Menu; right: Menu; filesFromBar: Files; closedFiles: number; filesFromMenu: Files; inFocus: { focus: boolean; bar: boolean }; leftFocus: { focus: boolean; bar: string | null }; at100: { band: string | null; bar: boolean; selected: string | null } };
  takenOver: { bar: string | null; rows: Menu; why: Record<string, string> };
  several: { cleared: { bar: string | null; selected: string | null }; three: Bar; onPicked: Menu; onBar: Menu; move: Menu; closeDlg: string | null; closeList: string[]; closeKept: number };
  moved: { groups: (string | null)[]; inside: boolean; bar: boolean; apart: boolean; setGroup: unknown[][]; note: string | null };
  createIn: Create & { area: R & { repos: { path: string }[] }; firstRepo: string | null };
  createLoose: Create;
  createOther: { ticket: Dialog; importing: Dialog };
  error?: string;
}
interface C {
  fold: { viewW: number; folded: Bar; extended: { bar: Bar; stored: string | null }; remembered: Bar; less: { bar: Bar; stored: string | null }; askFromRow2: unknown[][] };
  foldWs: Bar;
  error?: string;
}
interface D {
  cards: { zoom: number; band: string | null; items: { id: string; area: string | null; inside: boolean; overName: string[]; overArea: string[] }[] };
  peek: { peekOpen: boolean; bar: string | null; first: { peek: boolean; bar: string | null }; second: { bar: boolean; selected: boolean } };
  error?: string;
}

/** Part `part` of the preview's bar audit, run with `query` (the landscape fitted, motion off, besides). */
async function run<T>(part: string, query = "", size = "1400x900"): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const id = `mb-landscape-bar-audit-${part}`;
  const json: string | null = await pageResult({
    size,
    query: `labs=landscape&motion=off&landscapeBarAudit=${part}${query ? `&${query}` : ""}`,
    outDir: path.join(tempDir(id), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}`);
  return JSON.parse(json);
}

/** A workspace's menu, as every place that offers it shows it. */
const WORKSPACE_MENU = [
  "# Session", "Rename…", "Mute notifications", "Move to area…", "Size S", "Size M", "Size L",
  "-", "# Tools", "Files [⇧⌘E]", "Changes [⌃⇧G]", "Search [⇧⌘F]", "Run & debug [⇧⌘D]",
  "-", "# Terminal", "Repaint", "Hide the agent's diff panel (off)", "Undo the last turn…",
  "-", "# Hand on", "Continue in Codex…", "Fresh session from a brief…", "Second opinion from Codex",
  "-", "Close…",
];
const CREATE_ROWS = ["# New workspace", "Claude…", "Codex…", "Terminal…", "From a ticket…", "Import…", "Collab… (coming) (off)", "Pipeline from a ticket… (coming) (off)"];
const TAKEN_BACK = /^Nick Smith continues it on their laptop: take it back/;

describe.skipIf(!local)("the selection bar", () => {
  it("floats over an area at screen size at every zoom, with a room's tools only in a room's, running the model's handlers", async () => {
    const a = await run<A>("a");
    expect(a.error).toBeUndefined();

    // 12%, 30%, 60% and 100%: the same size, never in the scaled world, just above the area's name line or header,
    // lined up with its left edge, inside the window
    for (const key of ["5101", "5102"] as const) {
      const zs = a.zooms[key];
      expect(zs.map((z) => z.band), key).toEqual(["ls-band-cards", "ls-band-cards", "ls-band-readonly", "ls-band-live"]);
      zs.forEach((z, i) => expect(z.zoom, key).toBeCloseTo([0.12, 0.3, 0.6, 1][i], 2));
      for (const z of zs) {
        expect(z.bar, `${key} at ${z.zoom}`).toMatchObject({ inWorld: false, inView: true, visible: "visible" });
        expect(z.bar.rect.h, `${key} at ${z.zoom}`).toBe(38);
        expect(z.bar.rect.w, `${key} at ${z.zoom}`).toBe(zs[0].bar.rect.w);
        expect(z.gap, `${key} at ${z.zoom}`).toBeGreaterThanOrEqual(7);
        expect(z.gap, `${key} at ${z.zoom}`).toBeLessThanOrEqual(10);
        expect(z.left, `${key} at ${z.zoom}`).toBe(0);
      }
    }
    const room = a.zooms["5101"][1].bar;
    expect(room).toMatchObject({ name: "#5101", status: "1 waiting · 1 working", row: ["Chat · 2", "Board", "Members ▾", "Follow Nick", "Ask for status", "Tools ▾", "⋯"], row2: [] });
    // an area that isn't a room's: no Chat, Board, Members or Follow; far out its bar, as wide as its buttons, overhangs it
    for (const z of a.zooms["5102"]) expect(z.bar.row).toEqual(["Ask for status", "Tools ▾", "⋯"]);
    expect(a.zooms["5102"][0].bar.rect.w).toBeGreaterThan(a.zooms["5102"][0].areaW);

    // its button and ⋯'s row make the same call; Tools ▾ is the model's tools; the bar's right-click and the area's are ⋯
    expect(a.handlers.fromButton).toEqual([["5102"]]);
    expect(a.handlers.fromMenu).toEqual(a.handlers.fromButton);
    expect(a.handlers.tools).toEqual(["Artifacts"]);
    expect(a.handlers.more).toEqual(expect.arrayContaining(["# Area", "Rename…", "# Tools", "Artifacts", "Share as a team room…", "New session here…", "Ask for status"]));
    expect(a.handlers.more).not.toContain("Chat");
    expect(a.handlers.onBar).toEqual(a.handlers.more);
    expect(a.handlers.onArea).toEqual(a.handlers.more);
    // a room's Board and ⋯'s House board… open the room's board, the area still selected after
    expect(a.board).toEqual({ boardFromButton: true, closed: true, boardFromMenu: true, stillSelected: "#5101" });

    // panned to the window's right edge, it slides along it to stay inside, no longer lined up with its area
    const s = a.slide.slid;
    expect(s.bar.inView).toBe(true);
    expect(s.bar.rect.x + s.bar.rect.w).toBeLessThanOrEqual(s.viewW - 8 + 1);
    expect(s.bar.rect.x).toBeLessThan(s.areaLeft);

    // put away while its area is dragged, there again after
    expect(a.drag).toEqual({ during: "hidden", after: "visible", name: "#5102" });
    // Esc: an open menu takes the first, the selection the next; Esc in the bar clears it too
    expect(a.esc).toEqual({ menuOpen: true, afterFirst: { menu: false, bar: true, selected: true }, afterSecond: { bar: false, selected: false }, inBar: { bar: false, selected: false } });
  }, 120_000);

  it("has a workspace's, several's and a taken-over session's actions, and a right-click on the empty landscape makes a workspace there", async () => {
    const b = await run<B>("b");
    expect(b.error).toBeUndefined();

    // a workspace at 30%: Focus, Δ Changes, ▶ Run, Files, Artifacts and ⋯, its whole menu, as its right-click
    const w = b.workspace;
    expect(w.ws30).toMatchObject({ name: "Org dropdowns remember the last org", row: ["Focus ⌘E", "Δ 2 Changes", "▶ Run", "Files", "Artifacts", "⋯"], inView: true, inWorld: false });
    expect(w.more).toEqual(WORKSPACE_MENU);
    expect(w.right).toEqual(WORKSPACE_MENU);
    // Files from the bar and from ⋯: the one window, on it
    const files = { windows: 1, session: "s1", scope: "#5101 Org dropdowns remember the last org · 5101-orgDropdowns" };
    expect(w.filesFromBar).toEqual(files);
    expect(w.closedFiles).toBe(0);
    expect(w.filesFromMenu).toEqual(files);
    // Focus fills the window, with no bar; out of focus, the bar's back
    expect(w.inFocus).toEqual({ focus: true, bar: false });
    expect(w.leftFocus).toEqual({ focus: false, bar: "Org dropdowns remember the last org" });
    // at 100% its own header carries its tools: no bar, still selected
    expect(w.at100).toEqual({ band: "ls-band-live", bar: false, selected: "s1" });

    // taken over by a teammate: its turns and hand-on off in the bar's ⋯, saying why
    expect(b.takenOver.bar).toBe("Donor entity model");
    expect(b.takenOver.rows).toEqual(expect.arrayContaining(["Undo the last turn… (off)", "Continue in Codex… (off)", "Resume (off)", "Take it back"]));
    for (const row of ["Undo the last turn…", "Continue in Codex…", "Fresh session from a brief…", "Second opinion from Codex", "Resume"]) expect(b.takenOver.why[row], row).toMatch(TAKEN_BACK);

    // three Shift-clicked: their bar; its right-click and a picked card's the same menu; Close… asks first
    const v = b.several;
    expect(v.cleared).toMatchObject({ bar: null, selected: null });
    expect(v.three).toMatchObject({ name: "3 selected", row: ["Make area… M", "Stack ⌘G (off)", "Move to area ▾", "Close…"], inView: true });
    expect(v.three.why).toEqual({ "Stack ⌘G (off)": STACK_COMING });
    // all three are in 5101 already: Move to area offers the others
    expect(v.onPicked).toEqual(["# 3 selected", "Make area… [M]", "Stack (off) [⌘G]", "-", "# Move to area", "#5101 Org dropdowns remember the last org (off)", "#5102 Pathways quick view freezes", "#5110", "-", "Close…"]);
    expect(v.onBar).toEqual(v.onPicked);
    expect(v.move).toEqual(["#5101 Org dropdowns remember the last org (off)", "#5102 Pathways quick view freezes", "#5110"]);
    expect(v.closeDlg).toBe("Close 3 workspaces?");
    expect(v.closeList).toHaveLength(3);
    expect(v.closeKept).toBe(3);
    // Move to area ▾ → 5102: s1 and s4 join it, inside it; the api stack holds a teammate's tab, so it stays, saying so
    expect(b.moved).toEqual({ groups: ["5102", "5101/api", "5102"], inside: true, bar: false, apart: true, setGroup: [["s1", "5102"], ["s4", "5102"]], note: "1 teammate's workspace stays in its room" });

    // in an area: today's ways to make a workspace, then the area's rows; Claude… opens New session for that area
    const i = b.createIn;
    expect(i.rows!.slice(0, CREATE_ROWS.length)).toEqual(CREATE_ROWS);
    expect(i.rows!.slice(CREATE_ROWS.length, CREATE_ROWS.length + 2)).toEqual(["-", "# Area"]);
    expect(i.rows).not.toContain("New session here…");
    expect(i.why).toEqual({ "Collab… (coming)": expect.stringMatching(/later version/), "Pipeline from a ticket… (coming)": expect.stringMatching(/later version/) });
    expect(i.selected).toBe("5102");
    expect(i.dialog).toMatchObject({ title: "New session", launch: "Claude", mode: "New", group: "group: 5102▾", repo: path.basename(i.firstRepo!) });
    // made, it's in that area, where it was clicked (the nearest free spot to it)
    expect(i.made.group).toBe("5102");
    const p = i.made.placed!;
    expect(p.x >= i.area.x && p.y >= i.area.y && p.x + p.w <= i.area.x + i.area.w && p.y + p.h <= i.area.y + i.area.h).toBe(true);
    expect(Math.hypot(p.x - i.at.x, p.y - i.at.y)).toBeLessThan(300);
    // in no area: only the create rows; Terminal… makes a loose terminal where it was clicked
    const l = b.createLoose;
    expect(l.rows).toEqual(CREATE_ROWS);
    expect(l.selected).toBeNull();
    expect(l.dialog).toMatchObject({ launch: "Terminal", mode: "New", group: "no group▾" });
    expect(l.made.group).toBeNull();
    expect(Math.hypot(l.made.placed!.x - l.at.x, l.made.placed!.y - l.at.y)).toBeLessThan(16);
    // From a ticket… opens it with the ticket field; Import… importing
    expect(b.createOther.ticket).toMatchObject({ launch: "Claude", group: "group: 5102▾", ticketOpen: true });
    expect(b.createOther.importing).toMatchObject({ mode: "Import" });
  }, 120_000);

  it("folds its last buttons behind » in a narrow window, and remembers the second row", async () => {
    const c = await run<C>("c", "side=closed", "640x800");
    expect(c.error).toBeUndefined();
    const f = c.fold;
    expect(f.viewW).toBeLessThanOrEqual(640);
    // the room's tools stay; Ask for status and Tools ▾ fold, ⋯ never
    expect(f.folded).toMatchObject({ row: ["Chat · 2", "Board", "Members ▾", "Follow Nick", "» 2 more", "⋯"], row2: [], inView: true });
    expect(f.folded.rect.w).toBeLessThanOrEqual(f.viewW - 16);
    // » puts them on a second row until « Less, kept for this window
    expect(f.extended.bar).toMatchObject({ row: ["Chat · 2", "Board", "Members ▾", "Follow Nick", "« Less", "⋯"], row2: ["Ask for status", "Tools ▾"], inView: true });
    expect(f.extended.stored).toBe("true");
    expect(f.remembered).toMatchObject({ row2: ["Ask for status", "Tools ▾"] });
    expect(f.less.bar).toMatchObject({ row2: [], row: f.folded.row });
    expect(f.less.stored).toBe("false");
    // a button on the second row is the same button
    expect(f.askFromRow2).toEqual([["5101"]]);
    expect(c.foldWs).toMatchObject({ inView: true });
    expect(c.foldWs.rect.w).toBeLessThanOrEqual(f.viewW - 16);
  }, 120_000);

  it("zoomed out to cards, leaves windows and cards inside their areas; a peek takes Esc before the selection", async () => {
    const d = await run<D>("d", "lsWindows");
    expect(d.error).toBeUndefined();
    expect(d.cards.band).toBe("ls-band-cards");
    expect(d.cards.zoom).toBeCloseTo(0.13, 2);
    expect(d.cards.items.length).toBeGreaterThanOrEqual(3);
    for (const it of d.cards.items) expect(it, it.id).toMatchObject({ inside: true, overName: [], overArea: [] });
    expect(d.peek).toEqual({ peekOpen: true, bar: "#5102", first: { peek: false, bar: "#5102" }, second: { bar: false, selected: false } });
  }, 120_000);
});
