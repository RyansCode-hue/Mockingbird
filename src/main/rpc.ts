import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import type { Readable, Writable } from "stream";

/**
 * The base protocol the Debug Adapter Protocol and the Language Server
 * Protocol share: JSON messages in Content-Length frames over a pair of
 * streams, requests matched to their replies, and one close that fails
 * whatever is still waiting.
 */

/**
 * Splits a byte stream into framed messages. A malformed frame stops it:
 * `failed` says why, and nothing after it is read.
 */
export class FrameParser {
  private buf = Buffer.alloc(0);
  failed: string | null = null;

  /** The messages this chunk completes, including those before a malformed frame. */
  push(chunk: Buffer): any[] {
    const out: any[] = [];
    if (this.failed) return out;
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) return this.fail(`a message header without Content-Length: ${header.slice(0, 100)}`, out);
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try {
        out.push(JSON.parse(body));
      } catch (err) {
        return this.fail(`a message that isn't JSON (${(err as Error).message})`, out);
      }
    }
    return out;
  }

  private fail(why: string, parsed: any[]): any[] {
    this.failed = why;
    this.buf = Buffer.alloc(0);
    return parsed;
  }
}

export function frame(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

interface Pending {
  label: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * A framed connection. Unreadable input, a failed read or write, and (with
 * `closeOnEnd`) the input ending all close it; "close" is emitted once, with
 * why, after every pending request has been failed with that reason.
 */
export abstract class RpcConnection extends EventEmitter {
  private nextSeq = 1;
  private pending = new Map<number, Pending>();
  private parser = new FrameParser();
  private closedWhy: string | null = null;

  /**
   * `peer` names the other side in messages ("the debug adapter"). A socket
   * closes on end; a process's stdio leaves that to the process's exit, which
   * says why (see spawnRpcProcess).
   */
  constructor(input: Readable, private output: Writable, private opts: { peer: string; closeOnEnd: boolean; onClose?: () => void }) {
    super();
    const Peer = capital(opts.peer);
    input.on("data", (chunk: Buffer) => {
      if (this.closedWhy) return;
      for (const m of this.parser.push(chunk)) this.dispatch(m);
      if (this.parser.failed) this.close(`${Peer} sent something unreadable: ${this.parser.failed}`);
    });
    input.on("error", (err) => this.close(`${Peer}'s connection failed: ${err.message}`));
    if (opts.closeOnEnd) {
      const end = () => this.close(`${Peer} closed the connection`);
      input.on("end", end);
      input.on("close", end);
    }
    output.on("error", (err) => this.close(`Couldn't write to ${opts.peer}: ${err.message}`));
  }

  protected abstract dispatch(m: any): void;

  protected seq(): number {
    return this.nextSeq++;
  }

  protected send(msg: object): void {
    if (this.closedWhy) return;
    this.output.write(frame(msg));
  }

  /** Send a request (built around its sequence number) and wait for its reply, which the subclass settles through take(). */
  protected call<T>(label: string, build: (seq: number) => object, timeoutMs: number, timedOut: (seq: number) => Error): Promise<T> {
    if (this.closedWhy) return Promise.reject(new Error(this.closedWhy));
    const seq = this.seq();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(timedOut(seq));
      }, timeoutMs);
      this.pending.set(seq, { label, resolve, reject, timer });
      this.send(build(seq));
    });
  }

  /** The request a reply answers, no longer waiting; undefined when none is (it timed out, or never was). */
  protected take(seq: number): Pending | undefined {
    const p = this.pending.get(seq);
    if (!p) return undefined;
    this.pending.delete(seq);
    clearTimeout(p.timer);
    return p;
  }

  close(why = `The connection to ${this.opts.peer} was closed`): void {
    if (this.closedWhy) return;
    this.closedWhy = why;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    this.opts.onClose?.();
    this.emit("close", why);
  }

  get isClosed(): boolean {
    return this.closedWhy !== null;
  }
}

/** The last `max` characters a process wrote to stderr, for error messages. */
export function stderrTail(proc: ChildProcess, max = 8000): () => string {
  let err = "";
  proc.stderr?.on("data", (d) => (err = (err + d).slice(-max)));
  return () => err;
}

export function killIfAlive(proc: ChildProcess): void {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill();
}

/**
 * End a process started in its own group and everything it started: a
 * process whose helpers outlive it (a language server's tsserver) would
 * otherwise keep running, and writing, after it's gone.
 */
export function endProcessGroup(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch (err) {
    // ESRCH: the group is already gone
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") killIfAlive(proc);
  }
}

/**
 * Start a process that speaks a framed protocol on its stdio. The connection
 * closes when the process fails to start or exits, saying why (with the last
 * line of its stderr when it didn't exit cleanly); closing the connection
 * kills the process. `name` is the process as a sentence's subject.
 */
export function spawnRpcProcess<C extends RpcConnection>(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; name: string; /** Its own process group, ended whole when the connection closes. */ group?: boolean },
  connect: (input: Readable, output: Writable, onClose: () => void) => C
): { conn: C; stderr: () => string } {
  const proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: !!opts.group });
  const stderr = stderrTail(proc);
  const conn = connect(proc.stdout!, proc.stdin!, () => (opts.group ? endProcessGroup(proc) : killIfAlive(proc)));
  proc.on("error", (e) => conn.close(`${opts.name} didn't start: ${e.message}`));
  proc.on("exit", (code, signal) => {
    const tail = code || signal ? stderr().trim().split("\n").pop() : "";
    conn.close(`${opts.name} exited${code ? ` with code ${code}` : signal ? ` (${signal})` : ""}${tail ? `: ${tail}` : ""}`);
  });
  // the exit says why it ended; output closed by a process that lives on still ends the connection
  proc.stdout!.on("end", () => setTimeout(() => conn.close(`${opts.name} closed its output`), 1000).unref());
  return { conn, stderr };
}
