import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TerminalPane, agentPanelOf, disposeTerm, focusTerm, followOwners, applyTermTheme, hideAgentPanel, resyncTerm, type PaneDensity, type PaneResize } from "./TerminalPane";
import { EditorDock, ExplorerTree } from "./FilePanel";
import { SourceControl, type DiffSource } from "./SourceControl";
import { SearchView, type SearchState } from "./SearchView";
import { QuickOpen } from "./QuickOpen";
import { EMPTY_EDITOR, closeTab, openTab, tabKey, updateTab } from "./editorTabs";
import { useFolderRefresh } from "./folderWatch";
import { SetupWizard } from "./SetupWizard";
import { CouncilView } from "./Council";
import { UpdatePanel } from "./UpdatePanel";
import { WhatsNew } from "./WhatsNew";
import { LAST_SEEN_KEY, justUpdated, seenNow } from "./whatsNewModel";
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
import { resumeExited } from "./resumeFlow";
import { OVERLAYS, escapeLeavesFullscreen, inEditor } from "./keys";
import { cellKeyFor, cellKeyOf, closeStep, closeWaits, frontOf, groupChoices, inReadingOrder, queueClose, sessionHolding, sessionOutline, titleOf, paneShortcuts, remapGroupKeys, remapTrees, worktreeGone, type GridCell } from "./appModel";
import { LayoutIcon, FilesIcon, FolderIcon, ChevronIcon, SessionsIcon, SourceControlIcon, SearchIcon, RunDebugIcon, PinIcon, BellIcon, BellOffIcon, UpdateIcon, MinusIcon, GridIcon, PencilIcon, MoveIcon, CloseIcon, PlusIcon, NoteIcon } from "./Icons";
import { ActionBar, pickActions, tidyMenu, useContextMenu, type Action, type MenuEntry } from "./ContextMenu";
import { RunView } from "./RunView";
import { Popover } from "./Popover";
import { PipelineDialog, usePipelines } from "./TicketPipeline";
import { HandoffDialog } from "./Handoff";
import { BriefDialog, ContextWarning, useCostGate } from "./ContextWarning";
import { UndoTurnDialog } from "./UndoTurn";
import { MessageLogDialog, useAgentMessages } from "./AgentMessages";
import { RollupDialog } from "./Rollup";
import { PresetEditor } from "./Presets";
import { BottomPanel } from "./BottomPanel";
import { addOutput, onStopped } from "./debugStore";
import { installTooltips } from "./tooltips";
import { dirtyKeys } from "./CodeEditor";
import { AGENT_NAME, otherAgent, isErr, sanitizeSegment, splitGroupKey, topOfKey, groupUngrouped, groupKey, isWorkItemId, ticketIdOf, UI_COMMANDS, type LabsFlags, type SessionInfo, type SessionPreset, type SessionStatus, type Settings, type WorktreeStateInfo, type UsageReport, type UpdateProgress, type UpdateOutcome, type CollabRoom, type TranscriptHit, type RunServiceState, type DebugFrame, type Meters, type LspLocation, type FileOverlap, type AgentUpdateNotice, type MessageMode, type OptionalTab } from "../shared/types";
import { openLink } from "./uiUtil";
import { type Tab, TAB_LABELS } from "./tabs";
import { CommandPalette, HelpModal } from "./Palette";
import { UsageMeter } from "./UsageMeter";
import { DashboardBoard } from "./Dashboard";
import { RenameDialog, GroupDialog, RestartAllDialog, CloseSessionDialog, CloseManyDialog } from "./Dialogs";
import { SettingsView, type SettingsSection } from "./Settings";
import { ConnectedLine, JoinRoomDialog, MemberDialogs, ShareRoomDialog, roomOfGroup, useTeamStatus, type MemberDialog } from "./Team";
import { adminRequests, JoinRequestPrompt } from "./team/JoinRequests";
// team rooms: the Radley House board
import { HouseBoardDialog, HouseWarnings } from "./team/HouseBoard";
// team rooms: team chat
import { RoomChat, RoomChatPanel, TeamRoomIcon, openTeamView, useRoomChatOpen, type TeamViewHooks } from "./team/RoomChat";
import { connectedSummary, firstName, listNames, roomRowLine } from "./team/connectedModel";
// team rooms: take-over
import {
  BackupFreshness,
  HandOverPrompt,
  LeftCopyLine,
  LeftCopyPanel,
  ReceivedDialog,
  ReceivedNotice,
  RoomBackupWarnings,
  TakeOverDialog,
  leftCopyActions,
  receivedActions,
  takeOverAction,
  useTakeover,
} from "./team/TakeOver";
import { ArtifactCardFace, ArtifactCardGone, ArtifactsCount, ArtifactsWindow, ShareAreaArtifacts, shelfOfArea, type ShelfInfo } from "./team/Artifacts";
import { artifactRef } from "../shared/team/artifacts";
import { backupOf, type LeftCopy, type ReceivedChanges, type RoomSessionBackupView } from "../shared/team/takeover";
import { BackupConsentPrompt } from "./team/RoomBackups";
// team rooms: live panes
import { FollowingNow, LiveProblems, isRemote, useFollow, useRoomLive } from "./team/RoomLive";
import { followIn } from "./team/roomLiveModel";
import { NewSessionModal, ImportModal, type LaunchKind } from "./NewSession";
import { roomRepoNames } from "./newSessionModel";
import { ago, fmtElapsed, plural } from "../shared/format";
import { baseName } from "../shared/paths";
import { usePersisted, readPref, writePref } from "./prefs";
import { D, EASE, initMotion, motion, play, useFlipRows } from "./motion";
import { StatusDot } from "./StatusDot";
import { LID_MS, flyTarget, gridChange, gulp, rectOf, switchDir, type FlyTo } from "./gridMotion";
// the landscape (Settings → Labs)
import { FOCUS_MAX_FONT, Landscape, LandscapeBanners, type AreaHooks, type MovesFailed } from "./Landscape";
import { useLandscape, useLandscapeMigration } from "./useLandscape";
import { accentOf, accentsOf, areaCounts, areaSelectionNow, areaSummary, cardShelf, cardsAfterShare, mentionTarget, newExtraId, planOpenWindow, planPlaceCard, planResizeTile, presetFor, readProblem, renameSettled, resolveLayout, sameScope, selectionFor, tileSize, type CardView, type GroupMove, type PendingRename, type PlaceHint, type Tile, type ToolScope, type WindowView } from "./landscapeModel";
import { LANDSCAPE_FONT, LOOSE_GROUP, areaKeyOf, isWorkspaceTool, own, type LandscapePatch, type Rect, type Size, type SizePreset, type ToolKind, type ToolWindow as ToolWindowRecord } from "../shared/landscape";
import { actionOf, areaActions as areaModel, artifactsOf, createActions, menuOf, paneRow, takenOverWhy, workspaceActions, type ModelAction, type WorkspaceEnv } from "./workspaceActions";
import { TOOL_NAME, ToolWindow } from "./ToolWindow";
import type { WorkspaceChrome } from "./WorkspaceNode";
import { AreaHeader, GroupBar, stageChip, type GroupBarProps } from "./GroupBar";
import { AreaTree, treeCounts, treeOf, type TreeArea } from "./AreaTree";
import { MembersMenu } from "./team/MembersMenu";
import { settled } from "./settled";

initMotion();

type ModalKind = "new" | "import" | "help" | "restart" | "setup" | "update" | "quickopen" | null;
/** What the side bar shows, picked from the activity bar as in VS Code. */
type SideView = "sessions" | "explorer" | "scm" | "search" | "run"
  // team rooms: team chat
  | "room";
/** The landscape's rail adds Artifacts, a tool window of the selected workspace's area (docs/landscape.md, Tools). */
const ARTIFACTS_VIEW = { id: "artifacts" as const, label: "Artifacts", keys: undefined as string | undefined, Icon: NoteIcon };
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

/** The Labs landscape flag as this window last read it from settings: only a first-paint hint, settings decide. */
const LABS_LANDSCAPE_PREF = "mb.labs.landscape";

/** How long a pane the main process is about to add or rekey waits for its place (see `expected` in App). */
const EXPECT_MS = 10_000;
/** How long a right-click's place waits, once its session is made, for the session to reach the landscape. */
const PLACE_HINT_MS = 10_000;
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
  // which session lists have been read at least once (the landscape reads the grid's layout in only once they have)
  const [listsLoaded, setListsLoaded] = useState({ live: false, resumable: false });
  const listLoaded = (which: "live" | "resumable") => setListsLoaded((p) => (p[which] ? p : { ...p, [which]: true }));
  const [shown, setShown] = usePersisted<string[]>("mb.shown", []);
  const [focused, setFocused] = useState<string | null>(null);
  // Settings → Labs. Until settings are read, the flag as this window last saw it, so the Sessions tab doesn't
  // draw the grid only to swap it for the landscape (each fitting every terminal) a moment later
  const [labs, setLabsNow] = useState<LabsFlags>(() => ({ landscape: readPref<unknown>(LABS_LANDSCAPE_PREF, false) === true }));
  const setLabs = (next: LabsFlags) => {
    setLabsNow(next);
    // kept only once it differs from the default, so a window that never turns it on stores nothing new
    if ((readPref<unknown>(LABS_LANDSCAPE_PREF, false) === true) !== (next.landscape === true)) writePref(LABS_LANDSCAPE_PREF, next.landscape === true);
  };
  const landscapeOn = labs.landscape === true;
  // the sessions on the landscape's screen (Landscape's onSeen): what teammates stream here while it shows, as the
  // grid's panes are without it
  const [lsSeen, setLsSeen] = useState<string[]>([]);
  const onLsSeen = useCallback((ids: string[]) => setLsSeen((p) => (p.join("\n") === ids.join("\n") ? p : ids)), []);
  // team rooms: live panes — teammates' room sessions are sessions here too (session.room says whose)
  const roomLive = useRoomLive(ownSessions, landscapeOn ? lsSeen : shown, focused);
  const sessions = roomLive.sessions;
  useEffect(() => followOwners(sessions), [sessions]);
  // team rooms: take-over — each room session's backup, shown on its row and pane; Take over opens one dialog
  const takeoverView = useTakeover();
  const tkView = takeoverView && !isErr(takeoverView) ? takeoverView : null;
  const backupFor = (s: SessionInfo): RoomSessionBackupView | null => (tkView ? backupOf(tkView, s.room) : null);
  /** When this Mac took over the teammate's session that `s` continues, if it does. */
  const tookOverAt = (s: SessionInfo): number | null => tkView?.sessions.find((v) => v.takenOver?.newSessionId === s.id)?.takenOver?.at ?? null;
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
  // context warnings: a fresh session from a brief, and asking before an expensive resume
  const [briefFor, setBriefFor] = useState<SessionInfo | null>(null);
  const costGate = useCostGate();
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
  // and, from a right-click on the landscape, its repo and base (the area's), its ticket picker or its Import
  const [newSeed, setNewSeed] = useState<{ repo?: string; base?: string | null; ticket?: boolean; mode?: "new" | "import" }>({});
  // the landscape's selection besides the selected session: an area selected as a whole (the selection bar's)
  const [selArea, setSelArea] = useState<string | null>(null);
  // where the workspace a right-click's New workspace makes goes (resolveLayout); `took` names the session placed
  // there, and it's let go once that session's place is saved, or `until` passes without one
  const [placeHint, setPlaceHint] = useState<(PlaceHint & { created?: boolean; took?: string; until?: number }) | null>(null);
  // several workspaces' Close…: asked once (closeMany), then each closed as its own Close would, one dialog at a time
  const [closeMany, setCloseMany] = useState<SessionInfo[] | null>(null);
  const [closeQueue, setCloseQueue] = useState<string[]>([]);
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
  // the side bar's width snaps (the grid re-fits once); shown again, its contents slide in from the rail
  const sideInner = useRef<HTMLDivElement>(null);
  const sideWasCollapsed = useRef(sideCollapsed);
  useLayoutEffect(() => {
    if (sideWasCollapsed.current && !sideCollapsed && sideInner.current)
      play(sideInner.current, [{ opacity: 0, transform: "translateX(-12px)" }, { opacity: 1, transform: "none" }], { duration: D.s, easing: EASE.enter });
    sideWasCollapsed.current = sideCollapsed;
  }, [sideCollapsed]);
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
  // a room dialog asked for from an area's Members ▾: shown here, so it outlives the header it came from
  const [memberDlg, setMemberDlg] = useState<MemberDialog | null>(null);
  const [joinDlg, setJoinDlg] = useState(false);
  // team rooms: join requests this install answers as a room's admin, one prompt at a time, oldest first;
  // Later puts one off for this window (it stays in Settings → Team)
  const [laterJoins, setLaterJoins] = useState<string[]>([]);
  const joinKey = (r: { roomId: string; id: string; at: number }) => `${r.roomId}:${r.id}:${r.at}`;
  const joinAsks = adminRequests(teamStatus);
  const joinAsk = joinAsks.find((a) => !laterJoins.includes(joinKey(a.request)));
  const [joinShown, setJoinShown] = useState<typeof joinAsk | null>(null);
  useEffect(() => {
    if (!joinShown && joinAsk) setJoinShown(joinAsk);
  }, [joinShown, joinAsk]);
  const joinDone = useCallback(() => setJoinShown(null), []);
  // team rooms: rooms whose admin made backups to origin available and this member hasn't answered for theirs; Not now is an answer, closing asks again next start
  const [laterConsents, setLaterConsents] = useState<string[]>([]);
  // team rooms: the House board — the room whose board is open
  const [boardDlg, setBoardDlg] = useState<string | null>(null);
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
      const pending: PendingRename = { from: renameDlg.key, to: next };
      setLsRenames((r) => [...r.filter((x) => x.from !== pending.from), pending]);
      if (failed("Couldn't rename the group", await window.mb.renameGroup(renameDlg.key, next))) {
        setLsRenames((r) => r.filter((x) => x !== pending));
        return;
      }
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
  // Council models waiting on an approval, per council — badged on the tab wherever you are
  const [roomAsks, setRoomAsks] = useState<Record<string, number>>({});
  useEffect(() => {
    window.mb.collabList().then(
      unlessError("the councils", (rooms: CollabRoom[]) => setRoomAsks(Object.fromEntries(rooms.map((r) => [r.id, r.pending?.length ?? 0]))))
    );
    return window.mb.onCollabChanged((r: CollabRoom) => setRoomAsks((p) => ({ ...p, [r.id]: r.pending?.length ?? 0 })));
  }, []);
  const asksWaiting = Object.values(roomAsks).reduce((a, b) => a + b, 0);
  const [updOutcome, setUpdOutcome] = useState<(UpdateOutcome & { restoreErrors?: string[] }) | null>(null);
  useEffect(() => {
    window.mb.updateStatus().then(unlessError("the update's progress", setUpd));
    return window.mb.onUpdateProgress((p: UpdateProgress) => setUpd(p));
  }, []);
  // the update this launch ends, as far as What's new needs it: undefined until it's been read
  const [outcomeSeen, setOutcomeSeen] = useState<{ ok: boolean; to: string } | null | undefined>(undefined);
  // After an update restart: say how it went, and bring back the sessions that were open
  useEffect(() => {
    window.mb.updateOutcome().then(async (o: UpdateOutcome | null | { error: string }) => {
      if (isErr(o)) {
        setOutcomeSeen(null);
        return readFailed("how the last update went", o);
      }
      setOutcomeSeen(o ? { ok: o.ok, to: o.to } : null);
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
  // What's new: the first launch on a newer version labels the version "Updated to …" and opens its notes once;
  // dismissing them records the version as seen
  const [updatedTo, setUpdatedTo] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const whatsNewChecked = useRef(false);
  useEffect(() => {
    if (!appVersion || outcomeSeen === undefined || whatsNewChecked.current) return;
    whatsNewChecked.current = true;
    const last = readPref<string | null>(LAST_SEEN_KEY, null);
    const updated = justUpdated(appVersion, last, outcomeSeen);
    if (updated) {
      setUpdatedTo(true);
      setWhatsNewOpen(true);
    }
    const seen = seenNow(appVersion, last, updated);
    if (seen) writePref(LAST_SEEN_KEY, seen);
  }, [appVersion, outcomeSeen]);
  const closeWhatsNew = () => {
    setWhatsNewOpen(false);
    if (updatedTo) {
      writePref(LAST_SEEN_KEY, appVersion);
      setUpdatedTo(false);
    }
  };
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
    // on the landscape the side bar is the area tree, and the other views are tool windows
    const tool = landscapeOn ? toolOfView(v) : null;
    if (tool) return showTool(tool, sessions.find((s) => s.id === focused) ?? null);
    if (v === "sessions") setLsTeam(false);
    setSideView(v);
    setSideCollapsed(false);
    if (v === "search") setSearchFocus((n) => n + 1);
  };
  // on the landscape the side bar shows the Team view's room list in place of the area tree (the Connected line)
  const [lsTeam, setLsTeam] = useState(false);
  /**
   * A room's chat, from a clicked mention notification or the Connected line. On the landscape: the room's area, flown
   * to, with its Chat window; with no room named (the line, with several rooms), the Team view's room list in the side
   * bar, where each room's Leave and join requests are. On the grid: the Team view, on the room.
   */
  const openRoom = (roomId: string | null) => {
    const room = roomId && teamStatus && !isErr(teamStatus) ? teamStatus.rooms.find((r) => r.id === roomId) : undefined;
    if (!landscapeOn) {
      openTeamView(roomId);
      return showView("room");
    }
    setTab("sessions");
    const key = room?.groupKey;
    const area = key ? layoutNow.current?.areas.find((a) => a.key === key) : undefined;
    if (!key || !area) return teamViewOn(roomId);
    goToArea(key);
    if (!area.rect.collapsed) return void (showTool("chat", null, key) || teamViewOn(roomId));
    // collapsed: opened first, and its Chat placed once the layout has it open (the effect below)
    setRoomChatAfterOpen({ key, roomId });
    void landscapeStore.update({ areas: { [key]: { collapsed: false } } }, `${areaTitle(key)} opened`).then((error) => {
      if (!error) return;
      setRoomChatAfterOpen(null);
      lsSay(`${areaTitle(key)} couldn't be opened (${error}): its room's chat is in the side bar`);
      teamViewOn(roomId);
    });
  };
  /** The Team view in the side bar, on room `roomId` (or the room list): where a room shows when its area can't. */
  const teamViewOn = (roomId: string | null) => {
    openTeamView(roomId);
    setLsTeam(true);
    setSideCollapsed(false);
  };
  const [roomChatAfterOpen, setRoomChatAfterOpen] = useState<{ key: string; roomId: string | null } | null>(null);
  useRoomChatOpen(openRoom);

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
    else {
      setSessions(live);
      listLoaded("live");
    }
    const previous: SessionInfo[] | { error: string } = await window.mb.resumableSessions();
    if (isErr(previous)) readFailed("the previous sessions", previous);
    // debriefs aren't restored with the grid's sessions: they live on the WorkTracker tab
    else {
      setResumable(previous.filter((s) => !s.debrief));
      listLoaded("resumable");
    }
    return isErr(live) ? ownSessions : live;
  };

  // First launch opens the setup wizard. Installs that predate it (the help
  // popup was already seen) are marked set up without being interrupted.
  useEffect(() => {
    window.mb.getSettings().then(async (s: Settings | { error: string }) => {
      if (isErr(s)) {
        // the grid, as Labs flags are off until settings say otherwise
        setLabsNow({});
        return readFailed("settings", s);
      }
      setLabs(s.labs ?? {});
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
    const off = window.mb.onSessionsChanged((s: SessionInfo[]) => {
      setSessions(s);
      listLoaded("live");
    });
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
  // the grid's own bookkeeping, here and below, stands still while the landscape shows instead: the grid comes back
  // with the layout prefs it left
  useEffect(() => {
    if (!landscapeOn && activeGroup && activeGroup !== lastGroup) setLastGroup(activeGroup);
  }, [activeGroup, landscapeOn]);

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

  // record the active group's visible subset whenever it changes (its own
  // panes only — pinned visitors from other groups aren't part of its layout)
  useEffect(() => {
    if (landscapeOn || !activeGroup) return;
    const own = layoutToRemember(shown, groupOfId, activeGroup);
    if (own.length === 0) return;
    setGroupLayouts((prev) => {
      const cur = prev[activeGroup];
      if (cur && cur.length === own.length && cur.every((id, i) => id === own[i])) return prev;
      return { ...prev, [activeGroup]: own };
    });
  }, [shown, activeGroup, landscapeOn]);

  /** A group's remembered layout, pruned to sessions that still exist in it. */
  const rememberedLayout = (g: string): string[] => {
    const ids = sessions.filter((x) => topOf(x) === g).map((x) => x.id);
    return (groupLayouts[g] ?? []).filter((id) => ids.includes(id));
  };

  /** Swap the grid to another group's panes; pinned panes stay where they are. The new group's panes come in
   *  from its side of the side bar. */
  const switchGrid = (g: string, ids: string[]) => {
    const apply = () => {
      setZoomed(null);
      setLastGroup(g);
      setShown((p) => switchTo(p, pinnedSet, ids));
      collapseOthers(g);
    };
    if (!activeGroup || g === activeGroup) return apply();
    const order = outline.flatMap((e) => (e.kind === "connected" ? [] : [e.key]));
    gridChange({ kind: "switch", dir: switchDir(order, activeGroup, g) }, apply);
  };

  /** Show a session — same group appends; a different group swaps the grid to
   *  that group's remembered layout (plus the clicked session). */
  const showSession = (s: SessionInfo) => {
    const g = topOf(s);
    if (activeGroup && g !== activeGroup && !pinnedSet.has(s.id)) {
      const remembered = rememberedLayout(g);
      switchGrid(g, remembered.length ? [...new Set([...remembered, s.id])] : [s.id]);
    } else if (!shown.includes(s.id)) {
      // it opens in place and the panes already there make room
      gridChange({ kind: "open" }, () => setShown((p) => (p.includes(s.id) ? p : [...p, s.id])));
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

  // ---- minimizing into the side bar's folders, and restoring out of them (gridMotion.ts) ----
  // A workspace's folder is drawn open while it's in the grid and closed once minimized. Held open here while
  // its pane flies in (the lid closes once it lands), or opened ahead of a pane coming back out.
  const [lidOpen, setLidOpen] = useState<string | null>(null);
  const pendingRestore = useRef<number | null>(null);
  const cancelRestore = () => {
    if (pendingRestore.current !== null) clearTimeout(pendingRestore.current);
    pendingRestore.current = null;
  };
  const folderSel = (wsKey: string) => `.sub-label[data-ws="${CSS.escape(wsKey)}"] .ico.folder`;
  const rowDotSel = (id: string) => `.sess-item[data-sid="${CSS.escape(id)}"] > .dot`;
  const railIcon = () => document.querySelector('.activitybar .ab-btn[aria-label="Sessions"] .ico');
  const cellInGrid = (key: string) => !!document.querySelector(`.grid > [data-cell="${CSS.escape(key)}"]`);
  /** Where a pane going into (or coming out of) the icon at `sel` flies, measured now. */
  const flyTo = (sel: string): FlyTo => {
    const listShown = !sideCollapsed && sideView === "sessions";
    const icon = listShown ? document.querySelector(sel) : null;
    const list = document.querySelector(".sidebar .scroll");
    const rail = railIcon();
    return flyTarget({ target: icon && rectOf(icon), list: list && rectOf(list), listShown, rail: rail && rectOf(rail) });
  };
  /** A pane has landed: the folder's lid closes behind it and the folder (or the rail's icon) gulps. */
  const landed = (via: FlyTo["via"], sel: string, wsKey: string | null) => {
    // (unless that folder is already opening again for a restore)
    if (wsKey && pendingRestore.current === null) setLidOpen((l) => (l === wsKey ? null : l));
    if (via === "target") {
      const icon = document.querySelector(sel);
      gulp(icon);
      const row = icon?.closest(".sub-label");
      if (row) play(row, [{ opacity: 1 }, { opacity: 0 }], { duration: D.l, easing: "ease-out", pseudoElement: "::after" });
    } else if (via === "rail") gulp(railIcon());
  };

  /** Minimize a workspace: its pane flies into the open folder, then the lid closes. */
  const minimizeWorkspace = (wsKey: string, list: SessionInfo[]) => {
    cancelRestore();
    const cell = list.map((s) => cellKeyFor(s.id, s.taskGroup)).find(cellInGrid);
    if (!cell) return hideSessions(list);
    const sel = folderSel(wsKey);
    gridChange({ kind: "minimize", cell, target: () => flyTo(sel), onLanded: (via) => landed(via, sel, wsKey) }, () => {
      setLidOpen(wsKey);
      hideSessions(list);
    });
  };

  /** Show a minimized workspace again: the folder's lid opens, then its pane comes out to its place. */
  const restoreWorkspace = (top: string, wsKey: string, list: SessionInfo[]) => {
    cancelRestore();
    const sel = folderSel(wsKey);
    const from = flyTo(sel);
    const cell = list[0] ? cellKeyFor(list[0].id, list[0].taskGroup) : "";
    const out = () => gridChange({ kind: "restore", cell, from, onOut: () => setLidOpen((l) => (l === wsKey ? null : l)) }, () => focusSub(top, list));
    if (motion() !== "full" || from.via !== "target" || tab !== "sessions") return out();
    setLidOpen(wsKey);
    pendingRestore.current = window.setTimeout(() => {
      pendingRestore.current = null;
      out();
    }, LID_MS);
  };

  /** Hide one session's pane: it flies into its workspace's folder, or its own row's dot. */
  const minimizePane = (s: SessionInfo) => {
    const sub = subOf(s);
    const wsKey = sub ? `${topOf(s)}/${sub}` : null;
    const cell = cellKeyFor(s.id, s.taskGroup);
    // a workspace tab with others still shown leaves its pane in place: nothing flies
    const leaves = !wsKey || !shown.some((id) => id !== s.id && sessions.some((x) => x.id === id && cellKeyFor(x.id, x.taskGroup) === cell));
    if (!leaves || !cellInGrid(cell)) return hide(s.id);
    cancelRestore();
    const sel = wsKey ? folderSel(wsKey) : rowDotSel(s.id);
    gridChange({ kind: "minimize", cell, target: () => flyTo(sel), onLanded: (via) => landed(via, sel, wsKey) }, () => {
      if (wsKey) setLidOpen(wsKey);
      hide(s.id);
    });
  };

  const jumpToSession = (s: SessionInfo) => {
    if (s.debrief) {
      setTab("worktracker"); // debriefs live on their own tab, not the grid
    } else if (landscapeOn) {
      // every workspace is on the landscape at once: this brings the session's into view, and the grid stays as it was
      setTab("sessions");
      revealWorkspace(s.id);
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

  // team rooms: live panes — Follow mirrors a teammate's shown room sessions and focus. On the landscape, where every
  // workspace is on screen at once, it brings the one they focus (or the first they show) into view and selects it,
  // and picking another one stops it: the selection is what it watches there, not what's on screen, which a flight
  // or a pan changes
  const followFocus = useMemo(() => (focused ? [focused] : []), [focused]);
  const follow = useFollow({
    views: roomLive.state?.views ?? [],
    sessions,
    shown: landscapeOn ? followFocus : shown,
    groupOf: topOf,
    show: (g, ids, f) => {
      if (landscapeOn) {
        const id = f ?? ids[0];
        if (id) {
          revealWorkspace(id);
          setFocused(id);
        }
        return;
      }
      switchGrid(g, ids);
      if (f) setFocused(f);
    },
  });

  // one group on screen: a pane whose session moved to another group (or a stale
  // persisted layout) leaves the grid, unless it's pinned
  useEffect(() => {
    if (!landscapeOn) setShown((prev) => pruneToGroup(prev, groupOfId, pinnedSet, activeGroup));
  }, [sessions, pinnedSet, activeGroup, landscapeOn]);

  // debrief sessions live on the WorkTracker tab, everything else on the grid
  const workSessions = useMemo(() => sessions.filter((s) => !s.debrief), [sessions]);
  const debriefSessions = useMemo(() => sessions.filter((s) => s.debrief), [sessions]);

  // ---- the landscape (Settings → Labs): the Sessions tab's surface instead of the grid ----
  const landscapeStore = useLandscape(landscapeOn);
  const liveOwn = useMemo(() => sessions.filter((s) => !isRemote(s)), [sessions]);
  const liveRemote = useMemo(() => sessions.filter(isRemote), [sessions]);
  const migration = useLandscapeMigration({
    on: landscapeOn,
    store: landscapeStore,
    // set means teammates' sessions are all in it: main indexes them from the saved rooms as it starts
    lists: { ...listsLoaded, remote: roomLive.state !== null },
    live: liveOwn,
    resumable,
    remote: liveRemote,
    remoteError: roomLive.error,
    retryRemote: roomLive.retry,
  });
  const landscapeState = landscapeStore.state;
  // shown once the grid's layout is read in, or once it can't be: a layout made up before that would be redrawn
  // (and every terminal resized) when the migration lands
  const landscapeShown = landscapeOn && !!landscapeState && (migration.step.kind === "done" || migration.step.kind === "blocked" || !!migration.failed);
  // groups renamed here whose changes (the session list, the landscape's re-keying, teammates' sessions) haven't all
  // arrived: the layout keeps each under the key the landscape holds it under meanwhile
  const [lsRenames, setLsRenames] = useState<PendingRename[]>([]);
  useEffect(() => {
    if (!lsRenames.length || !landscapeState) return;
    const left = lsRenames.filter((r) => !renameSettled(r, landscapeState.landscape, workSessions));
    if (left.length !== lsRenames.length) setLsRenames(left);
  }, [lsRenames, landscapeState, workSessions]);
  const landscapeLayout = useMemo(
    () => (landscapeShown && landscapeState ? resolveLayout(landscapeState.landscape, workSessions, undefined, lsRenames, placeHint) : null),
    [landscapeShown, landscapeState, workSessions, lsRenames, placeHint]
  );
  // a right-click's place: kept for the session placed there until its place is saved (let go sooner, the next layout
  // would place it as any new one, and save that over it), or until it's been made and none took it
  useEffect(() => {
    if (!placeHint) return;
    if (placeHint.took && landscapeState && Object.hasOwn(landscapeState.landscape.workspaces, placeHint.took)) return setPlaceHint(null);
    if (!placeHint.took && landscapeLayout?.hinted) return setPlaceHint({ ...placeHint, took: landscapeLayout.hinted });
    if (placeHint.until === undefined) return;
    const t = setTimeout(() => setPlaceHint((h) => (h === placeHint ? null : h)), Math.max(0, placeHint.until - Date.now()));
    return () => clearTimeout(t);
  }, [placeHint, landscapeLayout, landscapeState]);
  // new workspaces keep the places they were given: saved, unless the file has a problem (what's shown stands in for it)
  // or the grid's layout isn't read in yet (it would place them)
  const placesToSave = landscapeLayout?.patch && migration.step.kind === "done" && !readProblem(landscapeState) ? JSON.stringify(landscapeLayout.patch) : null;
  useEffect(() => {
    if (placesToSave) void landscapeStore.update(JSON.parse(placesToSave), "new workspaces' places");
  }, [placesToSave]);
  // asks of the landscape (bring a workspace into view, go to an area), each held until the landscape takes it up
  // (onHandled): one asked from another tab waits for the landscape to mount, and none is taken up twice when the
  // landscape mounts again
  const asked = useRef(0);
  const [reveal, setReveal] = useState<{ id: string; n: number; focus?: boolean } | null>(null);
  /** Bring a session's workspace into view on the landscape, and with `focus` fill the window with it. */
  const revealWorkspace = (id: string, focus = false) => setReveal({ id, n: ++asked.current, focus });
  // going to an area on the landscape: the area tree, the switcher, ⌘K
  const [goTo, setGoTo] = useState<{ area: string; n: number } | null>(null);
  const goToArea = (area: string) => {
    setTab("sessions");
    setGoTo({ area, n: ++asked.current });
  };
  /** An area selected as a whole (the selection bar shows its actions): the selected session is let go, as in Figma. */
  const selectArea = (key: string | null) => {
    setSelArea(key);
    if (key) setFocused(null);
  };
  // a session selected (a click, its terminal, the tree, a jump) is the selection: the area selected before is let go
  useEffect(() => {
    if (focused) setSelArea(null);
  }, [focused]);
  // an area renamed or merged stays selected under its new key; one removed is let go, so no tool, key or Esc acts on
  // an area that isn't there
  useEffect(() => {
    if (!selArea || !landscapeLayout) return;
    const now = areaSelectionNow(selArea, landscapeLayout.areas.map((a) => a.key), lsRenames);
    if (now !== selArea) setSelArea(now);
  }, [selArea, landscapeLayout, lsRenames]);
  const landscapeHandled = (n: number) => {
    setReveal((r) => (r?.n === n ? null : r));
    setGoTo((g) => (g?.n === n ? null : g));
  };

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
    if (!tree || landscapeOn) return;
    for (const k of keysOf(tree)) expected.current.delete(k);
    // shown but not running: ids a relaunch brings back (by session, or by workspace)
    const awaiting = new Set(
      shown
        .filter((id) => !sessions.some((s) => s.id === id))
        .flatMap((id) => [id, cellKeyFor(id, resumable.find((r) => r.id === id)?.taskGroup)])
    );
    setTrees((p) => (worthSaving(asTree(p[seatKey]), tree, awaiting) ? { ...p, [seatKey]: tree } : p));
  }, [tree, seatKey, landscapeOn]);

  /** Change the active group's layout, starting from the tree as drawn. */
  const commitTree = (fn: (t: LayoutNode) => LayoutNode | null) => {
    if (!tree) return;
    const next = fn(tree);
    if (next && !sameTree(next, tree)) setTrees((p) => ({ ...p, [seatKey]: next }));
  };
  /** Arrange the panes, in the order they're read, into a snap layout or N even columns. */
  // re-arranging moves every pane to its new place together (gridMotion.ts)
  const arrangeAs = (id: string) => gridChange({ kind: "layout" }, () => commitTree((t) => arrange(id, readingOrder(t), gridExtent.current)));
  const arrangeInCols = (n: number) => gridChange({ kind: "layout" }, () => commitTree((t) => evenGrid(readingOrder(t), n)));
  const refit = () => gridChange({ kind: "layout" }, () => commitTree((t) => reconcile(null, readingOrder(t), gridExtent.current)));
  /** Fullscreen a pane (null: back to the grid): it grows to the grid's size while the others fade. */
  const zoomTo = (id: string | null) => gridChange({ kind: "zoom" }, () => setZoomed(id));

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
  // the session list's rows and headings ([data-flip]) slide to their new places when sessions arrive, leave,
  // move group or re-sort — never as the filter is typed, or a group or workspace folds open or shut
  const sessionList = useRef<HTMLDivElement>(null);
  useFlipRows(
    sessionList,
    "[data-flip]",
    "data-flip",
    workSessions.map((s) => `${s.id}:${s.taskGroup ?? ""}:${s.status}`).join("|"),
    `${filter}|${[...collapsed].join(",")}|${JSON.stringify(wsOpen)}|${sideView}|${tab}|${sideCollapsed}`
  );

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

  /** The close dialog open now, from the moment it's opened (its state is a render behind). */
  const closeDlgNow = useRef(closeDlg);
  closeDlgNow.current = closeDlg;
  /** Session `s`'s close dialog, or, while another's is open, `s` first in the queue to be asked once that's answered. */
  const askClose = (s: SessionInfo, wt: WorktreeStateInfo | { error: string }) => {
    const open = closeDlgNow.current?.session.id ?? null;
    if (closeWaits(open, s.id, [])) return setCloseQueue((q) => closeWaits(open, s.id, q) ?? q);
    closeDlgNow.current = { session: s, wt };
    setCloseDlg({ session: s, wt });
  };
  /** Close a session; dirty or unpushed worktrees get the dialog, clean ones close silently. */
  const requestClose = async (s: SessionInfo) => {
    const hasWorktree = s.repoPath && s.branch && s.cwd !== s.repoPath;
    if (!hasWorktree) return closeNow(s, true);
    const st: WorktreeStateInfo | { error: string } = await window.mb.worktreeState(s.cwd);
    if ("error" in st) {
      if (worktreeGone(st.error)) return closeNow(s, true);
      return askClose(s, st); // unknown state: the dialog says why and only keeps
    }
    if (!st.dirty && st.ahead === 0) return closeNow(s, true);
    askClose(s, st);
  };
  // several closed at once (the selection bar's Close…): one at a time, each as it is now (one closed meanwhile is
  // skipped), each waiting for the dialog the one before it opened; cancelling one's dialog keeps that one and goes on
  // with the rest, and one that fails is said and the rest go on
  const closingNow = useRef(false);
  /** The queue's session being closed now, or last: its dialog offers Cancel all while others wait. */
  const queuedNow = useRef<string | null>(null);
  const [closeTurn, setCloseTurn] = useState(0);
  useEffect(() => {
    const step = closeStep(closeQueue, sessions, { closing: closingNow.current, dialog: !!closeDlg });
    if (!step) return;
    const { next, taken } = step;
    // taken off as a function of the queue then, so ones another Close… adds meanwhile stay in it
    setCloseQueue((q) => q.filter((id) => !taken.includes(id)));
    if (!next) return;
    closingNow.current = true;
    queuedNow.current = next.id;
    void requestClose(next)
      .catch((err) => {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`[mockingbird] closing ${next.id} with several others failed:`, err);
        lsSay(`Couldn't close ${titleOf(next)} (${why}); the others go on closing`);
      })
      .finally(() => {
        closingNow.current = false;
        setCloseTurn((n) => n + 1);
      });
  }, [closeQueue, closeDlg, closeTurn, sessions]);

  /** A session continued in a new one (a handoff, or a fresh session from a brief): beside it, or in its place when it's closed. */
  const placeContinuation = async (old: SessionInfo, next: SessionInfo, closeOld: boolean) => {
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
  };

  const resumeDead = async (s: SessionInfo) => {
    // team rooms: a teammate continues it, so this copy doesn't run again (its pane stays until it's closed); main is
    // asked too, before its pty is dropped, for a take-over this window hasn't heard of
    const info = await resumeExited(titleOf(s), {
      refusal: takenOverWhy(s, "rather than resuming this copy"),
      mainRefusal: () => window.mb.relaunchRefusal(s.id),
      costOk: () => costGate.resume(s),
      kill: () => window.mb.killSession(s.id, false),
      dispose: () => disposeTerm(s.id),
      relaunch: () => window.mb.relaunchSession(s.id),
      say: alert,
    });
    if (info === undefined) return;
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
      // the landscape's side bar is the area tree (⌘\): ⌘B is Files, as the rail's
      if (landscapeOn) toggleTool("files");
      else setSideCollapsed((c) => !c);
      return;
    }
    // the landscape's area tree to the rail and back (design M); the area switcher stands in for it meanwhile
    if (cmd && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key === "\\" && tab === "sessions" && landscapeOn) {
      handled();
      if (sideCollapsed || sideView !== "sessions") showView("sessions");
      else setSideCollapsed(true);
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
    // on the landscape these open or close their tool's window
    const viewKey = (v: SideView) => {
      handled();
      const tool = landscapeOn && tab === "sessions" ? toolOfView(v) : null;
      if (tool) toggleTool(tool);
      else showView(v);
    };
    if (cmd && e.shiftKey && e.key.toLowerCase() === "f") return viewKey("search");
    if (cmd && e.shiftKey && e.key.toLowerCase() === "e") return viewKey("explorer");
    if (cmd && e.shiftKey && e.key.toLowerCase() === "d") return viewKey("run");
    if (cmd && !e.shiftKey && !e.ctrlKey && e.key === "j" && tab === "sessions") {
      handled();
      setPanelOpen((o) => !o);
      return;
    }
    if (e.ctrlKey && e.shiftKey && !cmd && e.key.toLowerCase() === "g") return viewKey("scm");
    if (cmd && e.shiftKey && e.key.toLowerCase() === "b") {
      handled();
      openControlRoom();
      return;
    }
    // the grid's own keys; the landscape has its own (Landscape.tsx), which take ⌘E and ⌘1 differently
    const grid = !landscapeOn;
    if (grid && cmd && !e.shiftKey && e.key === "e" && (focused || zoomed)) {
      handled();
      zoomTo(zoomed ? null : focused);
      return;
    }
    if (grid && e.key === "Escape" && zoomed && escapeLeavesFullscreen(e.target as Element, !!document.querySelector(OVERLAYS))) {
      handled();
      zoomTo(null);
      return;
    }
    if (!grid) {
      if (e.altKey && e.key === "Tab") {
        handled();
        cycleWaiting();
      }
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

  /** A session's terminal in its landscape workspace: the pane's body, sized by the workspace (TerminalPane `landscape`). */
  const landscapeBody = (s: SessionInfo, size: Size, home: Size | null) => (
    <TerminalPane
      key={termKey(s.id)}
      session={s}
      focused={focused === s.id}
      zoomed={false}
      density="min"
      paneIndex={99}
      // a teammate's session is only scaled: in focus it may grow past the landscape's font to fill the window
      landscape={{ w: size.w, h: size.h, font: home && isRemote(s) ? FOCUS_MAX_FONT : LANDSCAPE_FONT, home: home ?? undefined }}
      onFocus={() => setFocused(s.id)}
      onClose={() => requestClose(s)}
      onResume={() => resumeDead(s)}
      onCleanup={() => requestClose(s)}
      meter={meters?.sessions[s.id]}
      backup={backupFor(s)}
      onTakeOver={setTakeOverFor}
      tookOverAt={tookOverAt(s)}
      leftCopy={(() => {
        const l = leftFor(s);
        return l && <LeftCopyPanel left={l} onTakeBack={() => takeBack(l)} onClose={() => requestClose(s)} />;
      })()}
      teamNotice={<ReceivedNotice received={receivedFor(s)} onReview={setReviewing} />}
      onRestart={() => void restartSession(s)}
    />
  );
  // ---- tool windows and the workspace's actions (S5) ----
  // On the landscape the rail's views open as windows: placed beside the workspace (or in the area) they work on, or
  // docked at the window's edge, following the selected workspace (docs/landscape.md, Tools).
  const [lsNotice, setLsNotice] = useState<{ text: string; n: number } | null>(null);
  const lsSay = (text: string) => setLsNotice((p) => ({ text, n: (p?.n ?? 0) + 1 }));
  /** A change to the landscape; what stopped it is said over the landscape. */
  const lsChange = async (patch: LandscapePatch | null, what: string) => {
    if (!patch) return;
    const error = await landscapeStore.update(patch, what);
    if (error) lsSay(`${what}: not saved, ${error}`);
  };
  // a menu's pick (or a dialog's) acts on the landscape as it is then, not as it was when the menu opened
  const lsNow = useRef(landscapeState);
  lsNow.current = landscapeState;
  const layoutNow = useRef(landscapeLayout);
  layoutNow.current = landscapeLayout;
  const selectedAny = sessions.find((s) => s.id === focused) ?? null;
  /** The area selected as a whole, else the selected session's; null when it's loose or nothing is selected. */
  const selectedArea = selArea ?? (selectedAny && areaKeyOf(selectedAny) !== LOOSE_GROUP ? areaKeyOf(selectedAny) : null);
  /** What `tool` opens on from session `s`: its workspace (this Mac's only), or its area (`area` when given). Null: nothing. */
  const scopeOf = (tool: ToolKind, s: SessionInfo | null, area: string | null = s ? areaKeyOf(s) : null): ToolScope | null => {
    if (isWorkspaceTool(tool)) return s && !isRemote(s) ? { session: s.id } : null;
    return area && area !== LOOSE_GROUP ? { area } : null;
  };
  /** What `tool` opens on from the selection: the selected workspace, or for an area's tool the area selected as a whole. */
  const selScope = (tool: ToolKind): ToolScope | null => scopeOf(tool, selectedAny, selArea ?? undefined);
  /**
   * Tool window `id` (a new one by default) opened as `tool` on `scope`, beside its workspace or in its area
   * (planOpenWindow). With nothing to open it on, or no room for it in a locked area, it's docked instead, and said.
   */
  const openWindow = (tool: ToolKind, scope: ToolScope | null, id?: string): boolean => {
    const l = lsNow.current?.landscape;
    const layout = layoutNow.current;
    if (!l || !layout) return false;
    const wid = id ?? newExtraId(l, "w");
    // one docked window of a tool is enough: asked for again, the one there is it
    const docked = id ? undefined : Object.keys(l.tools).find((k) => l.tools[k].docked && l.tools[k].tool === tool);
    const dock = () => {
      if (!docked) void lsChange({ tools: { [wid]: { tool, docked: true } } }, `docking ${TOOL_NAME[tool]}`);
      return true;
    };
    if (!scope) return dock();
    const plan = planOpenWindow(l, layout, wid, tool, scope, areaTitle);
    if ("refused" in plan) {
      // a docked window shows the selection's area: the selection goes into this one first, so it shows this one
      if ("area" in scope) {
        const to = selectionFor(layout, scope.area, selectedAny);
        if (!to) {
          lsSay(`${plan.refused}, and it has no workspace to show ${TOOL_NAME[tool]} docked for`);
          return false;
        }
        if (to.select) setFocused(to.select);
      }
      lsSay(`${plan.refused}: ${TOOL_NAME[tool]} is docked instead`);
      return dock();
    }
    void lsChange(plan.patch, `opening ${TOOL_NAME[tool]}`);
    return true;
  };
  /**
   * Whether window `w` is `tool` open where `scope` would open it: placed on that scope, or docked while the selection
   * (`sel`) is that scope, since a docked window shows the selection's.
   */
  const openOn = (w: ToolWindowRecord, tool: ToolKind, scope: ToolScope | null, sel: SessionInfo | null = selectedAny) =>
    w.tool === tool && (w.docked ? sameScope(scope, sel === selectedAny ? selScope(tool) : scopeOf(tool, sel)) : !!scope && ("session" in scope ? w.session === scope.session : w.area === scope.area));
  /**
   * Why `tool` can't open from session `s` (in `area`, by default its), or null: the one rule the rail, the keys, a
   * docked window's ⧉ and the menus keep. A workspace tool is the session's actions' row (workspaceActions: none on a
   * teammate's session, only Search on an exited one); Chat is a room's area's only.
   */
  const toolGate = (tool: ToolKind, s: SessionInfo | null, area?: string | null): string | null => {
    if (isWorkspaceTool(tool) && s) {
      const row = actionOf(workspaceActions(s, wsEnv(s, tileOfSession(s.id))), `tool:${tool}`);
      if (!row || row.disabled) return row?.title ?? `${TOOL_NAME[tool]} doesn't open on ${titleOf(s)}`;
    }
    const scope = scopeOf(tool, s, area ?? (s ? areaKeyOf(s) : null));
    if (tool === "chat" && scope && "area" in scope && !roomOfGroup(teamStatus, scope.area)) return `${areaTitle(scope.area)} isn't a team room: share it as one from its ⋯ to chat with teammates`;
    return null;
  };
  /** The rail's tool buttons and keys on the landscape: open the tool beside the selected workspace (or in its area), or close it where it's open. */
  const toggleTool = (tool: ToolKind) => {
    const l = lsNow.current?.landscape;
    if (!l) return;
    const scope = selScope(tool);
    const open = Object.entries(l.tools).filter(([, w]) => openOn(w, tool, scope));
    if (open.length) return void lsChange({ tools: Object.fromEntries(open.map(([id]) => [id, null])) }, `closing ${TOOL_NAME[tool]}`);
    const no = toolGate(tool, selectedAny, selArea);
    if (no) return lsSay(no);
    openWindow(tool, scope);
  };
  /**
   * A tool opened from a workspace (its chips, its ⋯) or an area (its header, its ⋯): left as it is where it's open
   * already. Whether it shows (false: refused, and said).
   */
  const showTool = (tool: ToolKind, s: SessionInfo | null, area?: string): boolean => {
    const l = lsNow.current?.landscape;
    if (!l) return false;
    if (s) setFocused(s.id);
    const scope = scopeOf(tool, s, area ?? (s ? areaKeyOf(s) : null));
    if (tool === "search") setSearchFocus((n) => n + 1);
    // opened from a workspace, that's the selection now: a docked window follows it there
    if (Object.values(l.tools).some((w) => openOn(w, tool, scope, s ?? selectedAny))) return true;
    const no = toolGate(tool, s, area);
    if (no) {
      lsSay(no);
      return false;
    }
    return openWindow(tool, scope);
  };
  // a room's chat asked for while its area was collapsed: placed once the layout has the area open
  useEffect(() => {
    if (!roomChatAfterOpen || !landscapeLayout) return;
    const a = landscapeLayout.areas.find((x) => x.key === roomChatAfterOpen.key);
    if (a?.rect.collapsed) return;
    setRoomChatAfterOpen(null);
    if (!a || !showTool("chat", null, roomChatAfterOpen.key)) teamViewOn(roomChatAfterOpen.roomId);
  }, [landscapeLayout, roomChatAfterOpen]);
  const closeWindow = (id: string) => void lsChange({ tools: { [id]: null } }, "closing the window");
  /** Whether `tool` is open where the rail would open it: docked, or placed on the selected workspace (or its area). */
  const toolOpen = (tool: ToolKind) => Object.values(landscapeState?.landscape.tools ?? {}).some((w) => openOn(w, tool, selScope(tool)));
  /** The rail's views and the tools they are on the landscape. */
  const toolOfView = (v: SideView): ToolKind | null => ({ explorer: "files", scm: "changes", search: "search", run: "run", room: "chat", sessions: null } as const)[v];

  // a Search window keeps its own query; the side bar's is the grid's
  const [winSearch, setWinSearch] = useState<Record<string, SearchState>>({});
  const searchOf = (key: string): [SearchState, (st: SearchState) => void] =>
    key === "side" ? [search, setSearch] : [winSearch[key] ?? { ...search, q: "" }, (st) => setWinSearch((m) => ({ ...m, [key]: st }))];
  const activePathOf = (s: SessionInfo | null) => (activeTab && s && activeTab.root === s.cwd ? activeTab.path : null);
  /**
   * Mention artifact `a` of `shelf` (area `area`'s) to the selected workspace: its reference typed into the prompt, which
   * its agent reads with its artifact tools. Refused (and said) unless that's one of this Mac's in the area, whose agent
   * reads that shelf (mentionTarget).
   */
  const mentionArtifact = (a: { id: string; name: string }, shelf: ShelfInfo, area: string) => {
    const to = mentionTarget(selectedAny, area, shelf.id, shelfFor(area).id, roomOfGroup(teamStatus, area)?.id ?? null, areaTitle, titleOf);
    if ("no" in to) return lsSay(`Couldn't mention ${a.name}: ${to.no}`);
    typeInto(to.session, `${artifactRef(a.id, a.name)} `);
  };
  /** Artifact `artifact` of `shelf`, area `area`'s, placed as a card beside `beside` (its Artifacts window), or in the area's first free spot. */
  const placeCard = (area: string, shelf: string, artifact: string, beside: Rect | null) => {
    const l = lsNow.current?.landscape;
    const layout = layoutNow.current;
    if (!l || !layout) return;
    const plan = planPlaceCard(l, layout, newExtraId(l, "c"), area, shelf, artifact, beside, areaTitle);
    if ("refused" in plan) return lsSay(plan.refused);
    void lsChange(plan.patch, "placing the artifact");
  };
  /** Sharing area `key` as room `roomId` copied its artifacts (`ids`): its cards move to the room's copies. */
  const cardsShared = (key: string, roomId: string, ids: Record<string, string>) => {
    const l = lsNow.current?.landscape;
    if (l) void lsChange(cardsAfterShare(l, key, roomId, ids), "moving the area's cards to the room's copies");
  };
  const shelfFor = (area: string) => shelfOfArea(area, roomOfGroup(teamStatus, area) ?? null);

  /**
   * A tool's view: the side bar's on the grid (`key` "side"), a tool window's on the landscape (its id). `s` is the
   * session it works on (one of this Mac's), `area` the area it's of; `beside` is the window's place, where a card it
   * places goes next to.
   */
  const toolBody = (tool: ToolKind, s: SessionInfo | null, area: string | null, key: string, beside: Rect | null = null, seen = true): React.ReactNode => {
    const own = s && !isRemote(s) ? s : null;
    switch (tool) {
      case "files":
        return (
          <ExplorerTree
            session={own}
            activePath={activePathOf(own)}
            editor={editor}
            onOpen={(path, status) => openInEditor(path, { status }, own)}
            onActivate={(k) => setEditor((e) => ({ ...e, active: k }))}
            onCloseTab={(k) => setEditor((e) => closeTab(e, k))}
            onCloseAll={() => setEditor(EMPTY_EDITOR)}
            onQuickOpen={() => setModal("quickopen")}
          />
        );
      case "changes":
        return own ? (
          <SourceControl
            key={own.id}
            sessionId={own.id}
            root={own.cwd}
            selected={activePathOf(own)}
            onOpenDiff={(path, source, status) => openInEditor(path, { mode: "diff", source, status: status === "C" ? "M" : status }, own)}
            onOpenFile={(path) => openInEditor(path, {}, own)}
            onAskSession={(text) => typeInto(own.id, text)}
            review={((row) => (own.shell || !row ? undefined : { agent: otherAgent(own.agent), start: () => startReview(own), off: row.disabled ? row.title : undefined }))(sessionAction(own, "review"))}
          />
        ) : (
          <div className="fp-note">Click into a session to see its changes.</div>
        );
      case "search": {
        const [state, onState] = searchOf(key);
        return <SearchView session={own} state={state} onState={onState} focusKey={searchFocus} onOpenConversation={openTranscript} onOpenFile={(path, line) => openInEditor(path, { line }, own)} />;
      }
      case "run":
        return <RunView key={own?.id ?? ""} session={own} states={runStates} onShowLog={showLog} onAskSession={(text) => own && typeInto(own.id, text)} onOpenFrame={openFrame} />;
      case "chat": {
        const room = area ? roomOfGroup(teamStatus, area) : undefined;
        if (!room)
          return (
            <div className="fp-note">
              {area ? `${areaTitle(area)} isn't shared as a team room: share it from its ⋯ to chat with teammates here.` : "Select a workspace in an area to see its room's chat."}
            </div>
          );
        return (
          <RoomChat
            key={room.id}
            room={room}
            rooms={[room]}
            selfName={teamStatus && !isErr(teamStatus) ? teamStatus.self?.name ?? "you" : "you"}
            visible={seen}
            hooks={teamHooks}
            sessions={ownSessions}
            focusedSessionId={focusedSession?.id ?? null}
            onOpenRepoFile={openRepoFile}
          />
        );
      }
      case "artifacts": {
        if (!area) return <div className="fp-note">Select a workspace in an area: the area's artifacts show here.</div>;
        const shelf = shelfFor(area);
        const placed = new Set(Object.values(landscapeState?.landscape.cards ?? {}).filter((c) => c.area === area && c.shelf === shelf.id).map((c) => c.artifact));
        return (
          <ArtifactsWindow
            key={shelf.id}
            shelf={shelf}
            sessions={ownSessions}
            focusedSessionId={focusedSession?.id ?? null}
            onOpenRepoFile={openRepoFile}
            onMention={(a) => mentionArtifact(a, shelf, area)}
            onPlace={(a) => placeCard(area, shelf.id, a.id, beside)}
            placed={placed}
          />
        );
      }
    }
  };
  /**
   * A placed tool window's scope, as its title names it (design O: the area, and the workspace's branch), and its view.
   * `seen`: it's on screen in the live band, so what it shows is being looked at.
   */
  const windowFor = (w: WindowView, seen: boolean) => {
    const s = w.win.session ? sessions.find((x) => x.id === w.win.session) ?? null : null;
    const area = w.area ?? (s && areaKeyOf(s) !== LOOSE_GROUP ? areaKeyOf(s) : null);
    if (isWorkspaceTool(w.win.tool)) {
      if (!s) return { scope: "Its workspace closed", body: <div className="fp-note">The workspace this window was opened on has closed. Close the window, or dock it to follow the selected workspace.</div> };
      return { scope: [area && areaTitle(area), s.branch ?? titleOf(s)].filter(Boolean).join(" · "), body: toolBody(w.win.tool, s, area, w.id, w.rect, seen) };
    }
    const count = w.win.tool === "artifacts" && area ? <ArtifactsCount shelf={shelfFor(area).id} /> : undefined;
    return { scope: area ? areaTitle(area) : null, body: toolBody(w.win.tool, null, area, w.id, w.rect, seen), count };
  };
  const roomIds = teamStatus && !isErr(teamStatus) ? new Set(teamStatus.rooms.map((r) => r.id)) : null;
  const cardFor = (c: CardView) => {
    const takeOff = () => void lsChange({ cards: { [c.id]: null } }, "taking the card off");
    const at = cardShelf(c.card, roomIds);
    if ("gone" in at) return <ArtifactCardGone why={at.gone} onRemoveCard={takeOff} />;
    return (
      <ArtifactCardFace
        shelf={at.shelf}
        artifactId={c.card.artifact}
        sessions={ownSessions}
        focusedSessionId={focusedSession?.id ?? null}
        onOpenRepoFile={openRepoFile}
        onMention={(a) => mentionArtifact(a, at.shelf, c.card.area)}
        onRemoveCard={takeOff}
      />
    );
  };
  /** The docked tool windows, at the landscape's right edge: each on the selected workspace, or its area. */
  const dockColumn = () => {
    const docked = landscapeLayout?.docked ?? [];
    if (!docked.length) return null;
    return (
      <aside className="ls-dock" aria-label="Docked tools">
        {docked.map(({ id, win }) => {
          const ws = isWorkspaceTool(win.tool);
          const scope = ws ? (focusedSession ? [selectedArea && areaTitle(selectedArea), focusedSession.branch ?? titleOf(focusedSession)].filter(Boolean).join(" · ") : null) : selectedArea ? areaTitle(selectedArea) : null;
          return (
            <ToolWindow
              key={id}
              id={id}
              tool={win.tool}
              scope={scope}
              docked
              onPlace={() => {
                const to = selScope(win.tool);
                if (!to) return lsSay(ws ? "Select one of this Mac's workspaces to place it beside" : "Select a workspace in an area to place it there");
                const no = toolGate(win.tool, selectedAny, selArea);
                if (no) return lsSay(no);
                openWindow(win.tool, to, id);
              }}
              onClose={() => closeWindow(id)}
            >
              {toolBody(win.tool, ws ? focusedSession : null, ws ? null : selectedArea, id)}
            </ToolWindow>
          );
        })}
      </aside>
    );
  };

  /** Restart a session, resuming its conversation (a stuck one, or one the room's protections need). */
  const restartSession = async (s: SessionInfo) => {
    const r = await window.mb.sessionRestart(s.id);
    if (isErr(r)) alert(`Couldn't restart ${titleOf(s)}: ${r.error}`);
    else freshTerms([s.id]);
    refresh();
  };
  /** The agent messages a session sent and received, for its rail and footer; undefined when it has none. */
  const messagesOf = (s: SessionInfo) => {
    const mine = agentMessages.filter((m) => m.from === s.id || m.to === s.id);
    return mine.length ? { in: mine.filter((m) => m.to === s.id).length, out: mine.filter((m) => m.from === s.id).length } : undefined;
  };
  /**
   * A second opinion: the other agent reviews `author`'s branch and messages its findings back. It opens beside it on
   * the grid, and in its area on the landscape. Returns why it couldn't start.
   */
  const startReview = async (author: SessionInfo): Promise<string | null> => {
    const info = await window.mb.reviewStart(author.id);
    if (isErr(info)) return `Couldn't start the review: ${info.error}`;
    await refresh();
    if (landscapeOn) {
      revealWorkspace(info.id);
      return null;
    }
    // the reviewer opens beside the session it's reviewing
    const reviewer = cellKeyFor(info.id, info.taskGroup);
    expectPane(reviewer, (t) => t && insertBeside(t, cellKeyOfSession(author), "right", reviewer));
    setShown((p) => placeBeside(p.includes(info.id) ? p : [...p, info.id], info.id, author.id, "after"));
    return null;
  };
  /** Workspace `t` at size preset `p` (Size S/M/L), where it is when that's clear (planResizeTile); a refusal is said. */
  const resizeWorkspace = (key: string, p: SizePreset) => {
    const l = lsNow.current?.landscape;
    const layout = layoutNow.current;
    const t = layout?.tiles.find((x) => x.key === key);
    if (!l || !layout || !t) return lsSay("That workspace isn't on the landscape any more");
    const plan = planResizeTile(l, layout, key, presetFor(t, p), areaTitle);
    if ("refused" in plan) return lsSay(plan.refused);
    void lsChange(plan.patch, `${titleOf(t.front)}'s size`);
  };
  /** What a workspace's actions need (workspaceActions.tsx): `t` is its tile on the landscape, null off it. */
  const wsEnv = (s: SessionInfo, t: Tile | null): WorkspaceEnv => {
    const own = !isRemote(s);
    const b = own ? null : backupFor(s);
    const left = leftFor(s);
    const owner = own ? null : (s.room?.ownerName ?? "A teammate");
    const noAgent = s.shell ? "A terminal has no agent to hand on" : owner ? `${owner}'s session is theirs to hand on` : null;
    return {
      owner,
      size: t && landscapeLayout ? tileSize(t, landscapeLayout, areaTitle) : null,
      diffPanel: !!agentPanelOf(s.id),
      room: [
        takeOverAction(b, setTakeOverFor, b && tkView?.asking.find((a) => a.roomId === b.roomId && a.sessionId === b.sessionId)),
        ...leftCopyActions(left, () => left && takeBack(left), (err) => err && alert(`Couldn't send the changes: ${err}`)),
        ...receivedActions(receivedFor(s), setReviewing),
      ].filter((a): a is Action => !!a),
      rename: () => setRenameDlg({ kind: "session", key: s.id, initial: titleOf(s) }),
      mute: () => void toggleMute(s),
      move: () => setGroupDlg(s),
      resize: (p) => t && resizeWorkspace(t.key, p),
      tool: (k) => (landscapeOn ? showTool(k, s) : (setFocused(s.id), showView(({ files: "explorer", changes: "scm", search: "search", run: "run" } as const)[k]))),
      artifacts: landscapeOn ? artifactsOf(t, s, (area) => showTool("artifacts", null, area)) : null,
      repaint: () => void resyncTerm(s.id),
      hidePanel: () => {
        if (!hideAgentPanel(s.id)) lsSay("The agent's diff panel isn't open any more");
      },
      undo: s.shell ? { no: "A terminal has no agent turns to undo" } : owner ? { no: `${owner}'s session: theirs to undo` } : !s.repoPath ? { no: "It isn't in a git repository, so its turns can't be put back" } : () => setUndoFor(s),
      handoff: noAgent ? { no: noAgent } : () => setHandoffFor(s),
      brief: noAgent ? { no: noAgent } : () => setBriefFor(s),
      secondOpinion: noAgent ? { no: noAgent } : !s.repoPath ? { no: "It isn't in a git repository: a second opinion reviews its branch" } : () => void startReview(s).then((e) => e && alert(e)),
      close: () => requestClose(s),
      // a copy a teammate took over is taken back, not resumed or worked on: the model refuses those (workspaceActions)
      resume: () => resumeDead(s),
    };
  };
  const tileOfSession = (id: string) => landscapeLayout?.tiles.find((t) => t.members.some((m) => m.id === id)) ?? null;
  /** A landscape workspace's actions: its front session's, with its size. */
  const actionsFor = (t: Tile): ModelAction[] => workspaceActions(t.front, wsEnv(t.front, t));
  /**
   * Session `s`'s action `key` as its model has it, for what offers it outside the model's menus (the context chip,
   * the Changes tool, the grid's pane header, ⌘K), so none of them can run what the menus refuse.
   */
  const sessionAction = (s: SessionInfo, key: string): ModelAction | undefined => actionOf(workspaceActions(s, wsEnv(s, tileOfSession(s.id))), key);
  /** Its row for the grid's pane header and ⌘K (paneRow). */
  const paneAction = (s: SessionInfo, key: string): ModelAction | undefined => paneRow(s, wsEnv(s, tileOfSession(s.id)), key);
  /** Its context warning chip, with the model's Fresh session from a brief row (off, saying why, where it can't be). */
  const contextChipFor = (s: SessionInfo) => {
    const brief = sessionAction(s, "brief");
    return !s.shell && !isRemote(s) && brief ? <ContextWarning session={s} brief={brief} /> : undefined;
  };
  /** What a workspace's header chips and footer show (WorkspaceNode). */
  const chromeFor = (s: SessionInfo): WorkspaceChrome => ({
    chips: {
      overlaps: overlaps[s.id],
      runCount: runningIn(s.cwd),
      onJump: jumpTo,
      onOpenBoard: setBoardDlg,
      backup: backupFor(s),
      contextChip: contextChipFor(s),
      onRestart: () => void restartSession(s),
    },
    rail: { messages: messagesOf(s), onShowMessages: () => setMsgLogFor({ id: s.id, title: titleOf(s) }), meter: meters?.sessions[s.id] },
  });
  // ---- the landscape's areas (S4): each group's bar, ⋯ menu and tree row, and what its gestures ask ----
  const sessionsOfGroup = (key: string) => workSessions.filter((s) => topOf(s) === key);
  const areaTitle = (key: string) => groupTitle(key, sessionsOfGroup(key));
  /** A group's bar, on the grid over its panes and on the landscape as its area's header: the same parts and handlers. */
  const groupBarProps = (key: string): GroupBarProps => {
    const ticket = ticketOfGroup(key);
    return {
      group: key,
      title: areaTitle(key),
      ticket,
      pipeline: pipelines[key],
      onPipeline: () => setPipelineFor(ticket),
      meter: meters?.groups?.[key],
      room: roomOfGroup(teamStatus, key),
      onChat: landscapeOn ? () => showTool("chat", null, key) : () => showView("room"),
      onBoard: setBoardDlg,
      follow: followIn(follow, roomOfGroup(teamStatus, key)),
      onAsk: () => askGroupStatus(key),
    };
  };
  /** Share area `key` as a room, or invite a teammate to its room: the dialog offers the area's artifacts only when it makes the room. */
  const shareDialog = (key: string, title: string) => setShareDlg({ key, title });
  /** Join requests for `roomId` this install answers: shown again now, any put off with Later included. */
  const reviewJoins = (roomId: string) => {
    setLaterJoins((l) => l.filter((k) => !k.startsWith(`${roomId}:`)));
    const ask = joinAsks.find((a) => a.request.roomId === roomId);
    if (ask) setJoinShown(ask);
  };
  /**
   * An area's actions, as one model (workspaceActions.tsx) its ⋯, its right-click (on its header, its patch zoomed out,
   * its pill, its tree row) and its header's buttons all render: everything its header has no button for, and its tools.
   */
  const areaActions = (key: string): ModelAction[] => {
    const title = areaTitle(key);
    const l = landscapeState?.landscape;
    const a = l ? own(l.areas, key) : undefined;
    const room = roomOfGroup(teamStatus, key);
    const flag = (fields: { collapsed: boolean } | { locked: boolean }, what: string) => void landscapeStore.update({ areas: { [key]: fields } }, what);
    // removing an area takes its tool windows and artifact cards with it (those there when it's picked); its artifacts
    // on this Mac stay, under its key
    const extras = (): LandscapePatch => {
      const now = lsNow.current?.landscape;
      return {
        tools: Object.fromEntries(Object.entries(now?.tools ?? {}).filter(([, w]) => !w.docked && w.area === key).map(([id]) => [id, null])),
        cards: Object.fromEntries(Object.entries(now?.cards ?? {}).filter(([, c]) => c.area === key).map(([id]) => [id, null])),
      };
    };
    return areaModel({
      title,
      stored: a ?? null,
      room: !!room,
      landscape: landscapeOn,
      // an area outlives its sessions (their ghosts come back to it); one with none can go
      empty: !!a && !sessionsOfGroup(key).length,
      messages: { mode: msgModes[key], defaultSend: msgDefaultSend, set: (mode) => void setMsgMode(key, mode), log: () => setMsgLogFor({}) },
      // following one of the room's teammates (FollowButtons' handlers): a room's area's only
      follow: ((f) => ({ leader: f.leader?.name ?? null, candidates: f.candidates, stop: f.stop, start: (member: string) => f.follow(member) }))(followIn(follow, room)),
      rename: () => setRenameDlg({ kind: "group", key, initial: key }),
      collapse: () => a && flag({ collapsed: !a.collapsed }, `${title} ${a.collapsed ? "opened" : "collapsed"}`),
      lock: () => a && flag({ locked: !a.locked }, `${title} ${a.locked ? "unlocked" : "locked"}`),
      artifacts: () => showTool("artifacts", null, key),
      chat: () => showTool("chat", null, key),
      board: () => room && setBoardDlg(room.id),
      share: () => shareDialog(key, title),
      newSession: () => newSessionIn(key),
      ask: () => askGroupStatus(key),
      remove: () => void landscapeStore.update({ areas: { [key]: null }, ...extras() }, `removing ${title}`),
      chatIcon: <TeamRoomIcon />,
    });
  };
  /** An area's ⋯ (and right-click): its actions as a menu. */
  const areaMenu = (key: string): MenuEntry[] => menuOf(areaActions(key));
  /** A room's area's Members ▾ (design P): its header's and its selection bar's, with the same handlers. */
  const membersFor = (key: string): React.ReactNode => {
    const room = roomOfGroup(teamStatus, key);
    return (
      room && (
        <MembersMenu
          room={room}
          views={roomLive.state?.views ?? []}
          peers={teamStatus && !isErr(teamStatus) ? teamStatus.peers : []}
          sessions={sessions}
          follow={follow}
          takeover={takeoverView}
          onInvite={() => shareDialog(key, areaTitle(key))}
          onReviewJoins={() => reviewJoins(room.id)}
          onSettings={() => {
            setSettingsJump((j) => ({ section: "team", n: (j?.n ?? 0) + 1 }));
            setTab("settings");
          }}
          onDialog={setMemberDlg}
        />
      )
    );
  };
  /** New Session's repo and base for a session made in area `key`: its first repo, with the base it keeps for it. */
  const areaSeed = (key: string): { repo?: string; base?: string | null } => {
    const repo = landscapeLayout?.areas.find((a) => a.key === key)?.rect.repos[0];
    return repo ? { repo: repo.path, base: repo.base } : {};
  };
  /**
   * New session's dialog for a right-click on the landscape at `at`, in area `area` when it's in one: seeded with the
   * area's group and its first repo (with the base the area keeps for it), and the new workspace placed where it was
   * clicked (resolveLayout's PlaceHint).
   */
  const newAt = (area: string | null, at: { x: number; y: number }, seed: { launch?: LaunchKind; ticket?: boolean; mode?: "new" | "import" }) => {
    setNewGroup(area ?? "");
    setNewLaunch(seed.launch ?? "claude");
    setNewSeed({ ...(area ? areaSeed(area) : {}), ticket: seed.ticket, mode: seed.mode });
    setPlaceHint({ area: area ?? LOOSE_GROUP, at, since: Date.now() });
    setModal("new");
  };
  const areaHooks: AreaHooks = {
    header: (a, counts, onGrab) => {
      const p = groupBarProps(a.key);
      return (
        <AreaHeader
          {...p}
          repos={a.rect.repos}
          summary={areaSummary(counts, { workspaces: false })}
          locked={!!a.rect.locked}
          members={membersFor(a.key)}
          menu={() => areaMenu(a.key)}
          onArtifacts={() => showTool("artifacts", null, a.key)}
          onGrab={onGrab}
        />
      );
    },
    bar: (key) => ({ actions: areaActions(key), roomId: roomOfGroup(teamStatus, key)?.id ?? null, members: membersFor(key) }),
    create: (area, at) =>
      createActions({
        launch: (kind) => newAt(area, at, { launch: kind }),
        ticket: () => newAt(area, at, { ticket: true }),
        importIt: () => newAt(area, at, { mode: "import" }),
      }),
    info: (key) => {
      const ticket = ticketOfGroup(key);
      const stage = pipelines[key];
      const room = roomOfGroup(teamStatus, key);
      const others = room?.members.filter((m) => !m.self).map((m) => firstName(m.name)) ?? [];
      return {
        ticketChip: ticket && stage ? stageChip(areaTitle(key), ticket.id, stage) : null,
        shared: room ? (others.length ? `Shared room with ${listNames(others)}` : "Shared room") : null,
      };
    },
    menu: areaMenu,
  };
  /** A gesture's sessions moved into their groups, one at a time; the first that can't be is said and the rest left. */
  const runMoves = async (moves: readonly GroupMove[], what: string): Promise<MovesFailed | null> => {
    for (const [i, m] of moves.entries()) {
      const r = await settled(window.mb.setGroup(m.id, m.group));
      if (!isErr(r)) continue;
      const s = sessions.find((x) => x.id === m.id);
      console.error(`[mockingbird] ${what}: couldn't move ${m.id} to ${m.group ?? "no group"}:`, r.error);
      return { said: `${what}: ${s ? titleOf(s) : m.id} couldn't be moved (${r.error})${i ? `; ${i} of ${moves.length} moved` : ""}`, moved: i };
    }
    return null;
  };
  // Make area…'s name, asked with the rename dialog; the landscape waits for it
  const [areaNameAsk, setAreaNameAsk] = useState<{ count: number; answer: (name: string | null) => void } | null>(null);
  const askAreaName = (count: number) => new Promise<string | null>((answer) => setAreaNameAsk({ count, answer }));
  // the area tree: areas in the landscape's order, each with its workspaces (those the filter keeps)
  const treeAreas = useMemo((): TreeArea[] => {
    const order = landscapeLayout?.areas.map((a) => a.key) ?? [];
    const accents = accentsOf(order);
    const all = new Map(treeOf(workSessions, order).map((g) => [g.key, g.items]));
    const shownItems = new Map(treeOf(visible, order).map((g) => [g.key, g.items]));
    return [...all.keys()].map((key): TreeArea => {
      const a = landscapeLayout?.areas.find((x) => x.key === key);
      const room = roomOfGroup(teamStatus, key);
      const others = room?.members.filter((m) => !m.self && room.online.includes(m.id)) ?? [];
      return {
        key,
        // the sessions in no group are the landscape's loose workspaces
        title: key === "ungrouped" ? "Loose" : areaTitle(key),
        accent: a ? (accents.get(key) ?? accentOf(key)) : null,
        collapsed: !!a?.rect.collapsed,
        online: room ? others.map((m) => ({ id: m.id, name: m.name })) : null,
        counts: treeCounts(all.get(key) ?? []),
        items: shownItems.get(key) ?? [],
      };
    });
  }, [landscapeLayout, workSessions, visible, teamStatus]);

  const landscapeMain = () => (
    <>
      <LandscapeBanners
        problems={landscapeState?.problems ?? []}
        error={landscapeStore.error}
        onReload={landscapeStore.reload}
        migration={migration}
      />
      {landscapeLayout && landscapeState ? (
        <div className="ls-row">
        <Landscape
          layout={landscapeLayout}
          stored={landscapeState.landscape}
          selected={focused}
          onSelect={setFocused}
          selectedArea={selArea}
          onSelectArea={selectArea}
          onCloseMany={(ids) => setCloseMany(sessions.filter((s) => ids.includes(s.id)))}
          onTab={(t, id) => {
            setFocused(id);
            if (t.stack) void landscapeStore.update({ stacks: { [t.stack]: { active: id, placement: t.rect } } }, "the stack's front tab");
          }}
          reveal={reveal}
          goTo={goTo}
          onHandled={landscapeHandled}
          areaTitle={areaTitle}
          stackName={(stack) => splitGroupKey(stack).sub ?? stack}
          areas={areaHooks}
          meters={meters?.sessions}
          termKey={termKey}
          body={landscapeBody}
          onPatch={landscapeStore.update}
          onMoves={runMoves}
          askAreaName={askAreaName}
          onSeen={onLsSeen}
          switcher={sideCollapsed}
          onShowTree={() => showView("sessions")}
          actionsFor={actionsFor}
          chromeFor={chromeFor}
          windowFor={windowFor}
          onCloseWindow={closeWindow}
          cardFor={cardFor}
          notice={lsNotice}
        />
        {dockColumn()}
        </div>
      ) : (
        <div className="empty ls-loading">
          {!landscapeState ? (landscapeStore.error ? "The layout couldn't be read" : "Loading the layout…") : `Reading your grid's layout in${migration.step.kind === "wait" ? `, ${migration.step.why}` : ""}…`}
        </div>
      )}
    </>
  );

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
    setNewSeed({});
    // a right-click's place lasts until its session is placed; closed without one, it's let go
    setPlaceHint((h) => (h?.created ? h : null));
  }, [modal]);

  const onCreated = async (s: SessionInfo) => {
    setPlaceHint((h) => h && { ...h, created: true, until: Date.now() + PLACE_HINT_MS });
    // the lone pane joins its new workspace — unless the dialog put the session elsewhere
    const lone = pendingWs && s.taskGroup === pendingWs.key ? sessions.find((x) => x.id === pendingWs.id) : undefined;
    if (lone && pendingWs) await addAsTab(s, lone, pendingWs.key);
    refresh();
    jumpToSession(s);
    setModal(null);
  };

  /**
   * New Session's dialog seeded with group `key` (a group or "top/sub" workspace path; "ungrouped" seeds none) and, on
   * the landscape, its area's first repo and base, as a right-click's Create has them.
   */
  const newSessionIn = (key: string) => {
    setNewGroup(key === "ungrouped" ? "" : key);
    setNewLaunch("claude");
    setNewSeed(areaSeed(areaKeyOf({ taskGroup: key })));
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

  /** Open a file of session `s`'s folder (the focused session's by default) in its own editor tab. */
  const openInEditor = (path: string, o: { mode?: "file" | "diff"; status?: string; source?: DiffSource; line?: number | null } = {}, s: SessionInfo | null = focusedSession) => {
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
  /** A room's repo file, in the editor of the session main found it in (team rooms: artifacts). */
  const openRepoFile = (o: { sessionId: string; root: string; path: string; line: number | null }) => {
    const reveal = o.line ? { line: o.line, at: Date.now() } : undefined;
    setEditor((e) => openTab(e, { sessionId: o.sessionId, root: o.root, path: o.path, mode: "file", reveal }, new Set(dirtyKeys())));
  };
  const openFrameRef = useRef(openFrame);
  openFrameRef.current = openFrame;
  // where the debugger stops, the editor opens, with the debug controls beside it
  const showViewRef = useRef<(v: SideView) => void>(() => {});
  showViewRef.current = showView;
  useEffect(
    () =>
      onStopped((_sid, at) => {
        if (at.frame) openFrameRef.current(at.frame);
        showViewRef.current("run");
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

  // ---- session rows, in the Sessions view and (team rooms) the Team view ----
  const rowMenu = useContextMenu("Session");

  /** Everything a session's row, workspace tab and right-click menu offer, in menu order. */
  const sessionActions = (s: SessionInfo): MenuEntry[] => {
    // on the landscape a session's row, tab and right-click offer its workspace's actions, as its ⋯ does
    if (landscapeOn) return menuOf(workspaceActions(s, wsEnv(s, tileOfSession(s.id))));
    const own = !isRemote(s);
    const inGrid = shown.includes(s.id);
    const pinned = pinnedSet.has(s.id);
    const b = isRemote(s) ? backupFor(s) : null;
    // the grid's show, hide and pin mean nothing on the landscape, where every session is on screen
    const grid = !landscapeOn;
    return tidyMenu([
      grid &&
        (inGrid
          ? { key: "show", label: "Hide", menuLabel: "Hide from the grid", icon: <MinusIcon />, title: "Take its pane off the grid — the session keeps running", onPick: () => minimizePane(s) }
          : { key: "show", label: "Show", menuLabel: "Show in the grid", icon: <GridIcon />, onPick: () => showSession(s) }),
      "-",
      // team rooms: take-over
      takeOverAction(b, setTakeOverFor, b && tkView?.asking.find((a) => a.roomId === b.roomId && a.sessionId === b.sessionId)),
      own && { key: "rename", label: "Rename", menuLabel: "Rename…", icon: <PencilIcon />, onPick: () => setEditing({ key: s.id, value: titleOf(s) }) },
      {
        key: "notify",
        label: s.muted ? "Muted" : "Notify",
        menuLabel: s.muted ? "Unmute notifications" : "Mute notifications",
        icon: s.muted ? <BellOffIcon /> : <BellIcon />,
        pressed: !!s.muted,
        title: s.muted ? "Notifications muted — click to hear from this session again" : "Notifies you when it needs you — click to mute",
        onPick: () => toggleMute(s),
      },
      grid && {
        key: "pin",
        label: pinned ? "Pinned" : "Pin",
        menuLabel: pinned ? "Unpin" : "Pin to the screen",
        icon: <PinIcon />,
        pressed: pinned,
        title: pinned ? "Unpin — the pane goes back to following its group" : "Pin — keep this pane on screen when you switch groups",
        onPick: () => togglePin([s.id]),
      },
      own && { key: "move", label: "Move", menuLabel: "Move to group…", icon: <MoveIcon />, onPick: () => setGroupDlg(s) },
      "-",
      // a teammate's session is theirs to rename, move or close
      own && { key: "close", label: "Close", menuLabel: "Close session…", icon: <CloseIcon />, danger: true, onPick: () => requestClose(s) },
    ]);
  };

  /** A session's row: its name, with its actions at the end of that line, and what it is underneath. */
  const sessionRow = (s: SessionInfo) => {
    const idx = shown.indexOf(s.id);
    const acts = sessionActions(s);
    // on the landscape every session is on screen: its row brings it into view
    const open = () => {
      if (!landscapeOn) return idx >= 0 ? minimizePane(s) : showSession(s);
      setFocused(s.id);
      revealWorkspace(s.id);
    };
    return (
      <div
        key={s.id}
        data-sid={s.id}
        data-flip={`s:${s.id}`}
        className={`sess-item ${idx >= 0 ? "shown" : ""} ${focused === s.id ? "focused" : ""} ${pinnedSet.has(s.id) ? "pinned" : ""} ${s.muted ? "muted" : ""} ${isRemote(s) ? "remote" : ""}`}
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            open();
          }
        }}
        title={`${s.cwd} — double-click name to rename · drag onto a group to move, or onto a pane to open it as a tab there · right-click for more`}
        {...rowMenu.bind(() => acts)}
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
        <StatusDot status={s.status} />
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
            {/* the title line holds the row's actions, so they never sit over the lines and buttons under it */}
            <span className="sr-line">
              <span className="nm">{titleOf(s)}</span>
              <ActionBar className="sr-acts" actions={pickActions(acts, isRemote(s) ? ["takeover", "notify", "pin"] : ["notify", "pin", "close"])} more={acts} label={titleOf(s)} />
            </span>
            {rowLines(s)}
          </span>
        )}
      </div>
    );
  };
  /** The previous run's sessions, each to relaunch or forget: under the Sessions view, and under the area tree. */
  const previousList = () =>
    resumable.length > 0 && (
      <>
        <h2 data-flip="previous">
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
          <div key={s.id} data-flip={`p:${s.id}`} className="sess-item" title={taken ? `${s.cwd} — ${taken.back ? "it was taken back into another session here" : `${taken.byName} continued this session on their laptop`}, so this copy doesn't run again here.` : s.cwd}>
            <span className="dot dead" />
            <span className="name">
              <span className="nm">{s.title}</span>
              {left ? <LeftCopyLine left={left} onTakeBack={() => takeBack(left)} /> : taken && <span className="br tk-fresh muted">continued on {taken.byName}'s laptop {ago(taken.at)}</span>}
            </span>
            {!taken && (
            <button
              title="Relaunch, resuming the conversation"
              onClick={async () => {
                if (!(await costGate.resume(s))) return;
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
    );
  /** What a session's row says under its name, in the Sessions view and the area tree. */
  const rowLines = (s: SessionInfo) => (
    <>
      {/* team rooms: live panes — whose session it is and who's looking, in words */}
      {s.room && <span className="br who">{roomRowLine(s.room)}</span>}
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
    </>
  );

  /** A top-level group's sessions: loose rows, then its workspaces' folders with theirs. */
  const groupBody = (key: string, list: SessionInfo[]) => (
    <>
      {/* team rooms: take-over — what the session rows don't show (backups that failed outright or weren't deleted) */}
      {(() => {
        const room = roomOfGroup(teamStatus, key);
        return room ? <RoomBackupWarnings room={room} view={takeoverView} /> : null;
      })()}
      {bySub(list).map(([sub, subList]) => {
        const wsKey = `${key}/${sub}`;
        const inGrid = subList.some((s) => shown.includes(s.id));
        const open = !sub || (wsOpen[wsKey] ?? inGrid);
        return (
          <div key={sub || "_"} className={sub ? "ws-folder" : "loose-rows"}>
            {sub && (
              <div
                data-ws={wsKey}
                data-flip={`w:${wsKey}`}
                className={`sub-label ${inGrid ? "in-grid" : ""}`}
                title="click to show/minimize this workspace · ✎/double-click to rename · ✕ dissolves it (sessions stay) · drop a session to move it in"
                onClick={() =>
                  deferClick(() =>
                    inGrid
                      ? minimizeWorkspace(wsKey, subList)
                      : restoreWorkspace(key, wsKey, subList)
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
                <FolderIcon open={inGrid || lidOpen === wsKey} />
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
            {open && subList.map(sessionRow)}
          </div>
        );
      })}
    </>
  );

  // team rooms: the Sessions view's line for them, and what the Team view needs to show each room's sessions
  const connected = useMemo(() => connectedSummary(teamRooms, sessions), [teamRooms, sessions]);
  const roomSessions = (groupKey: string) => workSessions.filter((s) => topOf(s) === groupKey);
  const teamHooks: TeamViewHooks = {
    sessionCount: (groupKey) => roomSessions(groupKey).length,
    renderSessions: (groupKey) => groupBody(groupKey, roomSessions(groupKey)),
    onShowGroup: (groupKey) => (landscapeOn ? goToArea(groupKey) : focusGroup(groupKey, roomSessions(groupKey))),
    onOpenBoard: setBoardDlg,
    onInvite: (groupKey, title) => shareDialog(groupKey, title),
    onNewSession: newSessionIn,
    onJoinRoom: () => setJoinDlg(true),
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">
          <span className="mark">🪶</span>
          <span className="name">Mockingbird</span>
          {appVersion && <WhatsNew version={appVersion} updated={updatedTo} open={whatsNewOpen} onOpen={() => setWhatsNewOpen(true)} onClose={closeWhatsNew} />}
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
            {!landscapeOn && (
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
            )}
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
            onLabs={setLabs}
            presets={presets}
            onPresets={setPresets}
            onMsgDefaultSend={setMsgDefaultSend}
            onStartPreset={startPreset}
          />
        )}
        {tab === "collaborate" && (
          <CouncilView
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
          {[...SIDE_VIEWS, ...(landscapeOn ? [ARTIFACTS_VIEW] : [])].map(({ id, label: viewLabel, keys, Icon }) => {
            // on the landscape the views are tool windows, named as their windows are: lit while one is open on the
            // selection (or docked). Artifacts and Chat open on the selection's area
            const tool = landscapeOn ? (id === "artifacts" ? "artifacts" : toolOfView(id)) : null;
            const label = tool ? TOOL_NAME[tool] : viewLabel;
            const where = tool === "artifacts" || tool === "chat" ? "a window in the selected workspace's area" : "a window beside the selected workspace";
            const on = tool ? toolOpen(tool) : (landscapeOn ? id === "sessions" && !lsTeam : sideView === id) && !sideCollapsed;
            // what the selection's menu has off is off here too (a click says why)
            const no = tool && !on ? toolGate(tool, selectedAny, selArea) : null;
            const badge =
              id === "sessions" ? counts.waiting : id === "scm" ? scmCount : id === "run" ? runStates.filter((s) => s.status === "running" || s.status === "starting").length : 0;
            return (
              <button
                key={id}
                className={`ab-btn ${on ? "on" : ""} ${no ? "off" : ""}`}
                title={tool ? `${label}${keys ? ` (${keys})` : ""} — ${on ? "close its window" : no ?? where}` :`${label}${keys ? ` (${keys})` : ""}${on ? ` — click to hide the side bar (${landscapeOn ? "⌘\\" : "⌘B"})` : ""}`}
                aria-label={label}
                aria-pressed={on}
                aria-disabled={no ? true : undefined}
                onClick={() => (tool ? toggleTool(tool) : on ? setSideCollapsed(true) : showView(id as SideView))}
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
          <div className="side-inner" ref={sideInner} style={{ width: sideW }}>
          <div className="side-head">
            {/* the Sessions view is the area tree while the landscape shows (designs B and L) */}
            <span className="side-title">{landscapeOn ? (lsTeam ? "Team rooms" : "Landscape") : SIDE_VIEWS.find((v) => v.id === sideView)?.label}</span>
            {landscapeOn && lsTeam && (
              <button type="button" className="link side-back" title="Back to the area tree" onClick={() => setLsTeam(false)}>
                ‹ Areas
              </button>
            )}
          </div>
          {/* the grid's views; on the landscape they're tool windows, and the side bar is the area tree */}
          {!landscapeOn && (sideView === "explorer" || sideView === "scm" || sideView === "search" || sideView === "run") && toolBody(toolOfView(sideView)!, focusedSession, activeGroup, "side")}
          {/* team rooms: team chat */}
          {!landscapeOn && sideView === "room" && (
            <RoomChatPanel
              status={teamStatus}
              activeGroup={activeGroup}
              visible={!sideCollapsed}
              hooks={teamHooks}
              sessions={ownSessions}
              focusedSessionId={focusedSession?.id ?? null}
              onOpenRepoFile={openRepoFile}
            />
          )}
          {/* the landscape's area tree stands in for this list while the landscape shows */}
          {sideView === "sessions" && !landscapeOn && (
          <div className="scroll" ref={sessionList}>
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
              // team rooms: their groups and sessions are in the Team view; this line opens it
              if (entry.kind === "connected")
                return (
                  <div key="connected" data-flip="connected">
                  <ConnectedLine
                    summary={connected}
                    problem={roomLive.viewError}
                    onOpen={() => {
                      openTeamView(connected.roomId);
                      showView("room");
                    }}
                  />
                  </div>
                );
              const { key, list, shared } = entry;
              return (
              <div key={key}>
                {(
                  <div
                    className="group-label"
                    data-flip={`g:${key}`}
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
                    {/* team rooms: your sessions here; teammates' are in the Team view */}
                    {shared && <span className="gl-shared" title="A team room's group: your sessions in it are listed here, and the whole room — teammates' sessions too — in the Team view">Shared room</span>}
                    {key !== "ungrouped" && key !== "assistant" && (
                      <button
                        className="glbtn"
                        title={shared ? "Invite a teammate to this shared room" : "Share this group as a team room"}
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelClick();
                          shareDialog(key, groupTitle(key, list));
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
                {!collapsed.has(key) && groupBody(key, list)}
              </div>
              );
            })}

            {previousList()}
          </div>
          )}
          {landscapeOn && lsTeam && (
            <RoomChatPanel
              status={teamStatus}
              activeGroup={null}
              visible={!sideCollapsed}
              hooks={teamHooks}
              sessions={ownSessions}
              focusedSessionId={focusedSession?.id ?? null}
              onOpenRepoFile={openRepoFile}
            />
          )}
          {landscapeOn && !lsTeam && (
            <AreaTree
              areas={treeAreas}
              filter={filter}
              onFilter={setFilter}
              selected={focused}
              onArea={(key) => {
                // an area's row selects it, as its patch does, and flies there
                selectArea(key);
                goToArea(key);
              }}
              onPick={(s) => {
                setFocused(s.id);
                revealWorkspace(s.id);
              }}
              onFocus={(s) => {
                setFocused(s.id);
                revealWorkspace(s.id, true);
              }}
              onHide={() => setSideCollapsed(true)}
              menuFor={sessionActions}
              areaMenu={(key) => (key === "ungrouped" ? null : areaMenu(key))}
              footer={
                <>
                  {resumable.length > 0 && <div className="lt-previous">{previousList()}</div>}
                  {/* team rooms: the way into the Team view, as in the Sessions view */}
                  {teamRooms.length > 0 && (
                    <div className="lt-connected">
                      <ConnectedLine summary={connected} problem={roomLive.viewError} onOpen={() => openRoom(connected.roomId)} landscape />
                    </div>
                  )}
                </>
              }
            />
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
          {landscapeOn ? (
            landscapeMain()
          ) : (
          <>
          {activeGroup && (() => {
            const visitors = gridSessions.filter((s) => topOf(s) !== activeGroup).length;
            return (
              <GroupBar
                {...groupBarProps(activeGroup)}
                statusNote={statusNote}
                msgMode={msgModes[activeGroup]}
                msgDefaultSend={msgDefaultSend}
                onMsgMode={(mode) => void setMsgMode(activeGroup, mode)}
                count={`Showing ${gridSessions.filter((s) => topOf(s) === activeGroup).length} of ${sessionsOfGroup(activeGroup).length}${visitors ? ` · ${visitors} pinned from other groups` : ""}`}
              />
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
              className={`grid ${previewOn ? "previewing" : ""}`}
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
                    cell={embedded ? undefined : myKey}
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
                    onClose={onCloseOverride ?? (() => minimizePane(s))}
                    onZoom={() => zoomTo(zoomed === s.id ? null : s.id)}
                    onAddTab={embedded ? undefined : () => startWorkspaceFrom(s)}
                    tabDrop={embedded ? undefined : tabDrop(s, `h:${s.id}`)}
                    pinned={isPinned(pinIds)}
                    onPin={zoomed ? undefined : () => togglePin(pinIds)}
                    pinNote={visitor(s)}
                    onResume={() => resumeDead(s)}
                    onCleanup={() => requestClose(s)}
                    handoff={paneAction(s, "handoff")}
                    undoTurn={paneAction(s, "undo")}
                    overlaps={overlaps[s.id]}
                    onJump={jumpTo}
                    onOpenBoard={setBoardDlg}
                    backup={backupFor(s)}
                    onTakeOver={setTakeOverFor}
                    tookOverAt={tookOverAt(s)}
                    leftCopy={(() => {
                      const l = leftFor(s);
                      return l && <LeftCopyPanel left={l} onTakeBack={() => takeBack(l)} onClose={() => requestClose(s)} />;
                    })()}
                    teamNotice={<ReceivedNotice received={receivedFor(s)} onReview={setReviewing} />}
                    contextChip={contextChipFor(s)}
                    messages={(() => {
                      const mine = agentMessages.filter((m) => m.from === s.id || m.to === s.id);
                      return mine.length ? { in: mine.filter((m) => m.to === s.id).length, out: mine.filter((m) => m.from === s.id).length } : undefined;
                    })()}
                    onShowMessages={() => setMsgLogFor({ id: s.id, title: titleOf(s) })}
                    menuExtras={sessionActions(s).filter((a) => a === "-" || (a.key !== "show" && a.key !== "pin"))}
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
                  <div key={`ws-${key}`} data-cell={myKey} className={`ws-pane ${anyWaiting ? "st-waiting" : ""}`} style={area ? { gridArea: area } : undefined}>
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
                          {...rowMenu.bind(() =>
                            tidyMenu([
                              active.id !== s.id && {
                                key: "front",
                                label: "Open",
                                menuLabel: "Open this tab",
                                icon: <GridIcon />,
                                onPick: () => {
                                  setWsTabs((p) => ({ ...p, [key]: s.id }));
                                  setFocused(s.id);
                                  setTimeout(() => focusTerm(s.id), 50);
                                },
                              },
                              { key: "newtab", label: "New tab", menuLabel: `New tab in “${cell.sub}”…`, icon: <PlusIcon />, onPick: () => newSessionIn(key) },
                              "-",
                              ...sessionActions(s).filter((a) => a === "-" || a.key !== "show"),
                            ])
                          )}
                        >
                          <StatusDot status={s.status} className="sm" />
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
                    {paneFor(active, true, () => minimizeWorkspace(key, cell.list), cell.list.map((s) => s.id))}
                  </div>
                );
              })}
              <GridPreview on={previewOn} tree={preview.tree} hot={preview.hot} title={paneName} />
            </div>
          )}
          </>
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
            aria-label={`Restart ${plural(u.sessions.length, `${AGENT_NAME[u.agent]} session`)} on ${u.installed}`}
            onClick={() => setModal("restart")}
          >
            ↻ Restart {u.sessions.length}
            {agentUpdates.length > 1 && ` ${AGENT_NAME[u.agent]}`}
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
        <UsageMeter usage={usage} meters={meters} focused={sessions.find((s) => s.id === focused) ?? null} />
        <span className="right">
          {readError && (
            <span className="update-note bad" title={readError}>
              ✕ {readError}
              <button className="icon" title="Dismiss" onClick={() => setReadError(null)}>✕</button>
            </span>
          )}
          {/* a good update is said by the top bar's "Updated to" label; this note is for what went wrong */}
          {updOutcome && (!updOutcome.ok || !!updOutcome.restoreErrors?.length) && (
            <span
              className="update-note bad"
              title={[
                updOutcome.message,
                updOutcome.restoreErrors?.length ? `Sessions that couldn't come back: ${updOutcome.restoreErrors.join("; ")}` : "",
                `Log: ${updOutcome.logPath}`,
              ].filter(Boolean).join("\n")}
            >
              {updOutcome.ok ? `✕ ${plural(updOutcome.restoreErrors!.length, "session")} couldn't come back after the update` : `✕ ${updOutcome.message}`}
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
          {/* following a teammate: said here once, whichever room's (rooms' bars only offer Follow); after the notes, so
              it never takes their room */}
          <FollowingNow follow={follow} />
          {(() => {
            const theirs = workSessions.filter(isRemote).length;
            return <span className="sb-info">{workSessions.length - theirs} sessions{theirs ? ` (+${theirs} teammates')` : ""} · {groupCount} groups</span>;
          })()}
          <span className="sb-info">⌘K commands</span>
          <span className="sb-info help-link" onClick={() => setModal("help")}>? help</span>
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
            { label: landscapeOn ? "Sessions landscape" : "Sessions grid", run: () => setTab("sessions") },
            // the landscape: each area to fly to
            ...(landscapeOn ? (landscapeLayout?.areas ?? []).map((a) => ({ label: `Go to ${areaTitle(a.key)} — its area on the landscape`, run: () => goToArea(a.key) })) : []),
            ...(landscapeOn ? [{ label: sideCollapsed || sideView !== "sessions" ? "Show the area tree" : "Hide the area tree", kbd: "⌘\\", run: () => (sideCollapsed || sideView !== "sessions" ? showView("sessions") : setSideCollapsed(true)) }] : []),
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
                    run: () => shareDialog(activeGroup, groupTitle(activeGroup, workSessions.filter((s) => topOf(s) === activeGroup))),
                  },
                ]
              : []),
            // team rooms: the House board
            ...(activeGroup && roomOfGroup(teamStatus, activeGroup)
              ? [{ label: `House board — ${groupTitle(activeGroup, workSessions.filter((s) => topOf(s) === activeGroup))}`, run: () => setBoardDlg(roomOfGroup(teamStatus, activeGroup)!.id) }]
              : []),
            ...(shownTab("worktracker")
              ? [
                  { label: "WorkTracker — debriefs", run: () => setTab("worktracker") },
                  { label: "Morning brief", run: () => runDebrief("morning") },
                  { label: "4pm wrap-up", run: () => runDebrief("wrapUp") },
                ]
              : []),
            ...(shownTab("collaborate") ? [{ label: "Council — model discussions", run: () => setTab("collaborate") }] : []),
            ...(focusedSession
              ? [
                  {
                    label: `${zoomed === focusedSession.id ? "Exit fullscreen" : "Fullscreen"} ${titleOf(focusedSession)}`,
                    kbd: "⌘E",
                    run: () => zoomTo(zoomed === focusedSession.id ? null : focusedSession.id),
                  },
                  {
                    label: `Rename ${titleOf(focusedSession)}…`,
                    run: () => setRenameDlg({ kind: "session", key: focusedSession.id, initial: titleOf(focusedSession) }),
                  },
                  { label: `Change group of ${titleOf(focusedSession)}…`, run: () => setGroupDlg(focusedSession) },
                  { label: `${focusedSession.muted ? "Unmute" : "Mute"} notifications from ${titleOf(focusedSession)}`, run: () => toggleMute(focusedSession) },
                  ...((a) => (a ? [{ label: `Undo a turn of ${titleOf(focusedSession)} — put its files back`, run: () => a.onPick(), off: a.disabled ? a.title : undefined }] : []))(paneAction(focusedSession, "undo")),
                  ...((a) => (a ? [{ label: `Continue in ${AGENT_NAME[otherAgent(focusedSession.agent)]} — hand ${titleOf(focusedSession)} over with a summary`, run: () => a.onPick(), off: a.disabled ? a.title : undefined }] : []))(paneAction(focusedSession, "handoff")),
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
          cancelAll={closeDlg.session.id === queuedNow.current && closeQueue.some((id) => sessions.some((s) => s.id === id)) ? () => (setCloseQueue([]), setCloseDlg(null)) : undefined}
          onDone={() => {
            setCloseDlg(null);
            refresh();
          }}
          forceClose={forceClose}
        />
      )}
      {closeMany && (
        <CloseManyDialog
          sessions={closeMany}
          onCancel={() => setCloseMany(null)}
          onConfirm={() => {
            // added after any still waiting, each once, never the one being closed now
            setCloseQueue((q) => queueClose(q, closeMany.map((s) => s.id), closingNow.current || closeDlg?.session.id === queuedNow.current ? queuedNow.current : null));
            setCloseMany(null);
          }}
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
          onStarted={(next, closeOld) => {
            const old = handoffFor;
            setHandoffFor(null);
            void placeContinuation(old, next, closeOld);
          }}
        />
      )}
      {briefFor && (
        <BriefDialog
          session={briefFor}
          onClose={() => setBriefFor(null)}
          onStarted={(next, closeOld) => {
            const old = briefFor;
            setBriefFor(null);
            void placeContinuation(old, next, closeOld);
          }}
        />
      )}
      {costGate.dialog}

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

      {shareDlg && (
        <ShareRoomDialog
          groupKey={shareDlg.key}
          title={shareDlg.title}
          onClose={() => setShareDlg(null)}
          shared={(roomId) => <ShareAreaArtifacts areaKey={shareDlg.key} roomId={roomId} onShared={(ids) => cardsShared(shareDlg.key, roomId, ids)} />}
        />
      )}
      <MemberDialogs dialog={memberDlg} rooms={teamRooms} onClose={() => setMemberDlg(null)} />
      {joinDlg && <JoinRoomDialog onClose={() => setJoinDlg(false)} />}
      {/* team rooms: the House board */}
      {boardDlg && (
        <HouseBoardDialog
          roomId={boardDlg}
          onClose={() => setBoardDlg(null)}
          onStarted={(s) => {
            setBoardDlg(null);
            refresh();
            jumpToSession(s);
          }}
        />
      )}
      {rowMenu.menu}
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
      {/* team rooms: someone asks to join a room this install is the admin of */}
      {joinShown && !tkView?.asks[0] && (
        <JoinRequestPrompt
          key={joinKey(joinShown.request)}
          request={joinShown.request}
          room={joinShown.room}
          self={teamStatus && !isErr(teamStatus) ? teamStatus.self?.id : undefined}
          stillAsked={joinAsks.some((a) => joinKey(a.request) === joinKey(joinShown.request))}
          onLater={() => {
            setLaterJoins((l) => [...l, joinKey(joinShown.request)]);
            setJoinShown(null);
          }}
          onDone={joinDone}
        />
      )}
      {reviewing && <ReceivedDialog received={tkView?.received.find((r) => r.id === reviewing.id) ?? reviewing} onClose={() => setReviewing(null)} />}
      {/* team rooms: back up my room sessions to origin? — once the room's admin made it available */}
      {(() => {
        if (tkView?.asks[0] || joinShown) return null;
        const c = tkView?.rooms.find((r) => r.toOrigin && r.consent === null && !laterConsents.includes(r.roomId));
        const room = c && teamRooms.find((r) => r.id === c.roomId);
        return c && room ? <BackupConsentPrompt key={c.roomId} setting={c} roomName={room.name} onLater={() => setLaterConsents((l) => [...l, c.roomId])} /> : null;
      })()}
      <HouseWarnings onJump={jumpTo} onOpenBoard={setBoardDlg} boardRoomId={boardDlg} />

      {areaNameAsk && (
        <RenameDialog
          title={`Make an area of ${plural(areaNameAsk.count, "workspace")}`}
          initial=""
          onSave={(name) => {
            areaNameAsk.answer(name);
            setAreaNameAsk(null);
          }}
          onClose={() => {
            areaNameAsk.answer(null);
            setAreaNameAsk(null);
          }}
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
          rooms={teamRooms}
          roomRepos={roomRepoNames(sessions, teamRooms)}
          signalingUrl={teamStatus && !isErr(teamStatus) ? teamStatus.signalingUrl : undefined}
          onJoinRoom={() => {
            setModal(null);
            setJoinDlg(true);
          }}
          initialLaunch={newLaunch}
          initialGroup={newGroup}
          initialRepo={newSeed.repo}
          initialBase={newSeed.base ?? undefined}
          initialTicket={newSeed.ticket}
          initialMode={newSeed.mode}
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
