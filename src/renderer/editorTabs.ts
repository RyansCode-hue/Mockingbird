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

export interface Tab extends OpenFile {
  /** A preview tab is replaced by the next file opened with a single click; opening it for real keeps it. */
  preview: boolean;
}

export interface EditorState {
  tabs: Tab[];
  active: string | null;
}

export const EMPTY_EDITOR: EditorState = { tabs: [], active: null };
export const MAX_TABS = 12;

/** One tab per file per view: a staged diff and the working-tree diff of a file are different tabs, as in VS Code. */
export const tabKey = (f: OpenFile) =>
  `${f.root}:${f.path}:${f.source?.kind ?? "file"}:${f.source && "staged" in f.source && f.source.staged ? "staged" : ""}`;

/**
 * Open a file, VS Code-style: an open tab is activated (and updated); a preview
 * open replaces the current preview tab in place; past MAX_TABS the oldest
 * tab that isn't the new one closes.
 */
export function openTab(s: EditorState, f: OpenFile, preview: boolean): EditorState {
  const key = tabKey(f);
  const i = s.tabs.findIndex((t) => tabKey(t) === key);
  if (i >= 0) {
    const tabs = s.tabs.map((t, j) => (j === i ? { ...t, ...f, preview: t.preview && preview } : t));
    return { tabs, active: key };
  }
  const tab: Tab = { ...f, preview };
  const p = preview ? s.tabs.findIndex((t) => t.preview) : -1;
  const tabs = p >= 0 ? s.tabs.map((t, j) => (j === p ? tab : t)) : [...s.tabs, tab];
  return { tabs: tabs.length > MAX_TABS ? tabs.slice(-MAX_TABS) : tabs, active: key };
}

/** Close a tab; closing the active one activates its neighbor, as VS Code does. */
export function closeTab(s: EditorState, key: string): EditorState {
  const i = s.tabs.findIndex((t) => tabKey(t) === key);
  if (i < 0) return s;
  const tabs = s.tabs.filter((_, j) => j !== i);
  const active = key !== s.active ? s.active : tabs.length ? tabKey(tabs[Math.min(i, tabs.length - 1)]) : null;
  return { tabs, active };
}

/** Keep a tab: it stops being the preview tab. */
export function pinTab(s: EditorState, key: string): EditorState {
  return { ...s, tabs: s.tabs.map((t) => (tabKey(t) === key ? { ...t, preview: false } : t)) };
}

/** Change a tab in place (file ⇄ diff); its key is unchanged. */
export function updateTab(s: EditorState, key: string, change: Partial<OpenFile>): EditorState {
  return { ...s, tabs: s.tabs.map((t) => (tabKey(t) === key ? { ...t, ...change } : t)) };
}
