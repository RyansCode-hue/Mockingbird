import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Tool windows and the workspace's actions (S5) in the UI preview, in real headless Chrome: local only (CI runners
// have no desktop); the script passes a mock keychain. ?landscapeToolsAudit (src/preview/stub.ts) opens, docks, places
// and closes windows as a person would, works the actions from every place they're offered, and an area's artifacts,
// and reports what each step left once it settled, with the calls each made to the main process (window.__mbCalls).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type R = { x: number; y: number; w: number; h: number };
type Opened = { windows: number; beside: boolean; scope: string | null; stored: { session: string | null; area: string | null; docked: boolean } | null; lit: string | null; onItsWorktree: boolean; inView: boolean; apart: boolean };
type Stored = { id: string; tool: string; docked: boolean; session?: string; area?: string | null; placement?: R };
interface Audit {
  rail: string[];
  opened: Record<"files" | "changes" | "search" | "run", Opened>;
  keys: Record<string, { closed: boolean; open: boolean }>;
  dock: {
    docked: { inDock: boolean; placed: boolean; stored: Stored | null; scope: string | null };
    follows: { scope: string | null; onS5: boolean };
    placedAgain: { beside: boolean; stored: Stored | null; inDock: boolean };
  };
  remount: { before: { placed: Record<string, R>; docked: string[] }; after: { placed: Record<string, R>; docked: string[] }; storedSame: boolean };
  withArea: { moved: boolean; dx: [number, number]; dy: [number, number]; drawn: R | null; stored: R; apart: boolean };
  dead: { s6: string[]; y1: string[]; costAsked: string | null; resumed: string[]; cleaned: string[]; s6Now: string | null; y1Gone: boolean };
  actions: {
    cardMenu: string[] | null;
    cardMore: string[] | null;
    headMenu: string[] | null;
    headMore: string[] | null;
    treeMenu: string[] | null;
    muted: unknown[][];
    area5102: string[] | null;
    area5101: string[] | null;
    chrome: { chips: number; foot: string[]; footShown: number };
  };
  artifacts: {
    listed: { count: string | null; rows: string[]; scope: string | null; stored: Stored | null; asked: string[] };
    added: { lifted: boolean; calls: string[][]; rows: string[] };
    placedCard: { stored: { area: string; artifact: string; placement?: R } | null; drawn: number; tag: boolean };
    renamed: { rows: string[]; scope: string | null; window: string | null; card: string | null; shelves: string[] };
    removed: { confirm: string | null; calls: string[]; rows: string[] };
    room: { count: string | null; rows: string[]; expected: string[] | null };
  };
  error?: string;
}

/** The preview's audit `id`, run with `query` (the landscape at 50%, motion off, besides). */
async function run<T>(query: string, id: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1400x900",
    query: `labs=landscape&motion=off&lsCamera=0,0,0.5&${query}`,
    outDir: path.join(tempDir(id), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}`);
  return JSON.parse(json);
}
const audit = () => run<Audit>("landscapeToolsAudit", "mb-landscape-tools-audit");

type Seen = { band: string | null; partly: boolean; viewing: boolean; reads: number };
type Gate = { rows: Record<string, { menuOn: boolean; keyOpened: boolean; railOff: boolean }>; railClickOpened: boolean; said: string | null };
type Head = { tool: string; w: number; h: number; name: string; nameH: number; scope: string | null; inv: number };
interface Review {
  reload: { before: unknown; after: { placed: Record<string, R>; docked: string[]; cards: Record<string, R> }; storedSame: boolean; card: string | null };
  chat: { shown: Seen; offScreen: Seen; zoomedOut: Seen };
  notified: { before: number; after: number; windowShown: boolean; areaShown: boolean; tab: string | null };
  gate: { s6: Gate; teammate: Gate };
  menus: { y1: string[]; s4: string[]; teammate: string[] };
  dockedFollows: { opened: number; docked: boolean; placed: boolean; scope: string | null };
  hiddenRoom: { collapsed: { open: boolean; placed: number; docked: number }; locked: { placed: number; docked: number; scope: string | null } };
  dockedChat: { stillDocked: boolean; said: string | null };
  staleMenu: { menuOpen: boolean; unchanged: boolean; said: string | null };
  mention: { refused: { writes: number; said: string | null }; typed: string[][] };
  cards: { at13: { zoom: number; band: string; windows: Head[]; card: { w: number; h: number; name: string; kind: string | null; nameH: number; inv: number }; apart: boolean }; at16: { zoom: number; windows: number[]; card: number } };
  share: { shared: { offered: string | null; shelfWas: string; shelf: string; room: string | null; newId: boolean; inRoom: boolean; name: string | null }; invite: { code: boolean; offer: boolean } };
  team: { list: { title: string | null; rooms: string[] }; left: { leaveRows: string[] | null; roomGone: boolean; card: string | null; why: string | null }; backToTree: boolean };
  follow: { offered: boolean; on5102: string[]; on5101: number };
  error?: string;
}

/** A workspace's menu, as every place that offers it shows it. */
const WORKSPACE_MENU = [
  "# Session", "Rename…", "Mute notifications", "Move to area…", "Size S", "Size M", "Size L",
  "-", "# Tools", "Files [⇧⌘E]", "Changes [⌃⇧G]", "Search [⇧⌘F]", "Run & debug [⇧⌘D]",
  "-", "# Terminal", "Repaint", "Hide the agent's diff panel (off)", "Undo the last turn…",
  "-", "# Hand on", "Continue in Codex…", "Fresh session from a brief…", "Second opinion from Codex",
  "-", "Close…",
];

describe.skipIf(!local)("tool windows and the workspace's actions", () => {
  it("are worked as a person would: the rail and keys, docking and placing, a remount, an area's drag, every menu, a dead card, an area's artifacts", async () => {
    const a = await audit();
    expect(a.error).toBeUndefined();

    // the rail names the tools as their windows are named
    expect(a.rail).toEqual(["Sessions", "Files", "Changes", "Search", "Run & debug", "Chat", "Artifacts"]);

    // each opens beside the selected workspace, scoped to it, its area kept apart from the others, and in view
    for (const tool of ["files", "changes", "search", "run"] as const) {
      expect(a.opened[tool], tool).toMatchObject({ windows: 1, beside: true, stored: { session: "s1", area: "5101", docked: false }, lit: "true", inView: true, apart: true });
      expect(a.opened[tool].scope).toBe("#5101 Org dropdowns remember the last org · 5101-orgDropdowns");
    }
    // on its worktree: Files lists it, Changes reads its status, Run reads its run setup (Search waits for a query)
    for (const tool of ["files", "changes", "run"] as const) expect(a.opened[tool].onItsWorktree, tool).toBe(true);
    // each key closes the window open on the selection and opens it again beside it; ⌘B is Files
    expect(a.keys).toEqual({ "⇧⌘E": { closed: true, open: true }, "⌘B": { closed: true, open: true }, "⌃⇧G": { closed: true, open: true }, "⇧⌘F": { closed: true, open: true }, "⇧⌘D": { closed: true, open: true } });

    // docked, it has no scope or place of its own and follows the selection; placed again, beside what's selected
    expect(a.dock.docked).toMatchObject({ inDock: true, placed: false, stored: { tool: "files", docked: true } });
    expect(a.dock.docked.stored).not.toHaveProperty("placement");
    expect(a.dock.follows).toEqual({ scope: "#5102 Pathways quick view freezes · 5102-quickViewFreeze", onS5: true });
    expect(a.dock.placedAgain).toMatchObject({ beside: true, inDock: false, stored: { tool: "files", docked: false, session: "s5", area: "5102" } });

    // mounted again: each placed window where it was, the docked one docked, nothing stored changed
    expect(Object.keys(a.remount.before.placed)).toHaveLength(3);
    expect(a.remount.after).toEqual(a.remount.before);
    expect(a.remount.before.docked).toHaveLength(1);
    expect(a.remount.storedSame).toBe(true);

    // a placed window moves with its area, drawn where it's stored
    expect(a.withArea.moved).toBe(true);
    expect(a.withArea.dx[1]).toBe(a.withArea.dx[0]);
    expect(a.withArea.dy[1]).toBe(a.withArea.dy[0]);
    expect(a.withArea.dx[0] !== 0 || a.withArea.dy[0] !== 0).toBe(true);
    expect(a.withArea.drawn).toEqual(a.withArea.stored);
    expect(a.withArea.apart).toBe(true);

    // one model: the card's right-click and ⋯ zoomed out, the header's at 100%, and the tree row's, the same rows
    for (const k of ["cardMenu", "cardMore", "headMenu", "headMore", "treeMenu"] as const) expect(a.actions[k], k).toEqual(WORKSPACE_MENU);
    expect(a.actions.muted).toEqual([["s1", true]]);
    // an area's patch zoomed out: the area's model, Chat only in a room's
    expect(a.actions.area5102).toEqual(expect.arrayContaining(["# Area", "Rename…", "Collapse to a pill", "Lock its layout", "# Tools", "Artifacts", "Agent message log…", "Share as a team room…", "New session here…", "Ask for status"]));
    expect(a.actions.area5102).not.toContain("Chat");
    expect(a.actions.area5101).toEqual(expect.arrayContaining(["# Area", "Rename…", "Artifacts", "Chat", "Invite a teammate…", "New connected session here…"]));
    // the header's chips and the footer's cells (elapsed and tokens read without their key)
    expect(a.actions.chrome.chips).toBeGreaterThanOrEqual(5);
    expect(a.actions.chrome.foot).toEqual(["Elapsed", "Git", "PR", "Msgs", "Repo", "Folder", "Tokens"]);
    expect(a.actions.chrome.footShown).toBe(7);

    // a dead workspace's card: Resume (what it re-reads asked first) and Close & clean up
    expect(a.dead.s6).toEqual(["Resume", "Close & clean up"]);
    // one a teammate took over is taken back, not resumed: its card has no Resume
    expect(a.dead.y1).toEqual(["Close & clean up"]);
    expect(a.dead.costAsked).toMatch(/Resume Crashed session/);
    expect(a.dead.resumed).toEqual(expect.arrayContaining(['killSession ["s6",false]', 'relaunchSession ["s6"]']));
    expect(a.dead.s6Now).not.toBe("dead");
    expect(a.dead.cleaned).toContain('killSession ["y1",true]');
    expect(a.dead.y1Gone).toBe(true);

    // an area's artifacts on this Mac: listed from its own shelf
    expect(a.artifacts.listed).toMatchObject({ count: "On this Mac · 3", rows: ["quick-view-trace.png", "Tag list profile", "React profiler docs"], scope: "#5102 Pathways quick view freezes", stored: { tool: "artifacts", docked: false, area: "5102" } });
    expect(a.artifacts.listed.asked).toEqual(['artifactsList ["area:5102"]']);
    // a note added through its dialog, drawn over the landscape rather than scaled inside it
    expect(a.artifacts.added.lifted).toBe(true);
    expect(a.artifacts.added.calls[0]).toEqual(["artifactsAddNote", "area:5102", "Perf budget"]);
    expect(a.artifacts.added.rows).toEqual(["Perf budget", "quick-view-trace.png", "Tag list profile", "React profiler docs"]);
    // placed as a card in the area, the row saying so
    expect(a.artifacts.placedCard).toMatchObject({ stored: { area: "5102" }, drawn: 1, tag: true });
    // the area renamed: its artifacts, window and card follow, nothing left under the old name
    expect(a.artifacts.renamed).toEqual({ rows: a.artifacts.added.rows, scope: "Pathways", window: "Pathways", card: "Pathways", shelves: ["area:Pathways"] });
    // removed after its dialog, from the renamed area's shelf
    expect(a.artifacts.removed).toEqual({ confirm: "Remove “Perf budget”?", calls: ["area:Pathways"], rows: ["quick-view-trace.png", "Tag list profile", "React profiler docs"] });
    // a room's area: the room's artifacts
    expect(a.artifacts.room.count).toMatch(/^Shared with the room · \d+$/);
    expect([...a.artifacts.room.rows].sort()).toEqual([...(a.artifacts.room.expected ?? [])].sort());
  }, 120_000);

  it("say why an area's shelf a newer Mockingbird wrote can't be changed, and offer nothing that would", async () => {
    type ReadOnly = { shelf: { add: { disabled: boolean; title: string }; said: string[]; rowMenu: string[] | null; rows: number }; error?: string };
    const r = await run<ReadOnly>("areaReadOnly=5102&landscapeReadOnlyAudit", "mb-landscape-read-only-audit");
    expect(r.error).toBeUndefined();
    expect(r.shelf.rows).toBe(3);
    expect(r.shelf.add).toEqual({ disabled: true, title: expect.stringMatching(/newer Mockingbird .* update Mockingbird to change this area's artifacts/) });
    expect(r.shelf.said).toEqual([expect.stringMatching(/newer Mockingbird/)]);
    expect(r.shelf.rowMenu).toEqual(expect.arrayContaining(["Rename… (off)", "Remove… (off)"]));
  }, 120_000);

  it("keep the review's fixes: a reload, a Chat's viewing, routing, one gate, the menus", async () => {
    const r = await run<Review>("lsPersist&landscapeReviewAudit=a", "mb-landscape-review-audit-a");
    expect(r.error).toBeUndefined();

    // placed and docked windows and a card, through a real reload: drawn where they were, nothing stored changed
    expect(r.reload.after).toEqual(r.reload.before);
    expect([Object.keys(r.reload.after.placed).length, r.reload.after.docked.length, Object.keys(r.reload.after.cards).length]).toEqual([2, 1, 1]);
    expect(r.reload.storedSame).toBe(true);
    expect(r.reload.card).toBe("React profiler docs");

    // a Chat window views its room and reads it only on screen in the live band: off screen, or zoomed out to cards
    // with it on screen, its room isn't viewed (so a mention notifies) and nothing is marked read
    expect(r.chat.shown).toMatchObject({ band: "live", partly: true, viewing: true });
    expect(r.chat.shown.reads).toBeGreaterThan(0);
    expect(r.chat.offScreen).toEqual({ band: "live", partly: false, viewing: false, reads: 0 });
    expect(r.chat.zoomedOut).toEqual({ band: "cards", partly: true, viewing: false, reads: 0 });

    // a mention notification: its room's area, flown to, with the room's Chat opened in it
    expect(r.notified).toEqual({ before: 0, after: 1, windowShown: true, areaShown: true, tab: "Sessions" });

    // the keys and the rail do what the selection's menu offers, no more: an exited session's Search only, none of a
    // teammate's; the rail says why
    for (const [who, g] of Object.entries(r.gate)) {
      for (const [k, row] of Object.entries(g.rows)) expect({ who, k, opened: row.keyOpened, railOff: row.railOff }).toEqual({ who, k, opened: row.menuOn, railOff: !row.menuOn });
      expect(g.railClickOpened).toBe(false);
    }
    expect(Object.entries(r.gate.s6.rows).filter(([, x]) => x.menuOn).map(([k]) => k)).toEqual(["search"]);
    expect(Object.values(r.gate.teammate.rows).some((x) => x.menuOn)).toBe(false);
    expect(r.gate.s6.said).toBe("Its session has exited");
    expect(r.gate.teammate.said).toBe("Nick Smith's session has no folder on this Mac");

    // the menus as main.tsx builds them: a session a teammate took over is taken back, not resumed; a terminal and a
    // teammate's session have no agent to hand on
    expect(r.menus.y1).toEqual(expect.arrayContaining(["Take it back", "Resume (off)", "Close & clean up…"]));
    expect(r.menus.y1).not.toContain("Resume");
    expect(r.menus.s4).toEqual(expect.arrayContaining(["Undo the last turn… (off)", "Continue in Codex… (off)", "Fresh session from a brief… (off)", "Second opinion from Codex (off)"]));
    expect(r.menus.teammate).toEqual(
      expect.arrayContaining(["Files (off) [⇧⌘E]", "Changes (off) [⌃⇧G]", "Search (off) [⇧⌘F]", "Run & debug (off) [⇧⌘D]", "Undo the last turn… (off)", "Continue in Codex… (off)", "Close… (off)"])
    );
    // a docked Chat's ⧉ keeps the room rule
    expect(r.dockedChat).toEqual({ stillDocked: true, said: expect.stringMatching(/isn't a team room/) });
    // a mention for a room whose area is collapsed opens the area and places its Chat there; one locked with no room
    // shows it in the docked Chat already there, the selection moved into the room's area, never another room's
    expect(r.hiddenRoom.collapsed).toEqual({ open: true, placed: 1, docked: 0 });
    expect(r.hiddenRoom.locked).toEqual({ placed: 0, docked: 1, scope: "#5110" });
  }, 120_000);

  it("keep the review's fixes: menus picked late, mentions, the cards band, sharing, the room list, following", async () => {
    const r = await run<Review>("landscapeReviewAudit=b", "mb-landscape-review-audit-b");
    expect(r.error).toBeUndefined();

    // a tool picked from a workspace's menu while it's docked: the docked one shows that workspace, none is added
    expect(r.dockedFollows).toEqual({ opened: 0, docked: true, placed: false, scope: "#5101 Org dropdowns remember the last org · 5101-orgDropdowns" });

    // Size L from a menu opened before its area was locked: refused as the area is when it's picked
    expect(r.staleMenu).toEqual({ menuOpen: true, unchanged: true, said: expect.stringMatching(/is locked/) });

    // a mention goes only to a workspace in the artifact's area
    expect(r.mention.refused).toEqual({ writes: 0, said: expect.stringMatching(/is in #5101.*, not #5102/) });
    expect(r.mention.typed).toEqual([["s5", "#[React profiler docs](artifact:…) "]]);

    // zoomed out to cards, each window and the card read as a workspace card does: a head at screen size with the
    // tool's name and scope (the Artifacts window's count), or the artifact's name and kind; kept so as the camera moves
    expect(r.cards.at13).toMatchObject({ zoom: 0.13, band: "cards" });
    expect(r.cards.at13.windows.map((h) => h.name).sort()).toEqual(["Artifacts · 3", "Files"]);
    for (const h of r.cards.at13.windows) {
      expect(h.w, h.tool).toBeGreaterThanOrEqual(130);
      expect(h.nameH, h.tool).toBeGreaterThanOrEqual(13);
      expect(h.nameH, h.tool).toBeLessThanOrEqual(18);
      expect(h.scope, h.tool).toMatch(/^#510[12] /);
      expect(h.inv).toBeCloseTo(1 / 0.13, 2);
    }
    expect(r.cards.at13.card).toMatchObject({ name: "React profiler docs", kind: "Link" });
    expect(r.cards.at13.card.w).toBeGreaterThanOrEqual(130);
    expect(r.cards.at13.card.nameH).toBeGreaterThanOrEqual(13);
    // the card placed beside its Artifacts window is drawn under it, neither covering the other's name
    expect(r.cards.at13.apart).toBe(true);
    expect(r.cards.at16.zoom).toBe(0.16);
    for (const inv of [...r.cards.at16.windows, r.cards.at16.card]) expect(inv).toBeCloseTo(1 / 0.16, 2);

    // an area shared as a room: its artifacts offered as the room's made, its card following its artifact to the
    // room's copy; inviting to it later offers them no more
    expect(r.share.shared).toMatchObject({ offered: "Share 3 artifacts", shelfWas: "area:5102", newId: true, inRoom: true, name: "React profiler docs" });
    expect(r.share.shared.shelf).toBe(r.share.shared.room);
    expect(r.share.invite).toEqual({ code: true, offer: false });

    // the Connected line on the landscape: the Team view's room list in the side bar, Leave there; a card of the room
    // left says so, and back to the area tree
    expect(r.team.list).toEqual({ title: "Team rooms", rooms: ["#5101 Org dropdowns remember the last org", "#5110 Donor entities", "#5102 Pathways quick view freezes"] });
    expect(r.team.left).toMatchObject({ roomGone: true, card: "Not here any more", why: expect.stringMatching(/You left the room/) });
    expect(r.team.left.leaveRows).toContain("Leave room…");
    expect(r.team.backToTree).toBe(true);

    // following a teammate is said on an area that isn't a room's too
    expect(r.follow).toEqual({ offered: true, on5102: ["Following Nick"], on5101: 1 });
  }, 120_000);
});
