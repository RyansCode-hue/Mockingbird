import * as path from "path";
import { loadIdentity, type Identity } from "./identity";
import { RoomStore } from "./rooms";
import { TeamCore, type IntroType, type PeerWire, type TeamOptions, type WireHandler, type WireRoom } from "./transport";
import type { MemberId, PeerLinkState, RoomId } from "../../shared/team/types";

/**
 * Team members in one process, connected in memory: for tests of everything
 * built on the transport. Two members are linked when both are online, not
 * partitioned, and each lists the other in one of its rooms — what signaling
 * and WebRTC would do. Delivery is asynchronous and in order, like a data
 * channel's.
 *
 *   const { members: [ryan, nick], roomId } = await loopbackRoom(["Ryan", "Nick"], { dir });
 *   ryan.team.publish(roomId, "member.renamed", { name: "R" });
 *   net.setOnline(nick.id, false)   // Nick's laptop sleeps
 */

const pair = (a: MemberId, b: MemberId) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class LoopbackNetwork {
  private wires = new Map<MemberId, LoopbackWire>();
  private offline = new Set<MemberId>();
  private cut = new Set<string>();
  private full = new Set<string>();
  private links = new Set<string>();
  private reachableSent = new Map<string, string>();

  /** The wire for a member: one at a time (a closed one is replaced, as by an app restart). */
  wire(self: MemberId): LoopbackWire {
    if (this.wires.has(self) && !this.wires.get(self)!.closed) throw new Error(`${self} is already on this network`);
    const w = new LoopbackWire(self, this);
    this.wires.set(self, w);
    return w;
  }

  /** Take a member off the network (a laptop asleep), or bring it back. */
  setOnline(id: MemberId, online: boolean): void {
    if (online) this.offline.delete(id);
    else this.offline.add(id);
    this.reconcile();
  }

  /** Stop (or allow again) the connection between two members, as a firewall would. */
  partition(a: MemberId, b: MemberId, apart = true): void {
    if (apart) this.cut.add(pair(a, b));
    else this.cut.delete(pair(a, b));
    this.reconcile();
  }

  /** Make the stream pipe from one member to another full (writes are dropped), or empty it again. */
  congest(from: MemberId, to: MemberId, full: boolean): void {
    const k = `${from}>${to}`;
    if (full) this.full.add(k);
    else if (this.full.delete(k)) this.later(() => this.wires.get(from)?.handler?.drain(to));
  }

  isLinked(a: MemberId, b: MemberId): boolean {
    return this.links.has(pair(a, b));
  }

  isFull(from: MemberId, to: MemberId): boolean {
    return this.full.has(`${from}>${to}`);
  }

  online(id: MemberId): boolean {
    return this.wires.has(id) && !this.offline.has(id) && !this.wires.get(id)!.closed;
  }

  get(id: MemberId): LoopbackWire | undefined {
    return this.wires.get(id);
  }

  /** Delivery keeps order: everything goes through one microtask queue. */
  later(fn: () => void): void {
    queueMicrotask(fn);
  }

  /** Bring links and introductions in line with who's online and who lists whom. */
  reconcile(): void {
    const want = new Set<string>();
    const ids = [...this.wires.keys()];
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b || !this.online(a) || !this.online(b) || this.cut.has(pair(a, b))) continue;
        if (this.wires.get(a)!.lists(b) && this.wires.get(b)!.lists(a)) want.add(pair(a, b));
      }
    }
    for (const p of [...this.links]) {
      if (want.has(p)) continue;
      this.links.delete(p);
      const [a, b] = p.split("|");
      this.later(() => this.wires.get(a)?.handler?.down(b));
      this.later(() => this.wires.get(b)?.handler?.down(a));
    }
    for (const p of want) {
      if (this.links.has(p)) continue;
      this.links.add(p);
      const [a, b] = p.split("|");
      this.later(() => this.wires.get(a)?.handler?.up(b));
      this.later(() => this.wires.get(b)?.handler?.up(a));
    }
    // who can be introduced to whom, per room
    for (const w of this.wires.values()) {
      if (!this.online(w.self)) continue;
      for (const roomId of w.roomIds()) {
        const ids = [...this.wires.values()].filter((o) => o !== w && this.online(o.self) && o.roomIds().includes(roomId) && !this.cut.has(pair(o.self, w.self))).map((o) => o.self).sort();
        const k = `${w.self}\n${roomId}`;
        if (this.reachableSent.get(k) === ids.join(",")) continue;
        this.reachableSent.set(k, ids.join(","));
        this.later(() => w.handler?.reachable(roomId, ids));
      }
    }
    for (const w of this.wires.values()) this.later(() => w.handler?.changed());
  }
}

export class LoopbackWire implements PeerWire {
  handler: WireHandler | null = null;
  closed = false;
  private rooms: WireRoom[] = [];

  constructor(readonly self: MemberId, private net: LoopbackNetwork) {}

  setHandler(h: WireHandler): void {
    this.handler = h;
  }

  setRooms(rooms: WireRoom[]): void {
    this.rooms = rooms;
    this.net.reconcile();
  }

  /** Lists `peer` as a member of one of its rooms. */
  lists(peer: MemberId): boolean {
    return this.rooms.some((r) => r.members.some((m) => m.id === peer));
  }

  roomIds(): RoomId[] {
    return this.rooms.map((r) => r.roomId);
  }

  send(peer: MemberId, text: string): boolean {
    if (!this.net.isLinked(this.self, peer)) return false;
    this.net.later(() => {
      if (this.net.isLinked(this.self, peer)) this.net.get(peer)?.handler?.frame(this.self, text);
    });
    return true;
  }

  sendStream(peer: MemberId, text: string): boolean {
    if (!this.net.isLinked(this.self, peer) || this.net.isFull(this.self, peer)) return false;
    this.net.later(() => {
      if (this.net.isLinked(this.self, peer)) this.net.get(peer)?.handler?.stream(this.self, text);
    });
    return true;
  }

  congested(peer: MemberId): boolean {
    return this.net.isFull(this.self, peer);
  }

  connected(): MemberId[] {
    return this.rooms.flatMap((r) => r.members.map((m) => m.id)).filter((id, i, all) => id !== this.self && all.indexOf(id) === i && this.net.isLinked(this.self, id));
  }

  async introduce(roomId: RoomId, to: MemberId, type: IntroType, body: unknown): Promise<void> {
    const target = this.net.get(to);
    if (!this.net.online(this.self) || !target || !this.net.online(to) || !target.roomIds().includes(roomId)) throw new Error(`${to} isn't reachable in room ${roomId}`);
    const copy = JSON.parse(JSON.stringify(body));
    this.net.later(() => target.handler?.intro(roomId, this.self, type, copy));
  }

  linkStates(): Map<MemberId, { state: PeerLinkState; since: number }> {
    const out = new Map<MemberId, { state: PeerLinkState; since: number }>();
    for (const r of this.rooms) for (const m of r.members) if (m.id !== this.self) out.set(m.id, { state: this.net.isLinked(this.self, m.id) ? "direct" : "offline", since: 0 });
    return out;
  }

  roomStates(): Map<RoomId, { signaling: "online" | "offline" }> {
    return new Map(this.rooms.map((r) => [r.roomId, { signaling: this.net.online(this.self) ? "online" : "offline" }]));
  }

  problems(): string[] {
    return [];
  }

  wake(_roomId?: RoomId): void {
    this.net.reconcile();
  }

  close(): void {
    this.closed = true;
    this.net.reconcile();
  }
}

// ---- helpers for tests -----------------------------------------------------------------------

export interface LoopbackMember {
  name: string;
  id: MemberId;
  identity: Identity;
  store: RoomStore;
  wire: LoopbackWire;
  team: TeamCore;
  /** What the member's transport logged (refusals, failed handlers…), for assertions. */
  logs: string[];
  /** Change the display name Settings → Team would hold. */
  rename(name: string): void;
}

/** A member on the network, with its identity and rooms under `dir/<name>`. */
export function loopbackMember(net: LoopbackNetwork, name: string, dir: string, opts: Partial<TeamOptions> = {}): LoopbackMember {
  const base = path.join(dir, name);
  const identity = loadIdentity(base);
  const store = new RoomStore(path.join(base, "rooms")).load();
  const wire = net.wire(identity.id);
  const logs: string[] = [];
  let display = name;
  const team = new TeamCore({ identity, store, wire, name: () => display, log: (m) => logs.push(m), ...opts });
  return { name, id: identity.id, identity, store, wire, team, logs, rename: (n) => (display = n) };
}

/** Wait until `cond` holds (polling), or fail naming `what`. */
export async function until(cond: () => boolean, what = "the condition", timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A room shared by several loopback members: the first creates it, the rest
 * join with invite codes. Resolves once every member has every other as a
 * member and connected.
 */
export async function loopbackRoom(names: string[], opts: { dir: string; groupKey?: string; net?: LoopbackNetwork; team?: Partial<TeamOptions> }) {
  const net = opts.net ?? new LoopbackNetwork();
  const members = names.map((n) => loopbackMember(net, n, opts.dir, opts.team));
  const [creator, ...rest] = members;
  const groupKey = opts.groupKey ?? "5110";
  const room = creator.team.createRoom({ name: groupKey, groupKey, signalingUrl: "http://loopback.invalid" });
  for (const m of rest) m.team.join(creator.team.createInvite(room.id));
  await until(() => members.every((m) => m.team.room(room.id)?.members.length === members.length), "every member to have the room");
  await until(() => members.every((m) => m.team.presence(room.id).length === members.length - 1), "every member to be connected");
  return { net, roomId: room.id, members };
}
