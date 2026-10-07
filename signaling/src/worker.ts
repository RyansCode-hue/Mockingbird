import { DurableObject } from "cloudflare:workers";
import { DailyCounter, SignalingRoom, type ConnState, type QuotaAnswer, type RoomSocket } from "./room";
import { healthBody, workerConfig, type WorkerConfigEnv } from "./config";
import { ROOM_ID_RE, SIGNALING_PING, SIGNALING_PONG } from "../../src/shared/team/protocol";

/**
 * Mockingbird's signaling Worker: one Durable Object per room introduces its
 * members to each other (see room.ts for what it does and doesn't see).
 * WebSockets use the hibernation API, so idle rooms cost nothing; the
 * keep-alive ping is answered without waking the room. One more Durable
 * Object keeps the daily TURN budget for every room.
 *
 *   GET /             health: { service, protocol, relay, creators }
 *   GET /rooms/<id>   WebSocket upgrade into the room
 */

export interface Env extends WorkerConfigEnv {
  ROOMS: DurableObjectNamespace;
  TURN_QUOTA: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return Response.json(healthBody(env));
    const m = /^\/rooms\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!m || !ROOM_ID_RE.test(m[1])) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
};

interface Attachment extends ConnState {
  roomId: string;
}

export class SignalingRoomObject extends DurableObject<Env> {
  private room: SignalingRoom | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(SIGNALING_PING, SIGNALING_PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const roomId = /\/rooms\/([A-Za-z0-9_-]+)$/.exec(new URL(request.url).pathname)?.[1];
    if (!roomId || !ROOM_ID_RE.test(roomId)) return new Response("not found", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ roomId, cid: crypto.randomUUID() });
    this.roomFor(roomId).open(this.socket(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a?.roomId) return ws.close(1011, "lost connection state");
    await this.roomFor(a.roomId).message(this.socket(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a?.roomId) this.roomFor(a.roomId).close(this.socket(ws));
    try {
      ws.close(code, reason);
    } catch (err) {
      console.log(`signaling socket was already closed (${code}): ${(err as Error).message}`);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("signaling socket error", error);
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a?.roomId) this.roomFor(a.roomId).close(this.socket(ws));
  }

  private roomFor(roomId: string): SignalingRoom {
    if (this.room) return this.room;
    const config = workerConfig(this.env);
    if (config.invalidCreators.length) console.error(`ALLOWED_CREATORS has entries that aren't fingerprints (ignored): ${config.invalidCreators.length}`);
    const quota = this.env.TURN_QUOTA;
    this.room = new SignalingRoom({
      roomId,
      storage: { get: (k) => this.ctx.storage.get(k), put: (k, v) => this.ctx.storage.put(k, v) },
      sockets: () => this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.roomId === roomId).map((ws) => this.socket(ws)),
      turn: config.turn,
      allowedCreators: config.allowedCreators,
      turnQuota: {
        take: async () => {
          const res = await quota.get(quota.idFromName("global")).fetch(new Request("https://turn-quota/take", { method: "POST" }));
          if (!res.ok) throw new Error(`the budget answered ${res.status}`);
          return (await res.json()) as QuotaAnswer;
        },
      },
      log: (m) => console.log(m),
    });
    return this.room;
  }

  private socket(ws: WebSocket): RoomSocket {
    const a = ws.deserializeAttachment() as Attachment | null;
    return {
      cid: a?.cid ?? "",
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
      state: () => {
        const s = ws.deserializeAttachment() as Attachment | null;
        return s && "nonce" in s ? s : null;
      },
      save: (s) => ws.serializeAttachment({ ...s, roomId: a?.roomId ?? "" }),
    };
  }
}

/** The daily TURN budget shared by every room (one instance, named "global"). */
export class TurnQuotaObject extends DurableObject<Env> {
  private counter: DailyCounter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.counter = new DailyCounter({ get: (k) => this.ctx.storage.get(k), put: (k, v) => this.ctx.storage.put(k, v) }, workerConfig(env).turnDailyLimit, (m) => console.log(m));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/take") return new Response("not found", { status: 404 });
    return Response.json(await this.counter.take(Date.now()));
  }
}
