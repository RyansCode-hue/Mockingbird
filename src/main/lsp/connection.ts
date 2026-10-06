import type { Readable, Writable } from "stream";
import { RpcConnection } from "../rpc";

/** A request the server sends the client (workspace/configuration and the like). */
type ServerRequestHandler = (method: string, params: any) => Promise<any>;

const METHOD_NOT_FOUND = -32601;

/**
 * A Language Server Protocol connection: JSON-RPC 2.0 in Content-Length
 * frames over a server's stdio. Requests resolve with their result or reject
 * with the server's error; notifications are emitted as "notification"
 * (method, params); "close" fires once, with why.
 */
export class LspConnection extends RpcConnection {
  onRequest: ServerRequestHandler = async (method) => {
    throw Object.assign(new Error(`Mockingbird doesn't handle ${method}`), { code: METHOD_NOT_FOUND });
  };

  /** Over a server's stdio: the server's exit closes the connection (see spawnRpcProcess). */
  constructor(input: Readable, output: Writable, onClose?: () => void) {
    super(input, output, { peer: "the language server", closeOnEnd: false, onClose });
  }

  protected dispatch(m: any): void {
    if (m.id !== undefined && m.method) {
      // a request from the server
      this.onRequest(m.method, m.params).then(
        (result) => this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null }),
        (err) => this.send({ jsonrpc: "2.0", id: m.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } })
      );
    } else if (m.id !== undefined) {
      const p = this.take(m.id);
      if (!p) return;
      if (m.error) p.reject(new Error(`${p.label}: ${m.error.message ?? "failed"}`));
      else p.resolve(m.result);
    } else if (m.method) {
      this.emit("notification", m.method, m.params);
    }
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    return this.call<T>(
      method,
      (id) => ({ jsonrpc: "2.0", id, method, params }),
      timeoutMs,
      (id) => {
        // tell the server to stop working on it
        this.notify("$/cancelRequest", { id });
        return new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
    );
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(reason = "The language server stopped"): void {
    super.close(reason);
  }
}
