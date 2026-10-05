import type { DiffSource } from "./SourceControl";

/** A file or diff open in the editor. It keeps its own session, so it stays put while focus moves between panes. */
export interface OpenFile {
  sessionId: string;
  root: string;
  path: string;
  mode: "file" | "diff";
  /** Set when the file has changes: its status letter, and which diff to show. */
  status?: string;
  source?: DiffSource;
  /** A line to scroll to and mark; `at` changes each time it's asked for, so the same line can be revealed twice. */
  reveal?: { line: number; at: number };
}

export interface EditorState {
  tabs: OpenFile[];
  active: string | null;
}

export const EMPTY_EDITOR: EditorState = { tabs: [], active: null };
export const MAX_TABS = 24;

/** One tab per file per view: a staged diff and the working-tree diff of a file are different tabs, as in VS Code. */
export const tabKey = (f: OpenFile) =>
  `${f.root}:${f.path}:${f.source?.kind ?? "file"}:${
    f.source?.kind === "commit" ? f.source.sha : f.source && "staged" in f.source && f.source.staged ? "staged" : ""
  }`;

/** The file a tab shows. Its tabs share one editor buffer: the file's own tab and its diff flipped to File edit the same text. */
export const fileKey = (f: { root: string; path: string }) => `${f.root}:${f.path}`;

/**
 * Open a file in its own tab: one already open is activated (and updated);
 * past MAX_TABS the oldest tabs close — but never a tab of a file with
 * unsaved edits (`unsaved`: file keys), which would leave them with no tab to
 * save or discard them from.
 */
export function openTab(s: EditorState, f: OpenFile, unsaved: ReadonlySet<string> = new Set()): EditorState {
  const key = tabKey(f);
  const i = s.tabs.findIndex((t) => tabKey(t) === key);
  if (i >= 0) return { tabs: s.tabs.map((t, j) => (j === i ? { ...t, ...f } : t)), active: key };
  let excess = s.tabs.length + 1 - MAX_TABS;
  const kept = s.tabs.filter((t) => {
    if (excess <= 0 || unsaved.has(fileKey(t))) return true;
    excess--;
    return false;
  });
  return { tabs: [...kept, f], active: key };
}

/** The files whose last tab is among `closing` (tab keys): closing those tabs closes the files. */
export function filesClosing(tabs: OpenFile[], closing: readonly string[]): OpenFile[] {
  const shut = new Set(closing);
  const staying = new Set(tabs.filter((t) => !shut.has(tabKey(t))).map(fileKey));
  const files = new Map<string, OpenFile>();
  for (const t of tabs) if (shut.has(tabKey(t)) && !staying.has(fileKey(t))) files.set(fileKey(t), t);
  return [...files.values()];
}

/** Close a tab; closing the active one activates its neighbor, as VS Code does. */
export function closeTab(s: EditorState, key: string): EditorState {
  const i = s.tabs.findIndex((t) => tabKey(t) === key);
  if (i < 0) return s;
  const tabs = s.tabs.filter((_, j) => j !== i);
  const active = key !== s.active ? s.active : tabs.length ? tabKey(tabs[Math.min(i, tabs.length - 1)]) : null;
  return { tabs, active };
}

/** Change a tab in place (file ⇄ diff); its key is unchanged. */
export function updateTab(s: EditorState, key: string, change: Partial<OpenFile>): EditorState {
  return { ...s, tabs: s.tabs.map((t) => (tabKey(t) === key ? { ...t, ...change } : t)) };
}
