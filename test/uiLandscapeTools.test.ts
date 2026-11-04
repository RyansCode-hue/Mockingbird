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

async function audit(): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1400x900",
    query: "labs=landscape&motion=off&lsCamera=0,0,0.5&landscapeToolsAudit",
    outDir: path.join(tempDir("ls-tools"), "out"),
    read: `document.getElementById("mb-landscape-tools-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error("the preview didn't finish its tools audit");
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
});
