import { AgentBridge } from "./agentBridge";
import { RoomAssistant } from "./assistant";
import { AgentUpdateFeed } from "./agentUpdates";
import { TeamChat } from "./chat";
import type { Team, Unsubscribe } from "./transport";
import type { Messaging, RoomSessionInfo } from "../messaging";
import type { SessionInfo } from "../../shared/types";
import type { RoomEvent, RoomId } from "../../shared/team/types";

/**
 * The team room on this install: its chat, the agent updates posted to it,
 * the @assistant, and agent messaging across laptops — put together over the
 * team transport. index.ts makes one, starts it once the transport and
 * agent messaging are up, and tells it when the session list changes.
 */

export interface TeamRoomDeps {
  /** This install's sessions. */
  sessions: () => SessionInfo[];
  /** Its closed sessions that can be resumed (see AgentBridgeDeps.resumable). */
  resumable?: () => SessionInfo[];
  /** Which local group each room is shown as. */
  roomGroups: () => { roomId: RoomId; groupKey: string }[];
  /** The room a session of this install's is in (the live panes'); see AgentBridgeDeps.roomOf. */
  roomOf?: (sessionId: string) => RoomId | null;
  /** See AgentBridgeDeps.guardsOf. */
  guardsOf?: (sessionId: string) => { secrets: boolean } | null;
  /** One headless turn of the user's own agent CLI (the assistant). */
  ask: (prompt: string) => Promise<string>;
  /** The room's Radley House board for the assistant (the House service's); null when the room has no project. */
  houseBoard: (roomId: RoomId) => Promise<string | null>;
  /** The assistant prompt's room artifacts part (see AssistantDeps.artifacts). */
  artifacts?: (roomId: RoomId, question: RoomEvent<"chat.message">) => Promise<string | null>;
  /** Tell the window a room's chat changed ("*": any room's may have). */
  chatChanged: (roomId: RoomId) => void;
  notify: (n: { roomId: RoomId; title: string; body: string }) => void;
  windowFocused: () => boolean;
  log: (msg: string) => void;
  /** Where the chat's read marks live (default ~/.mockingbird/team). */
  dir?: string;
  /** Agent updates: how long a burst gathers, and the least time between two posts to a room. */
  updates?: { groupMs?: number; minGapMs?: number };
  /** How long mentions gather into one notification. */
  notifyGatherMs?: number;
}

const GROUPS_TTL_MS = 5_000;

export class TeamRoom {
  readonly chat: TeamChat;
  readonly bridge: AgentBridge;
  readonly updates: AgentUpdateFeed;
  readonly assistant: RoomAssistant;
  private team: Team | null = null;
  private offs: Unsubscribe[] = [];
  private groups: { at: number; list: { roomId: RoomId; groupKey: string }[] } | null = null;

  constructor(private d: TeamRoomDeps) {
    const roomGroups = () => {
      if (!this.groups || Date.now() - this.groups.at > GROUPS_TTL_MS) this.groups = { at: Date.now(), list: d.roomGroups() };
      return this.groups.list;
    };
    this.bridge = new AgentBridge({ sessions: d.sessions, resumable: d.resumable, roomGroups, roomOf: d.roomOf, guardsOf: d.guardsOf, log: d.log });
    this.assistant = new RoomAssistant({
      ask: d.ask,
      room: (roomId) => this.team?.room(roomId),
      sessions: (roomId) => this.sessionLines(roomId),
      repoDir: (roomId) => this.bridge.localSessions(roomId).find((s) => s.repoPath)?.cwd ?? null,
      board: d.houseBoard,
      publish: (roomId, body) => this.need().publish(roomId, "chat.assistant", body),
      log: d.log,
      artifacts: d.artifacts,
    });
    this.chat = new TeamChat({
      dir: d.dir,
      emit: d.chatChanged,
      notify: d.notify,
      windowFocused: d.windowFocused,
      notifyGatherMs: d.notifyGatherMs,
      askAssistant: (roomId, question) => void this.assistant.ask(roomId, question),
      log: d.log,
    });
    this.updates = new AgentUpdateFeed({
      roomOf: (s) => this.bridge.roomOf(s),
      publish: (roomId, items) => this.need().publish(roomId, "chat.update", { items }),
      log: d.log,
      ...d.updates,
    });
  }

  /** Listen to the team, answer teammates' agent requests, and let `messaging` reach their sessions. */
  start(team: Team | null, messaging: Messaging): void {
    this.stop();
    if (!team) {
      this.d.log("team rooms aren't running, so the room chat and teammates' sessions are unavailable");
      return;
    }
    this.team = team;
    this.chat.attach(team);
    this.bridge.attach(team, messaging);
    messaging.setRemote(this.bridge);
    this.offs.push(
      team.onEvent("*", (e, room) => this.updates.roomEvent(e, room, team.self.id)),
      team.onRoomsChanged(() => (this.groups = null))
    );
    this.updates.sessionsChanged(this.d.sessions());
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.chat.detach();
    this.bridge.detach();
    this.updates.flushAll();
    this.team = null;
  }

  /** The session list changed. */
  sessionsChanged(): void {
    this.updates.sessionsChanged(this.d.sessions());
  }

  private need(): Team {
    if (!this.team) throw new Error("Team rooms haven't started");
    return this.team;
  }

  /** The room's sessions on every laptop, for the assistant. */
  private async sessionLines(roomId: RoomId): Promise<string[]> {
    const team = this.need();
    const me = team.room(roomId)?.members.find((m) => m.id === team.self.id)?.name ?? "you";
    const line = (owner: string, s: RoomSessionInfo, offline = false) =>
      `- ${owner} · "${s.title}" (${s.agent}${s.branch ? `, branch ${s.branch}` : ""}) — ${offline ? `${s.status} when last seen` : s.status}${s.waitingReason ? `: ${s.waitingReason}` : ""}`;
    const lines = this.bridge.localSessions(roomId).map((s) =>
      line(me, { id: s.id, title: s.ticketTitle ?? s.title, agent: s.agent ?? "claude", repo: null, branch: s.branch, status: s.status, waitingReason: s.status === "waiting" ? s.waitingReason : null })
    );
    for (const t of await this.bridge.list(roomId)) {
      lines.push(...t.sessions.map((s) => line(t.name, s, !t.connected)));
      if (!t.connected) lines.push(`- ${t.name}: ${t.problem ?? "not connected"}${t.sessions.length ? "" : " (their sessions aren't known)"}`);
    }
    return lines;
  }
}
