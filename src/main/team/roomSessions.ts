import { defineEventType, onMemberRemoved } from "./rooms";
import { hasCredentials } from "../git";
import { AGENT_KINDS, splitGroupKey, type SessionInfo, type SessionStatus, type WorktreeStateInfo } from "../../shared/types";
import { roomSessionKey, type RoomGitState, type RoomSessionRecord } from "../../shared/team/livePanes";
import type { MemberId, RoomId } from "../../shared/team/types";
import type { Coauthor } from "./coauthors";

/**
 * Room sessions in the room log (docs/team-rooms.md, "Sessions in a room"):
 * the owner publishes session.upsert whenever something a teammate sees
 * changes, and session.removed when the session closes for good or leaves
 * the room. Only the owner (the event's author) can change its sessions.
 *
 * Other stages reach room sessions through the end of this file: the running
 * live panes are a RoomSessionSource (take-over is built on that one), and
 * isRoomSession, roomOfSession and onTurnEnded answer for whichever live
 * panes run in this process.
 */

const STATUSES: SessionStatus[] = ["working", "waiting", "idle", "dead"];

const text = (v: unknown, what: string, max: number, nullable = false): void => {
  if (nullable && v === null) return;
  if (typeof v !== "string" || v.length > max) throw new Error(`${what} must be text of up to ${max} characters`);
};
const count = (v: unknown, what: string, max: number): void => {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new Error(`${what} must be a whole number up to ${max}`);
};
const time = (v: unknown, what: string, nullable = false): void => {
  if (nullable && v === null) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${what} must be a time`);
};
export const SESSION_ID_RE = /^[\w-]{1,64}$/;

function validateGit(g: unknown): void {
  if (g === null) return;
  if (!g || typeof g !== "object") throw new Error("git must be an object or null");
  const x = g as Record<string, unknown>;
  text(x.branch, "git.branch", 300);
  text(x.upstream, "git.upstream", 300, true);
  for (const k of ["ahead", "behind", "dirtyFiles", "insertions", "deletions"]) count(x[k], `git.${k}`, 10_000_000);
}

/** Throws when a session.upsert body isn't a record. */
export function validateRecord(b: unknown): asserts b is RoomSessionRecord {
  if (!b || typeof b !== "object") throw new Error("no body");
  const r = b as Record<string, unknown>;
  if (typeof r.id !== "string" || !SESSION_ID_RE.test(r.id)) throw new Error("bad session id");
  text(r.title, "title", 300);
  if (r.agent !== null && !AGENT_KINDS.includes(r.agent as never)) throw new Error("bad agent");
  if (!STATUSES.includes(r.status as SessionStatus)) throw new Error("bad status");
  text(r.waitingReason, "waitingReason", 500, true);
  time(r.waitingSince, "waitingSince", true);
  text(r.branch, "branch", 300, true);
  text(r.repo, "repo", 500, true);
  if (typeof r.repo === "string" && hasCredentials(r.repo)) throw new Error("repo must not carry credentials");
  text(r.repoName, "repoName", 200, true);
  text(r.ticketId, "ticketId", 100, true);
  text(r.ticketTitle, "ticketTitle", 300, true);
  text(r.sub, "sub", 200, true);
  text(r.model, "model", 100, true);
  time(r.createdAt, "createdAt");
  if (typeof r.live !== "boolean") throw new Error("live must be true or false");
  count(r.cols, "cols", 1000);
  count(r.rows, "rows", 1000);
  const g = r.guards as Record<string, unknown> | null;
  if (!g || typeof g.secrets !== "boolean" || typeof g.coauthors !== "boolean") throw new Error("bad guards");
  validateGit(r.git);
}

defineEventType("session.upsert", {
  validate: (b) => validateRecord(b),
  reduce(state, e) {
    const sessions = (state.ext.sessions ??= {});
    sessions[roomSessionKey(e.author, e.body.id)] = { ...e.body, owner: e.author, at: e.at };
  },
});

defineEventType("session.removed", {
  validate(b: any) {
    if (!b || typeof b.id !== "string" || !SESSION_ID_RE.test(b.id)) throw new Error("bad session id");
  },
  reduce(state, e) {
    if (state.ext.sessions) delete state.ext.sessions[roomSessionKey(e.author, e.body.id)];
  },
});

// a member who left or was removed takes their sessions out of the room (on their Mac they carry on as local sessions)
onMemberRemoved("sessions", (state, member) => {
  const sessions = state.ext.sessions;
  if (!sessions) return;
  for (const [k, s] of Object.entries(sessions)) if (s.owner === member) delete sessions[k];
});

/** What a room session's record holds besides what SessionInfo says. */
export interface RecordExtras {
  live: boolean;
  repo: string | null;
  cols: number;
  rows: number;
  guards: RoomSessionRecord["guards"];
  git: RoomGitState | null;
}

const cut = (s: string | null | undefined, max: number): string | null => (s == null ? null : s.slice(0, max));

/** A session as its room's record. */
export function recordFor(info: SessionInfo, x: RecordExtras): RoomSessionRecord {
  const repoName = info.repoPath ? info.repoPath.split("/").filter(Boolean).pop() ?? null : null;
  return {
    id: info.id,
    title: info.title.slice(0, 300),
    agent: info.shell ? null : info.agent ?? "claude",
    status: x.live ? info.status : "dead",
    waitingReason: x.live && info.status === "waiting" ? cut(info.waitingReason, 500) : null,
    waitingSince: x.live && info.status === "waiting" ? info.waitingSince : null,
    branch: cut(info.branch, 300),
    repo: cut(x.repo, 500),
    repoName: cut(repoName, 200),
    ticketId: cut(info.ticketId, 100),
    ticketTitle: cut(info.ticketTitle, 300),
    sub: cut(info.taskGroup ? splitGroupKey(info.taskGroup).sub : null, 200),
    model: cut(info.model ?? null, 100),
    createdAt: info.createdAt,
    live: x.live,
    cols: Math.min(1000, Math.max(1, Math.round(x.cols))),
    rows: Math.min(1000, Math.max(1, Math.round(x.rows))),
    guards: x.guards,
    git: x.git,
  };
}

export const gitOf = (w: WorktreeStateInfo): RoomGitState => ({
  branch: w.branch,
  upstream: w.upstream,
  ahead: w.ahead,
  behind: w.behind,
  dirtyFiles: w.dirtyFiles,
  insertions: w.insertions,
  deletions: w.deletions,
});

/**
 * A repository's identity across laptops: its origin URL, never with
 * credentials (https://user:token@host/…) or a query string in it.
 */
export function originIdentity(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return null; // not a URL after all: never publish what can't be cleaned
    }
  }
  // scp-like git@host:org/repo.git: the user is a fixed name, not a credential
  return /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u) || /^[\w.-]+:[^\s]+$/.test(u) ? u : null;
}

// ---- for other stages ------------------------------------------------------------------

/** A room session's agent turn ended (stage 3 snapshots then; stage 4 posts an update). */
export interface TurnEnded {
  sessionId: string;
  roomId: RoomId;
  /** Its status now: idle, or dead when the agent exited mid-turn. */
  status: SessionStatus;
  /** Teammates who typed into the turn (the owner isn't listed). */
  drivers: Coauthor[];
}

/** What the running live panes answer about this install's room sessions. */
export interface RoomSessionLookup {
  /** The room a session of this install's is in; null outside rooms, and once a teammate took it over. */
  roomOfSession(id: string): RoomId | null;
}

/** The live panes as other stages use them: room sessions, and their turn ends. */
export interface RoomSessionSource extends RoomSessionLookup {
  /** Hear when one of this install's room sessions ends an agent turn. Returns the unsubscribe. */
  onTurnEnded(cb: (e: TurnEnded) => void): () => void;
}

/** Listeners for turn ends; one failing never stops the others. */
export class TurnFeed {
  private listeners = new Set<(e: TurnEnded) => void>();

  on(cb: (e: TurnEnded) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(e: TurnEnded): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error(`[team] a turn-ended listener failed for session ${e.sessionId}:`, err);
      }
    }
  }
}

let lookup: RoomSessionLookup | null = null;
const turns = new TurnFeed();

/** Set by the live panes when they start (null when they stop). */
export function setRoomSessionLookup(l: RoomSessionLookup | null): void {
  lookup = l;
}

/** The room a session of this install's is shared in, or null (not in a shared group, or team rooms aren't running). */
export function roomOfSession(id: string): RoomId | null {
  return lookup?.roomOfSession(id) ?? null;
}

/** Whether a session of this install's runs in a room (its group is shared). */
export function isRoomSession(id: string): boolean {
  return roomOfSession(id) !== null;
}

/** Hear when a room session's turn ends, whichever live panes run it. Returns the unsubscribe. */
export function onTurnEnded(cb: (e: TurnEnded) => void): () => void {
  return turns.on(cb);
}

export function turnEnded(e: TurnEnded): void {
  turns.emit(e);
}

/** Who a member is in a room (its name there). */
export const memberName = (members: { id: MemberId; name: string }[], id: MemberId): string => members.find((m) => m.id === id)?.name ?? id.slice(0, 8);
