import * as fs from "fs";
import * as path from "path";
import type { MemberId } from "../../shared/team/types";

/**
 * What each member may add to everyone's disk, enforced by the Mac that
 * receives it — never trusted from the sender (docs/team-rooms.md, "Limits
 * on what a member adds"). Every limit is per author: an event relayed by
 * another member still counts against the member who signed it.
 *
 * The numbers are set well above what normal use makes. Measured over the
 * test suite's rooms (3,600 events): events are 260–960 bytes (a session's
 * record ~650, a backup ~650–960); the most one member added to one room in
 * a minute was 504 (a 500-artifact drop). The largest event a validator
 * allows is a 60,000-character note, ~120 KB with JSON escaping. A Mac
 * publishes a session's record at most once a second, so ten live sessions
 * peak near 600 a minute.
 */
export interface RoomLimits {
  /** The largest event (its signed text), from anyone. */
  maxEventBytes: number;
  /** Events a member's Mac may add to a room per minute, sustained… */
  eventsPerMinute: number;
  /** …and in one burst (a dropped folder of artifacts, a Mac starting with many sessions). */
  eventBurst: number;
  /** A member's share of a room's log on disk. Membership events (joins, leaves, removals) are always taken. */
  maxMemberLogBytes: number;
  /**
   * An author's events reach a Mac in the order they were written (ordered
   * channels, sorted catch-up), except around a reconnect, when a new event
   * can overtake the backlog by a round trip. So an event that sorts at or
   * below what its author sent this long ago is backdated, and refused.
   */
  backdateGraceMs: number;
  /** One teammate's conversation copied here for take-over… */
  maxTranscriptBytes: number;
  /** …and all of one member's conversations in one room. */
  maxMemberTranscriptBytes: number;
}

export const ROOM_LIMITS: RoomLimits = {
  maxEventBytes: 256 * 1024,
  eventsPerMinute: 600,
  eventBurst: 1_000,
  maxMemberLogBytes: 256 * 1024 * 1024,
  backdateGraceMs: 5 * 60_000,
  maxTranscriptBytes: 512 * 1024 * 1024,
  maxMemberTranscriptBytes: 2 * 1024 * 1024 * 1024,
};

/** Which limit refused something: shown once per member and kind in the room. */
export type LimitKind = "size" | "rate" | "share" | "order" | "transcript" | "snapshot";

/**
 * How long a backlog a member's Mac claims to hold (in its sync) may arrive
 * without counting against the per-minute limit: a joiner copying the room,
 * or a member back from a week away. A claim can't exceed what the member's
 * share of the log allows, so this bounds nothing the share doesn't.
 */
export const CATCH_UP_MS = 10 * 60_000;

/** A token bucket: `burst` at once, refilled at `perMinute`. */
export class RateBucket {
  private tokens: number;
  private at: number;

  constructor(
    private perMinute: number,
    private burst: number,
    now: number
  ) {
    this.tokens = burst;
    this.at = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.perMinute) / 60_000);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** How long until `n` more events (at most a burst) would be taken. */
  waitMs(now: number, n = 1): number {
    const want = Math.min(n, this.burst);
    const tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.perMinute) / 60_000);
    return tokens >= want ? 0 : Math.ceil(((want - tokens) * 60_000) / this.perMinute);
  }
}

/** Plain-words sizes for limits: "256 MB", "120 KB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${+(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/**
 * Why `member` may not add `adding` bytes to the conversation copy at
 * `target` (in `transcriptsDir/<session>/`), or null. Each copy's meta.json
 * says whose it is: the member's other copies in the room count too.
 */
export function transcriptRefusal(transcriptsDir: string, target: string, member: MemberId, have: number, adding: number, limits: RoomLimits = ROOM_LIMITS): string | null {
  if (have + adding > limits.maxTranscriptBytes) return `a conversation copy over ${sizeText(limits.maxTranscriptBytes)}`;
  let total = have + adding;
  let names: string[] = [];
  try {
    names = fs.readdirSync(transcriptsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of names) {
    const dir = path.join(transcriptsDir, name);
    let meta: { file?: unknown; from?: unknown };
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`the conversation copy in ${dir} couldn't be read: ${(err as Error).message}`);
    }
    if (meta.from !== member || typeof meta.file !== "string") continue;
    const file = path.join(dir, meta.file);
    if (file === target) continue;
    try {
      total += fs.statSync(file).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return total > limits.maxMemberTranscriptBytes ? `more than ${sizeText(limits.maxMemberTranscriptBytes)} of conversation copies in this room` : null;
}
