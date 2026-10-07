import type { MemberId, RoomId } from "./types";

/**
 * The team room's chat (docs/team-rooms.md → Team room): what members say,
 * what the @assistant answers, and compact updates from the room's agents.
 * All of it is room events, so it's durable, replicated and ordered by the
 * room log; main reduces it (src/main/team/chat.ts) and the window shows it
 * (src/renderer/team/RoomChat.tsx).
 */

/** The mention that asks the assistant: it runs on the laptop of the member who wrote it. */
export const ASSISTANT_MENTION = "assistant";

/** The longest message a member can post. */
export const MAX_CHAT_TEXT = 8000;
/** The longest assistant answer kept (longer ones are cut, and say so). */
export const MAX_ASSISTANT_TEXT = 20_000;
/** Entries a room keeps in its reduced state (older ones stay in the log). */
export const MAX_CHAT_ENTRIES = 500;
/** Items one agent update carries; a burst beyond that is summarized. */
export const MAX_UPDATE_ITEMS = 20;

/** What an agent did, as a room's update shows it. */
export type AgentUpdateKind = "started" | "finished" | "waiting" | "ended" | "takeover" | "board";

export interface AgentUpdate {
  /** The session's id on its owner's install (empty for a board change). */
  session: string;
  /** The session's title, or the board item's. */
  title: string;
  kind: AgentUpdateKind;
  /** Why it's waiting, who took it over, what changed on the board… */
  detail?: string;
  /** Owner's wall clock, ms. */
  at: number;
}

export type AssistantState = "thinking" | "answer" | "error";

export interface ChatEventBodies {
  /** A member's message. `mentions` holds member ids and/or "assistant", resolved by the poster. */
  "chat.message": { text: string; mentions: string[] };
  /** The assistant's turn for the message `replyTo`, run on (and signed by) the asker's install. */
  "chat.assistant": { replyTo: string; state: AssistantState; text: string };
  /** A group of agent updates from the author's own room sessions (or its board changes). */
  "chat.update": { items: AgentUpdate[] };
}

declare module "./types" {
  interface RoomEventBodies extends ChatEventBodies {}
  interface RoomExtensions {
    chat: ChatState;
  }
}

/** One line of the chat, in room-log order. */
export interface ChatEntry {
  /** The event this entry is (for the assistant: its latest event). */
  id: string;
  kind: "message" | "assistant" | "update";
  author: MemberId;
  lamport: number;
  /** Author's wall clock, ms: display only. */
  at: number;
  text: string;
  mentions?: string[];
  /** Assistant entries: the message asked, and how far the answer got. */
  replyTo?: string;
  state?: AssistantState;
  items?: AgentUpdate[];
}

export interface ChatState {
  entries: ChatEntry[];
}

/** Per author, the newest Lamport time this install has read. An author's events only ever count up. */
export type ReadMarks = Record<MemberId, number>;

/** A room's chat as the window shows it. */
export interface RoomChatView {
  roomId: RoomId;
  self: MemberId;
  /** When this install joined the room: entries older than that start out read. */
  joinedAt: number;
  entries: ChatEntry[];
  read: ReadMarks;
  unread: number;
  mentions: number;
}

export type ChatUnread = Record<RoomId, { unread: number; mentions: number }>;

/** Has this install read the entry: at or before its author's read mark (with no mark yet, from before this install joined)? */
export function isRead(e: ChatEntry, read: ReadMarks | undefined, joinedAt: number): boolean {
  const mark = read?.[e.author];
  return mark === undefined ? e.at < joinedAt : e.lamport <= mark;
}

/** Does the entry count toward a room's unread badge: what others said, and finished assistant turns. */
export function countsAsUnread(e: ChatEntry, self: MemberId): boolean {
  if (e.kind === "message") return e.author !== self;
  if (e.kind === "assistant") return e.state !== "thinking";
  return false;
}

export function mentionsOf(e: ChatEntry, self: MemberId): boolean {
  return e.kind === "message" && e.author !== self && !!e.mentions?.includes(self);
}

/** Unread entries and, among them, mentions of this install. */
export function unreadCounts(entries: readonly ChatEntry[], self: MemberId, read: ReadMarks | undefined, joinedAt: number): { unread: number; mentions: number } {
  let unread = 0;
  let mentions = 0;
  for (const e of entries) {
    if (isRead(e, read, joinedAt) || !countsAsUnread(e, self)) continue;
    unread++;
    if (mentionsOf(e, self)) mentions++;
  }
  return { unread, mentions };
}

// ---- mentions --------------------------------------------------------------------------------

/** `@handle` tokens: after a start or a non-word character, so an email address isn't one. */
const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9][\w.-]*)/g;

const handleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** What the composer inserts for a member: the first word of their name ("Nick Smith" → "Nick"). */
export function mentionHandle(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^\w.-]/g, "") || "teammate";
}

/** Text without code: mentions in code aren't mentions. */
const withoutCode = (text: string) => text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");

/**
 * The member ids (and "assistant") a message mentions. `@Nick` matches a
 * member whose first name is Nick, `@NickSmith` the whole name; a first name
 * two members share mentions both.
 */
export function parseMentions(text: string, members: readonly { id: MemberId; name: string }[]): string[] {
  const out = new Set<string>();
  for (const m of withoutCode(text).matchAll(MENTION_RE)) {
    const key = handleKey(m[2]);
    if (!key) continue;
    if (key === ASSISTANT_MENTION) {
      out.add(ASSISTANT_MENTION);
      continue;
    }
    for (const member of members) {
      if (handleKey(member.name) === key || handleKey(mentionHandle(member.name)) === key) out.add(member.id);
    }
  }
  return [...out];
}

/** Does `@handle` name the assistant or one of the members (for highlighting)? */
export function knownHandle(handle: string, members: readonly { name: string }[]): boolean {
  const key = handleKey(handle);
  return key === ASSISTANT_MENTION || members.some((m) => handleKey(m.name) === key || handleKey(mentionHandle(m.name)) === key);
}

// ---- agent updates as text -------------------------------------------------------------------

const KIND_TEXT: Record<AgentUpdateKind, string> = {
  started: "started a turn",
  finished: "finished a turn",
  waiting: "is waiting on input",
  ended: "ended",
  takeover: "was taken over",
  board: "board",
};

/** One update as a line: "API tests — waiting on input: permission Bash". */
export function updateLine(u: AgentUpdate): string {
  if (u.kind === "board") return u.detail ? `${u.detail}${u.title ? ` ${u.title}` : ""}` : `board: ${u.title}`;
  const what = KIND_TEXT[u.kind];
  return `${u.title} — ${what}${u.detail ? `: ${u.detail}` : ""}`;
}
