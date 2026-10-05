import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { RUN_DIR } from "../runProfile";
import { connectTcp, type DapConnection } from "./client";
import type { DebugFrame, DebugScope, DebugSessionInfo, DebugVariable } from "../../shared/types";

export interface Connection {
  conn: DapConnection;
  dispose(): void;
  /** The adapter's own error output, for when it fails to start. */
  stderr?: () => string;
}

export interface LaunchOptions {
  worktree: string;
  repo: string;
  service: string;
  name: string;
  adapterID: string;
  /** A new connection to the adapter: the first for this session, and again for each child session it starts. */
  connect: () => Promise<Connection>;
  /** The launch or attach configuration, `request` included. */
  config: Record<string, unknown> & { request: "launch" | "attach" };
  /** Run the debuggee in a terminal (the adapter's runInTerminal request); returns its pid. */
  runInTerminal?: (args: { cwd: string; args: string[]; env?: Record<string, string | null>; title?: string }) => Promise<number | undefined>;
  parentId?: string;
  /** The program's output, when the debugger runs it itself (no terminal): child sessions report here too. */
  onOutput?: (category: string, text: string) => void;
  /** The top session ended, with the program's exit code when the adapter reported one. */
  onEnded?: (exitCode: number | null) => void;
}

interface Live {
  info: DebugSessionInfo;
  conn: DapConnection;
  opts: LaunchOptions;
  dispose(): void;
  exceptionFilters: string[];
  exitCode: number | null;
}

const short = () => crypto.randomBytes(4).toString("hex");

/**
 * Debug sessions over the Debug Adapter Protocol. Breakpoints belong to the
 * repository (relative paths), so they apply in whichever worktree is being
 * debugged, and are kept between runs. An adapter can start child sessions
 * (js-debug's browser targets, debugpy's subprocesses); they're tracked under
 * their parent and stopped with it.
 */
export class DebugManager {
  private live = new Map<string, Live>();

  constructor(private deps: { emit: (channel: string, ...args: unknown[]) => void; breakpointsDir?: string }) {}

  private get bpDir() {
    return this.deps.breakpointsDir ?? path.join(RUN_DIR, "breakpoints");
  }

  private bpFile(repo: string) {
    const hash = crypto.createHash("sha1").update(repo).digest("hex").slice(0, 8);
    return path.join(this.bpDir, `${path.basename(repo).replace(/[^\w.-]/g, "_")}-${hash}.json`);
  }

  /** A repo's breakpoints: relative path → line numbers. */
  breakpoints(repo: string): Record<string, number[]> {
    try {
      return JSON.parse(fs.readFileSync(this.bpFile(repo), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  /**
   * Set a file's breakpoints for a repo, save them, and send them to every
   * live session of that repo. Returns each line's verification from the
   * first session that answered (unverified lines are where code can't stop).
   */
  async setBreakpoints(repo: string, rel: string, lines: number[]): Promise<{ line: number; verified: boolean; message?: string }[]> {
    if (path.isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`Not a path inside the repository: ${rel}`);
    const all = this.breakpoints(repo);
    const sorted = [...new Set(lines.filter((l) => Number.isInteger(l) && l > 0))].sort((a, b) => a - b);
    if (sorted.length) all[rel] = sorted;
    else delete all[rel];
    fs.mkdirSync(this.bpDir, { recursive: true });
    fs.writeFileSync(this.bpFile(repo), JSON.stringify(all, null, 2));
    let result: { line: number; verified: boolean; message?: string }[] = sorted.map((line) => ({ line, verified: false }));
    let answered = false;
    for (const l of this.live.values()) {
      if (l.info.repo !== repo || l.info.state === "ended") continue;
      const r = await this.sendFile(l, rel, sorted).catch(() => null);
      if (r && !answered) {
        result = r;
        answered = true;
      }
    }
    return result;
  }

  private async sendFile(l: Live, rel: string, lines: number[]) {
    const body = await l.conn.request("setBreakpoints", { source: { path: path.join(l.info.worktree, rel), name: path.basename(rel) }, breakpoints: lines.map((line) => ({ line })), lines });
    return (body.breakpoints ?? []).map((b: any, i: number) => ({ line: b.line ?? lines[i], verified: !!b.verified, ...(b.message ? { message: b.message } : {}) }));
  }

  infos(): DebugSessionInfo[] {
    return [...this.live.values()].map((l) => ({ ...l.info, threads: [...l.info.threads] }));
  }

  private changed() {
    this.deps.emit("debug:changed", this.infos());
  }

  private output(id: string, category: string, text: string) {
    this.deps.emit("debug:output", id, category, text);
  }

  private get(id: string): Live {
    const l = this.live.get(id);
    if (!l || l.info.state === "ended") throw new Error("That debug session has ended");
    return l;
  }

  /** Start a debug session: initialize, launch or attach, breakpoints, configurationDone. */
  async launch(opts: LaunchOptions): Promise<string> {
    const id = `dbg-${short()}`;
    const info: DebugSessionInfo = {
      id,
      parentId: opts.parentId ?? null,
      name: opts.name,
      worktree: opts.worktree,
      repo: opts.repo,
      service: opts.service,
      state: "starting",
      threads: [],
    };
    let c: Connection;
    try {
      c = await opts.connect();
    } catch (err) {
      throw new Error(`Couldn't start the debugger: ${(err as Error).message}`);
    }
    const l: Live = { info, conn: c.conn, opts, dispose: c.dispose, exceptionFilters: [], exitCode: null };
    this.live.set(id, l);
    this.wire(l);
    this.changed();
    try {
      await this.handshake(l);
    } catch (err) {
      const why = `${(err as Error).message}${c.stderr?.() ? `\n${c.stderr().trim().split("\n").slice(-5).join("\n")}` : ""}`;
      info.error = why;
      this.end(l);
      throw new Error(why);
    }
    return id;
  }

  private async handshake(l: Live) {
    const { conn, opts } = l;
    // listen before asking: some adapters (netcoredbg) send "initialized" in the same
    // breath as the initialize reply, before an await here would get to listen
    const initialized = new Promise<void>((resolve) => {
      const h = (event: string) => {
        if (event !== "initialized") return;
        conn.off("event", h);
        resolve();
      };
      conn.on("event", h);
    });
    const caps = await conn.request("initialize", {
      clientID: "mockingbird",
      clientName: "Mockingbird",
      adapterID: opts.adapterID,
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: !!opts.runInTerminal,
      supportsStartDebuggingRequest: true,
      supportsProgressReporting: false,
      supportsInvalidatedEvent: false,
      supportsMemoryReferences: false,
      locale: "en",
    });
    l.exceptionFilters = (caps.exceptionBreakpointFilters ?? []).filter((f: any) => f.default).map((f: any) => f.filter);
    // most adapters answer launch only after configurationDone, so it's awaited last
    const launched = conn.request(opts.config.request, opts.config, 180_000);
    launched.catch(() => {}); // reported below; a failure before "initialized" ends the wait
    await Promise.race([initialized, launched.then(() => initialized)]);
    for (const [rel, lines] of Object.entries(this.breakpoints(l.info.repo))) {
      await this.sendFile(l, rel, lines).catch((err) => this.output(l.info.id, "important", `Breakpoints in ${rel} weren't set: ${err.message}\n`));
    }
    if (caps.supportsExceptionInfoRequest !== undefined || caps.exceptionBreakpointFilters) {
      await conn.request("setExceptionBreakpoints", { filters: l.exceptionFilters }).catch(() => {});
    }
    if (caps.supportsConfigurationDoneRequest) await conn.request("configurationDone");
    await launched;
    if (l.info.state === "starting") l.info.state = "running";
    this.changed();
  }

  private wire(l: Live) {
    const { conn, info } = l;
    conn.reverse = async (command, args) => {
      if (command === "runInTerminal") {
        if (!l.opts.runInTerminal) throw new Error("runInTerminal isn't available for this session");
        const pid = await l.opts.runInTerminal({ cwd: args.cwd, args: args.args, env: args.env, title: args.title });
        return pid ? { processId: pid } : {};
      }
      if (command === "startDebugging") {
        // a child target (a browser page, a worker): its own session, on a new connection
        this.launch({
          ...l.opts,
          name: String(args.configuration?.name ?? `${info.name} (child)`),
          parentId: info.id,
          config: { ...args.configuration, request: args.request === "attach" ? "attach" : "launch" },
        }).catch((err) => this.output(info.id, "important", `A child session didn't start: ${err.message}\n`));
        return {};
      }
      throw new Error(`Mockingbird doesn't support the "${command}" request`);
    };
    conn.on("event", (event: string, body: any) => {
      switch (event) {
        case "stopped":
          info.state = "stopped";
          info.stopped = { threadId: body.threadId, reason: body.reason, ...(body.description ? { description: body.description } : {}), ...(body.text ? { text: body.text } : {}) };
          this.refreshThreads(l).then(() => this.reportStop(l));
          break;
        case "continued":
          if (body.allThreadsContinued !== false || body.threadId === info.stopped?.threadId) {
            info.state = "running";
            delete info.stopped;
            this.changed();
          }
          break;
        case "thread":
          this.refreshThreads(l);
          break;
        case "output":
          if (body.category !== "telemetry" && typeof body.output === "string") {
            this.output(info.id, body.category ?? "console", body.output);
            // the program's own output (not the debugger's notes) also goes to its service log
            if (body.category === "stdout" || body.category === "stderr") l.opts.onOutput?.(body.category, body.output);
          }
          break;
        case "debugpyAttach": {
          // debugpy following a subprocess (uvicorn --reload's worker): attach to it as a child session
          const target = body.connect ?? {};
          this.launch({
            ...l.opts,
            name: String(body.name ?? `${info.name} (subprocess)`),
            parentId: info.id,
            connect: async () => {
              const conn = await connectTcp(Number(target.port), String(target.host ?? "127.0.0.1"));
              return { conn, dispose: () => conn.close() };
            },
            config: { ...body, request: "attach" },
          }).catch((err) => this.output(info.id, "important", `The subprocess session didn't start: ${err.message}\n`));
          break;
        }
        case "terminated":
        case "exited":
          if (event === "exited" && typeof body.exitCode === "number") {
            l.exitCode = body.exitCode;
            this.output(info.id, "console", `Exited with code ${body.exitCode}\n`);
          }
          if (event === "terminated") this.end(l);
          break;
      }
    });
    conn.on("close", (why: string) => {
      if (info.state !== "ended") {
        if (info.state === "starting") info.error ??= why;
        this.end(l);
      }
    });
  }

  private async refreshThreads(l: Live) {
    try {
      const r = await l.conn.request("threads");
      l.info.threads = (r.threads ?? []).map((t: any) => ({ id: t.id, name: String(t.name) }));
    } catch {
      /* the session ended while asking */
    }
    this.changed();
  }

  private async reportStop(l: Live) {
    const threadId = l.info.stopped?.threadId ?? l.info.threads[0]?.id;
    let frame: DebugFrame | null = null;
    if (threadId !== undefined) {
      const frames = await this.stackTrace(l.info.id, threadId).catch(() => []);
      frame = frames.find((f) => f.path) ?? frames[0] ?? null;
    }
    this.deps.emit("debug:stopped", l.info.id, { threadId, frame });
  }

  private end(l: Live) {
    if (l.info.state === "ended") return;
    l.info.state = "ended";
    delete l.info.stopped;
    try {
      l.dispose();
    } catch {
      /* already closed */
    }
    // children end with their parent
    for (const c of this.live.values()) if (c.info.parentId === l.info.id) this.end(c);
    if (!l.info.parentId) l.opts.onEnded?.(l.exitCode);
    this.changed();
  }

  async control(id: string, op: "continue" | "next" | "stepIn" | "stepOut" | "pause", threadId?: number): Promise<void> {
    const l = this.get(id);
    const t = threadId ?? l.info.stopped?.threadId ?? l.info.threads[0]?.id;
    if (t === undefined) throw new Error("No thread to control yet");
    if (op !== "pause") {
      l.info.state = "running";
      delete l.info.stopped;
      this.changed();
    }
    await l.conn.request(op, { threadId: t });
  }

  async stackTrace(id: string, threadId: number): Promise<DebugFrame[]> {
    const r = await this.get(id).conn.request("stackTrace", { threadId, startFrame: 0, levels: 60 });
    return (r.stackFrames ?? []).map((f: any) => ({ id: f.id, name: String(f.name), path: f.source?.path ?? null, line: f.line ?? 0, column: f.column ?? 0 }));
  }

  async scopes(id: string, frameId: number): Promise<DebugScope[]> {
    const r = await this.get(id).conn.request("scopes", { frameId });
    return (r.scopes ?? []).map((s: any) => ({ name: String(s.name), ref: s.variablesReference, expensive: !!s.expensive }));
  }

  async variables(id: string, ref: number): Promise<DebugVariable[]> {
    const r = await this.get(id).conn.request("variables", { variablesReference: ref });
    return (r.variables ?? []).map((v: any) => ({ name: String(v.name), value: String(v.value), ...(v.type ? { type: String(v.type) } : {}), ref: v.variablesReference ?? 0 }));
  }

  async evaluate(id: string, expression: string, frameId: number | undefined, context: "repl" | "watch" | "hover"): Promise<{ result: string; ref: number; type?: string }> {
    const r = await this.get(id).conn.request("evaluate", { expression, ...(frameId !== undefined ? { frameId } : {}), context });
    return { result: String(r.result ?? ""), ref: r.variablesReference ?? 0, ...(r.type ? { type: String(r.type) } : {}) };
  }

  /** End a session (and its children), stopping what it launched. */
  async stop(id: string): Promise<void> {
    const l = this.live.get(id);
    if (!l || l.info.state === "ended") return;
    for (const c of [...this.live.values()]) if (c.info.parentId === id) await this.stop(c.info.id);
    await l.conn.request("disconnect", { terminateDebuggee: true, restart: false }, 8_000).catch(() => {});
    this.end(l);
  }

  /** End every session debugging this worktree's service. */
  async stopService(worktree: string, service: string): Promise<void> {
    for (const l of [...this.live.values()]) if (l.info.worktree === worktree && l.info.service === service && !l.info.parentId) await this.stop(l.info.id);
  }

  async stopAll(): Promise<void> {
    for (const l of [...this.live.values()]) if (!l.info.parentId) await this.stop(l.info.id);
  }

  /** Forget ended sessions. */
  prune(): void {
    for (const [id, l] of this.live) if (l.info.state === "ended") this.live.delete(id);
    this.changed();
  }
}
