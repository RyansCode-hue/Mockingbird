import { MAX_UPDATE_ITEMS, type AgentUpdate } from "../../shared/team/chat";
import type { SessionInfo, SessionStatus } from "../../shared/types";
import type { MemberId, RoomEvent, RoomId, RoomState } from "../../shared/team/types";
import { isTicketNumber, type NudgeChange } from "../../shared/team/house";
import "../../shared/team/takeover"; // the take-over state the feed reads (type only)

/**
 * What a room's agents are doing, posted to its chat as compact
 * `chat.update` events (docs/team-rooms.md → Team room):
 *
 *   - a room session on this install started or finished a turn, is waiting
 *     on input (with the reason), or ended;
 *   - a room session was taken over (TAKEOVER_EVENT), or a member wrote to
 *     a House ticket (its house.nudge: "Ryan claimed #143", never the
 *     House's title or text): posted by the install that published that
 *     event, so the room hears it once.
 *
 * Updates gather per room for GROUP_MS, keeping each session's latest state,
 * and a room gets at most one update post per MIN_GAP_MS.
 */

/** The take-over event's type (stage 3 publishes it). Expected body: { sessionId, title?, from? (previous owner's member id) }. */
export const TAKEOVER_EVENT = "session.takenOver";
/** How a House write reads in the room: "Ryan claimed #143". */
const NUDGE_VERB: Record<NudgeChange, string> = {
  created: "created",
  claimed: "claimed",
  released: "released",
  progress: "posted progress on",
  status: "changed the status of",
  question: "asked a person a question on",
  note: "commented on",
};

const GROUP_MS = 10_000;
const MIN_GAP_MS = 30_000;

export interface Scheduled {
  cancel(): void;
}

export interface AgentUpdateFeedDeps {
  /** The room a local session is in, or null. */
  roomOf: (s: SessionInfo) => RoomId | null;
  /** Post a group of updates to a room's chat. */
  publish: (roomId: RoomId, items: AgentUpdate[]) => void;
  log: (msg: string) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Scheduled;
  groupMs?: number;
  minGapMs?: number;
}

interface Seen {
  status: SessionStatus;
  reason: string | null;
  roomId: RoomId | null;
}

export class AgentUpdateFeed {
  private seen = new Map<string, Seen>();
  private pending = new Map<RoomId, Map<string, AgentUpdate>>();
  private timers = new Map<RoomId, Scheduled>();
  private lastPost = new Map<RoomId, number>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => Scheduled;
  private readonly groupMs: number;
  private readonly minGapMs: number;

  constructor(private d: AgentUpdateFeedDeps) {
    this.now = d.now ?? Date.now;
    this.schedule =
      d.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      });
    this.groupMs = d.groupMs ?? GROUP_MS;
    this.minGapMs = d.minGapMs ?? MIN_GAP_MS;
  }

  /** The session list changed: note what each room session did since it was last seen. */
  sessionsChanged(list: readonly SessionInfo[]): void {
    const present = new Set<string>();
    for (const s of list) {
      if (s.shell || s.debrief) continue;
      present.add(s.id);
      const roomId = this.d.roomOf(s);
      const prev = this.seen.get(s.id);
      this.seen.set(s.id, { status: s.status, reason: s.waitingReason, roomId });
      // first sight, or just moved into a room: its next change is news, this isn't
      if (!roomId || !prev || prev.roomId !== roomId) continue;
      const change = transition(prev, s);
      if (change) this.add(roomId, `s:${s.id}`, { session: s.id, title: s.ticketTitle ?? s.title, ...change, at: this.now() });
    }
    for (const id of [...this.seen.keys()]) if (!present.has(id)) this.seen.delete(id);
  }

  /** A room event: a take-over or board change this install published becomes an update. */
  roomEvent(e: RoomEvent, room: RoomState, self: MemberId): void {
    if (e.author !== self) return;
    const name = (id: unknown) => room.members.find((m) => m.id === id)?.name;
    const body = (e.body ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof body[k] === "string" && (body[k] as string).trim()) return (body[k] as string).trim().slice(0, 200);
      return "";
    };
    if (e.type === TAKEOVER_EVENT) {
      const from = name(body.from);
      const sessionId = pick("sessionId");
      this.add(room.id, `e:${e.id}`, {
        session: sessionId,
        title: room.ext.takeover?.sessions[sessionId]?.session.title || "a session",
        kind: "takeover",
        detail: `${name(e.author) ?? "a teammate"} took it over${from ? ` from ${from}` : ""}`,
        at: this.now(),
      });
    } else if (e.type === "house.nudge" && isTicketNumber(body.n) && typeof body.change === "string" && body.change in NUDGE_VERB) {
      const via = pick("via");
      this.add(room.id, `e:${e.id}`, {
        session: "",
        title: "",
        kind: "board",
        detail: `${name(e.author) ?? "a teammate"}${via ? ` (agent: ${via})` : ""} ${NUDGE_VERB[body.change as NudgeChange]} #${body.n}`,
        at: this.now(),
      });
    }
  }

  /** Post everything gathered now (on quit). */
  flushAll(): void {
    for (const roomId of [...this.pending.keys()]) this.flush(roomId);
  }

  private add(roomId: RoomId, key: string, u: AgentUpdate): void {
    let items = this.pending.get(roomId);
    if (!items) this.pending.set(roomId, (items = new Map()));
    items.delete(key); // re-added at the end: the order is when each last changed
    items.set(key, u);
    if (this.timers.has(roomId)) return;
    const wait = Math.max(this.groupMs, (this.lastPost.get(roomId) ?? -Infinity) + this.minGapMs - this.now());
    this.timers.set(
      roomId,
      this.schedule(() => this.flush(roomId), wait)
    );
  }

  private flush(roomId: RoomId): void {
    this.timers.get(roomId)?.cancel();
    this.timers.delete(roomId);
    const items = [...(this.pending.get(roomId)?.values() ?? [])];
    this.pending.delete(roomId);
    if (!items.length) return;
    const kept = items.slice(-MAX_UPDATE_ITEMS);
    if (kept.length < items.length) this.d.log(`room ${roomId}: ${items.length - kept.length} older agent updates in one burst weren't posted (at most ${MAX_UPDATE_ITEMS} at a time)`);
    this.lastPost.set(roomId, this.now());
    try {
      this.d.publish(roomId, kept);
    } catch (err) {
      this.d.log(`posting ${kept.length} agent updates to room ${roomId} failed: ${(err as Error).message}`);
    }
  }
}

/** What a session's status change says, if it's worth posting. */
function transition(prev: Seen, s: SessionInfo): Pick<AgentUpdate, "kind" | "detail"> | null {
  if (s.status === "dead") return prev.status === "dead" ? null : { kind: "ended", ...(s.exitCode ? { detail: `exit code ${s.exitCode}` } : {}) };
  if (s.status === "waiting") {
    const reason = s.waitingReason ?? null;
    if (prev.status === "waiting" && (!reason || reason === prev.reason)) return null;
    return { kind: "waiting", ...(reason ? { detail: reason.slice(0, 300) } : {}) };
  }
  if (s.status === "working" && prev.status === "idle") return { kind: "started" };
  if (s.status === "idle" && prev.status === "working") return { kind: "finished" };
  return null;
}

