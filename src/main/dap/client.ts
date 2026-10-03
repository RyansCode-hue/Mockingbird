import { EventEmitter } from "events";
import * as net from "net";
import type { Readable, Writable } from "stream";

/**
 * A Debug Adapter Protocol connection: Content-Length framed JSON over a pair
 * of streams (an adapter's stdio, or a TCP socket). Requests resolve with
 * their response body or reject with the adapter's message; events are
 * emitted as "event"; requests the adapter sends us (startDebugging,
 * runInTerminal) go to the reverse-request handler.
 */

export interface DapMessage {
  seq: number;
  type: "request" | "response" | "event";
  command?: string;
  event?: string;
  arguments?: any;
  body?: any;
  request_seq?: number;
  success?: boolean;
  message?: string;
}

/** Splits a byte stream into DAP messages. */
export class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): DapMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: DapMessage[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) throw new Error(`DAP: a message header without Content-Length: ${header.slice(0, 100)}`);
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      out.push(JSON.parse(body));
    }
    return out;
  }
}

export function frame(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export type ReverseHandler = (command: string, args: any) => Promise<any>;

export class DapConnection extends EventEmitter {
  private seq = 1;
  private pending = new Map<number, { resolve: (b: any) => void; reject: (e: Error) => void; command: string; timer: NodeJS.Timeout }>();
  private parser = new FrameParser();
  private closed = false;
  reverse: ReverseHandler = async (command) => {
    throw new Error(`Mockingbird doesn't support the "${command}" request`);
  };

  constructor(private input: Readable, private output: Writable, private onClose?: () => void) {
    super();
    input.on("data", (chunk: Buffer) => {
      let msgs: DapMessage[];
      try {
        msgs = this.parser.push(chunk);
      } catch (err) {
        this.emit("error", err);
        return;
      }
      for (const m of msgs) this.dispatch(m);
    });
    const end = () => this.close("The debug adapter closed the connection");
    input.on("end", end);
    input.on("close", end);
    input.on("error", (err) => this.close(`The debug adapter's connection failed: ${err.message}`));
  }

  private dispatch(m: DapMessage) {
    if (m.type === "response") {
      const p = this.pending.get(m.request_seq!);
      if (!p) return;
      this.pending.delete(m.request_seq!);
      clearTimeout(p.timer);
      if (m.success) p.resolve(m.body ?? {});
      else p.reject(new Error(m.message || `${p.command} failed`));
    } else if (m.type === "event") {
      this.emit("event", m.event, m.body ?? {});
    } else if (m.type === "request") {
      this.reverse(m.command!, m.arguments ?? {}).then(
        (body) => this.send({ type: "response", request_seq: m.seq, command: m.command, success: true, body }),
        (err: Error) => this.send({ type: "response", request_seq: m.seq, command: m.command, success: false, message: err.message })
      );
    }
  }

  private send(msg: Omit<DapMessage, "seq">) {
    if (this.closed) return;
    this.output.write(frame({ seq: this.seq++, ...msg }));
  }

  request<T = any>(command: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The debug session has ended"));
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`The debug adapter didn't answer "${command}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, command, timer });
      this.output.write(frame({ seq, type: "request", command, ...(args === undefined ? {} : { arguments: args }) }));
    });
  }

  close(why = "The debug session has ended"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    this.emit("closed", why);
    this.onClose?.();
  }

  get isClosed() {
    return this.closed;
  }
}

/** Connect to an adapter listening on TCP, retrying while it starts up. */
export async function connectTcp(port: number, host = "127.0.0.1", timeoutMs = 15_000): Promise<DapConnection> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host, port }, () => resolve(s));
        s.once("error", reject);
      });
      return new DapConnection(sock, sock, () => sock.destroy());
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`Couldn't reach the debug adapter on ${host}:${port}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
