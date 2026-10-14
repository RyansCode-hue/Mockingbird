/**
 * Team rooms, stage 2: sessions in a room, live. What every member's room
 * state says about each room session, what the window is told about the
 * teammates' sessions and views, and the small codecs both ends share.
 * See docs/team-rooms.md, "Sessions in a room".
 *
 * A room session is a session in a room's shared group. It runs on its
 * owner's laptop; the owner publishes a record of it (session.upsert) and
 * every member shows it, tagged with the owner's initials. Its terminal
 * streams only to members who show it, and anyone can type into it.
 */
import type { AgentKind, SessionInfo, SessionStatus } from "../types";
import { isNewer } from "../versions";
import { named } from "./agentText";
import type { MemberId, RoomId } from "./types";

/** The owner's git state for a room session's folder: the chips a pane shows. */
export interface RoomGitState {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirtyFiles: number;
  insertions: number;
  deletions: number;
}

/** What the room knows about one room session. Published by its owner only. */
export interface RoomSessionRecord {
  /** The session's id on its owner's Mockingbird. */
  id: string;
  title: string;
  /** The agent it runs; null for a terminal. */
  agent: AgentKind | null;
  status: SessionStatus;
  waitingReason: string | null;
  waitingSince: number | null;
  branch: string | null;
  /** The repository's identity across laptops: its origin URL, without credentials. */
  repo: string | null;
  /** The repository folder's name on the owner's laptop, for display. */
  repoName: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  /** The workspace (sub-group) inside the room's group, if any. */
  sub: string | null;
  model: string | null;
  createdAt: number;
  /** Running on the owner's Mockingbird; false once closed there (the owner can resume it). */
  live: boolean;
  /** The owner's terminal size: viewers render at it, never resize it. */
  cols: number;
  rows: number;
  /**
   * What the session was started with: secret reads denied (Claude, and Codex
   * from CODEX_ROOM_GUARD_SINCE) and Co-authored-by trailers for teammates'
   * turns. False for a session that joined the room while running, until it
   * restarts.
   */
  guards: { secrets: boolean; coauthors: boolean };
  git: RoomGitState | null;
}

/**
 * The first Codex release whose permission profiles a room session can run
 * under from -c settings alone: deny-read globs that no approval lifts, chosen
 * over sandbox_mode in the user's config files.
 */
export const CODEX_ROOM_GUARD_SINCE = "0.138.0";

/** Whether a Codex CLI at `version` starts room sessions unable to read secret files; false when the version is unknown. */
export const codexGuardsSecrets = (version: string | null | undefined): boolean => !!version && !isNewer(version, CODEX_ROOM_GUARD_SINCE);

/** A room session as every member's room state holds it. */
export interface RoomSessionState extends RoomSessionRecord {
  owner: MemberId;
  /** The owner's clock when this version was published (display only). */
  at: number;
}

declare module "./types" {
  interface RoomEventBodies {
    /** The owner added a room session or something about it changed. */
    "session.upsert": RoomSessionRecord;
    /** The owner closed a room session for good, or moved it out of the room. */
    "session.removed": { id: string };
  }
  interface RoomExtensions {
    /** Room sessions by roomSessionKey(owner, id). */
    sessions: Record<string, RoomSessionState>;
  }
}

/**
 * A session on a teammate's laptop, as agents address it (list_sessions,
 * send_message, the teammate tools): "<its id>@<the first 8 characters of
 * the teammate's member id>" — unique in the room, and never mistaken for a
 * local id (those have no "@").
 */
export const remoteSessionId = (sessionId: string, member: string): string => `${sessionId}@${member.slice(0, 8)}`;

export function parseRemoteId(id: string): { session: string; member: string } | null {
  const m = /^([\w-]{1,64})@([0-9a-f]{8})$/.exec(id);
  return m ? { session: m[1], member: m[2] } : null;
}

/**
 * Why agent messages to a room session are refused, from what its record
 * says (`owner`: whose it is, as words); null when they're delivered. A
 * terminal never takes them, whatever runs in it: a message typed after its
 * agent quits would run as a shell command. Teammates' views show all of
 * these sessions, so list_sessions lists them too, with this reason.
 */
export function roomMessageRefusal(s: { agent: AgentKind | null; status: SessionStatus; live: boolean }, owner: string): string | null {
  const who = named(owner, 60);
  if (!s.live) return `${who} closed it; only ${who} can resume it`;
  if (s.agent === null) {
    return `it's a terminal on ${who}'s Mac (an agent started in it by hand, or brought back in one): agent messages are never typed into terminals, where one typed after the agent quits would run as a shell command — ask ${who} to continue it in an agent pane`;
  }
  if (s.status === "dead") return `its agent has exited on ${who}'s Mac (the pane is still open) — ask ${who} to restart it`;
  return null;
}

/** A room session's key in room state and views: the same on every member's Mockingbird. */
export const roomSessionKey = (owner: MemberId, id: string): string => `${owner}:${id}`;

export function parseRoomSessionKey(key: string): { owner: MemberId; id: string } | null {
  const m = /^([0-9a-f]{32}):([\w-]{1,64})$/.exec(key);
  return m ? { owner: m[1], id: m[2] } : null;
}

/**
 * The id a teammate's session has in this window. It can't collide with a
 * local session's (those never contain "~"), and stays the same across
 * restarts, so a grid layout that holds it comes back.
 */
export const remotePaneId = (owner: MemberId, id: string): string => `r~${owner.slice(0, 12)}~${id}`;

export const isRemotePaneId = (id: string): boolean => id.startsWith("r~");

/** How a room session is tagged in the window (SessionInfo.room). */
export interface RoomSessionTag {
  roomId: RoomId;
  /** The session's id on its owner's Mockingbird. */
  sessionId: string;
  owner: MemberId;
  ownerName: string;
  /** It runs on a teammate's laptop; this window shows a copy. */
  remote: boolean;
  /** The owner's Mockingbird is connected (always true for one's own). */
  online: boolean;
  /** Running on the owner's side (false: closed there, resumable by the owner). */
  live: boolean;
  /** Teammates showing it right now; `focused` when it's the pane they're in. */
  lookers: { id: MemberId; name: string; focused: boolean }[];
  /** The owner's terminal size (a remote session renders at it). */
  cols: number;
  rows: number;
  git: RoomGitState | null;
  repo: string | null;
  repoName: string | null;
  guards: { secrets: boolean; coauthors: boolean };
  /** Why typing into it or showing it failed just now (remote only). */
  problem?: string;
  /**
   * A teammate took this install's session over (own only): it continues on
   * their laptop, and this copy has left the room — nothing of it is shared
   * any more, and teammates can't type into it.
   */
  takenOver?: { by: MemberId; byName: string; at: number };
  /**
   * Own only: this install starts its room sessions inline (Settings → Team),
   * so restarting one that joined the room while running brings it inline.
   */
  inlineOnStart?: boolean;
}

/** What a teammate is showing, in this window's session ids. */
export interface MemberView {
  member: MemberId;
  name: string;
  /** Room sessions on their screen, in their grid order. */
  shown: string[];
  /** The room session they're in, if any. */
  focused: string | null;
  /** When it last changed (this Mockingbird's clock). */
  at: number;
}

/** Everything the window needs about room sessions (window.mb.teamLive). */
export interface LivePanesState {
  /** Teammates' room sessions, as sessions this window can show. */
  remote: SessionInfo[];
  /** This install's own room sessions' tags, by session id. */
  own: Record<string, RoomSessionTag>;
  /** Connected teammates' views (one per teammate, across shared rooms). */
  views: MemberView[];
  /** Problems worth showing (a session record that couldn't be published…). */
  problems: string[];
}

// ---- the pty stream --------------------------------------------------------------

/**
 * One piece of a room session's output on its stream channel: which session,
 * which pty (the epoch changes when the session restarts) and where in that
 * pty's output it starts. A viewer that finds a position it didn't expect
 * has missed output and asks for the scrollback again.
 */
export interface PtyChunk {
  session: string;
  epoch: string;
  pos: number;
  data: string;
}

export function encodePtyChunk(c: PtyChunk): string {
  return `p1|${c.session}|${c.epoch}|${c.pos}\n${c.data}`;
}

export function decodePtyChunk(text: string): PtyChunk | null {
  const nl = text.indexOf("\n");
  if (nl < 0 || nl > 200) return null;
  const m = /^p1\|([\w-]{1,64})\|([\w-]{1,40})\|(\d{1,15})$/.exec(text.slice(0, nl));
  return m ? { session: m[1], epoch: m[2], pos: Number(m[3]), data: text.slice(nl + 1) } : null;
}

/** The stream channel a room session's output goes on. */
export const ptyChannel = (sessionId: string) => `pty:${sessionId}`;
/** The stream channel each member's view (what it shows) goes on. */
export const VIEW_CHANNEL = "view";

/** A member's view as it travels: room session keys (roomSessionKey) of one room. */
export interface ViewMessage {
  v: 1;
  shown: string[];
  focused: string | null;
  /** Teammates' sessions it shows, so their owners stream them. */
  watching: string[];
}

/** RPC methods (team.request) for live panes. */
export const LIVE_METHODS = {
  /** The owner's scrollback for a room session: PaneSnapshot. */
  scrollback: "pty.scrollback",
  /** Keystrokes for a room session, from a teammate. */
  input: "pty.input",
} as const;

/** A room session's output so far, as its owner answers pty.scrollback. */
export interface PaneSnapshot {
  data: string;
  epoch: string;
  /** Where `data` ends in the pty's output. */
  end: number;
  cols: number;
  rows: number;
}
