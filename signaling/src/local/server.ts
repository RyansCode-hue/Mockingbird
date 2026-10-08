import * as crypto from "crypto";
import * as http from "http";
import { acceptWebSocket, type WsConnection } from "./wsServer";
import { DailyCounter, DEFAULT_TURN_DAILY_LIMIT, SignalingRoom, type ConnState, type RoomLimits, type TurnConfig } from "../room";
import { ROOM_ID_RE, SIGNALING_FEATURES, SIGNALING_PING, SIGNALING_PONG, SIGNALING_PROTOCOL, type IceServer, type ServerMessage, type SignalingFeature, type SignalingHealth, type SignedEnvelope } from "../../../src/shared/team/protocol";

/**
 * The signaling Worker's room logic served from Node, for tests and for two
 * Mockingbird dev instances on one Mac (`npm run team:signaling`). Same URLs
 * and messages as the Worker; rooms live in memory.
 *
 * `tamper` sees every relayed envelope and may change or drop it: tests use
 * it to play a compromised signaling server.
 */

export type Tamper = (roomId: string, env: SignedEnvelope) => SignedEnvelope | null;

export interface LocalSignalingOptions {
  port?: number;
  host?: string;
  /** STUN handed out (default none: tests stay on loopback). */
  stun?: IceServer[];
  turn?: TurnConfig | null;
  /** Who may create rooms. Default "any": this server is for tests and dev instances on one Mac. */
  allowedCreators?: readonly string[] | "any";
  turnDailyLimit?: number;
  fetch?: typeof fetch;
  limits?: Partial<RoomLimits>;
  tamper?: Tamper | null;
  log?: (msg: string) => void;
  /** SIGNALING_FEATURES served (default all; [] plays a Worker deployed before any). */
  features?: readonly SignalingFeature[];
}

export interface LocalSignaling {
  /** Base URL, as Settings → Team would hold it (http://127.0.0.1:<port>). */
  url: string;
  port: number;
  setTamper(t: Tamper | null): void;
  /** Cut every connection without a close handshake, as a sleeping laptop does. */
  dropAll(): void;
  /** Connected member ids per room. */
  online(roomId: string): string[];
  room(roomId: string): SignalingRoom | undefined;
  close(): Promise<void>;
}

interface Conn {
  ws: WsConnection;
  state: ConnState | null;
}

export async function startLocalSignaling(opts: LocalSignalingOptions = {}): Promise<LocalSignaling> {
  const log = opts.log ?? ((m: string) => console.log(`[local signaling] ${m}`));
  let tamper = opts.tamper ?? null;
  const rooms = new Map<string, { room: SignalingRoom; conns: Map<string, Conn> }>();
  const allowedCreators = opts.allowedCreators ?? "any";
  const quotaStore = new Map<string, unknown>();
  const turnQuota = new DailyCounter({ get: async (k) => structuredClone(quotaStore.get(k)) as any, put: async (k, v) => void quotaStore.set(k, structuredClone(v)) }, opts.turnDailyLimit ?? DEFAULT_TURN_DAILY_LIMIT, log);
  const sockets = new Set<WsConnection>();

  const roomFor = (roomId: string) => {
    let r = rooms.get(roomId);
    if (!r) {
      const conns = new Map<string, Conn>();
      const store = new Map<string, unknown>();
      const room = new SignalingRoom({
        roomId,
        storage: { get: async (k) => structuredClone(store.get(k)) as any, put: async (k, v) => void store.set(k, structuredClone(v)) },
        sockets: () => [...conns.entries()].filter(([, c]) => c.ws.open).map(([cid]) => socketFor(roomId, cid, conns)),
        stun: opts.stun ?? [],
        turn: opts.turn ?? null,
        allowedCreators,
        turnQuota,
        fetch: opts.fetch,
        limits: opts.limits,
        features: opts.features,
        log,
      });
      r = { room, conns };
      rooms.set(roomId, r);
    }
    return r;
  };

  const socketFor = (roomId: string, cid: string, conns: Map<string, Conn>) => ({
    cid,
    send: (text: string) => {
      const c = conns.get(cid);
      if (!c) return;
      if (tamper && text.startsWith('{"t":"signal"')) {
        const msg = JSON.parse(text) as Extract<ServerMessage, { t: "signal" }>;
        const env = tamper(roomId, msg.env);
        if (!env) return;
        text = JSON.stringify({ ...msg, env });
      }
      c.ws.send(text);
    },
    close: (code: number, reason: string) => conns.get(cid)?.ws.close(code, reason),
    state: () => conns.get(cid)?.state ?? null,
    save: (s: ConnState) => {
      const c = conns.get(cid);
      if (c) c.state = structuredClone(s);
    },
  });

  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/" || path === "/health") {
      const health: SignalingHealth = { service: "mockingbird-signaling", protocol: SIGNALING_PROTOCOL, relay: !!opts.turn, creators: allowedCreators === "any" ? "any" : allowedCreators.length, local: true, features: [...(opts.features ?? SIGNALING_FEATURES)] };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(health));
      return;
    }
    res.writeHead(path.startsWith("/rooms/") ? 426 : 404).end(path.startsWith("/rooms/") ? "expected a WebSocket upgrade" : "not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const m = /^\/rooms\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url ?? "/", "http://localhost").pathname);
    if (!m || !ROOM_ID_RE.test(m[1])) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    sockets.add(ws);
    const roomId = m[1];
    const r = roomFor(roomId);
    const cid = crypto.randomUUID();
    r.conns.set(cid, { ws, state: null });
    const sock = socketFor(roomId, cid, r.conns);
    ws.onMessage((data) => {
      if (data === SIGNALING_PING) return ws.send(SIGNALING_PONG); // as the Worker's auto-response does
      r.room.message(sock, typeof data === "string" ? data : new Uint8Array(data)).catch((err) => log(`room ${roomId}: handling a message failed: ${(err as Error).stack ?? err}`));
    });
    ws.onClose(() => {
      sockets.delete(ws);
      r.room.close(sock);
      r.conns.delete(cid);
    });
    r.room.open(sock);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    setTamper: (t) => (tamper = t),
    dropAll: () => {
      for (const ws of [...sockets]) ws.terminate();
    },
    online: (roomId) => [...(rooms.get(roomId)?.conns.values() ?? [])].filter((c) => c.ws.open && c.state?.member).map((c) => c.state!.member!.id),
    room: (roomId) => rooms.get(roomId)?.room,
    close: async () => {
      for (const ws of [...sockets]) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
