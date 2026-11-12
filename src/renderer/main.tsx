import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TerminalPane, agentPanelOf, disposeTerm, focusTerm, followOwners, applyTermTheme, hideAgentPanel, resyncTerm, termHasKeys } from "./TerminalPane";
import { EditorDock, ExplorerTree } from "./FilePanel";
import { SourceControl, type DiffSource } from "./SourceControl";
import { SearchView, type SearchState } from "./SearchView";
import { QuickOpen } from "./QuickOpen";
import { keyboardMoves } from "./Modal";
import { KEYS_SWALLOWED, inputStamp, keyboardNowhere, toNowhere, userLeft } from "./keyArm";
import { EMPTY_EDITOR, closeTab, openTab, tabKey, updateTab } from "./editorTabs";
import { useFolderRefresh } from "./folderWatch";
import { SetupWizard } from "./SetupWizard";
import { CouncilView } from "./Council";
import { UpdatePanel } from "./UpdatePanel";
import { WhatsNew } from "./WhatsNew";
import { LAST_SEEN_KEY, justUpdated, seenNow } from "./whatsNewModel";
import { DragLabel, installDragListeners } from "./drag";
import { resumeExited } from "./resumeFlow";
import { OVERLAYS, inEditor } from "./keys";
import { closeStep, closeWaits, groupChoices, queueClose, sessionHolding, sessionOutline, titleOf, worktreeGone } from "./appModel";
import { FilesIcon, FolderIcon, ChevronIcon, SessionsIcon, SourceControlIcon, SearchIcon, RunDebugIcon, UpdateIcon, NoteIcon } from "./Icons";
import { ActionBar, pickActions, useContextMenu, type Action, type MenuEntry } from "./ContextMenu";
import { RunView } from "./RunView";
import { Popover } from "./Popover";
import { PipelineDialog, RequestDismissDialog, usePipelines, usePipelinesRead } from "./TicketPipeline";
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
import { AGENT_NAME, HELPDESK_PRESET, otherAgent, isErr, sanitizeSegment, splitGroupKey, topOfKey, groupKey, isWorkItemId, ticketIdOf, ticketOfSession, UI_COMMANDS, type MissingFolder, type SessionInfo, type SessionPreset, type SessionStatus, type Settings, type WorktreeStateInfo, type UsageReport, type UpdateProgress, type UpdateOutcome, type CollabRoom, type TranscriptHit, type RunServiceState, type DebugFrame, type Meters, type LspLocation, type OverlapReport, type AgentUpdateNotice, type MessageMode, type OptionalTab, type IpcResult } from "../shared/types";
import { openLink } from "./uiUtil";
import { type Tab, TAB_LABELS } from "./tabs";
import { CommandPalette, HelpModal } from "./Palette";
import { UsageMeter } from "./UsageMeter";
import { DashboardBoard } from "./Dashboard";
import { RenameDialog, GroupDialog, RestartAllDialog, CloseSessionDialog, CloseManyDialog, StartStepDialog } from "./Dialogs";
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
import { followIn, mergeRoomSessions } from "./team/roomLiveModel";
import { NewSessionModal, ImportModal, type LaunchKind } from "./NewSession";
import { roomRepoNames } from "./newSessionModel";
import { fmtElapsed, plural } from "../shared/format";
import { baseName } from "../shared/paths";
import { usePersisted, readPref, writePref } from "./prefs";
import { D, EASE, initMotion, play } from "./motion";
import { StatusDot } from "./StatusDot";
// the landscape
import { emptyStateOf, nothingToTour } from "./landscapeFirstRun";
import { LandscapeTopBar, type TopTab } from "./TopBar";
import { FOCUS_MAX_FONT, Landscape, LandscapeBanners, type AreaHooks, type LandscapeNote, type NoteAction } from "./Landscape";
import { useLandscape, useLandscapeMigration, type LandscapeSave } from "./useLandscape";
import { NO_READ_NOTES, noteCleared, noteDismissed, noteFailed, type ReadNotes } from "./readNotes";
import { viewOnlyPatch, accentOf, accentsOf, areaSelectionNow, areaSummary, cardShelf, cardsAfterShare, carryPlan, closedIn, closedListOf, forgetPatch, plannedIn, freeSubName, mentionTarget, newExtraId, newStackName, planJoinStack, planOpenWindow, planPlaceCard, planResizeTile, planTidy, planUnstackAll, presetFor, readProblem, tidyRefusal, renamesLeft, resolveLayout, sameScope, selectionFor, tileSize, undoOf, unstackRefusal, withoutGone, type AreaPlan, type CardView, type GoToAsk, type GroupMove, type MovesFailed, type PendingRename, type PlaceHint, type RevealAsk, type ScreenBox, type Tile, type ToolScope, type WindowView } from "./landscapeModel";
import { wiresInOrder } from "../shared/wires";
import { wiresNow } from "./WireLayer";
import { droppedNote, unmovedNote } from "./wiresModel";
import { chainOf } from "./pipelineChain";
import { newAreaPatch } from "./landscapeModel";
import { SaveTemplateDialog, TemplatePicker } from "./TemplatePicker";
import type { LayOutReply, LayOutRequest, TemplateBody, TemplateDraft, TemplateList } from "../shared/pipelineTemplates";
import { GAP, LANDSCAPE_FONT, LOOSE_GROUP, areaKeyOf, isWorkspaceTool, own, type LandscapePatch, type Rect, type Size, type SizePreset, type ToolKind, type ToolWindow as ToolWindowRecord } from "../shared/landscape";
import { CLOSED_BUSY_WHY, actionOf, closedStatus, areaActions as areaModel, artifactsOf, createActions, ghostActions, ghostsActions, menuOf, needsActions, paneRow, plannedActions, plannedWhere, takenOverWhy, workspaceActions, type Can, type GhostEnv, type GhostsEnv, type ModelAction, type WorkspaceEnv } from "./workspaceActions";
import { NeedsYou, useNeedsYou } from "./NeedsYou";
import { currentIndex, goCan, selectionAfter, stepItem, targetOf, typingAsksOf, type NeedsItem, type NeedsLast, type NeedsSel } from "./needsYouModel";
import { decideTyping } from "./team/Typing";
import { BadgeContext } from "./cardBadges";
import { TOOL_NAME, ToolWindow } from "./ToolWindow";
import type { WorkspaceChrome } from "./WorkspaceNode";
import { AreaHeader, stageChip, type GroupBarProps } from "./GroupBar";
import { AreaTree, treeCounts, treeOf, type TreeArea } from "./AreaTree";
import { ClosedSessions } from "./ClosedSessions";
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

/** Overlaps before main's first answer: none known, and none unread. */
const NO_OVERLAPS: OverlapReport = { bySession: {}, unread: {} };

/** How long a pane the main process is about to add or rekey waits for its place (see `expected` in App). */
const EXPECT_MS = 10_000;
/** How long a right-click's place waits, once its session is made, for the session to reach the landscape. */
const PLACE_HINT_MS = 10_000;
/** How long a template's steps and wires, once laid out, have to reach the landscape before its area is tidied along them. */
const LAID_OUT_WAIT_MS = 8000;
/** What readClosed reads, as a failed read says it. */
const CLOSED_READ = "the previous sessions";
/** What a failed read of the closed sessions' missing folders is called in the status bar's error. */
const GONE_READ = "which closed sessions' folders are gone";
/** The longest wait before a failed read of the closed sessions is tried again. */
const CLOSED_RETRY_MAX_MS = 30_000;
/** Why something done to the landscape waits: what it plans against hasn't arrived from main yet. */
const LAYOUT_LOADING = "the layout hasn't loaded yet";
/** Why a change to the landscape isn't saved while the grid's layout isn't read in: reading it in would put it back. */
const NOT_READ_IN = "your grid's layout isn't read in yet, and reading it in would put this back: Try again in its banner first";
/** Words that follow others in a sentence ("in 5101"), with their space; none, nothing. */
const spaced = (words: string): string => (words ? ` ${words}` : "");

function App() {
  const [ownSessions, setSessions] = useState<SessionInfo[]>([]);
  const [resumable, setResumable] = useState<SessionInfo[]>([]);
  /** The steps not started yet (main's planned ones, W8): drawn as ghosts are, never among `resumable`. Read with it. */
  const [planned, setPlanned] = useState<SessionInfo[]>([]);
  /** The closed (resumable) sessions whose folders are gone, by id, and whether each still reopens: main's missingFolders, read with the lists. */
  const [goneFolders, setGoneFolders] = useState<ReadonlyMap<string, MissingFolder>>(() => new Map());
  // which session lists have been read at least once (the landscape reads the grid's layout in only once they have)
  const [listsLoaded, setListsLoaded] = useState({ live: false, resumable: false });
  /** Reads of the closed sessions that failed in a row (readClosed): each is tried again, later each time. */
  const [closedFails, setClosedFails] = useState(0);
  /** Likewise for reads of which closed sessions' folders are gone (readGone). */
  const [goneFails, setGoneFails] = useState(0);
  const listLoaded = (which: "live" | "resumable") => setListsLoaded((p) => (p[which] ? p : { ...p, [which]: true }));
  const [focused, setFocused] = useState<string | null>(null);
  // the sessions on the landscape's screen (Landscape's onSeen): what teammates stream here
  const [lsSeen, setLsSeen] = useState<string[]>([]);
  const onLsSeen = useCallback((ids: string[]) => setLsSeen((p) => (p.join("\n") === ids.join("\n") ? p : ids)), []);
  // team rooms: live panes — teammates' room sessions are sessions here too (session.room says whose)
  const roomLive = useRoomLive(ownSessions, lsSeen, focused);
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
  // the ticket pipeline, opened from an area's header, the palette or Needs you (`request`: an agent's PR request, its
  // form filled from it); and an agent's PR request being dismissed from Needs you
  const pipelines = usePipelines();
  const pipelinesRead = usePipelinesRead();
  const [pipelineFor, setPipelineFor] = useState<{ id: string; title: string; request?: string } | null>(null);
  const [dismissRequestFor, setDismissRequestFor] = useState<{ ticket: string; request: string } | null>(null);
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
  const [readNotes, setReadNotes] = useState<ReadNotes>(NO_READ_NOTES);
  const readFailed = (what: string, r: { error: string }) => {
    console.error(`[mockingbird] couldn't read ${what}:`, r.error);
    setReadNotes((n) => noteFailed(n, what, `Couldn't read ${what}: ${r.error}`));
  };
  /** `what` has been read: its note goes from the status bar, and any other's stays. */
  const readCleared = (what: string) => setReadNotes((n) => noteCleared(n, what));
  const unlessError =
    <T,>(what: string, apply: (v: T) => void) =>
    (r: T | { error: string }) => {
      if (isErr(r)) return readFailed(what, r);
      readCleared(what);
      apply(r as T);
    };
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
    const said = `Asked ${plural(r.asked, "session")}`;
    return lsSay(said);
  };
  // agent CLIs updated under running panes (they run the old version until restarted)
  const [agentUpdates, setAgentUpdates] = useState<AgentUpdateNotice[]>([]);
  useEffect(() => {
    window.mb.healthUpdates().then(unlessError("which agent CLIs were updated", (n: AgentUpdateNotice[]) => setAgentUpdates(Array.isArray(n) ? n : [])));
    return window.mb.onHealthUpdates((n: AgentUpdateNotice[]) => setAgentUpdates(Array.isArray(n) ? n : []));
  }, []);
  // files two worktrees of one repository have both changed, per session
  const [overlaps, setOverlaps] = useState<OverlapReport>(NO_OVERLAPS);
  useEffect(() => {
    window.mb.overlapsGet().then(unlessError("files changed in two worktrees", (o: OverlapReport) => setOverlaps(o ?? NO_OVERLAPS)));
    return window.mb.onOverlapsChanged((o: OverlapReport) => setOverlaps(o ?? NO_OVERLAPS));
  }, []);
  const [modal, setModal] = useState<ModalKind>(null);
  const [newLaunch, setNewLaunch] = useState<LaunchKind>("claude");
  // seeds New Session's Group field — set to "top/sub" by a workspace's + button
  const [newGroup, setNewGroup] = useState("");
  // and, from a right-click on the landscape, its repo and base (the area's), its ticket picker or its Import
  const [newSeed, setNewSeed] = useState<{ repo?: string; base?: string | null; ticket?: boolean; mode?: "new" | "import" }>({});
  // Add next step (W8): the session New session makes a not-started step after, while it's open
  const [nextFrom, setNextFrom] = useState<SessionInfo | null>(null);
  // the landscape's selection besides the selected session: an area selected as a whole (the selection bar's)
  const [selArea, setSelArea] = useState<string | null>(null);
  // where the workspace a right-click's New workspace makes goes (resolveLayout); `took` names the session placed
  // there, and it's let go once that session's place is saved, or `until` passes without one
  const [placeHint, setPlaceHint] = useState<(PlaceHint & { created?: boolean; until?: number }) | null>(null);
  // several workspaces' Close…: asked once (closeMany), then each closed as its own Close would, one dialog at a time
  const [closeMany, setCloseMany] = useState<SessionInfo[] | null>(null);
  const [closeQueue, setCloseQueue] = useState<string[]>([]);
  // Start now's confirm: the not-started step, and where main says it starts
  const [startAsk, setStartAsk] = useState<{ step: SessionInfo; where: string } | null>(null);
  // pipeline templates (W9): the picker, opened in an area (or none), and Save as template's dialog
  const [templatePicker, setTemplatePicker] = useState<{ area: string | null } | null>(null);
  const [templateSave, setTemplateSave] = useState<{ draft: TemplateDraft; leftOut: string[] } | null>(null);
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
  // the side bar's width snaps (the landscape re-fits once); shown again, its contents slide in from the rail
  const sideInner = useRef<HTMLDivElement>(null);
  const sideWasCollapsed = useRef(sideCollapsed);
  useLayoutEffect(() => {
    if (sideWasCollapsed.current && !sideCollapsed && sideInner.current)
      play(sideInner.current, [{ opacity: 0, transform: "translateX(-12px)" }, { opacity: 1, transform: "none" }], { duration: D.s, easing: EASE.enter });
    sideWasCollapsed.current = sideCollapsed;
  }, [sideCollapsed]);
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  /** The join prompt was closed by the user's own press or Esc: the landscape it was gone to from gets its keyboard armed. */
  const joinLeft = useRef(false);
  const joinDone = useCallback((left: boolean) => {
    joinLeft.current = left;
    setJoinShown(null);
  }, []);
  // team rooms: rooms whose admin made backups to origin available and this member hasn't answered for theirs; Not now is an answer, closing asks again next start
  const [laterConsents, setLaterConsents] = useState<string[]>([]);
  // team rooms: the House board — the room whose board is open
  const [boardDlg, setBoardDlg] = useState<string | null>(null);
  // area, stack and session renames use a dialog rather than a field in place: a name shows in several places at
  // once (the area tree, the landscape's headers and tabs), and a second edit field mounted for it takes the focus
  // from the first, closing it
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
    if (next !== renameDlg.key) {
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
  const [sideW, setSideW] = usePersisted<number>("mb.sideW", 264);
  const [editor, setEditor] = useState(EMPTY_EDITOR);
  const [search, setSearch] = useState<SearchState>(() => ({ q: "", ...readPref("mb.search", { scope: "conversations", regex: false, matchCase: false }) }));
  useEffect(() => {
    writePref("mb.search", { scope: search.scope, regex: search.regex, matchCase: search.matchCase });
  }, [search.scope, search.regex, search.matchCase]);
  const [searchFocus, setSearchFocus] = useState(0);
  // Run and Debug: every service's state, and the log panel under the landscape (⌘J)
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
  // why they couldn't be read, until they are: a card's cost badge shows "—" meanwhile rather than nothing. A reading
  // (asked, or pushed as the index catches up) is the meters or why there are none; each new reason is said once
  const [metersError, setMetersError] = useState<string | null>(null);
  const metersSaid = useRef<string | null>(null);
  useEffect(() => {
    const take = (r: IpcResult<Meters>) => {
      if (isErr(r)) {
        if (metersSaid.current !== r.error) readFailed("the token meters", r);
        metersSaid.current = r.error;
        setMeters(null); // what's shown from them would otherwise go stale beside "cost —"
        return setMetersError(r.error);
      }
      metersSaid.current = null;
      readCleared("the token meters");
      setMeters(r);
      setMetersError(null);
    };
    Promise.resolve(window.mb.metersGet()).then(take, (err: unknown) => take({ error: err instanceof Error ? err.message : String(err) }));
    return window.mb.onMetersChanged(take);
  }, []);
  const runningIn = (cwd: string) => runStates.filter((s) => s.worktree === cwd && (s.status === "running" || s.status === "starting")).length;
  /** Show a side bar view, from anywhere: the side bar lives on the Sessions tab. */
  const showView = (v: SideView) => {
    setTab("sessions");
    // the side bar is the area tree, and the other views are tool windows
    const tool = toolOfView(v);
    if (tool) return showTool(tool, sessions.find((s) => s.id === focused) ?? null);
    setLsTeam(false);
    setSideCollapsed(false);
  };
  // on the landscape the side bar shows the Team view's room list in place of the area tree (the Connected line)
  const [lsTeam, setLsTeam] = useState(false);
  /**
   * A room's chat, from a clicked mention notification or the Connected line: the room's area, flown to, with its Chat
   * window; with no room named (the line, with several rooms), the Team view's room list in the side bar, where each
   * room's Leave and join requests are.
   */
  const openRoom = (roomId: string | null) => {
    const room = roomId && teamStatus && !isErr(teamStatus) ? teamStatus.rooms.find((r) => r.id === roomId) : undefined;
    setTab("sessions");
    const key = room?.groupKey;
    const area = key ? layoutNow.current?.areas.find((a) => a.key === key) : undefined;
    if (!key || !area) return teamViewOn(roomId);
    goToArea(key);
    if (!area.rect.collapsed) return void (showTool("chat", null, key) || teamViewOn(roomId));
    // collapsed: opened first, and its Chat placed once the layout has it open (the effect below)
    setRoomChatAfterOpen({ key, roomId });
    void lsSaves.update({ areas: { [key]: { collapsed: false } } }, `${areaTitle(key)} opened`).then((error) => {
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

  /** Auto-name for a new stack in group `top`. */
  const nextSubName = (top: string): string => freeSubName(workSessions.filter((s) => topOf(s) === top).map(subOf));

  /**
   * Read the closed sessions (main's resumable ones) again: whether it could be. A failed read is said, and tried again
   * (closedFails), as the Closed sessions list, the ghosts and a rename on its way (renamesLeft) all wait on it.
   */
  const readClosed = async (): Promise<boolean> => {
    const [previous, notYet]: (SessionInfo[] | { error: string })[] = await Promise.all([window.mb.resumableSessions(), window.mb.plannedSessions()]);
    // the not-started steps are read with the closed sessions, and a read of either failing is the read failing: a step
    // left out would be placed over by a new workspace (withoutGone), and its wires drawn to nothing
    const failed = isErr(previous) ? previous : isErr(notYet) ? notYet : null;
    if (failed) {
      readFailed(CLOSED_READ, failed);
      setClosedFails((n) => n + 1);
      return false;
    }
    setPlanned(notYet as SessionInfo[]);
    // debriefs aren't reopened with the other sessions: they live on the WorkTracker tab
    setResumable((previous as SessionInfo[]).filter((s) => !s.debrief));
    listLoaded("resumable");
    setClosedFails(0);
    readCleared(CLOSED_READ);
    return true;
  };
  /** Read which closed sessions' folders are gone: those that can't run where they ran offer to start fresh instead. A failed read is said, and tried again (goneFails). */
  const readGone = async () => {
    const gone: MissingFolder[] | { error: string } = await window.mb.missingFolders();
    if (isErr(gone)) {
      readFailed(GONE_READ, gone);
      setGoneFails((n) => n + 1);
      return;
    }
    setGoneFolders((p) => (p.size === gone.length && gone.every((g) => JSON.stringify(p.get(g.id)) === JSON.stringify(g)) ? p : new Map(gone.map((g) => [g.id, g]))));
    setGoneFails(0);
    readCleared(GONE_READ);
  };
  /** Re-read the session lists; the live list comes back (the one on screen when the read fails). */
  const refresh = async (): Promise<SessionInfo[]> => {
    const live: SessionInfo[] | { error: string } = await window.mb.listSessions();
    if (isErr(live)) readFailed("the session list", live);
    else {
      readCleared("the session list");
      setSessions(live);
      listLoaded("live");
    }
    await readClosed();
    await readGone();
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

  // a failed read of the closed sessions, or of their missing folders, is tried again, after 1 s, then 2, 4… up to 30 s,
  // until it's read
  const retryIn = (fails: number) => Math.min(CLOSED_RETRY_MAX_MS, 1000 * 2 ** (fails - 1));
  useEffect(() => {
    if (!closedFails) return;
    const t = setTimeout(() => void readClosed(), retryIn(closedFails));
    return () => clearTimeout(t);
  }, [closedFails]);
  useEffect(() => {
    if (!goneFails) return;
    const t = setTimeout(() => void readGone(), retryIn(goneFails));
    return () => clearTimeout(t);
  }, [goneFails]);
  useEffect(() => {
    refresh();
    window.mb.hooksInstalled().then(unlessError("whether the status hooks are installed", (ok: unknown) => setHooksOk(ok === true)));
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


  /** Carry a group's message mode across a rename: it lives in settings, keyed by top-level group. */
  const migrateGroupKeys = async (oldKey: string, newKey: string) => {
    const [oldTop, newTop] = [topOfKey(oldKey), topOfKey(newKey)];
    const mode = msgModes[oldTop];
    if (mode && oldTop !== newTop && (await setMsgMode(newTop, mode))) await setMsgMode(oldTop, "");
  };

  /** Move a session into a group (null = out of any); returns whether it moved. */
  const moveToGroup = async (id: string, group: string | null): Promise<boolean> => {
    if (isRemote(sessions.find((s) => s.id === id))) return false; // a teammate's: only its owner moves it
    return !failed("Couldn't move the session", await window.mb.setGroup(id, group));
  };

  /**
   * Show session `s` and give its terminal the keyboard. `since`: the user's input as they asked for it (`inputStamp`),
   * for a jump that waited on main (resuming, starting a preset, opening a search hit): if they typed, pressed or a
   * dialog opened meanwhile, it's still shown, but the keyboard stays where it is.
   */
  const jumpToSession = (s: SessionInfo, since?: number) => {
    if (s.debrief) {
      setTab("worktracker"); // debriefs live on their own tab, not the landscape
    } else {
      // every workspace is on the landscape at once: this brings the session's into view
      setTab("sessions");
      revealWorkspace(s.id);
    }
    setFocused(s.id);
    const stale = () => since !== undefined && inputStamp() !== since;
    if (stale()) return;
    // A palette or menu closing as it's picked gives none back to what had it meanwhile, or a key typed straight after
    // would land in the session left.
    keyboardMoves();
    // its terminal gets the keyboard, or 50 ms later once it's there
    const give = () => {
      focusTerm(s.id);
      if (termHasKeys(s.id)) return;
      setTimeout(() => {
        if (stale()) return;
        focusTerm(s.id);
        if (termHasKeys(s.id) || !keyboardNowhere() || s.debrief) return;
        // its terminal isn't there to take it (the landscape zoomed out past it): the keyboard waits on the holder
        // (keyArm.ts), where typed keys do nothing and say why, not on the page, where Tab would walk on from the palette
        toNowhere();
        console.warn(`[mockingbird] ${s.id}'s terminal couldn't take the keyboard as it was gone to: it waits on the holder until a click or ⌘E`);
      }, 50);
    };
    // At once, unless something is open over the app (OVERLAYS). A palette or a menu row picked is closing as this runs:
    // looked at again the task after, once it has gone. A dialog still open then (a notification's jump came while one
    // was up) or the tour keeps the keyboard; the session is shown all the same.
    if (!document.querySelector(OVERLAYS)) return give();
    setTimeout(() => void (!document.querySelector(OVERLAYS) && !stale() && give()), 0);
  };
  const jumpTo = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (s) jumpToSession(s);
  };
  // the ui:command listener is registered once, so it must not capture jumpTo
  // directly — that closure would search the first render's empty session list
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;

  // team rooms: live panes — Follow brings the room session a teammate focuses (or the first they show) into view and
  // selects it, and picking another one stops it: the selection is what it watches, not what's on screen, which a
  // flight or a pan changes
  const followFocus = useMemo(() => (focused ? [focused] : []), [focused]);
  const follow = useFollow({
    views: roomLive.state?.views ?? [],
    sessions,
    shown: followFocus,
    groupOf: topOf,
    show: (_group, ids, f) => {
      const id = f ?? ids[0];
      if (!id) return;
      revealWorkspace(id);
      setFocused(id);
    },
  });


  // debrief sessions live on the WorkTracker tab, everything else on the landscape
  const workSessions = useMemo(() => sessions.filter((s) => !s.debrief), [sessions]);
  const debriefSessions = useMemo(() => sessions.filter((s) => s.debrief), [sessions]);

  // ---- the landscape: the Sessions tab's surface ----
  const landscapeStore = useLandscape();
  const liveOwn = useMemo(() => sessions.filter((s) => !isRemote(s)), [sessions]);
  const liveRemote = useMemo(() => sessions.filter(isRemote), [sessions]);
  const migration = useLandscapeMigration({
    store: landscapeStore,
    // set means teammates' sessions are all in it: main indexes them from the saved rooms as it starts
    lists: { ...listsLoaded, remote: roomLive.state !== null },
    live: liveOwn,
    resumable,
    remote: liveRemote,
    remoteError: roomLive.error,
    retryRemote: roomLive.retry,
  });
  // While reading the grid's layout in has failed, what moves on the landscape isn't saved: reading it in, on a retry or
  // the next launch, would put those places back. Each such save is refused and said, as the banner says; a stack's
  // front tab and an area's collapse or lock are saved (viewOnlyPatch), so a back tab can still be brought forward to
  // answer what waits in it. Reading it in, or keeping the landscape as it is, saves through the store itself. (A file
  // that can't be read is a stand-in main never saves, and says so.)
  const readInFailed = useRef(false);
  readInFailed.current = !!migration.failed;
  const lsSaves = useMemo(() => {
    const save = (patch: LandscapePatch, what: string): Promise<LandscapeSave> =>
      readInFailed.current && !viewOnlyPatch(patch) ? Promise.resolve({ error: NOT_READ_IN }) : landscapeStore.save(patch, what);
    const update = async (patch: LandscapePatch, what: string): Promise<string | null> => {
      const r = await save(patch, what);
      return "error" in r ? r.error : null;
    };
    return { save, update };
  }, [landscapeStore.save]);
  const landscapeState = landscapeStore.state;
  // shown once the grid's layout is read in, or once it can't be: a layout made up before that would be redrawn
  // (and every terminal resized) when the migration lands
  const landscapeShown = !!landscapeState && (migration.step.kind === "done" || migration.step.kind === "blocked" || !!migration.failed);
  // groups renamed here whose changes (the session list, the landscape's re-keying, teammates' sessions) haven't all
  // arrived: the layout keeps each under the key the landscape holds it under meanwhile
  const [lsRenames, setLsRenames] = useState<PendingRename[]>([]);
  // the closed sessions this Mac can reopen, with their room tags as a running one has (a copy a teammate took over says
  // so): the landscape's ghosts, and the Closed sessions list
  const closedSessions = useMemo(() => mergeRoomSessions(resumable, roomLive.state && { ...roomLive.state, remote: [] }), [resumable, roomLive.state]);
  // what the landscape draws as ghosts: the closed sessions and the steps not started yet (resolveLayout's `closed`),
  // so places, groups, renames and pushes are the ghost machinery's for both. Never published, listed or reopened as closed
  const lsClosed = useMemo(() => (planned.length ? [...closedSessions, ...planned] : closedSessions), [closedSessions, planned]);
  useEffect(() => {
    if (!lsRenames.length || !landscapeState) return;
    const left = renamesLeft(lsRenames, landscapeState.landscape, workSessions, lsClosed);
    if (left.length !== lsRenames.length) setLsRenames(left);
  }, [lsRenames, landscapeState, workSessions, lsClosed]);
  // every session there is, once each list has been read: a place kept for none of them takes no room (withoutGone)
  const knownSessions = useMemo(
    () => (listsLoaded.live && listsLoaded.resumable && roomLive.state !== null ? [...sessions, ...resumable, ...planned] : null),
    [listsLoaded.live, listsLoaded.resumable, roomLive.state, sessions, resumable, planned]
  );
  const lsPlaced = useMemo(() => (landscapeState ? withoutGone(landscapeState.landscape, knownSessions, lsRenames) : null), [landscapeState, knownSessions, lsRenames]);
  const landscapeLayout = useMemo(
    () => (landscapeShown && lsPlaced ? resolveLayout(lsPlaced, workSessions, undefined, lsRenames, placeHint, lsClosed) : null),
    [landscapeShown, lsPlaced, workSessions, lsRenames, placeHint, lsClosed]
  );
  /** The Closed sessions list: the closed sessions with no ghost on the landscape; all of them until it's laid out. */
  const closedList = useMemo(() => closedListOf(closedSessions, landscapeLayout), [closedSessions, landscapeLayout]);
  /** The closed session a Start fresh is letting go of now, so the effect below starts that once. */
  const lettingGo = useRef<string | null>(null);
  // a right-click's place: kept for the session placed there until its place is saved (let go sooner, the next layout
  // would place it as any new one, and save that over it), or until it's been made and none took it
  useEffect(() => {
    if (!placeHint) return;
    if (placeHint.took && landscapeState && Object.hasOwn(landscapeState.landscape.workspaces, placeHint.took)) {
      // Start fresh: the new workspace has the ghost's place now, so the closed session it stands in for is let go, its
      // place first; the hint (which keeps its ghost from being drawn) stays until then
      const was = placeHint.replaces ? resumable.find((s) => s.id === placeHint.replaces) : undefined;
      if (!was) return setPlaceHint(null);
      if (lettingGo.current === was.id) return;
      // its wires go first, to the session its dialog made (onCreated), whichever took the place; until the dialog has
      // said which that is, it waits (onCreated's change to the hint runs this again)
      const move = freshMove.current?.from === was.id ? freshMove.current : null;
      if (!move) return;
      lettingGo.current = was.id;
      const hint = placeHint;
      // those that can't move go with it, and the note says why
      void move.done
        .then((why) => {
          if (why) unmovedWires.current.set(was.id, why);
          return forgetGhosts([was], `letting ${titleOf(was)} go for the fresh session in its place`, true);
        })
        .finally(() => {
          // none went with it (it wasn't forgotten, or the book couldn't be changed either): why they stayed is still said
          const left = unmovedWires.current.get(was.id);
          unmovedWires.current.delete(was.id);
          if (left) lsSay(unmovedNote(titleOf(was), left));
          if (freshMove.current === move) freshMove.current = null;
          lettingGo.current = null;
          setPlaceHint((h) => (h === hint ? null : h));
        });
      return;
    }
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
  const [reveal, setReveal] = useState<RevealAsk | null>(null);
  /**
   * Bring a session's workspace into view on the landscape (in front, if it's a stack's tab), and with `focus` fill the
   * window with it; `keys` gives the landscape the keyboard once it's there, `avoid` is a box on screen to keep it clear of.
   */
  const revealWorkspace = (id: string, focus = false, o: { keys?: boolean; avoid?: ScreenBox | null } = {}) => {
    // a teammate waiting to type in it: it comes in at 100%, where its strip's Allow and Deny take a click
    const s = sessions.find((x) => x.id === id);
    setReveal({ id, n: ++asked.current, focus, answer: !!s && typingAsksOf(s).length > 0, ...o });
  };
  // going to an area on the landscape: the area tree, the switcher, ⌘K
  const [goTo, setGoTo] = useState<GoToAsk | null>(null);
  const goToArea = (area: string, avoid: ScreenBox | null = null) => {
    setTab("sessions");
    setGoTo({ area, n: ++asked.current, avoid });
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

  // the groups shown as team rooms
  const roomGroups = useMemo(() => teamRooms.map((r) => r.groupKey), [teamRooms]);
  // this Mac's top-level groups, then the rooms': the status bar counts them until the landscape's layout is read
  const outline = useMemo(() => sessionOutline(visible, roomGroups, !!filter), [visible, roomGroups, filter]);
  const groupCount = outline.filter((e) => e.kind === "group").length;

  // the Team view's stack folders, opened and shut by their chevrons: open to begin with
  const [wsOpen, setWsOpen] = useState<Record<string, boolean>>({});

  const bySub = (list: SessionInfo[]): [string, SessionInfo[]][] => {
    const m = new Map<string, SessionInfo[]>();
    for (const s of list) {
      const sub = subOf(s) ?? "";
      m.set(sub, [...(m.get(sub) ?? []), s]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])); // "" (no sub) first
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
    const r = forget ? await forgetSession(s) : await window.mb.killSession(s.id, false);
    if (isErr(r)) return r.error;
    disposeTerm(s.id);
    refresh();
    return null;
  };
  /**
   * Let session `s` go for good in main, and the places the landscape keeps for it (forgetPatch, read before it goes: its
   * stack's tabs are in the layout until then). Every forget goes through here or forgetGhosts, so no place is left
   * taking room nobody sees. Before the layout is read there's none to read: a place left in its file is passed over (withoutGone).
   */
  const forgetSession = async (s: SessionInfo): Promise<unknown> => {
    const l = lsNow.current?.landscape;
    const layout = layoutNow.current;
    const r = await window.mb.killSession(s.id, true);
    if (!isErr(r) && l && layout) await lsChange(forgetPatch(l, layout, [s.id]), `letting ${titleOf(s)}'s place go`);
    return r;
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
  // A closed session stays resumable, its ghost where it was (docs/landscape.md, Ghost cards).
  const requestClose = async (s: SessionInfo) => {
    const hasWorktree = s.repoPath && s.branch && s.cwd !== s.repoPath;
    if (!hasWorktree) return closeNow(s, false);
    const st: WorktreeStateInfo | { error: string } = await window.mb.worktreeState(s.cwd);
    if ("error" in st) {
      if (worktreeGone(st.error)) return closeNow(s, false);
      return askClose(s, st); // unknown state: the dialog says why and only keeps
    }
    if (!st.dirty && st.ahead === 0) return closeNow(s, false);
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
    const since = inputStamp();
    await refresh();
    // the old one, kept to reopen, stays as its ghost; the new one is beside it (placeBesideOf)
    setPlaceHint((h) => h && { ...h, created: true, until: Date.now() + PLACE_HINT_MS });
    if (closeOld && !failed(`Couldn't close ${titleOf(old)}`, await window.mb.killSession(old.id, false))) {
      disposeTerm(old.id);
      refresh();
    }
    setFocused(next.id);
    revealWorkspace(next.id);
    // the keyboard follows only if the user didn't type, press or get a dialog while it waited on main
    setTimeout(() => inputStamp() === since && focusTerm(next.id), 50);
  };

  const resumeDead = async (s: SessionInfo) => {
    const since = inputStamp();
    // team rooms: a teammate continues it, so this copy doesn't run again (its pane stays until it's closed); main
    // checks too, for a take-over this window hasn't heard of, before it lets the pty go
    const info = await resumeExited(titleOf(s), {
      refusal: takenOverWhy(s, "rather than resuming this copy"),
      costOk: () => costGate.resume(s),
      resume: () => window.mb.resumeSession(s.id),
      dispose: () => disposeTerm(s.id),
      refresh,
      say: alert,
    });
    if (!info) return;
    await refresh();
    jumpToSession(info, since);
  };

  // ⌥⇥ cycles waiting sessions, oldest wait first
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
      toggleTool("files");
      return;
    }
    // the landscape's area tree to the rail and back (design M); the area switcher stands in for it meanwhile
    if (cmd && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key === "\\" && tab === "sessions") {
      handled();
      if (sideCollapsed) showView("sessions");
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
      const tool = tab === "sessions" ? toolOfView(v) : null;
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
      density="min"
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
  const [lsNotice, setLsNotice] = useState<LandscapeNote | null>(null);
  // a notice is said where you are: over the landscape while it's on screen, else in the status bar (one said on
  // another tab isn't kept for the landscape to show later, out of its context)
  const landscapeOnScreen = useRef(false);
  landscapeOnScreen.current = tab === "sessions" && landscapeShown && !!landscapeLayout;
  const barNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Say `text` where the view is, over the landscape with `action` (Tidy's Undo) as a button beside it. */
  const lsSay = (text: string, action?: NoteAction) => {
    if (landscapeOnScreen.current) return setLsNotice((p) => ({ text, n: (p?.n ?? 0) + 1, action }));
    setStatusNote(text);
    if (barNoteTimer.current) clearTimeout(barNoteTimer.current);
    barNoteTimer.current = setTimeout(() => setStatusNote(""), 6000);
  };
  // keys swallowed with the keyboard nowhere (keyArm.ts's holder) say why once each time it goes there: the landscape
  // says it itself while it's up, the status bar anywhere else
  useEffect(() => {
    const on = () => void (!landscapeOnScreen.current && lsSay("Nothing has the keyboard: click where you want to type, or Tab to the top bar"));
    document.addEventListener(KEYS_SWALLOWED, on);
    return () => document.removeEventListener(KEYS_SWALLOWED, on);
  }, []);
  /** A change to the landscape; what stopped it is said over the landscape. */
  const lsChange = async (patch: LandscapePatch | null, what: string) => {
    if (!patch) return;
    const error = await lsSaves.update(patch, what);
    if (error) lsSay(`${what}: not saved, ${error}`);
  };
  /** The closed session a Start fresh stands in for, while its New session is open. */
  const freshFrom = useRef<SessionInfo | null>(null);
  /** A Start fresh's move of the old session's wires to the session its dialog made, for its ghost's letting go to wait on. */
  const freshMove = useRef<{ from: string; done: Promise<string | null> } | null>(null);
  /** Why a Start fresh's session couldn't take the old one's wires, by the old one's id, for the note as they go with it. */
  const unmovedWires = useRef(new Map<string, string>());
  /** The closed sessions being forgotten now (forgetGhosts), so a note on wires dropped with one names it. */
  const forgettingNow = useRef(new Set<string>());
  /**
   * Start fresh: session `old`'s wires and note go to `next` (wires:rekey, all or none). Resolves to why they couldn't,
   * logged, or null.
   */
  const moveWires = async (old: SessionInfo, next: string): Promise<string | null> => {
    const r = await Promise.resolve(window.mb.wiresRekey(old.id, next)).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    const why = isErr(r) ? r.error : "refused" in r ? r.refused : null;
    if (why) console.warn(`[mockingbird] ${old.id}'s wires didn't move to ${next}: ${why}`);
    return why;
  };
  const knownNow = useRef(knownSessions);
  knownNow.current = knownSessions;
  // wires main drops with a forgotten session are said: which, and why they didn't move first when a Start fresh's couldn't
  useEffect(
    () =>
      window.mb.onWiresChanged((c) => {
        if (!c.dropped?.length) return;
        const gone = c.dropped.flatMap((d) => [d.wire.from, d.wire.to]).find((id) => forgettingNow.current.has(id)) ?? null;
        const unmoved = gone ? (unmovedWires.current.get(gone) ?? null) : null;
        if (gone) unmovedWires.current.delete(gone);
        const name = (id: string) => {
          const s = knownNow.current?.find((x) => x.id === id);
          return s ? titleOf(s) : null;
        };
        lsSay(droppedNote(c.dropped, gone, name, unmoved));
      }),
    []
  );
  // a menu's pick (or a dialog's) acts on the landscape as it is then, not as it was when the menu opened
  const lsNow = useRef(landscapeState);
  lsNow.current = landscapeState;
  const layoutNow = useRef(landscapeLayout);
  layoutNow.current = landscapeLayout;
  const placedNow = useRef(lsPlaced);
  placedNow.current = lsPlaced;
  /** Closed sessions being reopened or forgotten now: their Reopen and Forget are off until that's done (whileClosedBusy). */
  const [closedBusy, setClosedBusy] = useState<ReadonlySet<string>>(() => new Set());
  const closedBusyNow = useRef(new Set<string>());
  /** A Reopen all under way: another waits for it to finish. */
  const [reopeningAll, setReopeningAll] = useState(false);
  const reopeningAllNow = useRef(false);
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

  // a Search window keeps its own query; the options it last set (scope, regex, case) are the next one's (mb.search)
  const [winSearch, setWinSearch] = useState<Record<string, SearchState>>({});
  const searchOf = (key: string): [SearchState, (st: SearchState) => void] => [
    winSearch[key] ?? { ...search, q: "" },
    (st) => {
      setWinSearch((m) => ({ ...m, [key]: st }));
      setSearch(st);
    },
  ];
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
   * A tool window's view (`key`, the window's id). `s` is the session it works on (one of this Mac's), `area` the
   * area it's of; `beside` is the window's place, where a card it places goes next to.
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
  /** A session main starts from `author` (`start`), placed beside or under its workspace in its area and shown. Returns why it couldn't start. */
  const startFrom = async (author: SessionInfo, start: () => Promise<IpcResult<SessionInfo>>, what: string, under = false): Promise<string | null> => {
    placeBesideOf(author, under);
    const info = await start();
    if (isErr(info)) {
      setPlaceHint(null);
      return `Couldn't ${what}: ${info.error}`;
    }
    await refresh();
    setPlaceHint((h) => h && { ...h, created: true, until: Date.now() + PLACE_HINT_MS });
    revealWorkspace(info.id);
    return null;
  };
  /** A second opinion: the other agent reviews `author`'s branch and messages its findings back. It opens beside it. */
  const startReview = (author: SessionInfo) => startFrom(author, () => window.mb.reviewStart(author.id), "start the review");
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
  /**
   * A session that goes on from `s` (or reviews it), made from now on: beside its workspace on the landscape, however
   * long it takes to make (resolveLayout's PlaceHint); a terminal on its tree goes `under` it, as Tidy puts one.
   */
  const placeBesideOf = (s: SessionInfo, under = false) => {
    const t = tileOfSession(s.id);
    setPlaceHint(t ? { area: t.area, at: under ? { x: t.rect.x, y: t.rect.y + t.rect.h + GAP } : { x: t.rect.x + t.rect.w + GAP, y: t.rect.y }, since: Date.now() } : null);
  };
  /** Plan `plan` carried out (carryPlan), or its refusal said. Whether it was. */
  const carry = async (plan: AreaPlan, what: string): Promise<boolean> => {
    const before = lsNow.current?.landscape;
    if ("refused" in plan) {
      lsSay(plan.refused);
      return false;
    }
    if (!before) {
      lsSay(`Not done, ${what}: ${LAYOUT_LOADING}`);
      return false;
    }
    return !!(await carryPlan(plan, what, { before, send: lsSaves.save, moves: runMoves, say: lsSay }));
  };
  /** Stack `stack`'s tabs of this Mac's each a workspace of its own (Unstack, the Team view's ✕). */
  const unstackStack = (stack: string) => {
    const layout = layoutNow.current;
    if (!layout) return lsSay(`Can't unstack ${splitGroupKey(stack).sub ?? stack}: ${LAYOUT_LOADING}`);
    void carry(planUnstackAll(layout, stack, areaTitle), `unstacking ${splitGroupKey(stack).sub ?? stack}`).then(() => refresh());
  };
  /** New session's dialog for another session in one card with `s`: a tab of its stack, or the stack that starts with it. */
  const newTabOf = (s: SessionInfo, t: Tile | null): Can => {
    const layout = layoutNow.current;
    const l = lsNow.current?.landscape;
    if (isRemote(s)) return { no: `${s.room?.ownerName ?? "A teammate"}'s session: only its owner adds tabs beside it` };
    if (t?.stack) return () => newSessionIn(t.stack!);
    if (!t || t.area === LOOSE_GROUP) return { no: "It's in no area: a stack is part of an area" };
    if (s.status === "dead") return { no: "Its session has exited: resume it first" };
    if (!l || !layout) return { no: `Not yet: ${LAYOUT_LOADING}` };
    if (layout.areas.find((a) => a.key === t.area)?.rect.locked) return { no: `${areaTitle(t.area)} is locked: unlock it to stack its workspaces` };
    return () => startWorkspaceFrom(s, `${t.area}/${newStackName(l, layout, t.area)}`);
  };
  /** Where a template dialog gives the keyboard as it closes, rather than back to a terminal: the landscape (focus's frame in focus). */
  const landscapeHome = () => document.querySelector<HTMLElement>(".ls-focus") ?? document.querySelector<HTMLElement>(".ls-viewport");
  /**
   * Save as template (W9) from `s`: the chain of handoff and feedback wires through it (the pipeline strip's, chainOf),
   * first to last, drafted by main (what it keeps, redacted) and shown whole before it's saved. Not offered on a
   * workspace no wire reaches, as its strip isn't; off, saying why, on a terminal, a teammate's workspace, or one no
   * handoff or feedback wire runs through.
   */
  const saveTemplateOf = (s: SessionInfo): Can | undefined => {
    const read = wiresNow();
    const links = read.state?.book?.links;
    if (links && !Object.values(links).some((w) => w.from === s.id || w.to === s.id)) return undefined;
    if (s.shell) return { no: "It's a terminal: save the chain from an agent on its tree" };
    if (isRemote(s)) return { no: `${s.room?.ownerName ?? "A teammate"}'s session: a template is saved from your own workspaces` };
    if (!links) return { no: `Wires can't be read right now${read.error ? `: ${read.error}` : ""}` };
    const known = [...sessions, ...resumable, ...planned];
    const chain = chainOf(
      s.id,
      links,
      (id) => ((x) => (x ? { title: titleOf(x), agent: x.shell ? "terminal" : (x.agent ?? "claude"), status: x.status, where: "open" as const } : null))(known.find((x) => x.id === id)),
      () => ({ state: "idle", gate: "ask" })
    );
    if (!chain || (!chain.up.length && !chain.down.length)) return { no: "No handoff or feedback wire runs through it: a template is a chain of steps" };
    const steps = [...chain.up, chain.here, ...chain.down];
    const leftOut = [...new Set(steps.flatMap((x) => x.also.map((a) => a.end?.title ?? a.id)))];
    return () =>
      void window.mb.templatesDraft(steps.map((x) => x.id)).then(
        (r: IpcResult<TemplateDraft>) => (isErr(r) ? lsSay(`Couldn't save it as a template: ${r.error}`) : setTemplateSave({ draft: r, leftOut })),
        (err: unknown) => lsSay(`Couldn't save it as a template: ${err instanceof Error ? err.message : String(err)}`)
      );
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
      stack:
        t?.stack && landscapeLayout
          ? {
              name: splitGroupKey(t.stack).sub ?? t.stack,
              rename: () => setRenameDlg({ kind: "sub", key: t.stack!, initial: splitGroupKey(t.stack!).sub ?? t.stack! }),
              unstack: ((no) => (no ? { no } : () => unstackStack(t.stack!)))(unstackRefusal(landscapeLayout, t.stack, areaTitle)),
            }
          : null,
      newTab: newTabOf(s, t),
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
      tool: (k) => showTool(k, s),
      artifacts: artifactsOf(t, s, (area) => showTool("artifacts", null, area)),
      repaint: () => void resyncTerm(s.id),
      hidePanel: () => {
        if (!hideAgentPanel(s.id)) lsSay("The agent's diff panel isn't open any more");
      },
      undo: s.shell ? { no: "A terminal has no agent turns to undo" } : owner ? { no: `${owner}'s session: theirs to undo` } : !s.repoPath ? { no: "It isn't in a git repository, so its turns can't be put back" } : () => setUndoFor(s),
      handoff: noAgent ? { no: noAgent } : () => (placeBesideOf(s), setHandoffFor(s)),
      brief: noAgent ? { no: noAgent } : () => (placeBesideOf(s), setBriefFor(s)),
      secondOpinion: noAgent ? { no: noAgent } : !s.repoPath ? { no: "It isn't in a git repository: a second opinion reviews its branch" } : () => void startReview(s).then((e) => e && alert(e)),
      addTerminal: s.shell
        ? { no: "It's a terminal: add one from the agent whose tree it shares" }
        : owner
          ? { no: `${owner}'s session: only its owner adds a terminal on its tree` }
          : !s.repoPath
            ? { no: "It isn't in a git repository, so it has no tree to add a terminal on" }
            : () => void startFrom(s, () => window.mb.wiresAddTerminal(s.id), "add a terminal on its tree", true).then((e) => e && alert(e)),
      close: () => requestClose(s),
      // a copy a teammate took over is taken back, not resumed or worked on: the model refuses those (workspaceActions)
      resume: () => resumeDead(s),
      saveTemplate: saveTemplateOf(s),
    };
  };
  const tileOfSession = (id: string) => landscapeLayout?.tiles.find((t) => t.members.some((m) => m.id === id)) ?? null;
  /** A landscape workspace's actions: its front session's (or `s`'s, a tab of its stack), with its size. */
  const actionsFor = (t: Tile, s: SessionInfo = t.front, extra: Partial<WorkspaceEnv> = {}): ModelAction[] => workspaceActions(s, { ...wsEnv(s, t), ...extra });
  const connectRef = useRef<((s: SessionInfo) => Can) | null>(null);

  // ---- closed sessions (S6b): ghosts where they were on the landscape, and the Closed sessions list ----
  /** Say what happened to closed sessions: over the landscape when it's shown, else in a dialog (it's still being read in). */
  const closedSay = (text: string) => (landscapeShown ? lsSay(text) : window.alert(text));
  /**
   * Run `work` (`what`: "reopening Tag list notes") on closed sessions `ids` with their Reopen and Forget off meanwhile
   * (closedBusy); refused, saying so, while any of them is being reopened or forgotten already, so a second press can't
   * start it again. Its callers don't wait for it: what it throws is logged and said here.
   */
  const whileClosedBusy = async (ids: readonly string[], what: string, work: () => Promise<void>): Promise<void> => {
    if (ids.some((id) => closedBusyNow.current.has(id))) return closedSay(CLOSED_BUSY_WHY);
    for (const id of ids) closedBusyNow.current.add(id);
    setClosedBusy(new Set(closedBusyNow.current));
    try {
      await work();
    } catch (err) {
      console.error(`[mockingbird] ${what} (${ids.join(", ")}):`, err);
      closedSay(`Couldn't finish ${what}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const id of ids) closedBusyNow.current.delete(id);
      setClosedBusy(new Set(closedBusyNow.current));
    }
  };
  /** Whether closed session `s` can be reopened here now: not a copy a teammate continues, its folder runnable, and not under way. */
  const reopenableHere = (s: SessionInfo, busy: ReadonlySet<string> = closedBusy) => !takenOverWhy(s, "") && goneFolders.get(s.id)?.reopens !== false && !busy.has(s.id);
  /**
   * Reopen closed session `s`: where its ghost is, or (from the list) as a new workspace in its group's area, which is
   * formed around it again if it's gone, as for any running session; its group is never changed. Asking first when
   * resuming it would cost a lot. Main refuses one a teammate continues (relaunchGuard) for a window that hasn't
   * heard of the take-over yet, and one being reopened already.
   */
  const reopenGhost = (s: SessionInfo) =>
    whileClosedBusy([s.id], `reopening ${titleOf(s)}`, async () => {
      if (!(await costGate.resume(s))) return;
      const info: SessionInfo | null | { error: string } = await window.mb.relaunchSession(s.id);
      await refresh();
      if (isErr(info)) return closedSay(`Couldn't reopen ${titleOf(s)}: ${info.error}`);
      if (!info) {
        console.error(`[mockingbird] reopening ${s.id}: main has no record of it to relaunch`);
        return closedSay(`Couldn't reopen ${titleOf(s)}: its saved record is gone`);
      }
      setFocused(info.id);
      revealWorkspace(info.id);
    });
  /**
   * Reopen every one of `list` that can be (Reopen all): one at a time, skipping copies a teammate continues, ones
   * whose folders can't be run and ones under way, saying what was skipped and what failed (`where`: "in 5101", none
   * for the Closed sessions list). One at a time: a second waits for it (reopeningAll).
   */
  const reopenGhosts = async (list: readonly SessionInfo[], where: string) => {
    if (reopeningAllNow.current) return closedSay("Reopening them already: wait for that to finish");
    const can = list.filter((s) => reopenableHere(s, closedBusyNow.current));
    const skipped = list.length - can.length;
    reopeningAllNow.current = true;
    setReopeningAll(true);
    try {
      // one question for all of them when any would cost a lot to resume, as Reopen asks for one
      if (!(await costGate.resumeAll(can))) return;
      await whileClosedBusy(
        can.map((s) => s.id),
        `reopening ${can.length === 1 ? titleOf(can[0]) : `${can.length} closed sessions`}${spaced(where)}`,
        async () => {
          const failures: string[] = [];
          let reopened = 0;
          for (const s of can) {
            const info: SessionInfo | null | { error: string } = await window.mb.relaunchSession(s.id);
            if (isErr(info)) failures.push(`${titleOf(s)}: ${info.error}`);
            else if (!info) failures.push(`${titleOf(s)}: its saved record is gone`);
            else reopened++;
          }
          await refresh();
          if (failures.length) console.error(`[mockingbird] reopening closed sessions${spaced(where)}:`, failures);
          const parts = [`Reopened ${reopened} of ${list.length}${spaced(where)}`, skipped ? `${skipped} left closed (taken over, their folders gone, or under way)` : "", failures.length ? `couldn't reopen ${failures.join("; ")}` : ""];
          closedSay(parts.filter(Boolean).join(" · "));
        }
      );
    } finally {
      reopeningAllNow.current = false;
      setReopeningAll(false);
    }
  };
  /**
   * Forget closed sessions `list` (Forget, Clear ghosts, the Closed sessions list's): main lets each go, and the landscape
   * the places kept for them (forgetPatch, read before they go: a stack's tabs are in the layout until then). With
   * `placesFirst` (Start fresh's ghost) the places go first, so the ghost is never drawn over the session in its place;
   * if forgetting it then fails, it's in the Closed sessions list, and that's said.
   */
  const forgetGhosts = (list: readonly SessionInfo[], what: string, placesFirst = false) =>
    whileClosedBusy(
      list.map((s) => s.id),
      what,
      async () => {
        const l = lsNow.current?.landscape;
        const layout = layoutNow.current;
        if (placesFirst && l && layout) await lsChange(forgetPatch(l, layout, list.map((s) => s.id)), what);
        const gone: string[] = [];
        const failures: string[] = [];
        for (const s of list) {
          forgettingNow.current.add(s.id);
          const r = await window.mb.killSession(s.id, true).finally(() => forgettingNow.current.delete(s.id));
          if (isErr(r)) failures.push(`${titleOf(s)}: ${r.error}`);
          else gone.push(s.id);
        }
        if (!placesFirst && l && layout) await lsChange(forgetPatch(l, layout, gone), what);
        await refresh();
        if (failures.length) {
          console.error(`[mockingbird] ${what}:`, failures);
          closedSay(`${what}: couldn't forget ${failures.join("; ")}`);
        }
      }
    );
  /**
   * Start afresh where closed session `s` was (its folder can't be run): New session's dialog with its agent, area, repo
   * and ticket. From its ghost, the new workspace goes at the ghost's corner and takes its place once it's made
   * (PlaceHint.replaces); from the Closed sessions list, where new workspaces go, the closed one left to forget.
   */
  const startFresh = (s: SessionInfo, fromGhost: boolean) => {
    const g = fromGhost ? layoutNow.current?.ghosts.find((x) => x.members.some((m) => m.id === s.id)) : undefined;
    if (fromGhost && !g) {
      console.warn(`[mockingbird] starting fresh for ${s.id}: its ghost isn't on the landscape any more`);
      lsSay(`${titleOf(s)}'s ghost isn't on the landscape any more: the fresh session goes where new workspaces go`);
    }
    const area = areaKeyOf(s);
    setNewGroup(area === LOOSE_GROUP ? "" : (s.taskGroup ?? ""));
    setNewLaunch(s.shell ? "shell" : (s.agent ?? "claude"));
    setNewSeed({ ...(area !== LOOSE_GROUP ? areaSeed(area) : {}), ...(s.repoPath ? { repo: s.repoPath } : {}) });
    setPlaceHint(g ? { area, at: { x: g.rect.x, y: g.rect.y }, since: Date.now(), replaces: s.id } : null);
    freshFrom.current = s;
    setModal("new");
  };
  /**
   * Closed session `s`'s actions' needs (GhostEnv): `tabs` its stack's closed tabs when it's a stack's ghost (Reopen and
   * Forget act on them all), `fromGhost` whether it's drawn on the landscape (else it's in the Closed sessions list).
   */
  const ghostEnv = (s: SessionInfo, tabs: readonly SessionInfo[] = [s], fromGhost = true): GhostEnv => {
    const left = leftFor(s);
    const several = tabs.length > 1;
    return {
      gone: goneFolders.get(s.id) ?? null,
      tabs: tabs.length,
      reopenable: tabs.filter((t) => reopenableHere(t)).length,
      busy: tabs.some((t) => closedBusy.has(t.id)),
      room: leftCopyActions(left, () => left && takeBack(left), (err) => err && closedSay(`Couldn't send the changes: ${err}`)),
      reopen: () => void (several ? reopenGhosts(tabs, `in ${titleOf(s)}'s stack`) : reopenGhost(s)),
      fresh: () => startFresh(s, fromGhost),
      forget: () => void forgetGhosts(tabs, several ? `forgetting ${titleOf(s)}'s ${tabs.length} closed tabs` : `forgetting ${titleOf(s)}`),
    };
  };
  /** A ghost's actions (its card's buttons, ⋯ and right-click; a stack's closed tab's): `tabs` a stack ghost's closed tabs. */
  const ghostActionsFor = (s: SessionInfo, tabs?: readonly SessionInfo[]): ModelAction[] =>
    s.planned
      ? plannedActions({
          busy: closedBusy.has(s.id),
          start: () => void askStartStep(s),
          forget: () => void forgetGhosts([s], `forgetting ${titleOf(s)}`),
        })
      : ghostActions(s, ghostEnv(s, tabs));
  /** A ghost's foot: a closed session's status (closedStatus), a not-started step's where it will work (plannedWhere). */
  const ghostStatusOf = (s: SessionInfo): string => {
    if (!s.planned) return closedStatus(s, goneFolders.get(s.id));
    const titled = (id: string) => [...sessions, ...resumable, ...planned].find((x) => x.id === id);
    return plannedWhere(s, (id) => ((x) => (x ? titleOf(x) : null))(titled(id)));
  };
  /**
   * Start now…: says where not-started step `s` would start (main's describeStart: a folder it shares while its owner
   * works there, or a new worktree at a commit) and asks first. What main refuses, then or as it starts, is said.
   */
  const askStartStep = (s: SessionInfo) =>
    whileClosedBusy([s.id], `starting ${titleOf(s)}`, async () => {
      const where: IpcResult<string> = await window.mb.describeStart(s.id);
      if (isErr(where)) return closedSay(`Couldn't start ${titleOf(s)}: ${where.error}`);
      setStartAsk({ step: s, where });
    });
  /**
   * Start now, agreed to: not-started step `s` started from the commit the step before it is on (main's startPlanned),
   * where its card is. Its Start now and Forget are off meanwhile, as a ghost's are.
   */
  const startStep = (s: SessionInfo) =>
    whileClosedBusy([s.id], `starting ${titleOf(s)}`, async () => {
      const info: IpcResult<SessionInfo> = await window.mb.startPlanned(s.id);
      await refresh();
      if (isErr(info)) return closedSay(`Couldn't start ${titleOf(s)}: ${info.error}`);
      setFocused(info.id);
      revealWorkspace(info.id);
    });
  /**
   * Reopen all and Clear over closed sessions `list` (GhostsEnv), each a `what` ("closed workspace"), `where` the
   * words saying where they are ("in 5101"; none for the Closed sessions list, which is where they are).
   */
  const closedRowsOf = (list: readonly SessionInfo[], where: string, what: string): GhostsEnv => ({
    count: list.length,
    reopenable: list.filter((s) => reopenableHere(s)).length,
    running: reopeningAll,
    reopenAll: () => void reopenGhosts(list, where),
    clear: () => {
      const one = list.length === 1 ? titleOf(list[0]) : null;
      if (!window.confirm(one ? `Forget ${one}? It can't be reopened after.` : `Forget all ${list.length} ${what}s${spaced(where)}? They can't be reopened after.`)) return;
      void forgetGhosts(list, one ? `forgetting ${one}` : `forgetting ${list.length} ${what}s${spaced(where)}`);
    },
  });
  /**
   * Area `key`'s (LOOSE_GROUP: the loose ones'; null: every one's) Reopen all and Clear ghosts, over the closed sessions
   * the layout draws there now.
   */
  const ghostRows = (key: string | null, title: string): GhostsEnv =>
    closedRowsOf(landscapeLayout ? closedIn(landscapeLayout, key) : [], key === null ? "on the landscape" : key === LOOSE_GROUP ? "outside every area" : `in ${title}`, "closed workspace");
  /** The Closed sessions list's Reopen all and Forget all. */
  const closedListRows = (): GhostsEnv => closedRowsOf(closedList, "", "closed session");
  /** The loose closed workspaces' Reopen all and Clear ghosts, while there are any: the tree's Loose row, a right-click outside every area. */
  const looseGhostRows = (): ModelAction[] => {
    const g = ghostRows(LOOSE_GROUP, "Loose");
    return g.count ? ghostsActions(g) : [];
  };
  /**
   * Tidy area `key` (planTidy); the note says so with Undo, which puts every place back while nothing else has changed
   * the landscape since (its revision is still the one the Tidy made, as its save answered): after a drag, a lock or a new workspace placed,
   * putting the old places back could overlap them, so Undo says it can't.
   */
  const tidyArea = (key: string) => {
    const now = lsNow.current;
    const layout = layoutNow.current;
    const placed = placedNow.current;
    if (!now || !layout || !placed) return;
    const title = areaTitle(key);
    const plan = planTidy(placed, layout, key, areaTitle, wiresInOrder(wiresNow().state?.book?.links ?? {}).map(([, w]) => w));
    if ("refused" in plan) return lsSay(plan.refused);
    if (!plan.patch) return lsSay(`${title} is tidy already`);
    const back = undoOf(now.landscape, plan.patch);
    void lsSaves.save(plan.patch, `tidying ${title}`).then((r) => {
      if ("error" in r) return lsSay(`Tidying ${title}: not saved, ${r.error}`);
      const undo = () => {
        if (landscapeStore.revNow() !== r.rev) return lsSay(`Can't undo tidying ${title}: the landscape has changed since`);
        void lsChange(back, `putting ${title} back as it was`);
      };
      lsSay(plan.note ?? `Tidied ${title} in the order its workspaces were made`, back ? { label: "Undo", run: undo } : undefined);
    });
  };
  /**
   * Session `s`'s action `key` as its model has it, for what offers it outside the model's menus (the context chip,
   * the Changes tool, ⌘K), so none of them can run what the menus refuse.
   */
  const sessionAction = (s: SessionInfo, key: string): ModelAction | undefined => actionOf(workspaceActions(s, wsEnv(s, tileOfSession(s.id))), key);
  /** Its row for ⌘K (paneRow). */
  const paneAction = (s: SessionInfo, key: string): ModelAction | undefined => paneRow(s, wsEnv(s, tileOfSession(s.id)), key);
  /** Its context warning chip, with the model's Fresh session from a brief row (off, saying why, where it can't be; none on the Helpdesk tasks workspace). */
  const contextChipFor = (s: SessionInfo) => {
    const brief = sessionAction(s, "brief");
    return !s.shell && !isRemote(s) && (brief || s.role === "tasks") ? <ContextWarning session={s} brief={brief} /> : undefined;
  };
  /** What a workspace's header chips and footer show (WorkspaceNode). */
  const chromeFor = (s: SessionInfo): WorkspaceChrome => ({
    chips: {
      overlaps: overlaps.bySession[s.id],
      overlapsUnread: overlaps.unread[s.id],
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
  /** A group's bar: its area's header on the landscape. */
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
      onChat: () => showTool("chat", null, key),
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
    const flag = (fields: { collapsed: boolean } | { locked: boolean }, what: string) => void lsChange({ areas: { [key]: fields } }, what);
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
      // an area outlives its sessions (their ghosts come back to it); one with none, and no ghost, can go
      empty: !!a && !sessionsOfGroup(key).length && !(landscapeLayout && (closedIn(landscapeLayout, key).length || plannedIn(landscapeLayout, key).length)),
      messages: { mode: msgModes[key], defaultSend: msgDefaultSend, set: (mode) => void setMsgMode(key, mode), log: () => setMsgLogFor({}) },
      // following one of the room's teammates (FollowButtons' handlers): a room's area's only
      follow: ((f) => ({ leader: f.leader?.name ?? null, candidates: f.candidates, stop: f.stop, start: (member: string) => f.follow(member) }))(followIn(follow, room)),
      rename: () => setRenameDlg({ kind: "group", key, initial: key }),
      collapse: () => a && flag({ collapsed: !a.collapsed }, `${title} ${a.collapsed ? "opened" : "collapsed"}`),
      lock: () => a && flag({ locked: !a.locked }, `${title} ${a.locked ? "unlocked" : "locked"}`),
      tidy: landscapeLayout ? ((no) => (no ? { no } : () => tidyArea(key)))(tidyRefusal(landscapeLayout, key, areaTitle)) : null,
      ghosts: landscapeLayout ? ghostRows(key, title) : null,
      artifacts: () => showTool("artifacts", null, key),
      chat: () => showTool("chat", null, key),
      board: () => room && setBoardDlg(room.id),
      share: () => shareDialog(key, title),
      newSession: () => newSessionIn(key),
      ask: () => askGroupStatus(key),
      remove: () => void lsChange({ areas: { [key]: null }, ...extras() }, `removing ${title}`),
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
  /**
   * Add next step (W8) from `from`'s edge handle: New session's dialog for a not-started step after it, seeded as a
   * right-click's create rows are (the area's group, its first repo and base, `from`'s agent), with `from`'s repo first.
   * Dropped into an area, the step goes there at the drop; dropped outside every area or clicked, it goes in `from`'s
   * area, at the drop or beside `from` (resolveLayout's PlaceHint), the area growing to hold it.
   */
  const addNextStep = (from: SessionInfo, at: { area: string | null; point: { x: number; y: number } } | null) => {
    const own = areaKeyOf(from);
    // dropped into space: the area it was let go in, or none outside every area; from a handle's click, the source's
    const area = at ? at.area : own === LOOSE_GROUP ? null : own;
    setNewGroup(area ?? "");
    setNewLaunch(from.shell ? "claude" : (from.agent ?? "claude"));
    setNewSeed({ ...(area ? areaSeed(area) : {}), ...(from.repoPath && (!at?.area || at.area === own) ? { repo: from.repoPath } : {}) });
    if (at) setPlaceHint({ area: area ?? LOOSE_GROUP, at: at.point, since: Date.now() });
    else placeBesideOf(from);
    setNextFrom(from);
    setModal("new");
  };
  /**
   * Lay out (W9): template `req.template` as not-started steps and their wires in area `req.area` (made first when it
   * has none: steps not started make no area), then, once they're drawn, an area made for them tidied along its wires
   * (planTidy). In an area that was there already they go where there's room, and nothing there moves.
   * The one act that does it, from the picker's Lay out: main checks it all again and makes everything. Settles with
   * why nothing was laid out (an area made for it is taken back), or null.
   */
  const layOutTemplate = async (req: LayOutRequest): Promise<string | null> => {
    const l = lsNow.current?.landscape;
    if (!l) return `The landscape isn't read in yet: ${LAYOUT_LOADING}`;
    const area = newAreaPatch(l, req.area, req.repoPath ? { path: req.repoPath, base: req.base ?? null } : null);
    if (area) {
      const why = await lsSaves.update(area, `making ${req.area}'s area`);
      if (why) return `Its area couldn't be made: ${why}`;
    }
    let r: IpcResult<LayOutReply>;
    try {
      r = await window.mb.templatesLayOut(req);
    } catch (err) {
      r = { error: err instanceof Error ? err.message : String(err) };
    }
    if (isErr(r)) {
      console.warn(`[mockingbird] laying out ${req.name}: ${r.error}`);
      if (area) await lsChange({ areas: { [req.area]: null } }, `taking back ${req.area}'s area`);
      return r.error;
    }
    setTemplatePicker(null);
    await refresh();
    const started = r.steps.find((s) => s.id === r.started)?.title;
    // a terminal made on the first step's tree runs already: it waits for nothing
    const terminals = new Set(req.template.steps.filter((s) => s.agent === "terminal").map((s) => s.key));
    const waiting = r.steps.filter((s) => s.id !== r.started && !terminals.has(s.key)).length;
    const said = [
      `Laid out “${req.name}” in ${areaTitle(req.area)}:`,
      started ? `${started} started${waiting ? `, ${waiting === 1 ? "1 step waits" : `${waiting} steps wait`} for ${waiting === 1 ? "its" : "their"} handoffs` : ""}.` : `${waiting === 1 ? "its step waits" : `its ${waiting} steps wait`}.`,
      ...r.notes,
    ].join(" ");
    laidOut.current = { area: req.area, ids: r.steps.map((s) => s.id), wires: r.wires, said, tidy: !!area, until: Date.now() + LAID_OUT_WAIT_MS };
    setLaidTick((n) => n + 1);
    return null;
  };
  /** A lay-out made, until its steps and wires are drawn and (`tidy`: its area was made for it) tidied along them. */
  const laidOut = useRef<{ area: string; ids: string[]; wires: string[]; said: string; tidy: boolean; until: number } | null>(null);
  const [laidTick, setLaidTick] = useState(0);
  useEffect(() => {
    const p = laidOut.current;
    if (!p) return;
    const layout = layoutNow.current;
    const placed = placedNow.current;
    const links = wiresNow().state?.book?.links ?? {};
    const drawn = new Set([...(layout?.tiles ?? []), ...(layout?.ghosts ?? [])].flatMap((t) => t.members.map((m) => m.id)));
    if (!layout || !placed || !p.ids.every((id) => drawn.has(id)) || !p.wires.every((id) => Object.hasOwn(links, id))) {
      if (Date.now() < p.until) {
        const t = setTimeout(() => setLaidTick((n) => n + 1), 200);
        return () => clearTimeout(t);
      }
      laidOut.current = null;
      return lsSay(`${p.said} ${p.tidy ? "Its area wasn't tidied: its steps weren't drawn in time. Tidy it from its ⋯ once they are." : ""}`.trim());
    }
    laidOut.current = null;
    if (!p.tidy) {
      goToArea(p.area);
      return lsSay(`${p.said} They went where there was room in ${areaTitle(p.area)}, and nothing already in it moved: Tidy in its ⋯ lines them up along their wires, with Undo.`);
    }
    const plan = planTidy(placed, layout, p.area, areaTitle, wiresInOrder(links).map(([, w]) => w));
    goToArea(p.area);
    if ("refused" in plan) return lsSay(`${p.said} Its area wasn't tidied: ${plan.refused}`);
    if (!plan.patch) return lsSay(p.said);
    void lsSaves.save(plan.patch, `tidying ${areaTitle(p.area)}`).then((s) => lsSay("error" in s ? `${p.said} Its area wasn't tidied: ${s.error}` : p.said));
  }, [laidTick, landscapeLayout]);
  const saveTemplateNow = async (name: string, body: TemplateBody): Promise<string | null> => {
    let r: IpcResult<TemplateList>;
    try {
      r = await window.mb.templatesSave(name, body);
    } catch (err) {
      r = { error: err instanceof Error ? err.message : String(err) };
    }
    if (isErr(r)) {
      console.warn(`[mockingbird] saving the template ${name}: ${r.error}`);
      return r.error;
    }
    setTemplateSave(null);
    lsSay(`Saved the template “${name}”: Pipeline from a ticket… lays it out`);
    return null;
  };
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
    // outside every area: what's made there is loose, and so are the closed workspaces it offers back
    create: (area, at) => [
      ...createActions({
        launch: (kind) => newAt(area, at, { launch: kind }),
        helpdesk: () => void openHelpdesk(),
        ticket: () => newAt(area, at, { ticket: true }),
        importIt: () => newAt(area, at, { mode: "import" }),
        importMany: () => setModal("import"),
        pipeline: () => setTemplatePicker({ area }),
      }),
      ...(area ? [] : looseGhostRows()),
    ],
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
    // a closed session moved (a stack's closed tab goes with it) is read again: main says only live ones changed
    const closed = moves.some((m) => [...resumable, ...planned].some((s) => s.id === m.id));
    try {
      for (const [i, m] of moves.entries()) {
        const r = await settled(window.mb.setGroup(m.id, m.group));
        if (!isErr(r)) continue;
        const s = sessions.find((x) => x.id === m.id) ?? resumable.find((x) => x.id === m.id);
        console.error(`[mockingbird] ${what}: couldn't move ${m.id} to ${m.group ?? "no group"}:`, r.error);
        return { said: `${what}: ${s ? titleOf(s) : m.id} couldn't be moved (${r.error})${i ? `; ${i} of ${moves.length} moved` : ""}`, moved: i };
      }
      return null;
    } finally {
      if (closed) await refresh();
    }
  };
  // Make area…'s name, asked with the rename dialog; the landscape waits for it
  const [areaNameAsk, setAreaNameAsk] = useState<{ count: number; answer: (name: string | null) => void } | null>(null);
  const askAreaName = (count: number) => new Promise<string | null>((answer) => setAreaNameAsk({ count, answer }));
  // ---- Needs you (S7): the tray, N / ⇧N, and the areas' waiting counts (NeedsYou.tsx, needsYouModel.ts) ----
  const needs = useNeedsYou(sessions, joinAsks, (s) => tileOfSession(s.id)?.area ?? areaKeyOf(s), titleOf, teamStatus && isErr(teamStatus) ? teamStatus.error : null, pipelinesRead);
  const needsSel: NeedsSel = { session: selArea ? null : focused, area: selArea };
  // where N and Go there last went, so N moves on from it while the selection is still the one it left
  const needsLast = useRef<NeedsLast | null>(null);
  const needsAt = currentIndex(needs.items, needsSel, needsLast.current);
  /** The admin's prompt for join request `key`, put off with Later or not (the same prompt Members ▾ shows). */
  const showJoinAsk = (key: string) => {
    setLaterJoins((l) => l.filter((k) => k !== key));
    const ask = joinAsks.find((a) => joinKey(a.request) === key);
    if (ask) setJoinShown(ask);
    return !!ask;
  };
  const onLandscape = (area: string) => !!landscapeLayout?.areas.some((a) => a.key === area);
  /**
   * The view to an item, for N and Go there alike: its workspace brought into view (in front, when it's a stack's tab)
   * and selected, or its room's area flown to and selected. The keyboard never goes into the workspace's terminal:
   * Codex's approval prompt answers to a single y, a or n, so a habitual N, or any letter, typed there would answer
   * it. Enter (focus) or a click on the terminal gives it the keyboard. Go there (`go`) gives the landscape the
   * keyboard as the tray closes and shows a join request's prompt; `avoid` is the open tray's box, kept clear of.
   */
  const toNeeds = (item: NeedsItem, o: { go: boolean; avoid: ScreenBox | null }) => {
    const t = targetOf(item, sessions);
    if ("no" in t) {
      // N's place moves on to it all the same, so the next N goes past an item with nowhere to go (a ticket of no workspace here)
      needsLast.current = { id: item.id, sel: needsSel };
      return lsSay(t.no);
    }
    needsLast.current = { id: item.id, sel: selectionAfter(item, needsSel, onLandscape) };
    if ("session" in t) {
      setTab("sessions");
      revealWorkspace(t.session.id, false, { keys: o.go, avoid: o.avoid });
      return setFocused(t.session.id);
    }
    if (onLandscape(t.area)) {
      goToArea(t.area, o.avoid);
      selectArea(t.area);
    } else if (!o.go) return lsSay(`${areaTitle(t.area)} has no area on the landscape: Go there in Needs you shows the request`);
    if (!o.go) return;
    // the tray has gone, so the keyboard has nowhere to come back to: it's the landscape's once the prompt is answered
    if (showJoinAsk(t.requestKey)) keysAfterJoin.current = true;
    else {
      lsSay("That join request has been answered");
      setLandscapeKeys((k) => ({ n: k.n + 1, armed: true }));
    }
  };
  const [landscapeKeys, setLandscapeKeys] = useState({ n: 0, armed: false });
  const keysAfterJoin = useRef(false);
  // the prompt answered or put off: the landscape gets the keyboard, armed only when the user's own press or Esc closed
  // it (never the request going from under it, nor Enter, after which keys may still be coming)
  useEffect(() => {
    if (joinShown || !keysAfterJoin.current) return;
    keysAfterJoin.current = false;
    const armed = joinLeft.current;
    joinLeft.current = false;
    setLandscapeKeys((k) => ({ n: k.n + 1, armed }));
  }, [joinShown]);
  const stepNeeds = (dir: 1 | -1, avoid: ScreenBox | null = null) => {
    const next = stepItem(needs.items, needsAt, dir);
    if (!next) return lsSay(needs.joinError ? `Couldn't read the rooms' join requests: ${needs.joinError}` : "Nothing needs you right now");
    toNeeds(next, { go: false, avoid });
  };
  /**
   * A typing ask answered from the tray: the same main-process call, and checks, as its strip's buttons; what goes
   * wrong is said, and the item stays listed until main says the ask is gone.
   */
  const answerTyping = (sessionId: string, ask: { member: string; name: string }, choice: "minutes" | "deny"): Promise<string | null> =>
    decideTyping(sessionId, ask.member, choice).then((error) => {
      if (error) lsSay(`Couldn't answer ${firstName(ask.name)}: ${error}`);
      return error;
    });
  /**
   * A ticket's item opened (W15): its pipeline in the dialog, on the agent's request's PR form when it's one. The
   * dialog opening puts the tray away and hands the keyboard back to its button for when it closes: never a terminal.
   */
  const openTicketItem = (pl: NonNullable<NeedsItem["pipeline"]>) =>
    setPipelineFor({ id: pl.ticket, title: pipelines[pl.ticket]?.title ?? ticketOfGroup(pl.ticket)?.title ?? "", ...(pl.request ? { request: pl.request } : {}) });
  /** An item's actions (needsActions): a typing ask's answers, Go there and Dismiss, Go there off saying why when it can't be gone to; a ticket's Open, and a PR request's Dismiss…. */
  const needsActionsFor = (item: NeedsItem, close: () => void): ModelAction[] => {
    const target = targetOf(item, sessions);
    const ask = item.typing;
    const pl = item.pipeline;
    return needsActions({
      open: pl
        ? {
            can: () => openTicketItem(pl),
            title: pl.request
              ? "Open the pull request form, filled from the agent's request: nothing is pushed or opened until you press Push and open PR"
              : `Open #${pl.ticket}'s pipeline`,
          }
        : null,
      dismissRequest: pl?.request ? () => setDismissRequestFor({ ticket: pl.ticket, request: pl.request! }) : null,
      go: goCan(target, () => {
        close();
        toNeeds(item, { go: true, avoid: null });
      }),
      goTitle: item.join
        ? "Fly to the room's area and show the request: accept or decline it there"
        : ask
          ? "Bring it into view at 100%, where its strip has Allow for this session, Allow for 15 min and Deny"
          : item.kind === "finished"
            ? "Bring it into view and select it: Enter or a click on its terminal to type there"
            : "Bring it into view and select it, the keyboard kept off its prompt (a single letter can answer one): Enter or a click on its terminal to answer it",
      dismiss: () => needs.dismiss(item),
      answer:
        ask && item.session
          ? {
              who: firstName(ask.name),
              allow: () => answerTyping(item.session!, ask, "minutes"),
              deny: () => answerTyping(item.session!, ask, "deny"),
            }
          : null,
    });
  };
  /** The base branch a card's diff is measured against: its area's entry for the session's repo (null: the repository's own). */
  const badgeEnv = useMemo(
    () => ({
      baseOf: (s: SessionInfo, area: string) => {
        const a = landscapeState ? own(landscapeState.landscape.areas, area) : undefined;
        return a?.repos.find((r) => r.path === s.repoPath)?.base ?? null;
      },
      metersError,
      needIds: needs.sessions,
    }),
    [landscapeState, metersError, needs.sessions]
  );

  // the area tree: areas in the landscape's order, each with its workspaces (those the filter keeps)
  const treeAreas = useMemo((): TreeArea[] => {
    const order = landscapeLayout?.areas.map((a) => a.key) ?? [];
    const accents = accentsOf(order);
    const all = new Map(treeOf(workSessions, order).map((g) => [g.key, g.items]));
    const shownItems = new Map(treeOf(visible, order).map((g) => [g.key, g.items]));
    const keys = [...all.keys()];
    // loose ghosts have the Loose row (its right-click holds their Reopen all and Clear ghosts) with no running workspace loose
    if (!all.has(LOOSE_GROUP) && landscapeLayout && (closedIn(landscapeLayout, LOOSE_GROUP).length || plannedIn(landscapeLayout, LOOSE_GROUP).length)) keys.push(LOOSE_GROUP);
    return keys.map((key): TreeArea => {
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
        needs: needs.byArea.get(key) ?? 0,
        items: shownItems.get(key) ?? [],
      };
    });
  }, [landscapeLayout, workSessions, visible, teamStatus, needs.byArea]);

  // ---- first run: the migration tour, the empty landscape's place, the shortcuts sheet and + New ----
  const noteOf = (what: string) => readNotes.shown[what] ?? readNotes.dismissed[what] ?? null;
  const lsEmpty = emptyStateOf({
    layout: landscapeLayout ?? { areas: [], tiles: [], ghosts: [], windows: [], cards: [] },
    problems: landscapeState?.problems ?? [],
    standIn: readProblem(landscapeState),
    storeError: landscapeStore.error,
    migrationFailed: migration.failed,
    lists: {
      live: { read: listsLoaded.live, error: noteOf("the session list"), retry: () => void refresh() },
      closed: { read: listsLoaded.resumable, error: noteOf(CLOSED_READ), retry: () => void readClosed() },
      remote: { read: roomLive.state !== null, error: roomLive.error, retry: roomLive.retry },
    },
    closed: closedList.length,
  });
  // the tour is for a landscape read in whole: nothing unread could make it look like a fresh install, or the reverse
  const tourSettled = !!landscapeLayout && migration.step.kind === "done" && !readProblem(landscapeState) && knownSessions !== null && !landscapeState?.landscape.tourDone;
  const [tourEnded, setTourEnded] = useState(false);
  const tourDue = tourSettled && !tourEnded && !nothingToTour(landscapeLayout);
  /** The tour settled for good: seen, or with nothing to show. A save that fails is said; it's gone for this run either way. */
  const settleTour = (what: string) => {
    setTourEnded(true);
    void landscapeStore.update({ tourDone: true }, what, { flag: true }).then((error) => {
      if (!error) return;
      console.error(`[mockingbird] couldn't save ${what}:`, error);
      lsSay(`The tour may show again next time: ${error}`);
    });
  };
  const endTour = () => settleTour("that the tour has been seen");
  // Nothing to show a tour on means nothing was migrated: what's made from here on isn't what the tour is about, so
  // there's none later either.
  const noTour = tourSettled && !tourEnded && nothingToTour(landscapeLayout);
  useEffect(() => {
    if (noTour) settleTour("that there's nothing to tour");
  }, [noTour]);
  const [keysOpen, setKeysOpen] = useState(false);
  const [newAsk, setNewAsk] = useState(0);
  /** The top bar's + New: the create menu at the view's centre on the landscape; anywhere else, there's no view to place it in, so New session's dialog. */
  const newFromBar = () => (landscapeOnScreen.current ? setNewAsk((n) => n + 1) : setModal("new"));

  const landscapeMain = () => (
    <>
      <LandscapeBanners
        onKeep={() =>
          void migration.keep(layoutNow.current?.patch ?? null).then((error) => lsSay(error ? `Not kept: ${error}` : "Kept where they are: your grid's layout wasn't read in, and won't be"))
        }
        problems={landscapeState?.problems ?? []}
        error={landscapeStore.error}
        onReload={landscapeStore.reload}
        migration={migration}
      />
      {landscapeLayout && landscapeState ? (
        <div className="ls-row">
        <BadgeContext.Provider value={badgeEnv}>
        <Landscape
          connectRef={connectRef}
          resumeOk={costGate.resume}
          rooms={teamRooms}
          layout={landscapeLayout}
          stored={landscapeState.landscape}
          selected={focused}
          onSelect={setFocused}
          selectedArea={selArea}
          onSelectArea={selectArea}
          onCloseMany={(ids) => setCloseMany(sessions.filter((s) => ids.includes(s.id)))}
          onTab={(t, id) => {
            setFocused(id);
            if (t.stack) void lsChange({ stacks: { [t.stack]: { active: id, placement: t.rect } } }, "the stack's front tab");
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
          onPatch={lsSaves.save}
          revNow={landscapeStore.revNow}
          onMoves={runMoves}
          askAreaName={askAreaName}
          onSeen={onLsSeen}
          switcher={sideCollapsed}
          onShowTree={() => showView("sessions")}
          treeHidden={sideCollapsed || lsTeam}
          actionsFor={actionsFor}
          chromeFor={chromeFor}
          windowFor={windowFor}
          onCloseWindow={closeWindow}
          cardFor={cardFor}
          notice={lsNotice}
          ghostActions={ghostActionsFor}
          ghostStatus={ghostStatusOf}
          needs={needs.byArea}
          onNeeds={stepNeeds}
          keysTo={landscapeKeys}
          emptyState={lsEmpty}
          onJoinRoom={() => setJoinDlg(true)}
          onShortcuts={() => setKeysOpen((o) => !o)}
          newAsk={newAsk}
          tour={{ due: tourDue, onEnd: endTour }}
          closed={closedSessions}
          nextStep={addNextStep}
        />
        </BadgeContext.Provider>
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
    const since = inputStamp();
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
    jumpToSession(info, since);
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
    setNextFrom(null);
    freshFrom.current = null;
    // a right-click's place lasts until its session is placed; closed without one, it's let go
    setPlaceHint((h) => (h?.created ? h : null));
  }, [modal]);

  /** Add next step's step made: placed where its hint says once it's read, and said with what starts it. */
  const onPlanned = async (s: SessionInfo) => {
    const after = nextFrom;
    setPlaceHint((h) => h && { ...h, created: true, until: Date.now() + PLACE_HINT_MS });
    setModal(null);
    await refresh();
    lsSay(`Added ${titleOf(s)}${after ? ` after ${titleOf(after)}` : ""}: it starts when ${after ? `${titleOf(after)}'s` : "its"} handoff is sent, or with Start now in its menu`);
  };

  const onCreated = async (s: SessionInfo, since?: number) => {
    // Start fresh: the old session's wires come to this one, before the hint below lets its ghost go. One in its ghost's
    // place: those that can't come go with the ghost, and that's said as it goes; otherwise the old one stays closed and
    // keeps them, which is said here.
    const was = freshFrom.current;
    if (was) {
      const done = moveWires(was, s.id);
      freshMove.current = { from: was.id, done };
      const replacing = placeHint?.replaces === was.id && areaKeyOf(s) === placeHint.area;
      void done.then((why) => why && !replacing && lsSay(`${unmovedNote(titleOf(was), why)}. They stay with it.`));
    }
    setPlaceHint((h) => h && { ...h, created: true, until: Date.now() + PLACE_HINT_MS });
    // the lone pane joins its new workspace — unless the dialog put the session elsewhere
    const lone = pendingWs && s.taskGroup === pendingWs.key ? sessions.find((x) => x.id === pendingWs.id) : undefined;
    if (lone && pendingWs) {
      if (layoutNow.current) await carry(planJoinStack(layoutNow.current, lone.id, s.id, pendingWs.key), "making them a stack");
      else lsSay(`${titleOf(s)} isn't stacked with ${titleOf(lone)}: ${LAYOUT_LOADING}. Select both and press ⌘G once it has`);
    }
    refresh();
    jumpToSession(s, since);
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
  const startWorkspaceFrom = (s: SessionInfo, stack?: string) => {
    const top = topOf(s);
    const key = stack ?? `${top}/${nextSubName(top)}`;
    setPendingWs({ id: s.id, key });
    setNewGroup(key);
    setNewLaunch("claude");
    setModal("new");
  };

  // a teammate's session has no folder here: the file views and session commands are for this Mac's sessions
  const focusedSession = sessions.find((s) => s.id === focused && !isRemote(s)) ?? null;
  /** The group ⌘K's room rows act on: the selected area. */
  const paletteGroup = selectedArea;

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

  /** Start a preset's session and show it. The built-in Helpdesk preset shows the one there is first (openHelpdesk). */
  const startPreset = async (p: SessionPreset) => {
    if (p.id === HELPDESK_PRESET.id) return openHelpdesk();
    const since = inputStamp();
    const info = await window.mb.presetStart(p.id);
    if (isErr(info)) return alert(`Couldn't start “${p.name}”: ${info.error}`);
    await refresh();
    jumpToSession(info, since);
  };
  /** The Helpdesk tasks workspace: the one this Mac has shown (an exited one with its Resume), its ghost reopened, or it's started. */
  const openHelpdesk = async () => {
    const own = ownSessions.find((s) => s.role === "tasks");
    if (own) return jumpToSession(own);
    const closed = resumable.find((s) => s.role === "tasks");
    if (closed) return reopenGhost(closed);
    const since = inputStamp();
    const info = await window.mb.presetStart(HELPDESK_PRESET.id);
    if (isErr(info)) return alert(`Couldn't start the Helpdesk tasks workspace: ${info.error}`);
    await refresh();
    jumpToSession(info, since);
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

  // ---- session rows, in the Team view's room lists ----
  const rowMenu = useContextMenu("Session");

  /**
   * A side bar row's Connect…: the landscape's, worked out as it's picked (every row, every render, it would be many
   * rules each), so why no wire can go from it is said then.
   */
  const connectFromRow = (s: SessionInfo): Can | undefined =>
    landscapeShown
      ? () => {
          const c = connectRef.current?.(s);
          if (typeof c === "function") return c();
          lsSay(c?.no ?? `Connect… is the landscape's, and ${LAYOUT_LOADING}`);
        }
      : undefined;
  /** Everything a session's row and right-click menu offer, in menu order: its workspace's actions, as its ⋯ does. */
  const sessionActions = (s: SessionInfo): MenuEntry[] => menuOf(workspaceActions(s, { ...wsEnv(s, tileOfSession(s.id)), connect: connectFromRow(s) }));

  /** A session's row: its name, with its actions at the end of that line, and what it is underneath. */
  const sessionRow = (s: SessionInfo) => {
    const acts = sessionActions(s);
    // every session is on the landscape: its row brings it into view
    const open = () => {
      setFocused(s.id);
      revealWorkspace(s.id);
    };
    return (
      <div
        key={s.id}
        data-sid={s.id}
        className={`sess-item ${focused === s.id ? "focused" : ""} ${s.muted ? "muted" : ""} ${isRemote(s) ? "remote" : ""}`}
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            open();
          }
        }}
        title={`${s.cwd} — double-click name to rename · right-click for more`}
        {...rowMenu.bind(() => acts)}
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
              <ActionBar className="sr-acts" actions={pickActions(acts, isRemote(s) ? ["takeover", "notify"] : ["notify", "close"])} more={acts} label={titleOf(s)} />
            </span>
            {rowLines(s)}
          </span>
        )}
      </div>
    );
  };
  /** What a session's row says under its name, in the Team view and the area tree. */
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
        const open = !sub || (wsOpen[wsKey] ?? true);
        return (
          <div key={sub || "_"} className={sub ? "ws-folder" : "loose-rows"}>
            {sub && (
              <div
                data-ws={wsKey}
                className="sub-label"
                title="click to bring this stack into view · ✎/double-click to rename · ✕ unstacks its tabs (the sessions stay)"
                onClick={() =>
                  deferClick(() => {
                    setFocused(subList[0].id);
                    revealWorkspace(subList[0].id);
                  })
                }
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  cancelClick();
                  setRenameDlg({ kind: "sub", key: wsKey, initial: sub });
                }}
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
                <FolderIcon open={open} />
                <span className="txt">{sub}</span>
                <StatusDots list={subList} />
                <button
                  title="Rename stack"
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelClick();
                    setRenameDlg({ kind: "sub", key: wsKey, initial: sub });
                  }}
                >
                  ✎
                </button>
                {((no) => (
                  <button
                    className="danger"
                    disabled={!!no}
                    title={no ?? "Unstack its tabs — the sessions stay in the group"}
                    onClick={(e) => {
                      e.stopPropagation();
                      unstackStack(wsKey);
                    }}
                  >
                    ✕
                  </button>
                ))(landscapeLayout ? unstackRefusal(landscapeLayout, wsKey, areaTitle) : `Not yet: ${LAYOUT_LOADING}`)}
              </div>
            )}
            {open && subList.map(sessionRow)}
          </div>
        );
      })}
    </>
  );

  // team rooms: the Connected line, and what the Team view needs to show each room's sessions
  const connected = useMemo(() => connectedSummary(teamRooms, sessions), [teamRooms, sessions]);
  const roomSessions = (groupKey: string) => workSessions.filter((s) => topOf(s) === groupKey);
  const teamHooks: TeamViewHooks = {
    sessionCount: (groupKey) => roomSessions(groupKey).length,
    renderSessions: (groupKey) => groupBody(groupKey, roomSessions(groupKey)),
    onShowGroup: (groupKey) => goToArea(groupKey),
    onOpenBoard: setBoardDlg,
    onInvite: (groupKey, title) => shareDialog(groupKey, title),
    onNewSession: newSessionIn,
    onJoinRoom: () => setJoinDlg(true),
  };

  const brand = (
    <span className="brand">
      <span className="mark">🪶</span>
      <span className="name">Mockingbird</span>
      {appVersion && <WhatsNew version={appVersion} updated={updatedTo} open={whatsNewOpen} onOpen={() => setWhatsNewOpen(true)} onClose={closeWhatsNew} />}
    </span>
  );
  const shownTabs = (["sessions", "dashboard", "worktracker", "collaborate", "settings"] as const).filter((t) => shownTab(t) || tab === t);
  const debriefWaits = debriefSessions.some((s) => s.status === "waiting");
  const asksSay = `${plural(asksWaiting, "request")} from models waiting on you`;
  const tabBadge = (t: Tab) =>
    t === "worktracker" && debriefWaits ? (
      <span className="dot sm waiting" style={{ marginLeft: 6 }} />
    ) : t === "collaborate" && asksWaiting > 0 ? (
      <span className="tab-badge" title={asksSay}>
        {asksWaiting}
      </span>
    ) : null;
  const topTabs: TopTab[] = shownTabs.map((t) => ({
    id: t,
    label: t === "sessions" ? "Landscape" : TAB_LABELS[t],
    badge: tabBadge(t),
    badgeSays: t === "worktracker" && debriefWaits ? "a debrief is waiting on you" : t === "collaborate" && asksWaiting > 0 ? asksSay : null,
  }));

  return (
    <div className="app">
      <LandscapeTopBar
        brand={brand}
        tabs={topTabs}
        tab={tab}
        onTab={setTab}
        needs={<NeedsYou state={needs} current={needsAt >= 0 ? needs.items[needsAt].id : null} actionsFor={needsActionsFor} areaTitle={areaTitle} onStep={stepNeeds} />}
        needsCount={needs.items.length}
        keysOpen={keysOpen}
        onKeysOpen={setKeysOpen}
        onNew={newFromBar}
      />

      <div className="body">
        <ViewErrorBoundary resetKey={tab}>
        {tab === "dashboard" && (
          <DashboardBoard
            sessions={sessions}
            onJump={jumpTo}
            onAskSession={typeInto}
            onOpenScm={openScmFor}
            onCreated={(s, since) => {
              refresh();
              jumpToSession(s, since);
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
          <CouncilView
            focusRoom={focusRoom}
            onOpenSession={async (id) => {
              setTab("sessions");
              const s = (await refresh()).find((x) => x.id === id);
              if (s) jumpToSession(s);
              else alert("That session isn't running any more — a closed one is a ghost on the landscape, and in the Closed sessions list.");
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
                    density="max"
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
          {[...SIDE_VIEWS, ARTIFACTS_VIEW].map(({ id, label: viewLabel, keys, Icon }) => {
            // on the landscape the views are tool windows, named as their windows are: lit while one is open on the
            // selection (or docked). Artifacts and Chat open on the selection's area
            const tool = id === "artifacts" ? "artifacts" : toolOfView(id);
            const label = tool ? TOOL_NAME[tool] : viewLabel;
            const where = tool === "artifacts" || tool === "chat" ? "a window in the selected workspace's area" : "a window beside the selected workspace";
            const on = tool ? toolOpen(tool) : id === "sessions" && !lsTeam && !sideCollapsed;
            // what the selection's menu has off is off here too (a click says why)
            const no = tool && !on ? toolGate(tool, selectedAny, selArea) : null;
            const badge =
              id === "sessions" ? counts.waiting : id === "scm" ? scmCount : id === "run" ? runStates.filter((s) => s.status === "running" || s.status === "starting").length : 0;
            return (
              <button
                key={id}
                className={`ab-btn ${on ? "on" : ""} ${no ? "off" : ""}`}
                title={tool ? `${label}${keys ? ` (${keys})` : ""} — ${on ? "close its window" : no ?? where}` : `${label}${keys ? ` (${keys})` : ""}${on ? " — click to hide the side bar (⌘\\)" : ""}`}
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
            {/* the side bar is the area tree (designs B and L) */}
            <span className="side-title">{lsTeam ? "Team rooms" : "Landscape"}</span>
            {lsTeam && (
              <button type="button" className="link side-back" title="Back to the area tree" onClick={() => setLsTeam(false)}>
                ‹ Areas
              </button>
            )}
          </div>
          {lsTeam && (
            <RoomChatPanel
              status={teamStatus}
              visible={!sideCollapsed}
              hooks={teamHooks}
              sessions={ownSessions}
              focusedSessionId={focusedSession?.id ?? null}
              onOpenRepoFile={openRepoFile}
            />
          )}
          {!lsTeam && (
            <AreaTree
              areas={treeAreas}
              needIds={needs.sessions}
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
              areaMenu={(key) => (key === LOOSE_GROUP ? ((rows) => (rows.length ? menuOf(rows) : null))(looseGhostRows()) : areaMenu(key))}
              footer={
                <>
                  {/* team rooms: live panes */}
                  <LiveProblems state={roomLive.state} />
                  {/* closed sessions with no ghost on the landscape (every one while it's being read in) */}
                  <ClosedSessions list={closedList} actionsFor={(s) => ghostActions(s, ghostEnv(s, [s], false))} all={ghostsActions(closedListRows(), { what: "closed session", clearLabel: "Forget all" })} statusFor={(s) => closedStatus(s, goneFolders.get(s.id))} />
                  {/* team rooms: the way into the Team view */}
                  {teamRooms.length > 0 && (
                    <div className="lt-connected">
                      <ConnectedLine summary={connected} problem={roomLive.viewError} onOpen={() => openRoom(connected.roomId)} />
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
          {landscapeMain()}
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
          {Object.entries(readNotes.shown).map(([what, text]) => (
            <span key={what} className="update-note bad" title={text}>
              <span className="un-text">✕ {text}</span>
              <button className="icon" title="Dismiss" onClick={() => setReadNotes((n) => noteDismissed(n, what))}>✕</button>
            </span>
          ))}
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
              <span className="un-text">{updOutcome.ok ? `✕ ${plural(updOutcome.restoreErrors!.length, "session")} couldn't come back after the update` : `✕ ${updOutcome.message}`}</span>
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
          {/* a note said while the landscape isn't on screen */}
          {statusNote && (
            <span className="update-note" title={statusNote}>
              <span className="un-text">{statusNote}</span>
            </span>
          )}
          {/* following a teammate: said here once, whichever room's (rooms' bars only offer Follow) */}
          <FollowingNow follow={follow} />
          <span className="sb-info">
            {(() => {
              const theirs = workSessions.filter(isRemote).length;
              return <span>{workSessions.length - theirs} sessions{theirs ? ` (+${theirs} teammates')` : ""} · {landscapeLayout ? plural(landscapeLayout.areas.filter((a) => a.key !== LOOSE_GROUP).length, "area") : `${groupCount} groups`}</span>;
            })()}
            <span>⌘K commands</span>
            <span className="help-link" onClick={() => setModal("help")}>? help</span>
          </span>
        </span>
      </div>

      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
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
            { label: "Landscape", run: () => setTab("sessions") },
            { label: "Shortcuts — every key on the landscape", kbd: "?", run: () => setKeysOpen(true) },
            // the landscape: each area to fly to
            ...(landscapeLayout?.areas ?? []).map((a) => ({ label: `Go to ${areaTitle(a.key)} — its area on the landscape`, run: () => goToArea(a.key) })),
            { label: sideCollapsed ? "Show the area tree" : "Hide the area tree", kbd: "⌘\\", run: () => (sideCollapsed ? showView("sessions") : setSideCollapsed(true)) },
            // the landscape: every ghost at once (Reopen all), while there are any
            ...ghostsActions(ghostRows(null, "the landscape"))
              .filter((a) => !a.disabled)
              .map((a) => ({ label: `${a.menuLabel ?? a.label} — closed workspaces, everywhere on the landscape`, run: a.onPick })),
            // the Closed sessions list: all of it at once, and each one to reopen
            ...ghostsActions(closedListRows(), { what: "closed session", clearLabel: "Forget all" })
              .filter((a) => !a.disabled)
              .map((a) => ({ label: `${a.menuLabel ?? a.label} — the Closed sessions list`, run: a.onPick })),
            ...closedList.flatMap((s) => {
              const reopen = actionOf(ghostActions(s, ghostEnv(s, [s], false)), "reopen");
              return reopen && !reopen.disabled ? [{ label: `Reopen ${titleOf(s)} — closed session`, run: reopen.onPick }] : [];
            }),
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
            ...(paletteGroup && paletteGroup !== "ungrouped" && paletteGroup !== "assistant"
              ? [
                  {
                    label: roomOfGroup(teamStatus, paletteGroup) ? `Invite a teammate to ${groupTitle(paletteGroup, workSessions.filter((s) => topOf(s) === paletteGroup))}` : `Share ${groupTitle(paletteGroup, workSessions.filter((s) => topOf(s) === paletteGroup))} as a team room`,
                    run: () => shareDialog(paletteGroup, groupTitle(paletteGroup, workSessions.filter((s) => topOf(s) === paletteGroup))),
                  },
                ]
              : []),
            // team rooms: the House board
            ...(paletteGroup && roomOfGroup(teamStatus, paletteGroup)
              ? [{ label: `House board — ${groupTitle(paletteGroup, workSessions.filter((s) => topOf(s) === paletteGroup))}`, run: () => setBoardDlg(roomOfGroup(teamStatus, paletteGroup)!.id) }]
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
                  { label: `Focus ${titleOf(focusedSession)} — fill the window with it`, kbd: "⌘E", run: () => revealWorkspace(focusedSession.id, true) },
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
                ]
              : []),
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
          forget={forgetSession}
        />
      )}
      {templatePicker && (
        <TemplatePicker
          where={{
            area: templatePicker.area,
            // the area it was opened in, else the first with a repo: its repo and base to start from
            seed: templatePicker.area ? areaSeed(templatePicker.area) : ((landscapeLayout?.areas ?? []).map((a) => areaSeed(a.key)).find((x) => x.repo) ?? {}),
            areaTitle: (k) => (landscapeLayout?.areas.some((a) => a.key === k) ? areaTitle(k) : null),
            inRoom: (k) => !!roomOfGroup(teamStatus, k),
          }}
          onLayOut={layOutTemplate}
          home={landscapeHome}
          onClose={() => setTemplatePicker(null)}
        />
      )}
      {templateSave && (
        <SaveTemplateDialog draft={templateSave.draft} leftOut={templateSave.leftOut} onSave={saveTemplateNow} home={landscapeHome} onClose={() => setTemplateSave(null)} />
      )}
      {startAsk && (
        <StartStepDialog
          title={titleOf(startAsk.step)}
          where={startAsk.where}
          onCancel={() => setStartAsk(null)}
          onStart={() => {
            setStartAsk(null);
            void startStep(startAsk.step);
          }}
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
          onClose={() => {
            setHandoffFor(null);
            setPlaceHint(null);
          }}
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
          onClose={() => {
            setBriefFor(null);
            setPlaceHint(null);
          }}
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
          key={`${pipelineFor.id}:${pipelineFor.request ?? ""}`}
          ticketId={pipelineFor.id}
          title={pipelineFor.title}
          openRequest={pipelineFor.request}
          // a session counts toward its ticket as main's ticket tools count it (ticketOfSession), so the one that asked is here
          sessions={workSessions.filter((s) => (topOf(s) === pipelineFor.id || ticketOfSession(s) === pipelineFor.id) && !isRemote(s))}
          sessionNamed={(id) => sessions.find((s) => s.id === id)}
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
      {dismissRequestFor && (
        <RequestDismissDialog ticketId={dismissRequestFor.ticket} requestId={dismissRequestFor.request} onDone={lsSay} onClose={() => setDismissRequestFor(null)} />
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
            joinLeft.current = userLeft();
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
          title={renameDlg.kind === "session" ? "Rename session" : renameDlg.kind === "sub" ? "Rename stack" : "Rename area"}
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
          nextStep={nextFrom ? { from: nextFrom } : undefined}
          onPlanned={(s) => void onPlanned(s)}
        />
      )}
      {modal === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onOpened={(opened, since) => {
            refresh();
            // every one is on the landscape: the first is brought into view
            if (opened[0]) jumpToSession(opened[0], since);
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
