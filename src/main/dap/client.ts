import * as net from "net";
import type { Readable, Writable } from "stream";
import { RpcConnection } from "../rpc";

/**
 * A Debug Adapter Protocol connection: Content-Length framed JSON over a pair
 * of streams (an adapter's stdio, or a TCP socket). Requests resolve with
 * their response body or reject with the adapter's message; events are
 * emitted as "event"; requests the adapter sends us (startDebugging,
 * runInTerminal) go to the reverse-request handler.
 */

interface DapMessage {
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

export class DapConnection extends RpcConnection {
  reverse: (command: string, args: any) => Promise<any> = async (command) => {
    throw new Error(`Mockingbird doesn't support the "${command}" request`);
  };

  /** `closeOnEnd` is false for an adapter's stdio, whose process exit closes the connection instead. */
  constructor(input: Readable, output: Writable, opts: { onClose?: () => void; closeOnEnd?: boolean } = {}) {
    super(input, output, { peer: "the debug adapter", closeOnEnd: opts.closeOnEnd ?? true, onClose: opts.onClose });
  }

  protected dispatch(m: DapMessage) {
    if (m.type === "response") {
      const p = this.take(m.request_seq!);
      if (!p) return;
      if (m.success) p.resolve(m.body ?? {});
      else p.reject(new Error(m.message || `${p.label} failed`));
    } else if (m.type === "event") {
      this.emit("event", m.event, m.body ?? {});
    } else if (m.type === "request") {
      this.reverse(m.command!, m.arguments ?? {}).then(
        (body) => this.reply({ type: "response", request_seq: m.seq, command: m.command, success: true, body }),
        (err: Error) => this.reply({ type: "response", request_seq: m.seq, command: m.command, success: false, message: err.message })
      );
    }
  }

  private reply(msg: Omit<DapMessage, "seq">) {
    this.send({ seq: this.seq(), ...msg });
  }

  request<T = any>(command: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    return this.call<T>(
      command,
      (seq) => ({ seq, type: "request", command, ...(args === undefined ? {} : { arguments: args }) }),
      timeoutMs,
      () => new Error(`The debug adapter didn't answer "${command}" within ${Math.round(timeoutMs / 1000)}s`)
    );
  }

  close(why = "The debug session has ended"): void {
    super.close(why);
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
      return new DapConnection(sock, sock, { onClose: () => sock.destroy() });
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`Couldn't reach the debug adapter on ${host}:${port}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/** Connects to an adapter already listening on TCP (debugpy --listen, a subprocess debugpy announced). */
export const tcpConnector = (port: number, host = "127.0.0.1", timeoutMs?: number) => async () => {
  const conn = await connectTcp(port, host, timeoutMs);
  return { conn, dispose: () => conn.close() };
};
