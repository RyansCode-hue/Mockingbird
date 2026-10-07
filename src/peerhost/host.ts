import { normalizeFingerprint, sdpFingerprint } from "../shared/team/protocol";
import { FINGERPRINT_MISMATCH, type HostCommand, type HostEvent, type Route } from "../shared/team/peerHost";

/**
 * The hidden peer-host window: Mockingbird's WebRTC connections, one per
 * teammate, run by commands from the main process (see
 * src/shared/team/peerHost.ts). Each connection has two data channels,
 * negotiated up front: "control" (reliable, ordered: room events, requests)
 * and "stream" (ordered, never retransmitted: terminal output).
 *
 * A connection only counts as open once both channels are open and the
 * peer's DTLS certificate — read from the connection's stats — is the one
 * pinned from its signed description. Messages that arrive before that wait.
 */

declare global {
  interface Window {
    peerHost: { onCommand(cb: (cmd: HostCommand) => void): void; emit(e: HostEvent): void };
  }
}

/** Above this many buffered bytes the stream channel drops writes. */
const STREAM_HIGH_WATER = 1 << 20;
/** The control channel's queue is pumped while less than this is buffered. */
const CONTROL_HIGH_WATER = 8 << 20;
const HEARTBEAT_MS = 5000;
/** No answer to the heartbeat for this long: the connection is dead. */
const HEARTBEAT_DEAD_MS = 20_000;
const PING = "\u0000ping";
const PONG = "\u0000pong";

interface Conn {
  peer: string;
  epoch: string;
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  stream: RTCDataChannel;
  /** The DTLS fingerprint this connection is pinned to (from the first verified remote description). */
  pinned: string | null;
  verified: boolean;
  closed: boolean;
  queue: string[];
  inbox: string[];
  candidates: RTCIceCandidateInit[];
  lastHeard: number;
  route: Route | null;
  congested: boolean;
  dropped: number;
  timers: ReturnType<typeof setInterval>[];
}

const conns = new Map<string, Conn>();
const emit = (e: HostEvent) => window.peerHost.emit(e);

function fail(where: string, c: Conn | null, err: unknown): void {
  emit({ ev: "error", ...(c ? { peer: c.peer, epoch: c.epoch } : {}), message: `${where}: ${err instanceof Error ? err.message : String(err)}` });
}

function close(c: Conn, reason: string): void {
  if (c.closed) return;
  c.closed = true;
  for (const t of c.timers) clearInterval(t);
  try {
    c.pc.close();
  } catch (err) {
    fail("closing a connection", c, err);
  }
  if (conns.get(c.peer) === c) conns.delete(c.peer);
  emit({ ev: "closed", peer: c.peer, epoch: c.epoch, reason });
}

/** The certificate the peer is actually using, from the connection's stats. */
async function remoteFingerprint(pc: RTCPeerConnection): Promise<string | null> {
  const stats = await pc.getStats();
  let certId: string | undefined;
  stats.forEach((s) => {
    if (s.type === "transport" && s.remoteCertificateId) certId = s.remoteCertificateId;
  });
  const cert = certId ? stats.get(certId) : undefined;
  return cert?.fingerprint ? normalizeFingerprint(cert.fingerprint) : null;
}

/** Relayed (TURN) or direct, from the selected candidate pair. */
async function routeOf(pc: RTCPeerConnection): Promise<Route | null> {
  const stats = await pc.getStats();
  let pairId: string | undefined;
  stats.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
  });
  if (!pairId) {
    stats.forEach((s) => {
      if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pairId = s.id;
    });
  }
  const pair = pairId ? stats.get(pairId) : undefined;
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "turn" : "direct";
}

function pump(c: Conn): void {
  while (c.queue.length && c.control.readyState === "open" && c.control.bufferedAmount < CONTROL_HIGH_WATER) {
    try {
      c.control.send(c.queue.shift()!);
    } catch (err) {
      fail("sending on the control channel", c, err);
      return close(c, "the control channel refused a message");
    }
  }
}

async function verify(c: Conn): Promise<void> {
  if (c.verified || c.closed || c.control.readyState !== "open" || c.stream.readyState !== "open") return;
  let actual: string | null;
  try {
    actual = await remoteFingerprint(c.pc);
  } catch (err) {
    fail("reading the peer's certificate", c, err);
    return close(c, "couldn't read the peer's certificate");
  }
  if (c.closed || c.verified) return;
  if (!actual || !c.pinned || actual !== c.pinned) {
    emit({ ev: "error", peer: c.peer, epoch: c.epoch, message: `certificate ${actual ?? "unknown"} isn't the pinned ${c.pinned ?? "none"}` });
    return close(c, FINGERPRINT_MISMATCH);
  }
  const route = await routeOf(c.pc).catch((err) => (fail("reading the route", c, err), null));
  if (c.closed || c.verified) return;
  // verified only now: until "open" is out, arriving messages wait in the inbox (main drops frames before open)
  c.verified = true;
  c.route = route;
  c.lastHeard = Date.now();
  emit({ ev: "open", peer: c.peer, epoch: c.epoch, route: c.route, fingerprint: actual });
  for (const m of c.inbox.splice(0)) emit({ ev: "message", peer: c.peer, data: m });
  pump(c);
  c.timers.push(
    setInterval(() => {
      if (c.closed) return;
      if (Date.now() - c.lastHeard > HEARTBEAT_DEAD_MS) return close(c, "the teammate stopped answering");
      if (c.control.readyState === "open") c.control.send(PING);
    }, HEARTBEAT_MS),
    setInterval(() => {
      routeOf(c.pc).then(
        (r) => {
          if (!c.closed && r !== c.route) {
            c.route = r;
            emit({ ev: "route", peer: c.peer, epoch: c.epoch, route: r });
          }
        },
        (err) => fail("reading the route", c, err)
      );
    }, 10_000)
  );
}

function open(cmd: Extract<HostCommand, { op: "open" }>): void {
  const old = conns.get(cmd.peer);
  if (old) close(old, "replaced");
  const pc = new RTCPeerConnection({ iceServers: cmd.iceServers as RTCIceServer[], ...(cmd.relayOnly ? { iceTransportPolicy: "relay" as const } : {}) });
  const c: Conn = {
    peer: cmd.peer,
    epoch: cmd.epoch,
    pc,
    control: pc.createDataChannel("control", { negotiated: true, id: 0, ordered: true }),
    stream: pc.createDataChannel("stream", { negotiated: true, id: 1, ordered: true, maxRetransmits: 0 }),
    pinned: null,
    verified: false,
    closed: false,
    queue: [],
    inbox: [],
    candidates: [],
    lastHeard: Date.now(),
    route: null,
    congested: false,
    dropped: 0,
    timers: [],
  };
  conns.set(cmd.peer, c);
  c.control.bufferedAmountLowThreshold = CONTROL_HIGH_WATER / 4;
  c.stream.bufferedAmountLowThreshold = STREAM_HIGH_WATER / 4;
  pc.onicecandidate = (e) => {
    if (e.candidate && !c.closed) emit({ ev: "candidate", peer: c.peer, epoch: c.epoch, candidate: e.candidate.toJSON() as any });
  };
  pc.onconnectionstatechange = () => {
    if (c.closed) return;
    emit({ ev: "state", peer: c.peer, epoch: c.epoch, state: pc.connectionState });
    if (pc.connectionState === "connected" && c.verified) {
      routeOf(pc).then(
        (r) => {
          if (!c.closed && r !== c.route) {
            c.route = r;
            emit({ ev: "route", peer: c.peer, epoch: c.epoch, route: r });
          }
        },
        (err) => fail("reading the route", c, err)
      );
    }
  };
  c.control.onopen = () => void verify(c);
  c.stream.onopen = () => void verify(c);
  c.control.onclose = () => close(c, "the control channel closed");
  c.control.onbufferedamountlow = () => pump(c);
  c.control.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    c.lastHeard = Date.now();
    if (e.data === PING) {
      if (c.control.readyState === "open") c.control.send(PONG);
      return;
    }
    if (e.data === PONG) return;
    if (c.verified) emit({ ev: "message", peer: c.peer, data: e.data });
    else c.inbox.push(e.data);
  };
  c.stream.onmessage = (e) => {
    if (c.verified && typeof e.data === "string") emit({ ev: "stream", peer: c.peer, data: e.data });
  };
  c.stream.onbufferedamountlow = () => {
    if (!c.congested) return;
    c.congested = false;
    emit({ ev: "congestion", peer: c.peer, congested: false, dropped: c.dropped });
  };
  if (cmd.role === "offerer") {
    (async () => {
      await pc.setLocalDescription(await pc.createOffer());
      if (!c.closed) emit({ ev: "local-description", peer: c.peer, epoch: c.epoch, description: { type: "offer", sdp: pc.localDescription!.sdp } });
    })().catch((err) => {
      fail("making an offer", c, err);
      close(c, "couldn't make an offer");
    });
  }
}

async function remote(cmd: Extract<HostCommand, { op: "remote" }>): Promise<void> {
  const c = conns.get(cmd.peer);
  if (!c || c.epoch !== cmd.epoch || c.closed) return;
  // main pinned this fingerprint from the signed description; it must be the one the description carries,
  // and once pinned a connection never accepts another (a renegotiation can't swap certificates)
  let fp: string;
  try {
    fp = sdpFingerprint(cmd.description.sdp);
  } catch (err) {
    fail("reading the remote description", c, err);
    return close(c, FINGERPRINT_MISMATCH);
  }
  if (fp !== normalizeFingerprint(cmd.fingerprint) || (c.pinned && c.pinned !== fp)) return close(c, FINGERPRINT_MISMATCH);
  c.pinned = fp;
  await c.pc.setRemoteDescription(cmd.description);
  for (const cand of c.candidates.splice(0)) await c.pc.addIceCandidate(cand).catch((err) => fail("adding a queued candidate", c, err));
  if (cmd.description.type === "offer") {
    await c.pc.setLocalDescription(await c.pc.createAnswer());
    if (!c.closed) emit({ ev: "local-description", peer: c.peer, epoch: c.epoch, description: { type: "answer", sdp: c.pc.localDescription!.sdp } });
  }
}

async function handle(cmd: HostCommand): Promise<void> {
  switch (cmd.op) {
    case "open":
      return open(cmd);
    case "remote":
      return remote(cmd).catch((err) => {
        const c = conns.get(cmd.peer);
        fail(`applying the ${cmd.description.type}`, c ?? null, err);
        if (c && c.epoch === cmd.epoch) close(c, `couldn't apply the ${cmd.description.type}`);
      });
    case "candidate": {
      const c = conns.get(cmd.peer);
      if (!c || c.epoch !== cmd.epoch || c.closed) return;
      if (!c.pc.remoteDescription) c.candidates.push(cmd.candidate);
      else await c.pc.addIceCandidate(cmd.candidate).catch((err) => fail("adding a candidate", c, err));
      return;
    }
    case "restart-ice": {
      const c = conns.get(cmd.peer);
      if (!c || c.epoch !== cmd.epoch || c.closed) return;
      try {
        await c.pc.setLocalDescription(await c.pc.createOffer({ iceRestart: true }));
        emit({ ev: "local-description", peer: c.peer, epoch: c.epoch, description: { type: "offer", sdp: c.pc.localDescription!.sdp } });
      } catch (err) {
        fail("restarting ICE", c, err);
        close(c, "couldn't restart ICE");
      }
      return;
    }
    case "close": {
      const c = conns.get(cmd.peer);
      if (c) close(c, cmd.reason);
      return;
    }
    case "send": {
      const c = conns.get(cmd.peer);
      if (!c || c.closed) return;
      c.queue.push(cmd.data);
      if (c.verified) pump(c);
      return;
    }
    case "stream": {
      const c = conns.get(cmd.peer);
      if (!c || c.closed || !c.verified || c.stream.readyState !== "open") return;
      if (c.stream.bufferedAmount > STREAM_HIGH_WATER) {
        c.dropped++;
        if (!c.congested) {
          c.congested = true;
          emit({ ev: "congestion", peer: c.peer, congested: true, dropped: c.dropped });
        }
        return;
      }
      try {
        c.stream.send(cmd.data);
      } catch (err) {
        c.dropped++;
        fail("sending on the stream channel", c, err);
      }
      return;
    }
    case "ice-servers":
      for (const c of conns.values()) {
        try {
          c.pc.setConfiguration({ ...c.pc.getConfiguration(), iceServers: cmd.iceServers as RTCIceServer[] });
        } catch (err) {
          fail("updating ICE servers", c, err);
        }
      }
      return;
  }
}

window.peerHost.onCommand((cmd) => {
  handle(cmd).catch((err) => fail(`handling ${cmd.op}`, conns.get((cmd as { peer?: string }).peer ?? "") ?? null, err));
});
const networkChanged = () => emit({ ev: "network-changed" });
window.addEventListener("online", networkChanged);
(navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener("change", networkChanged);
emit({ ev: "ready" });
