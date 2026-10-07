import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity, randomToken, roomIdFor, signalingJoinKey, signalingTokenHash, type Identity } from "../src/main/team/identity";
import { SignalingRoom, mintTurnCredentials, type ConnState, type RoomSocket, type RoomLimits } from "../signaling/src/room";
import { startLocalSignaling } from "../signaling/src/local/server";
import { CLOSE, helloPayload, SIGNALING_PING, SIGNALING_PONG, SIGNALING_PROTOCOL, signalingSocketUrl, TEAM_PROTOCOL, type ServerMessage } from "../src/shared/team/protocol";

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
function harness(o: { roomId?: string; limits?: Partial<RoomLimits>; turn?: { keyId: string; apiToken: string } | null; fetch?: typeof fetch; now?: () => number; storage?: Map<string, unknown> } = {}) {
  const creator = newId("creator");
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
  return { creator, salt, roomId, sockets, storage, logs, connect, say, get room() { return room; }, rehydrate: () => (room = make()) };
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

  it("admits a joiner once with an invite's join key, and never sees the token", async () => {
    const h = harness();
    const c = await h.connect(h.creator, { create: h.salt });
    const token = randomToken();
    await h.say(c, { t: "invite", tokenHash: signalingTokenHash(token), expiresAt: Date.now() + 3_600_000 });
    expect(c.last("invited")).toBeTruthy();
    expect(JSON.stringify([...h.storage.values()])).not.toContain(token);
    const nick = newId("nick");
    const n = await h.connect(nick, { join: signalingJoinKey(token) });
    expect(n.last("welcome")).toMatchObject({ you: nick.id, peers: [{ id: h.creator.id, team: TEAM_PROTOCOL }] });
    expect(c.last("peer-joined")).toEqual({ t: "peer-joined", peer: { id: nick.id, team: TEAM_PROTOCOL } });
    // the same key can't let anyone else in
    const sam = await h.connect(newId("sam"), { join: signalingJoinKey(token) });
    expect(sam.closed?.code).toBe(CLOSE.notMember);
    // Nick is a member now: he reconnects by key alone
    const again = await h.connect(nick);
    expect(again.last("welcome")).toBeTruthy();
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
      expect(health).toMatchObject({ service: "mockingbird-signaling", protocol: SIGNALING_PROTOCOL });
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
