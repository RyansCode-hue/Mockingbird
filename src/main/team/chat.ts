import * as path from "path";
import { readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { TEAM_DIR } from "./identity";
import { defineEventType } from "./rooms";
import type { Team, Unsubscribe } from "./transport";
import { MEMBER_ID_RE } from "../../shared/team/protocol";
import {
  ASSISTANT_MENTION,
  MAX_ASSISTANT_TEXT,
  MAX_CHAT_ENTRIES,
  MAX_CHAT_TEXT,
  MAX_UPDATE_ITEMS,
  isRead,
  mentionsOf,
  parseMentions,
  unreadCounts,
  type ChatEntry,
  type ChatState,
  type ChatUnread,
  type ReadMarks,
  type RoomChatView,
} from "../../shared/team/chat";
import type { MemberId, RoomEvent, RoomId, RoomState } from "../../shared/team/types";

/**
 * The team room's chat (docs/team-rooms.md → Team room). Three room events:
 *
 *   chat.message    a member's message, with the mentions the poster resolved
 *   chat.assistant  the @assistant's turn for one message: "thinking", then an
 *                   answer or an error, all signed by the asker's install (it
 *                   runs there, under the asker's account)
 *   chat.update     a group of agent updates from the author's own room sessions
 *
 * Each room keeps its newest MAX_CHAT_ENTRIES entries in its reduced state
 * (state.ext.chat), in room-log order. What this install has read is its own
 * business: per room and author, the newest Lamport time read
 * (~/.mockingbird/team/chat-read.json). An author's Lamport times only count
 * up, so a message written offline and merged later still shows as unread.
 */

// ---- event types --------------------------------------------------------------------------------

const UPDATE_KINDS = new Set(["started", "finished", "waiting", "ended", "takeover", "board"]);
const ASSISTANT_STATES = new Set(["thinking", "answer", "error"]);

const text = (v: unknown, what: string, max: number, min = 0): string => {
  if (typeof v !== "string" || v.length > max || v.trim().length < min) throw new Error(`${what} must be text of ${min}–${max} characters`);
  return v;
};

function chatOf(state: RoomState): ChatState {
  return (state.ext.chat ??= { entries: [] });
}

function append(chat: ChatState, entry: ChatEntry): void {
  chat.entries.push(entry);
  if (chat.entries.length > MAX_CHAT_ENTRIES) chat.entries.splice(0, chat.entries.length - MAX_CHAT_ENTRIES);
}

defineEventType("chat.message", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    text(b.text, "text", MAX_CHAT_TEXT, 1);
    if (!Array.isArray(b.mentions) || b.mentions.length > 50) throw new Error("mentions must be a list");
    for (const m of b.mentions) if (m !== ASSISTANT_MENTION && (typeof m !== "string" || !MEMBER_ID_RE.test(m))) throw new Error("a mention isn't a member or the assistant");
  },
  reduce(state, e) {
    append(chatOf(state), { id: e.id, kind: "message", author: e.author, lamport: e.lamport, at: e.at, text: e.body.text, mentions: e.body.mentions });
  },
});

defineEventType("chat.assistant", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    text(b.replyTo, "replyTo", 64, 1);
    if (!ASSISTANT_STATES.has(b.state)) throw new Error("unknown assistant state");
    text(b.text, "text", MAX_ASSISTANT_TEXT + 200);
  },
  reduce(state, e) {
    // a turn's newest event replaces its earlier one and lands at the end, where it was said
    const chat = chatOf(state);
    const i = chat.entries.findIndex((x) => x.kind === "assistant" && x.replyTo === e.body.replyTo && x.author === e.author);
    if (i >= 0) chat.entries.splice(i, 1);
    append(chat, { id: e.id, kind: "assistant", author: e.author, lamport: e.lamport, at: e.at, text: e.body.text, replyTo: e.body.replyTo, state: e.body.state });
  },
});

defineEventType("chat.update", {
  validate(b: any) {
    if (!b || typeof b !== "object" || !Array.isArray(b.items) || !b.items.length || b.items.length > MAX_UPDATE_ITEMS) throw new Error(`items must be a list of 1–${MAX_UPDATE_ITEMS}`);
    for (const u of b.items) {
      if (!u || typeof u !== "object") throw new Error("an item isn't an update");
      text(u.session, "session", 64);
      text(u.title, "title", 300);
      if (!UPDATE_KINDS.has(u.kind)) throw new Error("unknown update kind");
      if (u.detail !== undefined) text(u.detail, "detail", 500);
      if (typeof u.at !== "number" || !Number.isFinite(u.at)) throw new Error("bad update time");
    }
  },
  reduce(state, e) {
    append(chatOf(state), { id: e.id, kind: "update", author: e.author, lamport: e.lamport, at: e.at, text: "", items: e.body.items });
  },
});

// ---- the chat on this install ---------------------------------------------------------------------

/** Mentions older than this when they arrive (a long-offline teammate's backlog) don't notify. */
const NOTIFY_MAX_AGE_MS = 6 * 3_600_000;
const NOTIFY_GATHER_MS = 1500;

export interface TeamChatDeps {
  /** Where this install's read marks live. */
  dir?: string;
  /** A room's chat changed (or "*": every room's unread counts may have). */
  emit: (roomId: RoomId) => void;
  /** A teammate mentioned this install. Whether it shows (settings, quiet hours) is the caller's call. */
  notify: (n: { roomId: RoomId; title: string; body: string }) => void;
  windowFocused: () => boolean;
  /** A message by this install asks the assistant: run it (here, under this user's account). */
  askAssistant?: (roomId: RoomId, question: RoomEvent<"chat.message">) => void;
  log: (msg: string) => void;
  now?: () => number;
  /** How long mentions gather into one notification. */
  notifyGatherMs?: number;
}

export class TeamChat {
  private team: Team | null = null;
  private offs: Unsubscribe[] = [];
  private marks: Record<RoomId, ReadMarks>;
  private viewing: RoomId | null = null;
  private emitQueued = new Set<RoomId>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private mentionQueue = new Map<RoomId, RoomEvent<"chat.message">[]>();
  private mentionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string;
  private readonly now: () => number;

  constructor(private d: TeamChatDeps) {
    this.file = path.join(d.dir ?? TEAM_DIR, "chat-read.json");
    const v = readJsonOrSetAside(this.file, {}, "the team chat's read marks");
    this.marks = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<RoomId, ReadMarks>) : {};
    this.now = d.now ?? Date.now;
  }

  /** Start listening to the team's rooms. Turns this install started and never finished are closed with an error. */
  attach(team: Team): void {
    this.detach();
    this.team = team;
    this.offs.push(
      team.onEvent("chat.message", (e, room) => {
        this.changed(room.id);
        if (e.author !== team.self.id && e.body.mentions.includes(team.self.id)) this.queueMention(room, e);
      }),
      team.onEvent("chat.assistant", (_e, room) => this.changed(room.id)),
      team.onEvent("chat.update", (_e, room) => this.changed(room.id)),
      team.onRoomsChanged(() => this.changed("*"))
    );
    for (const room of team.rooms()) {
      for (const e of room.ext.chat?.entries ?? []) {
        if (e.kind !== "assistant" || e.state !== "thinking" || e.author !== team.self.id) continue;
        try {
          team.publish(room.id, "chat.assistant", { replyTo: e.replyTo!, state: "error", text: "Mockingbird closed before the assistant answered — ask again." });
        } catch (err) {
          this.d.log(`couldn't close the unanswered assistant turn in ${room.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
    this.team = null;
  }

  /** A room's chat, as the window shows it. */
  view(roomId: RoomId): RoomChatView {
    const { team, room } = this.need(roomId);
    const entries = room.ext.chat?.entries ?? [];
    const joinedAt = this.joinedAt(room, team.self.id);
    const read = this.marks[roomId] ?? {};
    return { roomId, self: team.self.id, joinedAt, entries, read, ...unreadCounts(entries, team.self.id, read, joinedAt) };
  }

  /** Unread entries and mentions, per room. */
  unread(): ChatUnread {
    const team = this.team;
    if (!team) return {};
    const out: ChatUnread = {};
    for (const room of team.rooms()) out[room.id] = unreadCounts(room.ext.chat?.entries ?? [], team.self.id, this.marks[room.id], this.joinedAt(room, team.self.id));
    return out;
  }

  /** Post a message. A mention of the assistant starts it here. */
  post(roomId: RoomId, raw: string): { id: string } {
    const { team, room } = this.need(roomId);
    const body = raw.trim();
    if (!body) throw new Error("The message is empty");
    if (body.length > MAX_CHAT_TEXT) throw new Error(`The message is ${body.length} characters; the limit is ${MAX_CHAT_TEXT}`);
    const e = team.publish(roomId, "chat.message", { text: body, mentions: parseMentions(body, room.members) });
    this.markRead(roomId);
    if (e.body.mentions.includes(ASSISTANT_MENTION)) {
      if (!this.d.askAssistant) {
        team.publish(roomId, "chat.assistant", { replyTo: e.id, state: "error", text: "The assistant isn't available in this Mockingbird." });
      } else {
        this.d.askAssistant(roomId, e);
      }
    }
    return { id: e.id };
  }

  /** Everything in the room so far counts as read here. Throws when the marks can't be saved. */
  markRead(roomId: RoomId): { unread: number; mentions: number } {
    const { team, room } = this.need(roomId);
    const marks = { ...(this.marks[roomId] ?? {}) };
    let moved = false;
    for (const e of room.ext.chat?.entries ?? []) {
      if ((marks[e.author] ?? 0) < e.lamport) {
        marks[e.author] = e.lamport;
        moved = true;
      }
    }
    if (moved) {
      this.marks = { ...this.marks, [roomId]: marks };
      writeFileAtomic(this.file, JSON.stringify(this.marks));
      this.changed(roomId);
    }
    return unreadCounts(room.ext.chat?.entries ?? [], team.self.id, marks, this.joinedAt(room, team.self.id));
  }

  /** The room the window shows right now (its mentions don't notify while the window has focus). */
  setViewing(roomId: RoomId | null): void {
    this.viewing = roomId;
  }

  private need(roomId: RoomId): { team: Team; room: RoomState } {
    const team = this.team;
    if (!team) throw new Error("Team rooms haven't started");
    const room = team.room(roomId);
    if (!room) throw new Error("You're not in that room");
    return { team, room };
  }

  private joinedAt(room: RoomState, self: MemberId): number {
    return room.members.find((m) => m.id === self)?.joinedAt ?? room.createdAt;
  }

  private changed(roomId: RoomId): void {
    this.emitQueued.add(roomId);
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const ids = [...this.emitQueued];
      this.emitQueued.clear();
      for (const id of ids) {
        try {
          this.d.emit(id);
        } catch (err) {
          this.d.log(`telling the window about room ${id}'s chat failed: ${(err as Error).message}`);
        }
      }
    }, 40);
  }

  private queueMention(room: RoomState, e: RoomEvent<"chat.message">): void {
    if (this.now() - e.at > NOTIFY_MAX_AGE_MS) return;
    const entry = room.ext.chat?.entries.find((x) => x.id === e.id);
    if (entry && isRead(entry, this.marks[room.id], this.joinedAt(room, this.team?.self.id ?? ""))) return;
    if (!entry || !mentionsOf(entry, this.team?.self.id ?? "")) return;
    this.mentionQueue.set(room.id, [...(this.mentionQueue.get(room.id) ?? []), e]);
    if (this.mentionTimer) return;
    this.mentionTimer = setTimeout(() => {
      this.mentionTimer = null;
      const batches = [...this.mentionQueue];
      this.mentionQueue.clear();
      for (const [roomId, events] of batches) this.notifyMentions(roomId, events);
    }, this.d.notifyGatherMs ?? NOTIFY_GATHER_MS);
  }

  private notifyMentions(roomId: RoomId, events: RoomEvent<"chat.message">[]): void {
    if (this.viewing === roomId && this.d.windowFocused()) return;
    const room = this.team?.room(roomId);
    if (!room) return;
    const names = [...new Set(events.map((e) => room.members.find((m) => m.id === e.author)?.name ?? "A teammate"))];
    const last = events[events.length - 1];
    const title = `${names.join(" and ")} mentioned you in ${room.name}`;
    const body = events.length > 1 ? `${events.length} messages · latest: ${excerpt(last.body.text)}` : excerpt(last.body.text);
    try {
      this.d.notify({ roomId, title, body });
    } catch (err) {
      this.d.log(`showing a mention from ${room.name} failed: ${(err as Error).message}`);
    }
  }
}

const excerpt = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 140 ? `${one.slice(0, 139)}…` : one;
};

/** The assistant answer as posted: cut to MAX_ASSISTANT_TEXT, saying so. */
export function clampAnswer(answer: string): string {
  return answer.length > MAX_ASSISTANT_TEXT ? `${answer.slice(0, MAX_ASSISTANT_TEXT)}\n\n[answer cut at ${MAX_ASSISTANT_TEXT} characters]` : answer;
}

