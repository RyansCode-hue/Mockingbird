import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity, randomToken, roomIdFor, signalingJoinKey, signalingTokenHash, type Identity } from "../src/main/team/identity";
import { DailyCounter, SignalingRoom, mintTurnCredentials, turnDailyLimit, DEFAULT_TURN_DAILY_LIMIT, type ConnState, type RoomSocket, type RoomLimits, type TurnQuota } from "../signaling/src/room";
import { healthBody } from "../signaling/src/config";
import { startLocalSignaling } from "../signaling/src/local/server";
import { allowCreatorsCommand, CLOSE, formatFingerprint, helloPayload, parseAllowedCreators, SIGNALING_PING, SIGNALING_PONG, SIGNALING_PROTOCOL, signalingSocketUrl, TEAM_PROTOCOL, type ServerMessage, type SignalingFeature } from "../src/shared/team/protocol";

const newId = (name: string) => loadIdentity(path.join(tempDir(name), "team"));

class FakeSocket implements RoomSocket {
  sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private st: ConnState | null = null;
  constructor(readonly cid: string) {}
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  state() {
    return this.st ? structuredClone(this.st) : null;
  }
  save(s: ConnState) {
    this.st = structuredClone(s);
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t) as any;
  }
}

/** A room over fake sockets and in-memory storage, as the Worker would drive it. */
function harness(
  o: {
    roomId?: string;
    limits?: Partial<RoomLimits>;
    turn?: { keyId: string; apiToken: string } | null;
    fetch?: typeof fetch;
    now?: () => number;
    storage?: Map<string, unknown>;
    /** Who may create rooms; default: the harness's creator. */
    allowed?: (creatorId: string) => readonly string[] | undefined;
    turnQuota?: TurnQuota;
    /** Default all; [] plays a Worker deployed before revoke. */
    features?: readonly SignalingFeature[];
  } = {}
) {
  const creator = newId("creator");
  let allowed = o.allowed ? o.allowed(creator.id) : [creator.id];
  const salt = randomToken();
  const roomId = o.roomId ?? roomIdFor(creator.publicKey, salt);
  const sockets: FakeSocket[] = [];
  const storage = o.storage ?? new Map<string, unknown>();
  const logs: string[] = [];
  const make = () =>
    new SignalingRoom({
      roomId,
      storage: { get: async (k) => structuredClone(storage.get(k)) as any, put: async (k, v) => void storage.set(k, structuredClone(v)) },
      sockets: () => sockets.filter((s) => !s.closed),
      now: o.now,
      turn: o.turn ?? null,
      fetch: o.fetch,
      stun: [{ urls: "stun:stun.example:3478" }],
      limits: o.limits,
      allowedCreators: allowed,
      turnQuota: o.turnQuota,
      features: o.features,
      log: (m) => logs.push(m),
    });
  let room = make();
  let n = 0;
  const connect = async (id: Identity, extra: { join?: string; create?: string; v?: number; badSig?: boolean } = {}) => {
    const s = new FakeSocket(`c${++n}`);
    sockets.push(s);
    room.open(s);
    const challenge = s.last("challenge")!;
    const fields = { publicKey: id.publicKey, ...(extra.join ? { join: extra.join } : {}), ...(extra.create ? { create: extra.create } : {}) };
    const sig = extra.badSig ? id.sign("something else") : id.sign(helloPayload(roomId, challenge.nonce, fields));
    await room.message(s, JSON.stringify({ t: "hello", v: extra.v ?? SIGNALING_PROTOCOL, team: TEAM_PROTOCOL, ...fields, sig }));
    return s;
  };
  const say = (s: FakeSocket, msg: unknown) => room.message(s, JSON.stringify(msg));
  return {
    creator,
    salt,
    roomId,
    sockets,
    storage,
    logs,
    connect,
    say,
    get room() {
      return room;
    },
    rehydrate: () => (room = make()),
    /** The Worker restarted with another ALLOWED_CREATORS. */
    setAllowed: (ids: readonly string[] | undefined) => {
      allowed = ids;
      room = make();
    },
  };
}

describe("signaling room: who gets in", () => {
  it("lets the creator claim the room with its salt, and refuses strangers", async () => {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    expect(c.last("welcome")).toMatchObject({ you: h.creator.id, peers: [], relay: false });
    const stranger = newId("stranger");
    const s = await h.connect(stranger);
    expect(s.last("error")).toMatchObject({ code: "not-member" });
    expect(s.closed?.code).toBe(CLOSE.notMember);
    // another key can't claim the room with the creator's salt
    const thief = await h.connect(stranger, { create: h.salt });
    expect(thief.closed?.code).toBe(CLOSE.notMember);
    expect(await h.room.memberIds()).toEqual([h.creator.id]);
  });

  it("refuses a hello signed by another key, or on another protocol", async () => {
    const h = harness();
    const bad = await h.connect(h.creator, { create: h.salt, badSig: true });
    expect(bad.last("error")?.message).toMatch(/signature/);
    expect(bad.closed?.code).toBe(CLOSE.notMember);
    const old = await h.connect(h.creator, { create: h.salt, v: SIGNALING_PROTOCOL + 1 });
    expect(old.last("error")).toMatchObject({ code: "protocol", serverProtocol: SIGNALING_PROTOCOL });
    expect(old.closed?.code).toBe(CLOSE.protocol);
  });

  it("lets a joiner knock once with an invite's join key, never sees the token, and lets it in on the admin's admit", async () => {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    const token = randomToken();
    await h.say(c, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: Date.now() + 3_600_000 });
    expect(c.last("invited")).toBeTruthy();
    expect(JSON.stringify([...h.storage.values()])).not.toContain(token);
    const nick = newId("nick");
    const n = await h.connect(nick, { join: signalingJoinKey(token) });
    expect(n.last("welcome")).toMatchObject({ you: nick.id, peers: [{ id: h.creator.id, team: TEAM_PROTOCOL }], knocking: true, relay: false });
    expect(c.last("peer-joined")).toEqual({ t: "peer-joined", peer: { id: nick.id, team: TEAM_PROTOCOL, knocking: true } });
    expect(await h.room.memberIds()).toEqual([h.creator.id]);
    expect(await h.room.knockingIds()).toEqual([nick.id]);
    // the same key can't let anyone else in
    const sam = await h.connect(newId("sam"), { join: signalingJoinKey(token) });
    expect(sam.closed?.code).toBe(CLOSE.notMember);
    // Nick's app reconnects while he waits: still at the door
    const waiting = await h.connect(nick, { join: signalingJoinKey(token) });
    expect(waiting.last("welcome")?.knocking).toBe(true);
    // the admin (the creator) admits him: welcomed again, as a member
    await h.say(c, { t: "admit", publicKeys: [nick.publicKey] });
    expect(c.last("admitted")).toEqual({ t: "admitted", ids: [nick.id] });
    expect(waiting.last("welcome")).toMatchObject({ you: nick.id, peers: [{ id: h.creator.id, team: TEAM_PROTOCOL }] });
    expect(waiting.last("welcome")?.knocking).toBeUndefined();
    expect(c.last("peer-joined")).toEqual({ t: "peer-joined", peer: { id: nick.id, team: TEAM_PROTOCOL } });
    expect(await h.room.memberIds()).toEqual([h.creator.id, nick.id]);
    expect(await h.room.knockingIds()).toEqual([]);
    // a member now: he reconnects by key alone
    const again = await h.connect(nick);
    expect(again.last("welcome")).toMatchObject({ you: nick.id });
    expect(again.last("welcome")?.knocking).toBeUndefined();
  });

  it("refuses an expired invite, and invites from non-members", async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    const c = await h.connect(h.creator, { create: h.salt });
    const token = randomToken();
    await h.say(c, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: now + 1000 });
    now += 5000;
    const late = await h.connect(newId("late"), { join: signalingJoinKey(token) });
    expect(late.closed?.code).toBe(CLOSE.notMember);
    await h.say(c, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: now + 30 * 24 * 3_600_000 });
    expect(c.last("error")?.message).toMatch(/7 days/);
  });

  it("lets a member admit keys from its room log (after the server lost its storage)", async () => {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    const nick = newId("nick");
    await h.say(c, { t: "admit", publicKeys: [nick.publicKey] });
    expect(c.last("admitted")).toEqual({ t: "admitted", ids: [nick.id] });
    expect((await h.connect(nick)).last("welcome")).toBeTruthy();
  });

  it("only talks to a connection after its hello", async () => {
    const h = harness();
    const s = new FakeSocket("x");
    h.sockets.push(s);
    h.room.open(s);
    await h.say(s, { t: "signal", to: "0".repeat(32), env: {} });
    expect(s.last("error")).toMatchObject({ code: "not-ready" });
    await h.room.message(s, SIGNALING_PING);
    expect(s.last("pong")).toBeTruthy();
  });
});

describe("signaling room: who may create rooms (ALLOWED_CREATORS)", () => {
  it("lets an allowlisted creator create the room", async () => {
    const h = harness({ allowed: (id) => ["f".repeat(32), id] });
    const c = await h.connect(h.creator, { create: h.salt });
    expect(c.last("welcome")).toMatchObject({ you: h.creator.id });
    expect(await h.room.memberIds()).toEqual([h.creator.id]);
  });

  it("refuses to create a room for a key that isn't listed, saying which fingerprint to add", async () => {
    const h = harness({ allowed: () => ["f".repeat(32)] });
    const c = await h.connect(h.creator, { create: h.salt });
    expect(c.last("error")).toEqual({ t: "error", code: "creation-refused", message: `This key (${formatFingerprint(h.creator.id)}) isn't allowed to create rooms on this signaling Worker — add its fingerprint to ALLOWED_CREATORS` });
    expect(c.closed?.code).toBe(CLOSE.creationRefused);
    expect(c.sent.some((m) => m.t === "welcome")).toBe(false);
    expect(await h.room.memberIds()).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/refused to create it for/);
  });

  it("refuses every new room while ALLOWED_CREATORS is unset or empty", async () => {
    for (const allowed of [undefined, []]) {
      const h = harness({ allowed: () => allowed });
      const c = await h.connect(h.creator, { create: h.salt });
      expect(c.last("error")).toMatchObject({ code: "creation-refused", message: expect.stringMatching(/doesn't allow new rooms yet — add your fingerprint \(.+\) to ALLOWED_CREATORS/) });
      expect(c.closed?.code).toBe(CLOSE.creationRefused);
      // and so nobody in it can mint TURN credentials
      await h.say(c, { t: "turn" });
      expect(c.sent.some((m) => m.t === "turn")).toBe(false);
    }
  });

  it("still lets invited joiners in, and members back, whatever the list says later", async () => {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    const token = randomToken();
    await h.say(c, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: Date.now() + 3_600_000 });
    // the Worker is redeployed with an empty list: existing rooms carry on
    h.setAllowed([]);
    const nick = newId("nick"); // never on the list
    const n = await h.connect(nick, { join: signalingJoinKey(token) });
    expect(n.last("welcome")).toMatchObject({ you: nick.id, knocking: true });
    const c2 = await h.connect(h.creator, { create: h.salt }); // a member, by key
    expect(c2.last("welcome")).toBeTruthy();
    await h.say(c2, { t: "admit", publicKeys: [nick.publicKey] });
    expect((await h.connect(nick)).last("welcome")).toMatchObject({ you: nick.id });
  });

  it("reads fingerprints as Settings shows them: grouped, comma- or space-separated; reports the rest", () => {
    const a = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const b = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    expect(parseAllowedCreators(`${formatFingerprint(a)}, ${formatFingerprint(b)}`)).toEqual({ ids: [a, b], invalid: [] });
    expect(parseAllowedCreators(`${formatFingerprint(a)} ${formatFingerprint(b)}`)).toEqual({ ids: [a, b], invalid: [] });
    expect(parseAllowedCreators(`${a.toUpperCase()}\n${b}; ${a}`)).toEqual({ ids: [a, b], invalid: [] });
    expect(parseAllowedCreators("ryan, a1b2")).toEqual({ ids: [], invalid: ["ryan", "a1b2"] });
    expect(parseAllowedCreators(undefined)).toEqual({ ids: [], invalid: [] });
    expect(allowCreatorsCommand([a, b])).toBe(`cd signaling && echo "${formatFingerprint(a)}, ${formatFingerprint(b)}" | npx wrangler secret put ALLOWED_CREATORS`);
    // the command's own value parses back to the same list
    expect(parseAllowedCreators(/echo "(.*)"/.exec(allowCreatorsCommand([a, b]))![1]).ids).toEqual([a, b]);
  });
});

describe("the Worker's /health", () => {
  it("says how many may create rooms, whether TURN is set and what it can do, never who", () => {
    const a = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    expect(healthBody({})).toEqual({ service: "mockingbird-signaling", protocol: SIGNALING_PROTOCOL, relay: false, creators: 0, features: ["revoke", "approve", "roles"] });
    const h = healthBody({ ALLOWED_CREATORS: `${formatFingerprint(a)}, ${"b".repeat(32)}, typo`, TURN_KEY_ID: "k", TURN_KEY_API_TOKEN: "t" });
    expect(h).toEqual({ service: "mockingbird-signaling", protocol: SIGNALING_PROTOCOL, relay: true, creators: 2, creatorsInvalid: 1, features: ["revoke", "approve", "roles"] });
    expect(JSON.stringify(h)).not.toContain("a1b2");
  });
});

describe("signaling room: relay and presence", () => {
  async function twoMembers() {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    const nick = newId("nick");
    await h.say(c, { t: "admit", publicKeys: [nick.publicKey] });
    const n = await h.connect(nick);
    return { h, c, n, nick };
  }

  it("relays a signal to its addressee with the sender stamped, and says when they're offline", async () => {
    const { h, c, n, nick } = await twoMembers();
    const env = { from: h.creator.id, to: nick.id, anything: "signed by the sender" };
    await h.say(c, { t: "signal", to: nick.id, env });
    expect(n.last("signal")).toEqual({ t: "signal", from: h.creator.id, env });
    await h.say(c, { t: "signal", to: "f".repeat(32), env: { ...env, to: "f".repeat(32) } });
    expect(c.last("error")).toMatchObject({ code: "peer-offline", to: "f".repeat(32) });
  });

  it("refuses a signal claiming another sender", async () => {
    const { h, n, nick } = await twoMembers();
    await h.say(n, { t: "signal", to: h.creator.id, env: { from: h.creator.id, to: h.creator.id } });
    expect(n.last("error")?.message).toMatch(/sender must be the connected member/);
    void nick;
  });

  it("tells members who left, and replaces a member's older connection", async () => {
    const { h, c, n, nick } = await twoMembers();
    const n2 = await h.connect(nick);
    expect(n.closed?.code).toBe(CLOSE.replaced);
    h.room.close(n); // the runtime reports the replaced socket closing
    expect(c.sent.filter((m) => m.t === "peer-left")).toEqual([]); // still connected through n2
    n2.closed = { code: 1000, reason: "bye" };
    h.room.close(n2);
    expect(c.last("peer-left")).toEqual({ t: "peer-left", id: nick.id });
  });

  it("keeps members and connections across hibernation (storage + attachments)", async () => {
    const { h, c, n, nick } = await twoMembers();
    h.rehydrate(); // the Durable Object was evicted; a new instance wakes for the next message
    await h.say(n, { t: "signal", to: h.creator.id, env: { from: nick.id } });
    expect(c.last("signal")).toMatchObject({ from: nick.id });
    expect(await h.room.memberIds()).toEqual([h.creator.id, nick.id]);
  });
});

describe("signaling room: revoke (leaving and removal)", () => {
  /** The creator, plus members admitted one after another (each a millisecond later than the one before). */
  async function room(extra: string[], o: { features?: readonly SignalingFeature[] } = {}) {
    let now = 1_000_000;
    const h = harness({ now: () => now, features: o.features });
    const c = await h.connect(h.creator, { create: h.salt });
    const ids: Identity[] = [];
    const socks: FakeSocket[] = [];
    for (const name of extra) {
      now += 1;
      const id = newId(name);
      await h.say(c, { t: "admit", publicKeys: [id.publicKey] });
      ids.push(id);
      socks.push(await h.connect(id));
    }
    return { h, c, ids, socks, inAnHour: () => now + 3_600_000 };
  }
  const removal = (member: string) => ({ type: "member.removed", body: { member }, sig: "signed by the remover's app" });

  it("announces what it can do, and lets a member cut itself off when it leaves", async () => {
    const { h, c, ids, socks } = await room(["nick"]);
    expect(c.last("welcome")).toMatchObject({ features: ["revoke", "approve", "roles"] });
    const [nick] = ids;
    const [n] = socks;
    await h.say(n, { t: "revoke", member: nick.id, event: removal(nick.id) });
    expect(n.last("revoked")).toEqual({ t: "revoked", member: nick.id });
    expect(n.closed?.code).toBe(CLOSE.notMember);
    expect(c.last("peer-left")).toEqual({ t: "peer-left", id: nick.id });
    expect(await h.room.memberIds()).toEqual([h.creator.id]);
    // back by key alone: refused, and told why with the removal itself
    const again = await h.connect(nick);
    expect(again.last("error")).toMatchObject({ code: "not-member", revoked: true, event: removal(nick.id) });
    expect(again.closed?.code).toBe(CLOSE.notMember);
    // members who connect later get it in their welcome
    const late = await h.connect(h.creator, { create: h.salt });
    expect(late.last("welcome")?.events).toEqual([removal(nick.id)]);
  });

  it("lets the admin (the creator) cut someone off: connections, invites, TURN and hellos go", async () => {
    const { h, c, ids, socks, inAnHour } = await room(["nick", "sam"]);
    const [nick] = ids;
    const [n, s] = socks;
    const token = randomToken();
    await h.say(n, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: inAnHour() });
    expect(n.last("invited")).toBeTruthy();
    await h.say(c, { t: "revoke", member: nick.id, event: removal(nick.id) });
    expect(c.last("revoked")).toEqual({ t: "revoked", member: nick.id });
    expect(n.last("error")).toMatchObject({ code: "not-member", revoked: true, event: removal(nick.id) });
    expect(n.closed?.code).toBe(CLOSE.notMember);
    expect(s.last("peer-left")).toEqual({ t: "peer-left", id: nick.id });
    // the invite Nick made no longer lets anyone in
    const newcomer = await h.connect(newId("newcomer"), { join: signalingJoinKey(token) });
    expect(newcomer.closed?.code).toBe(CLOSE.notMember);
    // a connection of his that's somehow still open gets nothing more: no relay credentials, no signals
    n.closed = null;
    await h.say(n, { t: "turn" });
    expect(n.last("turn")).toBeUndefined();
    expect(n.last("error")).toMatchObject({ code: "not-member" });
    expect(h.logs.some((l) => /refused a turn from .* isn't a member any more/.test(l))).toBe(true);
  });

  it("refuses a revoke of someone else from anyone but the owner or an admin, and says so", async () => {
    const { h, ids, socks } = await room(["nick", "sam"]);
    const [, sam] = ids;
    const [n] = socks;
    await h.say(n, { t: "revoke", member: sam.id });
    expect(n.last("error")).toMatchObject({ code: "forbidden", member: sam.id });
    expect(n.last("error")?.message).toMatch(/only the room's owner or an admin can remove members/);
    expect(await h.room.memberIds()).toContain(sam.id);
    expect(h.logs.some((l) => /refused .*'s revoke of/.test(l))).toBe(true);
  });

  it("hands the admin on to the member admitted earliest once the creator has left", async () => {
    const { h, c, ids, socks } = await room(["nick", "sam"]);
    const [nick, sam] = ids;
    const [n, s] = socks;
    await h.say(c, { t: "revoke", member: h.creator.id });
    await h.say(s, { t: "revoke", member: nick.id });
    expect(s.last("error")).toMatchObject({ code: "forbidden" });
    await h.say(n, { t: "revoke", member: sam.id });
    expect(n.last("revoked")).toEqual({ t: "revoked", member: sam.id });
    expect(await h.room.memberIds()).toEqual([nick.id]);
  });

  it("in a room from before revoke, only leaving works until the creator says hello again", async () => {
    const { h, c, ids, socks } = await room(["nick", "sam"]);
    const [, sam] = ids;
    const [n, s] = socks;
    // what a room created before this change keeps: no creator
    const rec = h.storage.get("room") as any;
    delete rec.creator;
    h.storage.set("room", rec);
    h.rehydrate();
    await h.say(c, { t: "revoke", member: sam.id });
    expect(c.last("error")).toMatchObject({ code: "forbidden", member: sam.id });
    expect(c.last("error")?.message).toMatch(/doesn't know the room's creator/);
    await h.say(s, { t: "revoke", member: sam.id }); // leaving still works
    expect(s.last("revoked")).toEqual({ t: "revoked", member: sam.id });
    // the creator's next hello proves the salt again: the room knows its admin from then on
    const c2 = await h.connect(h.creator, { create: h.salt });
    await h.say(c2, { t: "revoke", member: ids[0].id });
    expect(c2.last("revoked")).toEqual({ t: "revoked", member: ids[0].id });
    void n;
  });

  it("brings a revoked key back only through a new invite (or the admin), never a member's stale admit", async () => {
    const { h, c, ids, socks, inAnHour } = await room(["nick", "sam"]);
    const [nick] = ids;
    const [, s] = socks;
    await h.say(c, { t: "revoke", member: nick.id, event: removal(nick.id) });
    // Sam hasn't heard yet: his admit of the room log's members leaves Nick out
    await h.say(s, { t: "admit", publicKeys: [nick.publicKey] });
    expect(s.last("admitted")).toEqual({ t: "admitted", ids: [] });
    expect((await h.connect(nick)).closed?.code).toBe(CLOSE.notMember);
    // a new invite: at the door again (told nothing of the room, its removal included), in once the admin admits it
    const token = randomToken();
    await h.say(c, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: inAnHour() });
    const back = await h.connect(nick, { join: signalingJoinKey(token) });
    expect(back.last("welcome")).toMatchObject({ you: nick.id, knocking: true });
    expect(back.last("welcome")?.events).toBeUndefined();
    await h.say(s, { t: "admit", publicKeys: [nick.publicKey] }); // Sam isn't the admin
    expect(back.last("welcome")?.knocking).toBe(true);
    await h.say(c, { t: "admit", publicKeys: [nick.publicKey] });
    expect(back.last("welcome")).toMatchObject({ you: nick.id });
    expect(back.last("welcome")?.knocking).toBeUndefined();
    expect((await h.connect(nick)).last("welcome")).toBeTruthy();
    // the admin can admit a revoked key itself
    await h.say(c, { t: "revoke", member: nick.id });
    await h.say(c, { t: "admit", publicKeys: [nick.publicKey] });
    expect(c.last("admitted")).toEqual({ t: "admitted", ids: [nick.id] });
  });

  it("a Worker from before revoke doesn't know the message", async () => {
    const { h, c, ids } = await room(["nick"], { features: [] });
    expect(c.last("welcome")?.features).toBeUndefined();
    await h.say(c, { t: "revoke", member: ids[0].id });
    expect(c.last("error")).toMatchObject({ code: "bad-message", message: "unknown message revoke" });
    expect(await h.room.memberIds()).toContain(ids[0].id);
  });
});

describe("signaling room: joiners at the door (approve)", () => {
  /** The creator (the admin), Nick and Sam as members, and Lee knocking with an invite Nick made. */
  async function door(o: { features?: readonly SignalingFeature[] } = {}) {
    let now = 1_000_000;
    const h = harness({ now: () => now, features: o.features });
    const c = await h.connect(h.creator, { create: h.salt });
    const [nick, sam, lee] = [newId("nick"), newId("sam"), newId("lee")];
    await h.say(c, { t: "admit", publicKeys: [nick.publicKey, sam.publicKey] });
    const n = await h.connect(nick);
    const s = await h.connect(sam);
    const token = randomToken();
    await h.say(n, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: now + 3_600_000 });
    const l = await h.connect(lee, { join: signalingJoinKey(token) });
    return { h, c, n, s, l, nick, sam, lee, token, later: (ms: number) => (now += ms) };
  }
  const signal = (from: Identity, to: Identity, type: string) => ({ t: "signal", to: to.id, env: { from: from.id, to: to.id, type, body: {} } });

  it("a joiner at the door sees only its inviter, gets no TURN, invites, admits or revokes, and exchanges only the join handshake", async () => {
    const { h, c, n, s, l, nick, sam, lee, token } = await door();
    expect(l.last("welcome")).toEqual({ t: "welcome", v: SIGNALING_PROTOCOL, you: lee.id, now: expect.any(Number), peers: [{ id: nick.id, team: TEAM_PROTOCOL }], relay: false, features: ["revoke", "approve", "roles"], knocking: true });
    // members see it at the door
    for (const m of [c, n, s]) expect(m.last("peer-joined")).toEqual({ t: "peer-joined", peer: { id: lee.id, team: TEAM_PROTOCOL, knocking: true } });
    // only the handshake goes through
    for (const msg of [{ t: "turn" }, { t: "invite", tokenHash: signalingTokenHash(randomToken()), expiresAt: 2_000_000 }, { t: "admit", publicKeys: [lee.publicKey] }, { t: "revoke", member: nick.id }, { t: "deny", member: lee.id }]) {
      l.sent = [];
      await h.say(l, msg);
      expect(l.sent).toEqual([{ t: "error", code: "knocking", message: expect.stringMatching(/waiting for the room's admin/) }]);
    }
    expect(l.last("turn")).toBeUndefined();
    await h.say(l, signal(lee, nick, "join"));
    expect(n.last("signal")).toMatchObject({ from: lee.id, env: { type: "join" } });
    await h.say(n, signal(nick, lee, "join-pending"));
    expect(l.last("signal")).toMatchObject({ from: nick.id, env: { type: "join-pending" } });
    l.sent = [];
    await h.say(l, signal(lee, nick, "offer"));
    await h.say(n, signal(nick, lee, "offer"));
    expect(l.sent).toEqual([{ t: "error", code: "knocking", message: expect.any(String), to: nick.id }]);
    expect(n.last("error")).toMatchObject({ code: "knocking", to: lee.id });
    expect(n.sent.filter((m) => m.t === "signal" && m.env.type === "offer")).toEqual([]);
    // presence: it hears of its inviter only
    l.sent = [];
    s.closed = { code: 1000, reason: "bye" };
    h.room.close(s);
    expect(l.sent).toEqual([]);
    n.closed = { code: 1000, reason: "bye" };
    h.room.close(n);
    expect(l.sent).toEqual([{ t: "peer-left", id: nick.id }]);
    // it's not a member, and the invite it used is used
    expect(await h.room.memberIds()).toEqual([h.creator.id, nick.id, sam.id]);
    const other = await h.connect(newId("other"), { join: signalingJoinKey(token) });
    expect(other.closed?.code).toBe(CLOSE.notMember);
  });

  it("the admin's admit lets it in; a member's admit is ignored", async () => {
    const { h, c, n, s, l, lee } = await door();
    await h.say(n, { t: "admit", publicKeys: [lee.publicKey] });
    expect(n.last("admitted")).toEqual({ t: "admitted", ids: [] });
    expect(h.logs.some((l) => /ignored .*'s admit of .*: only the room's owner or an admin .* adds keys; it waits at the door/.test(l))).toBe(true);
    expect(await h.room.knockingIds()).toEqual([lee.id]);
    expect(l.last("welcome")?.knocking).toBe(true);
    await h.say(c, { t: "admit", publicKeys: [lee.publicKey] });
    expect(c.last("admitted")).toEqual({ t: "admitted", ids: [lee.id] });
    // welcomed again, as members are: everyone connected
    expect(l.last("welcome")?.knocking).toBeUndefined();
    expect(l.last("welcome")?.peers.map((p) => p.id).sort()).toEqual([h.creator.id, ...[n, s].map((x) => x.state()!.member!.id)].sort());
    expect(s.last("peer-joined")).toEqual({ t: "peer-joined", peer: { id: lee.id, team: TEAM_PROTOCOL } });
    // a member now: relay credentials, and the rest
    await h.say(l, { t: "turn" });
    expect(l.last("turn")).toBeTruthy();
    expect(await h.room.memberIds()).toContain(lee.id);
  });

  it("the admin declines: deny drops it at the door, its code stays used, and only a new code brings it back", async () => {
    const { h, c, n, l, lee, nick } = await door();
    await h.say(n, { t: "deny", member: lee.id });
    expect(n.last("error")).toMatchObject({ code: "forbidden", member: lee.id });
    await h.say(c, { t: "deny", member: nick.id });
    expect(c.last("error")).toMatchObject({ code: "forbidden", member: nick.id, message: expect.stringMatching(/a member, not at the door/) });
    await h.say(c, { t: "deny", member: lee.id });
    expect(c.last("denied")).toEqual({ t: "denied", member: lee.id });
    expect(l.last("error")).toEqual({ t: "error", code: "not-member", message: "the room's admin declined this join", declined: true });
    expect(l.closed?.code).toBe(CLOSE.notMember);
    expect(n.last("peer-left")).toEqual({ t: "peer-left", id: lee.id });
    expect(await h.room.knockingIds()).toEqual([]);
    const fresh = randomToken();
    await h.say(c, { t: "invite", tokenHash: signalingTokenHash(fresh), expiresAt: 2_000_000 });
    const back = await h.connect(lee, { join: signalingJoinKey(fresh) });
    expect(back.last("welcome")?.knocking).toBe(true);
  });

  it("a declined key's old code doesn't get it to the door again", async () => {
    const { h, c, lee, token } = await door();
    await h.say(c, { t: "deny", member: lee.id });
    const again = await h.connect(lee, { join: signalingJoinKey(token) });
    expect(again.last("error")).toMatchObject({ code: "not-member" });
    expect(again.closed?.code).toBe(CLOSE.notMember);
  });

  it("the knock expires with the invite", async () => {
    const { h, l, lee, token, later } = await door();
    later(3_600_001);
    l.sent = [];
    await h.say(l, signal(lee, lee, "join"));
    expect(l.last("error")).toMatchObject({ code: "not-member", message: expect.stringMatching(/invite expired before the room's admin accepted/) });
    expect(l.closed?.code).toBe(CLOSE.notMember);
    expect(await h.room.knockingIds()).toEqual([]);
    const again = await h.connect(lee, { join: signalingJoinKey(token) });
    expect(again.closed?.code).toBe(CLOSE.notMember);
  });

  it("an open knock past its invite's expiry is closed when the next connection says hello", async () => {
    const { h, l, later } = await door();
    later(3_600_001);
    await h.connect(h.creator, { create: h.salt });
    expect(l.last("error")).toMatchObject({ code: "not-member", message: expect.stringMatching(/invite expired/) });
    expect(l.closed?.code).toBe(CLOSE.notMember);
  });

  it("a room whose admin the server doesn't know takes any member's admit, as before", async () => {
    const { h, s, l, lee } = await door();
    const rec = h.storage.get("room") as any;
    delete rec.creator;
    h.storage.set("room", rec);
    h.rehydrate();
    await h.say(s, { t: "admit", publicKeys: [lee.publicKey] });
    expect(s.last("admitted")).toEqual({ t: "admitted", ids: [lee.id] });
    expect(l.last("welcome")?.knocking).toBeUndefined();
  });

  it("a Worker from before approve lets a join key straight in, and doesn't know deny", async () => {
    const { h, c, l, lee } = await door({ features: ["revoke"] });
    expect(l.last("welcome")).toMatchObject({ you: lee.id, features: ["revoke"] });
    expect(l.last("welcome")?.knocking).toBeUndefined();
    expect(await h.room.memberIds()).toContain(lee.id);
    await h.say(c, { t: "deny", member: lee.id });
    expect(c.last("error")).toMatchObject({ code: "bad-message", message: "unknown message deny" });
  });
});

describe("signaling room: limits", () => {
  it("rate-limits a chatty connection, then closes it", async () => {
    let now = 0;
    const h = harness({ limits: { burst: 3, perSecond: 1, strikes: 2 }, now: () => now });
    const c = await h.connect(h.creator, { create: h.salt });
    await h.say(c, { t: "ping" });
    await h.say(c, { t: "ping" });
    await h.say(c, { t: "ping" });
    expect(c.last("error")).toMatchObject({ code: "rate" });
    expect(c.closed).toBeNull();
    await h.say(c, { t: "ping" });
    expect(c.closed?.code).toBe(CLOSE.rate);
    void now;
  });

  it("refuses oversized and non-text messages", async () => {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    await h.room.message(c, "x".repeat(70_000));
    expect(c.last("error")).toMatchObject({ code: "too-big" });
    const d = await h.connect(h.creator, { create: h.salt });
    await h.room.message(d, new Uint8Array([1, 2, 3]));
    expect(d.last("error")).toMatchObject({ code: "bad-message" });
  });
});

describe("signaling room: TURN credentials", () => {
  const cloudflareAnswer = {
    iceServers: [
      { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u1", credential: "c1" },
    ],
  };

  it("hands out STUN only when no TURN key is configured", async () => {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    await h.say(c, { t: "turn" });
    expect(c.last("turn")).toEqual({ t: "turn", iceServers: [{ urls: "stun:stun.example:3478" }], ttl: 0, relay: false });
  });

  it("mints short-lived credentials from Cloudflare with the Worker's key, minus port 53", async () => {
    const fetchStub = vi.fn(async (_url: any, _init?: any) => new Response(JSON.stringify(cloudflareAnswer), { status: 201 }));
    const h = harness({ turn: { keyId: "key-id", apiToken: "api-token" }, fetch: fetchStub as unknown as typeof fetch });
    const c = await h.connect(h.creator, { create: h.salt });
    expect(c.last("welcome")?.relay).toBe(true);
    await h.say(c, { t: "turn" });
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer api-token", "Content-Type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ ttl: 86400 });
    expect(c.last("turn")).toEqual({
      t: "turn",
      ttl: 86400,
      relay: true,
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u1", credential: "c1" },
      ],
    });
    // asked again straight away: refused, no second mint
    await h.say(c, { t: "turn" });
    expect(c.last("error")).toMatchObject({ code: "rate" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("falls back to STUN and says why when Cloudflare refuses", async () => {
    const h = harness({ turn: { keyId: "k", apiToken: "bad" }, fetch: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch });
    const c = await h.connect(h.creator, { create: h.salt });
    await h.say(c, { t: "turn" });
    expect(c.last("turn")).toMatchObject({ relay: false, iceServers: [{ urls: "stun:stun.example:3478" }], error: expect.stringMatching(/401: unauthorized/) });
    expect(h.logs.join("\n")).toMatch(/minting TURN credentials failed/);
  });

  it("accepts the older single-object answer, and refuses one without credentials", async () => {
    const single = (async () => new Response(JSON.stringify({ iceServers: { urls: ["turn:t:3478"], username: "u", credential: "c" } }), { status: 201 })) as unknown as typeof fetch;
    expect(await mintTurnCredentials({ keyId: "k", apiToken: "t" }, 60, single)).toEqual([{ urls: ["turn:t:3478"], username: "u", credential: "c" }]);
    const none = (async () => new Response(JSON.stringify({ iceServers: [{ urls: "stun:x" }] }), { status: 201 })) as unknown as typeof fetch;
    await expect(mintTurnCredentials({ keyId: "k", apiToken: "t" }, 60, none)).rejects.toThrow(/no relay credentials/);
  });
});

describe("the Worker's daily TURN budget", () => {
  const memStorage = () => {
    const m = new Map<string, unknown>();
    return { get: async (k: string) => structuredClone(m.get(k)) as any, put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) };
  };

  it("counts per UTC day across callers, refuses past the limit, logs once, and resets the next day", async () => {
    const logs: string[] = [];
    const storage = memStorage();
    const day1 = Date.UTC(2026, 9, 7, 12);
    const counter = new DailyCounter(storage, 2, (m) => logs.push(m));
    expect(await counter.take(day1)).toEqual({ ok: true, used: 1, limit: 2 });
    // a second room's Durable Object reads the same counter (the Worker's one instance)
    expect(await new DailyCounter(storage, 2, (m) => logs.push(m)).take(day1)).toEqual({ ok: true, used: 2, limit: 2 });
    const again = new DailyCounter(storage, 2, (m) => logs.push(m));
    expect(await again.take(day1 + 1000)).toEqual({ ok: false, used: 2, limit: 2 });
    expect(await again.take(day1 + 2000)).toEqual({ ok: false, used: 2, limit: 2 });
    expect(logs).toEqual([expect.stringMatching(/TURN budget used up: 2 credentials minted today \(2026-10-07, limit 2\)/)]);
    expect(await again.take(Date.UTC(2026, 9, 8, 0, 0, 1))).toEqual({ ok: true, used: 1, limit: 2 });
  });

  it("stops a member looping on credentials: past the budget they get STUN only, and Cloudflare isn't asked", async () => {
    let now = Date.UTC(2026, 9, 7, 12);
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ iceServers: [{ urls: ["turn:t:3478"], username: "u", credential: "c" }] }), { status: 201 }));
    const quotaLogs: string[] = [];
    const h = harness({ turn: { keyId: "k", apiToken: "t" }, fetch: fetchStub as unknown as typeof fetch, now: () => now, turnQuota: new DailyCounter(memStorage(), 3, (m) => quotaLogs.push(m)) });
    const c = await h.connect(h.creator, { create: h.salt });
    for (let i = 0; i < 5; i++) {
      await h.say(c, { t: "turn" });
      now += 31_000; // past the per-connection interval each time
    }
    const turns = c.sent.filter((m): m is Extract<ServerMessage, { t: "turn" }> => m.t === "turn");
    expect(turns.map((t) => t.relay)).toEqual([true, true, true, false, false]);
    expect(turns[3]).toMatchObject({ relay: false, iceServers: [{ urls: "stun:stun.example:3478" }], error: expect.stringMatching(/daily relay budget \(3 credentials\) is used up/) });
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(quotaLogs).toHaveLength(1);
  });

  it("gives no credentials when the budget can't be checked", async () => {
    const fetchStub = vi.fn();
    const h = harness({ turn: { keyId: "k", apiToken: "t" }, fetch: fetchStub as unknown as typeof fetch, turnQuota: { take: async () => Promise.reject(new Error("quota object unreachable")) } });
    const c = await h.connect(h.creator, { create: h.salt });
    await h.say(c, { t: "turn" });
    expect(c.last("turn")).toMatchObject({ relay: false, error: expect.stringMatching(/couldn't check the relay budget: quota object unreachable/) });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(h.logs.join("\n")).toMatch(/couldn't check the relay budget/);
  });

  it("reads TURN_DAILY_LIMIT, falling back to the default for anything but a positive count", () => {
    expect(turnDailyLimit("50")).toBe(50);
    for (const v of [undefined, "", "0", "-3", "1.5", "lots"]) expect(turnDailyLimit(v)).toBe(DEFAULT_TURN_DAILY_LIMIT);
  });
});

describe("the local signaling server", () => {
  /** A client over Node's own WebSocket (the one the app's main process uses). */
  function client(url: string) {
    const ws = new WebSocket(url);
    const inbox: any[] = [];
    const waiters: (() => void)[] = [];
    ws.onmessage = (e) => {
      inbox.push(typeof e.data === "string" && e.data.startsWith("{") ? JSON.parse(e.data) : e.data);
      waiters.splice(0).forEach((w) => w());
    };
    const next = async (pred: (m: any) => boolean = () => true, ms = 3000) => {
      const start = Date.now();
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() - start > ms) throw new Error(`no matching message (have ${JSON.stringify(inbox).slice(0, 300)})`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    };
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("couldn't connect"));
    });
    return { ws, next, opened };
  }

  it("serves the room logic over WebSockets: hello, relay, keep-alive, big messages, a dropped connection", async () => {
    const server = await startLocalSignaling({ log: () => undefined });
    try {
      const health = await (await fetch(`${server.url}/health`)).json();
      expect(health).toMatchObject({ service: "mockingbird-signaling", protocol: SIGNALING_PROTOCOL, creators: "any", local: true });
      const ryan = newId("ryan");
      const salt = randomToken();
      const roomId = roomIdFor(ryan.publicKey, salt);
      const r = client(signalingSocketUrl(server.url, roomId));
      await r.opened;
      const ch = await r.next((m) => m.t === "challenge");
      r.ws.send(JSON.stringify({ t: "hello", v: SIGNALING_PROTOCOL, team: TEAM_PROTOCOL, publicKey: ryan.publicKey, create: salt, sig: ryan.sign(helloPayload(roomId, ch.nonce, { publicKey: ryan.publicKey, create: salt })) }));
      expect(await r.next((m) => m.t === "welcome")).toMatchObject({ you: ryan.id });

      const nick = newId("nick");
      r.ws.send(JSON.stringify({ t: "admit", publicKeys: [nick.publicKey] }));
      await r.next((m) => m.t === "admitted");
      const n = client(signalingSocketUrl(server.url, roomId));
      await n.opened;
      const ch2 = await n.next((m) => m.t === "challenge");
      n.ws.send(JSON.stringify({ t: "hello", v: SIGNALING_PROTOCOL, team: TEAM_PROTOCOL, publicKey: nick.publicKey, sig: nick.sign(helloPayload(roomId, ch2.nonce, { publicKey: nick.publicKey })) }));
      await n.next((m) => m.t === "welcome");
      expect(server.online(roomId).sort()).toEqual([ryan.id, nick.id].sort());

      const big = "x".repeat(60_000); // > 65535 bytes needs the 64-bit length form once JSON-wrapped with the envelope
      r.ws.send(JSON.stringify({ t: "signal", to: nick.id, env: { from: ryan.id, big } }));
      expect((await n.next((m) => m.t === "signal")).env.big).toBe(big);

      n.ws.send(SIGNALING_PING);
      expect(await n.next((m) => m === SIGNALING_PONG || m?.t === "pong")).toBeTruthy();

      const closed = new Promise<number>((resolve) => (r.ws.onclose = (e) => resolve(e.code)));
      server.dropAll();
      expect(await closed).toBe(1006);
    } finally {
      await server.close();
    }
  });

  it("refuses paths that aren't rooms", async () => {
    const server = await startLocalSignaling({ log: () => undefined });
    try {
      expect((await fetch(`${server.url}/nope`)).status).toBe(404);
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/rooms/short`);
      await expect(new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = () => reject(new Error("refused")))))).rejects.toThrow("refused");
    } finally {
      await server.close();
    }
  });
});
