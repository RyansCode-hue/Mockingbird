import { TeamError, type Team, type Unsubscribe } from "./transport";
import type { ArtifactStore } from "./artifactStore";
import { ARTIFACT_CHUNK, ARTIFACT_METHODS, EAGER_ARTIFACT_BYTES, SHA256_RE, type ArtifactLocal, type ArtifactRecord } from "../../shared/team/artifacts";
import type { MemberId, RoomId } from "../../shared/team/types";

/**
 * Room artifacts' bytes between members (docs/team-rooms.md, "Artifacts").
 * Never in the room log: each member fetches a file from a teammate who has
 * it, by hash, a chunk at a time, and keeps it only once its hash checks out.
 *
 * Serving: `artifact.have` says which of the asked hashes this member holds,
 * `artifact.chunk` sends a piece of one. Both are room-scoped (the transport
 * checked the asker is a member of the room it names) and answer only for
 * live file artifacts of that room whose verified blob is here.
 *
 * Fetching: a queue, newest first, with files someone opened (or an agent
 * read) ahead; up to EAGER_ARTIFACT_BYTES of a room's files come without
 * being asked, the rest when opened. One transfer per room and two overall,
 * two chunks in flight each. A file comes from its adder when they're
 * connected, else from any connected member that has it (fewest failures
 * first); a download cut short resumes from what arrived, from whoever has
 * it. A failed round waits 10 s, 30 s, 2 min, then 5 min before the next,
 * and starts over when a member connects.
 */

type FileRecord = Extract<ArtifactRecord, { kind: "file" }>;

export interface FetchTiming {
  /** Waits after each failed round, the last repeating. */
  retryMs: number[];
  /** A member is asked what it has at most this often (connecting, or a file with no source). */
  haveGapMs: number;
  chunkTimeoutMs: number;
  haveTimeoutMs: number;
  /** Bytes asked for per chunk. */
  chunkBytes: number;
}

const DEFAULT_TIMING: FetchTiming = { retryMs: [10_000, 30_000, 120_000, 300_000], haveGapMs: 30_000, chunkTimeoutMs: 60_000, haveTimeoutMs: 15_000, chunkBytes: ARTIFACT_CHUNK };
/** The most a chunk request may ask for. */
export const MAX_CHUNK_REQUEST = 1024 * 1024;
const MAX_HAVE_ASK = 500;
const MAX_OVERALL = 2;
const IN_FLIGHT = 2;

export interface FetchDeps {
  team: Team;
  store: (roomId: RoomId) => ArtifactStore;
  /** A room's live file artifacts. */
  files: (roomId: RoomId) => FileRecord[];
  nameOf: (roomId: RoomId, member: MemberId) => string;
  /** A file arrived, or a download moved on. */
  changed: (roomId: RoomId) => void;
  log: (msg: string) => void;
  now?: () => number;
  eagerBytes?: number;
  timing?: Partial<FetchTiming>;
}

interface Want {
  roomId: RoomId;
  sha: string;
  size: number;
  name: string;
  adders: Set<MemberId>;
  /** Fetched without being asked (within the room's eager budget). */
  eager: boolean;
  /** When someone asked for it (opened it, an agent read it, Download / Retry); 0: nobody. */
  priority: number;
  /** Newest first among the rest. */
  lamport: number;
  state: "queued" | "on-demand" | "downloading" | "waiting" | "failed";
  received: number;
  from: MemberId | null;
  problem: string | null;
  attempts: number;
  nextAt: number;
  cancelled: boolean;
  waiters: Set<() => void>;
}

class Cancelled extends Error {}
/** A member sent something that isn't the file: tried last from then on (`blame`: how strongly). */
class BadPeer extends Error {
  constructor(message: string, readonly blame = 5) {
    super(message);
  }
}

const key = (roomId: RoomId, sha: string) => `${roomId}\n${sha}`;

export class ArtifactFetcher {
  private wants = new Map<string, Want>();
  private active = new Map<string, Promise<void>>();
  /** Per room and member: the hashes they said they have, and when they were asked. */
  private haves = new Map<RoomId, Map<MemberId, { at: number; has: Set<string>; asked: Set<string>; error?: string }>>();
  private asking = new Set<string>();
  private failures = new Map<MemberId, number>();
  private online = new Map<RoomId, Set<MemberId>>();
  private offs: Unsubscribe[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly t: FetchTiming;
  private readonly now: () => number;
  private readonly eagerBytes: number;

  constructor(private d: FetchDeps) {
    this.t = { ...DEFAULT_TIMING, ...(d.timing ?? {}) };
    this.now = d.now ?? Date.now;
    this.eagerBytes = d.eagerBytes ?? EAGER_ARTIFACT_BYTES;
  }

  start(): void {
    const team = this.d.team;
    this.offs.push(
      team.onRequest(ARTIFACT_METHODS.have, (p, ctx) => this.serveHave(p, ctx.roomId)),
      team.onRequest(ARTIFACT_METHODS.chunk, (p, ctx) => this.serveChunk(p, ctx.roomId)),
      team.onPresence((roomId, online) => this.presence(roomId, online))
    );
    for (const room of team.rooms()) {
      this.online.set(room.id, new Set(team.presence(room.id)));
      this.refresh(room.id);
      void this.askHaves(room.id, [...this.online.get(room.id)!], true);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.wants.values()) this.cancel(w);
  }

  // ---- what the window and agents ask ---------------------------------------------------------

  /** Where a file that isn't here yet stands. */
  local(roomId: RoomId, sha: string): ArtifactLocal {
    const w = this.wants.get(key(roomId, sha));
    if (!w) return { state: "queued" };
    switch (w.state) {
      case "downloading":
        return { state: "downloading", received: w.received, from: w.from ? this.d.nameOf(roomId, w.from) : "a teammate" };
      case "waiting":
      case "failed":
        return { state: w.state, problem: w.problem ?? "not fetched yet" };
      default:
        return { state: w.state };
    }
  }

  /** Someone wants the file now (opened it, Download, Retry): it goes first, and a failed one is tried again at once. */
  prioritize(roomId: RoomId, sha: string): void {
    this.refresh(roomId);
    const w = this.wants.get(key(roomId, sha));
    if (!w) return;
    w.priority = this.now();
    if (w.state === "on-demand") w.state = "queued";
    if (w.state === "waiting" || w.state === "failed") {
      w.attempts = 0;
      w.nextAt = 0;
    }
    this.pump();
  }

  /** Fetch now and wait for it, at most `timeoutMs`. Resolves with whether the file is here. */
  async ensure(roomId: RoomId, sha: string, timeoutMs: number): Promise<boolean> {
    const here = () => this.d.store(roomId).blobSize(sha) !== null;
    if (here()) return true;
    this.prioritize(roomId, sha);
    const w = this.wants.get(key(roomId, sha));
    if (!w) return here();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        w.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      w.waiters.add(done);
    });
    return here();
  }

  /** The room's files changed (added, removed): what to fetch follows. */
  refresh(roomId: RoomId): void {
    if (this.stopped) return;
    const store = this.d.store(roomId);
    const records = [...this.d.files(roomId)].sort((a, b) => b.lamport - a.lamport);
    const live = new Map<string, FileRecord[]>();
    for (const r of records) live.set(r.sha256, [...(live.get(r.sha256) ?? []), r]);
    let budget = this.eagerBytes;
    for (const [sha, recs] of live) {
      const newest = recs[0];
      const eager = budget >= newest.size;
      if (eager) budget -= newest.size;
      const k = key(roomId, sha);
      const size = store.blobSize(sha);
      if (size !== null && recs.some((r) => r.size === size)) {
        const w = this.wants.get(k);
        if (w) this.finish(w);
        continue;
      }
      let w = this.wants.get(k);
      if (!w) {
        w = { roomId, sha, size: newest.size, name: newest.name, adders: new Set(), eager, priority: 0, lamport: newest.lamport, state: eager ? "queued" : "on-demand", received: store.partialSize(sha), from: null, problem: null, attempts: 0, nextAt: 0, cancelled: false, waiters: new Set() };
        this.wants.set(k, w);
      }
      w.adders = new Set(recs.map((r) => r.addedBy));
      w.name = newest.name;
      w.eager = eager;
      if (w.state === "on-demand" && eager) w.state = "queued";
      if (w.state === "queued" && !eager && !w.priority) w.state = "on-demand";
    }
    for (const w of [...this.wants.values()]) if (w.roomId === roomId && !live.has(w.sha)) this.finish(w);
    this.pump();
  }

  /**
   * This install isn't in the room any more: its downloads stop. A piece
   * already on its way is waited for a moment; the store is closed first,
   * so nothing written after that lands in a folder being deleted.
   */
  async roomLeft(roomId: RoomId, waitMs = 2_000): Promise<void> {
    for (const w of [...this.wants.values()]) if (w.roomId === roomId) this.finish(w);
    this.haves.delete(roomId);
    this.online.delete(roomId);
    const running = [...this.active].filter(([k]) => k.startsWith(`${roomId}\n`)).map(([, p]) => p);
    if (!running.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(running), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
  }

  // ---- serving ------------------------------------------------------------------------------------

  private liveSizes(roomId: RoomId | undefined): Map<string, Set<number>> {
    if (!roomId) throw new Error("artifact requests are made for a room");
    if (!this.d.team.room(roomId)) throw new Error("not in that room");
    const out = new Map<string, Set<number>>();
    for (const f of this.d.files(roomId)) out.set(f.sha256, (out.get(f.sha256) ?? new Set()).add(f.size));
    return out;
  }

  private serveHave(p: any, roomId: RoomId | undefined): { have: string[] } {
    const live = this.liveSizes(roomId);
    if (!p || !Array.isArray(p.sha256s) || p.sha256s.length > MAX_HAVE_ASK) throw new Error(`sha256s must be a list of up to ${MAX_HAVE_ASK}`);
    const store = this.d.store(roomId!);
    const have = (p.sha256s as unknown[]).filter((s): s is string => typeof s === "string" && SHA256_RE.test(s) && !!live.get(s)?.has(store.blobSize(s) ?? -1));
    return { have: [...new Set(have)] };
  }

  private serveChunk(p: any, roomId: RoomId | undefined): { size: number; offset: number; data: string } {
    const live = this.liveSizes(roomId);
    const sha = p?.sha256;
    if (typeof sha !== "string" || !SHA256_RE.test(sha)) throw new Error("sha256 must be 64 hex characters");
    if (!Number.isSafeInteger(p.offset) || p.offset < 0) throw new Error("offset must be a whole number");
    if (!Number.isSafeInteger(p.length) || p.length < 1 || p.length > MAX_CHUNK_REQUEST) throw new Error(`length must be 1–${MAX_CHUNK_REQUEST}`);
    const sizes = live.get(sha);
    if (!sizes) throw new Error("no such file in this room");
    const store = this.d.store(roomId!);
    const size = store.blobSize(sha);
    if (size === null || !sizes.has(size)) throw new Error("not here");
    if (p.offset > size) throw new Error("offset past the end");
    const data = store.readBlob(sha, p.offset, Math.min(p.length, size - p.offset));
    return { size, offset: p.offset, data: data.toString("base64") };
  }

  // ---- fetching -----------------------------------------------------------------------------------

  private presence(roomId: RoomId, online: MemberId[]): void {
    if (this.stopped) return;
    const before = this.online.get(roomId) ?? new Set();
    const now = new Set(online);
    this.online.set(roomId, now);
    const room = this.haves.get(roomId);
    for (const gone of before) if (!now.has(gone)) room?.delete(gone);
    const arrived = online.filter((m) => !before.has(m));
    if (!arrived.length) return;
    // someone new to ask: every waiting or failed file is worth trying again now
    for (const w of this.wants.values()) {
      if (w.roomId !== roomId || (w.state !== "waiting" && w.state !== "failed")) continue;
      w.attempts = 0;
      w.nextAt = 0;
    }
    for (const m of arrived) this.failures.delete(m);
    void this.askHaves(roomId, arrived, true);
    this.pump();
  }

  /** Ask members which of the room's missing files they have (each at most once per haveGapMs, unless `force`). */
  private async askHaves(roomId: RoomId, peers: MemberId[], force = false): Promise<void> {
    const shas = [...this.wants.values()].filter((w) => w.roomId === roomId).map((w) => w.sha);
    if (!shas.length) return;
    let room = this.haves.get(roomId);
    if (!room) this.haves.set(roomId, (room = new Map()));
    await Promise.all(
      peers.map(async (peer) => {
        const prior = room!.get(peer);
        const k = `${roomId}\n${peer}`;
        if (this.asking.has(k)) return;
        if (!force && prior && this.now() - prior.at < this.t.haveGapMs && shas.every((s) => prior.asked.has(s))) return;
        this.asking.add(k);
        try {
          const asked = shas.slice(0, MAX_HAVE_ASK);
          const r = await this.d.team.request<{ have?: unknown }>(peer, ARTIFACT_METHODS.have, { sha256s: asked }, { roomId, timeoutMs: this.t.haveTimeoutMs });
          const has = new Set(Array.isArray(r?.have) ? (r.have as unknown[]).filter((s): s is string => typeof s === "string" && asked.includes(s)) : []);
          room!.set(peer, { at: this.now(), has, asked: new Set(asked) });
        } catch (err) {
          room!.set(peer, { at: this.now(), has: new Set(), asked: new Set(shas), error: this.problemOf(roomId, peer, err) });
          if (!(err instanceof TeamError && (err.code === "offline" || err.code === "closed"))) this.d.log(`asking ${this.d.nameOf(roomId, peer)} which room files they have failed: ${(err as Error).message}`);
        } finally {
          this.asking.delete(k);
        }
      })
    );
    this.pump();
  }

  /** Who to fetch from: the adder when connected (unless it said it hasn't got it), else members that said they have it; fewest failures first. */
  private sources(w: Want): MemberId[] {
    const said = this.haves.get(w.roomId);
    const online = this.d.team.presence(w.roomId);
    const ok = online.filter((p) => {
      const h = said?.get(p);
      if (h?.has.has(w.sha)) return true;
      return w.adders.has(p) && !(h && h.asked.has(w.sha));
    });
    return ok.sort((a, b) => (this.failures.get(a) ?? 0) - (this.failures.get(b) ?? 0) || Number(w.adders.has(b)) - Number(w.adders.has(a)));
  }

  private order(): Want[] {
    return [...this.wants.values()].sort((a, b) => b.priority - a.priority || b.lamport - a.lamport);
  }

  private pump(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const w of this.order()) {
      if (this.active.size >= MAX_OVERALL) break;
      if (this.active.has(key(w.roomId, w.sha)) || [...this.active.keys()].some((k) => k.startsWith(`${w.roomId}\n`))) continue;
      if (!w.eager && !w.priority) continue;
      if (w.nextAt > now) continue;
      const k = key(w.roomId, w.sha);
      const run = this.run(w).finally(() => {
        this.active.delete(k);
        this.pump();
      });
      this.active.set(k, run);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...[...this.wants.values()].filter((w) => (w.eager || w.priority) && w.nextAt > this.now()).map((w) => w.nextAt));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  private async run(w: Want): Promise<void> {
    const sources = this.sources(w);
    if (!sources.length) {
      const online = this.d.team.presence(w.roomId);
      const said = this.haves.get(w.roomId);
      const here = [...w.adders].filter((a) => online.includes(a));
      const refused = here.map((a) => said?.get(a)?.error).find((e): e is string => !!e);
      const adders = [...w.adders].map((a) => this.d.nameOf(w.roomId, a));
      if (refused) this.setback(w, "failed", refused);
      else if (here.length) this.setback(w, "waiting", `${here.map((a) => this.d.nameOf(w.roomId, a)).join(" and ")} no longer ${here.length > 1 ? "have" : "has"} it, and no other connected teammate has it yet`);
      else this.setback(w, "waiting", `${adders.length ? adders.join(" and ") : "A teammate"} added it and ${adders.length > 1 ? "are" : "is"} offline; no connected teammate has it yet`);
      void this.askHaves(w.roomId, online);
      return;
    }
    let problem = "";
    for (const peer of sources) {
      if (w.cancelled) return;
      try {
        await this.download(w, peer);
        this.finish(w);
        this.d.changed(w.roomId);
        return;
      } catch (err) {
        if (err instanceof Cancelled || w.cancelled) return;
        problem = this.problemOf(w.roomId, peer, err);
        this.d.log(`room file ${w.name} (${w.sha.slice(0, 12)}) from ${this.d.nameOf(w.roomId, peer)}: ${problem}`);
        this.failures.set(peer, (this.failures.get(peer) ?? 0) + (err instanceof BadPeer ? err.blame : 1));
        if (err instanceof TeamError && err.code === "remote") this.haves.get(w.roomId)?.get(peer)?.has.delete(w.sha);
      }
    }
    this.setback(w, "failed", problem);
  }

  private setback(w: Want, state: "waiting" | "failed", problem: string): void {
    w.state = state;
    w.problem = problem;
    w.from = null;
    w.attempts++;
    w.nextAt = this.now() + this.t.retryMs[Math.min(w.attempts - 1, this.t.retryMs.length - 1)];
    this.d.changed(w.roomId);
  }

  private problemOf(roomId: RoomId, peer: MemberId, err: unknown): string {
    const name = this.d.nameOf(roomId, peer);
    if (err instanceof BadPeer) return err.message;
    if (err instanceof TeamError) {
      switch (err.code) {
        case "no-handler":
          return `${name}'s Mockingbird needs an update to share files`;
        case "offline":
        case "disconnected":
        case "closed":
          return `${name} went offline`;
        case "timeout":
          return `${name} didn't answer in time`;
        case "forbidden":
          return `${name}'s Mockingbird refused: it doesn't count this Mac in the room`;
        default:
          return `${name}'s Mockingbird couldn't send it: ${err.message}`;
      }
    }
    return `couldn't be fetched from ${name}: ${(err as Error).message}`;
  }

  private async download(w: Want, peer: MemberId): Promise<void> {
    const store = this.d.store(w.roomId);
    let offset = store.partialSize(w.sha);
    if (offset > w.size) {
      store.dropPartial(w.sha);
      offset = 0;
    }
    w.state = "downloading";
    w.from = peer;
    w.received = offset;
    this.d.changed(w.roomId);
    this.d.log(`fetching room file ${w.name} (${w.sha.slice(0, 12)}, ${w.size} bytes) from ${this.d.nameOf(w.roomId, peer)}${offset ? `, resuming at ${offset} bytes` : ""}`);
    if (w.size === 0) store.appendPartial(w.sha, Buffer.alloc(0));
    const resumed = offset > 0;
    let next = offset;
    const inFlight: { at: number; length: number; data: Promise<Buffer> }[] = [];
    try {
      while (offset < w.size) {
        while (inFlight.length < IN_FLIGHT && next < w.size) {
          const length = Math.min(this.t.chunkBytes, w.size - next);
          const data = this.chunk(w, peer, next, length);
          data.catch(() => {}); // awaited in order below; one that fails after an earlier one did is moot
          inFlight.push({ at: next, length, data });
          next += length;
        }
        const c = inFlight.shift()!;
        const data = await c.data;
        if (w.cancelled || this.stopped) throw new Cancelled();
        store.appendPartial(w.sha, data);
        offset += data.length;
        w.received = offset;
        this.d.changed(w.roomId);
        if (data.length < c.length) {
          // a short piece: what was asked after it starts at the wrong place
          inFlight.length = 0;
          next = offset;
        }
      }
    } catch (err) {
      // what this member sent so far is suspect too
      if (err instanceof BadPeer) store.dropPartial(w.sha);
      throw err;
    } finally {
      inFlight.length = 0;
    }
    if (w.cancelled || this.stopped) throw new Cancelled();
    if (await store.completePartial(w.sha, w.name)) return;
    const name = this.d.nameOf(w.roomId, peer);
    // a download resumed from an earlier one may hold another member's bytes: this one isn't blamed as hard
    throw resumed
      ? new BadPeer(`the file put together from what ${name} sent and an earlier partial download doesn't match its hash; it was thrown away`, 1)
      : new BadPeer(`what ${name} sent doesn't match the file's hash; it was thrown away`);
  }

  private async chunk(w: Want, peer: MemberId, offset: number, length: number): Promise<Buffer> {
    const r = await this.d.team.request<{ size?: unknown; offset?: unknown; data?: unknown }>(peer, ARTIFACT_METHODS.chunk, { sha256: w.sha, offset, length }, { roomId: w.roomId, timeoutMs: this.t.chunkTimeoutMs });
    const name = this.d.nameOf(w.roomId, peer);
    if (!r || r.size !== w.size) throw new BadPeer(`${name}'s copy is ${typeof r?.size === "number" ? `${r.size} bytes` : "of no size"}, not the ${w.size} the room says`);
    if (r.offset !== offset || typeof r.data !== "string") throw new BadPeer(`${name} sent a piece that wasn't asked for`);
    const data = Buffer.from(r.data, "base64");
    if (data.length < 1 || data.length > length || offset + data.length > w.size) throw new BadPeer(`${name} sent a piece of the wrong length`);
    return data;
  }

  private cancel(w: Want): void {
    w.cancelled = true;
    for (const done of [...w.waiters]) done();
  }

  /** Here, removed or no longer wanted: off the queue, and anyone waiting is told. */
  private finish(w: Want): void {
    this.wants.delete(key(w.roomId, w.sha));
    this.cancel(w);
  }
}
