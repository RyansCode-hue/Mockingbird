import type { ReactNode } from "react";
import type { Camera, Rect, Size } from "../shared/landscape";
import { readPref, writePref, type PrefStore } from "./prefs";
import { tidyMenu, type MenuEntry } from "./ContextMenu";
import { actionOf, type ModelAction } from "./workspaceActions";


/**
 * The selection bar's buttons and geometry (design Q, sized as Q2): which buttons a selection has, which of them fit,
 * and where it floats. Pure, so the bar (SelectionBar.tsx) and its tests share it.
 */

/** One button of the bar. */
export interface BarItem {
  key: string;
  label: string;
  title?: string;
  /** Its shortcut, after the label ("Focus ⌘E"). */
  kbd?: string;
  disabled?: boolean;
  /** Runs it, from its button. */
  onPick?: (from: HTMLElement) => void;
  /** ▾: these rows open as a menu under it instead. */
  menu?: () => MenuEntry[];
  /** A control of its own, drawn as it is (Members ▾). */
  element?: ReactNode;
  /** How soon it folds in a narrow window: higher first, the rightmost first among equals (foldBar). */
  rank: number;
  tone?: "teal" | "danger";
  /** A rule before it, as Q draws one before Tools ▾. */
  sep?: boolean;
}

/** A row of the model as a button: its label, its handler, and whether it can be done now (and why not) as the menu says. */
function fromRow(row: ModelAction | undefined, rank: number, over: Partial<BarItem> = {}): BarItem | null {
  if (!row) return null;
  const title = row.disabled ? row.title : `${row.title ?? row.menuLabel ?? row.label}${row.kbd ? ` (${row.kbd})` : ""}`;
  return { key: row.key, label: row.label, title, disabled: row.disabled, onPick: (from) => row.onPick(from), rank, ...over };
}
const present = (items: (BarItem | null | false | undefined)[]): BarItem[] => items.filter((x): x is BarItem => !!x);

/**
 * An area's buttons, from its model (main.tsx's areaActions): for a room's area its Chat (`chatCount` unread), Board,
 * Members ▾ and Follow, which stay longest in a narrow window; then Ask for status and Tools ▾ (the model's Tools
 * rows), which fold first with Follow. An area that isn't a room's has no Chat in its model, so no room tools.
 */
export function areaBarItems(actions: readonly ModelAction[], o: { chatCount: string | null; members: ReactNode | null }): BarItem[] {
  const chat = actionOf(actions, "tool:chat");
  const tools = actions.filter((a) => a.section === "tools");
  return present([
    chat && fromRow(chat, 1, { label: o.chatCount ? `Chat · ${o.chatCount}` : "Chat", tone: o.chatCount ? "teal" : undefined }),
    chat && fromRow(actionOf(actions, "board"), 1),
    chat && !!o.members && { key: "members", label: "Members", element: o.members, rank: 1 },
    ...(chat ? actions.filter((a) => a.key.startsWith("follow:")).map((a) => fromRow(a, 2)) : []),
    fromRow(actionOf(actions, "ask"), 2),
    tools.length > 0 && { key: "tools", label: "Tools", title: "Open one of the area's tool windows", menu: () => tidyMenu(tools), rank: 2, sep: true },
  ]);
}

/**
 * A workspace's buttons, from its model (workspaceActions.tsx): Focus, Δ Changes and ▶ Run, which stay longest; then
 * Files and Artifacts, which fold first. `changes` and `runs` are the counts its header chips show; `changes` is the
 * error when its worktree's state couldn't be read, so it reads "Δ ?" saying why, never as no changes.
 */
export function workspaceBarItems(actions: readonly ModelAction[], o: { onFocus: () => void; changes: number | { error: string }; runs: number }): BarItem[] {
  const unread = typeof o.changes === "number" ? null : o.changes.error;
  const changes = fromRow(actionOf(actions, "tool:changes"), 1, { label: unread !== null ? "Δ ?" : o.changes ? `Δ ${o.changes} Changes` : "Δ Changes" });
  return present([
    { key: "focus", label: "Focus", kbd: "⌘E", title: "Fill the window with it (Enter or ⌘E)", onPick: o.onFocus, rank: 1 },
    changes && unread !== null && !changes.disabled ? { ...changes, title: `Couldn't read its changes: ${unread}` } : changes,
    fromRow(actionOf(actions, "tool:run"), 1, { label: o.runs ? `▶ ${o.runs} Run` : "▶ Run" }),
    fromRow(actionOf(actions, "tool:files"), 2),
    fromRow(actionOf(actions, "tool:artifacts"), 2),
  ]);
}

/**
 * Several workspaces' buttons, from their model (workspaceActions.tsx's severalActions): Make area… (M) and Move to
 * area ▾ (the model's Move rows, as a menu) stay longest; Stack (coming) and Close… fold first.
 */
export function severalBarItems(actions: readonly ModelAction[]): BarItem[] {
  const moves = actions.filter((a) => a.section === "move");
  const make = actionOf(actions, "makeArea");
  const stack = actionOf(actions, "stack");
  return present([
    fromRow(make, 1, { kbd: make?.kbd }),
    fromRow(stack, 2, { kbd: stack?.kbd }),
    moves.length > 0 && { key: "move", label: "Move to area", title: "Move them into one of the areas", menu: () => tidyMenu(moves), rank: 1 },
    fromRow(actionOf(actions, "close"), 2, { label: "Close…", tone: "danger" }),
  ]);
}

/**
 * A not-started step's buttons, from its model (workspaceActions.tsx's plannedActions): Edit…, its model chip
 * (`chip`, the card's own) and Start now stay longest; Insert step after…, Re-lay out pipeline and Forget fold first.
 */
export function stepBarItems(actions: readonly ModelAction[], chip: ReactNode | null): BarItem[] {
  return present([
    fromRow(actionOf(actions, "edit"), 1, { label: "Edit…" }),
    !!chip && { key: "model", label: "Model", element: chip, rank: 1 },
    fromRow(actionOf(actions, "start"), 1),
    fromRow(actionOf(actions, "insertAfter"), 2, { label: "Insert step after…" }),
    fromRow(actionOf(actions, "relayout"), 2, { label: "Re-lay out pipeline" }),
    fromRow(actionOf(actions, "forget"), 2, { tone: "danger" }),
  ]);
}

/** Several not-started steps' buttons (main.tsx's stepsActions): Re-lay out pipeline, while they're in one, and Forget. */
export function stepsBarItems(actions: readonly ModelAction[]): BarItem[] {
  return present([fromRow(actionOf(actions, "relayout"), 1, { label: "Re-lay out pipeline" }), fromRow(actionOf(actions, "forget"), 1, { tone: "danger" })]);
}

/** An area's status in its bar: what its sessions are doing, or how many workspaces it has when nothing is. */
export function areaStatus(c: { waiting: number; working: number; dead: number; workspaces: number }): string {
  const parts = [c.waiting ? `${c.waiting} waiting` : "", c.working ? `${c.working} working` : "", c.dead ? `${c.dead} exited` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${c.workspaces} workspace${c.workspaces === 1 ? "" : "s"}`;
}

/**
 * What the bar floats over: the selection's rectangle on the landscape, and what's drawn above it; for workspaces, the
 * area they're in (`within`), whose name line or header the bar goes above rather than over (barAnchorFor).
 */
export interface BarTarget {
  rect: Rect;
  chrome: BarChrome;
  within?: { rect: Rect; chrome: BarChrome };
}

/** How far the bar keeps from the window's edges, and from the selection it floats over, in screen px. */
export const BAR_MARGIN = 8;
export const BAR_GAP = 8;

/**
 * An area's chrome above its rectangle, in screen px, as styles.css draws it: the header bar (`.ls-area-head`, 38
 * landscape px tall from 1 px over the area's top edge, scaled by --ls-hs about its bottom) in the live and read-only
 * bands, and the name line (`.ls-area-title`, its 22 px line 6 px over the edge) zoomed out to cards. A collapsed area
 * is its pill (`.ls-area-pill`, 34 px tall, scaled by --ls-hs from its corner).
 */
export const AREA_HEAD_PX = 38;
export const AREA_NAME_PX = 28;
export const AREA_PILL_PX = 34;

/** What a selection has drawn over its rectangle, which the bar floats above. */
export type BarChrome = "none" | "areaHeader" | "areaName" | "pill";

/** A button of the bar as folding counts it: its width on screen, and its rank (0 never folds; higher folds first). */
export interface FoldItem {
  key: string;
  w: number;
  rank: number;
}

export interface Fold {
  shown: string[];
  folded: string[];
}

/**
 * Which of a bar's buttons stay in its row when `avail` px are all there is: every one when they fit. Otherwise
 * buttons fold behind » (`moreW` px wide) in priority order, the highest rank first and, among equal ranks, the
 * rightmost first, until the rest and » fit. Rank 0 never folds (the name and ⋯), so a window too narrow even for
 * those keeps them and folds everything else. `gap` is the space between two items. The bar's width comes from what
 * it shows, never from the selection's.
 */
export function foldBar(items: readonly FoldItem[], avail: number, moreW: number, gap: number): Fold {
  const width = (list: readonly FoldItem[], more: boolean) => list.reduce((n, it) => n + it.w, 0) + (more ? moreW : 0) + gap * Math.max(0, list.length + (more ? 1 : 0) - 1);
  if (width(items, false) <= avail) return { shown: items.map((i) => i.key), folded: [] };
  const order = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.rank > 0)
    .sort((a, b) => b.it.rank - a.it.rank || b.i - a.i);
  const folded = new Set<string>();
  for (const { it } of order) {
    folded.add(it.key);
    if (width(items.filter((x) => !folded.has(x.key)), true) <= avail) break;
  }
  return { shown: items.filter((x) => !folded.has(x.key)).map((x) => x.key), folded: items.filter((x) => folded.has(x.key)).map((x) => x.key) };
}

/** Landscape rectangle `r` on screen, at camera `cam`. */
export const onScreen = (r: Rect, cam: Camera): Rect => ({ x: (r.x - cam.x) * cam.zoom, y: (r.y - cam.y) * cam.zoom, w: r.w * cam.zoom, h: r.h * cam.zoom });

/**
 * The selection's box on screen that the bar floats over: its rectangle at camera `cam`, taken up to the top of what's
 * drawn over it (an area's header or name line), or a collapsed area's pill.
 */
export function barAnchor(r: Rect, cam: Camera, chrome: BarChrome): Rect {
  const s = onScreen(r, cam);
  const z = cam.zoom;
  const hs = Math.max(1, 1 / z);
  if (chrome === "pill") return { x: s.x, y: s.y, w: s.w, h: AREA_PILL_PX * hs * z };
  const above = chrome === "areaHeader" ? AREA_HEAD_PX * (hs - 1) * z + 1 : chrome === "areaName" ? AREA_NAME_PX : 0;
  return { x: s.x, y: s.y - above, w: s.w, h: s.h + above };
}

/**
 * The box on screen the bar floats over for `t` at camera `cam`, the bar `barH` px tall: the selection's (barAnchor),
 * unless above it the bar would reach onto the name line or header of the area it's in (the header's bottom is
 * AREA_HEAD_PX × zoom under the area's top edge at every zoom; the name line is wholly above it); then the selection
 * taken up to the top of those, so the bar sits above the area's name instead of on it.
 */
export function barAnchorFor(t: BarTarget, cam: Camera, barH: number, gap = BAR_GAP): Rect {
  const a = barAnchor(t.rect, cam, t.chrome);
  if (!t.within) return a;
  const edge = onScreen(t.within.rect, cam).y;
  const chromeFoot = t.within.chrome === "areaHeader" ? edge + AREA_HEAD_PX * cam.zoom - 1 : edge;
  if (a.y - gap - barH >= chromeFoot) return a;
  const top = barAnchor(t.within.rect, cam, t.within.chrome).y;
  return top < a.y ? { x: a.x, y: top, w: a.w, h: a.y + a.h - top } : a;
}

/**
 * Where the bar goes for a selection at `anchor` (screen px), the bar `bar` big in a view `view` big: just above the
 * selection, lined up with its left edge, and always inside the view, sliding along its edges however far the
 * selection is (no higher than `minTop`, the strip the area switcher takes). It never jumps below the selection: with
 * no room above, it stays along the top edge over the selection's top, so panning moves it continuously. A bar wider
 * than the view keeps its left edge in.
 */
export function barPlace(anchor: Rect, bar: Size, view: Size, minTop = 0, margin = BAR_MARGIN, gap = BAR_GAP, avoid: Rect | null = null): { x: number; y: number } {
  const x = Math.max(margin, Math.min(anchor.x, view.w - bar.w - margin));
  const top = Math.max(margin, minTop);
  const at = { x, y: Math.max(top, Math.min(anchor.y - gap - bar.h, view.h - bar.h - margin)) };
  // clear of `avoid` (the minimap): left of it at the same height while the view has room there, else above it
  if (!avoid || !(at.x < avoid.x + avoid.w + gap && avoid.x < at.x + bar.w + gap && at.y < avoid.y + avoid.h + gap && avoid.y < at.y + bar.h + gap)) return at;
  const left = avoid.x - gap - bar.w;
  return left >= margin ? { ...at, x: left } : { ...at, y: Math.max(top, avoid.y - gap - bar.h) };
}

/**
 * Whether Esc on the landscape (or in the bar) clears the selection: only when something is selected, and only after
 * whatever opened over it has had the key. A peek (kept open or not) closes first, and an open menu, popover or dialog
 * closes first (keys.ts OVERLAYS); the next Esc clears the selection.
 */
export const escapeClears = (s: { selected: boolean; peek: boolean; overlay: boolean }): boolean => s.selected && !s.peek && !s.overlay;

/** Whether the bar shows its folded buttons on a second row: a view preference of this window, never part of landscape.json. */
export const BAR_EXTENDED_PREF = "mb.landscape.barExtended";

/** The remembered choice; false when there's none, or storage can't be read (readPref says why). */
export const readBarExtended = (store?: PrefStore): boolean => readPref<unknown>(BAR_EXTENDED_PREF, false, store) === true;

/** Remember the choice; false when storage can't keep it (it lasts this run, and writePref says why). */
export const saveBarExtended = (on: boolean, store?: PrefStore): boolean => writePref(BAR_EXTENDED_PREF, on, store);
