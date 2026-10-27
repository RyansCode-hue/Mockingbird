import * as fs from "fs";
import * as path from "path";
import { readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import type { MemberId, RoomId } from "../../shared/team/types";

/**
 * When this Mac was connected to each teammate in a room, in its own clock
 * (<room>/connected.json): what an offline take-over of one of its sessions
 * is checked against (takeover.ts, offlineTakeoverRefusal). A span opens when
 * a teammate's connection comes up and closes when it drops; one still open
 * when the app stopped without closing it (a crash, a power cut) ends at the
 * last heartbeat, at most CONNECTED_BEAT_MS before. Spans that ended more than
 * CONNECTED_KEEP_MS ago are let go.
 */

/** How long ended spans are kept: older take-overs are checked against nothing, so they count. */
export const CONNECTED_KEEP_MS = 30 * 86_400_000;
/** How often an open span's end is written down while the connection lasts. */
export const CONNECTED_BEAT_MS = 60_000;

/** From, and to (null: still connected). */
export type Span = [number, number | null];
interface RoomFile {
  v: 1;
  /** The last time this Mac wrote down its open spans: where they end when it stopped without closing them. */
  seen: number;
  members: Record<MemberId, Span[]>;
}

export class ConnectionLog {
  private rooms = new Map<RoomId, RoomFile>();

  constructor(private o: { dir: string; now: () => number; log: (context: string, err: unknown) => string }) {}

  /** Who's connected in `roomId` now: spans open for newcomers and close for those gone. */
  update(roomId: RoomId, online: readonly MemberId[]): void {
    const f = this.room(roomId);
    const now = this.o.now();
    let changed = false;
    for (const [member, spans] of Object.entries(f.members)) {
      const last = spans.at(-1);
      if (last && last[1] === null && !online.includes(member)) {
        last[1] = Math.max(last[0], now);
        changed = true;
      }
    }
    for (const member of online) {
      const spans = (f.members[member] ??= []);
      const last = spans.at(-1);
      if (!last || last[1] !== null) {
        spans.push([now, null]);
        changed = true;
      }
    }
    if (changed || this.open(f)) this.save(roomId, f, now);
  }

  /** While connections last, note that they still do (the end an unclosed span gets). */
  beat(): void {
    const now = this.o.now();
    for (const [roomId, f] of this.rooms) if (this.open(f)) this.save(roomId, f, now);
  }

  /** The app is stopping: every open span ends now. */
  close(): void {
    for (const roomId of [...this.rooms.keys()]) this.update(roomId, []);
  }

  /** This Mac's spans of connection to `member` in `roomId`, oldest first. */
  spans(roomId: RoomId, member: MemberId): readonly Span[] {
    return this.room(roomId).members[member] ?? [];
  }

  private open(f: RoomFile): boolean {
    return Object.values(f.members).some((spans) => spans.at(-1)?.[1] === null);
  }

  private file(roomId: RoomId): string {
    return path.join(this.o.dir, roomId, "connected.json");
  }

  private room(roomId: RoomId): RoomFile {
    let f = this.rooms.get(roomId);
    if (f) return f;
    const v = readJsonOrSetAside(this.file(roomId), null, `room ${roomId}'s record of connections`) as RoomFile | null;
    f = { v: 1, seen: 0, members: {} };
    if (v && v.v === 1 && v.members && typeof v.members === "object") {
      const seen = Number.isFinite(v.seen) ? v.seen : 0;
      for (const [member, spans] of Object.entries(v.members)) {
        if (!Array.isArray(spans)) continue;
        const ok = spans.filter((s): s is Span => Array.isArray(s) && Number.isFinite(s[0]) && (s[1] === null || Number.isFinite(s[1])));
        // a span left open by a run that didn't close it ends where that run last wrote it down
        f.members[member] = ok.map(([from, to]) => [from, to ?? Math.max(from, seen)]);
      }
    }
    this.rooms.set(roomId, f);
    return f;
  }

  private save(roomId: RoomId, f: RoomFile, now: number): void {
    f.seen = now;
    for (const [member, spans] of Object.entries(f.members)) {
      const kept = spans.filter(([, to]) => to === null || now - to < CONNECTED_KEEP_MS);
      if (kept.length) f.members[member] = kept;
      else delete f.members[member];
    }
    try {
      fs.mkdirSync(path.dirname(this.file(roomId)), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file(roomId), JSON.stringify(f), 0o600);
    } catch (err) {
      // kept in memory either way: what's lost is only the record across a restart
      this.o.log(`team: writing down room ${roomId}'s connections`, err);
    }
  }
}

/**
 * Whether `at` (a take-over's time) falls while this Mac was connected to the
 * taker: inside a span by more than `skew` from where it started, and — for
 * one that ended — from where it ended. A span still open reaches to any later
 * time.
 */
export function connectedThen(spans: readonly Span[], at: number, skew: number): boolean {
  return spans.some(([from, to]) => at >= from + skew && (to === null || at <= to - skew));
}
