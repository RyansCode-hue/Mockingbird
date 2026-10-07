import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { configureWebRtc, ElectronPeerHost } from "../../src/main/team/peerHost";
import { loadIdentity } from "../../src/main/team/identity";
import { RoomStore } from "../../src/main/team/rooms";
import { TeamCore } from "../../src/main/team/transport";
import { WebRtcWire } from "../../src/main/team/webrtc";
import { until } from "../../src/main/team/loopback";
import { startLocalSignaling } from "../../signaling/src/local/server";
import { signalPayload, type SignedEnvelope } from "../../src/shared/team/protocol";

/**
 * Real WebRTC between two Mockingbird peer hosts (hidden Electron windows,
 * the app's own bundle) over the local signaling server, in one Electron
 * process. Run by test/teamWebrtc.e2e.test.ts, which reads the "E2E {json}"
 * lines this prints. Everything lives under $HOME (the test's throwaway home).
 */

const home = process.env.HOME!;
const log = (m: string) => process.stdout.write(`LOG ${m}\n`);
const report = (o: unknown) => process.stdout.write(`E2E ${JSON.stringify(o)}\n`);

app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("password-store", "basic");
configureWebRtc(app);
app.setPath("userData", path.join(home, "e2e-userdata"));
app.on("window-all-closed", () => undefined); // hidden windows come and go; the scenario decides when to quit

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const detail = await fn();
    report({ step: name, ok: true, ms: Date.now() - start, detail });
    return detail;
  } catch (err) {
    report({ step: name, ok: false, ms: Date.now() - start, error: (err as Error).stack ?? String(err) });
    throw err;
  }
}

async function run(): Promise<void> {
  app.dock?.hide();
  let tamper: ((env: SignedEnvelope) => SignedEnvelope) | null = null;
  const signal = await startLocalSignaling({ log, tamper: (_room, env) => (tamper ? tamper(env) : env) });
  const member = (name: string) => {
    const dir = path.join(home, name, "team");
    fs.mkdirSync(dir, { recursive: true });
    const identity = loadIdentity(dir);
    const store = new RoomStore(path.join(dir, "rooms")).load();
    const host = new ElectronPeerHost({ assetsDir: __dirname, log: (m) => log(`${name} host: ${m}`) });
    const wire = new WebRtcWire({ identity, host, defaultIce: [], log: (m) => log(`${name}: ${m}`), timing: { retryMs: [300, 1000, 2000], knockMs: 1000, connectTimeoutMs: 15_000, iceWaitMs: 500 } });
    const team = new TeamCore({ identity, store, wire, name: () => name, log: (m) => log(`${name} team: ${m}`) });
    return { name, identity, host, wire, team };
  };
  const ryan = member("Ryan");
  const nick = member("Nick");
  const both = (roomId: string) => ryan.team.presence(roomId).length === 1 && nick.team.presence(roomId).length === 1;
  let roomId = "";

  try {
    await step("connect: share a room, join by code, connect peer to peer", async () => {
      roomId = ryan.team.createRoom({ name: "#5110 Donor entities", groupKey: "5110", signalingUrl: signal.url }).id;
      await until(() => ryan.team.status().rooms[0]?.signaling === "online", "Ryan's signaling", 10_000);
      nick.team.join(ryan.team.createInvite(roomId));
      await until(() => !!nick.team.room(roomId), "Nick to have the room", 20_000);
      await until(() => both(roomId), "both connected", 20_000);
      return { members: nick.team.room(roomId)!.members.map((m) => m.name), ryanSees: ryan.team.peers(), nickSees: nick.team.peers() };
    });

    await step("events: published on one side, applied on the other", async () => {
      const got: string[] = [];
      const off = nick.team.onEvent("member.renamed", (e) => got.push((e.body as { name: string }).name));
      ryan.team.publish(roomId, "member.renamed", { name: "Ryan E" });
      await until(() => got.length === 1, "the event", 5000);
      off();
      return { got, nicksView: nick.team.room(roomId)!.members[0].name };
    });

    await step("rpc: a request with a 300 KB answer (sent in parts over the data channel)", async () => {
      nick.team.onRequest("echo", (p: { n: number }) => ({ n: p.n, blob: "x".repeat(300_000) }));
      const r = await ryan.team.request<{ n: number; blob: string }>(nick.identity.id, "echo", { n: 42 }, { roomId, timeoutMs: 10_000 });
      if (r.n !== 42 || r.blob.length !== 300_000) throw new Error("wrong answer");
      return { bytes: r.blob.length };
    });

    await step("stream: 500 chunks arrive in order on the lossy channel", async () => {
      const got: { seq: number; gap: boolean; chunk: string }[] = [];
      const off = nick.team.onStream("pane:*", (chunk, ctx) => got.push({ seq: ctx.seq, gap: ctx.gap, chunk }));
      const s = ryan.team.stream(roomId, "pane:s1");
      let refused = 0;
      for (let i = 0; i < 500; i++) if (!s.write(`line ${i}\r\n`)) refused++;
      await until(() => got.length + refused >= 500, "the chunks", 10_000);
      off();
      const inOrder = got.every((g, i) => i === 0 || g.seq > got[i - 1].seq);
      if (!inOrder) throw new Error("out of order");
      return { received: got.length, refused, gaps: got.filter((g) => g.gap).length };
    });

    await step("host restart: the hidden window dies; connections come back, room state intact", async () => {
      ryan.host.crashForTest();
      await until(() => ryan.team.presence(roomId).length === 0, "the drop", 10_000);
      await until(() => both(roomId), "reconnected", 30_000);
      const got: string[] = [];
      const off = nick.team.onEvent("*", (e) => got.push(e.type));
      ryan.team.publish(roomId, "member.renamed", { name: "Ryan after restart" });
      await until(() => got.length === 1, "an event after the restart", 5000);
      off();
      return { members: ryan.team.room(roomId)!.members.length, peer: ryan.team.peers()[0] };
    });

    await step("sleep: signaling and the peer connection both drop; fresh signaling and a new connection", async () => {
      signal.dropAll();
      nick.host.crashForTest();
      await until(() => !both(roomId), "the drop", 10_000);
      await until(() => signal.online(roomId).length === 2, "signaling back", 30_000);
      await until(() => both(roomId), "reconnected", 30_000);
      return { peer: nick.team.peers()[0] };
    });

    await step("pinning: forged descriptions (changed certificate, or re-signed by a stranger) are refused; honest ones connect", async () => {
      const mallory = loadIdentity(path.join(home, "mallory", "team"));
      const forged = { changed: 0, resigned: 0 };
      let mode: "changed" | "resigned" = "changed";
      tamper = (env) => {
        if (env.type !== "offer" && env.type !== "answer") return env;
        forged[mode]++;
        const body = env.body as { epoch: string; sdp: string };
        const fake = { ...env, body: { ...body, sdp: body.sdp.replace(/a=fingerprint:sha-256 \S+/g, `a=fingerprint:sha-256 ${"AB:".repeat(31)}AB`) } };
        return mode === "changed" ? fake : { ...fake, sig: mallory.sign(signalPayload(fake)) };
      };
      ryan.host.crashForTest();
      await until(() => ryan.team.presence(roomId).length === 0, "the drop", 10_000);
      await until(() => forged.changed >= 2, "forged descriptions", 20_000);
      await new Promise((r) => setTimeout(r, 1500));
      const connectedWhileChanged = both(roomId);
      mode = "resigned";
      await until(() => forged.resigned >= 2, "re-signed descriptions", 20_000);
      await new Promise((r) => setTimeout(r, 1500));
      const connectedWhileResigned = both(roomId);
      const refusals = [...ryan.wire.linkStates().values(), ...nick.wire.linkStates().values()].map((s) => s.detail).filter(Boolean);
      tamper = null;
      await until(() => both(roomId), "the honest connection", 30_000);
      if (connectedWhileChanged || connectedWhileResigned) throw new Error("connected while descriptions were forged");
      return { forged, refusals };
    });
  } finally {
    ryan.team.close();
    nick.team.close();
    await signal.close();
  }
}

app
  .whenReady()
  .then(run)
  .then(
    () => {
      report({ done: true });
      app.exit(0);
    },
    (err) => {
      report({ done: true, error: (err as Error).stack ?? String(err) });
      app.exit(1);
    }
  );
