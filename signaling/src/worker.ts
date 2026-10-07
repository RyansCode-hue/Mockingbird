import { DurableObject } from "cloudflare:workers";
import { SignalingRoom, type ConnState, type RoomSocket } from "./room";
import { ROOM_ID_RE, SIGNALING_PING, SIGNALING_PONG, SIGNALING_PROTOCOL } from "../../src/shared/team/protocol";

/**
 * Mockingbird's signaling Worker: one Durable Object per room introduces its
 * members to each other (see room.ts for what it does and doesn't see).
 * WebSockets use the hibernation API, so idle rooms cost nothing; the
 * keep-alive ping is answered without waking the room.
 *
 *   GET /             health: { service, protocol }
 *   GET /rooms/<id>   WebSocket upgrade into the room
 */

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** Cloudflare Realtime TURN key, set with `npx wrangler secret put TURN_KEY_ID`. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ service: "mockingbird-signaling", protocol: SIGNALING_PROTOCOL, relay: !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) });
    }
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
    this.room ??= new SignalingRoom({
      roomId,
      storage: { get: (k) => this.ctx.storage.get(k), put: (k, v) => this.ctx.storage.put(k, v) },
      sockets: () => this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.roomId === roomId).map((ws) => this.socket(ws)),
      turn: this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN ? { keyId: this.env.TURN_KEY_ID, apiToken: this.env.TURN_KEY_API_TOKEN } : null,
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
