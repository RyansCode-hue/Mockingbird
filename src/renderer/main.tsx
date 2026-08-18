import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TerminalPane, disposeTerm, focusTerm, applyTermTheme, fmtElapsed, shortReason, PaneDensity, PaneResize } from "./TerminalPane";
import type { SessionInfo, SessionStatus, RepoEntry, Settings, ImportableConversation, WorktreeStateInfo, AdoWorkItem, AdoComment, RepoBranches } from "../shared/types";
import { slugBranch, sanitizeSegment, splitGroupKey, topOfKey } from "../shared/types";

declare global {
  interface Window {
    mb: any;
  }
}

type ModalKind = "new" | "import" | "help" | null;
type Tab = "sessions" | "dashboard" | "worktracker" | "settings";
const TAB_LABELS: Record<Tab, string> = {
  sessions: "Sessions",
  dashboard: "Dashboard",
  worktracker: "WorkTracker",
  settings: "Settings",
};
type ColsPref = number | "auto";

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
  const [newLaunch, setNewLaunch] = useState<"claude" | "shell">("claude");
  const [tab, setTab] = useState<Tab>(() => loadLS<Tab>("mb.tab", "sessions"));
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
    if (next !== renameDlg.key) {
      await window.mb.renameGroup(renameDlg.key, next);
      migrateGroupKeys(renameDlg.key, next);
    }
    setRenameDlg(null);
    refresh();
  };
  const [statusPop, setStatusPop] = useState<SessionStatus | null>(null);
  const [update, setUpdate] = useState<{ latest: string; url: string; newer: boolean } | null>(null);

  // persist grid arrangement across restarts (design: Interactions & Behavior)
  useEffect(() => localStorage.setItem("mb.shown", JSON.stringify(shown)), [shown]);
  useEffect(() => localStorage.setItem("mb.cols", JSON.stringify(colsPref)), [colsPref]);
  useEffect(() => localStorage.setItem("mb.side", JSON.stringify(sideCollapsed)), [sideCollapsed]);

  const reorder = (srcId: string, targetId: string) =>
    setShown((p) => {
      const arr = p.filter((x) => x !== srcId);
      const i = arr.indexOf(targetId);
      if (i < 0) return p;
      arr.splice(i, 0, srcId);
      return arr;
    });

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

  // first launch: open the how-to-use popup once
  useEffect(() => {
    if (!loadLS("mb.helpSeen", false)) {
      setModal("help");
      localStorage.setItem("mb.helpSeen", "true");
    }
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
    return () => {
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

  /** Minimize a whole workspace (all member sessions) from the grid at once. */
  const hideSessions = (list: SessionInfo[]) => {
    setShown((p) => p.filter((id) => !list.some((s) => s.id === id)));
    if (zoomed && list.some((s) => s.id === zoomed)) setZoomed(null);
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
        // tabs list ALL of the workspace's sessions — the workspace is the
        // visibility unit; any shown member brings the whole pane
        out.push({
          kind: "workspace",
          sub,
          list: workSessions.filter((x) => topOf(x) === topOf(s) && subOf(x) === sub),
        });
      }
    }
    return out;
  }, [gridSessions, workSessions, zoomed]);

  // the grid grows with the cell count — equal cells, no filler tiles
  const cols = zoomed ? 1 : colsPref === "auto" ? gridCols(Math.max(1, cells.length)) : colsPref;
  const rows = Math.max(1, Math.ceil(Math.max(1, cells.length) / cols));
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
    if (cmd && e.shiftKey && e.key.toLowerCase() === "b") {
      handled();
      setTab("settings");
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

  const onCreated = (s: SessionInfo) => {
    refresh();
    jumpToSession(s);
    setModal(null);
  };

  const focusedSession = sessions.find((s) => s.id === focused) ?? null;

  return (
    <div className="app">
      <div className="topbar">
        {tab === "sessions" && (
          <button className="icon" onClick={() => setSideCollapsed(!sideCollapsed)} title={sideCollapsed ? "Show sidebar" : "Hide sidebar"}>
            {sideCollapsed ? "▹" : "◃"}
          </button>
        )}
        <span className="brand">
          <span className="mark">🪶</span>
          <span className="name">Mockingbird</span>
          <span className="ver">v0.1</span>
        </span>
        <span className="tabs">
          {(["sessions", "dashboard", "worktracker", "settings"] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
              {t === "worktracker" && debriefSessions.some((s) => s.status === "waiting") && (
                <span className="dot sm waiting" style={{ marginLeft: 6 }} />
              )}
            </button>
          ))}
        </span>
        <span className="spacer" />
        {tab === "sessions" && (
          <>
            <span className="seg">
              {(["auto", 1, 2, 3, 4] as const).map((c) => (
                <button key={c} className={colsPref === c ? "on" : ""} onClick={() => setColsPref(c)}>
                  {c === "auto" ? "A" : c}
                </button>
              ))}
            </span>
            <span className="lbl">cols</span>
            <span className="vdiv" />
            <button className="outline" onClick={() => setModal("import")}>Import</button>
          </>
        )}
        <button className="primary" onClick={() => setModal("new")}>
          New session <span className="kbd">⌘N</span>
        </button>
      </div>

      <div className="body">
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
        {tab === "settings" && <SettingsView sessions={sessions} theme={theme} onTheme={setTheme} />}
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
        <div className={`sidebar ${sideCollapsed ? "collapsed" : ""}`}>
          <div className="scroll">
            <input
              className="filter"
              placeholder="Filter sessions"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {groups.map(([key, list]) => (
              <div key={key}>
                {(
                  <div
                    className="group-label"
                    title="click to focus this group in the grid · ✎/double-click to rename · drop a session here to move it"
                    onClick={() => deferClick(() => focusGroup(key, list))}
                    onDoubleClick={() => {
                      cancelClick();
                      if (key !== "ungrouped") setRenameDlg({ kind: "group", key, initial: key });
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => dropToGroup(e, key === "ungrouped" ? null : key)}
                  >
                    {key !== "ungrouped" && (
                      <button
                        className="glbtn"
                        title="Rename group"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelClick();
                          setRenameDlg({ kind: "group", key, initial: key });
                        }}
                      >
                        ✎
                      </button>
                    )}
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
                      {collapsed.has(key) ? "▸" : "▾"}
                    </span>
                    <span className="txt">{groupTitle(key, list)}</span>
                    <span className="gcount">{list.length}</span>
                  </div>
                )}
                {!collapsed.has(key) && bySub(list).map(([sub, subList]) => (
                  <div key={sub || "_"} className={sub ? "sub-rows" : undefined}>
                    {sub && (
                      <div
                        className="sub-label"
                        title="click to show/minimize this workspace · ✎/double-click to rename · ✕ dissolves it (sessions stay) · drop a session to move it in"
                        onClick={() =>
                          deferClick(() =>
                            subList.some((s) => shown.includes(s.id))
                              ? hideSessions(subList) // minimize the workspace
                              : focusSub(key, subList)
                          )
                        }
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          cancelClick();
                          setRenameDlg({ kind: "sub", key: `${key}/${sub}`, initial: sub });
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => dropToGroup(e, `${key}/${sub}`)}
                      >
                        <span className="txt">{sub}</span>
                        <span className="gcount">{subList.length}</span>
                        <button
                          title="Rename workspace"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelClick();
                            setRenameDlg({ kind: "sub", key: `${key}/${sub}`, initial: sub });
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
                    {subList.map((s) => {
                  const idx = shown.indexOf(s.id);
                  return (
                    <div
                      key={s.id}
                      className={`sess-item ${idx >= 0 ? "shown" : ""}`}
                      onClick={() => (idx >= 0 ? hide(s.id) : showSession(s))}
                      title={`${s.cwd} — double-click name to rename · drag onto a group to move`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/mb-session", s.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => e.preventDefault()}
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
                          {s.ticketTitle ?? s.title}
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
                ))}
              </div>
            ))}

            {resumable.length > 0 && (
              <>
                <h2>
                  <span>Previous</span>
                  <button className="icon" title="Relaunch every previous session (claude --continue)" onClick={restoreAll}>
                    ↺ restore all
                  </button>
                </h2>
                {resumable.filter((s) => !s.debrief).map((s) => (
                  <div key={s.id} className="sess-item" title={s.cwd}>
                    <span className="dot dead" />
                    <span className="name">{s.title}</span>
                    <button
                      title="Relaunch with claude --continue"
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
        </div>

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
                const remainder = cells.length % cols;
                const span = !zoomed && remainder !== 0 && i === cells.length - 1 ? cols - col : 1;
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
                    onClose={onCloseOverride ?? (() => hide(s.id))}
                    onZoom={() => setZoomed(zoomed === s.id ? null : s.id)}
                    onReorder={reorder}
                    onResume={() => resumeDead(s)}
                    onCleanup={() => requestClose(s)}
                    resize={resize}
                  />
                );
                if (cell.kind === "session") {
                  const pane = paneFor(cell.s, false);
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
                    style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
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
                        </button>
                      ))}
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
        <span className="right">
          {update?.newer && (
            <span
              className="update-link"
              title="A newer Mockingbird is out — click to open the release"
              onClick={() => window.mb.openExternal(update.url)}
            >
              ⭮ v{update.latest} available
            </span>
          )}
          {!hooksOk && (
            <span
              className="hooks-bad"
              title="Session status (working/waiting/idle) needs Claude Code hooks — click to install"
              onClick={async () => {
                await window.mb.installHooks();
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
            { label: "New terminal (no Claude)", run: () => { setNewLaunch("shell"); setModal("new"); } },
            { label: "Sessions grid", run: () => setTab("sessions") },
            { label: "Dashboard — ticket board", run: () => setTab("dashboard") },
            { label: "Settings / Broadcast / CLAUDE.md", kbd: "⌘⇧B", run: () => setTab("settings") },
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
          title={renameDlg.kind === "group" ? "Rename group" : "Rename workspace"}
          initial={renameDlg.initial}
          onSave={applyRename}
          onClose={() => setRenameDlg(null)}
        />
      )}

      {modal === "new" && (
        <NewSessionModal
          existingGroups={groupKeys}
          initialLaunch={newLaunch}
          onClose={() => {
            setModal(null);
            setNewLaunch("claude");
          }}
          onCreated={(s) => {
            setNewLaunch("claude");
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
      {modal === "help" && <HelpModal onClose={() => setModal(null)} />}
    </div>
  );
}

// ---- command palette (design 1c) ----
interface PaletteAction {
  label: string;
  kbd?: string;
  run: () => void;
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
    ["⌘⇧B", "Settings tab — broadcast + CLAUDE.md"],
    ["⇧⏎", "newline in a Claude prompt (won't submit)"],
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
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set(loadLS<string[]>("mb.board.hidden", [])));
  const [colOrder, setColOrder] = useState<string[]>(() => loadLS<string[]>("mb.board.colOrder", []));
  useEffect(() => {
    if (who !== null) localStorage.setItem("mb.board.who", JSON.stringify(who));
  }, [who]);
  useEffect(() => localStorage.setItem("mb.board.hidden", JSON.stringify([...hiddenCols])), [hiddenCols]);
  useEffect(() => localStorage.setItem("mb.board.colOrder", JSON.stringify(colOrder)), [colOrder]);

  // custom order first (drag columns to match your real ADO board), new states appended
  const orderedCols = useMemo(() => {
    const custom = colOrder.filter((c) => stateCols.includes(c));
    return [...custom, ...stateCols.filter((c) => !custom.includes(c))];
  }, [stateCols, colOrder]);

  const reorderCols = (src: string, target: string) => {
    if (src === target) return;
    const arr = orderedCols.filter((c) => c !== src);
    const i = arr.indexOf(target);
    if (i < 0) return;
    arr.splice(i, 0, src);
    setColOrder(arr);
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

  const load = async () => {
    setError("");
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
      useWorktree: true,
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
        <span className="flbl">Columns</span>
        <span className="pills">
          {orderedCols.map((c) => (
            <button
              key={c}
              className={`pill ${hiddenCols.has(c) ? "" : "on"}`}
              title={hiddenCols.has(c) ? "Show column" : "Hide column"}
              onClick={() =>
                setHiddenCols((p) => {
                  const n = new Set(p);
                  n.has(c) ? n.delete(c) : n.add(c);
                  return n;
                })
              }
            >
              {c}
            </button>
          ))}
        </span>
        <span style={{ marginLeft: "auto" }} />
        <span className="flbl-info">
          {items ? `${visibleItems.length} items` : ""}
          {total > (items?.length ?? 0) ? ` · showing ${items!.length} of ${total}` : ""}
          {syncedAt ? ` · synced ${fmtElapsed(syncedAt)} ago` : " · syncing…"}
        </span>
        <button className="outline" onClick={() => load()}>Refresh</button>
      </div>
      {error && <div className="err board-err">{error}</div>}
      <div className="board-cols">
        {items === null && <div className="wi-empty" style={{ padding: 14 }}>Loading work items…</div>}
        {items !== null && stateCols.length === 0 && !error && (
          <div className="wi-empty" style={{ padding: 14 }}>No active work items.</div>
        )}
        {orderedCols.filter((c) => !hiddenCols.has(c)).map((col) => {
          const colItems = visibleItems.filter((i) => i.state === col);
          return (
            <div
              key={col}
              className="bcol"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const movedCol = e.dataTransfer.getData("text/mb-col");
                if (movedCol) return reorderCols(movedCol, col);
                const id = parseInt(e.dataTransfer.getData("text/mb-wi"), 10);
                if (id) changeState(id, col);
              }}
            >
              <div
                className="bcol-hd"
                draggable
                title="drag to reorder columns"
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/mb-col", col);
                  e.dataTransfer.effectAllowed = "move";
                }}
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
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/mb-wi", String(it.id));
                        e.dataTransfer.effectAllowed = "move";
                      }}
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
                <select value={state} onChange={(e) => setState(e.target.value)}>
                  {[...new Set([state, ...typeStates])].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
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
                <select value={repoPath} onChange={(e) => setRepoPath(e.target.value)}>
                  <option value="">repo…</option>
                  {repos.map((r) => (
                    <option key={r.path} value={r.path}>{r.name}</option>
                  ))}
                </select>
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
                      <select
                        value={baseBranch}
                        onChange={(e) => setBaseBranch(e.target.value)}
                        style={{ marginTop: 6 }}
                        title="The base is fetched fresh from origin before the new branch is cut"
                      >
                        <option value="">base: current HEAD</option>
                        {branchInfo.branches.map((b) => (
                          <option key={b} value={b}>base: origin/{b}</option>
                        ))}
                      </select>
                    )}
                  </>
                ) : (
                  <select
                    value={existingBranch}
                    onChange={(e) => setExistingBranch(e.target.value)}
                    style={{ marginTop: 6 }}
                  >
                    <option value="">branch…</option>
                    {(branchInfo?.branches ?? []).map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
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
                    <select value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                      <option value="">choose session…</option>
                      {attachable.map((s) => (
                        <option key={s.id} value={s.id}>{s.ticketTitle ?? s.title}</option>
                      ))}
                    </select>
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
        <select value={top} onChange={(e) => setTop(e.target.value)}>
          {tops.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
          <option value="__new__">new group…</option>
        </select>
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
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="~/.claude/CLAUDE.md">global — ~/.claude/CLAUDE.md</option>
            {repoPaths.map((p) => (
              <option key={p} value={`${p}/CLAUDE.md`}>{p.split("/").pop()} — {p}/CLAUDE.md</option>
            ))}
          </select>
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
function SettingsView({
  sessions,
  theme,
  onTheme,
}: {
  sessions: SessionInfo[];
  theme: "dark" | "light";
  onTheme: (t: "dark" | "light") => void;
}) {
  const [s, setS] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [hooksOk, setHooksOk] = useState(true);
  const [identity, setIdentity] = useState<{ display: string; email: string; project: string } | { error: string } | null>(null);
  const [conn, setConn] = useState<{ az: boolean; global: string[]; project: string[] } | null>(null);
  const [updNote, setUpdNote] = useState("");
  const [adoCfg, setAdoCfg] = useState<{ orgUrl: string; project: string; patFile: string } | null>(null);
  const [connSaved, setConnSaved] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpCmd, setMcpCmd] = useState("");

  const loadConnectors = () => {
    window.mb.adoMe().then(setIdentity);
    window.mb.connectorsStatus().then((r: any) => r && !r.error && setConn(r));
    window.mb.adoConfigGet().then((r: any) => r && !r.error && setAdoCfg(r));
  };
  useEffect(() => {
    window.mb.getSettings().then(setS);
    window.mb.hooksInstalled().then(setHooksOk);
    loadConnectors();
  }, []);
  if (!s) return <div className="settings-page" />;

  const upd = (patch: Partial<Settings>) => {
    setS({ ...s, ...patch });
    setSavedAt(null);
  };
  const addRoot = async () => {
    const p = await window.mb.pickPath({ defaultPath: s.repoRoots[0] ?? "~" });
    if (p) upd({ repoRoots: [...new Set([...s.repoRoots, p])] });
  };
  const pickWorkTracker = async () => {
    const p = await window.mb.pickPath({ defaultPath: s.workTrackerPath });
    if (p) upd({ workTrackerPath: p });
  };
  const pickClaudeBin = async () => {
    const p = await window.mb.pickPath({ file: true, defaultPath: "/usr/local/bin" });
    if (p) upd({ claudeBin: p });
  };
  const save = async () => {
    await window.mb.setSettings(s);
    setSavedAt(Date.now());
  };

  return (
    <div className="settings-page">
      <div className="set-card">
        <h3>General</h3>
        <label>Theme</label>
        <span className="seg" style={{ alignSelf: "flex-start" }}>
          <button className={theme === "dark" ? "on" : ""} onClick={() => onTheme("dark")}>Dark</button>
          <button className={theme === "light" ? "on" : ""} onClick={() => onTheme("light")}>Light</button>
        </span>

        <label>Repo roots <span className="wi-note">folders scanned for repos in New Session</span></label>
        {s.repoRoots.map((r) => (
          <div key={r} className="path-row">
            <span className="p">{r}</span>
            <button
              className="danger"
              title="Remove"
              onClick={() => upd({ repoRoots: s.repoRoots.filter((x) => x !== r) })}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="row" style={{ justifyContent: "flex-start", marginTop: 6 }}>
          <button className="outline" onClick={addRoot}>Add folder…</button>
        </div>

        <label>WorkTracker folder <span className="wi-note">debriefs + ADO config live here</span></label>
        <div className="path-row">
          <span className="p">{s.workTrackerPath}</span>
          <button className="outline" onClick={pickWorkTracker}>Browse…</button>
        </div>

        <label>claude binary</label>
        <div className="path-row">
          <span className="p">{s.claudeBin}</span>
          <button className="outline" onClick={pickClaudeBin}>Browse…</button>
        </div>

        <div className="check-line">
          <input
            type="checkbox"
            checked={s.debriefs.enabled}
            onChange={(e) => upd({ debriefs: { ...s.debriefs, enabled: e.target.checked } })}
            id="dbe"
          />
          <label htmlFor="dbe" style={{ margin: 0 }}>
            auto-run debriefs at {s.debriefs.morning} / {s.debriefs.wrapUp} (weekdays, app open)
          </label>
        </div>
        <div className="check-line">
          <input
            type="checkbox"
            checked={s.notifications}
            onChange={(e) => upd({ notifications: e.target.checked })}
            id="ntf"
          />
          <label htmlFor="ntf" style={{ margin: 0 }}>native notifications</label>
        </div>

        <label>Claude Code hooks <span className="wi-note">how sessions report working / waiting / idle</span></label>
        {hooksOk ? (
          <span className="hooks-ok">installed ✓ — ~/.claude/settings.json</span>
        ) : (
          <div className="row" style={{ justifyContent: "flex-start", marginTop: 2 }}>
            <button
              className="outline"
              onClick={async () => {
                await window.mb.installHooks();
                setHooksOk(true);
              }}
            >
              Install hooks
            </button>
          </div>
        )}
        <label>Updates</label>
        <div className="row" style={{ justifyContent: "flex-start", marginTop: 2, gap: 8 }}>
          <button
            className="outline"
            onClick={async () => {
              setUpdNote("checking…");
              const r = await window.mb.updateCheck();
              if (r === null) setUpdNote('no update source — set "repository" in package.json to a GitHub repo');
              else if (r?.error) setUpdNote(`check failed: ${r.error}`);
              else if (r.newer) setUpdNote(`v${r.latest} available — see the status bar link, or GitHub releases`);
              else setUpdNote(`up to date ✓ (v${r.current})`);
            }}
          >
            Check for updates
          </button>
          {updNote && <span className="wi-note">{updNote}</span>}
        </div>

        <div className="row">
          {savedAt && <span className="kbd foot-hint" style={{ color: "var(--teal-text)" }}>saved ✓</span>}
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>

      <div className="set-card">
        <h3>Connectors</h3>

        <label>Azure DevOps <span className="wi-note">powers the Dashboard, ticket picker, and debrief snapshot · stored in WorkTracker/config.json</span></label>
        {adoCfg && (
          <>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                style={{ flex: 2 }}
                placeholder="org URL — https://dev.azure.com/YourOrg"
                value={adoCfg.orgUrl}
                onChange={(e) => {
                  setAdoCfg({ ...adoCfg, orgUrl: e.target.value });
                  setConnSaved(false);
                }}
              />
              <input
                type="text"
                style={{ flex: 1 }}
                placeholder="project"
                value={adoCfg.project}
                onChange={(e) => {
                  setAdoCfg({ ...adoCfg, project: e.target.value });
                  setConnSaved(false);
                }}
              />
            </div>
            <div className="path-row" style={{ marginTop: 6 }}>
              <span className="p">{adoCfg.patFile || "PAT file — a text file containing your Personal Access Token"}</span>
              <button
                className="outline"
                onClick={async () => {
                  const p = await window.mb.pickPath({ file: true, defaultPath: s.workTrackerPath });
                  if (p) {
                    setAdoCfg({ ...adoCfg, patFile: p });
                    setConnSaved(false);
                  }
                }}
              >
                Browse…
              </button>
            </div>
            <div className="row" style={{ justifyContent: "flex-start", marginTop: 8, gap: 8 }}>
              <button
                className="primary"
                disabled={!adoCfg.orgUrl.trim() || !adoCfg.project.trim() || !adoCfg.patFile.trim()}
                onClick={async () => {
                  const r = await window.mb.adoConfigSet(adoCfg);
                  if (!r?.error) {
                    setConnSaved(true);
                    loadConnectors();
                  }
                }}
              >
                Save connector
              </button>
              {connSaved && <span className="kbd" style={{ color: "var(--teal-text)" }}>saved ✓</span>}
            </div>
          </>
        )}
        <div className="wi-note" style={{ marginTop: 5 }}>
          {identity === null
            ? "resolving identity…"
            : "error" in identity
              ? "not connected — fill in org, project, and PAT file above"
              : `connected as ${identity.display}${identity.email ? ` (${identity.email})` : ""} · project ${identity.project} — identity comes from the PAT, so each user's own config makes the app theirs`}
        </div>

        <label>az CLI — debrief sessions</label>
        <div className="wi-note">
          {conn === null
            ? "checking…"
            : conn.az
              ? "az found · your PAT is auto-injected into debrief sessions (AZURE_DEVOPS_EXT_PAT), so az boards / az repos work without az login"
              : "az CLI not found — debriefs still get the ticket snapshot; install Azure CLI if your instructions use az commands"}
        </div>

        <label>
          MCP servers — debrief sessions{" "}
          <span className="wi-note">optional (snapshot + az cover tickets) · saved to WorkTracker/.mcp.json — Claude Code asks approval on first use</span>
        </label>
        {(conn?.project ?? []).map((n) => (
          <div key={n} className="path-row">
            <span className="p">{n}</span>
            <button className="danger" title="Remove" onClick={() => window.mb.mcpRemove(n).then(loadConnectors)}>
              ✕
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input
            type="text"
            style={{ flex: 1 }}
            placeholder="name — e.g. azure-devops"
            value={mcpName}
            onChange={(e) => setMcpName(e.target.value)}
          />
          <input
            type="text"
            style={{ flex: 2.2 }}
            placeholder="command — e.g. npx -y @azure-devops/mcp YourOrg"
            value={mcpCmd}
            onChange={(e) => setMcpCmd(e.target.value)}
          />
          <button
            className="outline"
            disabled={!mcpName.trim() || !mcpCmd.trim()}
            onClick={async () => {
              const r = await window.mb.mcpAdd(mcpName.trim(), mcpCmd.trim());
              if (!r?.error) {
                setMcpName("");
                setMcpCmd("");
                loadConnectors();
              }
            }}
          >
            Add
          </button>
        </div>
        <div className="wi-note" style={{ marginTop: 5 }}>
          {conn && conn.global.length
            ? `also configured globally in Claude Code (all sessions): ${conn.global.join(", ")} — manage those with claude mcp`
            : "global Claude Code servers (all sessions) are managed with claude mcp from a terminal"}
        </div>
      </div>

      <div className="set-card p0">
        <ControlRoomPanel sessions={sessions} />
      </div>
    </div>
  );
}

function NewSessionModal({
  existingGroups,
  initialLaunch,
  onClose,
  onCreated,
}: {
  existingGroups: string[];
  initialLaunch?: "claude" | "shell";
  onClose: () => void;
  onCreated: (s: SessionInfo) => void;
}) {
  const [launch, setLaunch] = useState<"claude" | "shell">(initialLaunch ?? "claude");
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<RepoEntry | null>(null);
  const [ticketId, setTicketId] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  const [group, setGroup] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [error, setError] = useState("");
  // ADO ticket picker — same flow as the dashboard's Start session
  const [tickets, setTickets] = useState<AdoWorkItem[]>([]);
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
      // only the PAT owner's tickets — identity comes from the PAT, so this is
      // automatically whoever's WorkTracker config the app is pointed at
      setTickets(r.me ? r.items.filter((i) => i.assignedTo === r.me) : r.items);
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

  const pickTicket = (val: string) => {
    setTicketSel(val);
    const t = tickets.find((x) => String(x.id) === val);
    if (t) {
      setTicketId(String(t.id));
      setTicketTitle(suggestTicketName(t.title));
    }
  };

  const filtered = repos.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const branch = ticketId && ticketTitle ? slugBranch(ticketId, ticketTitle) : "";

  const create = async () => {
    const t = tickets.find((x) => String(x.id) === ticketSel);
    const info = await window.mb.createSession({
      repoPath: sel?.path ?? null,
      ticketId: ticketId || undefined,
      ticketTitle: ticketTitle || undefined,
      taskGroup: sanitizeSegment(group) || undefined,
      useWorktree: useWorktree && !!sel,
      ...(useWorktree && sel && baseBranch ? { baseBranch } : {}),
      shell: launch === "shell",
      initialPrompt:
        launch === "claude" && t && sendTicket
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
          <button className={launch === "shell" ? "on" : ""} onClick={() => setLaunch("shell")}>Terminal</button>
        </span>
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
          My Azure DevOps tickets{" "}
          <span className="wi-note">
            {adoDown
              ? "board unavailable — manual entry below"
              : tickets.length
                ? "optional — fills the fields below"
                : "none assigned to you — manual entry below"}
          </span>
        </label>
        <select value={ticketSel} onChange={(e) => pickTicket(e.target.value)} disabled={adoDown || tickets.length === 0}>
          <option value="">none / manual</option>
          {tickets.map((t) => (
            <option key={t.id} value={String(t.id)}>
              #{t.id} · {t.title} ({t.state})
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label>Ticket #</label>
            <input type="text" placeholder="5038" value={ticketId} onChange={(e) => setTicketId(e.target.value)} />
          </div>
          <div style={{ flex: 2 }}>
            <label>Ticket name</label>
            <input type="text" placeholder="filterOrgsByFoundation" value={ticketTitle} onChange={(e) => setTicketTitle(e.target.value)} />
          </div>
          <div style={{ flex: 1.4 }}>
            <label>Group</label>
            <input
              type="text"
              list="mb-groups"
              placeholder={ticketId ? `defaults to ${ticketId.replace(/^#/, "")}` : "optional"}
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            />
            <datalist id="mb-groups">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="check-line">
          <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} id="wt" />
          <label htmlFor="wt" style={{ margin: 0 }}>git worktree{branch ? ` → ${branch}` : ""}</label>
        </div>
        {useWorktree && sel && branchInfo && branchInfo.branches.length > 0 && (
          <select
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            style={{ marginTop: 8 }}
            title="The base is fetched fresh from origin before the new branch is cut"
          >
            <option value="">base: current HEAD</option>
            {branchInfo.branches.map((b) => (
              <option key={b} value={b}>base: origin/{b}</option>
            ))}
          </select>
        )}
        {ticketSel && launch === "claude" && (
          <div className="check-line">
            <input type="checkbox" checked={sendTicket} onChange={(e) => setSendTicket(e.target.checked)} id="ntk" />
            <label htmlFor="ntk" style={{ margin: 0 }}>send ticket title + description to Claude</label>
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
          <button className="primary" onClick={create} disabled={launch === "claude" && !sel && useWorktree}>
            {launch === "shell" ? "Open terminal" : "Start claude"}
          </button>
        </div>
      </div>
    </div>
  );
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
  const [convos, setConvos] = useState<ImportableConversation[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.mb.listImportable().then((r: ImportableConversation[] | { error: string }) => {
      if (Array.isArray(r)) setConvos(r);
      else setError((r as any).error);
    });
  }, []);

  const toggle = (id: string) =>
    setSel((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const importSelected = async () => {
    setBusy(true);
    const opened: SessionInfo[] = [];
    const failures: string[] = [];
    for (const c of convos.filter((c) => sel.has(c.sessionId))) {
      const info = await window.mb.createSession({
        repoPath: c.cwd,
        useWorktree: false,
        resumeSessionId: c.sessionId,
        title: c.title,
      });
      if (info?.error) failures.push(`✕ ${c.title.slice(0, 40)}: ${info.error}`);
      else opened.push(info);
    }
    if (opened.length) onOpened(opened);
    if (failures.length) {
      setError(`Opened ${opened.length}, failed ${failures.length}:\n\n${failures.join("\n")}`);
      setSel(new Set());
      setBusy(false);
    } else {
      onDone();
    }
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Import conversations</h3>
        <div className="sub-h">
          Recent Claude CLI conversations from this machine — including ones started in cmux or a terminal.
          Each reopens with its full history in its original directory. Every import is a live claude
          process, so start with the handful you're actively working on — the rest stay here for later.
        </div>
        <div className="pick-list">
          {convos.map((c) => (
            <div key={c.sessionId} className={`item ${sel.has(c.sessionId) ? "sel" : ""}`} onClick={() => toggle(c.sessionId)}>
              <input type="checkbox" checked={sel.has(c.sessionId)} readOnly />
              <div className="meta">
                <div className="t">{c.title}</div>
                <div className="s">{c.cwd.replace(/^\/Users\/[^/]+/, "~")}</div>
              </div>
              <span className="age">{ago(c.mtimeMs)}</span>
            </div>
          ))}
          {convos.length === 0 && !error && (
            <div className="item"><div className="meta"><div className="s">scanning ~/.claude/projects…</div></div></div>
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
