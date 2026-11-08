import { AGENT_NAME, otherAgent, type MessageMode, type MissingFolder, type SessionInfo } from "../shared/types";
import { LOOSE_GROUP, SIZE_PRESETS, areaKeyOf, type SizePreset } from "../shared/landscape";
import { menuHeading, tidyMenu, type Action, type MenuEntry } from "./ContextMenu";
import { BellIcon, BellOffIcon, CloseIcon, FilesIcon, HandoffIcon, MoveIcon, NoteIcon, PanelRightIcon, PencilIcon, RepaintIcon, RunDebugIcon, SearchIcon, SourceControlIcon, UndoIcon } from "./Icons";
import { firstName } from "./team/connectedModel";

/**
 * A workspace's actions, said once (and an area's the same way): every surface that offers them — the workspace
 * header's chips and ⋯, its right-click menu, and whatever shows them without zooming in — renders this list, so none
 * of them can offer what the others don't, or word it differently. Each action has its label, whether it can be done
 * now and why not (`disabled`, `title`), its shortcut (`kbd`) and its handler; `section` groups the menu's rows.
 */
export type ActionSection = "session" | "tools" | "terminal" | "handon" | "room" | "area" | "ghosts" | "messages" | "sessions" | "share" | "create" | "several" | "move" | "end";

/** A section's heading in a menu; null: its rows follow a separator only. */
const SECTION_NAME: Record<ActionSection, string | null> = {
  session: "Session",
  tools: "Tools",
  terminal: "Terminal",
  handon: "Hand on",
  room: "Team room",
  area: "Area",
  ghosts: "Ghosts",
  messages: "Agent messages",
  sessions: "Sessions",
  share: null,
  create: "New workspace",
  several: null,
  move: "Move to area",
  end: null,
};

export interface ModelAction extends Action {
  section: ActionSection;
}

/** A handler, or why it isn't there: a disabled row says so. */
export type Can = (() => void) | { no: string };

/** The tool windows a workspace opens on itself (docs/landscape.md, Tools). */
export type WorkspaceTool = "files" | "changes" | "search" | "run";

/** Shortcuts the rail's tools open with (main.tsx's keyboard layer). */
export const TOOL_KEYS: Record<WorkspaceTool | "artifacts" | "chat", string | undefined> = { files: "⇧⌘E", changes: "⌃⇧G", search: "⇧⌘F", run: "⇧⌘D", artifacts: undefined, chat: undefined };

/** What a workspace's actions need to know about it, and do. */
export interface WorkspaceEnv {
  /** A teammate's session: its owner's name. Theirs to rename, move, size and close. */
  owner: string | null;
  /** On the landscape: the size preset it's at (null: none), and why its size can't change (null: it can). Off it, null. */
  size: { current: SizePreset | null; blocked: string | null } | null;
  /** The agent's diff side panel is open in its terminal. */
  diffPanel: boolean;
  /** Take over, Take it back, Send, Review (team rooms): in that order, those that apply. */
  room: Action[];
  rename: () => void;
  mute: () => void;
  move: () => void;
  resize: (p: SizePreset) => void;
  tool: (t: WorkspaceTool) => void;
  /** Its area's Artifacts window, or why there's none (a loose workspace); null where there are no tool windows (the grid). */
  artifacts: Can | null;
  repaint: () => void;
  hidePanel: () => void;
  undo: Can;
  handoff: Can;
  brief: Can;
  secondOpinion: Can;
  close: () => void;
  resume: Can;
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
  if (env.artifacts) out.push({ section: "tools", key: "tool:artifacts", label: "Artifacts", icon: <NoteIcon />, title: "Its area's artifacts", ...can(env.artifacts) });
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
    { section: "terminal", key: "undo", label: "Undo", menuLabel: "Undo the last turn…", icon: <UndoIcon />, ...can(tookIt(env.undo, "before undoing a turn here")) },
    { section: "handon", key: "handoff", label: other, menuLabel: `Continue in ${other}…`, icon: <HandoffIcon />, ...can(tookIt(env.handoff, "to hand it on")) },
    { section: "handon", key: "brief", label: "Brief", menuLabel: "Fresh session from a brief…", ...can(tookIt(env.brief, "to hand it on")) },
    { section: "handon", key: "review", label: "Second opinion", menuLabel: `Second opinion from ${other}`, ...can(tookIt(env.secondOpinion, "to have its branch reviewed")) },
    ...env.room.map((a): ModelAction => ({ ...a, section: "room" }))
  );
  if (dead && local) out.push({ section: "end", key: "resume", label: "Resume", menuLabel: "Resume", primary: true, title: "Start it again, resuming its conversation", ...can(tookIt(env.resume, "rather than resuming this copy")) });
  out.push({ section: "end", key: "close", label: "Close", menuLabel: dead ? "Close & clean up…" : "Close…", icon: <CloseIcon />, danger: true, onPick: env.close, ...theirs("close") });
  return out;
}

/** What making a workspace needs (right-click on empty landscape): today's New Session dialog, opened for each kind. */
export interface CreateEnv {
  launch: (kind: "claude" | "codex" | "shell") => void;
  /** The dialog with its ticket picker open. */
  ticket: () => void;
  /** The dialog's Import, resuming a conversation from this Mac. */
  importIt: () => void;
}

/** The kinds of workspace that can be made here, and those still to come (docs/landscape.md, Workspaces: Create). */
export function createActions(env: CreateEnv): ModelAction[] {
  const coming = (key: string, label: string, title: string): ModelAction => ({ section: "create", key, label, menuLabel: `${label} (coming)`, disabled: true, title, onPick: () => {} });
  return [
    { section: "create", key: "new:claude", label: "Claude", menuLabel: "Claude…", onPick: () => env.launch("claude") },
    { section: "create", key: "new:codex", label: "Codex", menuLabel: "Codex…", onPick: () => env.launch("codex") },
    { section: "create", key: "new:shell", label: "Terminal", menuLabel: "Terminal…", onPick: () => env.launch("shell") },
    { section: "create", key: "new:ticket", label: "From a ticket", menuLabel: "From a ticket…", onPick: env.ticket },
    { section: "create", key: "new:import", label: "Import", menuLabel: "Import…", onPick: env.importIt },
    coming("new:collab", "Collab…", "Collab workspaces, where several agents talk a change through, come in a later version"),
    coming("new:pipeline", "Pipeline from a ticket…", "Pipeline templates come in a later version"),
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
  const reopenTitle = several ? `Start its ${env.tabs} tabs again where it was, resuming their conversations` : env.gone?.reopens ? env.gone.why : "Start it again where it was, resuming its conversation";
  const out: ModelAction[] = [
    {
      section: "end",
      key: "reopen",
      label: "Reopen",
      menuLabel: several ? `Reopen its ${env.tabs} tabs` : undefined,
      primary: true,
      title: reopenTitle,
      ...can(busy ?? (taken ? { no: taken } : cantRun ? { no: cantRun } : env.reopen)),
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
 * Reopen all and Clear ghosts (Previous's restore all and its ✕ on each): an area's ⋯, the loose ones' (the tree's
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
    { section: "ghosts", key: "clearGhosts", label: clearLabel, menuLabel: n ? `${clearLabel} (${n})…` : clearLabel, danger: true, title: `Forget every ${what} here: they can't be reopened after`, ...can(n ? (g.running ? { no: "Wait for Reopen all to finish" } : g.clear) : none) },
  ];
}

/** What an area's actions need to know about it, and do (main.tsx's `areaActions` makes it). */
export interface AreaEnv {
  title: string;
  /** Its record on the landscape (collapsed, locked); null where it has none (the grid). */
  stored: { collapsed?: boolean; locked?: boolean } | null;
  /** A team room's area: the room tools (Chat, Board, Members, Follow) are only ever a room's. */
  room: boolean;
  /** The landscape is on: tool windows, the House board and following live there. */
  landscape: boolean;
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

/** A group's choices for agents' messages (its area's menu, the grid's group bar): one is on, so each says what it does differently. */
export const messageModes = (defaultSend: boolean): { value: MessageMode | ""; label: string; title: string }[] => [
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
  if (env.landscape) {
    out.push({ section: "tools", key: "tool:artifacts", label: "Artifacts", icon: <NoteIcon />, title: env.room ? "The room's artifacts" : "The area's artifacts, on this Mac", onPick: env.artifacts });
    if (env.room) out.push({ section: "tools", key: "tool:chat", label: "Chat", icon: env.chatIcon, title: "The room's chat", onPick: env.chat });
  }
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
    if (env.landscape) {
      out.push({ section: "room", key: "board", label: "Board", menuLabel: "House board…", title: "House board — the room's Radley House tickets and who has each", onPick: env.board });
      const f = env.follow;
      if (f.leader) out.push({ section: "room", key: "follow:stop", label: `Stop following ${firstName(f.leader)}`, title: `Stop mirroring ${f.leader}'s view`, onPick: f.stop });
      else for (const v of f.candidates) out.push({ section: "room", key: `follow:${v.member}`, label: `Follow ${firstName(v.name)}`, title: `Mirror ${v.name}'s view: the shared workspace they're in is brought into view and selected`, onPick: () => f.start(v.member) });
    }
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

/** Several workspaces' actions as a menu: under how many are picked, Move to area's rows under their own heading. */
export const severalMenu = (count: number, actions: readonly ModelAction[]): MenuEntry[] => [menuHeading(`${count} selected`), ...menuOf(actions)];

/** A model's actions as a menu: each section under its heading, the last after a separator. */
export function menuOf(actions: readonly ModelAction[]): MenuEntry[] {
  const out: (MenuEntry | null)[] = [];
  let at: ActionSection | null = null;
  for (const a of actions) {
    if (a.section !== at) {
      at = a.section;
      const name = SECTION_NAME[a.section];
      out.push("-", name ? menuHeading(name) : null);
    }
    out.push(a);
  }
  return tidyMenu(out);
}

/** The action `key` of a model, or undefined: what a chip or a button for it does. */
export const actionOf = (actions: readonly ModelAction[], key: string): ModelAction | undefined => actions.find((a) => a.key === key);

/**
 * Session `s`'s row `key` for what offers only what can be done (the grid's pane header, ⌘K): shown while it can be
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
