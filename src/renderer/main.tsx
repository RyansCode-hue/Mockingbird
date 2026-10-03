import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TerminalPane, disposeTerm, focusTerm, applyTermTheme, fmtElapsed, shortReason, PaneDensity, PaneResize } from "./TerminalPane";
import { EditorDock, ExplorerTree } from "./FilePanel";
import { SourceControl, type DiffSource } from "./SourceControl";
import { SearchView, type SearchState } from "./SearchView";
import { QuickOpen } from "./QuickOpen";
import { EMPTY_EDITOR, closeTab, openTab, tabKey, updateTab } from "./editorTabs";
import { useFolderRefresh } from "./folderWatch";
import { SetupWizard } from "./SetupWizard";
import { CollaborateView } from "./Collaborate";
import { UpdatePanel } from "./UpdatePanel";
import { Snippet } from "./TranscriptSearch";
import { Pick, Select } from "./Menu";
import { cardMove, columnOf, orderColumns, pickBoard } from "./boardView";
import { DragLabel, beginDrag, cue, dragging, installDragListeners, overTarget, placeBeside, samePlace, sideOf, useDrag, type Side } from "./drag";
import { resetText, pctNow } from "./usageFormat";
import { LayoutIcon, FilesIcon, FolderIcon, ChevronIcon, SessionsIcon, SourceControlIcon, SearchIcon } from "./Icons";
import type { AgentKind, AgentCheck, SetupStatus, SessionInfo, SessionStatus, RepoEntry, Settings, ImportableConversation, WorktreeStateInfo, AdoWorkItem, AdoComment, RepoBranches, WorktreeEntry, UsageReport, AgentUsage, UsageLimit, UpdateProgress, UpdateOutcome, CollabRoom, TranscriptHit, AdoBoard, ModelCatalog } from "../shared/types";
import { slugBranch, sanitizeSegment, splitGroupKey, topOfKey, groupUngrouped } from "../shared/types";

declare global {
  interface Window {
    mb: any;
  }
}

type ModalKind = "new" | "import" | "help" | "restart" | "setup" | "update" | "quickopen" | null;
/** What the side bar shows, picked from the activity bar as in VS Code. */
type SideView = "sessions" | "explorer" | "scm" | "search";
const SIDE_VIEWS: { id: SideView; label: string; keys?: string; Icon: () => React.JSX.Element }[] = [
  { id: "sessions", label: "Sessions", Icon: SessionsIcon },
  { id: "explorer", label: "Explorer", keys: "⇧⌘E", Icon: FilesIcon },
  { id: "scm", label: "Source Control", keys: "⌃⇧G", Icon: SourceControlIcon },
  { id: "search", label: "Search", keys: "⇧⌘F", Icon: SearchIcon },
];
type Tab = "sessions" | "dashboard" | "worktracker" | "collaborate" | "settings";
const TAB_LABELS: Record<Tab, string> = {
  sessions: "Sessions",
  dashboard: "Dashboard",
  worktracker: "WorkTracker",
  collaborate: "Collaborate",
  settings: "Settings",
};
type ColsPref = number | "auto";

/**
 * Snap-layout templates, in the spirit of Windows' snap layouts: pick an
 * arrangement rather than a column count. `zones` are CSS grid areas
 * (row-start / col-start / row-end / col-end) assigned to panes in order.
 * A template only governs when the pane count matches its zone count —
 * with fewer panes the zones collapse so nothing empty holds space, with more
 * the extras flow into equal cells below.
 */
interface GridLayout {
  id: string;
  label: string;
  cols: number;
  rows: number;
  zones: string[];
}
const LAYOUTS: GridLayout[] = [
  { id: "cols-2", label: "Two columns", cols: 2, rows: 1, zones: ["1/1/2/2", "1/2/2/3"] },
  { id: "rows-2", label: "Two rows", cols: 1, rows: 2, zones: ["1/1/2/2", "2/1/3/2"] },
  { id: "cols-3", label: "Three columns", cols: 3, rows: 1, zones: ["1/1/2/2", "1/2/2/3", "1/3/2/4"] },
  { id: "big-left", label: "Big left, two stacked", cols: 2, rows: 2, zones: ["1/1/3/2", "1/2/2/3", "2/2/3/3"] },
  { id: "big-top", label: "Big top, two below", cols: 2, rows: 2, zones: ["1/1/2/3", "2/1/3/2", "2/2/3/3"] },
  { id: "quad", label: "Four quadrants", cols: 2, rows: 2, zones: ["1/1/2/2", "1/2/2/3", "2/1/3/2", "2/2/3/3"] },
];

/** Miniature of a layout's zones, drawn the way the snap-layout flyout shows them. */
function LayoutThumb({ layout }: { layout: GridLayout }) {
  return (
    <span
      className="lay-thumb"
      style={{
        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
      }}
    >
      {layout.zones.map((z, i) => (
        <i key={i} style={{ gridArea: z }} />
      ))}
    </span>
  );
}

function gridCols(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

function loadLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

/** Case-insensitive subsequence match for the palette. */
function fuzzy(q: string, s: string): boolean {
  const qq = q.toLowerCase();
  const ss = s.toLowerCase();
  let i = 0;
  for (const ch of ss) if (i < qq.length && ch === qq[i]) i++;
  return i === qq.length;
}

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [resumable, setResumable] = useState<SessionInfo[]>([]);
  const [shown, setShown] = useState<string[]>(() => loadLS("mb.shown", []));
  const [focused, setFocused] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [newLaunch, setNewLaunch] = useState<LaunchKind>("claude");
  // seeds New Session's Group field — set to "top/sub" by a workspace's + button
  const [newGroup, setNewGroup] = useState("");
  // a lone pane's "+" promotes it to a workspace, but only once the new session
  // actually exists — cancelling the dialog must leave the pane exactly as it was
  const [pendingWs, setPendingWs] = useState<{ id: string; key: string } | null>(null);
  const [tab, setTab] = useState<Tab>(() => loadLS<Tab>("mb.tab", "sessions"));
  // a room to open, from a permission-request notification (the counter re-triggers the same room)
  const [focusRoom, setFocusRoom] = useState<{ id: string; n: number } | null>(null);
  useEffect(
    () =>
      window.mb.onCollabFocus((id: string) => {
        setTab("collaborate");
        setFocusRoom((f) => ({ id, n: (f?.n ?? 0) + 1 }));
      }),
    []
  );
  useEffect(() => localStorage.setItem("mb.tab", JSON.stringify(tab)), [tab]);
  const [theme, setTheme] = useState<"dark" | "light">(() => loadLS<"dark" | "light">("mb.theme", "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mb.theme", JSON.stringify(theme));
    applyTermTheme(theme === "light"); // xterm colors follow the app theme
  }, [theme]);
  const [hooksOk, setHooksOk] = useState(true);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{ kind: "session" | "group" | "sub"; key: string; value: string } | null>(null);
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(() => loadLS("mb.side", false));
  const [colsPref, setColsPref] = useState<ColsPref>(() => loadLS<ColsPref>("mb.cols", "auto"));
  // chosen snap layout per group ("" = auto). Kept per group because a ticket
  // with two panes and one with five want different arrangements.
  const [layouts, setLayouts] = useState<Record<string, string>>(() => loadLS("mb.layout", {}));
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadLS<string[]>("mb.collapsed", [])));
  useEffect(() => localStorage.setItem("mb.collapsed", JSON.stringify([...collapsed])), [collapsed]);
  // per-group memory of which sessions were visible, so switching back restores the subset
  const [groupLayouts, setGroupLayouts] = useState<Record<string, string[]>>(() =>
    loadLS<Record<string, string[]>>("mb.groupLayouts", {})
  );
  useEffect(() => localStorage.setItem("mb.groupLayouts", JSON.stringify(groupLayouts)), [groupLayouts]);
  // active tab per workspace (sub-group) pane, keyed "top/sub" — persisted
  const [wsTabs, setWsTabs] = useState<Record<string, string>>(() => loadLS("mb.wsTabs", {}));
  useEffect(() => localStorage.setItem("mb.wsTabs", JSON.stringify(wsTabs)), [wsTabs]);
  const [closeDlg, setCloseDlg] = useState<{ session: SessionInfo; wt: WorktreeStateInfo } | null>(null);
  const [groupDlg, setGroupDlg] = useState<SessionInfo | null>(null);
  // group/workspace renames use a dialog: inline editing broke because the same
  // edit field rendered in two places (sidebar + workspace tab strip) and the
  // second mount stole focus from the first, instantly closing it
  const [renameDlg, setRenameDlg] = useState<{ kind: "group" | "sub"; key: string; initial: string } | null>(null);

  const applyRename = async (v: string) => {
    if (!renameDlg) return;
    // "top/sub" is one key in the store, so both kinds are the same rename:
    // renameGroup is prefix-aware and remaps every member in a single pass
    const next =
      renameDlg.kind === "group"
        ? sanitizeSegment(v)
        : `${topOfKey(renameDlg.key)}/${sanitizeSegment(v)}`;
    if (!next) return;
    if (renameDlg.key === "ungrouped") {
      // "ungrouped" is the absence of a group, not a stored one: naming it groups its sessions
      for (const m of groupUngrouped(workSessions, next)) await window.mb.setGroup(m.id, m.group);
      migrateGroupKeys(renameDlg.key, next);
    } else if (next !== renameDlg.key) {
      await window.mb.renameGroup(renameDlg.key, next);
      migrateGroupKeys(renameDlg.key, next);
    }
    setRenameDlg(null);
    refresh();
  };
  const [statusPop, setStatusPop] = useState<SessionStatus | null>(null);
  const [update, setUpdate] = useState<{ latest: string; url: string; newer: boolean; source: "release" | "branch" } | null>(null);
  const [upd, setUpd] = useState<UpdateProgress>({ state: "idle", done: [], log: [] });
  const drag = useDrag();
  useEffect(() => installDragListeners(), []);
  // Collaborate models waiting on an approval, per room — badged on the tab wherever you are
  const [roomAsks, setRoomAsks] = useState<Record<string, number>>({});
  useEffect(() => {
    window.mb.collabList().then((rooms: CollabRoom[] | { error: string }) => {
      if (Array.isArray(rooms)) setRoomAsks(Object.fromEntries(rooms.map((r) => [r.id, r.pending?.length ?? 0])));
    });
    return window.mb.onCollabChanged((r: CollabRoom) => setRoomAsks((p) => ({ ...p, [r.id]: r.pending?.length ?? 0 })));
  }, []);
  const asksWaiting = Object.values(roomAsks).reduce((a, b) => a + b, 0);
  const [updOutcome, setUpdOutcome] = useState<(UpdateOutcome & { restoreErrors?: string[] }) | null>(null);
  useEffect(() => {
    window.mb.updateStatus().then((p: UpdateProgress) => setUpd(p));
    return window.mb.onUpdateProgress((p: UpdateProgress) => setUpd(p));
  }, []);
  // After an update restart: say how it went, and bring back the sessions that were open
  useEffect(() => {
    window.mb.updateOutcome().then(async (o: UpdateOutcome | null) => {
      if (!o) return;
      const restoreErrors: string[] = [];
      for (const id of o.sessions) {
        const r = await window.mb.relaunchSession(id);
        if (r?.error) restoreErrors.push(r.error);
      }
      setUpdOutcome({ ...o, restoreErrors });
      refresh();
    });
  }, []);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [settingsJump, setSettingsJump] = useState<{ section: SettingsSection; n: number } | null>(null);
  const openControlRoom = () => {
    setSettingsJump((p) => ({ section: "control", n: (p?.n ?? 0) + 1 }));
    setTab("settings");
  };
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    window.mb.appVersion().then((v: string) => setAppVersion(v));
  }, []);
  const [sideView, setSideView] = useState<SideView>(() => loadLS<SideView>("mb.sideView", "sessions"));
  useEffect(() => localStorage.setItem("mb.sideView", JSON.stringify(sideView)), [sideView]);
  const [sideW, setSideW] = useState<number>(() => loadLS("mb.sideW", 264));
  useEffect(() => localStorage.setItem("mb.sideW", JSON.stringify(sideW)), [sideW]);
  const [editor, setEditor] = useState(EMPTY_EDITOR);
  const [search, setSearch] = useState<SearchState>(() => ({ q: "", ...loadLS("mb.search", { scope: "conversations", regex: false, matchCase: false }) }));
  useEffect(() => localStorage.setItem("mb.search", JSON.stringify({ scope: search.scope, regex: search.regex, matchCase: search.matchCase })), [search.scope, search.regex, search.matchCase]);
  const [searchFocus, setSearchFocus] = useState(0);
  /** Show a side bar view, from anywhere: the side bar lives on the Sessions tab. */
  const showView = (v: SideView) => {
    setTab("sessions");
    setSideView(v);
    setSideCollapsed(false);
    if (v === "search") setSearchFocus((n) => n + 1);
  };

  // persist grid arrangement across restarts (design: Interactions & Behavior)
  useEffect(() => localStorage.setItem("mb.shown", JSON.stringify(shown)), [shown]);
  useEffect(() => localStorage.setItem("mb.cols", JSON.stringify(colsPref)), [colsPref]);
  useEffect(() => localStorage.setItem("mb.layout", JSON.stringify(layouts)), [layouts]);
  useEffect(() => localStorage.setItem("mb.side", JSON.stringify(sideCollapsed)), [sideCollapsed]);

  /** Put a session (dragged from the grid or the sidebar) beside a pane in the grid. */
  const reorder = (srcId: string, targetId: string, side: Side = "before") =>
    setShown((p) => placeBeside(p.includes(srcId) ? p : [...p, srcId], srcId, targetId, side));

  // inline editing is session titles only — group and workspace names are
  // renamed through RenameDialog (a second mounted input stole its focus)
  const commitEdit = async () => {
    if (!editing) return;
    const v = editing.value.trim();
    if (v) await window.mb.renameSession(editing.key, v);
    setEditing(null);
    refresh();
  };

  /** Remove a sub-group without touching its sessions — they move up into the group. */
  const dissolveSub = async (top: string, list: SessionInfo[]) => {
    await Promise.all(list.map((s) => window.mb.setGroup(s.id, top)));
    refresh();
  };

  /** Auto-name for a workspace created by dropping one session onto another. */
  const nextSubName = (top: string): string => {
    const subs = new Set(
      workSessions.filter((s) => topOf(s) === top).map((s) => subOf(s)).filter(Boolean)
    );
    if (!subs.has("tabs")) return "tabs";
    let i = 2;
    while (subs.has(`tabs-${i}`)) i++;
    return `tabs-${i}`;
  };

  const refresh = async (): Promise<SessionInfo[]> => {
    const live: SessionInfo[] = await window.mb.listSessions();
    setSessions(live);
    setResumable(await window.mb.resumableSessions());
    return live;
  };

  // First launch opens the setup wizard. Installs that predate it (the help
  // popup was already seen) are marked set up without being interrupted.
  useEffect(() => {
    window.mb.getSettings().then(async (s: Settings) => {
      if (s.setupDone) return;
      if (loadLS("mb.helpSeen", false)) await window.mb.setSettings({ ...s, setupDone: true });
      else {
        localStorage.setItem("mb.helpSeen", "true");
        setModal("setup");
      }
    });
  }, []);

  useEffect(() => {
    refresh();
    window.mb.hooksInstalled().then((ok: boolean) => setHooksOk(ok));
    // note: `shown` is deliberately NOT pruned against the live list — relaunch
    // reuses session ids, so a restored session lands back in its old grid slot
    const off = window.mb.onSessionsChanged((s: SessionInfo[]) => setSessions(s));
    const offUi = window.mb.onUiCommand((cmd: string, arg?: string) => {
      if (cmd === "new-session") setModal("new");
      if (cmd === "focus-session" && arg) jumpToRef.current(arg);
    });
    const offUpd = window.mb.onUpdateAvailable((u: any) => u?.newer && setUpdate(u));
    window.mb.usageGet().then((u: UsageReport | { error: string }) => !("error" in u) && setUsage(u));
    const offUsage = window.mb.onUsageChanged((u: UsageReport) => setUsage(u));
    return () => {
      offUsage();
      off();
      offUi();
      offUpd();
    };
  }, []);

  const groupKeyOf = (s: SessionInfo) => s.taskGroup ?? "ungrouped";
  // sub-groups are path-style: "5038/backend" → group 5038, sub-group backend
  const topOf = (s: SessionInfo) => splitGroupKey(groupKeyOf(s)).top;
  const subOf = (s: SessionInfo) => splitGroupKey(groupKeyOf(s)).sub;

  // the grid is group-exclusive at the TOP level: every shown session belongs
  // to the active group; sub-groups act as tabs within it
  const activeGroup = useMemo(() => {
    const first = shown.map((id) => sessions.find((s) => s.id === id)).find(Boolean);
    return first ? topOf(first) : null;
  }, [shown, sessions]);

  /** Carry a group's remembered UI state across a rename — these registries are
   *  keyed by group path, so without this a rename silently loses the group's
   *  layout, its workspaces' active tabs, and its collapsed state. */
  const migrateGroupKeys = (oldKey: string, newKey: string) => {
    const remap = <T,>(rec: Record<string, T>): Record<string, T> => {
      const out: Record<string, T> = {};
      for (const [k, v] of Object.entries(rec)) {
        out[k === oldKey || k.startsWith(oldKey + "/") ? newKey + k.slice(oldKey.length) : k] = v;
      }
      return out;
    };
    setGroupLayouts(remap);
    setWsTabs(remap);
    setCollapsed((prev) => {
      if (!prev.has(oldKey)) return prev;
      const next = new Set(prev);
      next.delete(oldKey);
      next.add(topOfKey(newKey));
      return next;
    });
  };

  const collapseOthers = (g: string) =>
    setCollapsed(new Set([...new Set(sessions.map(topOf))].filter((k) => k !== g)));

  // brief slide-in when the grid swaps to a different group (reduced-motion users get none)
  const prevGroup = useRef<string | null>(null);
  const [sliding, setSliding] = useState(false);
  useEffect(() => {
    const prev = prevGroup.current;
    prevGroup.current = activeGroup;
    if (activeGroup && prev && activeGroup !== prev) {
      setSliding(true);
      const t = setTimeout(() => setSliding(false), 260);
      return () => clearTimeout(t);
    }
  }, [activeGroup]);

  // record the active group's visible subset whenever it changes
  useEffect(() => {
    if (!activeGroup || shown.length === 0) return;
    setGroupLayouts((prev) => {
      const cur = prev[activeGroup];
      if (cur && cur.length === shown.length && cur.every((id, i) => id === shown[i])) return prev;
      return { ...prev, [activeGroup]: shown };
    });
  }, [shown, activeGroup]);

  /** A group's remembered layout, pruned to sessions that still exist in it. */
  const rememberedLayout = (g: string): string[] => {
    const ids = sessions.filter((x) => topOf(x) === g).map((x) => x.id);
    return (groupLayouts[g] ?? []).filter((id) => ids.includes(id));
  };

  /** Show a session — same group appends; a different group swaps the grid to
   *  that group's remembered layout (plus the clicked session). */
  const showSession = (s: SessionInfo) => {
    const g = topOf(s);
    if (activeGroup && g !== activeGroup) {
      setZoomed(null);
      const remembered = rememberedLayout(g);
      setShown(remembered.length ? [...new Set([...remembered, s.id])] : [s.id]);
      collapseOthers(g);
    } else {
      setShown((p) => (p.includes(s.id) ? p : [...p, s.id]));
    }
  };

  const hide = (id: string) => {
    setShown((p) => p.filter((x) => x !== id));
    if (zoomed === id) setZoomed(null);
  };

  /**
   * A workspace's sidebar folder follows the grid — open while it's shown,
   * closed once minimized. The chevron only peeks until the next show/minimize.
   */
  const folderFollowsGrid = (list: SessionInfo[]) =>
    setWsOpen((p) => {
      const keys = list.map((s) => s.taskGroup).filter((g): g is string => !!g && splitGroupKey(g).sub !== null);
      if (!keys.some((k) => k in p)) return p;
      const n = { ...p };
      for (const k of keys) delete n[k];
      return n;
    });

  /** Minimize a whole workspace (all member sessions) from the grid at once. */
  const hideSessions = (list: SessionInfo[]) => {
    setShown((p) => p.filter((id) => !list.some((s) => s.id === id)));
    if (zoomed && list.some((s) => s.id === zoomed)) setZoomed(null);
    folderFollowsGrid(list);
  };

  const jumpToSession = (s: SessionInfo) => {
    if (s.debrief) {
      setTab("worktracker"); // debriefs live on their own tab, not the grid
    } else {
      setTab("sessions");
      showSession(s);
      const sub = subOf(s);
      if (sub) setWsTabs((p) => ({ ...p, [`${topOf(s)}/${sub}`]: s.id })); // front its workspace tab
    }
    setFocused(s.id);
    setTimeout(() => focusTerm(s.id), 50);
  };
  const jumpTo = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (s) jumpToSession(s);
  };
  // the ui:command listener is registered once, so it must not capture jumpTo
  // directly — that closure would search the first render's empty session list
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;

  // safety net: if a stale persisted layout mixes groups, keep only the first group's panes
  useEffect(() => {
    setShown((prev) => {
      const first = prev.map((id) => sessions.find((s) => s.id === id)).find(Boolean);
      if (!first) return prev;
      const g = topOf(first);
      const pruned = prev.filter((id) => {
        const s = sessions.find((x) => x.id === id);
        return !s || topOf(s) === g; // unknown ids stay resumable into their slot
      });
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [sessions]);

  // debrief sessions live on the WorkTracker tab, everything else on the grid
  const workSessions = useMemo(() => sessions.filter((s) => !s.debrief), [sessions]);
  const debriefSessions = useMemo(() => sessions.filter((s) => s.debrief), [sessions]);

  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    return q
      ? workSessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            (s.ticketTitle ?? "").toLowerCase().includes(q) ||
            (s.ticketId ?? "").includes(q) ||
            (s.branch ?? "").toLowerCase().includes(q)
        )
      : workSessions;
  }, [workSessions, filter]);

  const gridSessions = zoomed
    ? sessions.filter((s) => s.id === zoomed)
    : shown.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s);

  // grid cells: plain sessions render individually; a sub-group renders as ONE
  // workspace pane with tabs (cmux-style)
  type GridCell = { kind: "session"; s: SessionInfo } | { kind: "workspace"; sub: string; list: SessionInfo[] };
  const cells: GridCell[] = useMemo(() => {
    if (zoomed) return gridSessions.map((s) => ({ kind: "session" as const, s }));
    const out: GridCell[] = [];
    const seen = new Set<string>();
    for (const s of gridSessions) {
      const sub = subOf(s);
      if (!sub) out.push({ kind: "session", s });
      else if (!seen.has(sub)) {
        seen.add(sub);
        // tabs are the workspace's members that are in the grid, so closing a
        // tab hides just that session; the pane goes when its last tab does
        out.push({
          kind: "workspace",
          sub,
          list: workSessions.filter((x) => topOf(x) === topOf(s) && subOf(x) === sub && shown.includes(x.id)),
        });
      }
    }
    return out;
  }, [gridSessions, workSessions, zoomed, shown]);

  // the grid grows with the cell count — equal cells, no filler tiles
  // the active group's chosen template, applied only when it fits the panes
  const layout = useMemo(() => {
    const id = activeGroup ? layouts[activeGroup] : layouts[""];
    const l = LAYOUTS.find((x) => x.id === id);
    return !zoomed && l && l.zones.length === cells.length ? l : null;
  }, [layouts, activeGroup, cells.length, zoomed]);

  const curLayoutId = (activeGroup ? layouts[activeGroup] : layouts[""]) ?? "";
  const cols = zoomed
    ? 1
    : layout
      ? layout.cols
      : colsPref === "auto"
        ? gridCols(Math.max(1, cells.length))
        : colsPref;
  const rows = layout ? layout.rows : Math.max(1, Math.ceil(Math.max(1, cells.length) / cols));
  // pane density follows column count (design 1b); a fullscreened pane is instrumented
  const density: PaneDensity = zoomed ? "max" : cols >= 4 ? "min" : cols === 3 ? "std" : "max";

  // ---- window-style pane resizing: grab a pane's own right edge / bottom edge /
  // corner; the grid tracks adjust so neighbors absorb the change ----
  const gridRef = useRef<HTMLDivElement>(null);
  const [colSizes, setColSizes] = useState<number[]>([]);
  const [rowSizes, setRowSizes] = useState<number[]>([]);

  const loadTracks = (key: string, n: number): number[] => {
    const v = loadLS<number[]>(key, []);
    return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && x > 0)
      ? v
      : Array(n).fill(1);
  };
  useEffect(() => setColSizes(loadTracks(`mb.cw.${cols}`, cols)), [cols]);
  useEffect(() => setRowSizes(loadTracks(`mb.rh.${rows}`, rows)), [rows]);
  useEffect(() => {
    if (colSizes.length === cols) localStorage.setItem(`mb.cw.${cols}`, JSON.stringify(colSizes));
  }, [colSizes, cols]);
  useEffect(() => {
    if (rowSizes.length === rows) localStorage.setItem(`mb.rh.${rows}`, JSON.stringify(rowSizes));
  }, [rowSizes, rows]);

  /** Dragging pane (index) in `axis` grows/shrinks it against its next neighbor. */
  const startTrackDrag = (axis: "col" | "row", index: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    const sizes = axis === "col" ? colSizes : rowSizes;
    const count = axis === "col" ? cols : rows;
    if (!grid || sizes.length !== count || index >= count - 1) return;
    const totalPx = (axis === "col" ? grid.clientWidth : grid.clientHeight) - 16 - 8 * (count - 1);
    const totalFr = sizes.reduce((a, b) => a + b, 0);
    const pxPerFr = totalPx / totalFr;
    const start = axis === "col" ? e.clientX : e.clientY;
    const a0 = sizes[index];
    const b0 = sizes[index + 1];
    const minFr = (axis === "col" ? 150 : 90) / pxPerFr; // keep panes usable
    if (a0 + b0 <= 2 * minFr) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    document.body.classList.add(axis === "col" ? "rz-x" : "rz-y");
    const setSizes = axis === "col" ? setColSizes : setRowSizes;
    const onMove = (ev: PointerEvent) => {
      const d = ((axis === "col" ? ev.clientX : ev.clientY) - start) / pxPerFr;
      const na = Math.min(Math.max(a0 + d, minFr), a0 + b0 - minFr);
      const nb = a0 + b0 - na;
      setSizes((prev) => prev.map((v, i) => (i === index ? na : i === index + 1 ? nb : v)));
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("rz-x", "rz-y");
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    // capture can be lost to an OS gesture or app switch — without this the
    // resize cursor stays stuck and the handle keeps resizing with no button held
    target.addEventListener("pointercancel", onUp);
  };

  const equalizeTracks = () => {
    setColSizes(Array(cols).fill(1));
    setRowSizes(Array(rows).fill(1));
  };

  // sidebar structure: top-level groups, each with sessions bucketed by sub-group
  const groups = useMemo(() => {
    const g = new Map<string, SessionInfo[]>();
    for (const s of visible) {
      const key = topOfKey(s.taskGroup ?? "ungrouped");
      g.set(key, [...(g.get(key) ?? []), s]);
    }
    return [...g.entries()];
  }, [visible]);

  // Workspace folders in the sidebar: explicitly opened/closed ones remember it;
  // the rest are open exactly while the workspace is in the grid.
  const [wsOpen, setWsOpen] = useState<Record<string, boolean>>(() => loadLS("mb.wsOpen", {}));
  useEffect(() => localStorage.setItem("mb.wsOpen", JSON.stringify(wsOpen)), [wsOpen]);

  const bySub = (list: SessionInfo[]): [string, SessionInfo[]][] => {
    const m = new Map<string, SessionInfo[]>();
    for (const s of list) {
      const sub = subOf(s) ?? "";
      m.set(sub, [...(m.get(sub) ?? []), s]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])); // "" (no sub) first
  };

  /** Reveal a workspace (sub-group) pane: within the active group its sessions
   *  are added to the grid; from another group the grid swaps to it.
   *  No focusTerm — see focusGroup (it would kill double-click rename). */
  const focusSub = (top: string, list: SessionInfo[]) => {
    setZoomed(null);
    folderFollowsGrid(list);
    if (activeGroup && top !== activeGroup) {
      setShown(list.map((s) => s.id));
      collapseOthers(top);
    } else {
      setShown((p) => [...p, ...list.map((s) => s.id).filter((id) => !p.includes(id))]);
    }
    if (list[0]) setFocused(list[0].id);
  };

  const counts = useMemo(() => {
    const c = { working: 0, waiting: 0, idle: 0, dead: 0 };
    for (const s of workSessions) c[s.status]++;
    return c;
  }, [workSessions]);

  const groupTitle = (key: string, list: SessionInfo[]): string => {
    if (key === "ungrouped" || key === "assistant") return key;
    if (!/^\d+$/.test(key.replace(/^#/, ""))) return key; // custom-renamed group
    const t = list.find((s) => s.ticketTitle)?.ticketTitle;
    return `#${key.replace(/^#/, "")}${t ? ` ${t}` : ""}`;
  };

  // existing group keys, for move targets and the New-Session picker
  const groupKeys = useMemo(
    () => [...new Set(sessions.map((s) => s.taskGroup).filter((g): g is string => !!g && g !== "assistant"))],
    [sessions]
  );

  // single-click actions on group/workspace headers are deferred so a
  // double-click (rename) can cancel them — otherwise the first click
  // collapses other groups and the layout shift moves the label away from
  // the cursor before the double-click completes
  const pendingClick = useRef<number | null>(null);
  const deferClick = (fn: () => void) => {
    if (pendingClick.current) clearTimeout(pendingClick.current);
    pendingClick.current = window.setTimeout(() => {
      pendingClick.current = null;
      fn();
    }, 250);
  };
  const cancelClick = () => {
    if (pendingClick.current) {
      clearTimeout(pendingClick.current);
      pendingClick.current = null;
    }
  };

  /** Click a group header: switching groups restores that group's remembered
   *  layout; clicking the already-active group's header re-shows all of it.
   *  NOTE: no focusTerm here — stealing keyboard focus right after a header
   *  click kills the double-click rename input (it blurs and closes). */
  const focusGroup = (key: string, list: SessionInfo[]) => {
    setZoomed(null);
    const remembered = key === activeGroup ? [] : rememberedLayout(key);
    const ids = remembered.length ? remembered : list.map((s) => s.id);
    setShown(ids);
    collapseOthers(key);
    const first = ids[0] ?? list[0]?.id;
    if (first) setFocused(first);
  };

  /** Drop handler shared by group headers and rows — moves the dragged session. */
  const titleOf = (s: SessionInfo) => s.ticketTitle ?? s.title;
  /** The drop cue for moving a dragged sidebar/pane session into `group` (null = out of any group). */
  const intoGroupTarget = (targetKey: string, group: string | null, name: string) => {
    const src = sessions.find((x) => x.id === dragging("text/mb-session"));
    if (!src || (src.taskGroup ?? null) === group) return null; // already there
    return { key: targetKey, outcome: group === null ? `Move ${titleOf(src)} out of its group` : `Move ${titleOf(src)} into ${name}` };
  };

  const dropToGroup = (e: React.DragEvent, group: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const src = e.dataTransfer.getData("text/mb-session");
    if (src) window.mb.setGroup(src, group);
  };

  const restoreAll = async () => {
    const failures: string[] = [];
    for (const s of resumable) {
      const info = await window.mb.relaunchSession(s.id);
      if (info?.error) failures.push(`✕ ${s.title}: ${info.error}`);
    }
    await refresh();
    if (failures.length) alert(`Some sessions couldn't be restored:\n\n${failures.join("\n")}`);
  };

  // ---- session close flow (design 1e) ----
  const forceClose = async (s: SessionInfo, forget: boolean) => {
    await window.mb.killSession(s.id, forget);
    disposeTerm(s.id);
    hide(s.id);
    refresh();
  };

  /** Close a session; dirty or unpushed worktrees get the dialog, clean ones close silently. */
  const requestClose = async (s: SessionInfo) => {
    const hasWorktree = s.repoPath && s.branch && s.cwd !== s.repoPath;
    if (!hasWorktree) return forceClose(s, true);
    const st: WorktreeStateInfo | { error: string } = await window.mb.worktreeState(s.cwd);
    if (!st || "error" in st) return forceClose(s, true); // worktree already gone
    if (!st.dirty && st.ahead === 0) return forceClose(s, true);
    setCloseDlg({ session: s, wt: st });
  };

  const resumeDead = async (s: SessionInfo) => {
    await window.mb.killSession(s.id, false); // drop the dead pty, keep the store entry
    disposeTerm(s.id);
    const info = await window.mb.relaunchSession(s.id);
    if (info?.error) return alert(`Couldn't resume: ${info.error}`);
    hide(s.id);
    await refresh();
    if (info) jumpToSession(info);
  };

  // ⌥⇥ cycles waiting sessions, oldest wait first — the primary motion for a busy grid
  const cycleWaiting = () => {
    const waiting = sessions
      .filter((s) => s.status === "waiting")
      .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0));
    if (!waiting.length) return;
    const i = waiting.findIndex((s) => s.id === focused);
    jumpTo(waiting[(i + 1) % waiting.length].id);
  };

  // ---- keyboard layer (design 1c) ----
  const kb = useRef<(e: KeyboardEvent) => void>();
  kb.current = (e: KeyboardEvent) => {
    const cmd = e.metaKey;
    if (paletteOpen) {
      if (cmd && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(false);
      }
      return; // palette input owns the rest
    }
    const handled = () => {
      e.preventDefault();
      e.stopPropagation(); // keep handled combos out of xterm
    };
    if (cmd && e.key === "k") {
      handled();
      setPaletteOpen(true);
      return;
    }
    if (cmd && e.key === "/") {
      handled();
      setModal((m) => (m === "help" ? null : "help"));
      return;
    }
    if (cmd && !e.shiftKey && !e.ctrlKey && e.key === "n") {
      handled();
      setModal("new");
      return;
    }
    if (cmd && !e.shiftKey && !e.ctrlKey && e.key === "b" && tab === "sessions") {
      handled();
      setSideCollapsed((c) => !c);
      return;
    }
    if (cmd && !e.ctrlKey && e.key.toLowerCase() === "p" && !modal) {
      handled();
      if (e.shiftKey) setPaletteOpen(true);
      else {
        setTab("sessions");
        setModal("quickopen");
      }
      return;
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "f") {
      handled();
      showView("search");
      return;
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "e") {
      handled();
      showView("explorer");
      return;
    }
    if (e.ctrlKey && e.shiftKey && !cmd && e.key.toLowerCase() === "g") {
      handled();
      showView("scm");
      return;
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "b") {
      handled();
      openControlRoom();
      return;
    }
    if (cmd && !e.shiftKey && e.key === "e" && (focused || zoomed)) {
      handled();
      setZoomed(zoomed ? null : focused);
      return;
    }
    if (e.key === "Escape" && zoomed && !modal && !closeDlg && !groupDlg) {
      handled();
      setZoomed(null);
      return;
    }
    if (cmd && e.ctrlKey && /^[1-4]$/.test(e.key)) {
      handled();
      setColsPref(parseInt(e.key, 10));
      return;
    }
    if (cmd && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
      // by CELL, not by session: a workspace pane holding 3 sessions is one
      // number, which is what the pane's own ⌘n badge shows
      const cell = cells[parseInt(e.key, 10) - 1];
      const target = cell && (cell.kind === "session" ? cell.s : (wsTabs[`${topOf(cell.list[0])}/${cell.sub}`] ? cell.list.find((x) => x.id === wsTabs[`${topOf(cell.list[0])}/${cell.sub}`]) : null) ?? cell.list[0]);
      if (target) {
        handled();
        jumpTo(target.id);
      }
      return;
    }
    if (e.altKey && e.key === "Tab") {
      handled();
      cycleWaiting();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => kb.current?.(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const editInput = (
    <input
      className="filter"
      style={{ marginBottom: 2, padding: "3px 6px" }}
      autoFocus
      value={editing?.value ?? ""}
      onChange={(e) => setEditing(editing && { ...editing, value: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitEdit();
        if (e.key === "Escape") setEditing(null);
      }}
      onBlur={commitEdit}
      onClick={(e) => e.stopPropagation()}
    />
  );

  /** Open a search hit wherever it lives; returns why it couldn't be opened. */
  const openTranscript = async (h: TranscriptHit): Promise<string | null> => {
    if (h.open.how === "pane") {
      jumpTo(h.open.sessionId);
      return null;
    }
    if (h.open.how === "room") {
      setTab("collaborate");
      const roomId = h.open.roomId;
      setFocusRoom((f) => ({ id: roomId, n: (f?.n ?? 0) + 1 }));
      return null;
    }
    const info =
      h.open.how === "previous"
        ? await window.mb.relaunchSession(h.open.sessionId)
        : await window.mb.createSession({ repoPath: h.cwd || null, useWorktree: false, resumeSessionId: h.id, agent: h.agent, title: h.title.slice(0, 60) });
    if (!info) return "That session is no longer saved.";
    if (info.error) return info.error;
    await refresh();
    jumpToSession(info);
    return null;
  };

  const onCreated = async (s: SessionInfo) => {
    if (pendingWs) {
      await window.mb.setGroup(pendingWs.id, pendingWs.key); // the lone pane joins its new workspace
      setPendingWs(null);
    }
    refresh();
    jumpToSession(s);
    setModal(null);
  };

  /** "+" on a pane that isn't in a workspace yet: open a second tab beside it. */
  const startWorkspaceFrom = (s: SessionInfo) => {
    const top = topOf(s);
    const key = `${top}/${nextSubName(top)}`;
    setPendingWs({ id: s.id, key });
    setNewGroup(key);
    setNewLaunch("claude");
    setModal("new");
  };

  const focusedSession = sessions.find((s) => s.id === focused) ?? null;

  /** Open a file of the focused session's folder in its own editor tab. */
  const openInEditor = (path: string, o: { mode?: "file" | "diff"; status?: string; source?: DiffSource; line?: number | null } = {}) => {
    const s = focusedSession;
    if (!s) return;
    const reveal = o.line ? { line: o.line, at: Date.now() } : undefined;
    setEditor((e) => openTab(e, { sessionId: s.id, root: s.cwd, path, mode: o.mode ?? "file", status: o.status, source: o.source, reveal }));
  };
  const activeTab = editor.tabs.find((t) => tabKey(t) === editor.active) ?? null;
  const activePath = activeTab && focusedSession && activeTab.root === focusedSession.cwd ? activeTab.path : null;

  // the Source Control badge: the focused folder's uncommitted files (the same
  // cached state the pane rails read, so this costs no extra git work)
  const [scmCount, setScmCount] = useState(0);
  const focusedCwd = tab === "sessions" ? focusedSession?.cwd ?? null : null;
  const scmSeq = useRef(0);
  const loadScmCount = () => {
    const n = ++scmSeq.current;
    if (!focusedCwd) return setScmCount(0);
    window.mb.worktreeState(focusedCwd).then((r: WorktreeStateInfo | { error: string }) => n === scmSeq.current && setScmCount("error" in r ? 0 : r.dirtyFiles));
  };
  useEffect(loadScmCount, [focusedCwd]);
  useFolderRefresh(focusedCwd, loadScmCount);

  // the main process watches live sessions' repository folders, so views of
  // them refresh on a change (folders outside a repository — home, WorkTracker
  // — are left to the slower poll rather than watched recursively)
  const watchKey = sessions
    .filter((s) => s.repoPath && s.status !== "dead")
    .map((s) => s.id)
    .sort()
    .join(",");
  useEffect(() => {
    window.mb.watchFolders(watchKey ? watchKey.split(",") : []);
  }, [watchKey]);

  const startSideResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = sideW;
    const move = (ev: PointerEvent) => setSideW(Math.min(640, Math.max(200, start + (ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("fp-resizing");
    };
    document.body.classList.add("fp-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">
          <span className="mark">🪶</span>
          <span className="name">Mockingbird</span>
          {appVersion && <span className="ver">v{appVersion}</span>}
        </span>
        <span className="tabs">
          {(["sessions", "dashboard", "worktracker", "collaborate", "settings"] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
              {t === "worktracker" && debriefSessions.some((s) => s.status === "waiting") && (
                <span className="dot sm waiting" style={{ marginLeft: 6 }} />
              )}
              {t === "collaborate" && asksWaiting > 0 && (
                <span className="tab-badge" title={`${asksWaiting} request${asksWaiting === 1 ? "" : "s"} from models waiting on you`}>
                  {asksWaiting}
                </span>
              )}
            </button>
          ))}
        </span>
        <span className="spacer" />
        {tab === "sessions" && (
          <>
            <span className="lay-wrap">
              <button
                className="outline"
                onClick={() => setLayoutOpen((o) => !o)}
                title="Layout — arrange this group's panes"
              >
                <LayoutIcon /> Layout
              </button>
              {layoutOpen && (
                <>
                  <div className="who-back" onMouseDown={() => setLayoutOpen(false)} />
                  <div className="lay-pop">
                    <div className="lay-grid">
                      {LAYOUTS.map((l) => (
                        <button
                          key={l.id}
                          className={`lay-opt ${curLayoutId === l.id ? "on" : ""}`}
                          title={`${l.label} — fits ${l.zones.length} panes`}
                          onClick={() => {
                            setLayouts((p) => ({ ...p, [activeGroup ?? ""]: l.id }));
                            setLayoutOpen(false);
                          }}
                        >
                          <LayoutThumb layout={l} />
                        </button>
                      ))}
                    </div>
                    <button
                      className={`lay-auto ${!curLayoutId ? "on" : ""}`}
                      onClick={() => {
                        setLayouts((p) => ({ ...p, [activeGroup ?? ""]: "" }));
                        setLayoutOpen(false);
                      }}
                    >
                      Auto — fit panes to the window
                    </button>
                    <div className="lay-note">
                      {layout
                        ? "Drag any pane edge to fine-tune."
                        : curLayoutId
                          ? `Applies with ${LAYOUTS.find((l) => l.id === curLayoutId)?.zones.length} panes open — ${cells.length} open now.`
                          : "Panes fill the window automatically."}
                    </div>
                  </div>
                </>
              )}
            </span>
            <button className="outline" onClick={() => setModal("import")}>Import</button>
          </>
        )}
        <button className="primary" onClick={() => setModal("new")}>
          New session <span className="kbd">⌘N</span>
        </button>
      </div>

      <div className="body">
        <ViewErrorBoundary resetKey={tab}>
        {tab === "dashboard" && (
          <DashboardBoard
            sessions={sessions}
            onJump={jumpTo}
            onCreated={(s) => {
              refresh();
              jumpToSession(s);
            }}
          />
        )}
        {tab === "settings" && (
          <SettingsView
            sessions={sessions}
            theme={theme}
            onTheme={setTheme}
            onRestartAll={() => setModal("restart")}
            onSetup={() => setModal("setup")}
            onUpdate={() => setModal("update")}
            jump={settingsJump}
          />
        )}
        {tab === "collaborate" && (
          <CollaborateView
            focusRoom={focusRoom}
            onOpenSession={(id) => {
              setTab("sessions");
              // the session was just created; give the list a moment to include it
              setTimeout(() => jumpToRef.current(id), 300);
            }}
          />
        )}
        {tab === "worktracker" && (
          <div className="wt-page">
            <div className="board-filter">
              <span className="flbl">WorkTracker</span>
              <span className="flbl-info">
                debriefs run here · wrap-up reads a passive digest of the day's sessions (nothing is interrupted)
              </span>
              <span style={{ marginLeft: "auto" }} />
              <button
                className="outline"
                onClick={() => window.mb.runDebrief("morning").then(refresh)}
              >
                Morning brief
              </button>
              <button
                className="primary"
                onClick={() => window.mb.runDebrief("wrapUp").then(refresh)}
              >
                4pm wrap-up
              </button>
            </div>
            {debriefSessions.length === 0 ? (
              <div className="empty">
                <div>no debrief running</div>
                <div style={{ maxWidth: 420, textAlign: "center", lineHeight: 1.6 }}>
                  The morning brief plans your day; the 4pm wrap-up interviews you and folds in a
                  digest of every coding session's terminal output — captured passively, without
                  sending anything to your sessions.
                </div>
              </div>
            ) : (
              <div className="wt-panes">
                {debriefSessions.map((s) => (
                  <TerminalPane
                    key={s.id}
                    session={s}
                    focused={focused === s.id}
                    zoomed={false}
                    density="max"
                    paneIndex={99}
                    onFocus={() => setFocused(s.id)}
                    onClose={() => forceClose(s, true)}
                    onResume={() => resumeDead(s)}
                    onCleanup={() => forceClose(s, true)}
                    closeTitle="Close debrief"
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "sessions" && (
        <>
        <nav className="activitybar" aria-label="Side bar views">
          {SIDE_VIEWS.map(({ id, label, keys, Icon }) => {
            const on = sideView === id && !sideCollapsed;
            const badge = id === "sessions" ? counts.waiting : id === "scm" ? scmCount : 0;
            return (
              <button
                key={id}
                className={`ab-btn ${on ? "on" : ""}`}
                title={`${label}${keys ? ` (${keys})` : ""}${on ? " — click to hide the side bar (⌘B)" : ""}`}
                aria-label={label}
                aria-pressed={on}
                onClick={() => (on ? setSideCollapsed(true) : showView(id))}
              >
                <Icon />
                {badge > 0 && (
                  <span className={`ab-badge ${id === "sessions" ? "waiting" : ""}`} title={id === "sessions" ? `${badge} waiting on you` : `${badge} uncommitted file${badge === 1 ? "" : "s"}`}>
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className={`sidebar ${sideCollapsed ? "collapsed" : ""}`} style={{ width: sideCollapsed ? 0 : sideW }}>
          <div className="side-inner" style={{ width: sideW }}>
          <div className="side-head">
            <span className="side-title">{SIDE_VIEWS.find((v) => v.id === sideView)?.label}</span>
          </div>
          {sideView === "explorer" && (
            <ExplorerTree
              session={focusedSession}
              activePath={activePath}
              onOpen={(path, status) => openInEditor(path, { status })}
            />
          )}
          {sideView === "scm" &&
            (focusedSession ? (
              <SourceControl
                key={focusedSession.id}
                sessionId={focusedSession.id}
                root={focusedSession.cwd}
                selected={activePath}
                onOpenDiff={(path, source, status) => openInEditor(path, { mode: "diff", source, status: status === "C" ? "M" : status })}
                onOpenFile={(path) => openInEditor(path)}
              />
            ) : (
              <div className="fp-note">Click into a session to see its changes.</div>
            ))}
          {sideView === "search" && (
            <SearchView
              session={focusedSession}
              state={search}
              onState={setSearch}
              focusKey={searchFocus}
              onOpenConversation={openTranscript}
              onOpenFile={(path, line) => openInEditor(path, { line })}
            />
          )}
          {sideView === "sessions" && (
          <div className="scroll">
            <div className="filter-row">
              <input
                className="filter"
                placeholder="Filter sessions"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {groups.map(([key, list]) => (
              <div key={key}>
                {(
                  <div
                    className="group-label"
                    title="click to focus this group in the grid · ✎/double-click to rename · drop a session here to move it"
                    onClick={() => deferClick(() => focusGroup(key, list))}
                    onDoubleClick={() => {
                      cancelClick();
                      setRenameDlg({ kind: "group", key, initial: key === "ungrouped" ? "" : key });
                    }}
                    data-drop={cue(drag, `g:${key}`)}
                    onDragOver={(e) => overTarget(e, intoGroupTarget(`g:${key}`, key === "ungrouped" ? null : key, groupTitle(key, list)))}
                    onDrop={(e) => dropToGroup(e, key === "ungrouped" ? null : key)}
                  >
                    <button
                      className="glbtn"
                      title={key === "ungrouped" ? "Name this group — its sessions become a group" : "Rename group"}
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelClick();
                        setRenameDlg({ kind: "group", key, initial: key === "ungrouped" ? "" : key });
                      }}
                    >
                      ✎
                    </button>
                    <span
                      className="chev"
                      title={collapsed.has(key) ? "Expand" : "Collapse"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCollapsed((p) => {
                          const n = new Set(p);
                          n.has(key) ? n.delete(key) : n.add(key);
                          return n;
                        });
                      }}
                    >
                      <ChevronIcon open={!collapsed.has(key)} />
                    </span>
                    <span className="txt">{groupTitle(key, list)}</span>
                  </div>
                )}
                {!collapsed.has(key) && bySub(list).map(([sub, subList]) => {
                  const wsKey = `${key}/${sub}`;
                  const inGrid = subList.some((s) => shown.includes(s.id));
                  const open = !sub || (wsOpen[wsKey] ?? inGrid);
                  return (
                  <div key={sub || "_"} className={sub ? "ws-folder" : "loose-rows"}>
                    {sub && (
                      <div
                        className={`sub-label ${inGrid ? "in-grid" : ""}`}
                        title="click to show/minimize this workspace · ✎/double-click to rename · ✕ dissolves it (sessions stay) · drop a session to move it in"
                        onClick={() =>
                          deferClick(() =>
                            inGrid
                              ? hideSessions(subList) // minimize the workspace
                              : focusSub(key, subList)
                          )
                        }
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          cancelClick();
                          setRenameDlg({ kind: "sub", key: wsKey, initial: sub });
                        }}
                        data-drop={cue(drag, `w:${wsKey}`)}
                        onDragOver={(e) => overTarget(e, intoGroupTarget(`w:${wsKey}`, wsKey, `${groupTitle(key, list)} / ${sub}`))}
                        onDrop={(e) => dropToGroup(e, wsKey)}
                      >
                        <span
                          className="ws-chev"
                          title={open ? "Hide sessions" : "Show sessions"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setWsOpen((p) => ({ ...p, [wsKey]: !open }));
                          }}
                        >
                          <ChevronIcon open={open} />
                        </span>
                        <FolderIcon open={inGrid} />
                        <span className="txt">{sub}</span>
                        <StatusDots list={subList} />
                        <button
                          title="Rename workspace"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelClick();
                            setRenameDlg({ kind: "sub", key: wsKey, initial: sub });
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="danger"
                          title="Dissolve this workspace — its sessions move up into the group"
                          onClick={(e) => {
                            e.stopPropagation();
                            dissolveSub(key, subList);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    {open && subList.map((s) => {
                  const idx = shown.indexOf(s.id);
                  return (
                    <div
                      key={s.id}
                      className={`sess-item ${idx >= 0 ? "shown" : ""}`}
                      onClick={() => (idx >= 0 ? hide(s.id) : showSession(s))}
                      title={`${s.cwd} — double-click name to rename · drag onto a group to move`}
                      draggable
                      onDragStart={(e) => beginDrag(e, "text/mb-session", s.id, `Moving ${titleOf(s)}`)}
                      data-drop={cue(drag, `s:${s.id}`)}
                      onDragOver={(e) => {
                        const srcS = sessions.find((x) => x.id === dragging("text/mb-session"));
                        if (!srcS || srcS.id === s.id) return overTarget(e, null);
                        if (topOf(srcS) === topOf(s) && !subOf(s) && !subOf(srcS)) {
                          return overTarget(e, { key: `s:${s.id}`, outcome: `Put ${titleOf(srcS)} and ${titleOf(s)} in a new workspace` });
                        }
                        const where = subOf(s) ? `${groupTitle(topOf(s), [s])} / ${subOf(s)}` : groupTitle(topOf(s), [s]);
                        overTarget(e, (srcS.taskGroup ?? null) === (s.taskGroup ?? null) ? null : { key: `s:${s.id}`, outcome: `Move ${titleOf(srcS)} into ${where}` });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const src = e.dataTransfer.getData("text/mb-session");
                        if (!src || src === s.id) return;
                        const srcS = sessions.find((x) => x.id === src);
                        // dropping one loose session onto another in the same group
                        // creates a workspace holding both (rename it right away)
                        if (srcS && topOf(srcS) === topOf(s) && !subOf(s) && !subOf(srcS)) {
                          const top = topOf(s);
                          const name = nextSubName(top);
                          window.mb.setGroup(s.id, `${top}/${name}`);
                          window.mb.setGroup(src, `${top}/${name}`);
                          setRenameDlg({ kind: "sub", key: `${top}/${name}`, initial: name });
                        } else {
                          window.mb.setGroup(src, s.taskGroup); // join this row's group/workspace
                        }
                      }}
                    >
                      <span className={`dot ${s.status}`} />
                      {editing?.kind === "session" && editing.key === s.id ? (
                        editInput
                      ) : (
                        <span
                          className="name"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditing({ kind: "session", key: s.id, value: s.ticketTitle ?? s.title });
                          }}
                        >
                          <span className="nm">{s.ticketTitle ?? s.title}</span>
                          {(s.branch || s.agent === "codex") && (
                            <span className="br">
                              {s.agent === "codex" ? "codex · " : ""}
                              {s.branch && s.branch !== (s.ticketTitle ?? s.title) ? s.branch : s.repoPath?.split("/").pop() ?? ""}
                            </span>
                          )}
                        </span>
                      )}
                      <button
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing({ kind: "session", key: s.id, value: s.ticketTitle ?? s.title });
                        }}
                      >
                        ✎
                      </button>
                      <button
                        title="Move to group…"
                        onClick={(e) => {
                          e.stopPropagation();
                          setGroupDlg(s);
                        }}
                      >
                        ⤷
                      </button>
                      <button
                        className="danger"
                        title="Close session"
                        onClick={(e) => {
                          e.stopPropagation();
                          requestClose(s);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                  </div>
                  );
                })}
              </div>
            ))}

            {resumable.length > 0 && (
              <>
                <h2>
                  <span>Previous</span>
                  <button className="icon" title="Relaunch every previous session, resuming its conversation" onClick={restoreAll}>
                    ↺ restore all
                  </button>
                </h2>
                {resumable.filter((s) => !s.debrief).map((s) => (
                  <div key={s.id} className="sess-item" title={s.cwd}>
                    <span className="dot dead" />
                    <span className="name">{s.title}</span>
                    <button
                      title="Relaunch, resuming the conversation"
                      onClick={async () => {
                        const info = await window.mb.relaunchSession(s.id);
                        if (info?.error) return alert(`Couldn't relaunch: ${info.error}`);
                        if (info) {
                          await refresh();
                          jumpTo(info.id);
                        }
                      }}
                    >
                      ↺
                    </button>
                    <button className="danger" onClick={() => window.mb.killSession(s.id, true).then(refresh)}>
                      ✕
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
          )}
          </div>
          <div className="side-grip" onPointerDown={startSideResize} />
        </div>
        <EditorDock
          editor={editor}
          onActivate={(key) => setEditor((e) => ({ ...e, active: key }))}
          onClose={(key) => setEditor((e) => closeTab(e, key))}
          onMode={(key, mode) => setEditor((e) => updateTab(e, key, { mode }))}
          onInsert={(text) => {
            if (!focusedSession) return;
            window.mb.sessionWrite(focusedSession.id, text);
            focusTerm(focusedSession.id);
          }}
        />

        <div className="main">
          {activeGroup && (() => {
            const topSessions = workSessions.filter((s) => topOf(s) === activeGroup);
            return (
              <div className="groupbar">
                <span className="gb-name">{groupTitle(activeGroup, topSessions)}</span>
                <span style={{ marginLeft: "auto" }} />
                <span className="flbl-info">{gridSessions.length} of {topSessions.length} shown</span>
              </div>
            );
          })()}
          {gridSessions.length === 0 ? (
            <div className="empty">
              <div>no sessions in the grid</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="primary" onClick={() => setModal("new")}>New session</button>
                <button className="outline" onClick={() => setModal("import")}>Import existing</button>
              </div>
            </div>
          ) : (
            <div
              className={`grid ${sliding ? "slide-in" : ""}`}
              ref={gridRef}
              style={{
                gridTemplateColumns:
                  colSizes.length === cols ? colSizes.map((f) => `${f}fr`).join(" ") : `repeat(${cols}, 1fr)`,
                gridTemplateRows:
                  rowSizes.length === rows ? rowSizes.map((f) => `${f}fr`).join(" ") : undefined,
              }}
            >
              {cells.map((cell, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                // the last pane of an incomplete row spans the leftover columns —
                // no dead cells (3 sessions in 2 cols → bottom pane full width)
                const zone = layout?.zones[i];
                const remainder = cells.length % cols;
                const span = !zoomed && !layout && remainder !== 0 && i === cells.length - 1 ? cols - col : 1;
                const canX = !zoomed && col + span - 1 < cols - 1;
                const canY = !zoomed && row < rows - 1;
                const resize =
                  canX || canY
                    ? {
                        x: canX ? (e: React.PointerEvent) => startTrackDrag("col", col, e) : undefined,
                        y: canY ? (e: React.PointerEvent) => startTrackDrag("row", row, e) : undefined,
                        reset: equalizeTracks,
                      }
                    : undefined;
                const paneFor = (s: SessionInfo, embedded: boolean, onCloseOverride?: () => void) => (
                  <TerminalPane
                    key={s.id}
                    session={s}
                    focused={focused === s.id}
                    zoomed={zoomed === s.id}
                    density={density}
                    paneIndex={i}
                    embedded={embedded}
                    onFocus={() => setFocused(s.id)}
                    onOpenFiles={() => {
                      setFocused(s.id);
                      showView("explorer");
                    }}
                    onOpenChanges={() => {
                      setFocused(s.id);
                      showView("scm");
                    }}
                    onClose={onCloseOverride ?? (() => hide(s.id))}
                    onZoom={() => setZoomed(zoomed === s.id ? null : s.id)}
                    onAddTab={embedded ? undefined : () => startWorkspaceFrom(s)}
                    onReorder={reorder}
                    drop={{
                      cue: cue(drag, `p:${s.id}`),
                      over: (e) => {
                        const src = dragging("text/mb-session");
                        if (!src) return e.preventDefault(); // files from Finder: the pane handles those itself
                        const srcS = sessions.find((x) => x.id === src);
                        const side = sideOf(e, e.currentTarget, "x");
                        const inGrid = shown.includes(src);
                        if (!srcS || src === s.id || (inGrid && samePlace(shown, src, s.id, side))) return overTarget(e, null);
                        overTarget(e, { key: `p:${s.id}`, side, outcome: `${inGrid ? "Move" : "Show"} ${titleOf(srcS)} ${side} ${titleOf(s)}` });
                      },
                      drop: (e) => {
                        const src = e.dataTransfer.getData("text/mb-session");
                        if (src && src !== s.id) reorder(src, s.id, sideOf(e, e.currentTarget, "x"));
                      },
                    }}
                    onResume={() => resumeDead(s)}
                    onCleanup={() => requestClose(s)}
                    resize={resize}
                  />
                );
                if (cell.kind === "session") {
                  const pane = paneFor(cell.s, false);
                  if (zone)
                    return (
                      <div key={`zone-${cell.s.id}`} className="spanwrap" style={{ gridArea: zone }}>
                        {pane}
                      </div>
                    );
                  return span > 1 ? (
                    <div key={`span-${cell.s.id}`} className="spanwrap" style={{ gridColumn: `span ${span}` }}>
                      {pane}
                    </div>
                  ) : (
                    pane
                  );
                }
                // workspace pane: one cell, session tabs across the top (cmux-style)
                const key = `${activeGroup}/${cell.sub}`;
                const active = cell.list.find((s) => s.id === wsTabs[key]) ?? cell.list[0];
                const anyWaiting = cell.list.some((s) => s.status === "waiting");
                return (
                  <div
                    key={`ws-${cell.sub}`}
                    className={`ws-pane ${anyWaiting ? "st-waiting" : ""}`}
                    style={zone ? { gridArea: zone } : span > 1 ? { gridColumn: `span ${span}` } : undefined}
                  >
                    <div className="ws-tabs">
                      <span
                        className="ws-name"
                        title="double-click to rename this workspace"
                        onDoubleClick={() => setRenameDlg({ kind: "sub", key, initial: cell.sub })}
                      >
                        {cell.sub}
                      </span>
                      {cell.list.map((s) => (
                        <button
                          key={s.id}
                          className={`ws-tab ${active.id === s.id ? "on" : ""}`}
                          onClick={() => {
                            setWsTabs((p) => ({ ...p, [key]: s.id }));
                            setFocused(s.id);
                            setTimeout(() => focusTerm(s.id), 50);
                          }}
                        >
                          <span className={`dot sm ${s.status}`} />
                          <span className="t">{s.ticketTitle ?? s.title}</span>
                          <span
                            className="ws-x"
                            role="button"
                            aria-label={`Close ${s.ticketTitle ?? s.title}`}
                            title="Close session"
                            onClick={(e) => {
                              e.stopPropagation();
                              requestClose(s);
                            }}
                          >
                            ×
                          </span>
                        </button>
                      ))}
                      <button
                        className="ws-add"
                        title={`New tab in “${cell.sub}”`}
                        onClick={() => {
                          setNewGroup(key);
                          setNewLaunch("claude");
                          setModal("new");
                        }}
                      >
                        +
                      </button>
                    </div>
                    {paneFor(active, true, () => hideSessions(cell.list))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </>
        )}
        </ViewErrorBoundary>
      </div>

      <div className="statusbar">
        {(["working", "waiting", "idle", "dead"] as const).map((st) => {
          const c = counts[st];
          if (st === "dead" && c === 0) return null;
          const list = workSessions.filter((s) => s.status === st);
          return (
            <span className="stat-wrap" key={st}>
              <span
                className={`count ${st === "waiting" ? "waiting" : ""} ${c > 0 ? "clickable" : ""}`}
                title={c > 0 ? `Show ${st} sessions` : undefined}
                onClick={() => c > 0 && setStatusPop((p) => (p === st ? null : st))}
              >
                <span className={`dot sm ${st}`} /> {c} {st}
              </span>
              {statusPop === st && (
                <>
                  <div className="who-back" onMouseDown={() => setStatusPop(null)} />
                  <div className="who-pop stat-pop">
                    {list.map((s) => (
                      <div
                        key={s.id}
                        className="who-row"
                        onClick={() => {
                          setStatusPop(null);
                          jumpTo(s.id); // swaps to its group and un-hides the pane
                        }}
                      >
                        <span className={`dot sm ${s.status}`} />
                        {s.ticketTitle ?? s.title}
                        <span className="cnt">
                          {st === "waiting" && s.waitingSince
                            ? fmtElapsed(s.waitingSince)
                            : groupKeyOf(s)}
                        </span>
                      </div>
                    ))}
                    {list.length === 0 && <div className="who-row">none</div>}
                  </div>
                </>
              )}
            </span>
          );
        })}
        <UsageMeter usage={usage} />
        <span className="right">
          {updOutcome && (
            <span
              className={`update-note ${updOutcome.ok ? "" : "bad"}`}
              title={[
                updOutcome.message,
                updOutcome.restoreErrors?.length ? `Sessions that couldn't come back: ${updOutcome.restoreErrors.join("; ")}` : "",
                `Log: ${updOutcome.logPath}`,
              ].filter(Boolean).join("\n")}
            >
              {updOutcome.ok ? `✓ ${updOutcome.message}` : `✕ ${updOutcome.message}`}
              <button className="icon" title="Dismiss" onClick={() => setUpdOutcome(null)}>✕</button>
            </span>
          )}
          {(upd.state !== "idle" || update?.newer) && (
            <span
              className={`update-link ${upd.state === "failed" ? "bad" : ""}`}
              title="Update Mockingbird from your clone — it builds while you work and restarts when you say"
              onClick={() => setModal("update")}
            >
              {upd.state === "preparing"
                ? `⭮ building${update?.latest ? ` v${update.latest}` : ""}…`
                : upd.state === "ready"
                  ? `⭮ restart to update to v${upd.version}`
                  : upd.state === "failed"
                    ? "⭮ update failed"
                    : upd.state === "installing"
                      ? "⭮ restarting…"
                      : `⭮ v${update!.latest} available`}
            </span>
          )}
          {!hooksOk && (
            <span
              className="hooks-bad"
              title="Session status (working/waiting/idle) needs Claude Code hooks — click to install"
              onClick={async () => {
                const r = await window.mb.installHooks();
                if (r?.error) return alert(`Couldn't install hooks: ${r.error}`);
                setHooksOk(true);
              }}
            >
              ⚠ install hooks
            </span>
          )}
          <span>{workSessions.length} sessions · {groups.length} groups</span>
          <span>⌘K commands</span>
          <span className="help-link" onClick={() => setModal("help")}>? help</span>
        </span>
      </div>

      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          gridSessions={gridSessions}
          onClose={() => setPaletteOpen(false)}
          actions={[
            { label: "New session", kbd: "⌘N", run: () => { setNewLaunch("claude"); setModal("new"); } },
            { label: "New Codex session", run: () => { setNewLaunch("codex"); setModal("new"); } },
            { label: "New terminal (no Claude)", run: () => { setNewLaunch("shell"); setModal("new"); } },
            { label: "Restart all agent sessions", run: () => setModal("restart") },
            { label: "Setup — agents, hooks, repos, Azure DevOps", run: () => setModal("setup") },
            { label: "Sessions grid", run: () => setTab("sessions") },
            { label: "Dashboard — ticket board", run: () => setTab("dashboard") },
            { label: "Broadcast / CLAUDE.md (control room)", kbd: "⌘⇧B", run: openControlRoom },
            { label: "Go to file…", kbd: "⌘P", run: () => { setTab("sessions"); setModal("quickopen"); } },
            { label: "Search — conversations, or the focused session's files", kbd: "⌘⇧F", run: () => showView("search") },
            { label: "Explorer — the focused session's folder", kbd: "⌘⇧E", run: () => showView("explorer") },
            { label: "Source Control — stage, commit, push", kbd: "⌃⇧G", run: () => showView("scm") },
            { label: "Settings", run: () => setTab("settings") },
            { label: "Import sessions", run: () => setModal("import") },
            { label: "WorkTracker — debriefs", run: () => setTab("worktracker") },
            { label: "Morning brief", run: () => { window.mb.runDebrief("morning"); setTab("worktracker"); } },
            { label: "4pm wrap-up", run: () => { window.mb.runDebrief("wrapUp"); setTab("worktracker"); } },
            ...(focusedSession
              ? [
                  {
                    label: `${zoomed === focusedSession.id ? "Exit fullscreen" : "Fullscreen"} ${focusedSession.ticketTitle ?? focusedSession.title}`,
                    kbd: "⌘E",
                    run: () => setZoomed(zoomed === focusedSession.id ? null : focusedSession.id),
                  },
                  {
                    label: `Rename ${focusedSession.ticketTitle ?? focusedSession.title}…`,
                    run: () => {
                      setSideCollapsed(false);
                      setEditing({ kind: "session", key: focusedSession.id, value: focusedSession.ticketTitle ?? focusedSession.title });
                    },
                  },
                  { label: `Change group of ${focusedSession.ticketTitle ?? focusedSession.title}…`, run: () => setGroupDlg(focusedSession) },
                ]
              : []),
            { label: "Columns: 1", kbd: "⌘⌃1", run: () => setColsPref(1) },
            { label: "Columns: 2", kbd: "⌘⌃2", run: () => setColsPref(2) },
            { label: "Columns: 3", kbd: "⌘⌃3", run: () => setColsPref(3) },
            { label: "Columns: 4", kbd: "⌘⌃4", run: () => setColsPref(4) },
            { label: "Next waiting session", kbd: "⌥⇥", run: cycleWaiting },
            { label: `Switch to ${theme === "dark" ? "light" : "dark"} mode`, run: () => setTheme(theme === "dark" ? "light" : "dark") },
            { label: "How to use Mockingbird", kbd: "⌘/", run: () => setModal("help") },
          ]}
          onJump={jumpTo}
        />
      )}

      {closeDlg && (
        <CloseSessionDialog
          session={closeDlg.session}
          wt={closeDlg.wt}
          onCancel={() => setCloseDlg(null)}
          onDone={() => {
            setCloseDlg(null);
            refresh();
          }}
          forceClose={forceClose}
        />
      )}

      {groupDlg && (
        <GroupDialog
          session={groupDlg}
          groups={groupKeys}
          onClose={() => setGroupDlg(null)}
        />
      )}

      {renameDlg && (
        <RenameDialog
          title={renameDlg.kind === "sub" ? "Rename workspace" : renameDlg.key === "ungrouped" ? "Name this group" : "Rename group"}
          initial={renameDlg.initial}
          onSave={applyRename}
          onClose={() => setRenameDlg(null)}
        />
      )}

      {modal === "new" && (
        <NewSessionModal
          existingGroups={groupKeys}
          initialLaunch={newLaunch}
          initialGroup={newGroup}
          onClose={() => {
            setModal(null);
            setNewLaunch("claude");
            setNewGroup("");
            setPendingWs(null); // cancelled — the pane stays a plain pane
          }}
          onCreated={(s) => {
            setNewLaunch("claude");
            setNewGroup("");
            onCreated(s);
          }}
        />
      )}
      {modal === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onOpened={(opened) => {
            refresh();
            const batch = opened.slice(0, 6); // rest stay in the sidebar to avoid a 26-pane grid
            if (batch.length) {
              setShown(batch.map((s) => s.id)); // imports become the active (ungrouped) group
              collapseOthers(groupKeyOf(batch[0]));
              setTab("sessions");
            }
          }}
          onDone={() => setModal(null)}
        />
      )}
      {modal === "restart" && (
        <RestartAllDialog
          sessions={sessions}
          onClose={() => setModal(null)}
          onDone={(ids) => {
            // the ptys are new: drop the cached terminals so each pane re-attaches
            // and replays the fresh buffer instead of showing the dead one
            ids.forEach(disposeTerm);
            refresh();
          }}
        />
      )}
      <DragLabel />
      {modal === "help" && <HelpModal onClose={() => setModal(null)} />}
      {modal === "quickopen" && (
        <QuickOpen session={focusedSession} onClose={() => setModal(null)} onOpen={(path, line) => openInEditor(path, { line })} />
      )}
      {modal === "update" && (
        <UpdatePanel
          progress={upd}
          current={appVersion}
          latest={update?.newer ? update.latest : undefined}
          onClose={() => setModal(null)}
          onOpenGitHub={update ? () => window.mb.openExternal(update.url) : undefined}
        />
      )}
      {modal === "setup" && (
        <SetupWizard
          onClose={() => setModal(null)}
          onFinish={() => {
            setNewLaunch("claude");
            setModal("new");
          }}
        />
      )}
    </div>
  );
}

// ---- command palette (design 1c) ----
interface PaletteAction {
  label: string;
  kbd?: string;
  run: () => void;
}

/**
 * Keeps a crash in one tab's view from blanking the whole window: the error is
 * shown with a way to retry, the top bar keeps working, and switching tabs
 * starts the view fresh.
 */
class ViewErrorBoundary extends React.Component<{ resetKey: string; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[mockingbird] view crashed:", error, info.componentStack);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view-error">
        <strong>This view hit an error.</strong>
        <code>{this.state.error.message}</code>
        <span className="wi-note">Your sessions are still running. Reload the view, or switch tabs.</span>
        <button className="outline" onClick={() => this.setState({ error: null })}>Reload view</button>
      </div>
    );
  }
}

/** One dot per session (up to 3, then a count), so a collapsed workspace still shows who's busy or blocked. */
function StatusDots({ list }: { list: SessionInfo[] }) {
  const order = { waiting: 0, working: 1, idle: 2, dead: 3 } as const;
  const sorted = [...list].sort((a, b) => order[a.status] - order[b.status]);
  const MAX = 3;
  const extra = sorted.length - MAX;
  return (
    <span className="sdots" title={`${list.length} session${list.length === 1 ? "" : "s"}`}>
      {sorted.slice(0, MAX).map((s) => (
        <span key={s.id} className={`dot xs ${s.status}`} />
      ))}
      {extra > 0 && <span className="more">+{extra}</span>}
    </span>
  );
}

type UsageShow = "claude" | "codex" | "both";
const AGENT_NAME = { claude: "Claude", codex: "Codex" } as const;

/**
 * Plan usage in the status bar — Claude, Codex, or both — with a popover of
 * every limit. Both agents report account-wide numbers from their sessions.
 */
function UsageMeter({ usage }: { usage: UsageReport | null }) {
  const [show, setShow] = useState<UsageShow>(() => loadLS("mb.usageShow", "both"));
  useEffect(() => localStorage.setItem("mb.usageShow", JSON.stringify(show)), [show]);
  const [open, setOpen] = useState(false);
  // resets pass while the app sits open with no session reporting
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const agents = (show === "both" ? (["claude", "codex"] as const) : ([show] as const)).filter(Boolean) as ("claude" | "codex")[];
  const shown = agents.map((a) => ({ a, u: usage?.[a] ?? null }));
  const compact = shown.filter((x) => x.u);
  const short = (l: UsageLimit) => (l.label.startsWith("5-hour") ? "5h" : l.label.startsWith("Weekly") ? "wk" : l.label);

  return (
    <span className="usage-wrap">
      <span className="usage" onClick={() => setOpen((o) => !o)} title="Plan usage — click for details">
        {compact.length === 0 ? (
          <span className="dim">usage</span>
        ) : (
          compact.map(({ a, u }) => (
            <span key={a} className="usage-agent">
              {agents.length > 1 && <span className="dim">{AGENT_NAME[a]}</span>}
              {u!.limits
                .filter((l) => l.label === "5-hour limit" || l.label.startsWith("Weekly · all") || l.label === "Weekly limit")
                .map((l) => (
                  <span key={l.label} className={pctNow(l, now) >= 90 ? "hot" : ""}>
                    {short(l)} {Math.round(pctNow(l, now))}%
                  </span>
                ))}
            </span>
          ))
        )}
      </span>
      {open && (
        <>
          <div className="who-back" onMouseDown={() => setOpen(false)} />
          <div className="usage-pop">
            {shown.map(({ a, u }) => (
              <div key={a} className="usage-sec">
                <div className="usage-head">
                  {AGENT_NAME[a]} plan usage limits{u?.plan ? ` · ${u.plan}` : ""}
                </div>
                {!u ? (
                  <div className="usage-empty">
                    {a === "claude"
                      ? "No report yet — appears after a Claude session's first response."
                      : "No report yet — appears after a Codex session's first turn."}
                  </div>
                ) : (
                  <>
                    {u.limits.map((l) => {
                      const pct = pctNow(l, now);
                      return (
                        <div key={l.label} className="usage-row">
                          <div className="usage-line">
                            <span className="usage-label">{l.label}</span>
                            <span
                              className="usage-reset"
                              title={l.note ? "Claude Code reports this window with a reply in a Claude pane; Collaborate turns don't report it" : undefined}
                            >
                              {l.note ?? resetText(l.resetsAt, now)}
                            </span>
                            <span className="usage-pct">{l.note ? "—" : `${Math.round(pct)}%`}</span>
                          </div>
                          <div className="usage-bar">
                            <span className={pct >= 90 ? "hot" : ""} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                          </div>
                        </div>
                      );
                    })}
                    <div className="usage-foot">
                      reported {fmtElapsed(u.at)} ago{a === "codex" ? " · read from Codex's session logs" : ""}
                    </div>
                  </>
                )}
              </div>
            ))}
            <div className="usage-show">
              <span className="seg" title="Whose usage to list">
                {(["claude", "codex", "both"] as const).map((v) => (
                  <button key={v} className={show === v ? "on" : ""} onClick={() => setShow(v)}>
                    {v === "both" ? "Both" : AGENT_NAME[v]}
                  </button>
                ))}
              </span>
            </div>
          </div>
        </>
      )}
    </span>
  );
}

function CommandPalette({
  sessions,
  gridSessions,
  actions,
  onJump,
  onClose,
}: {
  sessions: SessionInfo[];
  gridSessions: SessionInfo[];
  actions: PaletteAction[];
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const statusPhrase = (s: SessionInfo): string => {
    if (s.status === "waiting")
      return `${shortReason(s.waitingReason)}${s.waitingSince ? ` ${fmtElapsed(s.waitingSince)}` : ""}`;
    return s.status;
  };

  const rows = useMemo(() => {
    const acts = actions
      .filter((a) => !q || fuzzy(q, a.label))
      .map((a) => ({ kind: "action" as const, label: a.label, kbd: a.kbd, run: a.run }));
    const sess = sessions
      .filter((s) => !q || fuzzy(q, s.ticketTitle ?? s.title) || fuzzy(q, s.branch ?? ""))
      .map((s) => {
        const idx = gridSessions.findIndex((g) => g.id === s.id);
        return {
          kind: "session" as const,
          label: s.ticketTitle ?? s.title,
          kbd: idx >= 0 && idx < 9 ? `⌘${idx + 1}` : undefined,
          status: s.status,
          state: statusPhrase(s),
          run: () => onJump(s.id),
        };
      });
    return { acts, sess, flat: [...acts, ...sess] };
  }, [q, sessions, gridSessions, actions]);

  useEffect(() => setSel(0), [q]);
  const clamp = Math.min(sel, Math.max(0, rows.flat.length - 1));

  const runRow = (i: number) => {
    const r = rows.flat[i];
    if (!r) return;
    onClose();
    r.run();
  };

  let flatIndex = -1;

  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div className="palette">
        <div className="inrow">
          <span className="prompt">›</span>
          <input
            autoFocus
            value={q}
            placeholder="Type a command or session"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, rows.flat.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              }
              if (e.key === "Enter") {
                e.preventDefault();
                runRow(clamp);
              }
            }}
          />
          <span className="kbd">esc to close</span>
        </div>
        <div className="results">
          {rows.acts.length > 0 && <div className="grp">Actions</div>}
          {rows.acts.map((r) => {
            flatIndex++;
            const i = flatIndex;
            return (
              <div key={`a${r.label}`} className={`row ${i === clamp ? "sel" : ""}`} onMouseDown={() => runRow(i)}>
                <span className="lab">{r.label}</span>
                {r.kbd && <span className="kbd">{r.kbd}</span>}
              </div>
            );
          })}
          {rows.acts.length > 0 && rows.sess.length > 0 && <div className="grp-div" />}
          {rows.sess.length > 0 && <div className="grp">Jump to session</div>}
          {rows.sess.map((r, j) => {
            flatIndex++;
            const i = flatIndex;
            return (
              <div key={`s${j}`} className={`row ${i === clamp ? "sel" : ""}`} onMouseDown={() => runRow(i)}>
                <span className={`dot ${r.status}`} />
                <span className="lab">{r.label}</span>
                <span className={`state ${r.status === "waiting" ? "amber" : ""}`}>{r.state}</span>
                {r.kbd && <span className="kbd">{r.kbd}</span>}
              </div>
            );
          })}
        </div>
        <div className="pfoot">
          <span>↑↓ move</span>
          <span>⏎ run</span>
          <span className="right">⌘K close</span>
        </div>
      </div>
    </>
  );
}

// ---- how-to-use popup (shown once on first launch, then ⌘/ · palette · status bar) ----
function HelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const keys: [string, string][] = [
    ["⌘K", "command palette — every action, jump to any session"],
    ["⌘N", "new session"],
    ["⌘1–9", "jump to pane 1–9"],
    ["⌥⇥", "next waiting session (oldest first)"],
    ["⌘E", "fullscreen the focused pane (esc restores)"],
    ["⌘⌃1–4", "grid columns (also switches pane detail level)"],
    ["⌘P", "go to a file in the focused session's folder (name:42 jumps to a line)"],
    ["⌘B", "show or hide the side bar"],
    ["⌘⇧E", "Explorer — the focused session's folder"],
    ["⌃⇧G", "Source Control — stage, commit, push"],
    ["⌘⇧B", "control room — broadcast + CLAUDE.md"],
    ["⌘⇧F", "search every conversation on this Mac, or the focused session's files"],
    ["⇧⏎", "newline in a Claude prompt (won't submit)"],
    ["⇧click", "select more than a screen: click where it starts, scroll, shift-click where it ends — it's copied"],
    ["⌘V", "paste — images land in the prompt as [Image #1]; files can also be dropped onto a pane"],
    ["⌘/", "this popup"],
  ];

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal help" onMouseDown={(e) => e.stopPropagation()}>
        <h3>How to use Mockingbird</h3>
        <div className="sub-h">
          A grid of parallel Claude CLI sessions. Watch them all at once; the app tells you when one needs you.
        </div>
        <div className="help-cols">
          <div>
            <div className="help-sec">The one rule</div>
            <p>
              <span className="dot waiting" style={{ marginRight: 6 }} />
              <b>Amber means a session is blocked on you</b> — a permission prompt or a question.
              The pane gets an amber border and a banner saying exactly why. Everything else is
              just status: <span className="dot working" /> working · <span className="dot idle" /> idle ·{" "}
              <span className="dot dead" /> dead. Press <span className="kbd">⌥⇥</span> to jump to
              whoever has waited longest.
            </p>
            <div className="help-sec">Sessions &amp; the grid</div>
            <p>
              <b>New session</b> picks a repo, optionally a ticket # — Mockingbird creates a git
              worktree and branch, and launches <span className="kbd">claude</span> in it. The grid
              sizes itself to however many sessions you have open. Click sidebar rows to show/hide
              panes; drag pane headers to rearrange; <span className="kbd">⛶</span> fullscreens a
              pane. <b>Resize a pane from its own right edge, bottom edge, or corner grip</b> —
              like a window; neighbors absorb the change (double-click a handle to even out).{" "}
              <b>Double-click any name</b> — pane title or sidebar row — <b>to rename it</b>.
              Closing a session with unsaved work always asks first — the safe choice is preselected.
            </p>
            <div className="help-sec">Groups &amp; sub-groups</div>
            <p>
              Sessions sharing a ticket # group automatically, and <b>the grid shows one group at a
              time</b> — the bar above the grid names it. Click a group header to fill the grid with
              it (other groups collapse — ▸ toggles them individually); click rows to hide/re-show
              panes. <b>Workspaces (sub-groups)</b> put several sessions in <b>one pane with tabs</b>,
              cmux-style. <b>Create</b>: drag one session row onto another in the same group (or use
              a row's <span className="kbd">⤷</span> dialog's sub-group field). <b>Rename</b>:
              double-click the workspace name — in the sidebar or on the pane's tab strip.{" "}
              <b>Dissolve</b>: hover the sidebar workspace label and click ✕ — its sessions stay,
              they just move back up into the group. Drag rows onto any group or workspace header
              to move them between.
            </p>
          </div>
          <div>
            <div className="help-sec">Keyboard</div>
            {keys.map(([k, d]) => (
              <div key={k} className="help-key">
                <span className="kbd">{k}</span>
                <span>{d}</span>
              </div>
            ))}
            <div className="help-sec">Broadcast &amp; CLAUDE.md</div>
            <p>
              Both live in the <b>Settings</b> tab. <b>Broadcast</b> queues a message to every
              session and delivers it when each one is idle (the delivery list shows who got it).
              Editing <b>CLAUDE.md</b> there ends with "Save &amp; re-read in N": every session in
              that repo re-reads it, no restarts. The <b>Dashboard</b> tab is your ADO board —
              drag cards between columns, comment, and start sessions from tickets.
            </p>
            <div className="help-sec">After a restart</div>
            <p>
              Sessions from the last run appear under <b>Previous</b> — <span className="kbd">↺ restore all</span>{" "}
              relaunches them with their history (<span className="kbd">claude --continue</span>) back
              into their old grid slots and groups.
            </p>
          </div>
        </div>
        <div className="row">
          <span className="kbd foot-hint">reopen anytime with ⌘/</span>
          <button className="primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}

// ---- ADO board: near-ADO kanban — drag cards between state columns, comment, link sessions ----
/** "Filter orgs by foundation" → "filterOrgsByFoundation" (branch-friendly). */
/** Kickoff prompt for a session started from an Azure DevOps ticket. */
function ticketKickoffPrompt(id: number | string, title: string, description: string): string {
  return (
    `You're picking up Azure DevOps ticket #${id}: ${title}.\n\n` +
    (description.trim() ? `Ticket description:\n${description.trim()}\n\n` : "") +
    `Get familiar with the relevant code first and propose an approach before making changes.`
  );
}

function suggestTicketName(title: string): string {
  const words = title.replace(/[^a-zA-Z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 5);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
}

// ADO's own work-item type colors, used as card accents
const TYPE_COLORS: Record<string, string> = {
  Task: "#f2cb1d",
  Bug: "#cc293d",
  "User Story": "#009ccc",
  "Product Backlog Item": "#009ccc",
  Feature: "#773b93",
  Epic: "#ff7b00",
};
const typeColor = (t: string) => TYPE_COLORS[t] ?? "#8d877c";

const STATE_ORDER = [
  "New", "Approved", "Committed", "To Do", "Open", "Active", "In Progress", "Doing",
  "Resolved", "In Review", "Review", "Done", "Closed",
];
const stateRank = (s: string) => {
  const i = STATE_ORDER.indexOf(s);
  return i < 0 ? STATE_ORDER.length : i;
};

// Terminal columns. A ticket you'd start work on never sits in one, so the
// New Session picker leaves them out — you pick from the working columns of
// the board (Approved/Planning/Parked/In Progress/QA and the like).
const DONE_STATES = ["done", "closed", "removed", "completed", "resolved", "cut", "abandoned"];
const isWorkingState = (state: string) => {
  const s = state.toLowerCase();
  return !DONE_STATES.some((d) => s === d || s.startsWith(d + " ") || s.endsWith(" " + d));
};

/**
 * Group tickets into board columns. Order of preference: the column order you
 * dragged into place on the Dashboard, then Azure DevOps' own workflow order
 * for the work item type, then a generic fallback. Terminal columns are dropped
 * entirely — you don't start work from Done.
 */
function ticketsByColumn(
  items: AdoWorkItem[],
  workflowOrder: string[] = []
): { state: string; items: AdoWorkItem[] }[] {
  const custom = loadLS<Record<string, { order: string[] }> | null>("mb.board.prefs", null)?.states?.order ?? loadLS<string[]>("mb.board.colOrder", []);
  const order = custom.length ? custom : workflowOrder;
  const byState = new Map<string, AdoWorkItem[]>();
  for (const t of items) {
    if (!isWorkingState(t.state)) continue;
    const list = byState.get(t.state);
    if (list) list.push(t);
    else byState.set(t.state, [t]);
  }
  const rank = (c: string) => {
    const i = order.indexOf(c);
    return i < 0 ? order.length + stateRank(c) : i;
  };
  return [...byState.entries()]
    .map(([state, list]) => ({ state, items: list.sort((a, b) => a.id - b.id) }))
    .sort((a, b) => rank(a.state) - rank(b.state) || a.state.localeCompare(b.state));
}

function DashboardBoard({
  sessions,
  onJump,
  onCreated,
}: {
  sessions: SessionInfo[];
  onJump: (id: string) => void;
  onCreated: (s: SessionInfo) => void;
}) {
  const [items, setItems] = useState<AdoWorkItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [stateCols, setStateCols] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  // filters: multi-select "Assigned to" (empty = everyone) and hidden columns
  const [me, setMe] = useState("");
  const [who, setWho] = useState<string[] | null>(() => loadLS<string[] | null>("mb.board.who", null));
  const [whoOpen, setWhoOpen] = useState(false);
  useEffect(() => {
    if (who !== null) localStorage.setItem("mb.board.who", JSON.stringify(who));
  }, [who]);

  // The team's Azure Boards board — its real columns — when it can be read; work item states otherwise
  const [boardsInfo, setBoardsInfo] = useState<{ team: string; boards: AdoBoard[] } | { error: string } | null>(null);
  const [boardName, setBoardName] = useState<string>(() => loadLS("mb.board.name", ""));
  useEffect(() => localStorage.setItem("mb.board.name", JSON.stringify(boardName)), [boardName]);
  const boards = boardsInfo && !("error" in boardsInfo) ? boardsInfo.boards : null;
  const board = boards ? boards.find((b) => b.name === boardName) ?? pickBoard(items ?? [], boards) : null;

  // column order and hidden columns, kept per board ("states" when there's no board)
  const [colPrefs, setColPrefs] = useState<Record<string, { order: string[]; hidden: string[] }>>(
    () =>
      loadLS<Record<string, { order: string[]; hidden: string[] }> | null>("mb.board.prefs", null) ?? {
        states: { order: loadLS<string[]>("mb.board.colOrder", []), hidden: loadLS<string[]>("mb.board.hidden", []) },
      }
  );
  useEffect(() => localStorage.setItem("mb.board.prefs", JSON.stringify(colPrefs)), [colPrefs]);
  const prefKey = board ? `board:${board.name}` : "states";
  const defaultHidden = board ? board.columns.filter((c) => c.type === "outgoing").map((c) => c.name) : [];
  const prefs = colPrefs[prefKey] ?? { order: [], hidden: defaultHidden };
  const setPrefs = (p: { order: string[]; hidden: string[] }) => setColPrefs((all) => ({ ...all, [prefKey]: p }));
  const allCols = board ? board.columns.map((c) => c.name) : stateCols;
  const orderedCols = orderColumns(allCols, prefs.order);
  const hiddenCols = new Set(prefs.hidden);
  const toggleHidden = (c: string) => setPrefs({ ...prefs, hidden: hiddenCols.has(c) ? prefs.hidden.filter((x) => x !== c) : [...prefs.hidden, c] });
  const [colsOpen, setColsOpen] = useState(false);
  /** The column a card sits in: its board column, or its state without a board. */
  const colOfItem = (it: AdoWorkItem) => (board ? columnOf(it, board) : it.state);

  const drag = useDrag();
  const reorderCols = (src: string, target: string, side: Side) => setPrefs({ ...prefs, order: placeBeside(orderedCols, src, target, side) });
  /** What dropping the current drag on a column would do: move a column beside it, or move a ticket into it. */
  const columnTarget = (e: React.DragEvent, col: string) => {
    const srcCol = dragging("text/mb-col");
    if (srcCol) {
      const side = sideOf(e, e.currentTarget, "x");
      return srcCol === col || samePlace(orderedCols, srcCol, col, side) ? null : { key: `c:${col}`, side, outcome: `Put ${srcCol} ${side} ${col}` };
    }
    const it = items?.find((i) => String(i.id) === dragging("text/mb-wi"));
    if (!it) return null;
    if (!board) return it.state !== col ? { key: `c:${col}`, outcome: `#${it.id}: ${it.state} → ${col}` } : null;
    const mv = cardMove(it, board, col);
    return mv ? { key: `c:${col}`, outcome: `#${it.id} → ${col}${mv.stateChanges ? ` (${it.state} → ${mv.state})` : ""}` } : null;
  };

  /** Drop a card in a board column: the column (and its state for the card's type) is saved to ADO. */
  const moveCard = async (id: number, col: string) => {
    const prev = items?.find((i) => i.id === id);
    if (!prev) return;
    if (!board) return changeState(id, col);
    const mv = cardMove(prev, board, col);
    if (!mv) return;
    setError("");
    setItems((p) => (p ? p.map((i) => (i.id === id ? { ...i, boardColumn: col, state: mv.state } : i)) : p));
    const r = await window.mb.adoMoveToColumn(id, prev.type, board.name, col);
    if (r?.error) {
      setItems((p) => (p ? p.map((i) => (i.id === id ? prev : i)) : p));
      setError(`Couldn't move ${id} to ${col}: ${r.error}`);
    }
  };
  // detail edit state
  const [title, setTitle] = useState("");
  const [state, setState] = useState("");
  const [desc, setDesc] = useState("");
  const [typeStates, setTypeStates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // discussion
  const [comments, setComments] = useState<AdoComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  // start/attach session
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [repoPath, setRepoPath] = useState("");
  const [ticketName, setTicketName] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachId, setAttachId] = useState("");
  const [branchMode, setBranchMode] = useState<"new" | "existing">("new");
  const [dashWorktree, setDashWorktree] = useState(true);
  const [branchInfo, setBranchInfo] = useState<RepoBranches | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const [sendTicket, setSendTicket] = useState(true);

  // branch list follows the chosen repo; default base = its dev/uat-style branch
  useEffect(() => {
    setBranchInfo(null);
    setExistingBranch("");
    setBaseBranch("");
    if (!repoPath) return;
    let alive = true;
    window.mb.repoBranches(repoPath).then((r: RepoBranches | { error: string }) => {
      if (!alive || !r || "error" in r) return;
      setBranchInfo(r);
      setBaseBranch(r.defaultBase ?? "");
    });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  const load = async (fresh = false) => {
    setError("");
    window.mb.adoBoards(fresh).then((b: { team: string; boards: AdoBoard[] } | { error: string }) => setBoardsInfo(b));
    const r: { items: AdoWorkItem[]; total: number; me: string } | { error: string } =
      await window.mb.adoList();
    if ("error" in r) {
      setItems([]);
      setError(r.error);
      return;
    }
    setItems(r.items);
    setTotal(r.total);
    setMe(r.me);
    // first run: default the assigned-to filter to the PAT's owner; on later runs,
    // heal any stale spelling of "me" persisted by an older build
    setWho((prev) => {
      if (prev === null) return r.me ? [r.me] : [];
      return r.me
        ? prev.map((p) => (p.toLowerCase() === r.me.toLowerCase() ? r.me : p))
        : prev;
    });
    setSyncedAt(Date.now());
    // board columns = union of the valid states for every type on the board
    const types = [...new Set(r.items.map((i) => i.type))];
    const fetched = await Promise.all(
      types.map((t) => window.mb.adoStates(t).then((s2: string[] | { error: string }) => (Array.isArray(s2) ? s2 : [])))
    );
    const all = new Set<string>([...r.items.map((i) => i.state), ...fetched.flat()]);
    all.delete("Removed");
    setStateCols([...all].sort((a, b) => stateRank(a) - stateRank(b) || a.localeCompare(b)));
  };

  useEffect(() => {
    load();
    window.mb.listRepos().then((r: RepoEntry[] | { error: string }) => Array.isArray(r) && setRepos(r));
  }, []);

  const people = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items ?? []) {
      const n = i.assignedTo || "Unassigned";
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    // selected people and "me" always get a row, even with no cards loaded —
    // a checked filter must never be invisible
    for (const w of who ?? []) if (!counts.has(w)) counts.set(w, 0);
    if (me && !counts.has(me)) counts.set(me, 0);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, who, me]);

  const whoSet = new Set(who ?? []);
  const visibleItems = (items ?? []).filter(
    (i) => whoSet.size === 0 || whoSet.has(i.assignedTo || "Unassigned")
  );
  const whoLabel =
    who === null
      ? "…"
      : whoSet.size === 0
        ? "Everyone"
        : whoSet.size === 1
          ? [...whoSet][0] === me
            ? "Me"
            : [...whoSet][0]
          : `${whoSet.size} people`;
  const toggleWho = (name: string) =>
    setWho((prev) => {
      const n = new Set(prev ?? []);
      n.has(name) ? n.delete(name) : n.add(name);
      return [...n];
    });

  // esc closes the work-item dialog
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && detailId != null) setDetailId(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [detailId]);

  const detail = items?.find((i) => i.id === detailId) ?? null;

  const openDetail = (it: AdoWorkItem) => {
    setDetailId(it.id);
    setTitle(it.title);
    setState(it.state);
    setDesc(it.description);
    setTypeStates([]);
    setTicketName(suggestTicketName(it.title));
    setAttachId("");
    setComments(null);
    setDraft("");
    window.mb.adoStates(it.type).then((r: string[] | { error: string }) => Array.isArray(r) && setTypeStates(r));
    window.mb.adoComments(it.id).then((r: AdoComment[] | { error: string }) => {
      if (Array.isArray(r)) setComments(r);
      else {
        setComments([]);
        setError(r.error);
      }
    });
  };

  /** Optimistic state change (drag between columns or the detail dropdown). */
  const changeState = async (id: number, newState: string) => {
    const prev = items?.find((i) => i.id === id);
    if (!prev || prev.state === newState) return;
    setError("");
    setItems((p) => (p ? p.map((i) => (i.id === id ? { ...i, state: newState } : i)) : p));
    if (detailId === id) setState(newState);
    const r = await window.mb.adoUpdate(id, { state: newState });
    if (r?.error) {
      setItems((p) => (p ? p.map((i) => (i.id === id ? { ...i, state: prev.state } : i)) : p));
      if (detailId === id) setState(prev.state);
      setError(`Couldn't move ${id} to ${newState}: ${r.error}`);
    }
  };

  const dirty = !!detail && (title !== detail.title || state !== detail.state || desc !== detail.description);

  const save = async () => {
    if (!detail || !dirty) return;
    setSaving(true);
    setError("");
    const patch: Record<string, string> = {};
    if (title !== detail.title) patch.title = title;
    if (state !== detail.state) patch.state = state;
    if (desc !== detail.description) patch.description = desc;
    const r = await window.mb.adoUpdate(detail.id, patch);
    setSaving(false);
    if (r?.error) return setError(r.error);
    setItems((p) => (p ? p.map((i) => (i.id === detail.id ? { ...i, title, state, description: desc } : i)) : p));
  };

  const postComment = async () => {
    if (!detail || !draft.trim()) return;
    setPosting(true);
    setError("");
    const r = await window.mb.adoAddComment(detail.id, draft.trim());
    setPosting(false);
    if (r?.error) return setError(r.error);
    setComments((p) => [...(p ?? []), r]);
    setDraft("");
  };

  const groupOf = (it: AdoWorkItem) => String(it.id);
  // sub-group-aware: a session in "5038/backend" still belongs to ticket 5038
  const topGroupOf = (s: SessionInfo) => topOfKey(s.taskGroup ?? "");
  const linkedTo = (it: AdoWorkItem) => sessions.filter((s) => topGroupOf(s) === groupOf(it));
  const linked = detail ? linkedTo(detail) : [];
  const attachable = detail ? sessions.filter((s) => topGroupOf(s) !== groupOf(detail) && s.status !== "dead") : [];

  const startSession = async () => {
    if (!detail || !repoPath) return;
    if (branchMode === "existing" && !existingBranch) return;
    setBusy(true);
    setError("");
    const prompt = sendTicket ? ticketKickoffPrompt(detail.id, title, desc) : undefined;
    const info = await window.mb.createSession({
      repoPath,
      ticketId: String(detail.id),
      ticketTitle: ticketName || suggestTicketName(detail.title),
      useWorktree: dashWorktree,
      ...(branchMode === "existing"
        ? { branchName: existingBranch }
        : baseBranch
          ? { baseBranch }
          : {}),
      initialPrompt: prompt,
    });
    setBusy(false);
    if (info?.error) return setError(info.error);
    onCreated(info);
  };

  return (
    <div className="board">
      <div className="board-filter">
        <span className="flbl">Assigned to</span>
        <span className="who-wrap">
          <button className="who-btn" onClick={() => setWhoOpen((o) => !o)}>
            {whoLabel} <span className="kbd">▾</span>
          </button>
          {whoOpen && (
            <>
              <div className="who-back" onMouseDown={() => setWhoOpen(false)} />
              <div className="who-pop">
                <div
                  className={`who-row ${whoSet.size === 0 ? "on" : ""}`}
                  onClick={() => setWho([])}
                >
                  <span className={`ck ${whoSet.size === 0 ? "on" : ""}`}>{whoSet.size === 0 ? "✓" : ""}</span>
                  Everyone
                  <span className="cnt">{items?.length ?? 0}</span>
                </div>
                <div className="who-div" />
                {people.map(([p, n]) => (
                  <div key={p} className={`who-row ${whoSet.has(p) ? "on" : ""}`} onClick={() => toggleWho(p)}>
                    <span className={`ck ${whoSet.has(p) ? "on" : ""}`}>{whoSet.has(p) ? "✓" : ""}</span>
                    {p === me ? `${p} (me)` : p}
                    <span className="cnt">{n}</span>
                  </div>
                ))}
                <div className="who-hint">check any number of people · stays open while you pick</div>
              </div>
            </>
          )}
        </span>
        <span className="vdiv" />
        {boards && boards.length > 0 && (
          <>
            <span className="flbl">Board</span>
            <Pick
              className="board-pick"
              value={board?.name ?? ""}
              title={boardsInfo && !("error" in boardsInfo) ? `${boardsInfo.team}'s boards in Azure DevOps` : undefined}
              onChange={(e) => setBoardName(e.target.value)}
            >
              {boards.map((b) => (
                <option key={b.id} value={b.name}>{b.name}</option>
              ))}
            </Pick>
          </>
        )}
        <span className="who-wrap">
          <button className="who-btn" onClick={() => setColsOpen((o) => !o)}>
            Columns {hiddenCols.size > 0 && <span className="kbd">{orderedCols.length - [...hiddenCols].filter((c) => orderedCols.includes(c)).length}/{orderedCols.length}</span>}{" "}
            <span className="kbd">▾</span>
          </button>
          {colsOpen && (
            <>
              <div className="who-back" onMouseDown={() => setColsOpen(false)} />
              <div className="who-pop cols-pop">
                <div className="who-hint cols-src">
                  {board
                    ? `${board.name} board · ${boardsInfo && !("error" in boardsInfo) ? boardsInfo.team : ""} — as set up in Azure DevOps`
                    : boardsInfo && "error" in boardsInfo
                      ? `Showing work item states — couldn't read your team's board: ${boardsInfo.error}`
                      : "Showing work item states"}
                </div>
                {orderedCols.map((c) => {
                  const n = visibleItems.filter((i) => colOfItem(i) === c).length;
                  return (
                    <div
                      key={c}
                      className={`who-row col-row ${hiddenCols.has(c) ? "" : "on"}`}
                      data-drop={cue(drag, `cl:${c}`)}
                      onDragOver={(e) => {
                        const src = dragging("text/mb-col");
                        const side = sideOf(e, e.currentTarget, "y");
                        overTarget(e, !src || src === c || samePlace(orderedCols, src, c, side) ? null : { key: `cl:${c}`, side, outcome: `Put ${src} ${side} ${c}` });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const src = e.dataTransfer.getData("text/mb-col");
                        if (src && src !== c) reorderCols(src, c, sideOf(e, e.currentTarget, "y"));
                      }}
                    >
                      <span className="col-grip" draggable title="Drag to reorder" onDragStart={(e) => beginDrag(e, "text/mb-col", c, `Moving column ${c}`)}>
                        ⋮⋮
                      </span>
                      <span className={`ck ${hiddenCols.has(c) ? "" : "on"}`} title={hiddenCols.has(c) ? "Show column" : "Hide column"} onClick={() => toggleHidden(c)}>
                        {hiddenCols.has(c) ? "" : "✓"}
                      </span>
                      <span onClick={() => toggleHidden(c)}>{c}</span>
                      <span className="cnt">{n}</span>
                    </div>
                  );
                })}
                <div className="who-div" />
                <div className="who-row" onClick={() => setPrefs({ order: [], hidden: defaultHidden })}>
                  {board ? "Reset to the board's order" : "Reset order"}
                </div>
              </div>
            </>
          )}
        </span>
        <span style={{ marginLeft: "auto" }} />
        <span className="flbl-info">
          {items ? `${visibleItems.length} items` : ""}
          {board && items && visibleItems.some((i) => colOfItem(i) === null)
            ? ` · ${visibleItems.filter((i) => colOfItem(i) === null).length} on other boards`
            : ""}
          {total > (items?.length ?? 0) ? ` · showing ${items!.length} of ${total}` : ""}
          {syncedAt ? ` · synced ${fmtElapsed(syncedAt)} ago` : " · syncing…"}
        </span>
        <button className="outline" onClick={() => load(true)}>Refresh</button>
      </div>
      {error && <div className="err board-err">{error}</div>}
      <div className="board-cols">
        {items === null && <div className="wi-empty" style={{ padding: 14 }}>Loading work items…</div>}
        {items !== null && stateCols.length === 0 && !error && (
          <div className="wi-empty" style={{ padding: 14 }}>No active work items.</div>
        )}
        {orderedCols.filter((c) => !hiddenCols.has(c)).map((col) => {
          const colItems = visibleItems.filter((i) => colOfItem(i) === col);
          return (
            <div
              key={col}
              className="bcol"
              data-drop={cue(drag, `c:${col}`)}
              onDragOver={(e) => overTarget(e, columnTarget(e, col))}
              onDrop={(e) => {
                e.preventDefault();
                const movedCol = e.dataTransfer.getData("text/mb-col");
                if (movedCol) return movedCol !== col && reorderCols(movedCol, col, sideOf(e, e.currentTarget, "x"));
                const id = parseInt(e.dataTransfer.getData("text/mb-wi"), 10);
                if (id) moveCard(id, col);
              }}
            >
              <div
                className="bcol-hd"
                draggable
                title="drag to reorder columns"
                onDragStart={(e) => beginDrag(e, "text/mb-col", col, `Moving column ${col}`)}
              >
                {col}
                <span className="cnt">{colItems.length}</span>
              </div>
              <div className="bcol-body">
                {colItems.map((it) => {
                  const live = linkedTo(it);
                  return (
                    <div
                      key={it.id}
                      className="bcard"
                      draggable
                      onDragStart={(e) => beginDrag(e, "text/mb-wi", String(it.id), `Moving #${it.id}`)}
                      onClick={() => openDetail(it)}
                      title="drag to another column to change state"
                    >
                      <span className="tbar" style={{ background: typeColor(it.type) }} />
                      <div className="bc-top">
                        <span className="wi-id">{it.id}</span>
                        <span className="bc-type">{it.type}</span>
                        <span className="bc-age">{it.changed ? ago(Date.parse(it.changed)) : ""}</span>
                      </div>
                      <div className="bc-title">{it.title}</div>
                      <div className="bc-foot">
                        {live.map((s) => (
                          <span key={s.id} className={`dot sm ${s.status}`} />
                        ))}
                        <span>{live.length ? `${live.length} session${live.length === 1 ? "" : "s"}` : "no session"}</span>
                        {it.assignedTo !== me && (
                          <span className="bc-who">{it.assignedTo || "Unassigned"}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {detail && (
        <div className="modal-back" onMouseDown={() => setDetailId(null)}>
          <div className="bdetail" onMouseDown={(e) => e.stopPropagation()}>
            <div className="hd">
              <span className="tsq" style={{ background: typeColor(detail.type) }} />
              <span className="wi-id">{detail.id}</span>
              <span className="path">{detail.type}{detail.assignedTo ? ` · ${detail.assignedTo}` : " · Unassigned"}</span>
              <span style={{ marginLeft: "auto" }} />
              {dirty && <span className="kbd" style={{ color: "var(--amber)" }}>unsaved</span>}
              <button className="primary" disabled={!dirty || saving} onClick={save}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button className="outline" onClick={() => window.mb.openExternal(detail.url)}>Open in ADO</button>
              <button className="icon" title="Close (esc)" onClick={() => setDetailId(null)}>✕</button>
            </div>
            <div className="bd-body">
              <div className="wi-form bd-main">
                <label>Title</label>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
                <label>
                  Description <span className="wi-note">plain text — rich formatting is simplified on save</span>
                </label>
                <textarea value={desc} onChange={(e) => setDesc(e.target.value)} spellCheck={false} style={{ minHeight: 140 }} />
                <div className="wi-sec">Discussion</div>
                {comments === null && <div className="wi-empty">Loading comments…</div>}
                {comments?.length === 0 && <div className="wi-empty">No comments yet.</div>}
                {comments?.map((c) => (
                  <div key={c.id} className="cmt">
                    <div className="cmt-hd">
                      <b>{c.author}</b>
                      <span>{c.date ? `${ago(Date.parse(c.date))} ago` : ""}</span>
                    </div>
                    <div className="cmt-tx">{c.text}</div>
                  </div>
                ))}
                <div className="cmt-compose">
                  <textarea
                    placeholder="Write a comment…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    style={{ minHeight: 64 }}
                  />
                  <div className="row">
                    <button className="primary" disabled={!draft.trim() || posting} onClick={postComment}>
                      {posting ? "Posting…" : "Comment"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="wi-form bd-side">
                <label>State</label>
                <Pick value={state} onChange={(e) => setState(e.target.value)}>
                  {[...new Set([state, ...typeStates])].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </Pick>
                <div className="wi-sec">Sessions on this ticket</div>
                {linked.length === 0 && <div className="wi-empty">None yet.</div>}
                {linked.map((s) => (
                  <div key={s.id} className="drow" style={{ cursor: "pointer" }} onClick={() => onJump(s.id)}>
                    <span className={`dot sm ${s.status}`} />
                    <span className="nm">{s.ticketTitle ?? s.title}</span>
                    <span className="st">open ⏎</span>
                  </div>
                ))}
                <label>New session</label>
                <Pick value={repoPath} onChange={(e) => setRepoPath(e.target.value)}>
                  <option value="">repo…</option>
                  {repos.map((r) => (
                    <option key={r.path} value={r.path}>{r.name}</option>
                  ))}
                </Pick>
                <div className="check-line" style={{ marginTop: 6 }}>
                  <input type="checkbox" id="dash-wt" checked={dashWorktree} onChange={(e) => setDashWorktree(e.target.checked)} />
                  <label htmlFor="dash-wt" style={{ margin: 0 }}>
                    isolated worktree
                    <span className="wi-note"> {dashWorktree ? "own folder under worktrees/<repo>/" : "off — branch is checked out in the repo itself"}</span>
                  </label>
                </div>
                <div className="pills" style={{ marginTop: 6 }}>
                  <button className={`pill ${branchMode === "new" ? "on" : ""}`} onClick={() => setBranchMode("new")}>
                    New branch
                  </button>
                  <button
                    className={`pill ${branchMode === "existing" ? "on" : ""}`}
                    onClick={() => setBranchMode("existing")}
                  >
                    Existing branch
                  </button>
                </div>
                {branchMode === "new" ? (
                  <>
                    <input
                      type="text"
                      value={ticketName}
                      onChange={(e) => setTicketName(e.target.value)}
                      style={{ marginTop: 6 }}
                      title="Short name — becomes the branch/worktree suffix"
                    />
                    {branchInfo && branchInfo.branches.length > 0 && (
                      <Pick
                        value={baseBranch}
                        onChange={(e) => setBaseBranch(e.target.value)}
                        style={{ marginTop: 6 }}
                        title="The base is fetched fresh from origin before the new branch is cut"
                      >
                        <option value="">base: current HEAD</option>
                        {branchInfo.branches.map((b) => (
                          <option key={b} value={b}>base: origin/{b}</option>
                        ))}
                      </Pick>
                    )}
                  </>
                ) : (
                  <Pick
                    value={existingBranch}
                    onChange={(e) => setExistingBranch(e.target.value)}
                    style={{ marginTop: 6 }}
                  >
                    <option value="">branch…</option>
                    {(branchInfo?.branches ?? []).map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </Pick>
                )}
                <div className="check-line">
                  <input
                    type="checkbox"
                    checked={sendTicket}
                    onChange={(e) => setSendTicket(e.target.checked)}
                    id="sendtk"
                  />
                  <label htmlFor="sendtk" style={{ margin: 0, textTransform: "none", letterSpacing: 0 }}>
                    send ticket title + description to Claude
                  </label>
                </div>
                <button
                  className="primary"
                  style={{ marginTop: 7 }}
                  disabled={!repoPath || busy || (branchMode === "existing" && !existingBranch)}
                  onClick={startSession}
                >
                  {busy ? "Starting…" : "Start session"}
                </button>
                {branchMode === "new" && repoPath && ticketName && (
                  <div className="wi-note">
                    creates worktree {slugBranch(String(detail.id), ticketName)}
                    {baseBranch ? ` from origin/${baseBranch}` : ""}
                  </div>
                )}
                {branchMode === "existing" && existingBranch && (
                  <div className="wi-note">opens a worktree on {existingBranch}</div>
                )}
                {attachable.length > 0 && (
                  <>
                    <label>Attach existing</label>
                    <Pick value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                      <option value="">choose session…</option>
                      {attachable.map((s) => (
                        <option key={s.id} value={s.id}>{s.ticketTitle ?? s.title}</option>
                      ))}
                    </Pick>
                    <button
                      className="outline"
                      style={{ marginTop: 7 }}
                      disabled={!attachId}
                      onClick={async () => {
                        await window.mb.setGroup(attachId, groupOf(detail));
                        setAttachId("");
                      }}
                    >
                      Attach
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- rename dialog (groups + workspaces) ----
function RenameDialog({
  title,
  initial,
  onSave,
  onClose,
}: {
  title: string;
  initial: string;
  onSave: (v: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal close-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <input
          type="text"
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && v.trim()) onSave(v.trim());
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="row">
          <button className="outline" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ---- move-to-group dialog ----
function GroupDialog({
  session,
  groups,
  onClose,
}: {
  session: SessionInfo;
  groups: string[];
  onClose: () => void;
}) {
  const cur = session.taskGroup ?? "";
  const curTop = cur ? splitGroupKey(cur).top : "";
  const curSub = cur ? (splitGroupKey(cur).sub ?? "") : "";
  const tops = [...new Set(groups.map(topOfKey))];
  const [top, setTop] = useState(curTop && tops.includes(curTop) ? curTop : (tops[0] ?? "__new__"));
  const [newTop, setNewTop] = useState("");
  const [sub, setSub] = useState(curSub);
  const isNew = top === "__new__";
  const effTop = (isNew ? newTop : top).trim().replace(/\//g, "-");

  const move = async (g: string | null) => {
    await window.mb.setGroup(session.id, g);
    onClose();
  };
  const apply = () => {
    if (!effTop) return;
    const cleanSub = sub.trim().replace(/\//g, "-");
    move(cleanSub ? `${effTop}/${cleanSub}` : effTop);
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal close-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Move {session.ticketTitle ?? session.title}</h3>
        <div className="sub-h">
          Pick the group — and optionally a workspace inside it — then Move. Nothing changes until
          you click Move.
        </div>
        <label>Group</label>
        <Pick value={top} onChange={(e) => setTop(e.target.value)}>
          {tops.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
          <option value="__new__">new group…</option>
        </Pick>
        {isNew && (
          <input
            type="text"
            autoFocus
            placeholder="new group name"
            value={newTop}
            onChange={(e) => setNewTop(e.target.value)}
            style={{ marginTop: 6 }}
          />
        )}
        <label>
          Workspace <span className="wi-note">optional — sessions in the same workspace share one tabbed pane</span>
        </label>
        <input
          type="text"
          list="mb-subs"
          placeholder="none"
          value={sub}
          onChange={(e) => setSub(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
        />
        <datalist id="mb-subs">
          {[...new Set(groups.filter((g) => g.startsWith(effTop + "/")).map((g) => splitGroupKey(g).sub))]
            .filter((s): s is string => !!s)
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
        <div className="row">
          {cur && (
            <button className="outline" style={{ marginRight: "auto" }} onClick={() => move(null)}>
              Remove from group
            </button>
          )}
          <button className="outline" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!effTop} onClick={apply}>Move</button>
        </div>
      </div>
    </div>
  );
}

// ---- close-session dialog (design 1e) ----
type CleanupMode = "keep" | "push" | "discard";

/**
 * Restart every Claude pane in place. The CLI prints "Update installed ·
 * Restart to update" when it upgrades itself, and each running claude keeps the
 * old binary until it is restarted — this does the whole grid at once.
 */
function RestartAllDialog({
  sessions,
  onClose,
  onDone,
}: {
  sessions: SessionInfo[];
  onClose: () => void;
  onDone: (restarted: string[]) => void;
}) {
  const [includeBusy, setIncludeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const live = sessions.filter((s) => s.status !== "dead" && !s.shell);
  const active = live.filter((s) => s.status === "working" || s.status === "waiting");
  const count = includeBusy ? live.length : live.length - active.length;

  const run = async () => {
    setBusy(true);
    setError("");
    const r = await window.mb.restartAllSessions(includeBusy);
    if (r?.error) {
      setError(r.error);
      setBusy(false);
      return;
    }
    if (r.failed?.length) {
      setError(`${r.failed.length} couldn't restart: ${r.failed.map((f: any) => f.error).join("; ")}`);
      setBusy(false);
      onDone(r.restarted ?? []);
      return;
    }
    onDone(r.restarted ?? []);
    onClose();
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal close-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Restart agent sessions?</h3>
        <div className="sub-h">
          Each pane relaunches with <code>--continue</code>, so conversations, grid position, and
          groups are kept. Plain terminals and dead panes are left alone.
        </div>
        {active.length > 0 && (
          <label className="check-line" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={includeBusy}
              onChange={(e) => setIncludeBusy(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>
              also restart the {active.length} session{active.length === 1 ? "" : "s"} that{" "}
              {active.length === 1 ? "is" : "are"} working or waiting — their in-flight turn is lost
            </span>
          </label>
        )}
        {error && <div className="err">{error}</div>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="outline" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={run} disabled={busy || count === 0}>
            {busy ? "restarting…" : count === 0 ? "nothing to restart" : `Restart ${count} session${count === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseSessionDialog({
  session,
  wt,
  onCancel,
  onDone,
  forceClose,
}: {
  session: SessionInfo;
  wt: WorktreeStateInfo;
  onCancel: () => void;
  onDone: () => void;
  forceClose: (s: SessionInfo, forget: boolean) => Promise<void>;
}) {
  // the safe option is always preselected; the destructive one is never the default
  const [mode, setMode] = useState<CleanupMode>("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wtName = session.cwd.split("/").pop();
  const stateStr = [wt.dirty ? `${wt.dirtyFiles} uncommitted file${wt.dirtyFiles === 1 ? "" : "s"}` : null, wt.ahead ? `${wt.ahead} unpushed commit${wt.ahead === 1 ? "" : "s"}` : null]
    .filter(Boolean)
    .join(" and ");

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      if (mode === "keep") {
        await forceClose(session, false); // keep the store entry → resumable under Previous
      } else {
        await forceClose(session, true);
        const r = await window.mb.worktreeCleanup(session.repoPath, session.cwd, mode);
        if (r?.error) {
          setError(r.error);
          setBusy(false);
          return;
        }
      }
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const opts: { mode: CleanupMode; label: string; consequence: string; destructive?: boolean }[] = [
    {
      mode: "keep",
      label: "Keep worktree, close pane",
      consequence: "nothing is lost · resumable under Previous",
    },
    {
      mode: "push",
      label: "Push branch, then remove worktree",
      consequence: wt.dirty ? `commits WIP on ${wt.branch}, pushes, removes the worktree` : `pushes ${wt.branch}, removes the worktree`,
    },
    {
      mode: "discard",
      label: "Discard everything and delete",
      consequence: "removes the worktree and deletes the branch · not recoverable",
      destructive: true,
    },
  ];

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !busy) {
        e.preventDefault();
        confirm();
      }
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal close-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Close {session.ticketTitle ?? session.title}?</h3>
        <div className="sub-h">
          Worktree <span className="wt-name">{wtName}</span> has {stateStr || "local work"}.
        </div>
        {opts.map((o) => (
          <button
            key={o.mode}
            className={`opt ${mode === o.mode ? "sel" : ""} ${o.destructive ? "destructive" : ""}`}
            onClick={() => setMode(o.mode)}
          >
            <span className="t">
              <span className="radio" />
              {o.label}
            </span>
            <div className="c">{o.consequence}</div>
          </button>
        ))}
        {error && <div className="err">{error}</div>}
        <div className="row">
          <span className="kbd foot-hint">⏎ to confirm</span>
          <button className="outline" onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={busy} onClick={confirm}>
            {busy ? "Closing…" : "Close session"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- broadcast + CLAUDE.md control room (design 1g) ----
type DeliveryState = { state: "delivered" | "queued" | "skipped"; at?: string; note?: string };

function ControlRoomPanel({ sessions }: { sessions: SessionInfo[] }) {
  const repoPaths = useMemo(
    () => [...new Set(sessions.filter((s) => s.repoPath).map((s) => s.repoPath!))],
    [sessions]
  );
  const [target, setTarget] = useState("~/.claude/CLAUDE.md");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loadedPath, setLoadedPath] = useState("");
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delivery, setDelivery] = useState<Record<string, DeliveryState>>({});

  const [ioError, setIoError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; // a slower earlier read must not land on top of a newer target
    setIoError(null);
    window.mb
      .readClaudeMd(target)
      .then((r: { path: string; content: string } | { error: string }) => {
        if (!alive) return;
        if ("error" in r) {
          // an unreadable file must never look like an empty one — saving that
          // empty editor back would overwrite the real CLAUDE.md
          setIoError(`Couldn't read ${target}: ${r.error}`);
          setContent("");
          setOriginal("");
          setLoadedPath(target);
          return;
        }
        setContent(r.content);
        setOriginal(r.content);
        setLoadedPath(r.path);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  const dirty = content !== original;
  const changedLines = useMemo(() => {
    if (!dirty) return 0;
    const a = original.split("\n");
    const b = content.split("\n");
    let n = Math.abs(b.length - a.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
    return n;
  }, [content, original, dirty]);

  // shells are excluded — a broadcast typed into a plain terminal would run as commands
  const live = sessions.filter((s) => s.status !== "dead" && !s.shell);
  // sessions that will be told to re-read: rooted in the repo, or all live for global
  const repoOf = target.replace(/\/CLAUDE\.md$/, "");
  const rereadTargets = target.startsWith("~")
    ? live
    : live.filter((s) => s.repoPath === repoOf);

  const bTargets = scope === "all" ? live : live.filter((s) => selected.has(s.id));

  const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const markDelivery = (targets: SessionInfo[]) => {
    setDelivery((prev) => {
      const d: Record<string, DeliveryState> = { ...prev };
      for (const s of sessions) {
        if (!targets.some((t) => t.id === s.id)) {
          if (s.status === "dead") d[s.id] = { state: "skipped", note: "skipped · dead" };
          continue;
        }
        d[s.id] =
          s.status === "working"
            ? { state: "queued", note: "queued · busy" }
            : { state: "delivered", at: now(), note: `delivered ${now()}` };
      }
      return d;
    });
  };

  // promote queued → delivered when a session's queue drains (visible per design 1g)
  useEffect(() => {
    setDelivery((prev) => {
      let changed = false;
      const d = { ...prev };
      for (const s of sessions) {
        if (d[s.id]?.state === "queued" && (s.queuedCount ?? 0) === 0 && s.status !== "working") {
          d[s.id] = { state: "delivered", at: now(), note: `delivered ${now()}` };
          changed = true;
        }
      }
      return changed ? d : prev;
    });
  }, [sessions]);

  const saveAndReread = async (broadcastToo: boolean) => {
    if (ioError) return; // don't write an editor we never managed to fill
    const r = await window.mb.saveClaudeMd(target, content);
    if (r && typeof r === "object" && "error" in r) {
      setIoError(`Couldn't save ${target}: ${(r as { error: string }).error}`);
      return; // no broadcast — nothing was written to re-read
    }
    setIoError(null);
    setOriginal(content);
    if (broadcastToo && rereadTargets.length) {
      await window.mb.broadcast({
        message: `Heads up: ${loadedPath} was just updated. Please re-read it now and apply it to all work going forward in this session.`,
        sessionIds: rereadTargets.map((s) => s.id),
        whenIdle: true,
      });
      markDelivery(rereadTargets);
    }
  };

  const queueBroadcast = async () => {
    if (!message.trim() || !bTargets.length) return;
    await window.mb.broadcast({ message, sessionIds: bTargets.map((s) => s.id), whenIdle: true });
    markDelivery(bTargets);
    setMessage("");
  };

  return (
    <div className="control">
        <div className="editor">
          <div className="hd">
            <span className="t">CLAUDE.md</span>
            <span className="path">{loadedPath}</span>
            {dirty && <span className="unsaved">unsaved</span>}
            {ioError && <span className="err-inline">{ioError}</span>}
          </div>
          <Pick value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="~/.claude/CLAUDE.md">global — ~/.claude/CLAUDE.md</option>
            {repoPaths.map((p) => (
              <option key={p} value={`${p}/CLAUDE.md`}>{p.split("/").pop()} — {p}/CLAUDE.md</option>
            ))}
          </Pick>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          <div className="ft">
            <span className="diff">{dirty ? `${changedLines} line${changedLines === 1 ? "" : "s"} changed` : "no changes"}</span>
            <button className="outline" disabled={!dirty} onClick={() => saveAndReread(false)}>Save</button>
            <button className="primary" disabled={!dirty || !rereadTargets.length} onClick={() => saveAndReread(true)}>
              Save &amp; re-read in {rereadTargets.length}
            </button>
          </div>
        </div>

        <div className="rail-b">
          <div className="hd">
            <span className="t">Broadcast</span>
            <span className="unsaved kbd" style={{ color: "var(--text-4)" }}>⌘⇧B</span>
          </div>
          <div className="composer">
            <textarea
              placeholder="e.g. Run the linter before declaring anything done."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="pills">
              <button className={`pill ${scope === "all" ? "on" : ""}`} onClick={() => setScope("all")}>
                All ({live.length})
              </button>
              <button className={`pill ${scope === "selected" ? "on" : ""}`} onClick={() => setScope("selected")}>
                Selected ({selected.size})
              </button>
            </div>
            <button className="primary" disabled={!message.trim() || !bTargets.length} onClick={queueBroadcast}>
              Queue for {bTargets.length} session{bTargets.length === 1 ? "" : "s"}
            </button>
          </div>
          <div className="delivery">
            <div className="grp">Delivery</div>
            {sessions.filter((s) => !s.shell).map((s) => {
              const d = delivery[s.id];
              const note =
                d?.note ??
                (s.status === "dead" ? "skipped · dead" : (s.queuedCount ?? 0) > 0 ? "queued · busy" : "");
              const cls = note.startsWith("delivered") ? "teal" : note.startsWith("queued") ? "amber" : "";
              return (
                <div
                  key={s.id}
                  className="drow"
                  style={{ cursor: scope === "selected" ? "pointer" : "default", opacity: scope === "selected" && !selected.has(s.id) ? 0.55 : 1 }}
                  onClick={() =>
                    scope === "selected" &&
                    setSelected((p) => {
                      const n = new Set(p);
                      n.has(s.id) ? n.delete(s.id) : n.add(s.id);
                      return n;
                    })
                  }
                >
                  <span className={`dot sm ${s.status}`} />
                  <span className="nm">{s.ticketTitle ?? s.title}</span>
                  <span className={`st ${cls}`}>{note}</span>
                </div>
              );
            })}
          </div>
        </div>
    </div>
  );
}

// ---- settings tab: general config (with native pickers) + the control room ----

/** Settings card: every <repo>-worktrees checkout, with strays removable. */
function WorktreeJanitor() {
  const [list, setList] = useState<WorktreeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const load = async () => {
    const r = await window.mb.listWorktrees();
    if (r?.error) return setError(r.error);
    setError("");
    setList(r);
    // a rescan drops selections for worktrees that are gone or now in use
    const removable = new Set((r as WorktreeEntry[]).filter((w) => !w.inUse).map((w) => w.path));
    setSelected((s) => new Set([...s].filter((p) => removable.has(p))));
  };
  useEffect(() => {
    load();
  }, []);
  const riskOf = (w: WorktreeEntry) =>
    w.dirty
      ? `${w.name}: ${w.dirtyFiles} uncommitted file${w.dirtyFiles === 1 ? "" : "s"} will be lost`
      : w.ahead
        ? `${w.name}: ${w.ahead} unpushed commit${w.ahead === 1 ? "" : "s"} on ${w.branch} (the branch is kept)`
        : null;
  // one confirmation for the whole batch, listing every worktree that would lose work;
  // removals run one at a time and every failure is reported, not just the first
  const remove = async (ws: WorktreeEntry[]) => {
    if (ws.length === 0) return;
    const risks = ws.map(riskOf).filter(Boolean) as string[];
    const what = ws.length === 1 ? `the worktree folder ${ws[0].path}` : `${ws.length} worktree folders`;
    const msg = (risks.length ? `${risks.join("\n")}\n\n` : "") + `Remove ${what}?`;
    if (!window.confirm(msg)) return;
    setBusy("remove");
    const failures: string[] = [];
    for (const w of ws) {
      const r = await window.mb.removeWorktree(w.repoPath, w.path);
      if (r?.error) failures.push(`${w.name}: ${r.error}`);
    }
    setBusy(null);
    await load(); // reload first: it clears the error, and these failures must stay visible
    setError(failures.join(" · "));
  };
  const strays = list?.filter((w) => !w.inUse) ?? [];
  const chosen = strays.filter((w) => selected.has(w.path));
  const toggle = (path: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  const allChosen = strays.length > 0 && chosen.length === strays.length;
  const movable = list?.filter((w) => w.legacy && !w.inUse && !w.error) ?? [];
  const migrate = async (ws: WorktreeEntry[]) => {
    setBusy("migrate");
    const failures: string[] = [];
    for (const w of ws) {
      const r = await window.mb.migrateWorktree(w.repoPath, w.path);
      if (r?.error) failures.push(`${w.name}: ${r.error}`);
    }
    setBusy(null);
    await load(); // reload first: it clears the error, and these failures must stay visible
    setError(failures.join(" · "));
  };
  return (
    <div className="set-card">
      <h3>Worktrees</h3>
      <label>
        Isolated checkouts{" "}
        <span className="wi-note">
          one folder beside your repos: <code>worktrees/&lt;repo&gt;/&lt;branch&gt;</code> · {list ? `${list.length} total · ${strays.length} not in use` : "scanning…"}
        </span>
      </label>
      {movable.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 4 }}>
          <button className="outline" disabled={busy === "migrate"} onClick={() => migrate(movable)}>
            {busy === "migrate" ? "moving…" : `Move ${movable.length} old-layout worktree${movable.length === 1 ? "" : "s"} into worktrees/`}
          </button>
          <span className="wi-note">from <code>&lt;repo&gt;-worktrees/</code> · in-use ones are skipped</span>
        </div>
      )}
      {strays.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-start", gap: 10, marginTop: 4 }}>
          <label className="check-line" style={{ margin: 0, textTransform: "none", letterSpacing: 0 }}>
            <input
              type="checkbox"
              checked={allChosen}
              onChange={() => setSelected(allChosen ? new Set() : new Set(strays.map((w) => w.path)))}
            />
            <span>all {strays.length} not in use</span>
          </label>
          <button className="outline" disabled={chosen.length === 0 || busy === "remove"} onClick={() => remove(chosen)}>
            {busy === "remove" ? "removing…" : `Remove ${chosen.length || ""} selected`}
          </button>
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {list && list.length === 0 && <div className="wi-note">none — sessions are running in repo checkouts</div>}
      {list && list.length > 0 && (
        <div className="wt-list">
          {list.map((w) => (
            <div key={w.path} className={`wt-row ${w.inUse ? "live" : ""} ${selected.has(w.path) ? "sel" : ""}`}>
              <input
                type="checkbox"
                className="wt-check"
                disabled={w.inUse}
                checked={selected.has(w.path)}
                onChange={() => toggle(w.path)}
                title={w.inUse ? "in use by a session" : "select for removal"}
              />
              <span className="wt-repo">{w.repoName}</span>
              <span className="wt-name" title={w.path}>
                {w.name}
                {w.legacy && <span className="wt-legacy"> old layout</span>}
              </span>
              <span className="wt-meta">
                {w.error
                  ? `⚠ ${w.error}`
                  : [
                      w.branch,
                      w.dirty ? `${w.dirtyFiles} dirty` : "clean",
                      w.ahead ? `↑${w.ahead}` : null,
                      w.behind ? `↓${w.behind}` : null,
                      w.ageDays ? `${w.ageDays}d` : "today",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
              {w.inUse ? (
                <span className="wt-live">in use</span>
              ) : (
                <button className="outline" disabled={busy === "remove"} onClick={() => remove([w])}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "repos", label: "Repos" },
  { id: "ado", label: "Azure DevOps" },
  { id: "debriefs", label: "Debriefs" },
  { id: "control", label: "Control room" },
  { id: "about", label: "About" },
] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** One setting: name and a short note on the left, its control on the right. */
function SetRow({ title, note, children }: { title: React.ReactNode; note?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {note && <div className="set-row-note">{note}</div>}
      </div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function SettingsView({
  sessions,
  theme,
  onTheme,
  onRestartAll,
  onSetup,
  onUpdate,
  jump,
}: {
  sessions: SessionInfo[];
  theme: "dark" | "light";
  onTheme: (t: "dark" | "light") => void;
  onRestartAll: () => void;
  onSetup: () => void;
  onUpdate: () => void;
  /** Open a specific section, e.g. the control room from ⌘⇧B. */
  jump: { section: SettingsSection; n: number } | null;
}) {
  const [section, setSection] = useState<SettingsSection>(() => jump?.section ?? loadLS("mb.setSection", "general"));
  useEffect(() => {
    if (jump) setSection(jump.section);
  }, [jump]);
  useEffect(() => localStorage.setItem("mb.setSection", JSON.stringify(section)), [section]);
  const [s, setS] = useState<Settings | null>(null);
  const [saveState, setSaveState] = useState<{ ok: boolean; msg: string } | null>(null);
  const [status, setStatus] = useState<SetupStatus | { error: string } | null>(null);
  const [conn, setConn] = useState<{ az: boolean; global: string[]; project: string[] } | { error: string } | null>(null);
  const [updating, setUpdating] = useState<"claude" | "codex" | null>(null);
  const [agentNote, setAgentNote] = useState("");
  const [updNote, setUpdNote] = useState("");
  const [adoCfg, setAdoCfg] = useState<{ orgUrl: string; project: string; patFile: string } | null>(null);
  const [adoNote, setAdoNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpCmd, setMcpCmd] = useState("");
  const [mcpErr, setMcpErr] = useState("");
  const [version, setVersion] = useState("");

  const loadStatus = () => {
    setStatus(null);
    window.mb.setupStatus().then(setStatus);
  };
  const loadConnectors = () => window.mb.connectorsStatus().then(setConn);
  useEffect(() => {
    window.mb.getSettings().then(setS);
    window.mb.appVersion().then(setVersion);
    window.mb.adoConfigGet().then((r: any) => {
      if (r?.error) setAdoNote({ ok: false, msg: `Couldn't read your Azure DevOps config: ${r.error}` });
      else setAdoCfg(r);
    });
    loadStatus();
    loadConnectors();
  }, []);
  if (!s) return <div className="settings-page" />;

  // every change saves immediately — there is no Save button to forget
  const upd = async (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    const r = await window.mb.setSettings(next);
    setSaveState(r?.error ? { ok: false, msg: `Couldn't save: ${r.error}` } : { ok: true, msg: "Saved" });
    if (patch.repoRoots || patch.claudeBin || patch.codexBin) loadStatus();
  };
  const pickBin = async (key: "claudeBin" | "codexBin") => {
    const p = await window.mb.pickPath({ file: true, defaultPath: "/usr/local/bin" });
    if (p) upd({ [key]: p });
  };
  const addRoot = async () => {
    const p = await window.mb.pickPath({ defaultPath: s.repoRoots[0] ?? "~" });
    if (p) upd({ repoRoots: [...new Set([...s.repoRoots, p])] });
  };
  const connectAdo = async () => {
    if (!adoCfg) return;
    setConnecting(true);
    const r = await window.mb.adoConfigSet(adoCfg);
    if (r?.error) {
      setConnecting(false);
      return setAdoNote({ ok: false, msg: `Couldn't save: ${r.error}` });
    }
    const me = await window.mb.adoMe();
    setConnecting(false);
    setAdoNote(me?.error ? { ok: false, msg: me.error } : { ok: true, msg: `Connected as ${me.display}` });
    loadStatus();
  };
  const st = status && !("error" in status) ? status : null;
  const agentLine = (a?: AgentCheck) =>
    !a ? "checking…" : !a.found ? "not installed" : `${a.version ?? ""}${a.signedIn === true ? " · signed in" : a.signedIn === false ? " · not signed in" : ""}`;

  return (
    <div className="settings-page set2">
      <nav className="set-nav">
        {SETTINGS_SECTIONS.map((x) => (
          <button key={x.id} className={section === x.id ? "on" : ""} onClick={() => setSection(x.id)}>
            {x.label}
          </button>
        ))}
        {saveState && <span className={`set-saved ${saveState.ok ? "" : "bad"}`}>{saveState.msg}</span>}
      </nav>

      <div className={`set-body ${section === "control" ? "wide" : ""}`}>
        {section === "general" && (
          <>
            <h2>General</h2>
            <SetRow title="Theme">
              <span className="seg">
                <button className={theme === "dark" ? "on" : ""} onClick={() => onTheme("dark")}>Dark</button>
                <button className={theme === "light" ? "on" : ""} onClick={() => onTheme("light")}>Light</button>
              </span>
            </SetRow>
            <SetRow title="Notifications" note="When a session finishes or needs you">
              <Toggle label="Notifications" on={s.notifications} onChange={(v) => upd({ notifications: v })} />
            </SetRow>
            <SetRow title="Setup wizard" note="Agents, status hooks, repo folders, Azure DevOps">
              <button className="outline" onClick={onSetup}>Run setup</button>
            </SetRow>
          </>
        )}

        {section === "agents" && (
          <>
            <h2>Agents</h2>
            {status && "error" in status && <div className="err">Couldn't check agents: {status.error}</div>}
            <SetRow title="Claude Code" note={agentLine(st?.claude)}>
              <button
                className="outline"
                disabled={updating !== null}
                onClick={async () => {
                  setUpdating("claude");
                  const r = await window.mb.agentUpdate("claude");
                  setUpdating(null);
                  setAgentNote(r?.error ? `Claude Code update failed: ${r.error}` : `Claude Code: ${r} — restart sessions to use it`);
                  loadStatus();
                }}
              >
                {updating === "claude" ? "Updating…" : "Update"}
              </button>
            </SetRow>
            <SetRow title="Codex" note={agentLine(st?.codex)}>
              <button
                className="outline"
                disabled={updating !== null || (st !== null && !st.codex.found)}
                onClick={async () => {
                  setUpdating("codex");
                  const r = await window.mb.agentUpdate("codex");
                  setUpdating(null);
                  setAgentNote(r?.error ? `Codex update failed: ${r.error}` : `Codex: ${r} — restart sessions to use it`);
                  loadStatus();
                }}
              >
                {updating === "codex" ? "Updating…" : "Update"}
              </button>
            </SetRow>
            {agentNote && <div className="set-note">{agentNote}</div>}
            <SetRow
              title="Restart all sessions"
              note="Moves every pane onto the newest CLI build and resumes each conversation — needed after an update, or when a new model says the CLI must update"
            >
              <button className="outline" onClick={onRestartAll}>Restart</button>
            </SetRow>
            <SetRow
              title="Status hooks"
              note={
                !st
                  ? "checking…"
                  : st.hooks.codex === false
                    ? "Codex hooks missing — Codex panes won't show working / waiting / idle"
                    : st.hooks.claude
                      ? `Installed for Claude Code${st.hooks.codex ? " and Codex (Codex asks you to trust them once: /hooks)" : ""}`
                      : "Not installed — panes won't show working / waiting / idle"
              }
            >
              {st && (!st.hooks.claude || st.hooks.codex === false) ? (
                <button
                  className="outline"
                  onClick={async () => {
                    const r = await window.mb.installHooks();
                    if (r?.error) setAgentNote(`Couldn't install hooks: ${r.error}`);
                    loadStatus();
                  }}
                >
                  Install
                </button>
              ) : st ? (
                <span className="set-ok">✓</span>
              ) : null}
            </SetRow>
            <SetRow
              title="Auto-send agent messages"
              note="Sessions can message each other. Off: an incoming message waits in the prompt until you press Enter"
            >
              <Toggle label="Auto-send agent messages" on={s.agentMessagesSubmit !== false} onChange={(v) => upd({ agentMessagesSubmit: v })} />
            </SetRow>
            <SetRow title="Claude Code binary" note={s.claudeBin}>
              <button className="outline" onClick={() => pickBin("claudeBin")}>Change…</button>
            </SetRow>
            <SetRow title="Codex binary" note={s.codexBin ?? "codex"}>
              <button className="outline" onClick={() => pickBin("codexBin")}>Change…</button>
            </SetRow>
          </>
        )}

        {section === "repos" && (
          <>
            <h2>Repos</h2>
            <p className="set-lede">New Session lists the git repos under these folders.</p>
            {s.repoRoots.map((r) => {
              const found = st?.repoRoots.find((x) => x.path === r);
              return (
                <SetRow
                  key={r}
                  title={r}
                  note={!found ? "" : !found.exists ? "folder not found" : `${found.repos} repo${found.repos === 1 ? "" : "s"}`}
                >
                  <button className="danger" title="Remove" onClick={() => upd({ repoRoots: s.repoRoots.filter((x) => x !== r) })}>
                    ✕
                  </button>
                </SetRow>
              );
            })}
            <div className="set-actions">
              <button className="outline" onClick={addRoot}>Add folder…</button>
            </div>
            <WorktreeJanitor />
          </>
        )}

        {section === "ado" && (
          <>
            <h2>Azure DevOps</h2>
            <p className="set-lede">
              Powers the Dashboard, the ticket picker in New Session, and debrief snapshots. Use your own personal access
              token — the board's "assigned to me" follows whoever owns it.
            </p>
            <SetRow
              title="Connection"
              note={!st ? "checking…" : st.ado.connected ? `Connected as ${st.ado.display} · ${st.ado.detail}` : st.ado.detail}
            >
              {st && <span className={st.ado.connected ? "set-ok" : "set-bad"}>{st.ado.connected ? "✓" : "✕"}</span>}
            </SetRow>
            <SetRow title="WorkTracker folder" note={`${s.workTrackerPath} — holds config.json and debrief notes`}>
              <button
                className="outline"
                onClick={async () => {
                  const p = await window.mb.pickPath({ defaultPath: s.workTrackerPath });
                  if (p) upd({ workTrackerPath: p });
                }}
              >
                Change…
              </button>
            </SetRow>
            {adoCfg && (
              <div className="set-form">
                <label>Organization URL</label>
                <input type="text" placeholder="https://dev.azure.com/YourOrg" value={adoCfg.orgUrl} onChange={(e) => setAdoCfg({ ...adoCfg, orgUrl: e.target.value })} />
                <label>Project</label>
                <input type="text" placeholder="YourProject" value={adoCfg.project} onChange={(e) => setAdoCfg({ ...adoCfg, project: e.target.value })} />
                <label>Token file</label>
                <div className="path-row">
                  <span className="p">{adoCfg.patFile || "a text file containing your personal access token"}</span>
                  <button
                    className="outline"
                    onClick={async () => {
                      const p = await window.mb.pickPath({ file: true, defaultPath: s.workTrackerPath });
                      if (p) setAdoCfg({ ...adoCfg, patFile: p });
                    }}
                  >
                    Browse…
                  </button>
                </div>
                <div className="set-actions">
                  <button
                    className="outline strong"
                    disabled={connecting || !adoCfg.orgUrl.trim() || !adoCfg.project.trim() || !adoCfg.patFile.trim()}
                    onClick={connectAdo}
                  >
                    {connecting ? "Connecting…" : "Save and connect"}
                  </button>
                </div>
              </div>
            )}
            {adoNote && <div className={adoNote.ok ? "set-note ok" : "err"}>{adoNote.msg}</div>}
          </>
        )}

        {section === "debriefs" && (
          <>
            <h2>Debriefs</h2>
            <p className="set-lede">
              The morning brief and 4pm wrap-up run an assistant in your WorkTracker folder that follows{" "}
              <code>instructions/morning.md</code> and <code>wrap-up.md</code> there.
            </p>
            <SetRow title="Run automatically" note={`${s.debriefs.morning} and ${s.debriefs.wrapUp}, weekdays, while the app is open`}>
              <Toggle label="Run debriefs automatically" on={s.debriefs.enabled} onChange={(v) => upd({ debriefs: { ...s.debriefs, enabled: v } })} />
            </SetRow>
            <SetRow
              title="Azure CLI"
              note={
                conn === null
                  ? "checking…"
                  : "error" in conn
                    ? `Couldn't check: ${conn.error}`
                    : conn.az
                      ? "Found — your token is passed to debrief sessions, so az boards / az repos work without az login"
                      : "Not installed — debriefs still get the ticket snapshot"
              }
            />
            <h3 className="set-sub">MCP servers for debrief sessions</h3>
            <p className="set-lede">
              Optional. Saved to WorkTracker/.mcp.json; Claude Code asks you to approve each on first use.
              {conn && !("error" in conn) && conn.global.length > 0 && ` Also configured for every session: ${conn.global.join(", ")} (manage with claude mcp).`}
            </p>
            {conn && !("error" in conn) &&
              conn.project.map((n) => (
                <SetRow key={n} title={n}>
                  <button
                    className="danger"
                    title="Remove"
                    onClick={async () => {
                      const r = await window.mb.mcpRemove(n);
                      setMcpErr(r?.error ? `Couldn't remove ${n}: ${r.error}` : "");
                      loadConnectors();
                    }}
                  >
                    ✕
                  </button>
                </SetRow>
              ))}
            <div className="set-inline">
              <input type="text" style={{ flex: 1 }} placeholder="azure-devops" value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
              <input type="text" style={{ flex: 2.2 }} placeholder="npx -y @azure-devops/mcp YourOrg" value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} />
              <button
                className="outline"
                disabled={!mcpName.trim() || !mcpCmd.trim()}
                onClick={async () => {
                  const r = await window.mb.mcpAdd(mcpName.trim(), mcpCmd.trim());
                  if (r?.error) return setMcpErr(`Couldn't add ${mcpName.trim()}: ${r.error}`);
                  setMcpErr("");
                  setMcpName("");
                  setMcpCmd("");
                  loadConnectors();
                }}
              >
                Add
              </button>
            </div>
            {mcpErr && <div className="err">{mcpErr}</div>}
          </>
        )}

        {section === "control" && (
          <>
            <h2>Control room</h2>
            <p className="set-lede">Broadcast an instruction to many sessions at once, or edit CLAUDE.md and have every session re-read it.</p>
            <div className="set-card p0">
              <ControlRoomPanel sessions={sessions} />
            </div>
          </>
        )}

        {section === "about" && (
          <>
            <h2>About</h2>
            <SetRow title="Mockingbird" note={version ? `Version ${version}` : ""}>
              <button
                className="outline"
                onClick={async () => {
                  setUpdNote("Checking…");
                  const r = await window.mb.updateCheck();
                  const where = (u: { source: string }) => (u.source === "release" ? "the latest release" : "the newest version on GitHub");
                  if (r === null) setUpdNote("This build doesn't say where its updates come from, so it can't check.");
                  else if (r?.error) setUpdNote(`Couldn't check: ${r.error}`);
                  else if (r.newer) {
                    setUpdNote(`Version ${r.latest} is available.`);
                    onUpdate();
                  }
                  else if (r.latest === r.current) setUpdNote(`Up to date — ${r.current} is ${where(r)}.`);
                  else setUpdNote(`Up to date — you're on ${r.current}, ahead of ${where(r)} (${r.latest}).`);
                }}
              >
                Check for updates
              </button>
            </SetRow>
            {updNote && <div className="set-note">{updNote}</div>}
            <UpdateSourceRow onUpdate={onUpdate} />
            <SetRow title="Guide" note="Every feature and shortcut">
              <span className="kbd">⌘/</span>
            </SetRow>
          </>
        )}
      </div>
    </div>
  );
}

/** Where in-app updates build from: the user's clone, found automatically or chosen. */
function UpdateSourceRow({ onUpdate }: { onUpdate: () => void }) {
  const [src, setSrc] = useState<{ configured: string | null; found: string | null; problem?: string } | null>(null);
  const load = () => window.mb.updateSource().then((r: any) => setSrc(r?.error ? { configured: null, found: null, problem: r.error } : r));
  useEffect(() => {
    load();
  }, []);
  const choose = async (dir: string | null) => {
    const s: Settings = await window.mb.getSettings();
    await window.mb.setSettings({ ...s, updateSource: dir });
    load();
  };
  const note = !src
    ? "Looking for your clone…"
    : src.problem
      ? src.problem
      : src.found
        ? `${src.found}${src.configured ? "" : " (found automatically)"}`
        : "No clone of Mockingbird under your repo folders — updates can't build until you clone it or choose its folder.";
  return (
    <SetRow title="Updates build from" note={note}>
      <button className="outline" onClick={async () => { const d = await window.mb.pickPath({ defaultPath: src?.found ?? undefined }); if (d) choose(d); }}>
        Choose…
      </button>
      {src?.configured && <button className="outline" onClick={() => choose(null)}>Find automatically</button>}
      <button className="outline" disabled={!src?.found} onClick={onUpdate}>Update…</button>
    </SetRow>
  );
}

type LaunchKind = AgentKind | "shell";

function NewSessionModal({
  existingGroups,
  initialLaunch,
  initialGroup,
  onClose,
  onCreated,
}: {
  existingGroups: string[];
  initialLaunch?: LaunchKind;
  initialGroup?: string; // "5038" or "5038/backend" — a workspace path adds a tab there
  onClose: () => void;
  onCreated: (s: SessionInfo) => void;
}) {
  const [launch, setLaunch] = useState<LaunchKind>(initialLaunch ?? "claude");
  const isAgent = launch !== "shell";
  const agentLabel = launch === "codex" ? "Codex" : "Claude";
  // model/effort ride the agent's command line; the last choice is remembered
  // per agent because people tend to have a working default for each
  const [model, setModel] = useState(() => loadLS("mb.newModel", ""));
  const [modelCustom, setModelCustom] = useState(() => loadLS("mb.newModelCustom", ""));
  const [effort, setEffort] = useState(() => loadLS("mb.newEffort", ""));
  const [codexModel, setCodexModel] = useState(() => loadLS("mb.newCodexModel", ""));
  const [codexEffort, setCodexEffort] = useState(() => loadLS("mb.newCodexEffort", ""));
  // the models and effort levels the CLIs offer on this Mac (read from the CLIs, not built in)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    window.mb.modelCatalog().then((c: ModelCatalog | { error: string }) => !("error" in c) && setCatalog(c));
  }, []);
  const [codexCustom, setCodexCustom] = useState(false);
  useEffect(() => {
    // a saved model the catalog doesn't list is a custom id: show it in the text box
    if (catalog && codexModel && !catalog.codex.models.some((m) => m.id === codexModel)) setCodexCustom(true);
  }, [catalog]);
  const codexInfo = catalog?.codex.models.find((m) => m.id === codexModel);
  useEffect(() => localStorage.setItem("mb.newModel", JSON.stringify(model)), [model]);
  useEffect(() => localStorage.setItem("mb.newModelCustom", JSON.stringify(modelCustom)), [modelCustom]);
  useEffect(() => localStorage.setItem("mb.newEffort", JSON.stringify(effort)), [effort]);
  useEffect(() => localStorage.setItem("mb.newCodexModel", JSON.stringify(codexModel)), [codexModel]);
  useEffect(() => localStorage.setItem("mb.newCodexEffort", JSON.stringify(codexEffort)), [codexEffort]);
  const effModel = launch === "codex" ? codexModel.trim() : model === "__custom" ? modelCustom.trim() : model;
  const effEffort = launch === "codex" ? codexEffort : effort;
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<RepoEntry | null>(null);
  const [ticketId, setTicketId] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  // Group + Workspace as two explicit selectors ("workspace" = what the path
  // syntax called a sub-group). Seeded initialGroup ("top" or "top/sub") comes
  // from a workspace's + button; a seeded name that doesn't exist yet lands in
  // the matching "new …" input instead.
  const allTops = useMemo(() => [...new Set(existingGroups.map(topOfKey))], [existingGroups]);
  const subsOf = (top: string) =>
    [...new Set(
      existingGroups
        .filter((g) => g.startsWith(top + "/"))
        .map((g) => splitGroupKey(g).sub)
        .filter((x): x is string => !!x)
    )];
  const seed = initialGroup ? splitGroupKey(initialGroup) : null;
  const [grpSel, setGrpSel] = useState<string>(() =>
    seed ? (allTops.includes(seed.top) ? seed.top : "__new") : ""
  );
  const [grpNew, setGrpNew] = useState(() => (seed && !allTops.includes(seed.top) ? seed.top : ""));
  const [wsSel, setWsSel] = useState<string>(() => {
    if (!seed?.sub) return "";
    return subsOf(seed.top).includes(seed.sub) ? seed.sub : "__new";
  });
  const [wsNew, setWsNew] = useState(() =>
    seed?.sub && !subsOf(seed.top).includes(seed.sub) ? seed.sub : ""
  );
  const effTop = grpSel === "__new" ? sanitizeSegment(grpNew) : grpSel;
  const effSub = wsSel === "__new" ? sanitizeSegment(wsNew) : wsSel;
  const group = effTop ? (effSub ? `${effTop}/${effSub}` : effTop) : "";
  // Picking a ticket defaults to an isolated worktree under
  // <parent>/worktrees/<repo>/<branch>; unticked, the branch is checked out in
  // the repo itself. An explicit choice is remembered and wins.
  const wtPref = loadLS<boolean | null>("mb.newWorktree", null);
  const [useWorktree, setUseWorktreeRaw] = useState<boolean>(wtPref ?? false);
  const setUseWorktree = (v: boolean) => {
    setUseWorktreeRaw(v);
    localStorage.setItem("mb.newWorktree", JSON.stringify(v));
  };
  const [error, setError] = useState("");
  // ADO ticket picker — same flow as the dashboard's Start session
  const [allTickets, setAllTickets] = useState<AdoWorkItem[]>([]);
  const [who, setWho] = useState(""); // "" until identity resolves; "*" = anyone
  const [stateOrder, setStateOrder] = useState<string[]>([]); // ADO workflow order
  const [adoDown, setAdoDown] = useState(false);
  const [ticketSel, setTicketSel] = useState("");
  const [sendTicket, setSendTicket] = useState(true);
  const [branchInfo, setBranchInfo] = useState<RepoBranches | null>(null);
  const [baseBranch, setBaseBranch] = useState("");

  useEffect(() => {
    window.mb.listRepos().then((r: RepoEntry[] | { error: string }) => {
      if (Array.isArray(r)) setRepos(r);
      else setError(`Repo scan failed: ${(r as any).error}`);
    });
    window.mb.adoList().then((r: { items: AdoWorkItem[]; me: string } | { error: string }) => {
      if ("error" in r) return setAdoDown(true); // manual entry still works
      // keep everyone's tickets: the picker defaults to yours (identity comes
      // from the PAT) but you can pick up someone else's
      setAllTickets(r.items);
      setWho(r.me || "*");
      // ADO returns a type's states in workflow order — that is the column order
      // of the real board, so the picker reads top-to-bottom the way it looks
      const types = [...new Set(r.items.map((i) => i.type))];
      Promise.all(
        types.map((t) =>
          window.mb.adoStates(t).then((x: string[] | { error: string }) => (Array.isArray(x) ? x : []))
        )
      ).then((lists) => setStateOrder([...new Set(lists.flat())]));
    });
  }, []);

  // base-branch options follow the chosen repo (new branch is cut off origin/<base>)
  useEffect(() => {
    setBranchInfo(null);
    setBaseBranch("");
    if (!sel) return;
    let alive = true;
    window.mb.repoBranches(sel.path).then((r: RepoBranches | { error: string }) => {
      if (!alive || !r || "error" in r) return;
      setBranchInfo(r);
      setBaseBranch(r.defaultBase ?? "");
    });
    return () => {
      alive = false;
    };
  }, [sel]);

  // people who actually have tickets on the board, you first
  const people = useMemo(() => {
    const names = [...new Set(allTickets.map((t) => t.assignedTo).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
    const mine = who && who !== "*" ? names.filter((n) => n === who) : [];
    return [...mine, ...names.filter((n) => !mine.includes(n))];
  }, [allTickets, who]);

  const tickets = useMemo(
    () => (who && who !== "*" ? allTickets.filter((t) => t.assignedTo === who) : allTickets),
    [allTickets, who]
  );
  const columns = useMemo(() => ticketsByColumn(tickets, stateOrder), [tickets, stateOrder]);
  const pickable = useMemo(() => columns.flatMap((c) => c.items), [columns]);

  const pickTicket = (val: string) => {
    setTicketSel(val);
    const t = allTickets.find((x) => String(x.id) === val);
    if (t) {
      setTicketId(String(t.id));
      setTicketTitle(suggestTicketName(t.title));
    }
  };

  const filtered = repos.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const branch = ticketId && ticketTitle ? slugBranch(ticketId, ticketTitle) : "";

  const create = async () => {
    const t = allTickets.find((x) => String(x.id) === ticketSel);
    const info = await window.mb.createSession({
      repoPath: sel?.path ?? null,
      ticketId: ticketId || undefined,
      ticketTitle: ticketTitle || undefined,
      taskGroup: group || undefined,
      useWorktree: useWorktree && !!sel,
      ...(sel && baseBranch ? { baseBranch } : {}),
      shell: launch === "shell",
      ...(isAgent ? { agent: launch } : {}),
      ...(isAgent && effModel ? { model: effModel } : {}),
      ...(isAgent && effEffort ? { effort: effEffort } : {}),
      initialPrompt:
        isAgent && t && sendTicket
          ? ticketKickoffPrompt(t.id, t.title, t.description)
          : undefined,
    });
    if (info?.error) return setError(info.error);
    onCreated(info);
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>New session</h3>
        <div className="sub-h">Pick a repo, optionally attach a ticket — worktree and branch are handled for you.</div>
        <label>Launch</label>
        <span className="seg" style={{ display: "inline-flex" }}>
          <button className={launch === "claude" ? "on" : ""} onClick={() => setLaunch("claude")}>Claude</button>
          <button className={launch === "codex" ? "on" : ""} onClick={() => setLaunch("codex")} title="OpenAI Codex CLI — signs in with your ChatGPT subscription">Codex</button>
          <button className={launch === "shell" ? "on" : ""} onClick={() => setLaunch("shell")}>Terminal</button>
        </span>
        {launch === "codex" && (
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              <label>Model</label>
              <Select
                value={codexCustom ? "__custom" : codexModel}
                placeholder={codexModel || "Default"}
                options={[
                  { value: "", label: "Default", description: "Whatever codex is set to" },
                  ...(catalog?.codex.models ?? []).map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group })),
                  { value: "__custom", label: "Other model id…", group: "Other" },
                ]}
                onChange={(v) => {
                  setCodexCustom(v === "__custom");
                  if (v !== "__custom") setCodexModel(v);
                }}
              />
              {codexCustom && (
                <input type="text" placeholder="e.g. gpt-6-luna" value={codexModel} onChange={(e) => setCodexModel(e.target.value)} style={{ marginTop: 6 }} />
              )}
            </div>
            <div style={{ flex: 1 }}>
              <label>Reasoning</label>
              <Select
                value={codexEffort}
                options={[
                  { value: "", label: codexInfo?.defaultEffort ? `Default (${codexInfo.defaultEffort})` : "Default" },
                  ...(codexInfo?.efforts ?? catalog?.codex.efforts ?? ["low", "medium", "high", "xhigh"]).map((e) => ({ value: e, label: e })),
                ]}
                onChange={setCodexEffort}
              />
            </div>
          </div>
        )}
        {launch === "claude" && (
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              <label>Model</label>
              <Select
                value={model}
                placeholder={model || "Default"}
                options={[
                  { value: "", label: "Default", description: "Whatever claude is set to" },
                  ...(catalog?.claude.models ?? []).map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group })),
                  { value: "__custom", label: "Other model id…", group: "Other" },
                ]}
                onChange={setModel}
              />
              {model === "__custom" && (
                <input
                  type="text"
                  placeholder="e.g. claude-sonnet-5-5"
                  value={modelCustom}
                  onChange={(e) => setModelCustom(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              )}
            </div>
            <div style={{ flex: 1 }}>
              <label>Effort</label>
              <Select
                value={effort}
                options={[{ value: "", label: "Default" }, ...(catalog?.claude.efforts ?? ["low", "medium", "high", "xhigh", "max"]).map((e) => ({ value: e, label: e }))]}
                onChange={setEffort}
              />
            </div>
          </div>
        )}
        <label>Repo</label>
        <input type="text" autoFocus placeholder="search ~/Code + ~/Personal Projects…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pick-list">
          {filtered.map((r) => (
            <div key={r.path} className={`item ${sel?.path === r.path ? "sel" : ""}`} onClick={() => setSel(r)}>
              <div className="meta">
                <div className="t">{r.name}</div>
                <div className="s">{r.path.replace(/^\/Users\/[^/]+/, "~")}</div>
              </div>
            </div>
          ))}
        </div>
        <label>
          Azure DevOps tickets{" "}
          <span className="wi-note">
            {adoDown
              ? "board unavailable — manual entry below"
              : pickable.length
                ? "optional — fills the fields below"
                : "nothing in the working columns — manual entry below"}
          </span>
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <Pick
            style={{ flex: "0 0 34%" }}
            value={who}
            onChange={(e) => {
              setWho(e.target.value);
              setTicketSel(""); // the old pick may not belong to this person
            }}
            disabled={adoDown || !allTickets.length}
            title="Whose tickets to choose from"
          >
            <option value="*">Anyone</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Pick>
          <Pick
            style={{ flex: 1 }}
            value={ticketSel}
            onChange={(e) => pickTicket(e.target.value)}
            disabled={adoDown || pickable.length === 0}
          >
            <option value="">none / manual</option>
            {columns.map((c) => (
              <optgroup key={c.state} label={c.state}>
                {c.items.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    #{t.id} · {t.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </Pick>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label>Ticket #</label>
            <input type="text" placeholder="5038" value={ticketId} onChange={(e) => setTicketId(e.target.value)} />
          </div>
          <div style={{ flex: 2 }}>
            <label>Ticket name</label>
            <input type="text" placeholder="filterOrgsByFoundation" value={ticketTitle} onChange={(e) => setTicketTitle(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label>Group</label>
            <Pick
              value={grpSel}
              onChange={(e) => {
                setGrpSel(e.target.value);
                setWsSel("");
                setWsNew("");
              }}
            >
              <option value="">
                {ticketId ? `auto — ticket ${ticketId.replace(/^#/, "")}` : "none"}
              </option>
              {allTops.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              <option value="__new">new group…</option>
            </Pick>
            {grpSel === "__new" && (
              <input
                type="text"
                autoFocus
                placeholder="group name"
                value={grpNew}
                onChange={(e) => setGrpNew(e.target.value)}
                style={{ marginTop: 6 }}
              />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label>
              Workspace
              {effSub && <span className="hint-inline"> → opens as a tab</span>}
            </label>
            <Pick value={wsSel} onChange={(e) => setWsSel(e.target.value)} disabled={!effTop}>
              <option value="">{effTop ? "none — its own pane" : "pick a group first"}</option>
              {(grpSel && grpSel !== "__new" ? subsOf(grpSel) : []).map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
              <option value="__new">new workspace…</option>
            </Pick>
            {wsSel === "__new" && (
              <input
                type="text"
                placeholder="workspace name"
                value={wsNew}
                onChange={(e) => setWsNew(e.target.value)}
                style={{ marginTop: 6 }}
              />
            )}
          </div>
        </div>
        <div className="check-line">
          <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} id="wt" />
          <label htmlFor="wt" style={{ margin: 0 }}>
            isolated worktree
            <span className="wi-note">
              {" "}
              {useWorktree
                ? `worktrees/${sel?.name ?? "<repo>"}/${branch || "<branch>"} — its own folder, safe beside other sessions`
                : branch
                  ? `off — switches the repo checkout to ${branch}`
                  : "off — runs in the repo checkout on its current branch"}
            </span>
          </label>
        </div>
        {sel && branch && branchInfo && branchInfo.branches.length > 0 && (
          <Pick
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            style={{ marginTop: 8 }}
            title="The base is fetched fresh from origin before the new branch is cut"
          >
            <option value="">base: current HEAD</option>
            {branchInfo.branches.map((b) => (
              <option key={b} value={b}>base: origin/{b}</option>
            ))}
          </Pick>
        )}
        {ticketSel && isAgent && (
          <div className="check-line">
            <input type="checkbox" checked={sendTicket} onChange={(e) => setSendTicket(e.target.checked)} id="ntk" />
            <label htmlFor="ntk" style={{ margin: 0 }}>send ticket title + description to {agentLabel}</label>
          </div>
        )}
        {launch === "shell" && !sel && (
          <div className="wi-note" style={{ marginTop: 8 }}>
            no repo picked — the terminal opens in your home folder (pick a repo to open there, or in a worktree)
          </div>
        )}
        {error && <div className="err">{error}</div>}
        <div className="row">
          <button className="outline" onClick={onClose}>Cancel</button>
          {isAgent && !sel && (
            <span className="wi-note" style={{ marginRight: "auto" }}>
              no repo — starts a plain {agentLabel} chat (fully tracked: resumable, restartable)
            </span>
          )}
          <button className="primary cta" onClick={create}>
            {launch === "shell" ? "Open terminal" : sel ? `Start ${agentLabel.toLowerCase()}` : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A conversation the Import list can open: a recent one, or a search hit. */
interface ImportRow {
  id: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  at: number;
  snippet?: string;
  /** Search hits that are already open, or belong to a Collaborate room, aren't imported again. */
  blocked?: string;
  /** A closed Mockingbird session that resumes this conversation — restored rather than duplicated. */
  restore?: string;
}

function ImportModal({
  onClose,
  onOpened,
  onDone,
}: {
  onClose: () => void;
  onOpened: (opened: SessionInfo[]) => void;
  onDone: () => void;
}) {
  const [convos, setConvos] = useState<ImportableConversation[] | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ImportRow[] | null>(null);
  const [sel, setSel] = useState<Map<string, ImportRow>>(new Map());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.mb.listImportable().then((r: ImportableConversation[] | { error: string }) => {
      if (Array.isArray(r)) setConvos(r);
      else setError((r as any).error);
    });
  }, []);

  // typing searches every Claude and Codex conversation on this Mac (the transcript index), any age
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    let live = true;
    const t = setTimeout(async () => {
      const r = await window.mb.searchTranscripts(q);
      if (!live) return;
      if (r?.error) return setError(r.error);
      setError("");
      setHits(
        (r.hits as TranscriptHit[]).map((h) => ({
          id: h.id,
          agent: h.agent,
          cwd: h.cwd,
          title: h.open.how === "room" ? `${h.open.roomTitle} (Collaborate)` : h.title,
          at: h.updated,
          snippet: h.snippet,
          ...(h.open.how === "pane" ? { blocked: "already open" } : h.open.how === "room" ? { blocked: "in a Collaborate room" } : {}),
          ...(h.open.how === "previous" ? { restore: h.open.sessionId } : {}),
        }))
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const rows: ImportRow[] | null = hits ?? (convos ? convos.map((c) => ({ id: c.sessionId, agent: "claude" as AgentKind, cwd: c.cwd, title: c.title, at: c.mtimeMs })) : null);

  const toggle = (r: ImportRow) =>
    setSel((p) => {
      const n = new Map(p);
      n.has(r.id) ? n.delete(r.id) : n.set(r.id, r);
      return n;
    });

  const importSelected = async () => {
    setBusy(true);
    const opened: SessionInfo[] = [];
    const failures: string[] = [];
    for (const c of sel.values()) {
      const info = c.restore
        ? await window.mb.relaunchSession(c.restore)
        : await window.mb.createSession({ repoPath: c.cwd, useWorktree: false, resumeSessionId: c.id, agent: c.agent, title: c.title.slice(0, 80) });
      if (!info || info.error) failures.push(`✕ ${c.title.slice(0, 40)}: ${info?.error ?? "that session is no longer saved"}`);
      else opened.push(info);
    }
    if (opened.length) onOpened(opened);
    if (failures.length) {
      setError(`Opened ${opened.length}, failed ${failures.length}:\n\n${failures.join("\n")}`);
      setSel(new Map());
      setBusy(false);
    } else {
      onDone();
    }
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal import-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Import conversations</h3>
        <div className="sub-h">
          Recent Claude conversations from this Mac — including ones started in cmux or a terminal — or search every Claude and Codex
          conversation, any age. Each reopens with its full history in its original folder. Every import is a live agent process, so start
          with the handful you're actively working on.
        </div>
        <input
          className="import-search"
          type="text"
          autoFocus
          placeholder="Search every conversation — words, files, commands"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="pick-list">
          {rows?.map((c) => (
            <div
              key={c.id}
              className={`item ${sel.has(c.id) ? "sel" : ""} ${c.blocked ? "blocked" : ""}`}
              title={c.blocked ? `Not imported: ${c.blocked}` : c.restore ? "Restores the closed Mockingbird session that ran this" : undefined}
              onClick={() => !c.blocked && toggle(c)}
            >
              <input type="checkbox" checked={sel.has(c.id)} disabled={!!c.blocked} readOnly />
              <div className="meta">
                <div className="t">
                  {c.title}
                  {c.agent === "codex" && <span className="ts-agent codex">codex</span>}
                </div>
                <div className="s">
                  {c.cwd.replace(/^\/Users\/[^/]+/, "~")}
                  {c.blocked ? ` · ${c.blocked}` : c.restore ? " · restores your closed session" : ""}
                </div>
                {c.snippet && (
                  <div className="ts-snip">
                    <Snippet text={c.snippet} />
                  </div>
                )}
              </div>
              <span className="age">{ago(c.at)}</span>
            </div>
          ))}
          {rows === null && !error && (
            <div className="item"><div className="meta"><div className="s">{q.trim() ? "searching…" : "scanning ~/.claude/projects…"}</div></div></div>
          )}
          {rows?.length === 0 && (
            <div className="item"><div className="meta"><div className="s">{q.trim() ? "No conversation mentions that." : "No recent conversations."}</div></div></div>
          )}
        </div>
        {error && <div className="err">{error}</div>}
        <div className="row">
          <button className="outline" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={sel.size === 0 || busy} onClick={importSelected}>
            {busy ? "Opening…" : `Open ${sel.size || ""} session${sel.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
