/**
 * The shortcuts sheet's rows (`?`, the top bar's "? Shortcuts"), said once. Every row is something this build does:
 * test/uiLandscapeFirstRun.test.ts drives each `id` in a real browser (?landscapeFirstRunAudit=k) and fails on a row
 * nothing drove, so a row is added here together with the step that proves it.
 *
 * A single letter (and `?`) works only while the landscape itself has the keyboard, never in a terminal or a text
 * field (Landscape.tsx, surfaceKey). ⌘ keys work from anywhere unless the row's handler says otherwise.
 */
export interface ShortcutRow {
  id: string;
  what: string;
  keys: string;
}

export interface ShortcutSection {
  title: string;
  rows: readonly ShortcutRow[];
}

export const SHORTCUTS: readonly ShortcutSection[] = [
  {
    title: "Move around",
    rows: [
      { id: "pan", what: "Pan", keys: "Space-drag · two fingers" },
      { id: "zoom", what: "Zoom", keys: "⌘ scroll · pinch" },
      { id: "zoomKeys", what: "Zoom in / out", keys: "⌘= / ⌘-" },
      { id: "fit", what: "Fit everything / 100%", keys: "⌘0 / ⌘1" },
      { id: "goTo", what: "Go to an area or workspace", keys: "⌘K" },
      { id: "nearest", what: "Nearest workspace that way", keys: "⌥ arrows" },
      { id: "tree", what: "Show or hide the area tree", keys: "⌘\\" },
    ],
  },
  {
    title: "Work",
    rows: [
      { id: "focus", what: "Focus the selected workspace", keys: "Enter · ⌘E" },
      { id: "back", what: "Back to the landscape", keys: "⌘E · ⌘Esc" },
      { id: "needs", what: "Next / previous that needs you", keys: "N / ⇧N" },
      { id: "waiting", what: "Next session waiting on you", keys: "⌥⇥" },
      { id: "peek", what: "Peek at a card", keys: "hover · Space holds" },
      { id: "files", what: "Files window", keys: "⌘B · ⇧⌘E" },
      { id: "changes", what: "Changes window", keys: "⌃⇧G" },
      { id: "search", what: "Search window", keys: "⇧⌘F" },
      { id: "run", what: "Run & debug window", keys: "⇧⌘D" },
      { id: "file", what: "Go to a file", keys: "⌘P" },
      { id: "panel", what: "Log panel", keys: "⌘J" },
    ],
  },
  {
    title: "Build",
    rows: [
      { id: "newHere", what: "New workspace here", keys: "right-click" },
      { id: "newDialog", what: "New session", keys: "⌘N" },
      { id: "several", what: "Select several", keys: "⇧-click · marquee" },
      { id: "makeArea", what: "Make area from selection", keys: "marquee, then M" },
      { id: "tidy", what: "Tidy the area", keys: "T" },
      { id: "undoTidy", what: "Undo a Tidy, while it says so", keys: "⌘Z" },
      { id: "stack", what: "Stack selected workspaces", keys: "⌘G" },
      { id: "clear", what: "Clear the selection", keys: "Esc" },
    ],
  },
];

/** The sheet's own key, driven with the rest; it has its line under the rows rather than a row. */
export const SHEET_KEY_ID = "sheet";

export const SHEET_FOOT = "Press ? on the landscape to open this. In a terminal, click the landscape's background first.";

/** Every row's id, and the sheet's own key: what the driven test must have driven. */
export const shortcutIds = (): string[] => [...SHORTCUTS.flatMap((s) => s.rows.map((r) => r.id)), SHEET_KEY_ID];
