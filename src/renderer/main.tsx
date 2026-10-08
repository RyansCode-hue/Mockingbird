import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TerminalPane, disposeTerm, focusTerm, applyTermTheme, type PaneDensity, type PaneResize } from "./TerminalPane";
import { EditorDock, ExplorerTree } from "./FilePanel";
import { SourceControl, type DiffSource } from "./SourceControl";
import { SearchView, type SearchState } from "./SearchView";
import { QuickOpen } from "./QuickOpen";
import { EMPTY_EDITOR, closeTab, openTab, tabKey, updateTab } from "./editorTabs";
import { useFolderRefresh } from "./folderWatch";
import { SetupWizard } from "./SetupWizard";
import { CollaborateView } from "./Collaborate";
import { UpdatePanel } from "./UpdatePanel";
import { DragLabel, beginDrag, cue, dragFrom, dragging, installDragListeners, overTarget, placeBeside, useDrag } from "./drag";
import { activeGroupOf, layoutToRemember, pruneToGroup, switchTo } from "./gridModel";
import {
  TEMPLATES,
  arrange,
  asTree,
  canResize,
  drawTree,
  dropRegion,
  equalize,
  evenGrid,
  hasLeaf,
  insertBeside,
  keysOf,
  leafAt,
  legacyTree,
  maxAcross,
  planDrop,
  readingOrder,
  reconcile,
  rects,
  remove,
  rename,
  renameWorkspaces,
  resizePane,
  sameTree,
  templateOf,
  templateTree,
  toGrid,
  worthSaving,
  type DragSource,
  type Extent,
  type Landing,
  type LayoutNode,
  type LegacyLayout,
  type Side as EdgeSide,
} from "./layoutTree";
import { GridPreview } from "./GridPreview";
import { OVERLAYS, escapeLeavesFullscreen, inEditor } from "./keys";
import { cellKeyFor, cellKeyOf, frontOf, groupChoices, inReadingOrder, sessionHolding, sessionOutline, titleOf, paneShortcuts, remapGroupKeys, remapTrees, worktreeGone, type GridCell } from "./appModel";
import { LayoutIcon, FilesIcon, FolderIcon, ChevronIcon, SessionsIcon, SourceControlIcon, SearchIcon, RunDebugIcon, PinIcon, BellIcon, BellOffIcon, UpdateIcon } from "./Icons";
import { RunView } from "./RunView";
import { Popover } from "./Popover";
import { PipelineDialog, StageChip, usePipelines } from "./TicketPipeline";
import { HandoffDialog } from "./Handoff";
import { UndoTurnDialog } from "./UndoTurn";
import { MessageLogDialog, useAgentMessages } from "./AgentMessages";
import { RollupDialog } from "./Rollup";
import { PresetEditor } from "./Presets";
import { BottomPanel } from "./BottomPanel";
import { addOutput, onStopped } from "./debugStore";
import { installTooltips } from "./tooltips";
import { dirtyKeys } from "./CodeEditor";
import { AGENT_NAME, otherAgent, isErr, sanitizeSegment, splitGroupKey, topOfKey, groupUngrouped, groupKey, isWorkItemId, ticketIdOf, UI_COMMANDS, type SessionInfo, type SessionPreset, type SessionStatus, type Settings, type WorktreeStateInfo, type UsageReport, type UpdateProgress, type UpdateOutcome, type CollabRoom, type TranscriptHit, type RunServiceState, type DebugFrame, type Meters, type LspLocation, type FileOverlap, type AgentUpdateNotice, type MessageMode, type OptionalTab } from "../shared/types";
import { openLink } from "./uiUtil";
import { type Tab, TAB_LABELS } from "./tabs";
import { CommandPalette, HelpModal } from "./Palette";
import { UsageMeter } from "./UsageMeter";
import { DashboardBoard } from "./Dashboard";
import { RenameDialog, GroupDialog, RestartAllDialog, CloseSessionDialog } from "./Dialogs";
import { SettingsView, type SettingsSection } from "./Settings";
import { ConnectedDivider, JoinRoomDialog, ShareRoomDialog, SharedBadge, roomOfGroup, useTeamStatus } from "./Team";
// team rooms: plan board
import { PlanBoardDialog, PlanWarnings } from "./team/PlanBoard";
// team rooms: team chat
import { RoomChatChip, RoomChatPanel, TeamRoomIcon, useRoomChatOpen } from "./team/RoomChat";
// team rooms: take-over
import {
  BackupFreshness,
  HandOverPrompt,
  LeftCopyLine,
  LeftCopyPanel,
  ReceivedDialog,
  ReceivedNotice,
  RoomBackupWarnings,
  TakeOverButton,
  TakeOverDialog,
  useTakeover,
} from "./team/TakeOver";
import { backupOf, type LeftCopy, type ReceivedChanges, type RoomSessionBackupView } from "../shared/team/takeover";
// team rooms: live panes
import { FollowControls, LiveProblems, RoomRowTag, isRemote, useFollow, useRoomLive } from "./team/RoomLive";
import { NewSessionModal, ImportModal, type LaunchKind } from "./NewSession";
import { roomRepoNames } from "./newSessionModel";
import { ago, fmtElapsed, plural } from "../shared/format";
import { baseName } from "../shared/paths";
import { usePersisted, readPref, writePref } from "./prefs";

type ModalKind = "new" | "import" | "help" | "restart" | "setup" | "update" | "quickopen" | null;
/** What the side bar shows, picked from the activity bar as in VS Code. */
type SideView = "sessions" | "explorer" | "scm" | "search" | "run"
  // team rooms: team chat
  | "room";
const SIDE_VIEWS: { id: SideView; label: string; keys?: string; Icon: () => React.JSX.Element }[] = [
  { id: "sessions", label: "Sessions", Icon: SessionsIcon },
  { id: "explorer", label: "Explorer", keys: "⇧⌘E", Icon: FilesIcon },
  { id: "scm", label: "Source Control", keys: "⌃⇧G", Icon: SourceControlIcon },
  { id: "search", label: "Search", keys: "⇧⌘F", Icon: SearchIcon },
  { id: "run", label: "Run and Debug", keys: "⇧⌘D", Icon: RunDebugIcon },
  // team rooms: team chat (the icon carries its own unread badge)
  { id: "room", label: "Team room", Icon: TeamRoomIcon },
];

/** Miniature of a snap layout's shape, drawn the way the snap-layout flyout shows them. */
function LayoutThumb({ tree }: { tree: LayoutNode }) {
  const g = toGrid(tree);
  return (
    <span
      className="lay-thumb"
      style={{
        gridTemplateColumns: g.cols.map((f) => `${f}fr`).join(" "),
        gridTemplateRows: g.rows.map((f) => `${f}fr`).join(" "),
      }}
    >
      {Object.values(g.areas).map((area, i) => (
        <i key={i} style={{ gridArea: area }} />
      ))}
    </span>
  );
}

/** How long a pane the main process is about to add or rekey waits for its place (see `expected` in App). */
const EXPECT_MS = 10_000;
const SIDE_WORDS: Record<EdgeSide, string> = { left: "to the left of", right: "to the right of", top: "above", bottom: "below" };
const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** The layout prefs from before split trees, read once at startup for groups that have no tree yet. */
function readLegacyLayout(): LegacyLayout {
  const cols = readPref<unknown>("mb.cols", "auto");
  return {
    templates: asRecord(readPref("mb.layout", {})),
    seats: asRecord(readPref("mb.zones", {})),
    cols: typeof cols === "number" && cols >= 1 ? cols : "auto",
    groups: Object.keys(asRecord(readPref("mb.groupLayouts", {}))),
  };
}

function App() {
  const [ownSessions, setSessions] = useState<SessionInfo[]>([]);
  const [resumable, setResumable] = useState<SessionInfo[]>([]);
  const [shown, setShown] = usePersisted<string[]>("mb.shown", []);
  const [focused, setFocused] = useState<string | null>(null);
  // team rooms: live panes — teammates' room sessions are sessions here too (session.room says whose)
  const roomLive = useRoomLive(ownSessions, shown, focused);
  const sessions = roomLive.sessions;
  // team rooms: take-over — each room session's backup, shown on its row and pane; Take over opens one dialog
  const takeoverView = useTakeover();
  const tkView = takeoverView && !isErr(takeoverView) ? takeoverView : null;
  const backupFor = (s: SessionInfo): RoomSessionBackupView | null => (tkView ? backupOf(tkView, s.room) : null);
  const [takeOverFor, setTakeOverFor] = useState<(RoomSessionBackupView & { back?: boolean }) | null>(null);
  // a copy of this Mac's that a teammate continued (stopped here), and changes a teammate sent for one of this Mac's sessions
  const leftFor = (s: SessionInfo): LeftCopy | null => (tkView && !isRemote(s) ? tkView.left.find((l) => l.sessionId === s.id) ?? null : null);
  const receivedFor = (s: SessionInfo): ReceivedChanges[] => (tkView && !isRemote(s) ? tkView.received.filter((r) => r.sessionId === s.id) : []);
  const [reviewing, setReviewing] = useState<ReceivedChanges | null>(null);
  /** Take it back: a take-over of the copy that continues it now (asking its owner first when they're connected). */
  const takeBack = (l: LeftCopy) => {
    const v = tkView && backupOf(tkView, { roomId: l.roomId, sessionId: l.now.sessionId, owner: l.now.owner });
    if (!v) return alert(`${l.now.ownerName}'s copy has no backup here yet — Take it back is offered once it has one`);
    setTakeOverFor({ ...v, back: true });
  };
  const [zoomed, setZoomed] = useState<string | null>(null);
  // pinned panes stay on screen when the grid switches groups
  const [pinned, setPinned] = usePersisted<string[]>("mb.pinned", []);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  // the group the grid was last switched to (see activeGroupOf)
  const [lastGroup, setLastGroup] = usePersisted<string | null>("mb.activeGroup", null);
  // where each pane sits, per group: a split tree (layoutTree.ts) whose leaves are cell keys
  const [trees, setTrees] = usePersisted<Record<string, LayoutNode>>("mb.trees", {});
  const [legacyLayout] = useState(readLegacyLayout);
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
  const [modal, setModal] = useState<ModalKind>(null);
  const [newLaunch, setNewLaunch] = useState<LaunchKind>("claude");
  // seeds New Session's Group field — set to "top/sub" by a workspace's + button
  const [newGroup, setNewGroup] = useState("");
  // a lone pane's "+" promotes it to a workspace, but only once the new session
  // actually exists — cancelling the dialog must leave the pane exactly as it was
  const [pendingWs, setPendingWs] = useState<{ id: string; key: string } | null>(null);
  const [tab, setTab] = usePersisted<Tab>("mb.tab", "sessions");
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
  // tabs turned off in Settings leave the top bar (and the palette); one opened
  // anyway — by a notification or a search hit — shows while it's the active tab
  const [hiddenTabs, setHiddenTabs] = useState<OptionalTab[]>([]);
  // one-click session setups (Settings → Presets), and one being saved from New session
  const [presets, setPresets] = useState<SessionPreset[]>([]);
  const [presetDraft, setPresetDraft] = useState<SessionPreset | null>(null);
  const shownTab = (t: Tab) => !(hiddenTabs as Tab[]).includes(t);
  const [theme, setTheme] = usePersisted<"dark" | "light">("mb.theme", "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyTermTheme(theme === "light"); // xterm colors follow the app theme
  }, [theme]);
  const [hooksOk, setHooksOk] = useState(true);
  const [filter, setFilter] = useState("");
  // a session title being edited inline in its sidebar row
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [sideCollapsed, setSideCollapsed] = usePersisted<boolean>("mb.side", false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readPref<string[]>("mb.collapsed", [])));
  useEffect(() => {
    writePref("mb.collapsed", [...collapsed]);
  }, [collapsed]);
  // per-group memory of which sessions were visible, so switching back restores the subset
  const [groupLayouts, setGroupLayouts] = usePersisted<Record<string, string[]>>("mb.groupLayouts", {});
  // active tab per workspace (sub-group) pane, keyed "top/sub" — persisted
  const [wsTabs, setWsTabs] = usePersisted<Record<string, string>>("mb.wsTabs", {});
  const [closeDlg, setCloseDlg] = useState<{ session: SessionInfo; wt: WorktreeStateInfo | { error: string } } | null>(null);
  const [groupDlg, setGroupDlg] = useState<SessionInfo | null>(null);
  // team rooms: which groups are shared, and the share / join dialogs
  const teamStatus = useTeamStatus();
  const teamRooms = useMemo(() => (teamStatus && !isErr(teamStatus) ? teamStatus.rooms : []), [teamStatus]);
  const [shareDlg, setShareDlg] = useState<{ key: string; title: string } | null>(null);
  const [joinDlg, setJoinDlg] = useState(false);
  // team rooms: plan board — the room whose board is open
  const [planDlg, setPlanDlg] = useState<string | null>(null);
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
        : groupKey(topOfKey(renameDlg.key), v);
    if (!next) return;
    if (renameDlg.key === "ungrouped") {
      expectRename(renameDlg.key, next);
      // "ungrouped" is the absence of a group, not a stored one: naming it groups its sessions
      for (const m of groupUngrouped(workSessions, next)) {
        if (failed("Couldn't name the group", await window.mb.setGroup(m.id, m.group))) return refresh();
      }
      await migrateGroupKeys(renameDlg.key, next);
    } else if (next !== renameDlg.key) {
      expectRename(renameDlg.key, next);
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
  const [sideView, setSideView] = usePersisted<SideView>("mb.sideView", "sessions");
  const [sideW, setSideW] = usePersisted<number>("mb.sideW", 264);
  const [editor, setEditor] = useState(EMPTY_EDITOR);
  const [search, setSearch] = useState<SearchState>(() => ({ q: "", ...readPref("mb.search", { scope: "conversations", regex: false, matchCase: false }) }));
  useEffect(() => {
    writePref("mb.search", { scope: search.scope, regex: search.regex, matchCase: search.matchCase });
  }, [search.scope, search.regex, search.matchCase]);
  const [searchFocus, setSearchFocus] = useState(0);
  // Run and Debug: every service's state, and the log panel under the grid (⌘J)
  const [runStates, setRunStates] = useState<RunServiceState[]>([]);
  useEffect(() => {
    window.mb.runStates().then(unlessError("the services' run states", setRunStates));
    return window.mb.onRunChanged(setRunStates);
  }, []);
  const [panelOpen, setPanelOpen] = usePersisted<boolean>("mb.panel.open", false);
  const [panelH, setPanelH] = usePersisted<number>("mb.panel.h", 260);
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
  // team rooms: team chat — a clicked mention notification opens the room's chat
  useRoomChatOpen(() => showView("room"));

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
  const dissolveSub = async (top: string, all: SessionInfo[]) => {
    // teammates' sessions stay in the workspace their owners put them in
    const list = all.filter((s) => !isRemote(s));
    // the first of its tabs on screen takes the workspace pane's place; it moves
    // last, so the pane is gone by the time it lands
    const first = list.find((s) => shown.includes(s.id));
    if (first) expectPane(first.id, (t) => rename(t, cellKeyOfSession(first), first.id));
    const order = first ? [...list.filter((s) => s !== first), first] : list;
    const results = await Promise.all(order.map((s) => window.mb.setGroup(s.id, top)));
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
    return isErr(live) ? ownSessions : live;
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
      if (readPref("mb.helpSeen", false)) failed("Couldn't mark setup as done", await window.mb.setSettings({ setupDone: true }));
      else {
        writePref("mb.helpSeen", true);
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
      if (cmd === UI_COMMANDS.newSession) setModal("new");
      if (cmd === UI_COMMANDS.update) setModal("update"); // the update notification was clicked
      if (cmd === UI_COMMANDS.focusSession && arg) jumpToRef.current(arg);
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
    setTrees((prev) => remapTrees(prev, oldKey, newKey));
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
   * Returns whether it moved.
   */
  const moveToGroup = async (id: string, group: string | null): Promise<boolean> => {
    if (isRemote(sessions.find((s) => s.id === id))) return false; // a teammate's: only its owner moves it
    const top = topOfKey(group ?? "ungrouped");
    const stays = !activeGroup || top === activeGroup || pinnedSet.has(id);
    if (!stays) {
      setShown((p) => p.filter((x) => x !== id));
      setGroupLayouts((p) => ({ ...p, [top]: [...(p[top] ?? []).filter((x) => x !== id), id] }));
    }
    const before = shown;
    if (failed("Couldn't move the session", await window.mb.setGroup(id, group))) {
      setShown(before);
      return false;
    }
    if (stays) {
      setShown((p) => (p.includes(id) ? p : [...p, id]));
      if (group && splitGroupKey(group).sub) setWsTabs((p) => ({ ...p, [group]: id }));
    }
    return true;
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

  // team rooms: live panes — Follow mirrors a teammate's shown room sessions and focus
  const follow = useFollow({
    views: roomLive.state?.views ?? [],
    sessions,
    shown,
    groupOf: topOf,
    show: (g, ids, f) => {
      switchGrid(g, ids);
      if (f) setFocused(f);
    },
  });

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

  // the sessions the layout holds: everything shown, even while one is fullscreen
  const layoutSessions = useMemo(
    () => shown.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s),
    [sessions, shown]
  );
  const gridSessions = useMemo(() => (zoomed ? sessions.filter((s) => s.id === zoomed) : layoutSessions), [zoomed, sessions, layoutSessions]);

  // grid cells: plain sessions render individually; a sub-group renders as ONE
  // workspace pane with tabs (cmux-style)
  const layoutCells: GridCell[] = useMemo(() => {
    const out: GridCell[] = [];
    const seen = new Set<string>();
    for (const s of layoutSessions) {
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
  }, [layoutSessions, workSessions, shown]);
  // fullscreen shows the one session on its own; leaving it returns to the layout as it was
  const cells: GridCell[] = useMemo(
    () => (zoomed ? gridSessions.map((s) => ({ kind: "session" as const, s })) : layoutCells),
    [zoomed, gridSessions, layoutCells]
  );
  const cellKeyOfSession = (s: SessionInfo) => cellKeyFor(s.id, s.taskGroup);

  // ---- the layout: a split tree per group (layoutTree.ts) says where each pane sits ----
  const seatKey = activeGroup ?? "";
  const layoutKeys = useMemo(() => layoutCells.map(cellKeyOf), [layoutCells]);
  const gridRef = useRef<HTMLDivElement>(null);
  // the grid's size, read when panes are added (the default rule splits along the longer side)
  const gridExtent = useRef<Extent>({ w: window.innerWidth, h: window.innerHeight });
  // the grid element comes and goes with the Sessions tab and with having panes at all
  const hasGrid = tab === "sessions" && gridSessions.length > 0;
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth && el.clientHeight) gridExtent.current = { w: el.clientWidth, h: el.clientHeight };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasGrid]);

  /**
   * Panes about to appear, and where each lands instead of by the default rule.
   * A session changing group changes its cell's key (joining a workspace, or
   * leaving one for a pane of its own), and the main process sends the new
   * session list — which redraws the grid — before the call that made the
   * change returns. So the place is set before the call, and applied on the
   * render where the key first appears.
   */
  const expected = useRef(new Map<string, Landing>());
  const expectPane = (key: string, place: Landing["place"]) => expected.current.set(key, { at: Date.now(), place });

  const tree = useMemo(() => {
    if (!layoutKeys.length) return null;
    const saved = asTree(trees[seatKey]) ?? legacyTree(legacyLayout, seatKey, layoutKeys, gridExtent.current);
    return drawTree(saved, layoutKeys, gridExtent.current, expected.current, Date.now(), EXPECT_MS);
  }, [trees, seatKey, layoutKeys, legacyLayout]);

  // the tree is saved as drawn, so panes added by the default rule keep their places
  useEffect(() => {
    if (!tree) return;
    for (const k of keysOf(tree)) expected.current.delete(k);
    // shown but not running: ids a relaunch brings back (by session, or by workspace)
    const awaiting = new Set(
      shown
        .filter((id) => !sessions.some((s) => s.id === id))
        .flatMap((id) => [id, cellKeyFor(id, resumable.find((r) => r.id === id)?.taskGroup)])
    );
    setTrees((p) => (worthSaving(asTree(p[seatKey]), tree, awaiting) ? { ...p, [seatKey]: tree } : p));
  }, [tree, seatKey]);

  /** Change the active group's layout, starting from the tree as drawn. */
  const commitTree = (fn: (t: LayoutNode) => LayoutNode | null) => {
    if (!tree) return;
    const next = fn(tree);
    if (next && !sameTree(next, tree)) setTrees((p) => ({ ...p, [seatKey]: next }));
  };
  /** Arrange the panes, in the order they're read, into a snap layout or N even columns. */
  const arrangeAs = (id: string) => commitTree((t) => arrange(id, readingOrder(t), gridExtent.current));
  const arrangeInCols = (n: number) => commitTree((t) => evenGrid(readingOrder(t), n));
  const refit = () => commitTree((t) => reconcile(null, readingOrder(t), gridExtent.current));

  /**
   * A group rename is about to change keys: the group's tree is copied under
   * its new name, and each workspace pane under it keeps its place when its
   * key changes (see `expected`). migrateGroupKeys tidies up once it's done.
   */
  const expectRename = (oldKey: string, newKey: string) => {
    for (const k of keysOf(tree)) {
      const nk = keysOf(renameWorkspaces({ kind: "leaf", key: k }, oldKey, newKey))[0];
      if (nk !== k) expectPane(nk, (t) => rename(t, k, nk));
    }
    setTrees((p) => {
      const from = asTree(p[oldKey]);
      return from && !splitGroupKey(oldKey).sub ? { ...p, [topOfKey(newKey)]: renameWorkspaces(from, oldKey, newKey) } : p;
    });
  };

  // pane numbers (⌘1–9, the badges, the palette's hints) follow the grid top-left first
  const orderedCells = useMemo(() => (zoomed ? cells : inReadingOrder(cells, tree)), [cells, tree, zoomed]);
  const shortcuts = useMemo(() => paneShortcuts(orderedCells, wsTabs), [orderedCells, wsTabs]);
  const layoutGrid = useMemo(() => (zoomed || !tree ? null : toGrid(tree)), [tree, zoomed]);
  const across = zoomed ? 1 : maxAcross(tree);
  // pane density follows how many panes sit side by side (design 1b); a fullscreened pane is instrumented
  const density: PaneDensity = zoomed ? "max" : across >= 4 ? "min" : across === 3 ? "std" : "max";

  /** The grid's content box in client pixels, and the pixels its tracks share (gaps taken out). */
  const gridBox = () => {
    const el = gridRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const width = r.width - px(cs.paddingLeft) - px(cs.paddingRight);
    const height = r.height - px(cs.paddingTop) - px(cs.paddingBottom);
    return {
      left: r.left + px(cs.paddingLeft),
      top: r.top + px(cs.paddingTop),
      width,
      height,
      trackW: width - px(cs.columnGap) * Math.max(0, (layoutGrid?.cols.length ?? 1) - 1),
      trackH: height - px(cs.rowGap) * Math.max(0, (layoutGrid?.rows.length ?? 1) - 1),
    };
  };

  // ---- window-style pane resizing: grab a pane's own right edge / bottom edge /
  // corner; the boundary there moves and the panes on either side trade size ----
  const startResize = (key: string, axes: ("x" | "y")[], e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = gridBox();
    if (!box || !tree) return;
    const t0 = tree;
    const group = seatKey;
    const start = { x: e.clientX, y: e.clientY };
    const min = { x: 150 / box.trackW, y: 90 / box.trackH }; // keep panes usable
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    for (const a of axes) document.body.classList.add(a === "x" ? "rz-x" : "rz-y");
    const onMove = (ev: PointerEvent) => {
      let t = t0;
      for (const a of axes) t = resizePane(t, key, a, a === "x" ? (ev.clientX - start.x) / box.trackW : (ev.clientY - start.y) / box.trackH, min);
      setTrees((p) => ({ ...p, [group]: t }));
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
  /** The resize handles a pane gets: only on edges it shares with another pane. */
  const resizeFor = (key: string): PaneResize | undefined => {
    if (zoomed || !tree) return undefined;
    const x = canResize(tree, key, "x");
    const y = canResize(tree, key, "y");
    if (!x && !y) return undefined;
    return {
      x: x ? (e) => startResize(key, ["x"], e) : undefined,
      y: y ? (e) => startResize(key, ["y"], e) : undefined,
      xy: x && y ? (e) => startResize(key, ["x", "y"], e) : undefined,
      reset: () => commitTree(equalize),
    };
  };

  // the groups shown as team rooms
  const roomGroups = useMemo(() => teamRooms.map((r) => r.groupKey), [teamRooms]);
  // sidebar structure: this Mac's top-level groups, then the rooms' under "Connected Sessions"; each with sessions bucketed by sub-group
  const outline = useMemo(() => sessionOutline(visible, roomGroups, !!filter), [visible, roomGroups, filter]);
  const groupCount = outline.filter((e) => e.kind === "group").length;

  // Workspace folders in the sidebar: explicitly opened/closed ones remember it;
  // the rest are open exactly while the workspace is in the grid.
  const [wsOpen, setWsOpen] = usePersisted<Record<string, boolean>>("mb.wsOpen", {});

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
    for (const s of workSessions) if (!isRemote(s)) c[s.status]++;
    return c;
  }, [workSessions]);

  const groupTitle = (key: string, list: SessionInfo[]): string => {
    if (key === "ungrouped" || key === "assistant") return key;
    if (!isWorkItemId(ticketIdOf(key))) return key; // custom-renamed group
    const t = list.find((s) => s.ticketTitle)?.ticketTitle;
    return `#${ticketIdOf(key)}${t ? ` ${t}` : ""}`;
  };

  // existing group keys, for move targets and the New-Session picker — a joined room's even before it has a session here
  const groupKeys = useMemo(() => groupChoices(sessions, roomGroups), [sessions, roomGroups]);

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
    if (!src || isRemote(src) || dragFrom() === "workspace" || (src.taskGroup ?? null) === group) return null; // already there, or a teammate's
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
   * pane's place and pin always carry over to the workspace.
   */
  const addAsTab = async (src: SessionInfo, target: SessionInfo, newKey?: string) => {
    if (src.id === target.id || isRemote(src)) return;
    let key = subOf(target) ? `${topOf(target)}/${subOf(target)}` : null;
    if (!key) {
      const top = topOf(target);
      key = newKey ?? `${top}/${nextSubName(top)}`;
      const wsKey = key;
      // the lone pane's place becomes the workspace's
      expectPane(`ws:${wsKey}`, (t) => rename(t, target.id, `ws:${wsKey}`));
      if (failed("Couldn't make the workspace", await window.mb.setGroup(target.id, wsKey))) {
        expected.current.delete(`ws:${wsKey}`);
        return;
      }
      if (!newKey) setRenameDlg({ kind: "sub", key: wsKey, initial: splitGroupKey(wsKey).sub ?? "" });
    }
    const wsKey = key;
    if (src.taskGroup !== wsKey && failed("Couldn't add the tab", await window.mb.setGroup(src.id, wsKey))) return;
    if (pinnedSet.has(target.id)) setPinned((p) => (p.includes(src.id) ? p : [...p, src.id]));
    setShown((p) => placeBeside(p.includes(src.id) ? p : [...p, src.id], src.id, target.id, "after"));
    setWsTabs((p) => ({ ...p, [wsKey]: src.id }));
    setFocused(src.id);
  };

  // ---- dragging sessions onto the grid ----

  /** What the dragged session is to the grid (see DragSource). */
  const dragSourceOf = (src: SessionInfo): DragSource => {
    const k = cellKeyOfSession(src);
    if (!tree || !hasLeaf(tree, k)) return { key: src.id, from: null };
    const cell = layoutCells.find((c) => cellKeyOf(c) === k);
    // a lone pane, a workspace dragged by its name, or a workspace's only tab on screen moves as the pane it is
    const sole = cell?.kind === "workspace" && cell.list.length === 1 && cell.list[0].id === src.id;
    if (k === src.id || dragFrom() === "workspace" || sole) return { key: k, from: k };
    // any other tab on screen is dragged out of its workspace
    return shown.includes(src.id) ? { key: src.id, from: null, tabOf: k } : { key: src.id, from: null };
  };

  /** A pane's name in drop outcomes and the drag preview: its session's title, or its workspace's name. */
  const paneName = (key: string): string => {
    const c = layoutCells.find((x) => cellKeyOf(x) === key);
    if (c) return c.kind === "session" ? titleOf(c.s) : c.sub;
    const s = sessions.find((x) => x.id === key);
    return s ? titleOf(s) : key;
  };

  /** The drop cue for making the dragged session a tab in `target`'s pane, if that would change anything. */
  const tabTarget = (key: string, target: SessionInfo) => {
    const src = sessions.find((x) => x.id === dragging("text/mb-session"));
    if (!src || isRemote(src) || src.id === target.id || dragFrom() === "workspace") return null;
    const ws = subOf(target) ? `${topOf(target)}/${subOf(target)}` : null;
    if (ws && src.taskGroup === ws && shown.includes(src.id)) return null; // already a tab here
    // the layout once it's a tab: a pane of its own on screen closes
    const from = dragSourceOf(src).from;
    const after = from ? remove(tree, from) : tree;
    return {
      key,
      outcome: ws ? `Open ${titleOf(src)} as a tab in ${subOf(target)}` : `Open ${titleOf(src)} as a tab with ${titleOf(target)}`,
      preview: after ? { tree: after, hot: cellKeyOfSession(target) } : undefined,
    };
  };

  /**
   * What dropping the dragged session on a pane's body would do, from where
   * the pointer is in the layout: an edge splits that pane for it, the center
   * swaps panes or makes it a tab (planDrop). Null where a drop changes nothing.
   */
  const gridDropAt = (e: React.DragEvent) => {
    const src = sessions.find((x) => x.id === dragging("text/mb-session"));
    const box = gridBox();
    if (!src || !box || !tree || zoomed) return null;
    const p = { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
    const target = leafAt(tree, p);
    if (!target) return null;
    const source = dragSourceOf(src);
    const plan = planDrop(tree, source, target, dropRegion(rects(tree)[target], p));
    if (!plan) return null;
    if (plan.kind === "tab") {
      const c = layoutCells.find((x) => cellKeyOf(x) === target);
      const front = c && frontOf(c, wsTabs);
      const cue = front && tabTarget(`grid:tab:${target}`, front);
      return front && cue ? { plan, src, source, front, cue } : null;
    }
    const name = dragFrom() === "workspace" ? paneName(source.key) : titleOf(src);
    const outcome = plan.kind === "swap" ? `Swap ${name} and ${paneName(target)}` : `Put ${name} ${SIDE_WORDS[plan.side]} ${paneName(target)}`;
    const cue = { key: `grid:${plan.kind}:${target}:${plan.kind === "split" ? plan.side : ""}`, outcome, preview: { tree: plan.tree, hot: plan.key } };
    return { plan, src, source, front: null, cue };
  };

  /** One handler for the whole grid: panes' headers take tab drops themselves, and files dropped on a pane go to its terminal. */
  const overGrid = (e: React.DragEvent) => {
    if (!dragging("text/mb-session")) return;
    overTarget(e, gridDropAt(e)?.cue ?? null);
  };
  const dropOnGrid = async (e: React.DragEvent) => {
    if (!dragging("text/mb-session")) return;
    e.preventDefault();
    const at = gridDropAt(e);
    if (!at) return;
    const { plan, src } = at;
    setFocused(src.id);
    if (plan.kind === "tab") return void (at.front && addAsTab(src, at.front));
    if (at.source.from) return commitTree(() => plan.tree); // a pane on screen moves, or two swap
    if (plan.kind !== "split") return;
    // a session that isn't a pane of its own yet lands beside the target once it is one
    const { target, side } = plan;
    expectPane(src.id, (t) => t && insertBeside(t, target, side, src.id));
    // it joins the group on screen (a pinned visitor keeps its own), leaving any workspace
    const top = pinnedSet.has(src.id) ? topOf(src) : activeGroup ?? topOf(src);
    const dest = top === "ungrouped" ? null : top;
    if ((src.taskGroup ?? null) === dest) setShown((p) => (p.includes(src.id) ? p : [...p, src.id]));
    else if (!(await moveToGroup(src.id, dest))) expected.current.delete(src.id);
  };

  // While a session is dragged over the grid, the preview shows the layout the
  // drop would leave — or the one on screen, where a drop changes nothing.
  const sessionDrag = drag?.type === "text/mb-session" ? drag : null;
  const gridRect = sessionDrag && !zoomed ? gridRef.current?.getBoundingClientRect() : undefined;
  const previewOn =
    !!sessionDrag && !!gridRect && sessionDrag.x >= gridRect.left && sessionDrag.x <= gridRect.right && sessionDrag.y >= gridRect.top && sessionDrag.y <= gridRect.bottom;
  const dragged = sessionDrag ? sessions.find((s) => s.id === sessionDrag.payload) : undefined;
  const preview = sessionDrag?.target?.preview ?? { tree, hot: dragged ? dragSourceOf(dragged).from : null };

  const restoreAll = async () => {
    const failures: string[] = [];
    // team rooms: a copy a teammate continued doesn't run again (Take it back continues theirs)
    for (const s of resumable.filter((x) => !roomLive.state?.own[x.id]?.takenOver)) {
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
    // team rooms: a teammate continues it, so this copy doesn't run again (its pane stays until it's closed)
    if (s.room?.takenOver) return alert(`${s.room.takenOver.byName} continues ${titleOf(s)} on their laptop — take it back rather than resuming this copy.`);
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
      .filter((s) => s.status === "waiting" && !isRemote(s))
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
      arrangeInCols(parseInt(e.key, 10));
      return;
    }
    if (cmd && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
      // by CELL, not by session: a workspace pane holding 3 sessions is one
      // number, which is what the pane's own ⌘n badge shows
      const cell = orderedCells[parseInt(e.key, 10) - 1];
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

  // what New session was opened for (a pane's "+", a workspace's tab strip, a
  // launch kind) lasts only while it's open, however it closes
  useEffect(() => {
    if (modal === "new") return;
    setPendingWs(null);
    setNewGroup("");
    setNewLaunch("claude");
  }, [modal]);

  const onCreated = async (s: SessionInfo) => {
    // the lone pane joins its new workspace — unless the dialog put the session elsewhere
    const lone = pendingWs && s.taskGroup === pendingWs.key ? sessions.find((x) => x.id === pendingWs.id) : undefined;
    if (lone && pendingWs) await addAsTab(s, lone, pendingWs.key);
    refresh();
    jumpToSession(s);
    setModal(null);
  };

  /** New session seeded with group `key` (a group or "top/sub" workspace path; "ungrouped" seeds none). */
  const newSessionIn = (key: string) => {
    setNewGroup(key === "ungrouped" ? "" : key);
    setNewLaunch("claude");
    setModal("new");
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

  // a teammate's session has no folder here: the file views and session commands are for this Mac's sessions
  const focusedSession = sessions.find((s) => s.id === focused && !isRemote(s)) ?? null;

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
    if (!g || !isWorkItemId(g)) return null;
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
                    {TEMPLATES.map((l) => (
                      <button
                        key={l.id}
                        className={`lay-opt ${templateOf(tree) === l.id ? "on" : ""}`}
                        title={`${l.label} — arranges the panes on screen in this shape`}
                        onClick={() => {
                          arrangeAs(l.id);
                          setLayoutOpen(false);
                        }}
                      >
                        <LayoutThumb tree={templateTree(l)} />
                      </button>
                    ))}
                  </div>
                  <button
                    className="lay-auto"
                    onClick={() => {
                      refit();
                      setLayoutOpen(false);
                    }}
                  >
                    Auto — fit panes to the window
                  </button>
                  <div className="lay-note">
                    Drag a session onto a pane's edge to split it there, onto its middle to swap places or open it as a tab. Drag any pane edge to fine-tune; double-click it to even out.
                  </div>
                </Popover>
              )}
            </span>
            <button className="outline" onClick={() => setModal("import")}>Import</button>
          </>
        )}
        <button className="primary" onClick={() => setModal("new")}>
          New/Import Session <span className="kbd">⌘N</span>
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
            sessions={ownSessions /* team rooms: live panes — broadcasts reach this Mac's sessions */}
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
                        agent: otherAgent(focusedSession.agent),
                        start: async () => {
                          const author = focusedSession;
                          const info = await window.mb.reviewStart(author.id);
                          if (isErr(info)) return `Couldn't start the review: ${info.error}`;
                          await refresh();
                          // the reviewer opens beside the session it's reviewing
                          const reviewer = cellKeyFor(info.id, info.taskGroup);
                          expectPane(reviewer, (t) => t && insertBeside(t, cellKeyOfSession(author), "right", reviewer));
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
          {/* team rooms: team chat */}
          {sideView === "room" && <RoomChatPanel status={teamStatus} activeGroup={activeGroup} visible={!sideCollapsed} onNewSession={newSessionIn} onJoinRoom={() => setJoinDlg(true)} />}
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
            {/* team rooms: live panes */}
            <LiveProblems state={roomLive.state} />
            {outline.map((entry) => {
              if (entry.kind === "connected") return <ConnectedDivider key="connected" status={teamStatus} />;
              const { key, list, shared } = entry;
              return (
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
                    {(() => {
                      const room = roomOfGroup(teamStatus, key);
                      return room ? <SharedBadge room={room} /> : null;
                    })()}
                    {/* team rooms: plan board */}
                    {roomOfGroup(teamStatus, key) && (
                      <button
                        className="glbtn"
                        title="Plan board — work packages, who has what, and the files each owns"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelClick();
                          setPlanDlg(roomOfGroup(teamStatus, key)!.id);
                        }}
                      >
                        ▦
                      </button>
                    )}
                    {key !== "ungrouped" && key !== "assistant" && (
                      <button
                        className="glbtn"
                        title={roomOfGroup(teamStatus, key) ? "Invite a teammate to this shared room" : "Share this group as a team room"}
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelClick();
                          setShareDlg({ key, title: groupTitle(key, list) });
                        }}
                      >
                        ⇪
                      </button>
                    )}
                    {key !== "assistant" && (
                      <button
                        className="glbtn"
                        title={
                          key === "ungrouped"
                            ? "New session (no group)"
                            : shared
                              ? `New connected session in ${groupTitle(key, list)} — teammates see it`
                              : `New session in ${groupTitle(key, list)}`
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelClick();
                          newSessionIn(key);
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>
                )}
                {/* team rooms: take-over — what the session rows don't show (backups that failed outright or weren't deleted) */}
                {!collapsed.has(key) && (() => {
                  const room = roomOfGroup(teamStatus, key);
                  return room ? <RoomBackupWarnings room={room} view={takeoverView} /> : null;
                })()}
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
                            if (!isRemote(s)) setEditing({ key: s.id, value: titleOf(s) });
                          }}
                        >
                          <span className="nm">{titleOf(s)}</span>
                          {(s.branch || s.agent === "codex") && (
                            <span className="br">
                              {s.agent === "codex" ? "codex · " : ""}
                              {s.branch && s.branch !== titleOf(s) ? s.branch : (s.repoPath ? baseName(s.repoPath) : "")}
                            </span>
                          )}
                          {/* team rooms: take-over — how fresh this room session's backup is; or, continued by a teammate, what's left of this copy */}
                          {(() => {
                            const l = leftFor(s);
                            if (l) return <LeftCopyLine left={l} onTakeBack={() => takeBack(l)} />;
                            const b = backupFor(s);
                            return b && <span className="br fresh"><BackupFreshness view={b} /></span>;
                          })()}
                          <ReceivedNotice received={receivedFor(s)} onReview={setReviewing} compact />
                        </span>
                      )}
                      {/* team rooms: live panes — whose session it is, who's looking; a teammate's is theirs to rename, move or close */}
                      <RoomRowTag s={s} />
                      {(() => {
                        const b = isRemote(s) ? backupFor(s) : null;
                        return b && <TakeOverButton view={b} onOpen={setTakeOverFor} asking={tkView?.asking.find((a) => a.roomId === b.roomId && a.sessionId === b.sessionId)} />;
                      })()}
                      {!isRemote(s) && (
                      <button
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing({ key: s.id, value: titleOf(s) });
                        }}
                      >
                        ✎
                      </button>
                      )}
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
                      {!isRemote(s) && (
                      <>
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
                      </>
                      )}
                    </div>
                  );
                })}
                  </div>
                  );
                })}
              </div>
              );
            })}

            {resumable.length > 0 && (
              <>
                <h2>
                  <span>Previous</span>
                  <button className="icon" title="Relaunch every previous session, resuming its conversation" onClick={restoreAll}>
                    ↺ restore all
                  </button>
                </h2>
                {resumable.map((s) => {
                  // team rooms: a teammate continued it, so this copy doesn't run again — it can be taken back instead
                  const taken = roomLive.state?.own[s.id]?.takenOver;
                  const left = leftFor(s);
                  return (
                  <div key={s.id} className="sess-item" title={taken ? `${s.cwd} — ${taken.byName} continued this session on their laptop, so this copy doesn't run again here.` : s.cwd}>
                    <span className="dot dead" />
                    <span className="name">
                      <span className="nm">{s.title}</span>
                      {left ? <LeftCopyLine left={left} onTakeBack={() => takeBack(left)} /> : taken && <span className="br tk-fresh muted">continued on {taken.byName}'s laptop {ago(taken.at)}</span>}
                    </span>
                    {!taken && (
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
                    )}
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
                  );
                })}
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
                {/* team rooms: team chat */}
                {(() => {
                  const room = roomOfGroup(teamStatus, activeGroup);
                  return room ? <RoomChatChip room={room} onOpen={() => showView("room")} /> : null;
                })()}
                {/* team rooms: live panes */}
                <FollowControls follow={follow} />
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
              className={`grid ${sliding ? "slide-in" : ""} ${previewOn ? "previewing" : ""}`}
              ref={gridRef}
              style={{
                gridTemplateColumns: (layoutGrid?.cols ?? [1]).map((f) => `minmax(0, ${f}fr)`).join(" "),
                gridTemplateRows: (layoutGrid?.rows ?? [1]).map((f) => `minmax(0, ${f}fr)`).join(" "),
              }}
              onDragOver={overGrid}
              onDrop={dropOnGrid}
            >
              {cells.map((cell) => {
                // panes stay in `shown` order as the grid's children, each placed by
                // its area, so a layout change moves them without remounting any
                const myKey = cellKeyOf(cell);
                const area = layoutGrid?.areas[myKey];
                const i = orderedCells.indexOf(cell);
                const resize = resizeFor(myKey);
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
                    area={embedded ? undefined : area}
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
                    tabDrop={embedded ? undefined : tabDrop(s, `h:${s.id}`)}
                    pinned={isPinned(pinIds)}
                    onPin={zoomed ? undefined : () => togglePin(pinIds)}
                    pinNote={visitor(s)}
                    onResume={() => resumeDead(s)}
                    onCleanup={() => requestClose(s)}
                    onHandoff={s.shell ? undefined : () => setHandoffFor(s)}
                    onUndoTurn={s.shell || !s.repoPath || isRemote(s) ? undefined : () => setUndoFor(s)}
                    overlaps={overlaps[s.id]}
                    onJump={jumpTo}
                    onOpenPlan={setPlanDlg}
                    backup={backupFor(s)}
                    onTakeOver={setTakeOverFor}
                    leftCopy={(() => {
                      const l = leftFor(s);
                      return l && <LeftCopyPanel left={l} onTakeBack={() => takeBack(l)} onClose={() => requestClose(s)} />;
                    })()}
                    teamNotice={<ReceivedNotice received={receivedFor(s)} onReview={setReviewing} />}
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
                if (cell.kind === "session") return paneFor(cell.s, false);
                // workspace pane: one cell, session tabs across the top (cmux-style)
                const key = cell.key;
                const active = frontOf(cell, wsTabs);
                const anyWaiting = cell.list.some((s) => s.status === "waiting");
                const strip = tabDrop(active, `h:ws:${key}`);
                return (
                  <div key={`ws-${key}`} className={`ws-pane ${anyWaiting ? "st-waiting" : ""}`} style={area ? { gridArea: area } : undefined}>
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
                        title="drag to move this workspace's pane · double-click to rename it"
                        draggable
                        onDragStart={(e) => beginDrag(e, "text/mb-session", active.id, `Moving ${cell.sub}`, "workspace")}
                        onDoubleClick={() => setRenameDlg({ kind: "sub", key, initial: cell.sub })}
                      >
                        {cell.sub}
                      </span>
                      {cell.list.map((s) => (
                        <button
                          key={s.id}
                          className={`ws-tab ${active.id === s.id ? "on" : ""}`}
                          title="drag onto the grid to give it a pane of its own, or onto another pane to make it a tab there"
                          draggable
                          onDragStart={(e) => beginDrag(e, "text/mb-session", s.id, `Moving ${titleOf(s)}`, "tab")}
                          onClick={() => {
                            setWsTabs((p) => ({ ...p, [key]: s.id }));
                            setFocused(s.id);
                            setTimeout(() => focusTerm(s.id), 50);
                          }}
                        >
                          <span className={`dot sm ${s.status}`} />
                          <span className="t">{titleOf(s)}</span>
                          {/* a teammate's session is theirs to close */}
                          {!isRemote(s) && (
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
                          )}
                        </button>
                      ))}
                      <button
                        className="ws-add"
                        title={`New tab in “${cell.sub}”`}
                        onClick={() => newSessionIn(key)}
                      >
                        +
                      </button>
                    </div>
                    {paneFor(active, true, () => hideSessions(cell.list), cell.list.map((s) => s.id))}
                  </div>
                );
              })}
              <GridPreview on={previewOn} tree={preview.tree} hot={preview.hot} title={paneName} />
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
            title={`${AGENT_NAME[u.agent]} ${u.installed} is installed; these sessions still run the version they started with:\n${u.sessions.map((x) => `  ${x.title} (${x.version})`).join("\n")}\nRestarting resumes each conversation.`}
            onClick={() => setModal("restart")}
          >
            {AGENT_NAME[u.agent]} {u.installed} · restart {plural(u.sessions.length, "session")}
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
              className={`update-link ${upd.state === "failed" ? "bad" : ""} ${upd.state === "preparing" || upd.state === "installing" ? "busy" : ""}`}
              title="Update Mockingbird from your clone — it builds while you work and restarts when you say"
              onClick={() => setModal("update")}
            >
              <UpdateIcon />
              {upd.state === "preparing"
                ? `building${update?.latest ? ` v${update.latest}` : ""}…`
                : upd.state === "ready"
                  ? `restart to update to v${upd.version}`
                  : upd.state === "failed"
                    ? "update failed"
                    : upd.state === "installing"
                      ? "restarting…"
                      : `v${update!.latest} available`}
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
          {(() => {
            const theirs = workSessions.filter(isRemote).length;
            return <span>{workSessions.length - theirs} sessions{theirs ? ` (+${theirs} teammates')` : ""} · {groupCount} groups</span>;
          })()}
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
            { label: "Join a team room — paste a teammate's code", run: () => setJoinDlg(true) },
            // team rooms: live panes
            ...(follow.leader
              ? [{ label: `Stop following ${follow.leader.name}`, run: follow.stop }]
              : follow.candidates.map((v) => ({ label: `Follow ${v.name} — mirror the shared sessions they show`, run: () => follow.follow(v.member) }))),
            ...(activeGroup && activeGroup !== "ungrouped" && activeGroup !== "assistant"
              ? [
                  {
                    label: roomOfGroup(teamStatus, activeGroup) ? `Invite a teammate to ${groupTitle(activeGroup, workSessions.filter((s) => topOf(s) === activeGroup))}` : `Share ${groupTitle(activeGroup, workSessions.filter((s) => topOf(s) === activeGroup))} as a team room`,
                    run: () => setShareDlg({ key: activeGroup, title: groupTitle(activeGroup, workSessions.filter((s) => topOf(s) === activeGroup)) }),
                  },
                ]
              : []),
            // team rooms: plan board
            ...(activeGroup && roomOfGroup(teamStatus, activeGroup)
              ? [{ label: `Plan board — ${groupTitle(activeGroup, workSessions.filter((s) => topOf(s) === activeGroup))}`, run: () => setPlanDlg(roomOfGroup(teamStatus, activeGroup)!.id) }]
              : []),
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
                    ? [{ label: `Continue in ${AGENT_NAME[otherAgent(focusedSession.agent)]} — hand ${titleOf(focusedSession)} over with a summary`, run: () => setHandoffFor(focusedSession) }]
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
            ...[1, 2, 3, 4].map((n) => ({ label: `Arrange in ${plural(n, "column")}`, kbd: `⌘⌃${n}`, run: () => arrangeInCols(n) })),
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
            const [oldKey, nextKey] = [cellKeyOfSession(old), cellKeyFor(next.id, next.taskGroup)];
            // the old one is kept under Previous; its worktree is the new session's
            if (closeOld && !failed(`Couldn't close ${titleOf(old)}`, await window.mb.killSession(old.id, false))) {
              disposeTerm(old.id);
              expectPane(nextKey, (t) => rename(t, oldKey, nextKey)); // the new session takes the old one's place
              setShown((p) => (p.includes(old.id) ? p.map((x) => (x === old.id ? next.id : x)) : [...p, next.id]));
              refresh();
            } else {
              expectPane(nextKey, (t) => t && insertBeside(t, oldKey, "right", nextKey));
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
          sessions={workSessions.filter((s) => topOf(s) === pipelineFor.id && !isRemote(s))}
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
          onMove={async (g) => void (await moveToGroup(groupDlg.id, g))}
          onClose={() => setGroupDlg(null)}
        />
      )}

      {shareDlg && <ShareRoomDialog groupKey={shareDlg.key} title={shareDlg.title} onClose={() => setShareDlg(null)} />}
      {joinDlg && <JoinRoomDialog onClose={() => setJoinDlg(false)} />}
      {/* team rooms: plan board */}
      {planDlg && <PlanBoardDialog roomId={planDlg} onClose={() => setPlanDlg(null)} />}
      {takeOverFor && (
        <TakeOverDialog
          view={takeOverFor}
          takeBack={takeOverFor.back}
          asking={tkView?.asking.find((a) => a.roomId === takeOverFor.roomId && a.sessionId === takeOverFor.sessionId) ?? null}
          onClose={() => setTakeOverFor(null)}
        />
      )}
      {/* team rooms: a teammate asks to continue one of this Mac's sessions — one prompt at a time, oldest first */}
      {tkView?.asks[0] && <HandOverPrompt key={tkView.asks[0].askId} ask={tkView.asks[0]} onShow={jumpTo} />}
      {reviewing && <ReceivedDialog received={tkView?.received.find((r) => r.id === reviewing.id) ?? reviewing} onClose={() => setReviewing(null)} />}
      <PlanWarnings onJump={jumpTo} onOpenBoard={setPlanDlg} />

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
          rooms={teamRooms}
          roomRepos={roomRepoNames(sessions, teamRooms)}
          signalingUrl={teamStatus && !isErr(teamStatus) ? teamStatus.signalingUrl : undefined}
          onJoinRoom={() => {
            setModal(null);
            setJoinDlg(true);
          }}
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
          sessions={ownSessions /* team rooms: live panes — teammates' sessions restart on their Mockingbirds */}
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
