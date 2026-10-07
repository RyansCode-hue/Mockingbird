import * as crypto from "crypto";
import type * as http from "http";
import type { Duplex } from "stream";

/**
 * The server side of RFC 6455, as far as the local signaling server needs it:
 * text and binary messages (fragmented or not), ping/pong and close; no
 * extensions. For tests and two dev instances on one Mac only — the app never
 * runs a server, and the deployed signaling is the Cloudflare Worker.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Drop the TCP connection without a close handshake (a laptop going to sleep). */
  terminate(): void;
  onMessage(cb: (data: string | Buffer) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  readonly open: boolean;
}

/** Complete a WebSocket upgrade, or answer 400 and return null. */
export function acceptWebSocket(req: http.IncomingMessage, socket: Duplex, head: Buffer, maxMessage = 1 << 20): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (String(req.headers.upgrade).toLowerCase() !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let buf: Buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] | null = null;
  let fragOpcode = 0;
  let fragSize = 0;
  let open = true;
  let closed = false;
  let onMessage: (data: string | Buffer) => void = () => undefined;
  let onClose: (code: number, reason: string) => void = () => undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const frame = (opcode: number, payload: Buffer) => {
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = len;
    else if (len < 65536) {
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    socket.write(Buffer.concat([header, payload]));
  };

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    open = false;
    onClose(code, reason);
  };

  const close = (code = 1000, reason = "") => {
    if (!open) return;
    open = false;
    const r = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    frame(0x8, payload);
    socket.end();
    setTimeout(() => socket.destroy(), 2000).unref();
    finish(code, reason);
  };

  const deliver = (opcode: number, payload: Buffer) => {
    if (opcode === 0x2) return onMessage(payload);
    let text: string;
    try {
      text = decoder.decode(payload);
    } catch {
      return close(1007, "invalid UTF-8");
    }
    onMessage(text);
  };

  const handle = (fin: boolean, opcode: number, payload: Buffer) => {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return close(1002, "bad control frame");
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (open) {
          open = false;
          frame(0x8, payload.subarray(0, 2));
          socket.end();
        }
        return finish(code, reason);
      }
      if (opcode === 0x9) return frame(0xa, payload);
      if (opcode === 0xa) return;
      return close(1002, "unknown control frame");
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fragments) return close(1002, "new message inside a fragmented one");
      if (fin) return deliver(opcode, payload);
      fragments = [payload];
      fragOpcode = opcode;
      fragSize = payload.length;
      return;
    }
    if (opcode === 0x0) {
      if (!fragments) return close(1002, "continuation without a message");
      fragSize += payload.length;
      if (fragSize > maxMessage) return close(1009, "message too big");
      fragments.push(payload);
      if (fin) {
        const whole = Buffer.concat(fragments);
        fragments = null;
        deliver(fragOpcode, whole);
      }
      return;
    }
    close(1002, "unknown opcode");
  };

  const parse = () => {
    while (open && buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      if (buf[0] & 0x70) return close(1002, "reserved bits set");
      const opcode = buf[0] & 0x0f;
      if (!(buf[1] & 0x80)) return close(1002, "client frames must be masked");
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return close(1009, "message too big");
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (len > maxMessage) return close(1009, "message too big");
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      handle(fin, opcode, payload);
    }
  };

  socket.on("data", (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    parse();
  });
  socket.on("close", () => finish(1006, "connection lost"));
  socket.on("error", (err) => {
    console.error(`[local signaling] socket error: ${err.message}`);
    finish(1006, err.message);
  });
  queueMicrotask(parse); // bytes that arrived with the upgrade

  return {
    send: (text) => {
      if (open) frame(0x1, Buffer.from(text, "utf8"));
    },
    close,
    terminate: () => {
      open = false;
      socket.destroy();
      finish(1006, "terminated");
    },
    onMessage: (cb) => (onMessage = cb),
    onClose: (cb) => (onClose = cb),
    get open() {
      return open;
    },
  };
}
