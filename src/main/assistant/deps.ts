import type { AssistantWindowAction } from "../../shared/assistant";
import type { PermissionMode } from "../../shared/permissionModes";
import type { AgentKind, SessionStatus } from "../../shared/types";

/**
 * What the Assistant's tools reach the app through (index.ts makes it; tests fake it). Each group takes the part it
 * uses (Pick<AssistantDeps, …>). It carries state and actions, never a session's output, files, environment or
 * secrets: no tool can read what isn't here.
 */

/** A session as the Assistant sees it: its state, never its output. */
export interface AssistantSession {
  id: string;
  /** Its title as the landscape shows it (its ticket's title when it has one). */
  title: string;
  agent: AgentKind | "terminal";
  status: SessionStatus;
  /** Why it waits on the user (its agent's notice), and since when (ms); null when it doesn't. */
  waitingReason: string | null;
  waitingSince: number | null;
  /** Its group's key ("atticus", "5038/api"); null when it's in none. */
  group: string | null;
  /** The team room its group is shared as, by name; null outside one. */
  room: string | null;
  /** Its repository's folder name. */
  repo: string | null;
  branch: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  /** This Mac's own; false for a teammate's room session, whose owner `owner` names. */
  mine: boolean;
  owner?: string;
  /** The Helpdesk tasks workspace: its status and lifecycle are the Assistant's to act on, its conversation never. */
  helpdesk: boolean;
}

/** A top-level group, as the landscape and the sessions have it. */
export interface AssistantGroup {
  key: string;
  /** Its sub-groups' keys ("5038/api"): each a stack of workspaces. */
  stacks: string[];
  /** This Mac's running sessions in it, its stacks' included. */
  sessions: number;
  /** The team room it's shared as, by name; null when it isn't. */
  room: string | null;
  /** It has an area on the landscape. */
  area: boolean;
}

/** A team room this install is in. */
export interface AssistantRoom {
  id: string;
  name: string;
  /** The local group it's shown as. */
  group: string;
  /** Its members' names, this install's own first. */
  members: string[];
  /** How many teammates are connected now. */
  online: number;
}

export interface AssistantDeps {
  /** Every session the landscape shows: this Mac's running ones, and teammates' room sessions. */
  sessions(): AssistantSession[];
  groups(): AssistantGroup[];
  rooms(): AssistantRoom[];
  /** A step only the window can take (`assistant:window`). */
  toWindow(action: AssistantWindowAction): void;
  /** Rename this Mac's session `id`, as the window's Rename does. Throws why not. */
  rename(id: string, title: string): void;
  /**
   * Why this Mac's session `id` can't be restarted now (a teammate continues it, it's being resumed…), or null when it
   * can. The session guards' answer for a relaunch (sessionGuards.ts whyNot).
   */
  relaunchRefusal(id: string): string | null;
  /** Restart session `id` in place: its agent stopped and started again on the same conversation. Throws why not. */
  relaunch(id: string): Promise<void>;
}
