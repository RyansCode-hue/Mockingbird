import * as crypto from "crypto";
import type { LogSummary } from "./rooms";
import type { MemberId, RoomEvent, RoomId } from "../../shared/team/types";

/**
 * What two connected Mockingbirds say to each other over the reliable
 * channel (one JSON frame per message), and the lossy stream channel's
 * framing. Transport-independent: the WebRTC wire and the in-process
 * loopback carry the same strings.
 */

export type TeamFrame =
  /** First frame after connecting (and again when the rooms shared with this peer change). */
  | { k: "hello"; team: number; name: string; rooms: RoomId[] }
  /** Room events: published live, or sent because the other side lacked them. */
  | { k: "ev"; roomId: RoomId; events: RoomEvent[] }
  /** Anti-entropy: this side's per-author summary of a room's log. */
  | { k: "sync"; roomId: RoomId; summary: LogSummary }
  /** Anti-entropy: the event ids this side has by one author; the other side sends what's missing. */
  | { k: "have"; roomId: RoomId; author: MemberId; ids: string[] }
  | { k: "req"; id: number; method: string; params: unknown; roomId?: RoomId }
  | { k: "res"; id: number; ok: true; result: unknown }
  | { k: "res"; id: number; ok: false; error: string; code: string }
  /** One piece of a frame too big for a single message, in order. */
  | { k: "part"; id: string; i: number; n: number; s: string };

/**
 * The largest single message, in characters. A frame is already JSON (control
 * characters escaped), so a part's piece at most doubles (quotes, backslashes)
 * or triples in UTF-8: under the 256 KB a WebRTC message may be.
 */
export const MAX_MESSAGE = 48 * 1024;
/** The largest whole frame accepted after reassembly. */
export const MAX_FRAME = 64 * 1024 * 1024;

/** A frame as the messages to send: itself, or its parts when it's too big for one. */
export function encodeFrame(f: TeamFrame): string[] {
  const text = JSON.stringify(f);
  if (text.length <= MAX_MESSAGE) return [text];
  if (text.length > MAX_FRAME) throw new Error(`a ${f.k} frame of ${text.length} characters is over the ${MAX_FRAME} limit`);
  const pieces = splitText(text, MAX_MESSAGE - 200);
  const id = crypto.randomBytes(8).toString("hex");
  return pieces.map((s, i) => JSON.stringify({ k: "part", id, i, n: pieces.length, s } satisfies TeamFrame));
}

/** Text cut into pieces of at most `size` UTF-16 units, never between a surrogate pair. */
export function splitText(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** Puts parted frames back together, per peer. Throws on a malformed message. */
export class Reassembler {
  private partial = new Map<string, { n: number; parts: string[]; size: number; at: number }>();

  push(peer: MemberId, text: string, now = Date.now()): TeamFrame | null {
    const f = JSON.parse(text) as TeamFrame;
    if (!f || typeof f !== "object" || typeof (f as { k?: unknown }).k !== "string") throw new Error("not a frame");
    if (f.k !== "part") return f;
    if (typeof f.id !== "string" || !Number.isInteger(f.i) || !Number.isInteger(f.n) || f.n < 1 || f.i < 0 || f.i >= f.n || typeof f.s !== "string") throw new Error("malformed part");
    const key = `${peer}\n${f.id}`;
    for (const [k, p] of this.partial) if (now - p.at > 120_000) this.partial.delete(k);
    let p = this.partial.get(key);
    if (!p) {
      if ([...this.partial.keys()].filter((k) => k.startsWith(`${peer}\n`)).length >= 16) throw new Error("too many unfinished frames");
      p = { n: f.n, parts: [], size: 0, at: now };
      this.partial.set(key, p);
    }
    if (f.i !== p.parts.length || f.n !== p.n) {
      this.partial.delete(key);
      throw new Error("frame parts out of order");
    }
    p.parts.push(f.s);
    p.size += f.s.length;
    if (p.size > MAX_FRAME) {
      this.partial.delete(key);
      throw new Error("frame too big");
    }
    if (p.parts.length < p.n) return null;
    this.partial.delete(key);
    return this.push(peer, p.parts.join(""), now);
  }

  /** Forget a peer's unfinished frames (it disconnected). */
  drop(peer: MemberId): void {
    for (const k of [...this.partial.keys()]) if (k.startsWith(`${peer}\n`)) this.partial.delete(k);
  }
}

/** One message on the stream channel: room, channel, sequence number, data. */
export interface StreamFrame {
  r: RoomId;
  c: string;
  q: number;
  d: string;
}

/**
 * The largest stream chunk in one message; longer writes are split (each
 * piece its own sequence number). Terminal output is full of control
 * characters, which JSON writes as six (\u001b), so 16K characters stay well
 * under the 256 KB a WebRTC message may be.
 */
export const MAX_STREAM_CHUNK = 16 * 1024;
