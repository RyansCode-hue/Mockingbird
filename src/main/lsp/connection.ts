import { EventEmitter } from "events";
import type { Readable, Writable } from "stream";
import { FrameParser, frame } from "../dap/client";

/** A request the server sends the client (workspace/configuration and the like). */
export type ServerRequestHandler = (method: string, params: any) => Promise<any>;

const METHOD_NOT_FOUND = -32601;

/**
 * A Language Server Protocol connection: JSON-RPC 2.0 in Content-Length
 * frames over a server's stdio. Requests resolve with their result or reject
 * with the server's error; notifications are emitted as "notification"
 * (method, params); "close" fires once, with why.
 */
export class LspConnection extends EventEmitter {
  private id = 1;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout }>();
  private parser = new FrameParser();
  private closed: string | null = null;
  onRequest: ServerRequestHandler = async (method) => {
    throw Object.assign(new Error(`Mockingbird doesn't handle ${method}`), { code: METHOD_NOT_FOUND });
  };

  constructor(input: Readable, private output: Writable, private onClose?: () => void) {
    super();
    input.on("data", (chunk: Buffer) => {
      let msgs: any[];
      try {
        msgs = this.parser.push(chunk);
      } catch (err) {
        this.close(`The language server sent something unreadable: ${(err as Error).message}`);
        return;
      }
      for (const m of msgs) this.dispatch(m);
    });
    output.on("error", (err) => this.close(`Couldn't write to the language server: ${err.message}`));
  }

  private dispatch(m: any): void {
    if (m.id !== undefined && m.method) {
      // a request from the server
      this.onRequest(m.method, m.params).then(
        (result) => this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null }),
        (err) => this.send({ jsonrpc: "2.0", id: m.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } })
      );
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? "failed"}`));
      else p.resolve(m.result);
    } else if (m.method) {
      this.emit("notification", m.method, m.params);
    }
  }

  private send(msg: object): void {
    if (this.closed) return;
    this.output.write(frame(msg));
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.id++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // tell the server to stop working on it
        this.notify("$/cancelRequest", { id });
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(reason = "The language server stopped"): void {
    if (this.closed) return;
    this.closed = reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.onClose?.();
    this.emit("close", reason);
  }
}
