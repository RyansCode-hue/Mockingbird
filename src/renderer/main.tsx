import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TerminalPane, disposeTerm, focusTerm, applyTermTheme, type PaneDensity } from "./TerminalPane";
import { EditorDock, ExplorerTree } from "./FilePanel";
import { SourceControl, type DiffSource } from "./SourceControl";
import { SearchView, type SearchState } from "./SearchView";
import { QuickOpen } from "./QuickOpen";
import { EMPTY_EDITOR, closeTab, openTab, tabKey, updateTab } from "./editorTabs";
import { useFolderRefresh } from "./folderWatch";
import { SetupWizard } from "./SetupWizard";
import { CollaborateView } from "./Collaborate";
import { UpdatePanel } from "./UpdatePanel";
import { DragLabel, beginDrag, cue, dragFrom, dragging, installDragListeners, overTarget, placeBeside, samePlace, sideOf, useDrag, type Side } from "./drag";
import { activeGroupOf, dropInZone, layoutToRemember, overflowArea, parseZone, placeInZones, pruneToGroup, seating, switchTo } from "./gridModel";
import { OVERLAYS, escapeLeavesFullscreen, inEditor } from "./keys";
import { cellKeyFor, frontOf, sessionHolding, titleOf, paneShortcuts, remapGroupKeys, remapSeats, worktreeGone, type GridCell } from "./appModel";
import { LayoutIcon, FilesIcon, FolderIcon, ChevronIcon, SessionsIcon, SourceControlIcon, SearchIcon, RunDebugIcon, PinIcon, BellIcon, BellOffIcon } from "./Icons";
import { RunView } from "./RunView";
import { Popover } from "./Popover";
import { PipelineDialog, StageChip, usePipelines } from "./TicketPipeline";
import { HandoffDialog, otherAgent } from "./Handoff";
import { UndoTurnDialog } from "./UndoTurn";
import { MessageLogDialog, useAgentMessages } from "./AgentMessages";
import { RollupDialog } from "./Rollup";
import { PresetEditor } from "./Presets";
import { BottomPanel } from "./BottomPanel";
import { addOutput, onStopped } from "./debugStore";
import { installTooltips } from "./tooltips";
import { dirtyKeys } from "./CodeEditor";
import type { SessionInfo, SessionPreset, SessionStatus, Settings, WorktreeStateInfo, UsageReport, UpdateProgress, UpdateOutcome, CollabRoom, TranscriptHit, RunServiceState, DebugFrame, Meters, LspLocation, FileOverlap, AgentUpdateNotice, MessageMode, OptionalTab } from "../shared/types";
import { isErr, sanitizeSegment, splitGroupKey, topOfKey, groupUngrouped } from "../shared/types";
import { loadLS, openLink } from "./uiUtil";
import { type Tab, TAB_LABELS } from "./tabs";
import { CommandPalette, HelpModal } from "./Palette";
import { UsageMeter } from "./UsageMeter";
import { DashboardBoard } from "./Dashboard";
import { RenameDialog, GroupDialog, RestartAllDialog, CloseSessionDialog } from "./Dialogs";
import { SettingsView, type SettingsSection } from "./Settings";
import { NewSessionModal, ImportModal, type LaunchKind } from "./NewSession";
import { fmtElapsed, plural } from "../shared/format";

type ModalKind = "new" | "import" | "help" | "restart" | "setup" | "update" | "quickopen" | null;
/** What the side bar shows, picked from the activity bar as in VS Code. */
type SideView = "sessions" | "explorer" | "scm" | "search" | "run";
const SIDE_VIEWS: { id: SideView; label: string; keys?: string; Icon: () => React.JSX.Element }[] = [
  { id: "sessions", label: "Sessions", Icon: SessionsIcon },
  { id: "explorer", label: "Explorer", keys: "⇧⌘E", Icon: FilesIcon },
  { id: "scm", label: "Source Control", keys: "⌃⇧G", Icon: SourceControlIcon },
  { id: "search", label: "Search", keys: "⇧⌘F", Icon: SearchIcon },
  { id: "run", label: "Run and Debug", keys: "⇧⌘D", Icon: RunDebugIcon },
];
type ColsPref = number | "auto";

/**
 * Snap-layout templates, in the spirit of Windows' snap layouts: pick an
 * arrangement rather than a column count. `zones` are CSS grid areas
 * (row-start / col-start / row-end / col-end). Panes fill the zones in order
 * unless dragged into one (gridModel.placeInZones); a zone with no pane offers
 * to open a session there, and panes beyond the zones flow into rows below.
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

/**
 * An empty snap-layout zone, like Windows' Snap Assist: open one of the group's
 * minimized sessions here, start a new one, or drop a pane or session in.
 */
function ZoneSlot({
  area,
  cue: dropCue,
  picking,
  onPick,
  minimized,
  onOpen,
  onNew,
  over,
  drop,
}: {
  area: string;
  cue?: string;
  picking: boolean;
  onPick: (open: boolean) => void;
  minimized: SessionInfo[];
  onOpen: (s: SessionInfo) => void;
  onNew: () => void;
  over: (e: React.DragEvent) => void;
  drop: (e: React.DragEvent) => void;
}) {
  return (
    <div className="zone-slot" style={{ gridArea: area }} data-drop={dropCue} onDragOver={over} onDrop={drop}>
      {picking ? (
        <div className="zone-pick" onKeyDown={(e) => e.key === "Escape" && onPick(false)}>
          <div className="zone-pick-h">Open in this zone</div>
          <div className="zone-pick-list">
            {minimized.length === 0 && <div className="fp-note">Every session in this group is already open.</div>}
            {minimized.map((s) => (
              <button key={s.id} className="zone-pick-row" onClick={() => onOpen(s)}>
                <span className={`dot sm ${s.status}`} />
                <span className="t">{titleOf(s)}</span>
              </button>
            ))}
          </div>
          <div className="row">
            <button className="outline" onClick={() => onPick(false)}>Cancel</button>
            <button className="primary" autoFocus onClick={onNew}>New session…</button>
          </div>
        </div>
      ) : (
        <button className="zone-open" onClick={() => onPick(true)} title="Open one of this group's minimized sessions here, or start a new one">
          + Open a session here
        </button>
      )}
    </div>
  );
}

function gridCols(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [resumable, setResumable] = useState<SessionInfo[]>([]);
  const [shown, setShown] = useState<string[]>(() => loadLS("mb.shown", []));
  const [focused, setFocused] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  // pinned panes stay on screen when the grid switches groups
  const [pinned, setPinned] = useState<string[]>(() => loadLS("mb.pinned", []));
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  // the group the grid was last switched to (see activeGroupOf)
  const [lastGroup, setLastGroup] = useState<string | null>(() => loadLS("mb.activeGroup", null));
  // which pane sits in which snap-layout zone, per group (cell key per zone)
  const [zoneSeats, setZoneSeats] = useState<Record<string, (string | null)[]>>(() => loadLS("mb.zones", {}));
  // an empty zone's "open a session here" picker, and a new session headed for a zone
  const [slotPick, setSlotPick] = useState<number | null>(null);
  // the ticket pipeline opened from the grid (group bar, palette)
  const pipelines = usePipelines();
  const [pipelineFor, setPipelineFor] = useState<{ id: string; title: string } | null>(null);
  // "continue in the other agent" for this session
  const [handoffFor, setHandoffFor] = useState<SessionInfo | null>(null);
  // "undo a turn" for this session
  const [undoFor, setUndoFor] = useState<SessionInfo | null>(null);
  // agent messaging: the log, how messages arrive per group, and a group's status check
  const agentMessages = useAgentMessages();
  const [msgLogFor, setMsgLogFor] = useState<{ id?: string; title?: string } | null>(null);
  const [rollupOpen, setRollupOpen] = useState(false);
  const [msgModes, setMsgModes] = useState<Record<string, MessageMode>>({});
  const [msgDefaultSend, setMsgDefaultSend] = useState(true);
  const [statusNote, setStatusNote] = useState("");
  // Main-process handlers answer { error } instead of rejecting. A failed read
  // never lands in state: the previous value stays and the status bar says why.
  const [readError, setReadError] = useState<string | null>(null);
  const readFailed = (what: string, r: { error: string }) => {
    console.error(`[mockingbird] couldn't read ${what}:`, r.error);
    setReadError(`Couldn't read ${what}: ${r.error}`);
  };
  const unlessError =
    <T,>(what: string, apply: (v: T) => void) =>
    (r: T | { error: string }) =>
      isErr(r) ? readFailed(what, r) : apply(r as T);
  /** A change the main process refused: said right away. Returns whether it failed. */
  const failed = (what: string, r: unknown): boolean => {
    if (!isErr(r)) return false;
    alert(`${what}: ${r.error}`);
    return true;
  };
  const setMsgMode = async (group: string, mode: MessageMode | ""): Promise<boolean> => {
    const r = await window.mb.messagesGroupMode(group, mode || null);
    if (isErr(r)) {
      alert(`Couldn't change how agent messages arrive in ${group}: ${r.error}`);
      return false;
    }
    setMsgModes(r);
    return true;
  };
  const askGroupStatus = async (group: string) => {
    const r = await window.mb.groupStatusCheck(group);
    if (isErr(r)) return alert(r.error);
    setStatusNote(`Asked ${plural(r.asked, "session")}`);
    setTimeout(() => setStatusNote(""), 6000);
  };
  // agent CLIs updated under running panes (they run the old version until restarted)
  const [agentUpdates, setAgentUpdates] = useState<AgentUpdateNotice[]>([]);
  useEffect(() => {
    window.mb.healthUpdates().then(unlessError("which agent CLIs were updated", (n: AgentUpdateNotice[]) => setAgentUpdates(Array.isArray(n) ? n : [])));
    return window.mb.onHealthUpdates((n: AgentUpdateNotice[]) => setAgentUpdates(Array.isArray(n) ? n : []));
  }, []);
  // files two worktrees of one repository have both changed, per session
  const [overlaps, setOverlaps] = useState<Record<string, FileOverlap[]>>({});
  useEffect(() => {
    window.mb.overlapsGet().then(unlessError("files changed in two worktrees", (o: Record<string, FileOverlap[]>) => setOverlaps(o ?? {})));
    return window.mb.onOverlapsChanged((o: Record<string, FileOverlap[]>) => setOverlaps(o ?? {}));
  }, []);
  const [pendingZone, setPendingZone] = useState<{ group: string; zone: number } | null>(null);
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
  // tabs turned off in Settings leave the top bar (and the palette); one opened
  // anyway — by a notification or a search hit — shows while it's the active tab
  const [hiddenTabs, setHiddenTabs] = useState<OptionalTab[]>([]);
  // one-click session setups (Settings → Presets), and one being saved from New session
  const [presets, setPresets] = useState<SessionPreset[]>([]);
  const [presetDraft, setPresetDraft] = useState<SessionPreset | null>(null);
  const shownTab = (t: Tab) => !(hiddenTabs as Tab[]).includes(t);
  const [theme, setTheme] = useState<"dark" | "light">(() => loadLS<"dark" | "light">("mb.theme", "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mb.theme", JSON.stringify(theme));
    applyTermTheme(theme === "light"); // xterm colors follow the app theme
  }, [theme]);
  const [hooksOk, setHooksOk] = useState(true);
  const [filter, setFilter] = useState("");
  // a session title being edited inline in its sidebar row
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
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
  const [closeDlg, setCloseDlg] = useState<{ session: SessionInfo; wt: WorktreeStateInfo | { error: string } } | null>(null);
  const [groupDlg, setGroupDlg] = useState<SessionInfo | null>(null);
  // group/workspace renames use a dialog: inline editing broke because the same
  // edit field rendered in two places (sidebar + workspace tab strip) and the
  // second mount stole focus from the first, instantly closing it. Sessions use
  // it too when renamed from somewhere their sidebar row may not be showing.
  const [renameDlg, setRenameDlg] = useState<{ kind: "group" | "sub" | "session"; key: string; initial: string } | null>(null);

  const applyRename = async (v: string) => {
    if (!renameDlg) return;
    if (renameDlg.kind === "session") {
      if (failed("Couldn't rename the session", await window.mb.renameSession(renameDlg.key, v))) return;
      setRenameDlg(null);
      refresh();
      return;
    }
    // "top/sub" is one key in the store, so both kinds are the same rename:
    // renameGroup is prefix-aware and remaps every member in a single pass
    const next =
      renameDlg.kind === "group"
        ? sanitizeSegment(v)
        : `${topOfKey(renameDlg.key)}/${sanitizeSegment(v)}`;
    if (!next) return;
    if (renameDlg.key === "ungrouped") {
      // "ungrouped" is the absence of a group, not a stored one: naming it groups its sessions
      for (const m of groupUngrouped(workSessions, next)) {
        if (failed("Couldn't name the group", await window.mb.setGroup(m.id, m.group))) return refresh();
      }
      await migrateGroupKeys(renameDlg.key, next);
    } else if (next !== renameDlg.key) {
      if (failed("Couldn't rename the group", await window.mb.renameGroup(renameDlg.key, next))) return;
      await migrateGroupKeys(renameDlg.key, next);
    }
    setRenameDlg(null);
    refresh();
  };
  const [statusPop, setStatusPop] = useState<SessionStatus | null>(null);
  const [update, setUpdate] = useState<{ latest: string; url: string; newer: boolean; source: "release" | "branch" } | null>(null);
  const [upd, setUpd] = useState<UpdateProgress>({ state: "idle", done: [], log: [] });
  const drag = useDrag();
  useEffect(() => installDragListeners(), []);
  useEffect(() => installTooltips(), []);
  // unsaved edits hold the window open; the main process asks whether to quit anyway
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (!dirtyKeys().length) return;
      e.preventDefault();
      e.returnValue = false;
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);
  // Collaborate models waiting on an approval, per room — badged on the tab wherever you are
  const [roomAsks, setRoomAsks] = useState<Record<string, number>>({});
  useEffect(() => {
    window.mb.collabList().then(
      unlessError("the Collaborate rooms", (rooms: CollabRoom[]) => setRoomAsks(Object.fromEntries(rooms.map((r) => [r.id, r.pending?.length ?? 0]))))
    );
    return window.mb.onCollabChanged((r: CollabRoom) => setRoomAsks((p) => ({ ...p, [r.id]: r.pending?.length ?? 0 })));
  }, []);
  const asksWaiting = Object.values(roomAsks).reduce((a, b) => a + b, 0);
  const [updOutcome, setUpdOutcome] = useState<(UpdateOutcome & { restoreErrors?: string[] }) | null>(null);
  useEffect(() => {
    window.mb.updateStatus().then(unlessError("the update's progress", setUpd));
    return window.mb.onUpdateProgress((p: UpdateProgress) => setUpd(p));
  }, []);
  // After an update restart: say how it went, and bring back the sessions that were open
  useEffect(() => {
    window.mb.updateOutcome().then(async (o: UpdateOutcome | null | { error: string }) => {
      if (isErr(o)) return readFailed("how the last update went", o);
      if (!o) return;
      const restoreErrors: string[] = [];
      for (const id of o.sessions) {
        const r = await window.mb.relaunchSession(id);
        if (isErr(r)) restoreErrors.push(r.error);
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
    window.mb.appVersion().then(unlessError("the app version", (v: string) => setAppVersion(String(v))));
  }, []);
  const [sideView, setSideView] = useState<SideView>(() => loadLS<SideView>("mb.sideView", "sessions"));
  useEffect(() => localStorage.setItem("mb.sideView", JSON.stringify(sideView)), [sideView]);
  const [sideW, setSideW] = useState<number>(() => loadLS("mb.sideW", 264));
  useEffect(() => localStorage.setItem("mb.sideW", JSON.stringify(sideW)), [sideW]);
  const [editor, setEditor] = useState(EMPTY_EDITOR);
  const [search, setSearch] = useState<SearchState>(() => ({ q: "", ...loadLS("mb.search", { scope: "conversations", regex: false, matchCase: false }) }));
  useEffect(() => localStorage.setItem("mb.search", JSON.stringify({ scope: search.scope, regex: search.regex, matchCase: search.matchCase })), [search.scope, search.regex, search.matchCase]);
  const [searchFocus, setSearchFocus] = useState(0);
  // Run and Debug: every service's state, and the log panel under the grid (⌘J)
  const [runStates, setRunStates] = useState<RunServiceState[]>([]);
  useEffect(() => {
    window.mb.runStates().then(unlessError("the services' run states", setRunStates));
    return window.mb.onRunChanged(setRunStates);
  }, []);
  const [panelOpen, setPanelOpen] = useState<boolean>(() => loadLS("mb.panel.open", false));
  useEffect(() => localStorage.setItem("mb.panel.open", JSON.stringify(panelOpen)), [panelOpen]);
  const [panelH, setPanelH] = useState<number>(() => loadLS("mb.panel.h", 260));
  useEffect(() => localStorage.setItem("mb.panel.h", JSON.stringify(panelH)), [panelH]);
  const [panelTab, setPanelTab] = useState<string | null>(null);
  const showLog = (id: string) => {
    setPanelTab(id);
    setPanelOpen(true);
  };
  // token meters per pane and for today, pushed when the transcript index catches up
  const [meters, setMeters] = useState<Meters | null>(null);
  useEffect(() => {
    window.mb.metersGet().then(unlessError("the token meters", setMeters));
    return window.mb.onMetersChanged((m: Meters) => setMeters(m));
  }, []);
  const runningIn = (cwd: string) => runStates.filter((s) => s.worktree === cwd && (s.status === "running" || s.status === "starting")).length;
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
  useEffect(() => localStorage.setItem("mb.pinned", JSON.stringify(pinned)), [pinned]);
  useEffect(() => localStorage.setItem("mb.activeGroup", JSON.stringify(lastGroup)), [lastGroup]);
  useEffect(() => localStorage.setItem("mb.zones", JSON.stringify(zoneSeats)), [zoneSeats]);

  /** Put a session (dragged from the grid or the sidebar) beside a pane in the grid. */
  const reorder = (srcId: string, targetId: string, side: Side = "before") =>
    setShown((p) => placeBeside(p.includes(srcId) ? p : [...p, srcId], srcId, targetId, side));

  // inline editing is session titles only — group and workspace names are
  // renamed through RenameDialog (a second mounted input stole its focus)
  const commitEdit = async () => {
    if (!editing) return;
    const v = editing.value.trim();
    if (v) failed("Couldn't rename the session", await window.mb.renameSession(editing.key, v));
    setEditing(null);
    refresh();
  };

  /** Remove a sub-group without touching its sessions — they move up into the group. */
  const dissolveSub = async (top: string, list: SessionInfo[]) => {
    const results = await Promise.all(list.map((s) => window.mb.setGroup(s.id, top)));
    const errors = results.filter(isErr);
    if (errors.length) alert(`Couldn't move ${errors.length} of the workspace's sessions into the group: ${errors.map((e) => e.error).join("; ")}`);
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

  /** Re-read the session lists; the live list comes back (the one on screen when the read fails). */
  const refresh = async (): Promise<SessionInfo[]> => {
    const live: SessionInfo[] | { error: string } = await window.mb.listSessions();
    if (isErr(live)) readFailed("the session list", live);
    else setSessions(live);
    const previous: SessionInfo[] | { error: string } = await window.mb.resumableSessions();
    if (isErr(previous)) readFailed("the previous sessions", previous);
    // debriefs aren't restored with the grid's sessions: they live on the WorkTracker tab
    else setResumable(previous.filter((s) => !s.debrief));
    return isErr(live) ? sessions : live;
  };

  // First launch opens the setup wizard. Installs that predate it (the help
  // popup was already seen) are marked set up without being interrupted.
  useEffect(() => {
    window.mb.getSettings().then(async (s: Settings | { error: string }) => {
      if (isErr(s)) return readFailed("settings", s);
      const hidden = s.hiddenTabs ?? [];
      setHiddenTabs(hidden);
      setPresets(s.presets ?? []);
      setMsgModes(s.agentMessagesByGroup ?? {});
      setMsgDefaultSend(s.agentMessagesSubmit !== false);
      setTab((t) => ((hidden as Tab[]).includes(t) ? "sessions" : t));
      if (s.setupDone) return;
      if (loadLS("mb.helpSeen", false)) failed("Couldn't mark setup as done", await window.mb.setSettings({ setupDone: true }));
      else {
        localStorage.setItem("mb.helpSeen", "true");
        setModal("setup");
      }
    });
  }, []);

  useEffect(() => {
    refresh();
    window.mb.hooksInstalled().then(unlessError("whether the status hooks are installed", (ok: unknown) => setHooksOk(ok === true)));
    // note: `shown` is deliberately NOT pruned against the live list — relaunch
    // reuses session ids, so a restored session lands back in its old grid slot
    const off = window.mb.onSessionsChanged((s: SessionInfo[]) => setSessions(s));
    const offUi = window.mb.onUiCommand((cmd: string, arg?: string) => {
      if (cmd === "new-session") setModal("new");
      if (cmd === "update") setModal("update"); // the update notification was clicked
      if (cmd === "focus-session" && arg) jumpToRef.current(arg);
    });
    const offUpd = window.mb.onUpdateAvailable((u: any) => u?.newer && setUpdate(u));
    window.mb.usageGet().then(unlessError("plan usage", setUsage));
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

  /** A live session's top-level group; undefined for an id awaiting a relaunch. */
  const groupOfId = (id: string): string | undefined => {
    const s = sessions.find((x) => x.id === id);
    return s ? topOf(s) : undefined;
  };
  // the grid is group-exclusive at the TOP level: every shown session belongs
  // to the active group (pinned panes excepted); sub-groups act as tabs within it
  const activeGroup = useMemo(() => activeGroupOf(shown, groupOfId, pinnedSet, lastGroup), [shown, sessions, pinnedSet, lastGroup]);
  useEffect(() => {
    if (activeGroup && activeGroup !== lastGroup) setLastGroup(activeGroup);
  }, [activeGroup]);

  /** Carry a group's remembered UI state across a rename — these registries are
   *  keyed by group path, so without this a rename silently loses the group's
   *  layout, its workspaces' active tabs and folders, its collapsed state, and
   *  how agent messages arrive in it. */
  const migrateGroupKeys = async (oldKey: string, newKey: string) => {
    const remap = <T,>(rec: Record<string, T>) => remapGroupKeys(rec, oldKey, newKey);
    setGroupLayouts(remap);
    setWsTabs(remap);
    setWsOpen(remap);
    setLayouts(remap);
    setZoneSeats((prev) => remapSeats(prev, oldKey, newKey));
    setLastGroup((g) => (g === oldKey ? topOfKey(newKey) : g));
    setCollapsed((prev) => {
      if (!prev.has(oldKey)) return prev;
      const next = new Set(prev);
      next.delete(oldKey);
      next.add(topOfKey(newKey));
      return next;
    });
    // the per-group message mode lives in settings, keyed by top-level group
    const [oldTop, newTop] = [topOfKey(oldKey), topOfKey(newKey)];
    const mode = msgModes[oldTop];
    if (mode && oldTop !== newTop && (await setMsgMode(newTop, mode))) await setMsgMode(oldTop, "");
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

  // record the active group's visible subset whenever it changes (its own
  // panes only — pinned visitors from other groups aren't part of its layout)
  useEffect(() => {
    if (!activeGroup) return;
    const own = layoutToRemember(shown, groupOfId, activeGroup);
    if (own.length === 0) return;
    setGroupLayouts((prev) => {
      const cur = prev[activeGroup];
      if (cur && cur.length === own.length && cur.every((id, i) => id === own[i])) return prev;
      return { ...prev, [activeGroup]: own };
    });
  }, [shown, activeGroup]);

  /** A group's remembered layout, pruned to sessions that still exist in it. */
  const rememberedLayout = (g: string): string[] => {
    const ids = sessions.filter((x) => topOf(x) === g).map((x) => x.id);
    return (groupLayouts[g] ?? []).filter((id) => ids.includes(id));
  };

  /** Swap the grid to another group's panes; pinned panes stay where they are. */
  const switchGrid = (g: string, ids: string[]) => {
    setZoomed(null);
    setLastGroup(g);
    setShown((p) => switchTo(p, pinnedSet, ids));
    collapseOthers(g);
  };

  /** Show a session — same group appends; a different group swaps the grid to
   *  that group's remembered layout (plus the clicked session). */
  const showSession = (s: SessionInfo) => {
    const g = topOf(s);
    if (activeGroup && g !== activeGroup && !pinnedSet.has(s.id)) {
      const remembered = rememberedLayout(g);
      switchGrid(g, remembered.length ? [...new Set([...remembered, s.id])] : [s.id]);
    } else {
      setShown((p) => (p.includes(s.id) ? p : [...p, s.id]));
    }
  };

  /** Pin or unpin panes. Pinning puts a minimized session back on screen;
   *  unpinning a visitor from another group sends it back to its group. */
  const togglePin = (ids: string[]) => {
    const pin = !ids.every((id) => pinnedSet.has(id));
    setPinned((p) => (pin ? [...new Set([...p, ...ids])] : p.filter((id) => !ids.includes(id))));
    if (pin) setShown((p) => [...p, ...ids.filter((id) => !p.includes(id))]);
  };

  /**
   * Move a session into a group (null = out of any). The grid keeps its panes:
   * a session moved into the group on screen opens there (as the front tab of
   * its workspace); one moved to another group leaves the grid and is open
   * when that group is next shown — unless it's pinned, which keeps it here.
   */
  const moveToGroup = async (id: string, group: string | null) => {
    const top = topOfKey(group ?? "ungrouped");
    const stays = !activeGroup || top === activeGroup || pinnedSet.has(id);
    if (!stays) {
      setShown((p) => p.filter((x) => x !== id));
      setGroupLayouts((p) => ({ ...p, [top]: [...(p[top] ?? []).filter((x) => x !== id), id] }));
    }
    const before = shown;
    if (failed("Couldn't move the session", await window.mb.setGroup(id, group))) {
      setShown(before);
      return;
    }
    if (stays) {
      setShown((p) => (p.includes(id) ? p : [...p, id]));
      if (group && splitGroupKey(group).sub) setWsTabs((p) => ({ ...p, [group]: id }));
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

  // one group on screen: a pane whose session moved to another group (or a stale
  // persisted layout) leaves the grid, unless it's pinned
  useEffect(() => {
    setShown((prev) => pruneToGroup(prev, groupOfId, pinnedSet, activeGroup));
  }, [sessions, pinnedSet, activeGroup]);

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

  const gridSessions = useMemo(
    () =>
      zoomed
        ? sessions.filter((s) => s.id === zoomed)
        : shown.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s),
    [zoomed, sessions, shown]
  );

  // grid cells: plain sessions render individually; a sub-group renders as ONE
  // workspace pane with tabs (cmux-style)
  const cells: GridCell[] = useMemo(() => {
    if (zoomed) return gridSessions.map((s) => ({ kind: "session" as const, s }));
    const out: GridCell[] = [];
    const seen = new Set<string>();
    for (const s of gridSessions) {
      const sub = subOf(s);
      const key = `${topOf(s)}/${sub}`;
      if (!sub) out.push({ kind: "session", s });
      else if (!seen.has(key)) {
        seen.add(key);
        // tabs are the workspace's members that are in the grid, so closing a
        // tab hides just that session; the pane goes when its last tab does
        out.push({
          kind: "workspace",
          key,
          sub,
          list: workSessions.filter((x) => topOf(x) === topOf(s) && subOf(x) === sub && shown.includes(x.id)),
        });
      }
    }
    return out;
  }, [gridSessions, workSessions, zoomed, shown]);
  /** How zones and drops name a cell: its session, or "ws:<workspace key>". */
  const cellKey = (c: GridCell) => (c.kind === "session" ? c.s.id : `ws:${c.key}`);
  const cellKeyOfSession = (s: SessionInfo) => cellKeyFor(s.id, s.taskGroup);

  // without a template the grid grows with the cell count — equal cells, no filler tiles
  const seatKey = activeGroup ?? "";
  const curLayoutId = layouts[seatKey] ?? "";
  const layout = useMemo(() => (zoomed ? null : LAYOUTS.find((x) => x.id === curLayoutId) ?? null), [curLayoutId, zoomed]);
  const cellKeys = useMemo(() => cells.map(cellKey), [cells]);
  const shortcuts = useMemo(() => paneShortcuts(cells, wsTabs), [cells, wsTabs]);
  const zoning = useMemo(
    () => (layout ? placeInZones(cellKeys, layout.zones.length, zoneSeats[seatKey] ?? []) : null),
    [layout, cellKeys, zoneSeats, seatKey]
  );
  /** Seat a cell in a zone (a swap when it comes from another zone). */
  const seatInZone = (key: string, zone: number) => {
    if (!layout || !zoning) return;
    setZoneSeats((p) => ({ ...p, [seatKey]: dropInZone(seating(cellKeys, zoning, layout.zones.length), key, zone) }));
  };
  const cols = zoomed
    ? 1
    : layout
      ? layout.cols
      : colsPref === "auto"
        ? gridCols(Math.max(1, cells.length))
        : colsPref;
  const rows = layout
    ? layout.rows + Math.ceil((zoning?.overflow.length ?? 0) / layout.cols)
    : Math.max(1, Math.ceil(Math.max(1, cells.length) / cols));
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
      switchGrid(top, list.map((s) => s.id));
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

  /** Click a group header: the grid shows the panes that group last had open
   *  (all of its sessions the first time), whether or not it's already active.
   *  NOTE: no focusTerm here — stealing keyboard focus right after a header
   *  click kills the double-click rename input (it blurs and closes). */
  const focusGroup = (key: string, list: SessionInfo[]) => {
    const remembered = rememberedLayout(key);
    const ids = remembered.length ? remembered : list.map((s) => s.id);
    switchGrid(key, ids);
    const first = ids[0] ?? list[0]?.id;
    if (first) setFocused(first);
  };

  /** The drop cue for moving a dragged sidebar/pane session into `group` (null = out of any group). */
  const intoGroupTarget = (targetKey: string, group: string | null, name: string) => {
    const src = sessions.find((x) => x.id === dragging("text/mb-session"));
    if (!src || (src.taskGroup ?? null) === group) return null; // already there
    return { key: targetKey, outcome: group === null ? `Move ${titleOf(src)} out of its group` : `Move ${titleOf(src)} into ${name}` };
  };

  /** Drop handler shared by group headers and rows — moves the dragged session. */
  const dropToGroup = (e: React.DragEvent, group: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const src = e.dataTransfer.getData("text/mb-session");
    if (src) moveToGroup(src, group);
  };

  /**
   * Make a session a tab in the pane showing `target`: it joins the target's
   * workspace, or a new workspace holding both when the target is a lone pane —
   * `newKey` when the caller already chose it, else auto-named and offered for
   * renaming. Every way of making a workspace comes through here, so the lone
   * pane's zone and pin always carry over to the workspace.
   */
  const addAsTab = async (src: SessionInfo, target: SessionInfo, newKey?: string) => {
    if (src.id === target.id) return;
    let key = subOf(target) ? `${topOf(target)}/${subOf(target)}` : null;
    if (!key) {
      const top = topOf(target);
      key = newKey ?? `${top}/${nextSubName(top)}`;
      const wsKey = key;
      if (failed("Couldn't make the workspace", await window.mb.setGroup(target.id, wsKey))) return;
      // the lone pane's zone becomes the workspace's
      setZoneSeats((p) => {
        const g = activeGroup ?? "";
        return p[g] ? { ...p, [g]: p[g].map((v) => (v === target.id ? `ws:${wsKey}` : v)) } : p;
      });
      if (!newKey) setRenameDlg({ kind: "sub", key: wsKey, initial: splitGroupKey(wsKey).sub ?? "" });
    }
    const wsKey = key;
    if (src.taskGroup !== wsKey && failed("Couldn't add the tab", await window.mb.setGroup(src.id, wsKey))) return;
    if (pinnedSet.has(target.id)) setPinned((p) => (p.includes(src.id) ? p : [...p, src.id]));
    setShown((p) => placeBeside(p.includes(src.id) ? p : [...p, src.id], src.id, target.id, "after"));
    setWsTabs((p) => ({ ...p, [wsKey]: src.id }));
    setFocused(src.id);
  };

  /** The drop cue for making the dragged session a tab in `target`'s pane, if that would change anything. */
  const tabTarget = (key: string, target: SessionInfo) => {
    const src = sessions.find((x) => x.id === dragging("text/mb-session"));
    if (!src || src.id === target.id) return null;
    const ws = subOf(target) ? `${topOf(target)}/${subOf(target)}` : null;
    if (ws && src.taskGroup === ws && shown.includes(src.id)) return null; // already a tab here
    return { key, outcome: ws ? `Open ${titleOf(src)} as a tab in ${subOf(target)}` : `Open ${titleOf(src)} as a tab with ${titleOf(target)}` };
  };

  const restoreAll = async () => {
    const failures: string[] = [];
    for (const s of resumable) {
      const info = await window.mb.relaunchSession(s.id);
      if (isErr(info)) failures.push(`✕ ${s.title}: ${info.error}`);
    }
    await refresh();
    if (failures.length) alert(`Some sessions couldn't be restored:\n\n${failures.join("\n")}`);
  };

  // A restarted pane needs a new terminal: the cached one holds the old CLI's
  // screen and modes. Bumping its key remounts the pane, whichever order the
  // restart's remove/re-add and this call arrive in, and it replays the new
  // pty's buffer from the start.
  const [termGen, setTermGen] = useState<Record<string, number>>({});
  const freshTerms = (ids: string[]) => {
    ids.forEach(disposeTerm);
    setTermGen((g) => ({ ...g, ...Object.fromEntries(ids.map((id) => [id, (g[id] ?? 0) + 1])) }));
  };
  const termKey = (id: string) => `${id}:${termGen[id] ?? 0}`;

  // ---- session close flow (design 1e) ----
  /** Close a session's pane and process; returns why it couldn't, leaving the pane as it was. */
  const forceClose = async (s: SessionInfo, forget: boolean): Promise<string | null> => {
    const r = await window.mb.killSession(s.id, forget);
    if (isErr(r)) return r.error;
    disposeTerm(s.id);
    hide(s.id);
    refresh();
    return null;
  };
  /** forceClose where no dialog is open to show the failure. */
  const closeNow = async (s: SessionInfo, forget: boolean) => {
    const err = await forceClose(s, forget);
    if (err) alert(`Couldn't close ${titleOf(s)}: ${err}`);
  };

  /** Close a session; dirty or unpushed worktrees get the dialog, clean ones close silently. */
  const requestClose = async (s: SessionInfo) => {
    const hasWorktree = s.repoPath && s.branch && s.cwd !== s.repoPath;
    if (!hasWorktree) return closeNow(s, true);
    const st: WorktreeStateInfo | { error: string } = await window.mb.worktreeState(s.cwd);
    if ("error" in st) {
      if (worktreeGone(st.error)) return closeNow(s, true);
      return setCloseDlg({ session: s, wt: st }); // unknown state: the dialog says why and only keeps
    }
    if (!st.dirty && st.ahead === 0) return closeNow(s, true);
    setCloseDlg({ session: s, wt: st });
  };

  const resumeDead = async (s: SessionInfo) => {
    // drop the dead pty, keep the store entry
    if (failed(`Couldn't resume ${titleOf(s)}`, await window.mb.killSession(s.id, false))) return;
    disposeTerm(s.id);
    const info = await window.mb.relaunchSession(s.id);
    if (isErr(info)) return alert(`Couldn't resume: ${info.error}`);
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
    if (cmd && e.key === "/" && !inEditor(e.target as Element)) {
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
    if (cmd && e.shiftKey && e.key.toLowerCase() === "d") {
      handled();
      showView("run");
      return;
    }
    if (cmd && !e.shiftKey && !e.ctrlKey && e.key === "j" && tab === "sessions") {
      handled();
      setPanelOpen((o) => !o);
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
    if (e.key === "Escape" && zoomed && escapeLeavesFullscreen(e.target as Element, !!document.querySelector(OVERLAYS))) {
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
      const target = cell && frontOf(cell, wsTabs);
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
    if (isErr(info)) return info.error;
    await refresh();
    jumpToSession(info);
    return null;
  };

  // what New session was opened for (a pane's "+", an empty zone, a workspace's
  // tab strip, a launch kind) lasts only while it's open, however it closes
  useEffect(() => {
    if (modal === "new") return;
    setPendingWs(null);
    setPendingZone(null);
    setNewGroup("");
    setNewLaunch("claude");
  }, [modal]);

  const onCreated = async (s: SessionInfo) => {
    // the lone pane joins its new workspace — unless the dialog put the session elsewhere
    const lone = pendingWs && s.taskGroup === pendingWs.key ? sessions.find((x) => x.id === pendingWs.id) : undefined;
    if (lone && pendingWs) await addAsTab(s, lone, pendingWs.key);
    // "New session" from an empty zone: the zone holds the session's cell, its workspace if it joined one
    if (pendingZone && pendingZone.group === seatKey) seatInZone(cellKeyFor(s.id, s.taskGroup), pendingZone.zone);
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

  /**
   * Open a definition: in the editor tab's own session when the file is in its
   * folder, else any session whose folder holds it. Returns why it can't open.
   */
  const openLocation = (loc: LspLocation, fromSession: string): string | null => {
    const s = sessionHolding(sessions, loc.path, sessions.find((x) => x.id === fromSession));
    if (!s) return `The definition is outside the session's folder: ${loc.path}:${loc.line}`;
    setEditor((e) => openTab(e, { sessionId: s.id, root: s.cwd, path: loc.path.slice(s.cwd.length + 1), mode: "file", reveal: { line: loc.line, at: Date.now() } }, new Set(dirtyKeys())));
    return null;
  };

  /** Mute or unmute a session's notifications. */
  const toggleMute = async (s: SessionInfo) => {
    const r = await window.mb.sessionMute(s.id, !s.muted);
    if (isErr(r)) alert(`Couldn't change it: ${r.error}`);
  };

  /** Start the morning brief or the 4pm wrap-up on the WorkTracker tab. */
  const runDebrief = async (kind: "morning" | "wrapUp") => {
    setTab("worktracker");
    const r = await window.mb.runDebrief(kind);
    if (isErr(r)) alert(`Couldn't start the ${kind === "morning" ? "morning brief" : "4pm wrap-up"}: ${r.error}`);
    refresh();
  };

  /** Start a preset's session and show it. */
  const startPreset = async (p: SessionPreset) => {
    const info = await window.mb.presetStart(p.id);
    if (isErr(info)) return alert(`Couldn't start “${p.name}”: ${info.error}`);
    await refresh();
    jumpToSession(info);
  };
  /** Save the preset list. Settings writes merge, so only the changed key is sent. */
  const savePresets = async (next: SessionPreset[]) => {
    const r = await window.mb.setSettings({ presets: next });
    if (isErr(r)) return alert(`Couldn't save the preset: ${r.error}`);
    setPresets(next);
  };

  /** Type text into a session's prompt and bring its pane up; the user reads it there and presses Return. */
  const typeInto = (id: string, text: string) => {
    window.mb.sessionWrite(id, text);
    jumpTo(id);
  };
  const openScmFor = (id: string) => {
    setFocused(id);
    showView("scm");
  };
  /** A ticket group's id and title, when the group is an ADO work item. */
  const ticketOfGroup = (g: string | null): { id: string; title: string } | null => {
    if (!g || !/^\d+$/.test(g)) return null;
    const t = workSessions.find((s) => topOf(s) === g && s.ticketTitle)?.ticketTitle ?? "";
    return { id: g, title: t };
  };

  /** Open a file of the focused session's folder in its own editor tab. */
  const openInEditor = (path: string, o: { mode?: "file" | "diff"; status?: string; source?: DiffSource; line?: number | null } = {}) => {
    const s = focusedSession;
    if (!s) return;
    const reveal = o.line ? { line: o.line, at: Date.now() } : undefined;
    setEditor((e) => openTab(e, { sessionId: s.id, root: s.cwd, path, mode: o.mode ?? "file", status: o.status, source: o.source, reveal }, new Set(dirtyKeys())));
  };
  /**
   * Show a debugger location in the editor. Files are read through a pane
   * whose folder holds them (the focused one first), so the editor's folder
   * boundary still applies; library code outside every pane's folder isn't opened.
   */
  const openFrame = (frame: DebugFrame) => {
    if (!frame.path) return;
    const s = sessionHolding(sessions, frame.path, focusedSession);
    if (!s) {
      addOutput({ sid: "", category: "important", text: `${frame.path}:${frame.line} isn't inside an open session's folder, so it isn't shown.\n` });
      return;
    }
    const reveal = { line: frame.line, at: Date.now() };
    setEditor((e) => openTab(e, { sessionId: s.id, root: s.cwd, path: frame.path!.slice(s.cwd.length + 1), mode: "file", reveal }, new Set(dirtyKeys())));
  };
  const openFrameRef = useRef(openFrame);
  openFrameRef.current = openFrame;
  // where the debugger stops, the editor opens, with the debug controls beside it
  useEffect(
    () =>
      onStopped((_sid, at) => {
        if (at.frame) openFrameRef.current(at.frame);
        setTab("sessions");
        setSideView("run");
        setSideCollapsed(false);
      }),
    []
  );
  const activeTab = editor.tabs.find((t) => tabKey(t) === editor.active) ?? null;
  const activePath = activeTab && focusedSession && activeTab.root === focusedSession.cwd ? activeTab.path : null;

  // the Source Control badge: the focused folder's uncommitted files (the same
  // cached state the pane rails read, so this costs no extra git work)
  const [scmCount, setScmCount] = useState(0);
  const [scmCountError, setScmCountError] = useState<string | null>(null);
  const focusedCwd = tab === "sessions" ? focusedSession?.cwd ?? null : null;
  const scmSeq = useRef(0);
  const loadScmCount = () => {
    const n = ++scmSeq.current;
    if (!focusedCwd) {
      setScmCountError(null);
      return setScmCount(0);
    }
    window.mb.worktreeState(focusedCwd).then((r: WorktreeStateInfo | { error: string }) => {
      if (n !== scmSeq.current) return;
      // a folder outside any repository has nothing to count; anything else is a failure to show
      setScmCountError(isErr(r) && !/not a git repository/i.test(r.error) ? r.error : null);
      setScmCount(isErr(r) ? 0 : r.dirtyFiles);
    });
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
    window.mb.watchFolders(watchKey ? watchKey.split(",") : []).then((r: unknown) => isErr(r) && console.error("[mockingbird] couldn't watch the sessions' folders:", r.error));
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
          {(["sessions", "dashboard", "worktracker", "collaborate", "settings"] as const).filter((t) => shownTab(t) || tab === t).map((t) => (
            <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
              {t === "worktracker" && debriefSessions.some((s) => s.status === "waiting") && (
                <span className="dot sm waiting" style={{ marginLeft: 6 }} />
              )}
              {t === "collaborate" && asksWaiting > 0 && (
                <span className="tab-badge" title={`${plural(asksWaiting, "request")} from models waiting on you`}>
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
                <Popover className="lay-pop" onClose={() => setLayoutOpen(false)}>
                  <div className="lay-grid">
                    {LAYOUTS.map((l) => (
                      <button
                        key={l.id}
                        className={`lay-opt ${curLayoutId === l.id ? "on" : ""}`}
                        title={`${l.label} — ${l.zones.length} zones`}
                        onClick={() => {
                          setLayouts((p) => ({ ...p, [seatKey]: l.id }));
                          setZoneSeats((p) => ({ ...p, [seatKey]: [] }));
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
                      setLayouts((p) => ({ ...p, [seatKey]: "" }));
                      setLayoutOpen(false);
                    }}
                  >
                    Auto — fit panes to the window
                  </button>
                  <div className="lay-note">
                    {curLayoutId
                      ? "Drag a pane onto another to swap places, or into an empty zone. Drag any pane edge to fine-tune."
                      : "Panes fill the window automatically."}
                  </div>
                </Popover>
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
            onAskSession={typeInto}
            onOpenScm={openScmFor}
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
            onHiddenTabs={setHiddenTabs}
            presets={presets}
            onPresets={setPresets}
            onMsgDefaultSend={setMsgDefaultSend}
            onStartPreset={startPreset}
          />
        )}
        {tab === "collaborate" && (
          <CollaborateView
            focusRoom={focusRoom}
            onOpenSession={async (id) => {
              setTab("sessions");
              const s = (await refresh()).find((x) => x.id === id);
              if (s) jumpToSession(s);
              else alert("That session isn't running any more — a closed one is under Previous in the Sessions side bar.");
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
              <button className="outline" data-tip="Time per ticket and outcomes for the week, written into WorkTracker" onClick={() => setRollupOpen(true)}>
                Weekly rollup
              </button>
              <button
                className="outline"
                onClick={() => runDebrief("morning")}
              >
                Morning brief
              </button>
              <button
                className="primary"
                onClick={() => runDebrief("wrapUp")}
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
                    key={termKey(s.id)}
                    session={s}
                    focused={focused === s.id}
                    zoomed={false}
                    density="max"
                    paneIndex={99}
                    onFocus={() => setFocused(s.id)}
                    onClose={() => closeNow(s, true)}
                    onResume={() => resumeDead(s)}
                    onCleanup={() => closeNow(s, true)}
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
            const badge =
              id === "sessions" ? counts.waiting : id === "scm" ? scmCount : id === "run" ? runStates.filter((s) => s.status === "running" || s.status === "starting").length : 0;
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
                {id === "scm" && scmCountError ? (
                  <span className="ab-badge waiting" title={`Couldn't count uncommitted files: ${scmCountError}`}>!</span>
                ) : badge > 0 && (
                  <span
                    className={`ab-badge ${id === "sessions" ? "waiting" : ""}`}
                    title={id === "sessions" ? `${badge} waiting on you` : id === "run" ? `${plural(badge, "service")} running` : plural(badge, "uncommitted file")}
                  >
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
              editor={editor}
              onOpen={(path, status) => openInEditor(path, { status })}
              onActivate={(key) => setEditor((e) => ({ ...e, active: key }))}
              onCloseTab={(key) => setEditor((e) => closeTab(e, key))}
              onCloseAll={() => setEditor(EMPTY_EDITOR)}
              onQuickOpen={() => setModal("quickopen")}
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
                onAskSession={(text) => typeInto(focusedSession.id, text)}
                review={
                  focusedSession.shell
                    ? undefined
                    : {
                        agent: otherAgent(focusedSession.agent) === "codex" ? "Codex" : "Claude",
                        start: async () => {
                          const author = focusedSession;
                          const info = await window.mb.reviewStart(author.id);
                          if (isErr(info)) return `Couldn't start the review: ${info.error}`;
                          await refresh();
                          // the reviewer opens beside the session it's reviewing
                          setShown((p) => placeBeside(p.includes(info.id) ? p : [...p, info.id], info.id, author.id, "after"));
                          return null;
                        },
                      }
                }
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
          {sideView === "run" && (
            <RunView
              key={focusedSession?.id ?? ""}
              session={focusedSession}
              states={runStates}
              onShowLog={showLog}
              onAskSession={(text) => focusedSession && typeInto(focusedSession.id, text)}
              onOpenFrame={openFrame}
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
                      className={`sess-item ${idx >= 0 ? "shown" : ""} ${pinnedSet.has(s.id) ? "pinned" : ""}`}
                      onClick={() => (idx >= 0 ? hide(s.id) : showSession(s))}
                      title={`${s.cwd} — double-click name to rename · drag onto a group to move, or onto a pane to open it as a tab there`}
                      draggable
                      onDragStart={(e) => beginDrag(e, "text/mb-session", s.id, `Moving ${titleOf(s)}`, "sidebar")}
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
                          addAsTab(srcS, s);
                        } else {
                          moveToGroup(src, s.taskGroup); // join this row's group/workspace
                        }
                      }}
                    >
                      <span className={`dot ${s.status}`} />
                      {editing?.key === s.id ? (
                        editInput
                      ) : (
                        <span
                          className="name"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditing({ key: s.id, value: titleOf(s) });
                          }}
                        >
                          <span className="nm">{titleOf(s)}</span>
                          {(s.branch || s.agent === "codex") && (
                            <span className="br">
                              {s.agent === "codex" ? "codex · " : ""}
                              {s.branch && s.branch !== titleOf(s) ? s.branch : s.repoPath?.split("/").pop() ?? ""}
                            </span>
                          )}
                        </span>
                      )}
                      <button
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing({ key: s.id, value: titleOf(s) });
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className={`mute ${s.muted ? "on" : ""}`}
                        title={s.muted ? "Notifications muted — click to hear from this session again" : "Mute this session's notifications"}
                        aria-pressed={!!s.muted}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMute(s);
                        }}
                      >
                        {s.muted ? <BellOffIcon /> : <BellIcon />}
                      </button>
                      <button
                        className={`pin ${pinnedSet.has(s.id) ? "on" : ""}`}
                        title={pinnedSet.has(s.id) ? "Unpin — the pane goes back to following its group" : "Pin — keep this pane on screen when you switch groups"}
                        aria-pressed={pinnedSet.has(s.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin([s.id]);
                        }}
                      >
                        <PinIcon />
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
                {resumable.map((s) => (
                  <div key={s.id} className="sess-item" title={s.cwd}>
                    <span className="dot dead" />
                    <span className="name">{s.title}</span>
                    <button
                      title="Relaunch, resuming the conversation"
                      onClick={async () => {
                        const info = await window.mb.relaunchSession(s.id);
                        if (isErr(info)) return alert(`Couldn't relaunch: ${info.error}`);
                        if (info) {
                          await refresh();
                          jumpTo(info.id);
                        }
                      }}
                    >
                      ↺
                    </button>
                    <button
                      className="danger"
                      onClick={async () => {
                        failed(`Couldn't forget ${s.title}`, await window.mb.killSession(s.id, true));
                        refresh();
                      }}
                    >
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
          onCloseAll={() => setEditor(EMPTY_EDITOR)}
          onOpenLocation={openLocation}
          onMode={(key, mode) => setEditor((e) => updateTab(e, key, { mode }))}
          onInsert={(text) => focusedSession && typeInto(focusedSession.id, text)}
        />

        <div className="main">
          {activeGroup && (() => {
            const topSessions = workSessions.filter((s) => topOf(s) === activeGroup);
            return (
              <div className="groupbar">
                <span className="gb-name">{groupTitle(activeGroup, topSessions)}</span>
                {ticketOfGroup(activeGroup) &&
                  (pipelines[activeGroup] ? (
                    <StageChip p={pipelines[activeGroup]} onClick={() => setPipelineFor(ticketOfGroup(activeGroup))} />
                  ) : (
                    <button className="chip" data-tip="Ticket pipeline — track this ticket from coding to done" onClick={() => setPipelineFor(ticketOfGroup(activeGroup))}>
                      Pipeline
                    </button>
                  ))}
                <span style={{ marginLeft: "auto" }} />
                {statusNote && <span className="flbl-info">{statusNote}</span>}
                <select
                  className="gb-msg"
                  value={msgModes[activeGroup] ?? ""}
                  title="How messages from other agents arrive in this group's sessions: sent as a prompt, or typed in and left for you to send"
                  onChange={(e) => setMsgMode(activeGroup, e.target.value as MessageMode | "")}
                >
                  <option value="">Agent messages: {msgDefaultSend ? "auto-send" : "leave in prompt"} (default)</option>
                  <option value="send">Agent messages: auto-send</option>
                  <option value="prompt">Agent messages: leave in prompt</option>
                </select>
                <button className="chip" data-tip="Ask every agent session in this group for a three-line status report — each answers when its current turn ends" onClick={() => askGroupStatus(activeGroup)}>
                  Ask for status
                </button>
                <span className="flbl-info">
                  {gridSessions.filter((s) => topOf(s) === activeGroup).length} of {topSessions.length} shown
                  {(() => {
                    const visitors = gridSessions.filter((s) => topOf(s) !== activeGroup).length;
                    return visitors ? ` · ${visitors} pinned from other groups` : "";
                  })()}
                </span>
              </div>
            );
          })()}
          {gridSessions.length === 0 ? (
            <div
              className="empty"
              data-drop={cue(drag, "grid")}
              onDragOver={(e) => {
                const srcS = sessions.find((x) => x.id === dragging("text/mb-session"));
                overTarget(e, srcS ? { key: "grid", outcome: `Open ${titleOf(srcS)} here` } : null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const srcS = sessions.find((x) => x.id === e.dataTransfer.getData("text/mb-session"));
                if (srcS) jumpToSession(srcS);
              }}
            >
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
                // with a template, a cell sits in its zone (or a row below it);
                // without one, cells flow in order and the last of an incomplete
                // row spans the leftover columns — no dead cells
                const zi = zoning ? zoning.zoneOf[i] : -1;
                const below = zoning ? zoning.overflow.indexOf(i) : -1;
                const area =
                  layout && zoning
                    ? zi >= 0
                      ? layout.zones[zi]
                      : overflowArea(below, cols, layout.rows, below === zoning.overflow.length - 1)
                    : undefined;
                const box = area ? parseZone(area) : null;
                const col = box ? box.ce - 2 : i % cols;
                const row = box ? box.re - 2 : Math.floor(i / cols);
                const remainder = cells.length % cols;
                const span = !zoomed && !layout && remainder !== 0 && i === cells.length - 1 ? cols - (i % cols) : 1;
                const canX = !zoomed && (box ? box.ce <= cols : col + span - 1 < cols - 1);
                const canY = !zoomed && (box ? box.re <= rows : row < rows - 1);
                const resize =
                  canX || canY
                    ? {
                        x: canX ? (e: React.PointerEvent) => startTrackDrag("col", box ? col : col + span - 1, e) : undefined,
                        y: canY ? (e: React.PointerEvent) => startTrackDrag("row", row, e) : undefined,
                        reset: equalizeTracks,
                      }
                    : undefined;
                const myKey = cellKey(cell);
                /** A drop on a pane's body: from the sidebar it opens as a tab; a pane
                 *  swaps zones (with a template) or moves beside this one. */
                const bodyDrop = (s: SessionInfo) => ({
                  cue: cue(drag, `p:${s.id}`),
                  over: (e: React.DragEvent) => {
                    const src = dragging("text/mb-session");
                    if (!src) return e.preventDefault(); // files from Finder: the pane handles those itself
                    const srcS = sessions.find((x) => x.id === src);
                    if (!srcS || src === s.id) return overTarget(e, null);
                    if (dragFrom() === "sidebar" && !shown.includes(src)) return overTarget(e, tabTarget(`p:${s.id}`, s));
                    const srcKey = cellKeyOfSession(srcS);
                    if (srcKey === myKey) return overTarget(e, null);
                    if (layout && zoning) {
                      const from = cellKeys.indexOf(srcKey);
                      if (zi < 0 || from < 0) return overTarget(e, null);
                      const seated = zoning.zoneOf[from] >= 0;
                      return overTarget(e, { key: `p:${s.id}`, outcome: seated ? `Swap ${titleOf(srcS)} and ${titleOf(s)}` : `Put ${titleOf(srcS)} here` });
                    }
                    const side = sideOf(e, e.currentTarget, "x");
                    const inGrid = shown.includes(src);
                    if (inGrid && samePlace(shown, src, s.id, side)) return overTarget(e, null);
                    overTarget(e, { key: `p:${s.id}`, side, outcome: `${inGrid ? "Move" : "Show"} ${titleOf(srcS)} ${side} ${titleOf(s)}` });
                  },
                  drop: (e: React.DragEvent) => {
                    const src = e.dataTransfer.getData("text/mb-session");
                    const srcS = sessions.find((x) => x.id === src);
                    if (!srcS || src === s.id) return;
                    if (dragFrom() === "sidebar" && !shown.includes(src)) return void addAsTab(srcS, s);
                    const srcKey = cellKeyOfSession(srcS);
                    if (srcKey === myKey) return;
                    if (layout && zoning) {
                      if (zi >= 0 && cellKeys.includes(srcKey)) seatInZone(srcKey, zi);
                      return;
                    }
                    // a workspace moves as a whole: all of its tabs go beside the target
                    const moving = shown.filter((id) => {
                      const x = sessions.find((y) => y.id === id);
                      return x ? cellKeyOfSession(x) === cellKeyOfSession(srcS) : false;
                    });
                    const side = sideOf(e, e.currentTarget, "x");
                    setShown((p) => {
                      let next = p.includes(src) ? p : [...p, src];
                      for (const id of side === "after" ? [...(moving.length ? moving : [src])].reverse() : moving.length ? moving : [src]) {
                        next = placeBeside(next, id, s.id, side);
                      }
                      return next;
                    });
                  },
                });
                const tabDrop = (s: SessionInfo, key: string) => ({
                  cue: cue(drag, key),
                  over: (e: React.DragEvent) => overTarget(e, tabTarget(key, s)),
                  drop: () => {
                    const src = sessions.find((x) => x.id === dragging("text/mb-session"));
                    if (src && tabTarget(key, s)) addAsTab(src, s);
                  },
                });
                const isPinned = (ids: string[]) => ids.length > 0 && ids.every((id) => pinnedSet.has(id));
                const visitor = (s: SessionInfo) => (isPinned([s.id]) && activeGroup && topOf(s) !== activeGroup ? `from ${groupTitle(topOf(s), [s])}` : undefined);
                const paneFor = (s: SessionInfo, embedded: boolean, onCloseOverride?: () => void, pinIds: string[] = [s.id]) => (
                  <TerminalPane
                    key={termKey(s.id)}
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
                    runCount={runningIn(s.cwd)}
                    meter={meters?.sessions[s.id]}
                    onOpenRun={() => {
                      setFocused(s.id);
                      showView("run");
                    }}
                    onClose={onCloseOverride ?? (() => hide(s.id))}
                    onZoom={() => setZoomed(zoomed === s.id ? null : s.id)}
                    onAddTab={embedded ? undefined : () => startWorkspaceFrom(s)}
                    onReorder={reorder}
                    drop={bodyDrop(s)}
                    tabDrop={embedded ? undefined : tabDrop(s, `h:${s.id}`)}
                    pinned={isPinned(pinIds)}
                    onPin={zoomed ? undefined : () => togglePin(pinIds)}
                    pinNote={visitor(s)}
                    onResume={() => resumeDead(s)}
                    onCleanup={() => requestClose(s)}
                    onHandoff={s.shell ? undefined : () => setHandoffFor(s)}
                    onUndoTurn={s.shell || !s.repoPath ? undefined : () => setUndoFor(s)}
                    overlaps={overlaps[s.id]}
                    onJump={jumpTo}
                    messages={(() => {
                      const mine = agentMessages.filter((m) => m.from === s.id || m.to === s.id);
                      return mine.length ? { in: mine.filter((m) => m.to === s.id).length, out: mine.filter((m) => m.from === s.id).length } : undefined;
                    })()}
                    onShowMessages={() => setMsgLogFor({ id: s.id, title: titleOf(s) })}
                    onRestart={async () => {
                      const r = await window.mb.sessionRestart(s.id);
                      if (isErr(r)) alert(`Couldn't restart ${titleOf(s)}: ${r.error}`);
                      else freshTerms([s.id]);
                      refresh();
                    }}
                    resize={resize}
                  />
                );
                if (cell.kind === "session") {
                  const pane = paneFor(cell.s, false);
                  if (area)
                    return (
                      <div key={`zone-${cell.s.id}`} className="spanwrap" style={{ gridArea: area }}>
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
                const key = cell.key;
                const active = frontOf(cell, wsTabs);
                const anyWaiting = cell.list.some((s) => s.status === "waiting");
                const strip = tabDrop(active, `h:ws:${key}`);
                return (
                  <div
                    key={`ws-${key}`}
                    className={`ws-pane ${anyWaiting ? "st-waiting" : ""}`}
                    style={area ? { gridArea: area } : span > 1 ? { gridColumn: `span ${span}` } : undefined}
                  >
                    <div
                      className="ws-tabs"
                      data-drop={strip.cue}
                      onDragOver={(e) => {
                        if (!dragging("text/mb-session")) return;
                        e.stopPropagation();
                        strip.over(e);
                      }}
                      onDrop={(e) => {
                        if (!dragging("text/mb-session")) return;
                        e.preventDefault();
                        e.stopPropagation();
                        strip.drop();
                      }}
                    >
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
                          <span className="t">{titleOf(s)}</span>
                          <span
                            className="ws-x"
                            role="button"
                            aria-label={`Close ${titleOf(s)}`}
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
                    {paneFor(active, true, () => hideSessions(cell.list), cell.list.map((s) => s.id))}
                  </div>
                );
              })}
              {layout &&
                zoning?.empty.map((z) => (
                  <ZoneSlot
                    key={`slot-${z}`}
                    area={layout.zones[z]}
                    cue={cue(drag, `z:${z}`)}
                    picking={slotPick === z}
                    onPick={(open) => setSlotPick(open ? z : null)}
                    // a tab of a workspace already on screen opens in that pane, not a zone
                    minimized={workSessions.filter((s) => topOf(s) === activeGroup && !cellKeys.includes(cellKeyOfSession(s)))}
                    onOpen={(s) => {
                      setSlotPick(null);
                      setShown((p) => (p.includes(s.id) ? p : [...p, s.id]));
                      seatInZone(cellKeyOfSession(s), z);
                      setFocused(s.id);
                    }}
                    onNew={() => {
                      setSlotPick(null);
                      setPendingZone({ group: seatKey, zone: z });
                      setNewGroup(activeGroup && activeGroup !== "ungrouped" ? activeGroup : "");
                      setNewLaunch("claude");
                      setModal("new");
                    }}
                    over={(e) => {
                      const srcS = sessions.find((x) => x.id === dragging("text/mb-session"));
                      if (!srcS) return overTarget(e, null);
                      const inGrid = cellKeys.includes(cellKeyOfSession(srcS));
                      // from the sidebar, a tab of a workspace on screen belongs in that pane
                      if (inGrid && !shown.includes(srcS.id)) return overTarget(e, null);
                      overTarget(e, { key: `z:${z}`, outcome: `${inGrid ? "Put" : "Open"} ${titleOf(srcS)} here` });
                    }}
                    drop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const srcS = sessions.find((x) => x.id === e.dataTransfer.getData("text/mb-session"));
                      if (!srcS) return;
                      if (cellKeys.includes(cellKeyOfSession(srcS)) && !shown.includes(srcS.id)) return;
                      if (topOf(srcS) !== activeGroup && !pinnedSet.has(srcS.id)) {
                        // a session from another group joins this one (as a lone pane) to take the zone
                        const dest = activeGroup === "ungrouped" ? null : activeGroup;
                        moveToGroup(srcS.id, dest);
                        seatInZone(cellKeyFor(srcS.id, dest), z);
                      } else {
                        setShown((p) => (p.includes(srcS.id) ? p : [...p, srcS.id]));
                        seatInZone(cellKeyOfSession(srcS), z);
                      }
                    }}
                  />
                ))}
            </div>
          )}
          {panelOpen && (
            <BottomPanel
              states={runStates}
              active={panelTab}
              height={panelH}
              onActive={setPanelTab}
              onHide={() => setPanelOpen(false)}
              onResize={setPanelH}
            />
          )}
        </div>
        </>
        )}
        </ViewErrorBoundary>
      </div>

      <div className="statusbar">
        {agentUpdates.map((u) => (
          <button
            key={u.agent}
            className="sb-update"
            title={`${u.agent === "codex" ? "Codex" : "Claude Code"} ${u.installed} is installed; these sessions still run the version they started with:\n${u.sessions.map((x) => `  ${x.title} (${x.version})`).join("\n")}\nRestarting resumes each conversation.`}
            onClick={() => setModal("restart")}
          >
            {u.agent === "codex" ? "Codex" : "Claude Code"} {u.installed} · restart {plural(u.sessions.length, "session")}
          </button>
        ))}
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
                <Popover className="who-pop stat-pop" onClose={() => setStatusPop(null)}>
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
                      {titleOf(s)}
                      <span className="cnt">
                        {st === "waiting" && s.waitingSince
                          ? fmtElapsed(s.waitingSince)
                          : groupKeyOf(s)}
                      </span>
                    </div>
                  ))}
                  {list.length === 0 && <div className="who-row">none</div>}
                </Popover>
              )}
            </span>
          );
        })}
        <UsageMeter usage={usage} meters={meters} />
        <span className="right">
          {readError && (
            <span className="update-note bad" title={readError}>
              ✕ {readError}
              <button className="icon" title="Dismiss" onClick={() => setReadError(null)}>✕</button>
            </span>
          )}
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
                if (isErr(r)) return alert(`Couldn't install hooks: ${r.error}`);
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
          shortcuts={shortcuts}
          onClose={() => setPaletteOpen(false)}
          actions={[
            { label: "New session", kbd: "⌘N", run: () => { setNewLaunch("claude"); setModal("new"); } },
            { label: "New Codex session", run: () => { setNewLaunch("codex"); setModal("new"); } },
            { label: "New terminal (no Claude)", run: () => { setNewLaunch("shell"); setModal("new"); } },
            ...presets.map((p) => ({ label: `Start preset: ${p.name}`, run: () => startPreset(p) })),
            { label: "Restart all agent sessions", run: () => setModal("restart") },
            { label: "Agent message log — what sessions told each other", run: () => setMsgLogFor({}) },
            { label: "Weekly rollup — time per ticket and outcomes", run: () => setRollupOpen(true) },
            { label: "Setup — agents, hooks, repos, Azure DevOps", run: () => setModal("setup") },
            { label: "Sessions grid", run: () => setTab("sessions") },
            ...(shownTab("dashboard") ? [{ label: "Dashboard — ticket board", run: () => setTab("dashboard") }] : []),
            { label: "Broadcast / CLAUDE.md (control room)", kbd: "⌘⇧B", run: openControlRoom },
            { label: "Go to file…", kbd: "⌘P", run: () => { setTab("sessions"); setModal("quickopen"); } },
            { label: "Search — conversations, or the focused session's files", kbd: "⌘⇧F", run: () => showView("search") },
            { label: "Explorer — the focused session's folder", kbd: "⌘⇧E", run: () => showView("explorer") },
            { label: "Source Control — stage, commit, push", kbd: "⌃⇧G", run: () => showView("scm") },
            { label: "Run and Debug — start the focused worktree's services", kbd: "⌘⇧D", run: () => showView("run") },
            { label: "Toggle the log panel", kbd: "⌘J", run: () => (setTab("sessions"), setPanelOpen((o) => !o)) },
            { label: "Settings", run: () => setTab("settings") },
            { label: "Import sessions", run: () => setModal("import") },
            ...(shownTab("worktracker")
              ? [
                  { label: "WorkTracker — debriefs", run: () => setTab("worktracker") },
                  { label: "Morning brief", run: () => runDebrief("morning") },
                  { label: "4pm wrap-up", run: () => runDebrief("wrapUp") },
                ]
              : []),
            ...(shownTab("collaborate") ? [{ label: "Collaborate — rooms", run: () => setTab("collaborate") }] : []),
            ...(focusedSession
              ? [
                  {
                    label: `${zoomed === focusedSession.id ? "Exit fullscreen" : "Fullscreen"} ${titleOf(focusedSession)}`,
                    kbd: "⌘E",
                    run: () => setZoomed(zoomed === focusedSession.id ? null : focusedSession.id),
                  },
                  {
                    label: `Rename ${titleOf(focusedSession)}…`,
                    run: () => setRenameDlg({ kind: "session", key: focusedSession.id, initial: titleOf(focusedSession) }),
                  },
                  { label: `Change group of ${titleOf(focusedSession)}…`, run: () => setGroupDlg(focusedSession) },
                  { label: `${focusedSession.muted ? "Unmute" : "Mute"} notifications from ${titleOf(focusedSession)}`, run: () => toggleMute(focusedSession) },
                  ...(!focusedSession.shell && focusedSession.repoPath
                    ? [{ label: `Undo a turn of ${titleOf(focusedSession)} — put its files back`, run: () => setUndoFor(focusedSession) }]
                    : []),
                  ...(!focusedSession.shell
                    ? [{ label: `Continue in ${otherAgent(focusedSession.agent) === "codex" ? "Codex" : "Claude Code"} — hand ${titleOf(focusedSession)} over with a summary`, run: () => setHandoffFor(focusedSession) }]
                    : []),
                  ...(ticketOfGroup(topOf(focusedSession))
                    ? [{ label: `Ticket pipeline — #${topOf(focusedSession)}`, run: () => setPipelineFor(ticketOfGroup(topOf(focusedSession))) }]
                    : []),
                  {
                    label: `${pinnedSet.has(focusedSession.id) ? "Unpin" : "Pin"} ${titleOf(focusedSession)}${pinnedSet.has(focusedSession.id) ? "" : " — keep it on screen across groups"}`,
                    run: () => togglePin([focusedSession.id]),
                  },
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

      {presetDraft && (
        <PresetEditor
          initial={presetDraft}
          onClose={() => setPresetDraft(null)}
          onSave={async (p) => {
            await savePresets([...presets.filter((x) => x.id !== p.id), p]);
            setPresetDraft(null);
          }}
        />
      )}

      {rollupOpen && <RollupDialog onClose={() => setRollupOpen(false)} />}

      {msgLogFor && <MessageLogDialog sessionId={msgLogFor.id} title={msgLogFor.title} onJump={(id) => (setMsgLogFor(null), jumpTo(id))} onClose={() => setMsgLogFor(null)} />}

      {undoFor && (
        <UndoTurnDialog
          session={undoFor}
          onClose={() => setUndoFor(null)}
          onTellAgent={(text) => {
            const s = undoFor;
            setUndoFor(null);
            typeInto(s.id, text);
          }}
        />
      )}

      {handoffFor && (
        <HandoffDialog
          session={handoffFor}
          onClose={() => setHandoffFor(null)}
          onStarted={async (next, closeOld) => {
            const old = handoffFor;
            setHandoffFor(null);
            await refresh();
            // the old one is kept under Previous; its worktree is the new session's
            if (closeOld && !failed(`Couldn't close ${titleOf(old)}`, await window.mb.killSession(old.id, false))) {
              disposeTerm(old.id);
              setShown((p) => (p.includes(old.id) ? p.map((x) => (x === old.id ? next.id : x)) : [...p, next.id]));
              refresh();
            } else {
              setShown((p) => placeBeside(p.includes(next.id) ? p : [...p, next.id], next.id, old.id, "after"));
            }
            setFocused(next.id);
            setTimeout(() => focusTerm(next.id), 50);
          }}
        />
      )}

      {pipelineFor && (
        <PipelineDialog
          ticketId={pipelineFor.id}
          title={pipelineFor.title}
          sessions={workSessions.filter((s) => topOf(s) === pipelineFor.id)}
          onAskSession={(id, text) => {
            setPipelineFor(null);
            typeInto(id, text);
          }}
          onOpenScm={(id) => {
            setPipelineFor(null);
            openScmFor(id);
          }}
          onClose={() => setPipelineFor(null)}
        />
      )}

      {groupDlg && (
        <GroupDialog
          session={groupDlg}
          groups={groupKeys}
          onMove={(g) => moveToGroup(groupDlg.id, g)}
          onClose={() => setGroupDlg(null)}
        />
      )}

      {renameDlg && (
        <RenameDialog
          title={renameDlg.kind === "session" ? "Rename session" : renameDlg.kind === "sub" ? "Rename workspace" : renameDlg.key === "ungrouped" ? "Name this group" : "Rename group"}
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
          presets={presets}
          onStartPreset={(p) => {
            setModal(null);
            startPreset(p);
          }}
          onSavePreset={(draft) => {
            setModal(null);
            setPresetDraft(draft);
          }}
          onClose={() => setModal(null)}
          onCreated={onCreated}
        />
      )}
      {modal === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onOpened={(opened) => {
            refresh();
            const batch = opened.slice(0, 6); // rest stay in the sidebar to avoid a 26-pane grid
            if (batch.length) {
              // the grid shows the first import's group (restored sessions keep theirs); pinned panes stay
              const g = topOf(batch[0]);
              switchGrid(g, batch.filter((s) => topOf(s) === g).map((s) => s.id));
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
            freshTerms(ids);
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
          onOpenGitHub={update ? () => openLink(update.url) : undefined}
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
    <span className="sdots" title={plural(list.length, "session")}>
      {sorted.slice(0, MAX).map((s) => (
        <span key={s.id} className={`dot xs ${s.status}`} />
      ))}
      {extra > 0 && <span className="more">+{extra}</span>}
    </span>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
