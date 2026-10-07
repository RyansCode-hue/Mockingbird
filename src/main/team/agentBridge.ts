import * as path from "path";
import { parseRemoteId, type Messaging, type RemoteAgents, type RemoteSendResult, type RoomSessionInfo, type SenderInfo, type TeammateSessions } from "../messaging";
import { TeamError, type Team, type Unsubscribe } from "./transport";
import { topOfKey, type SessionInfo } from "../../shared/types";
import type { MemberId, RoomId } from "../../shared/team/types";

/**
 * Mockingbird's agent messaging across laptops (docs/team-rooms.md → Team
 * room): a room session's list_sessions also lists the room sessions
 * teammates run, and send_message to one goes through the room to the
 * owner's Mockingbird, which delivers it by its own rules and answers with
 * what happened.
 *
 * A session is in a room when its top-level group is the group the room is
 * shown as on this install. Only those are ever listed to teammates, and
 * only to members of that room (the transport checks membership of the room
 * a request names). Two requests:
 *
 *   agents.list   {}                      → { sessions: RoomSessionInfo[] }
 *   agents.send   { from, to, text }      → { status, detail, toTitle? }
 */

export const AGENT_REQUESTS = { list: "agents.list", send: "agents.send" } as const;

const LIST_TIMEOUT_MS = 5_000;
const SEND_TIMEOUT_MS = 15_000;
const STATUSES = new Set(["working", "waiting", "idle", "dead"]);

export interface AgentBridgeDeps {
  /** This install's sessions (the session manager's list). */
  sessions: () => SessionInfo[];
  /** Which local group each room is shown as. */
  roomGroups: () => { roomId: RoomId; groupKey: string }[];
  /**
   * The room a session of this install's is in, when the live panes say
   * (a session a teammate took over has left its room). Without it, a
   * session's room is its top-level group's.
   */
  roomOf?: (sessionId: string) => RoomId | null;
  log: (msg: string) => void;
  now?: () => number;
}

/** A session teammates may see: a live agent pane (no terminals, debriefs or assistant panes). */
const shareable = (s: SessionInfo) => s.status !== "dead" && !s.shell && !s.debrief && s.kind === "work";

export class AgentBridge implements RemoteAgents {
  private team: Team | null = null;
  private messaging: Messaging | null = null;
  private offs: Unsubscribe[] = [];
  /** Per room and teammate: the sessions they answered with last, for when they're offline. */
  private seen = new Map<RoomId, Map<MemberId, { at: number; sessions: RoomSessionInfo[] }>>();
  private readonly now: () => number;

  constructor(private d: AgentBridgeDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Answer teammates' requests, delivering their messages through `messaging`. */
  attach(team: Team, messaging: Messaging): void {
    this.detach();
    this.team = team;
    this.messaging = messaging;
    this.offs.push(
      team.onRequest(AGENT_REQUESTS.list, (_params, ctx) => {
        if (!ctx.roomId) throw new Error("name the room whose sessions to list");
        return { sessions: this.localSessions(ctx.roomId).map(describe) };
      }),
      team.onRequest(AGENT_REQUESTS.send, (p, ctx) => {
        if (!ctx.roomId) throw new Error("name the room the message goes through");
        const roomId = ctx.roomId;
        const from = senderOf(p?.from);
        if (!from || typeof p.to !== "string" || typeof p.text !== "string") throw new Error("malformed agent message");
        const member = { id: ctx.from, name: this.nameOf(roomId, ctx.from) };
        return this.messaging!.receiveRemote({ member, from, to: p.to, text: p.text }, (s) => this.roomOf(s) === roomId);
      })
    );
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
    this.team = null;
  }

  roomOf(session: SessionInfo): RoomId | null {
    if (this.d.roomOf) return this.d.roomOf(session.id);
    if (!session.taskGroup) return null;
    const top = topOfKey(session.taskGroup);
    return this.d.roomGroups().find((r) => r.groupKey === top)?.roomId ?? null;
  }

  /** This install's live agent sessions in a room. */
  localSessions(roomId: RoomId): SessionInfo[] {
    return this.d.sessions().filter((s) => shareable(s) && this.roomOf(s) === roomId);
  }

  /** Each teammate's sessions in the room: asked now when they're connected, else as last seen. */
  async list(roomId: RoomId): Promise<TeammateSessions[]> {
    const team = this.team;
    const room = team?.room(roomId);
    if (!team || !room) return [];
    const online = new Set(team.presence(roomId));
    const seen = this.seen.get(roomId) ?? new Map();
    this.seen.set(roomId, seen);
    return Promise.all(
      room.members
        .filter((m) => m.id !== team.self.id)
        .map(async (m): Promise<TeammateSessions> => {
          const stale = (problem: string): TeammateSessions => {
            const last = seen.get(m.id);
            return { member: m.id, name: m.name, connected: false, problem, ...(last ? { at: last.at, sessions: last.sessions } : { sessions: [] }) };
          };
          if (!online.has(m.id)) return stale(`${m.name} is offline`);
          try {
            const r = await team.request<{ sessions?: unknown }>(m.id, AGENT_REQUESTS.list, {}, { roomId, timeoutMs: LIST_TIMEOUT_MS });
            const sessions = Array.isArray(r?.sessions) ? r.sessions.map(sessionInfo).filter((s): s is RoomSessionInfo => !!s) : null;
            if (!sessions) throw new Error("its answer had no session list");
            seen.set(m.id, { at: this.now(), sessions });
            return { member: m.id, name: m.name, connected: true, at: this.now(), sessions };
          } catch (err) {
            const problem = problemOf(err, m.name);
            this.d.log(`listing ${m.name}'s sessions in ${room.name} failed: ${problem}`);
            return stale(problem);
          }
        })
    );
  }

  /** Send to a teammate's session ("<id>@<member>") through the room, with what became of it. */
  async send(roomId: RoomId, from: SenderInfo, to: string, text: string): Promise<RemoteSendResult> {
    const team = this.team;
    const room = team?.room(roomId);
    if (!team || !room) return { status: "refused", detail: "team rooms aren't running on this Mockingbird", owner: "the teammate" };
    const target = parseRemoteId(to);
    const member = target && room.members.find((m) => m.id !== team.self.id && m.id.startsWith(target.member));
    if (!target || !member) return { status: "refused", detail: `no teammate in this room runs "${to}" — call list_sessions for current ids`, owner: "the teammate" };
    const knownTitle = this.seen.get(roomId)?.get(member.id)?.sessions.find((s) => s.id === target.session)?.title;
    const base = { owner: member.name, ...(knownTitle ? { toTitle: knownTitle } : {}) };
    if (!team.presence(roomId).includes(member.id)) {
      return { ...base, status: "offline", detail: `${member.name}'s Mockingbird isn't connected right now, so nothing was sent — try again once they're back` };
    }
    try {
      const r = await team.request<{ status?: unknown; detail?: unknown; toTitle?: unknown }>(member.id, AGENT_REQUESTS.send, { from, to: target.session, text }, { roomId, timeoutMs: SEND_TIMEOUT_MS });
      const status = r?.status === "delivered" || r?.status === "queued" || r?.status === "refused" ? r.status : null;
      if (!status) throw new TeamError("remote", "its answer said nothing about the delivery");
      return { ...base, status, detail: String(r.detail ?? status).slice(0, 500), ...(typeof r.toTitle === "string" ? { toTitle: r.toTitle.slice(0, 300) } : {}) };
    } catch (err) {
      const problem = problemOf(err, member.name);
      this.d.log(`a message to ${to} in ${room.name} failed: ${problem}`);
      const code = err instanceof TeamError ? err.code : null;
      if (code === "offline" || code === "closed") return { ...base, status: "offline", detail: `${problem}, so nothing was sent` };
      if (code === "timeout" || code === "disconnected") return { ...base, status: "unconfirmed", detail: `${problem} — it may or may not have arrived` };
      return { ...base, status: "refused", detail: problem };
    }
  }

  private nameOf(roomId: RoomId, id: MemberId): string {
    return this.team?.room(roomId)?.members.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  }
}

function describe(s: SessionInfo): RoomSessionInfo {
  return {
    id: s.id,
    title: s.ticketTitle ?? s.title,
    agent: s.agent ?? "claude",
    repo: s.repoPath ? path.basename(s.repoPath) : null,
    branch: s.branch,
    status: s.status,
    ...(s.status === "waiting" ? { waitingReason: s.waitingReason } : {}),
  };
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const strOrNull = (v: unknown, max: number): string | null | undefined => (v === null ? null : str(v, max) ?? undefined);

/** A teammate's description of one of its sessions, or null when it isn't one. */
function sessionInfo(v: any): RoomSessionInfo | null {
  const id = str(v?.id, 64);
  const title = str(v?.title, 300);
  const repo = strOrNull(v?.repo, 200);
  const branch = strOrNull(v?.branch, 200);
  if (!id || !/^[\w-]+$/.test(id) || title === null || repo === undefined || branch === undefined || !STATUSES.has(v.status)) return null;
  return {
    id,
    title,
    agent: v.agent === "codex" ? "codex" : "claude",
    repo,
    branch,
    status: v.status,
    ...(typeof v.waitingReason === "string" ? { waitingReason: v.waitingReason.slice(0, 300) } : {}),
  };
}

/** The sending session as a teammate described it, or null when malformed. */
function senderOf(v: any): SenderInfo | null {
  const id = str(v?.id, 64);
  const title = str(v?.title, 300);
  const repo = strOrNull(v?.repo, 200);
  const branch = strOrNull(v?.branch, 200);
  if (!id || !/^[\w-]+$/.test(id) || title === null || repo === undefined || branch === undefined) return null;
  return { id, title, agent: v.agent === "codex" ? "codex" : "claude", repo, branch };
}

function problemOf(err: unknown, name: string): string {
  if (err instanceof TeamError) {
    switch (err.code) {
      case "offline":
      case "closed":
        return `${name}'s Mockingbird isn't connected`;
      case "timeout":
        return `${name}'s Mockingbird didn't answer in time`;
      case "disconnected":
        return `${name}'s Mockingbird disconnected before answering`;
      case "no-handler":
        return `${name}'s Mockingbird can't take agent messages yet (it needs an update)`;
      case "forbidden":
        return `${name}'s Mockingbird doesn't count this install as a member of the room`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
