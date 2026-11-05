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
  grown: { was: Bar; grown: Bar; dotsInView: boolean };
  error?: string;
}
interface D {
  cards: { zoom: number; band: string | null; items: { id: string; area: string | null; inside: boolean; overName: string[]; overArea: string[] }[] };
  peek: { peekOpen: boolean; bar: string | null; first: { peek: boolean; bar: string | null }; second: { bar: boolean; selected: boolean } };
  error?: string;
}

interface E {
  menus: { plain: Menu; room: Menu; follow5110: { menu: string[]; header: string[] }; header5101: string[] };
  artifactsMidRename: { group: string | null; held: boolean; opened: (string | null)[]; after: (string | null)[] };
  newHere: { repo: string | null; made: { repoPath: string | null; baseBranch: string | null; taskGroup: string | null }[] };
  renamed: { selected: string | null; bar: string | null; title: string | null };
  removed: { spareSelected: string | null; afterRemove: { area: boolean; selected: string | null; bar: string | null }; madeAgain: { selected: string | null; bar: string | null } };
  pill: { before: { selected: string | null; collapsed: boolean }; after: { selected: string | null; collapsed: boolean; bar: string | null } };
  error?: string;
}
type Clear = { bar: string | null; gap: number; inView: boolean } | null;
interface G {
  cancelAll: { first: { title: string | null; buttons: string[] }; askedAfter: number; left: string[] };
  appended: { left: string[]; dialog: boolean };
  error?: string;
}
interface F {
  shiftOnTerm: { bar: string | null };
  above: Record<string, Clear>;
  gitFail: { label: string | null; title: string | null };
  closeMany: { picked: string | null; many: { title: string | null; list: string[] }; dialogs: string[]; notes: string[]; left: string[] };
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
  "-", "# Tools", "Files [⇧⌘E]", "Changes [⌃⇧G]", "Search [⇧⌘F]", "Run & debug [⇧⌘D]", "Artifacts",
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
    expect(a.handlers.more).not.toContain("# Team room");
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

    // three Shift-clicked (one of them the api stack): their bar; its right-click and a picked card's the same menu;
    // Close… asks first, listing every tab of the stack that's this Mac's
    const v = b.several;
    expect(v.cleared).toMatchObject({ bar: null, selected: null });
    expect(v.three).toMatchObject({ name: "3 selected", row: ["Make area… M", "Stack ⌘G (off)", "Move to area ▾", "Close…"], inView: true });
    expect(v.three.why).toEqual({ "Stack ⌘G (off)": STACK_COMING });
    // all three are in 5101 already: Move to area offers the others
    expect(v.onPicked).toEqual(["# 3 selected", "Make area… [M]", "Stack (off) [⌘G]", "-", "# Move to area", "#5101 Org dropdowns remember the last org (off)", "#5102 Pathways quick view freezes", "#5110", "-", "Close…"]);
    expect(v.onBar).toEqual(v.onPicked);
    expect(v.move).toEqual(["#5101 Org dropdowns remember the last org (off)", "#5102 Pathways quick view freezes", "#5110"]);
    expect(v.closeDlg).toBe("Close 4 sessions?");
    expect(v.closeList).toEqual(["Org dropdowns remember the last org", "API: last org per user", "API tests", "test runner"]);
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
    // made, it's in that area, over where it was clicked (near its foot and right edge: moved in from them to fit)
    expect(i.made.group).toBe("5102");
    const p = i.made.placed!;
    expect(p.x >= i.area.x && p.y >= i.area.y && p.x + p.w <= i.area.x + i.area.w && p.y + p.h <= i.area.y + i.area.h).toBe(true);
    expect(i.at.x >= p.x && i.at.x <= p.x + p.w && i.at.y >= p.y && i.at.y <= p.y + p.h, JSON.stringify({ at: i.at, p })).toBe(true);
    // in no area: only the create rows; Terminal… makes a loose terminal where it was clicked
    const l = b.createLoose;
    expect(l.rows).toEqual(CREATE_ROWS);
    expect(l.selected).toBeNull();
    expect(l.dialog).toMatchObject({ launch: "Terminal", mode: "New", group: "no group▾" });
    expect(l.made.group).toBeNull();
    // (or the nearest free spot by it, when what's stored there leaves no room at the click)
    expect(Math.hypot(l.made.placed!.x - l.at.x, l.made.placed!.y - l.at.y), JSON.stringify({ at: l.at, p: l.made.placed })).toBeLessThan(160);
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
    // its status grown while it's selected: measured again, it folds more and stays inside the window, ⋯ in it
    expect(c.grown.was.status).toBe("1 waiting · 1 working");
    expect(c.grown.grown.status).toBe("3 waiting · 1 working · 1 exited");
    expect(c.grown.grown).toMatchObject({ inView: true });
    expect(c.grown.grown.rect.w).toBeLessThanOrEqual(f.viewW - 16);
    expect(c.grown.dotsInView).toBe(true);
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

  it("has area menus without a room's rows outside rooms, makes New session here… in the area's repo, and keeps the selection true to the areas there are", async () => {
    const e = await run<E>("e", "samView");
    expect(e.error).toBeUndefined();
    // an area that isn't a room's: no Team room heading; its sessions under Sessions; one choice each for messages
    expect(e.menus.plain).toEqual([
      "# Area", "Rename…", "Collapse to a pill", "Lock its layout",
      "-", "# Tools", "Artifacts",
      "-", "# Agent messages", "As in Settings (auto-send)", "Always auto-send", "Always leave in prompt", "Agent message log…",
      "-", "# Sessions", "New session here…", "Ask for status",
      "-", "Share as a team room…",
    ]);
    // a room's: its Chat, then its board, Follow and Invite under Team room
    expect(e.menus.room).toEqual([
      "# Area", "Rename…", "Collapse to a pill", "Lock its layout",
      "-", "# Tools", "Artifacts", "Chat",
      "-", "# Agent messages", "As in Settings (auto-send)", "Always auto-send", "Always leave in prompt", "Agent message log…",
      "-", "# Sessions", "New connected session here…", "Ask for status",
      "-", "# Team room", "House board…", "Follow Nick", "Follow Sam", "Invite a teammate…",
    ]);
    // a room's area offers only its own members to follow, in its menu and its header alike: Sam isn't in 5110's room
    expect(e.menus.follow5110).toEqual({ menu: ["Follow Nick"], header: ["Follow Nick"] });
    expect(e.menus.header5101).toEqual(["Follow Nick", "Follow Sam"]);
    // New session here… opens on the area's first repo and makes it there, on its base
    expect(e.newHere.repo).toBe("client-portal");
    expect(e.newHere.made).toEqual([{ repoPath: "/Users/you/Code/client-portal", baseBranch: "main", taskGroup: "5102" }]);
    // renamed: still selected, under its new name, with its bar
    expect(e.renamed.selected).toBe("Pathways");
    expect(e.renamed.bar).not.toBeNull();
    expect(e.renamed.title).toContain(e.renamed.bar!);
    // renamed again, before the landscape has caught up: a workspace's Artifacts opens the area the landscape holds,
    // which the rename then carries to its new name
    expect(e.artifactsMidRename).toEqual({ group: "Quick view", held: true, opened: ["Pathways"], after: ["Quick view"] });
    // removed: let go, so an area made again under its name isn't selected
    expect(e.removed.spareSelected).toBe("Spare");
    expect(e.removed.afterRemove).toEqual({ area: false, selected: null, bar: null });
    expect(e.removed.madeAgain).toEqual({ selected: null, bar: null });
    // a collapsed area's pill: a click opens it and selects it
    expect(e.pill.before).toEqual({ selected: null, collapsed: true });
    expect(e.pill.after).toMatchObject({ selected: "5101", collapsed: false });
    expect(e.pill.after.bar).toMatch(/^#5101/);
  }, 120_000);

  it("picks with Shift on a terminal, keeps above the area's name, says when changes can't be read, and closes several one at a time", async () => {
    const f = await run<F>("f", "gitFail=5102-quickViewFreeze&closeFail=5110-donor-entities");
    expect(f.error).toBeUndefined();
    // at 60% a Shift-click on another workspace's terminal adds it
    expect(f.shiftOnTerm).toEqual({ bar: "2 selected" });
    // over workspaces at the area's top, alone or two, in the cards and read-only bands: clear above its name or header
    for (const [k, v] of Object.entries(f.above)) {
      expect(v, k).not.toBeNull();
      expect(v!.inView, k).toBe(true);
      expect(v!.gap, k).toBeGreaterThanOrEqual(7);
    }
    expect(f.above["two@0.3"]!.bar).toBe("2 selected");
    // changes that couldn't be read: Δ ?, saying why, never Δ Changes
    expect(f.gitFail).toEqual({ label: "Δ ?", title: "Couldn't read its changes: git status: fatal: unable to read index" });
    // Close… on three: the one with uncommitted work asks in its own dialog (cancelled: it stays), the one that fails
    // says so and the rest go on, the exited one closes
    const c = f.closeMany;
    expect(c.picked).toBe("3 selected");
    expect(c.many.title).toBe("Close 3 sessions?");
    expect(c.dialogs).toEqual(["Close Release notes for #5101?"]);
    expect(c.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^Couldn't close Donor entity model \(EIO: i\/o error, read\); the others go on closing$/)]));
    expect(c.left).toEqual(["s8", "y1"]);
  }, 120_000);

  it("stops closing several with Cancel all, and adds a second Close… on several after the first's rest", async () => {
    const g = await run<G>("g", "gitSlow=5102-quickViewFreeze");
    expect(g.error).toBeUndefined();
    // the first one's dialog, others still to come: Cancel all keeps it and the rest, and nothing more is asked
    expect(g.cancelAll.first.title).toMatch(/^Close /);
    expect(g.cancelAll.first.buttons).toEqual(expect.arrayContaining(["Cancel all", "Cancel"]));
    expect(g.cancelAll.askedAfter).toBe(0);
    expect(g.cancelAll.left).toEqual(["s1", "s8"]);
    // s5 read slowly while s4 and y1 are closed as well: s6, waiting behind s5, still closes, and so do they
    expect(g.appended).toEqual({ left: [], dialog: false });
  }, 120_000);
});
