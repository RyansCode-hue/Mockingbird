import { AGENT_NAME, otherAgent, ticketIdOf, type MessageMode, type MissingFolder, type SessionInfo } from "../shared/types";
import { LOOSE_GROUP, SIZE_PRESETS, areaKeyOf, type SizePreset } from "../shared/landscape";
import { menuHeading, tidyMenu, type Action, type MenuEntry } from "./ContextMenu";
import { BellIcon, BellOffIcon, CloseIcon, FilesIcon, HandoffIcon, MoveIcon, NoteIcon, PanelRightIcon, PencilIcon, PlusIcon, RepaintIcon, RunDebugIcon, SearchIcon, SourceControlIcon, UndoIcon } from "./Icons";
import { firstName } from "./team/connectedModel";

/**
 * A workspace's actions, said once (and an area's the same way): every surface that offers them — the workspace
 * header's chips and ⋯, its right-click menu, and whatever shows them without zooming in — renders this list, so none
 * of them can offer what the others don't, or word it differently. Each action has its label, whether it can be done
 * now and why not (`disabled`, `title`), its shortcut (`kbd`) and its handler; `section` groups the menu's rows.
 */
export type ActionSection = "session" | "stack" | "tools" | "terminal" | "handon" | "wires" | "room" | "area" | "ghosts" | "messages" | "sessions" | "share" | "create" | "several" | "move" | "needs" | "wire" | "end";

/** A section's heading in a menu; null: its rows follow a separator only. */
const SECTION_NAME: Record<ActionSection, string | null> = {
  session: "Session",
  stack: "Stack",
  tools: "Tools",
  terminal: "Terminal",
  handon: "Hand on",
  wires: "Wires",
  room: "Team room",
  area: "Area",
  ghosts: "Ghosts",
  messages: "Agent messages",
  sessions: "Sessions",
  share: null,
  create: "New workspace",
  several: null,
  move: "Move to area",
  needs: null,
  wire: null,
  end: null,
};

export interface ModelAction extends Action {
  section: ActionSection;
  /**
   * A teammate's ask to type answered (Needs you): main's call, settling with why it was refused, or null. Where it's
   * set the tray runs it rather than `onPick`, and only from a pointer's click (NeedsYou.tsx).
   */
  answer?: () => Promise<string | null>;
}

/** A handler, or why it isn't there: a disabled row says so. */
export type Can = (() => void) | { no: string };
/** A typing ask's answer (ModelAction.answer), or why it can't be given. */
export type Answer = (() => Promise<string | null>) | { no: string };

/** The tool windows a workspace opens on itself (docs/landscape.md, Tools). */
export type WorkspaceTool = "files" | "changes" | "search" | "run";

/** Shortcuts the rail's tools open with (main.tsx's keyboard layer). */
export const TOOL_KEYS: Record<WorkspaceTool | "artifacts" | "chat", string | undefined> = { files: "⇧⌘E", changes: "⌃⇧G", search: "⇧⌘F", run: "⇧⌘D", artifacts: undefined, chat: undefined };

/** What a workspace's actions need to know about it, and do. */
export interface WorkspaceEnv {
  /** A teammate's session: its owner's name. Theirs to rename, move, size and close. */
  owner: string | null;
  /** The size preset it's at (null: none), and why its size can't change (null: it can). Null while it has no place on the landscape. */
  size: { current: SizePreset | null; blocked: string | null } | null;
  /** A stack's tab: its stack's name, renaming it, and taking every tab of this Mac's out of it. Null: a workspace of its own, or one with no place yet. */
  stack: { name: string; rename: Can; unstack: Can } | null;
  /** Another session in one card with this one: a new tab of its stack, or the stack it starts by that; or why not. */
  newTab: Can;
  /** The agent's diff side panel is open in its terminal. */
  diffPanel: boolean;
  /** Take over, Take it back, Send, Review (team rooms): in that order, those that apply. */
  room: Action[];
  rename: () => void;
  mute: () => void;
  move: () => void;
  resize: (p: SizePreset) => void;
  tool: (t: WorkspaceTool) => void;
  /** Its area's Artifacts window, or why there's none (a loose workspace). */
  artifacts: Can;
  repaint: () => void;
  hidePanel: () => void;
  undo: Can;
  handoff: Can;
  brief: Can;
  secondOpinion: Can;
  /** "Add terminal on its tree": a terminal in its folder, wired to it by a shared worktree wire. Absent where it isn't offered. */
  addTerminal?: Can;
  close: () => void;
  resume: Can;
  /** Resume <agent> for a terminal its agent quit into (SessionInfo.agentQuit): back to that agent pane, on its conversation. */
  resumeAgent?: Can;
  /** Open a terminal here, for an exited pane whose agent quit in its room's sandbox (SessionInfo.quitInSandbox). */
  openTerminal?: Can;
  /**
   * Connect…: a menu of the workspaces a wire can be made to, as Move to area lists areas (the landscape's; left out
   * where wires aren't made, as in ⌘K), or why none can be.
   */
  connect?: Can;
  /** Save as template (W9): the chain of wires through it, as a pipeline template. Absent where it isn't offered. */
  saveTemplate?: Can;
  /**
   * Finish step… (W5): its step finished by you, from its latest message, in a small popover that says what each wire out
   * does before anything moves; or why it can't be now. Absent where it isn't offered: a workspace with no handoff or
   * feedback wire out, or where wires aren't drawn.
   */
  finish?: Can;
}

const can = (c: Can): Pick<Action, "onPick" | "disabled" | "title"> => (typeof c === "function" ? { onPick: c } : { onPick: () => {}, disabled: true, title: c.no });

/**
 * A workspace's Artifacts on the landscape: its area's window, the area its tile is in or, while it has no tile yet,
 * its session's; off saying why for a loose one.
 */
export function artifactsOf(tile: { area: string } | null | undefined, s: Pick<SessionInfo, "taskGroup">, show: (area: string) => void): Can {
  const area = tile?.area ?? areaKeyOf(s);
  return area === LOOSE_GROUP ? { no: "It's in no area: artifacts are kept by area" } : () => show(area);
}

/** Why a copy that was taken back into another session here does nothing more: that session goes on with it. */
export const TAKEN_BACK_WHY = "It was taken back into another session here, which goes on with it: this copy doesn't run again";

/**
 * Why `what` can't be done to session `s` here because a teammate took it over and continues it on their laptop (its
 * turns, its branch and its conversation go on there; this copy is taken back, never worked on), or because it was
 * taken back since into another session here; null when no one took it over.
 */
export const takenOverWhy = (s: SessionInfo, what: string): string | null => {
  const t = s.room?.takenOver;
  return !t ? null : t.back ? TAKEN_BACK_WHY : `${t.byName} continues it on their laptop: take it back ${what}`;
};

/** Every action of session `s`'s workspace, in menu order. */
export function workspaceActions(s: SessionInfo, env: WorkspaceEnv): ModelAction[] {
  const dead = s.status === "dead";
  const other = AGENT_NAME[otherAgent(s.agent)];
  const theirs = (what: string) => (env.owner ? { disabled: true, title: `${env.owner}'s session: theirs to ${what}` } : {});
  // a copy a teammate took over and continues on their laptop is taken back, never worked on here: its turns, its
  // branch and its conversation go on there
  const tookIt = (c: Can, what: string): Can => {
    const no = takenOverWhy(s, what);
    return no ? { no } : c;
  };
  const out: ModelAction[] = [
    { section: "session", key: "rename", label: "Rename", menuLabel: "Rename…", icon: <PencilIcon />, onPick: env.rename, ...theirs("rename") },
    {
      section: "session",
      key: "notify",
      label: s.muted ? "Muted" : "Notify",
      menuLabel: s.muted ? "Unmute notifications" : "Mute notifications",
      icon: s.muted ? <BellOffIcon /> : <BellIcon />,
      pressed: !!s.muted,
      title: s.muted ? "Notifications muted — pick to hear from this session again" : "It notifies you when it needs you — pick to mute",
      onPick: env.mute,
    },
    { section: "session", key: "move", label: "Move", menuLabel: "Move to area…", icon: <MoveIcon />, onPick: env.move, ...theirs("move") },
  ];
  if (env.size) {
    const blocked = env.size.blocked;
    for (const p of SIZE_PRESETS)
      out.push({
        section: "session",
        key: `size:${p}`,
        label: p,
        menuLabel: `Size ${p}`,
        pressed: env.size.current === p,
        onPick: () => env.resize(p),
        ...(blocked ? { disabled: true, title: blocked } : {}),
      });
  }
  const newTab = tookIt(env.newTab, "to add a tab beside it");
  if (env.stack)
    out.push(
      { section: "stack", key: "newTab", label: "New tab", menuLabel: `New tab in “${env.stack.name}”…`, icon: <PlusIcon />, title: "Another session in this stack", ...can(newTab) },
      { section: "stack", key: "renameStack", label: "Rename stack", menuLabel: `Rename “${env.stack.name}”…`, title: "Rename this stack: its tabs stay as they are", ...can(env.stack.rename) },
      { section: "stack", key: "unstack", label: "Unstack", menuLabel: "Unstack its tabs", title: "Each of its tabs becomes a workspace of its own in the area, the one in front keeping the stack's place", ...can(env.stack.unstack) }
    );
  else out.push({ section: "session", key: "newTab", label: "New tab", menuLabel: "New tab…", icon: <PlusIcon />, title: "Another session in one card with this one: they become a stack with a tab each", ...can(newTab) });
  const local = !env.owner;
  const noFolder = env.owner ? `${env.owner}'s session has no folder on this Mac` : dead ? "Its session has exited" : null;
  const tool = (t: WorkspaceTool, label: string, icon: JSX.Element): ModelAction => ({
    section: "tools",
    key: `tool:${t}`,
    label,
    icon,
    kbd: TOOL_KEYS[t],
    onPick: () => env.tool(t),
    // an exited session's Search still looks through its folder and conversations; a teammate's has neither here
    ...(noFolder && (t !== "search" || !local) ? { disabled: true, title: noFolder } : {}),
  });
  out.push(tool("files", "Files", <FilesIcon />), tool("changes", "Changes", <SourceControlIcon />), tool("search", "Search", <SearchIcon />), tool("run", "Run & debug", <RunDebugIcon />));
  out.push({ section: "tools", key: "tool:artifacts", label: "Artifacts", icon: <NoteIcon />, title: "Its area's artifacts", ...can(env.artifacts) });
  out.push(
    { section: "terminal", key: "repaint", label: "Repaint", icon: <RepaintIcon />, title: "Have the session redraw its screen (its scrollback stays)", onPick: env.repaint, ...(dead ? { disabled: true, title: "Its session has exited" } : {}) },
    {
      section: "terminal",
      key: "diff",
      label: "Hide diff",
      menuLabel: "Hide the agent's diff panel",
      icon: <PanelRightIcon open />,
      onPick: env.hidePanel,
      ...(env.diffPanel ? { title: "Close the agent's diff side panel (same as its × or /diff)" } : { disabled: true, title: "The agent's diff panel isn't open" }),
    },
    { section: "terminal", key: "undo", label: "Undo", menuLabel: "Undo the last turn…", icon: <UndoIcon />, ...can(tookIt(env.undo, "before undoing a turn here")) }
  );
  // the Helpdesk tasks workspace takes no wires
  if (env.addTerminal && s.role !== "tasks")
    out.push({
      section: "terminal",
      key: "addTerminal",
      label: "Add terminal",
      menuLabel: "Add terminal on its tree",
      icon: <PlusIcon />,
      title: "A terminal in its folder, on its branch, wired to it: it closes when its worktree is cleaned up",
      ...can(tookIt(env.addTerminal, "to add a terminal on its tree")),
    });
  // the Helpdesk tasks workspace's conversation holds what its user saw on admin sites: nothing hands it on to another
  // session, so its menus, ⌘K, its selection bar and its context warning offer none of these
  if (s.role !== "tasks")
    out.push(
      { section: "handon", key: "handoff", label: other, menuLabel: `Continue in ${other}…`, icon: <HandoffIcon />, ...can(tookIt(env.handoff, "to hand it on")) },
      { section: "handon", key: "brief", label: "Brief", menuLabel: "Fresh session from a brief…", ...can(tookIt(env.brief, "to hand it on")) },
      { section: "handon", key: "review", label: "Second opinion", menuLabel: `Second opinion from ${other}`, ...can(tookIt(env.secondOpinion, "to have its branch reviewed")) }
    );
  if (env.connect) out.push({ section: "wires", key: "connect", label: "Connect", menuLabel: "Connect…", title: "Wire it to another workspace: a handoff, a context link, a feedback loop or a shared worktree", ...can(env.connect) });
  if (env.finish)
    out.push({
      section: "wires",
      key: "finish",
      label: "Finish step",
      menuLabel: "Finish step…",
      title: "Finish its step yourself, from its latest message: what each wire out does is shown before anything moves",
      ...can(tookIt(env.finish, "to finish its step here")),
    });
  if (env.saveTemplate && s.role !== "tasks")
    out.push({ section: "wires", key: "saveTemplate", label: "Save as template", menuLabel: "Save as template…", title: "Keep the chain of wires through it as a pipeline template, to lay out again from a ticket", ...can(env.saveTemplate) });
  out.push(...env.room.map((a): ModelAction => ({ ...a, section: "room" })));
  const agentName = AGENT_NAME[s.agent ?? "claude"];
  if (dead && local) {
    // an agent that quit in its room's sandbox leaves its pane exited: a terminal opens there only when asked
    const held = !s.shell && !!s.quitInSandbox;
    const resume = held ? `Resume ${agentName}` : "Resume";
    out.push({ section: "end", key: "resume", label: resume, menuLabel: resume, primary: true, title: "Start it again, resuming its conversation", ...can(tookIt(env.resume, "rather than resuming this copy")) });
    if (held && env.openTerminal)
      out.push({ section: "end", key: "openTerminal", label: "Open a terminal here", title: "A login shell in its folder, on your Mac and outside the room's sandbox", ...can(tookIt(env.openTerminal, "before opening a terminal in it")) });
  }
  if (!dead && local && s.shell && s.agentQuit && env.resumeAgent) {
    const name = AGENT_NAME[s.agentQuit.agent];
    out.push({ section: "end", key: "resumeAgent", label: `Resume ${name}`, title: `Ends this terminal and resumes its conversation in ${name}, in this workspace`, ...can(tookIt(env.resumeAgent, `rather than resuming ${name} in this copy`)) });
  }
  out.push({ section: "end", key: "close", label: "Close", menuLabel: dead ? "Close & clean up…" : "Close…", icon: <CloseIcon />, danger: true, onPick: env.close, ...theirs("close") });
  return out;
}

/** What the focused header's ⋯ leaves to the rest of the window: the activity bar has the tools, the landscape sizes and wires. */
const NOT_IN_FOCUS_MENU: ReadonlySet<ActionSection> = new Set(["tools", "wires"]);

/**
 * The focused header's ⋯: a workspace's actions less sizes, tools, wires and New tab (its tabs' + adds one), and only
 * those that can be done now, a row that's off left out rather than greyed. menuOf drops a heading with no rows left.
 * The card's ⋯ and every right-click keep the whole model.
 */
export const focusMenuActions = (actions: readonly ModelAction[]): ModelAction[] =>
  actions.filter((a) => !a.disabled && !NOT_IN_FOCUS_MENU.has(a.section) && a.key !== "newTab" && !a.key.startsWith("size:"));

/** Why Helpdesk tasks… is off: it's being opened (started, or its ghost reopened) already. */
export const HELPDESK_BUSY = "Opening the Helpdesk tasks workspace…";

/** What making a workspace needs (right-click on empty landscape): today's New Session dialog, opened for each kind. */
export interface CreateEnv {
  launch: (kind: "claude" | "codex" | "shell") => void;
  /** The Helpdesk tasks workspace: the one there is shown, its ghost reopened, or it's started. */
  helpdesk: () => void;
  /** That's under way: the row is off, saying so, until it's done. */
  helpdeskBusy?: boolean;
  /** The dialog with its ticket picker open. */
  ticket: () => void;
  /** The dialog's Import, resuming a conversation from this Mac. */
  importIt: () => void;
  /** Import conversations: several from this Mac at once, each reopened in its own folder (⌘K's Import sessions). */
  importMany: () => void;
  /** Pipeline from a ticket…: the template picker (W9). */
  pipeline: () => void;
}

/** The kinds of workspace that can be made here, and those still to come (docs/landscape.md, Workspaces: Create). */
export function createActions(env: CreateEnv): ModelAction[] {
  const coming = (key: string, label: string, title: string): ModelAction => ({ section: "create", key, label, menuLabel: `${label} (coming)`, disabled: true, title, onPick: () => {} });
  return [
    { section: "create", key: "new:claude", label: "Claude", menuLabel: "Claude…", onPick: () => env.launch("claude") },
    { section: "create", key: "new:codex", label: "Codex", menuLabel: "Codex…", onPick: () => env.launch("codex") },
    { section: "create", key: "new:shell", label: "Terminal", menuLabel: "Terminal…", onPick: () => env.launch("shell") },
    {
      section: "create",
      key: "new:helpdesk",
      label: "Helpdesk tasks",
      menuLabel: "Helpdesk tasks…",
      title: env.helpdeskBusy ? HELPDESK_BUSY : "Claude in your Chrome, for helpdesk requests you paste in: shows the one you have, or starts it",
      disabled: !!env.helpdeskBusy,
      onPick: env.helpdesk,
    },
    { section: "create", key: "new:ticket", label: "From a ticket", menuLabel: "From a ticket…", onPick: env.ticket },
    { section: "create", key: "new:import", label: "Resume a conversation", menuLabel: "Resume a conversation…", onPick: env.importIt },
    { section: "create", key: "new:import-many", label: "Import conversations", menuLabel: "Import conversations…", onPick: env.importMany },
    coming("new:collab", "Collab…", "Collab workspaces, where several agents talk a change through, come in a later version"),
    { section: "create", key: "new:pipeline", label: "Pipeline from a ticket", menuLabel: "Pipeline from a ticket…", title: "Lay out a saved pipeline template's steps and wires, on a ticket", onPick: env.pipeline },
  ];
}

/**
 * What a closed session's actions need to know about it, and do (main.tsx's `ghostEnv` makes it): its ghost's card,
 * ⋯ and right-click, a stack's closed tab, and its row in the Closed sessions list.
 */
export interface GhostEnv {
  /**
   * Its folder is gone (main's missingFolders): a removed worktree whose branch is still there reopens (made again from
   * it); otherwise it can't run where it ran, and `why` says what's missing.
   */
  gone: Omit<MissingFolder, "id"> | null;
  /** How many closed tabs it is: a stack's ghost of more than one, which Reopen and Forget act on together. */
  tabs: number;
  /** How many of those can be reopened here now (not taken over, their folders runnable, not under way): a stack's ghost with none has Reopen off. */
  reopenable: number;
  /** Being reopened or forgotten now: Reopen and Forget wait for that to finish. */
  busy: boolean;
  /** Take it back, Send (team rooms): a copy a teammate continues on their laptop. */
  room: Action[];
  /** Relaunch it under its id, resuming its conversation: it lands where its ghost is. */
  reopen: () => void;
  /** A new session where it was, from its repo, ticket and area: what one whose folder is gone offers. */
  fresh: () => void;
  /** Let it go for good: it can't be reopened after. */
  forget: () => void;
}

/** A closed session's status line (its ghost's foot, its Closed sessions row): taken over by a teammate, its folder gone, or Closed. */
export const closedStatus = (s: SessionInfo, gone: Pick<MissingFolder, "short"> | null | undefined): string =>
  s.room?.takenOver ? (s.room.takenOver.back ? "Taken back into another session here" : `Continued by ${s.room.takenOver.byName} on their laptop`) : (gone?.short ?? "Closed");

/** Why a closed session isn't reopened or forgotten again while that's under way. */
export const CLOSED_BUSY_WHY = "It's being reopened or forgotten already";

/**
 * Every action of a closed session this Mac can reopen (its ghost, a stack's closed tab, its Closed sessions row), in
 * menu order. Reopen goes through the take-over rule as Resume does (a copy a teammate continues is taken back, never
 * run again here), and main refuses it too (relaunchGuard). A stack's ghost of several tabs reopens and forgets them
 * all, skipping (and saying so) any that can't be reopened.
 */
export function ghostActions(s: SessionInfo, env: GhostEnv): ModelAction[] {
  const several = env.tabs > 1;
  const taken = several ? null : takenOverWhy(s, "rather than reopening this copy");
  const cantRun = !several && env.gone && !env.gone.reopens ? env.gone.why : null;
  const busy = env.busy ? { no: CLOSED_BUSY_WHY } : null;
  const noTab = several && !env.reopenable ? `None of its ${env.tabs} tabs can be reopened here: taken over by a teammate, their folders gone, or being reopened or forgotten` : null;
  const reopenTitle = several ? `Start its ${env.tabs} tabs again where it was, resuming their conversations` : env.gone?.reopens ? env.gone.why : "Start it again where it was, resuming its conversation";
  const out: ModelAction[] = [
    {
      section: "end",
      key: "reopen",
      label: "Reopen",
      menuLabel: several ? `Reopen its ${env.tabs} tabs` : undefined,
      primary: true,
      title: reopenTitle,
      ...can(busy ?? (taken ? { no: taken } : cantRun ? { no: cantRun } : noTab ? { no: noTab } : env.reopen)),
    },
  ];
  if (cantRun && !taken) out.push({ section: "end", key: "fresh", label: "Start fresh", menuLabel: "Start fresh…", title: "A new session where it was: its repo, ticket and area, on a new worktree", onPick: env.fresh });
  out.push(...env.room.map((a): ModelAction => ({ ...a, section: "room" })));
  out.push({
    section: "end",
    key: "forget",
    label: "Forget",
    menuLabel: several ? `Forget its ${env.tabs} tabs` : "Forget it",
    danger: true,
    icon: <CloseIcon />,
    ...can(busy ?? env.forget),
    title: env.busy ? CLOSED_BUSY_WHY : several ? `Let this stack's ${env.tabs} closed tabs go for good: they can't be reopened after` : "Let it go for good: it can't be reopened after",
  });
  return out;
}

/** What a not-started step's actions need, and do (main.tsx's `plannedEnv` makes it): its card's ⋯ and right-click. */
export interface PlannedEnv {
  /** Being started or forgotten now: neither again till that's done. */
  busy: boolean;
  /** Start now…: says where it would start and asks, then starts it from the commit the step before it is on. */
  start: () => void;
  /** Let it go: its place and its wires go with it. */
  forget: () => void;
}

/** Why a not-started step isn't started or forgotten again while that's under way. */
export const PLANNED_BUSY_WHY = "It's being started or forgotten already";

/**
 * A not-started step's actions (W8): Start now and Forget. Never Reopen: it has nothing to go back to, and main refuses
 * a relaunch of one too.
 */
export function plannedActions(env: PlannedEnv): ModelAction[] {
  const busy = env.busy ? { no: PLANNED_BUSY_WHY } : null;
  return [
    { section: "end", key: "start", label: "Start now", menuLabel: "Start now…", primary: true, title: "Start it now, from the commit the step before it is on, without waiting for its handoff: it says where first", ...can(busy ?? env.start) },
    { section: "end", key: "forget", label: "Forget", menuLabel: "Forget it", danger: true, icon: <CloseIcon />, title: env.busy ? PLANNED_BUSY_WHY : "Let it go, with its place and its wires", ...can(busy ?? env.forget) },
  ];
}

/**
 * Where a not-started step will work, as its card's foot says it: in another session's folder (`titleOf` names that
 * one), a new worktree of its repo, its repo's checkout, or no repo; its ticket first.
 */
export function plannedWhere(s: SessionInfo, titleOf: (id: string) => string | null): string {
  const p = s.planned;
  const repo = s.repoPath ? s.repoPath.split("/").filter(Boolean).pop() : null;
  const where = p?.sharesWith ? `in ${titleOf(p.sharesWith) ?? "another session"}'s folder` : repo ? `${repo} · ${p?.worktree ? "new worktree" : "its checkout"}` : "no repo";
  return [s.ticketId ? `#${ticketIdOf(s.ticketId)}` : null, where].filter(Boolean).join(" · ");
}

/**
 * Several closed sessions at once (an area's ghosts, the loose ones', every one, or the Closed sessions list): how many
 * (Clear ghosts acts on all of them), how many of those can be reopened here, and Reopen all and Clear ghosts.
 */
export interface GhostsEnv {
  count: number;
  /** Those not taken over by a teammate, whose folders can still be run, and not being reopened or forgotten now. */
  reopenable: number;
  /** A Reopen all is under way. */
  running: boolean;
  reopenAll: Can;
  clear: Can;
}

/**
 * Reopen all and Clear ghosts: an area's ⋯, the loose ones' (the tree's
 * Loose row, a right-click outside every area), ⌘K's over every one and the Closed sessions list's. Off, saying why,
 * when there are none, when none of them can be reopened here, and while a Reopen all is under way.
 */
export function ghostsActions(g: GhostsEnv, o: { what?: string; clearLabel?: string } = {}): ModelAction[] {
  const n = g.count;
  const what = o.what ?? "closed workspace";
  const none = { no: `No ${what}s here` };
  const reopen: Can = !n ? none : g.running ? { no: "Reopening them already" } : !g.reopenable ? { no: `None of these can be reopened here: taken over by a teammate, their folders gone, or being reopened or forgotten` } : g.reopenAll;
  const clearLabel = o.clearLabel ?? "Clear ghosts";
  return [
    { section: "ghosts", key: "reopenAll", label: "Reopen all", menuLabel: g.reopenable ? `Reopen all (${g.reopenable})` : "Reopen all", title: `Start every ${what} here again, resuming its conversation`, ...can(reopen) },
    { section: "ghosts", key: "clearGhosts", label: clearLabel, menuLabel: n ? `${clearLabel} (${n})…` : clearLabel, danger: true, title: `Forget all the ${what}s here: they can't be reopened after`, ...can(n ? (g.running ? { no: "Wait for Reopen all to finish" } : g.clear) : none) },
  ];
}

/** What an area's actions need to know about it, and do (main.tsx's `areaActions` makes it). */
export interface AreaEnv {
  title: string;
  /** Its record on the landscape (collapsed, locked); null where it has none. */
  stored: { collapsed?: boolean; locked?: boolean } | null;
  /** A team room's area: the room tools (Chat, Board, Members, Follow) are only ever a room's. */
  room: boolean;
  /** No session is in it, so it can go (its ghosts come back to it otherwise). */
  empty: boolean;
  /** How agents' messages to its sessions are delivered: its own choice (undefined: Settings'), and Settings'. */
  messages: { mode: MessageMode | undefined; defaultSend: boolean; set: (mode: MessageMode | "") => void; log: () => void };
  /** Following a teammate's view: the one followed (null: no one), and the room's teammates who can be. */
  follow: { leader: string | null; candidates: readonly { member: string; name: string }[]; stop: () => void; start: (member: string) => void };
  rename: () => void;
  collapse: () => void;
  lock: () => void;
  /** Pack it in creation order (T), or why it can't be (locked, collapsed, nothing in it); null where there's no landscape. */
  tidy: Can | null;
  /** Its closed workspaces (ghosts): how many, Reopen all and Clear ghosts; null where there's no landscape. */
  ghosts: GhostsEnv | null;
  artifacts: () => void;
  chat: () => void;
  board: () => void;
  share: () => void;
  newSession: () => void;
  ask: () => void;
  remove: () => void;
  /** The room's Chat icon (team/RoomChat.tsx), kept out of this model's imports. */
  chatIcon?: JSX.Element;
}

/** A group's choices for agents' messages (its area's menu): one is on, so each says what it does differently. */
const messageModes = (defaultSend: boolean): { value: MessageMode | ""; label: string; title: string }[] => [
  { value: "", label: `As in Settings (${defaultSend ? "auto-send" : "leave in prompt"})`, title: "What Settings → Agents says, for every group" },
  { value: "send", label: "Always auto-send", title: "Sent as a prompt as soon as it arrives" },
  { value: "prompt", label: "Always leave in prompt", title: "Typed into the prompt; you press Enter" },
];

/** What Lock does, as its button and menu row say it: an area's layout frozen, the area itself still pushed aside whole. */
export const lockTitle = (locked: boolean): string =>
  locked ? "Unlock: workspaces can be moved into, out of and within it again" : "Lock its layout: its workspaces keep their places, and none move in or out; it's still pushed aside whole when another area grows";

/**
 * Every action of an area, in menu order: its ⋯, its right-click (header, name line, patch, pill, tree row), its
 * header's buttons and its selection bar all render this list. Room tools (Chat, Board, Follow, Invite) are only a
 * room's; another area offers to become one instead.
 */
export function areaActions(env: AreaEnv): ModelAction[] {
  const st = env.stored;
  const out: ModelAction[] = [{ section: "area", key: "rename", label: "Rename", menuLabel: "Rename…", onPick: env.rename }];
  if (st)
    out.push(
      { section: "area", key: "collapse", label: st.collapsed ? "Open" : "Collapse", menuLabel: st.collapsed ? "Open the area" : "Collapse to a pill", onPick: env.collapse },
      { section: "area", key: "lock", label: st.locked ? "Locked" : "Lock", menuLabel: st.locked ? "Unlock its layout" : "Lock its layout", title: lockTitle(!!st.locked), pressed: !!st.locked, onPick: env.lock }
    );
  if (env.tidy) out.push({ section: "area", key: "tidy", label: "Tidy", kbd: "T", title: "Pack its workspaces in the order they were made — Undo puts them back", ...can(env.tidy) });
  if (env.ghosts) out.push(...ghostsActions(env.ghosts));
  out.push({ section: "tools", key: "tool:artifacts", label: "Artifacts", icon: <NoteIcon />, title: env.room ? "The room's artifacts" : "The area's artifacts, on this Mac", onPick: env.artifacts });
  if (env.room) out.push({ section: "tools", key: "tool:chat", label: "Chat", icon: env.chatIcon, title: "The room's chat", onPick: env.chat });
  for (const m of messageModes(env.messages.defaultSend)) {
    const on = (env.messages.mode ?? "") === m.value;
    out.push({ section: "messages", key: `msg:${m.value || "default"}`, label: m.label, title: m.title, icon: on ? "✓" : undefined, pressed: on, onPick: () => env.messages.set(m.value) });
  }
  out.push(
    { section: "messages", key: "log", label: "Message log", menuLabel: "Agent message log…", title: "What sessions told each other", onPick: env.messages.log },
    { section: "sessions", key: "new", label: "New session", menuLabel: env.room ? "New connected session here…" : "New session here…", onPick: env.newSession },
    { section: "sessions", key: "ask", label: "Ask for status", onPick: env.ask }
  );
  if (env.room) {
    out.push({ section: "room", key: "board", label: "Board", menuLabel: "House board…", title: "House board — the room's Radley House tickets and who has each", onPick: env.board });
    const f = env.follow;
    if (f.leader) out.push({ section: "room", key: "follow:stop", label: `Stop following ${firstName(f.leader)}`, title: `Stop mirroring ${f.leader}'s view`, onPick: f.stop });
    else for (const v of f.candidates) out.push({ section: "room", key: `follow:${v.member}`, label: `Follow ${firstName(v.name)}`, title: `Mirror ${v.name}'s view: the shared workspace they're in is brought into view and selected`, onPick: () => f.start(v.member) });
    out.push({ section: "room", key: "share", label: "Invite", menuLabel: "Invite a teammate…", onPick: env.share });
  } else out.push({ section: "share", key: "share", label: "Share", menuLabel: "Share as a team room…", onPick: env.share });
  if (env.empty && st) out.push({ section: "end", key: "remove", label: "Remove", menuLabel: "Remove the area", danger: true, onPick: env.remove });
  return out;
}

/** What several workspaces' actions need (Landscape.tsx makes it from the picked ones). */
export interface SeveralEnv {
  makeArea: () => void;
  /** Stack them into one card with a tab each (⌘G), or why they can't be (planStack's refusal). */
  stack: Can;
  /** Move to area's rows: each area, with why it can't take them (null: it can), as moving them would say. */
  areas: readonly { key: string; title: string; refused: string | null; pick: () => void }[];
  /** Close…: every session of this Mac's in them (a stack's tabs each), asked about once; or why it can't be done here. */
  close: Can;
}

/** Several picked workspaces' actions, in menu order: their selection bar and their right-click render this list. */
export function severalActions(env: SeveralEnv): ModelAction[] {
  return [
    { section: "several", key: "makeArea", label: "Make area…", kbd: "M", title: "Make an area of them", onPick: env.makeArea },
    { section: "several", key: "stack", label: "Stack", kbd: "⌘G", title: "Stack them into one card with a tab each", ...can(env.stack) },
    ...env.areas.map((a): ModelAction => ({ section: "move", key: `move:${a.key}`, label: a.title, onPick: a.pick, ...(a.refused ? { disabled: true, title: a.refused } : {}) })),
    { section: "end", key: "close", label: "Close", menuLabel: "Close…", danger: true, title: "Close them, asking first about any with uncommitted or unpushed work", ...can(env.close) },
  ];
}

/** What a Needs you item's actions need (NeedsYou.tsx makes it from needsYouModel's target). */
export interface NeedsEnv {
  /** Its workspace focused and brought into view, or its room's area flown to with the admin's prompt; or why not. */
  go: Can;
  /** "Answer it in its terminal" and such: what Go there leads to, its tooltip. */
  goTitle: string;
  dismiss: () => void;
  /** A typing ask's answers (Allow for 15 min, Deny: main's calls, as the strip's), and the teammate's first name. */
  answer?: { allow: Answer; deny: Answer; who: string } | null;
  /**
   * A ticket's item (W15): Open, the main action in place of Go there, shows its pipeline (an agent's request: the PR
   * form, filled from it); `title` says what it opens. Nothing is pushed, opened or posted by it.
   */
  open?: { can: Can; title: string } | null;
  /** An agent's pull request request: Dismiss… in place of Dismiss, asking for a note to the agent before main drops it. */
  dismissRequest?: Can | null;
  /**
   * A wire's item (W5): Send, the main action while what waits is ready (main's call for the pending the item names,
   * taken only from a pointer's click, as Allow is), and Show, its send popover.
   */
  wire?: { send: Answer | null; show: Can } | null;
  /** A pull request the merge watch can't follow (W16): Check now, asking its provider again, and Mark merged…, asked first. */
  merge?: { check: Can; mark: Can } | null;
  /** A finished session's item with a handoff or feedback wire out: Finish step…, its popover. */
  finish?: Can | null;
  /** What Dismiss… says it does, when it isn't a pull request request's (an Orchestrator's plan, W17). */
  dismissTitle?: string;
}

const answerOf = (a: Answer): Pick<ModelAction, "onPick" | "answer" | "disabled" | "title"> =>
  typeof a === "function" ? { onPick: () => void a(), answer: a } : { onPick: () => {}, disabled: true, title: a.no };

/**
 * A Needs you item's actions, in the tray's order: Go there, the main one on every row but a ticket's, whose is Open, a
 * wire's, whose are Send (while what waits is ready) and Show, and a pull request's, whose is Check now; a typing ask's
 * Allow for 15 min and Deny, a pull request's Mark merged…, a finished step's Finish step…; then Dismiss (until its
 * state changes), or an agent's pull request request's Dismiss…. The tray offers only the bounded allowance: one until
 * it's taken back is given from the strip, with the session in view.
 */
export function needsActions(env: NeedsEnv): ModelAction[] {
  const a = env.answer;
  const dismissRow: ModelAction = { section: "needs", key: "dismiss", label: "Dismiss", title: "Take it off the list until its state changes", onPick: env.dismiss };
  if (env.wire)
    return [
      ...(env.wire.send ? [{ section: "needs", key: "send", label: "Send", primary: true, title: "Send what waits at its gate as it is: Show has it, to read or change first", ...answerOf(env.wire.send) } satisfies ModelAction] : []),
      { section: "needs", key: "show", label: "Show", primary: !env.wire.send, title: "Its send popover: what waits at its gate, and what can be done there", ...can(env.wire.show) },
      dismissRow,
    ];
  if (env.merge)
    return [
      { section: "needs", key: "check", label: "Check now", primary: true, title: "Ask its provider now whether it has merged", ...can(env.merge.check) },
      { section: "needs", key: "markMerged", label: "Mark merged…", title: "Say it merged, when Mockingbird can't tell: asked first, and the ticket and its wires go on as for a merge", ...can(env.merge.mark) },
      dismissRow,
    ];
  if (env.open)
    return [
      { section: "needs", key: "open", label: "Open", primary: true, title: env.open.title, ...can(env.open.can) },
      env.dismissRequest
        ? { section: "needs", key: "dismissRequest", label: "Dismiss…", title: env.dismissTitle ?? "Turn the request down, with a note for the agent: nothing is pushed or opened", ...can(env.dismissRequest) }
        : { section: "needs", key: "dismiss", label: "Dismiss", title: "Take it off the list until its state changes", onPick: env.dismiss },
    ];
  return [
    { section: "needs", key: "go", label: "Go there", primary: true, title: env.goTitle, ...can(env.go) },
    ...(a
      ? ([
          { section: "needs", key: "allow", label: "Allow for 15 min", title: `Let ${a.who} type in this session for 15 minutes. Allow for this session is on its strip, with the session in view`, ...answerOf(a.allow) },
          { section: "needs", key: "deny", label: "Deny", title: `Tell ${a.who} no: they can ask again in a minute`, ...answerOf(a.deny) },
        ] satisfies ModelAction[])
      : []),
    ...(env.finish ? [{ section: "needs", key: "finish", label: "Finish step…", title: "Finish its step yourself, from its latest message: what each wire out does is shown before anything moves", ...can(env.finish) } satisfies ModelAction] : []),
    dismissRow,
  ];
}

/** A workspace Connect… can wire to: its title, its area's (a heading over its rows), and why no wire to it can be made. */
export interface ConnectTarget {
  id: string;
  title: string;
  area: string;
  refused: string | null;
  pick: () => void;
}

/**
 * Connect…'s menu: under which workspace it wires, each workspace a wire can go to, under its area's name, off saying
 * why when no type of wire can be made to it (the type picker then says which can).
 */
export function connectMenu(from: string, targets: readonly ConnectTarget[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  let at: string | null = null;
  for (const t of targets) {
    if (t.area !== at) {
      at = t.area;
      out.push("-", menuHeading(t.area));
    }
    out.push({ key: `connect:${t.id}`, label: t.title, onPick: t.pick, ...(t.refused ? { disabled: true, title: t.refused } : { title: `Pick the type of wire from “${from}” to “${t.title}”` }) });
  }
  return [menuHeading(`Connect “${from}” to`), ...tidyMenu(out)];
}

/** What a wire's actions need (a right-click on it): its ends' names and type, and what each does, or why it can't. */
export interface WireEnv {
  /** "Builder → Tester". */
  title: string;
  /** Its type's name ("Feedback loop"). */
  kind: string;
  settings: Can;
  remove: () => void;
}

/** A wire's actions, in menu order (its right-click): Settings… and Remove. */
export function wireActions(env: WireEnv): ModelAction[] {
  return [
    { section: "wire", key: "settings", label: "Settings", menuLabel: "Settings…", title: "What it sends, when, its rounds and its gate", ...can(env.settings) },
    { section: "end", key: "remove", label: "Remove", menuLabel: "Remove the wire", danger: true, title: "Undo in the note puts it back as it was", onPick: env.remove },
  ];
}

/** A wire's actions as a menu, under its ends and type. */
export const wireMenu = (env: WireEnv): MenuEntry[] => [menuHeading(`${env.title} · ${env.kind}`), ...menuOf(wireActions(env))];

/** Several workspaces' actions as a menu: under how many are picked, Move to area's rows under their own heading. */
export const severalMenu = (count: number, actions: readonly ModelAction[]): MenuEntry[] => [menuHeading(`${count} selected`), ...menuOf(actions)];

/** A model's actions as a menu: each section under its heading (`names` renames some, for where they're offered), the last after a separator. */
export function menuOf(actions: readonly ModelAction[], names: Partial<Record<ActionSection, string | null>> = {}): MenuEntry[] {
  const out: (MenuEntry | null)[] = [];
  let at: ActionSection | null = null;
  for (const a of actions) {
    if (a.section !== at) {
      at = a.section;
      const name = Object.hasOwn(names, a.section) ? names[a.section] : SECTION_NAME[a.section];
      out.push("-", name ? menuHeading(name) : null);
    }
    out.push(a);
  }
  return tidyMenu(out);
}

/** The action `key` of a model, or undefined: what a chip or a button for it does. */
export const actionOf = (actions: readonly ModelAction[], key: string): ModelAction | undefined => actions.find((a) => a.key === key);

/**
 * Session `s`'s row `key` for what offers only what can be done (⌘K): shown while it can be
 * done; off with the take-over's reason while a teammate has taken the session over, where it could otherwise be done;
 * not shown where it never applies (a terminal, a teammate's session, a folder outside git).
 */
export function paneRow(s: SessionInfo, env: WorkspaceEnv, key: string): ModelAction | undefined {
  const a = actionOf(workspaceActions(s, env), key);
  if (!a?.disabled) return a;
  return s.room?.takenOver && usable(workspaceActions({ ...s, room: { ...s.room, takenOver: undefined } }, env), key) ? a : undefined;
}

/** An action that's offered and can be done now, or undefined. */
export const usable = (actions: readonly ModelAction[], key: string): ModelAction | undefined => {
  const a = actionOf(actions, key);
  return a && !a.disabled ? a : undefined;
};

/** A model's rows kept in `section`, as they are: an area's own actions joining the shared model. */
export const inSection = (section: ActionSection, entries: readonly MenuEntry[]): ModelAction[] => entries.filter((e): e is Action => e !== "-").map((a) => ({ ...a, section }));
