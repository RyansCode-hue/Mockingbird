import { AGENT_NAME, otherAgent, type SessionInfo } from "../shared/types";
import { SIZE_PRESETS, type SizePreset } from "../shared/landscape";
import { menuHeading, tidyMenu, type Action, type MenuEntry } from "./ContextMenu";
import { BellIcon, BellOffIcon, CloseIcon, FilesIcon, HandoffIcon, MoveIcon, PanelRightIcon, PencilIcon, RepaintIcon, RunDebugIcon, SearchIcon, SourceControlIcon, UndoIcon } from "./Icons";

/**
 * A workspace's actions, said once (and an area's the same way): every surface that offers them — the workspace
 * header's chips and ⋯, its right-click menu, and whatever shows them without zooming in — renders this list, so none
 * of them can offer what the others don't, or word it differently. Each action has its label, whether it can be done
 * now and why not (`disabled`, `title`), its shortcut (`kbd`) and its handler; `section` groups the menu's rows.
 */
export type ActionSection = "session" | "tools" | "terminal" | "handon" | "room" | "area" | "messages" | "end";

/** A section's heading in a menu; null: its rows follow a separator only. */
const SECTION_NAME: Record<ActionSection, string | null> = {
  session: "Session",
  tools: "Tools",
  terminal: "Terminal",
  handon: "Hand on",
  room: "Team room",
  area: "Area",
  messages: "Agent messages",
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

/** Every action of session `s`'s workspace, in menu order. */
export function workspaceActions(s: SessionInfo, env: WorkspaceEnv): ModelAction[] {
  const dead = s.status === "dead";
  const other = AGENT_NAME[otherAgent(s.agent)];
  const theirs = (what: string) => (env.owner ? { disabled: true, title: `${env.owner}'s session: theirs to ${what}` } : {});
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
    ...(noFolder && t !== "search" ? { disabled: true, title: noFolder } : {}),
  });
  out.push(tool("files", "Files", <FilesIcon />), tool("changes", "Changes", <SourceControlIcon />), tool("search", "Search", <SearchIcon />), tool("run", "Run & debug", <RunDebugIcon />));
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
    { section: "terminal", key: "undo", label: "Undo", menuLabel: "Undo the last turn…", icon: <UndoIcon />, ...can(env.undo) },
    { section: "handon", key: "handoff", label: other, menuLabel: `Continue in ${other}…`, icon: <HandoffIcon />, ...can(env.handoff) },
    { section: "handon", key: "brief", label: "Brief", menuLabel: "Fresh session from a brief…", ...can(env.brief) },
    { section: "handon", key: "review", label: "Second opinion", menuLabel: `Second opinion from ${other}`, ...can(env.secondOpinion) },
    ...env.room.map((a): ModelAction => ({ ...a, section: "room" }))
  );
  if (dead && local) out.push({ section: "end", key: "resume", label: "Resume", menuLabel: "Resume", primary: true, title: "Start it again, resuming its conversation", ...can(env.resume) });
  out.push({ section: "end", key: "close", label: "Close", menuLabel: dead ? "Close & clean up…" : "Close…", icon: <CloseIcon />, danger: true, onPick: env.close, ...theirs("close") });
  return out;
}

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

/** An action that's offered and can be done now, or undefined. */
export const usable = (actions: readonly ModelAction[], key: string): ModelAction | undefined => {
  const a = actionOf(actions, key);
  return a && !a.disabled ? a : undefined;
};

/** A model's rows kept in `section`, as they are: an area's own actions joining the shared model. */
export const inSection = (section: ActionSection, entries: readonly MenuEntry[]): ModelAction[] => entries.filter((e): e is Action => e !== "-").map((a) => ({ ...a, section }));
