import * as crypto from "crypto";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity } from "../src/main/team/identity";
import { RoomStore } from "../src/main/team/rooms";
import { TeamCore } from "../src/main/team/transport";
import { WebRtcWire, type PeerHostBridge } from "../src/main/team/webrtc";
import { until } from "../src/main/team/loopback";
import { startLocalSignaling, type LocalSignaling } from "../signaling/src/local/server";
import { sdpFingerprint, signalPayload, TEAM_PROTOCOL, type SignedEnvelope } from "../src/shared/team/protocol";
import { FINGERPRINT_MISMATCH, type HostCommand, type HostEvent } from "../src/shared/team/peerHost";

/**
 * The WebRTC wire's decisions — signing, checking, epochs, knocks, joins —
 * over the real local signaling server, with a stand-in for the peer host:
 * two FakeHosts "connect" once each has the other's description, and present
 * a certificate (normally the one they advertised). The real WebRTC run is
 * test/teamWebrtc.e2e.test.ts.
 */
class FakeNet {
  hosts = new Map<string, FakeHost>();
}

class FakeHost implements PeerHostBridge {
  listener: (e: HostEvent) => void = () => undefined;
  conns = new Map<string, { epoch: string; remote: boolean; pinned: string | null; open: boolean }>();
  commands: HostCommand[] = [];
  started = 0;
  /** The certificate this host advertises; `presents` is the one it really uses (a MITM would differ). */
  advertised = crypto.randomBytes(32).toString("hex");
  presents: string | null = null;
  constructor(readonly self: string, private net: FakeNet) {
    net.hosts.set(self, this);
  }
  setListener(cb: (e: HostEvent) => void) {
    this.listener = cb;
  }
  start() {
    this.started++;
    queueMicrotask(() => this.listener({ ev: "ready" }));
  }
  stop() {}
  restart() {
    this.conns.clear();
    queueMicrotask(() => this.listener({ ev: "ready" }));
  }
  private sdp(type: string) {
    return `v=0\r\no=- ${type}\r\na=fingerprint:sha-256 ${this.advertised.match(/../g)!.join(":").toUpperCase()}\r\n`;
  }
  private emit(e: HostEvent) {
    queueMicrotask(() => this.listener(e));
  }
  command(cmd: HostCommand) {
    this.commands.push(cmd);
    const other = this.net.hosts.get((cmd as { peer: string }).peer);
    switch (cmd.op) {
      case "open":
        this.conns.set(cmd.peer, { epoch: cmd.epoch, remote: false, pinned: null, open: false });
        if (cmd.role === "offerer") this.emit({ ev: "local-description", peer: cmd.peer, epoch: cmd.epoch, description: { type: "offer", sdp: this.sdp("offer") } });
        return;
      case "remote": {
        const c = this.conns.get(cmd.peer);
        if (!c || c.epoch !== cmd.epoch) return;
        if (sdpFingerprint(cmd.description.sdp) !== cmd.fingerprint) throw new Error("main handed over a fingerprint the description doesn't carry");
        c.remote = true;
        c.pinned = cmd.fingerprint;
        if (cmd.description.type === "offer") this.emit({ ev: "local-description", peer: cmd.peer, epoch: cmd.epoch, description: { type: "answer", sdp: this.sdp("answer") } });
        queueMicrotask(() => this.tryOpen(cmd.peer));
        return;
      }
      case "close": {
        this.conns.delete(cmd.peer);
        const o = other?.conns.get(this.self);
        if (o?.open) {
          other!.conns.delete(this.self);
          other!.emit({ ev: "closed", peer: this.self, epoch: o.epoch, reason: "the other side closed" });
        }
        return;
      }
      case "send":
        if (this.conns.get(cmd.peer)?.open) other?.emit({ ev: "message", peer: this.self, data: cmd.data });
        return;
      case "stream":
        if (this.conns.get(cmd.peer)?.open) other?.emit({ ev: "stream", peer: this.self, data: cmd.data });
        return;
    }
  }
  /** Both sides have each other's description for the same epoch: the "DTLS handshake" checks the pin. */
  tryOpen(peer: string) {
    const other = this.net.hosts.get(peer);
    const mine = this.conns.get(peer);
    const theirs = other?.conns.get(this.self);
    if (!other || !mine || !theirs || mine.epoch !== theirs.epoch || !mine.remote || !theirs.remote || mine.open) return;
    for (const [h, c, remoteHost] of [[this, mine, other], [other, theirs, this]] as const) {
      const actual = remoteHost.presents ?? remoteHost.advertised;
      if (c.pinned !== actual) {
        h.conns.delete(remoteHost.self);
        h.emit({ ev: "closed", peer: remoteHost.self, epoch: c.epoch, reason: FINGERPRINT_MISMATCH });
        continue;
      }
      c.open = true;
      h.emit({ ev: "open", peer: remoteHost.self, epoch: c.epoch, route: "direct", fingerprint: actual });
    }
  }
}

const servers: LocalSignaling[] = [];
const teams: TeamCore[] = [];
afterEach(async () => {
  for (const t of teams.splice(0)) t.close();
  for (const s of servers.splice(0)) await s.close();
});

function member(name: string, net: FakeNet, dir: string) {
  const identity = loadIdentity(path.join(dir, name, "team"));
  const store = new RoomStore(path.join(dir, name, "team", "rooms")).load();
  const host = new FakeHost(identity.id, net);
  const logs: string[] = [];
  const wire = new WebRtcWire({ identity, host, log: (m) => logs.push(m), defaultIce: [], timing: { retryMs: [50, 100, 200], knockMs: 100, connectTimeoutMs: 2000, iceWaitMs: 200 } });
  const team = new TeamCore({ identity, store, wire, name: () => name, log: (m) => logs.push(m) });
  teams.push(team);
  return { name, identity, store, host, wire, team, logs };
}

async function roomOverSignaling(signal: LocalSignaling) {
  const dir = tempDir("wire");
  const net = new FakeNet();
  const ryan = member("Ryan", net, dir);
  const nick = member("Nick", net, dir);
  const room = ryan.team.createRoom({ name: "#5110 Donor entities", groupKey: "5110", signalingUrl: signal.url });
  // the inviter's app is online when it hands over a code
  await until(() => ryan.team.status().rooms[0]?.signaling === "online", "Ryan's signaling", 5000);
  const code = ryan.team.createInvite(room.id);
  nick.team.join(code);
  return { ryan, nick, roomId: room.id, net };
}

describe("the WebRTC wire over the local signaling server", () => {
  it("joins by invite code and connects: signed details checked, fingerprints pinned, room copied", async () => {
    const signal = await startLocalSignaling({ log: () => undefined });
    servers.push(signal);
    const { ryan, nick, roomId } = await roomOverSignaling(signal);
    await until(() => !!nick.team.room(roomId), "Nick to have the room", 8000);
    await until(() => ryan.team.presence(roomId).length === 1 && nick.team.presence(roomId).length === 1, "both connected", 8000);
    expect(nick.team.room(roomId)!.members.map((m) => m.name)).toEqual(["Ryan", "Nick"]);
    expect(ryan.team.peers()[0]).toMatchObject({ id: nick.identity.id, name: "Nick", state: "direct" });
    expect(ryan.team.status().rooms[0]).toMatchObject({ signaling: "online", online: [nick.identity.id] });
    // the lower id offered; the host was given the fingerprint from the signed description
    const offerer = ryan.identity.id < nick.identity.id ? ryan : nick;
    const answerer = offerer === ryan ? nick : ryan;
    expect(offerer.host.commands.find((c) => c.op === "open")).toMatchObject({ role: "offerer" });
    expect(answerer.host.commands.find((c) => c.op === "remote")).toMatchObject({ fingerprint: offerer.host.advertised });

    const got: string[] = [];
    nick.team.onEvent("member.renamed", (e) => got.push((e.body as { name: string }).name));
    ryan.team.publish(roomId, "member.renamed", { name: "Ryan E" });
    await until(() => got.length === 1, "the event over the wire");
    nick.team.onRequest("ping", (p) => `pong ${p}`);
    expect(await ryan.team.request(nick.identity.id, "ping", 7)).toBe("pong 7");
  });

  it("refuses a forged answer (changed fingerprint, or re-signed by another key) and connects once the tampering stops", async () => {
    const mallory = loadIdentity(path.join(tempDir("mallory"), "team"));
    let mode: "change" | "resign" | null = "change";
    const tampered: string[] = [];
    const signal = await startLocalSignaling({
      log: () => undefined,
      tamper: (_room, env) => {
        if (!mode || (env.type !== "answer" && env.type !== "offer")) return env;
        const body = env.body as { epoch: string; sdp: string };
        const sdp = body.sdp.replace(/a=fingerprint:sha-256 \S+/, `a=fingerprint:sha-256 ${"AB:".repeat(31)}AB`);
        tampered.push(`${mode}:${env.type}`);
        if (mode === "change") return { ...env, body: { ...body, sdp } }; // the signature no longer matches
        const forged: SignedEnvelope = { ...env, body: { ...body, sdp } };
        return { ...forged, sig: mallory.sign(signalPayload(forged)) }; // signed, but by someone who isn't the member
      },
    });
    servers.push(signal);
    const { ryan, nick, roomId } = await roomOverSignaling(signal);
    await until(() => tampered.length >= 2, "two forged descriptions", 8000);
    expect(ryan.team.presence(roomId)).toEqual([]);
    const logs = [...ryan.logs, ...nick.logs].join("\n");
    expect(logs).toMatch(/refused (offer|answer) from \w+ in room \S+: a bad signature/);
    mode = "resign";
    await until(() => tampered.some((t) => t.startsWith("resign")), "a re-signed forgery", 8000);
    await new Promise((r) => setTimeout(r, 100));
    expect(ryan.team.presence(roomId)).toEqual([]);
    // shown as a refusal, not just as offline
    const details = [...ryan.wire.linkStates().values(), ...nick.wire.linkStates().values()].map((p) => p.detail ?? "");
    expect(details.join()).toMatch(/weren't signed by this teammate/);
    mode = null;
    await until(() => ryan.team.presence(roomId).length === 1, "the honest connection", 10_000);
  });

  it("closes a connection whose certificate isn't the one in the signed description", async () => {
    const signal = await startLocalSignaling({ log: () => undefined });
    servers.push(signal);
    const { ryan, nick, roomId } = await roomOverSignaling(signal);
    await until(() => !!nick.team.room(roomId) && ryan.team.presence(roomId).length === 1, "connected", 8000);
    // a man in the middle terminates DTLS with its own certificate
    nick.host.presents = crypto.randomBytes(32).toString("hex");
    ryan.host.restart(); // force a new connection
    await until(() => ryan.team.peers()[0]?.state === "error", "the mismatch to show", 8000);
    expect(ryan.team.peers()[0].detail).toMatch(/certificate didn't match/);
    expect(ryan.team.presence(roomId)).toEqual([]);
    nick.host.presents = null;
    await until(() => ryan.team.presence(roomId).length === 1, "reconnected once the certificate is right", 10_000);
  });

  it("reconnects after the signaling connections drop and after the peer host restarts, keeping room state", async () => {
    const signal = await startLocalSignaling({ log: () => undefined });
    servers.push(signal);
    const { ryan, nick, roomId } = await roomOverSignaling(signal);
    await until(() => !!nick.team.room(roomId) && ryan.team.presence(roomId).length === 1, "connected", 8000);
    signal.dropAll(); // laptop slept: the WebSockets died
    await until(() => signal.online(roomId).length === 2, "signaling back", 10_000);
    ryan.host.restart(); // the hidden window died: every connection is gone
    await until(() => ryan.team.presence(roomId).length === 0, "the drop", 4000).catch(() => undefined);
    await until(() => ryan.team.presence(roomId).length === 1 && nick.team.presence(roomId).length === 1, "reconnected", 10_000);
    expect(ryan.team.room(roomId)!.members).toHaveLength(2);
    const seen: string[] = [];
    nick.team.onEvent("*", (e) => seen.push(e.type));
    ryan.team.publish(roomId, "member.renamed", { name: "Ryan again" });
    await until(() => seen.length === 1, "an event after reconnecting");
  });

  it("shows a teammate on another team protocol as needing an update, without connecting", async () => {
    const signal = await startLocalSignaling({ log: () => undefined });
    servers.push(signal);
    const { ryan, nick, roomId } = await roomOverSignaling(signal);
    await until(() => !!nick.team.room(roomId) && ryan.team.presence(roomId).length === 1, "connected", 8000);
    // Nick reconnects to signaling announcing a newer protocol (as the server would relay it)
    const ryanRoom = (ryan.wire as any).rooms.get(roomId);
    ryanRoom.client.peers.set(nick.identity.id, { id: nick.identity.id, team: TEAM_PROTOCOL + 1 });
    (ryan.wire as any).onSignaling(ryanRoom, { t: "peer-joined", peer: { id: nick.identity.id, team: TEAM_PROTOCOL + 1 } });
    await until(() => ryan.team.peers()[0]?.state === "needs-update", "needs-update");
    expect(ryan.team.peers()[0].detail).toMatch(/Their Mockingbird needs an update|needs an update/);
    expect(ryan.team.presence(roomId)).toEqual([]);
  });
});
