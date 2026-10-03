import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { buildOverride, composeConfig, composeProject, writeOverride } from "./composeOverride";
import { DEFAULT_SIDE_BY_SIDE, expand, loadProfile, mainCheckout, parseEnvFile, slotPorts, startOrder } from "./runProfile";
import { copyPrepared, setupCommand } from "./runPrepare";
import type { DebugManager } from "./dap/session";
import type { debugTargetFor } from "./dap/targets";
import { quote } from "./shell";
import type { RunProfile, RunService, RunServiceState } from "../shared/types";

/** What a run needs from a terminal process — node-pty in the app, a fake in tests. */
export interface RunProc {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
}
export type Spawn = (command: string, opts: { cwd: string; env: Record<string, string> }) => RunProc;

/** Someone else listening on a port a service needs. */
export interface PortConflict {
  port: number;
  service: string;
  pid: number | null;
  command: string;
}

/** `ids`: the started services' run ids, in `started` order (for showing their logs). */
export type StartResult = { slot: number; started: string[]; ids: string[] } | { blocked: PortConflict[]; slot: number };

const BUFFER_MAX = 400_000;
const STOP_GRACE_MS = 5_000;
const READY_TIMEOUT_MS = 180_000;

/** Is anything accepting connections on this port (IPv4 or IPv6 loopback)? */
export function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  const one = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port });
      const done = (v: boolean) => {
        s.destroy();
        resolve(v);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  return Promise.all([one("127.0.0.1"), one("::1")]).then(([a, b]) => a || b);
}

/** Who's listening on a port, from lsof: [{pid, command}] (empty when nobody is). */
export function portListeners(port: number): Promise<{ pid: number; command: string }[]> {
  return new Promise((resolve, reject) =>
    execFile("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { timeout: 10_000 }, (err, stdout) => {
      // lsof exits 1 when nothing matches
      if (err && (err as any).code !== 1) return reject(new Error(`lsof: ${err.message}`));
      const out: { pid: number; command: string }[] = [];
      let pid = 0;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) pid = parseInt(line.slice(1), 10);
        else if (line.startsWith("c") && pid) out.push({ pid, command: line.slice(1) });
      }
      resolve(out);
    })
  );
}

interface Live {
  state: RunServiceState;
  proc: RunProc | null;
  buffer: string;
  exited: Promise<void>;
  stopRequested: boolean;
  /** For compose services: how to take the stack down after the foreground process ends. */
  down?: string;
  /** For a service the debugger runs itself: called when its session ends. */
  endVirtual?: (exitCode: number | null) => void;
}

const runId = (worktree: string, service: string) => crypto.createHash("sha1").update(`${worktree}\0${service}`).digest("hex").slice(0, 12);

/**
 * Runs a repository's services for a worktree, each on its own terminal so
 * colors and prompts behave. Swap mode runs a repo one worktree at a time on
 * its standard ports — starting one stops the other first. Side-by-side mode
 * gives each running worktree its own slot of ports. Stopping signals the
 * whole process group (dotnet, uvicorn --reload and Vite all fork), then
 * kills it if it lingers.
 */
export class RunManager {
  private live = new Map<string, Live>();
  /** The last port check's conflicts per worktree: the only processes the user may ask us to stop. */
  private offered = new Map<string, Set<number>>();

  constructor(
    private deps: {
      spawn: Spawn;
      emit: (channel: string, ...args: unknown[]) => void;
      baseEnv: () => Record<string, string>;
      docker: () => Promise<string>;
      runShell: (command: string, cwd: string, env: Record<string, string>) => Promise<{ code: number; out: string }>;
      inUse?: (port: number) => Promise<boolean>;
      listeners?: (port: number) => Promise<{ pid: number; command: string }[]>;
      kill?: (pid: number, signal: NodeJS.Signals) => void;
      profileFor?: (repo: string) => RunProfile | null;
      mainOf?: (worktree: string) => Promise<string>;
      readyTimeoutMs?: number;
      debugger?: DebugManager;
      debugTarget?: typeof debugTargetFor;
    }
  ) {}

  private get inUse() {
    return this.deps.inUse ?? portInUse;
  }
  private get kill() {
    return this.deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  }

  states(): RunServiceState[] {
    return [...this.live.values()].map((l) => ({ ...l.state }));
  }

  buffer(id: string): string {
    return this.live.get(id)?.buffer ?? "";
  }

  write(id: string, data: string): void {
    this.live.get(id)?.proc?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.live.get(id)?.proc?.resize(cols, rows);
    } catch {
      /* exited between the resize and now */
    }
  }

  private changed() {
    this.deps.emit("run:changed", this.states());
  }

  private running(worktree?: string, repo?: string): Live[] {
    return [...this.live.values()].filter(
      (l) => (l.state.status === "starting" || l.state.status === "running" || l.state.status === "stopping") && (!worktree || l.state.worktree === worktree) && (!repo || l.state.repo === repo)
    );
  }

  private async profile(worktree: string): Promise<{ repo: string; profile: RunProfile }> {
    const repo = await (this.deps.mainOf ?? mainCheckout)(worktree);
    const profile = (this.deps.profileFor ?? loadProfile)(repo);
    if (!profile) throw new Error(`There's no run setup for ${path.basename(repo)} yet — draft one in Run and Debug`);
    return { repo, profile };
  }

  /**
   * The slot this worktree runs in. A worktree already running keeps its slot;
   * swap mode is always slot 0; side by side takes the lowest slot no other
   * worktree of the repo is using.
   */
  private slotFor(repo: string, worktree: string, mode: "swap" | "side", profile: RunProfile): number {
    const mine = this.running(worktree, repo)[0];
    if (mine) return mine.state.slot;
    if (mode === "swap") return 0;
    const taken = new Set(this.running(undefined, repo).map((l) => l.state.slot));
    const slots = (profile.sideBySide ?? DEFAULT_SIDE_BY_SIDE).slots;
    for (let s = 0; s <= slots; s++) if (!taken.has(s)) return s;
    throw new Error(`All ${slots + 1} side-by-side slots of ${path.basename(repo)} are in use — stop one first`);
  }

  /** The services to start: those asked for plus what they depend on, dependencies first. */
  private plan(profile: RunProfile, names?: string[]): RunService[] {
    const ordered = startOrder(profile.services);
    if (!names?.length) return ordered;
    const want = new Set<string>();
    const add = (n: string) => {
      if (want.has(n)) return;
      const s = profile.services.find((x) => x.name === n);
      if (!s) throw new Error(`No service named "${n}"`);
      want.add(n);
      for (const d of s.dependsOn ?? []) add(d);
    };
    names.forEach(add);
    return ordered.filter((s) => want.has(s.name));
  }

  /**
   * Start a worktree's services. Ports another process holds are reported
   * (blocked) rather than taken; the user decides whether to stop that process.
   */
  async start(worktree: string, opts: { mode: "swap" | "side"; services?: string[]; debug?: string[] }): Promise<StartResult> {
    const { repo, profile } = await this.profile(worktree);
    const slot = this.slotFor(repo, worktree, opts.mode, profile);
    if (opts.mode === "swap") {
      // one copy of the app at a time: the other worktrees' runs make way
      const others = [...new Set(this.running(undefined, repo).filter((l) => l.state.worktree !== worktree).map((l) => l.state.worktree))];
      for (const w of others) await this.stop(w);
    }
    const ports = slotPorts(profile, slot);
    const todo = this.plan(profile, opts.services).filter((s) => !this.running(worktree).some((l) => l.state.service === s.name));

    const conflicts: PortConflict[] = [];
    for (const s of todo) {
      for (const p of s.ports ?? []) {
        const port = ports.get(p.name)!;
        if (!(await this.inUse(port))) continue;
        const who = await (this.deps.listeners ?? portListeners)(port);
        if (!who.length) conflicts.push({ port, service: s.name, pid: null, command: "unknown (not visible to lsof)" });
        for (const w of who) conflicts.push({ port, service: s.name, pid: w.pid, command: w.command });
      }
    }
    if (conflicts.length) {
      this.offered.set(worktree, new Set(conflicts.map((c) => c.pid).filter((p): p is number => p !== null)));
      return { blocked: conflicts, slot };
    }

    const started: string[] = [];
    const ids: string[] = [];
    for (const s of todo) {
      const l = opts.debug?.includes(s.name) ? await this.launchDebug(worktree, repo, profile, s, slot, ports) : await this.launch(worktree, repo, profile, s, slot, ports);
      started.push(s.name);
      ids.push(l.state.id);
      if (!(await this.whenReady(l, s, ports))) break; // it died: what depends on it isn't started
    }
    return { slot, started, ids };
  }

  /** Stop processes the last port check reported for this worktree — and only those. */
  stopListeners(worktree: string, pids: number[]): void {
    const allowed = this.offered.get(worktree) ?? new Set();
    for (const pid of pids) {
      if (!allowed.has(pid)) throw new Error(`Process ${pid} wasn't one reported as holding a port — not stopped`);
      try {
        this.kill(pid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
    this.offered.delete(worktree);
  }

  /** A service's working folder, environment (env files, then its own env) and placeholder context. */
  private serviceSetup(worktree: string, repo: string, s: RunService, slot: number, ports: Map<string, number>) {
    const ctx = { ports, slot, worktree };
    const cwd = path.join(worktree, s.cwd);
    const env: Record<string, string> = { ...this.deps.baseEnv(), MOCKINGBIRD_RUN: s.name, FORCE_COLOR: "1" };
    for (const f of s.envFiles ?? []) {
      const file = path.join(worktree, f);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        throw new Error(`${s.name}: env file ${f} is missing in this worktree — run Prepare to copy it from ${path.basename(repo)} (${(err as Error).message})`);
      }
      Object.assign(env, parseEnvFile(text));
    }
    for (const [k, v] of Object.entries(s.env ?? {})) env[k] = expand(v, ctx);
    return { ctx, cwd, env, command: expand(s.command, ctx) };
  }

  private async launch(worktree: string, repo: string, profile: RunProfile, s: RunService, slot: number, ports: Map<string, number>): Promise<Live> {
    const { ctx, cwd, env, command: plain } = this.serviceSetup(worktree, repo, s, slot, ports);
    let command = plain;
    let down: string | undefined;
    if (s.kind === "compose") {
      const docker = await this.deps.docker();
      const project = composeProject(repo, slot);
      const file = s.compose!.file;
      const cfg = await composeConfig(docker, { cwd, file, project, env });
      const mains = [...new Set([repo, fs.realpathSync(repo)])];
      const override = writeOverride(project, buildOverride(cfg, { main: mains, worktree, slot, step: (profile.sideBySide ?? DEFAULT_SIDE_BY_SIDE).step, project }));
      const base = `${quote(docker)} compose -p ${quote(project)} -f ${quote(file)} -f ${quote(override)}`;
      command = `${base} up --remove-orphans ${(s.compose!.services ?? []).map(quote).join(" ")}`.trim();
      down = `${base} down --remove-orphans`;
    }
    return this.spawnLive(worktree, repo, s, slot, ports, ctx, command, cwd, env, down);
  }

  /**
   * Run a service under the debugger. The adapter asks for the program to be
   * started in a terminal (runInTerminal), so it runs on its own terminal like
   * any service — same log tab, same stop — with the debugger attached.
   */
  private async launchDebug(worktree: string, repo: string, profile: RunProfile, s: RunService, slot: number, ports: Map<string, number>): Promise<Live> {
    if (!this.deps.debugger || !this.deps.debugTarget) throw new Error("Debugging isn't available");
    if (s.kind === "compose") throw new Error(`${s.name} is a Docker Compose service — debugging inside containers comes in a later stage`);
    const { ctx, cwd, env, command } = this.serviceSetup(worktree, repo, s, slot, ports);
    const first = (s.ports ?? []).find((p) => p.url) ?? s.ports?.[0];
    const url = first ? expand((first.url ?? "http://localhost:${port}").replace(/\$\{port\}/g, String(ports.get(first.name))), ctx) : undefined;
    const target = await this.deps.debugTarget(s, { cwd, env, command, url, expand: (x) => expand(x, ctx), onProgress: (m) => this.deps.emit("run:progress", worktree, m) });
    if (target.kind === "internal") {
      // the build runs on the service's terminal, visibly; then the debugger runs the program
      // itself, and its output is forwarded into the same log
      const b = this.spawnLive(worktree, repo, s, slot, ports, ctx, target.internal!.build, cwd, env, undefined, target.notes);
      await b.exited;
      if (b.state.exitCode !== 0) {
        b.state.status = "failed";
        b.state.error = "The build failed — see the log";
        this.changed();
        return b;
      }
      const loc = await this.deps.runShell(target.internal!.locate, cwd, env);
      const program = loc.out.trim().split("\n").pop()?.trim() ?? "";
      if (loc.code !== 0 || !program) throw new Error(`Couldn't find what the build produced: ${loc.out.trim().slice(0, 200) || `exit ${loc.code}`}`);
      const l = this.virtualLive(b);
      const sessionId = await this.deps.debugger.launch({
        worktree,
        repo,
        service: s.name,
        name: s.name,
        adapterID: target.adapterID,
        connect: target.connect,
        config: { ...target.config, program },
        onOutput: (_c, text) => this.append(l, text.replace(/\r?\n/g, "\r\n")),
        onEnded: (code) => l.endVirtual?.(code),
      });
      l.state.debug = sessionId;
      this.changed();
      return l;
    }
    if (target.kind === "alongside") {
      // the service runs as usual; once it's up, the debugger opens beside it
      const l = await this.launch(worktree, repo, profile, s, slot, ports);
      if (!(await this.whenReady(l, s, ports))) return l;
      const sessionId = await this.deps.debugger.launch({ worktree, repo, service: s.name, name: String(target.config.name ?? s.name), adapterID: target.adapterID, connect: target.connect, config: target.config });
      l.state.debug = sessionId;
      this.changed();
      return l;
    }
    let resolveLive!: (l: Live) => void;
    const started = new Promise<Live>((r) => (resolveLive = r));
    const runInTerminal = async (req: { cwd: string; args: string[]; env?: Record<string, string | null> }) => {
      const e = { ...env };
      for (const [k, v] of Object.entries(req.env ?? {})) if (v === null) delete e[k];
      else e[k] = v;
      const cmd = [...target.pre, `exec ${req.args.map(quote).join(" ")}`].join(" && ");
      const l = this.spawnLive(worktree, repo, s, slot, ports, ctx, cmd, req.cwd || cwd, e, undefined, target.notes);
      resolveLive(l);
      return l.state.pid ?? undefined;
    };
    const sessionId = await this.deps.debugger.launch({ worktree, repo, service: s.name, name: s.name, adapterID: target.adapterID, connect: target.connect, config: target.config, runInTerminal });
    const l = await Promise.race([started, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`The debugger started but never ran ${s.name}`)), 30_000))]);
    l.state.debug = sessionId;
    this.changed();
    return l;
  }

  private append(l: Live, text: string) {
    if (this.live.get(l.state.id) !== l) return;
    l.buffer = (l.buffer + text).slice(-BUFFER_MAX);
    this.deps.emit("run:data", l.state.id, text);
  }

  /**
   * A service the debugger runs itself, with no terminal of its own: it
   * continues the build's log and lives as long as the debug session.
   */
  private virtualLive(build: Live): Live {
    let resolveExit!: () => void;
    const state: RunServiceState = { ...build.state, status: "starting", pid: null, exitCode: null, startedAt: Date.now() };
    const l: Live = { state, proc: null, buffer: build.buffer, exited: new Promise((r) => (resolveExit = r)), stopRequested: false };
    l.endVirtual = (code) => {
      state.exitCode = code;
      if (l.stopRequested || !code) state.status = "stopped";
      else {
        state.status = "failed";
        state.error ??= `Exited with code ${code}`;
      }
      resolveExit();
      this.changed();
    };
    this.live.set(state.id, l);
    this.changed();
    return l;
  }

  private spawnLive(
    worktree: string,
    repo: string,
    s: RunService,
    slot: number,
    ports: Map<string, number>,
    ctx: { ports: Map<string, number>; slot: number; worktree: string },
    command: string,
    cwd: string,
    env: Record<string, string>,
    down?: string,
    notes: string[] = []
  ): Live {
    const id = runId(worktree, s.name);
    const state: RunServiceState = {
      id,
      service: s.name,
      worktree,
      repo,
      slot,
      status: "starting",
      // a url may say ${port} (its own) or ${port:name} (any service's)
      ports: (s.ports ?? []).map((p) => ({ name: p.name, port: ports.get(p.name)!, ...(p.url ? { url: expand(p.url.replace(/\$\{port\}/g, String(ports.get(p.name))), ctx) } : {}) })),
      pid: null,
      exitCode: null,
      startedAt: Date.now(),
    };
    const prior = this.live.get(id);
    let resolveExit!: () => void;
    const l: Live = { state, proc: null, buffer: prior?.buffer ? `${prior.buffer}\r\n` : "", exited: new Promise((r) => (resolveExit = r)), stopRequested: false, down };
    this.live.set(id, l);
    const header = `\x1b[2m$ ${command}\x1b[0m\r\n${notes.map((n) => `\x1b[33m${n}\x1b[0m\r\n`).join("")}`;
    l.buffer += header;
    this.deps.emit("run:data", id, header);
    try {
      l.proc = this.deps.spawn(command, { cwd, env });
    } catch (err) {
      state.status = "failed";
      state.error = `Couldn't start: ${(err as Error).message}`;
      resolveExit();
      this.changed();
      return l;
    }
    state.pid = l.proc.pid;
    l.proc.onData((d) => {
      if (this.live.get(id) !== l) return;
      l.buffer = (l.buffer + d).slice(-BUFFER_MAX);
      this.deps.emit("run:data", id, d);
    });
    l.proc.onExit(({ exitCode }) => {
      state.exitCode = exitCode;
      state.pid = null;
      if (l.stopRequested || exitCode === 0) state.status = "stopped";
      else {
        state.status = "failed";
        state.error ??= `Exited with code ${exitCode}`;
      }
      resolveExit();
      this.changed();
    });
    this.changed();
    return l;
  }

  /** Wait until the service is up: its ready port answers or its ready line appears. False if it exited first. */
  private async whenReady(l: Live, s: RunService, ports: Map<string, number>): Promise<boolean> {
    const finish = (ok: boolean) => {
      if (ok && l.state.status === "starting") l.state.status = "running";
      this.changed();
      return ok;
    };
    if (l.state.status === "failed") return false;
    const readyPort = s.ready?.port ? ports.get(s.ready.port) : undefined;
    const readyLog = s.ready?.log ? new RegExp(s.ready.log) : null;
    if (readyPort === undefined && !readyLog) return finish(true); // nothing to wait for
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
    let exited = false;
    l.exited.then(() => (exited = true));
    while (Date.now() < deadline) {
      if (exited) return finish(false);
      // strip colors so a pattern matches what the eye sees
      if (readyLog && readyLog.test(l.buffer.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))) return finish(true);
      if (readyPort !== undefined && (await this.inUse(readyPort))) return finish(true);
      await new Promise((r) => setTimeout(r, 300));
    }
    l.state.error = `Not ready after ${Math.round((this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)}s — the services after it were started anyway`;
    return finish(true);
  }

  /** Stop a worktree's services (all, or the named ones and what depends on them), dependents first. */
  async stop(worktree: string, services?: string[]): Promise<void> {
    let targets = this.running(worktree);
    if (services?.length) {
      const names = new Set(services);
      // whatever depends on a stopped service goes too
      let grew = true;
      const deps = new Map<string, string[]>();
      try {
        const { profile } = await this.profile(worktree);
        for (const s of profile.services) deps.set(s.name, s.dependsOn ?? []);
      } catch {
        /* the profile was removed; stop just what was named */
      }
      while (grew) {
        grew = false;
        for (const [n, d] of deps) if (!names.has(n) && d.some((x) => names.has(x))) (names.add(n), (grew = true));
      }
      targets = targets.filter((l) => names.has(l.state.service));
    }
    // dependents first: reverse of the order they were started
    targets.sort((a, b) => b.state.startedAt - a.state.startedAt);
    for (const l of targets) await this.stopOne(l);
  }

  private async stopOne(l: Live): Promise<void> {
    const virtual = !l.proc && !!l.endVirtual;
    if (!virtual && (!l.proc || l.state.pid === null)) return;
    l.stopRequested = true;
    l.state.status = "stopping";
    // taken now: ending the debugger may end the process, which clears it
    const pid = l.state.pid ?? 0;
    this.changed();
    // the debugger first: disconnecting ends the debuggee cleanly
    if (l.state.debug) await this.deps.debugger?.stop(l.state.debug).catch(() => {});
    if (virtual) {
      await Promise.race([l.exited, new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
      if (l.state.status === "stopping") l.endVirtual!(null);
      return;
    }
    const signal = (sig: NodeJS.Signals) => {
      try {
        this.kill(-pid, sig); // the whole process group: the shell and everything it started
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    };
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS);
    await l.exited;
    clearTimeout(timer);
    if (l.down) {
      const r = await this.deps.runShell(l.down, path.join(l.state.worktree), this.deps.baseEnv());
      const note = `\r\n\x1b[2m$ ${l.down}\x1b[0m\r\n${r.out.replace(/\n/g, "\r\n")}`;
      l.buffer = (l.buffer + note).slice(-BUFFER_MAX);
      this.deps.emit("run:data", l.state.id, note);
      if (r.code !== 0) {
        l.state.error = `docker compose down failed (exit ${r.code}) — containers may still be running`;
        l.state.status = "failed";
      }
    }
    this.changed();
  }

  /**
   * Get a worktree ready to run: copy the gitignored files it lacks from the
   * main checkout, then run the setup commands it still needs, logged like a
   * service named "prepare".
   */
  async prepare(worktree: string): Promise<{ copied: string[]; kept: string[]; missing: string[]; ran: boolean; id: string | null }> {
    const { repo, profile } = await this.profile(worktree);
    const copy = copyPrepared(repo, worktree, profile.prepare?.copy ?? []);
    const command = setupCommand(worktree, profile.prepare);
    const id = runId(worktree, "prepare");
    const summary = [
      copy.copied.length ? `Copied from ${path.basename(repo)}: ${copy.copied.join(", ")}` : "",
      copy.kept.length ? `Already here (kept): ${copy.kept.join(", ")}` : "",
      copy.missing.length ? `Not in ${path.basename(repo)} either: ${copy.missing.join(", ")}` : "",
      command ? "" : "No setup commands needed.",
    ].filter(Boolean);
    if (!command) {
      const l = this.live.get(id);
      const note = `${summary.join("\r\n")}\r\n`;
      if (l) {
        l.buffer = (l.buffer + note).slice(-BUFFER_MAX);
        this.deps.emit("run:data", id, note);
      }
      return { ...copy, ran: false, id: l ? id : null };
    }
    if (this.running(worktree).some((l) => l.state.service === "prepare")) throw new Error("Prepare is already running for this worktree");
    const service: RunService = { name: "prepare", kind: "process", cwd: ".", command: summary.map((line) => `echo ${quote(line)}`).concat(command).join(" && ") };
    const l = await this.launch(worktree, repo, profile, service, 0, new Map());
    await l.exited;
    return { ...copy, ran: true, id };
  }

  /** Everything, for quitting the app. */
  async stopAll(): Promise<void> {
    const worktrees = [...new Set(this.running().map((l) => l.state.worktree))];
    await Promise.all(worktrees.map((w) => this.stop(w)));
  }

  /** Stop one service by its run id — for a log whose session has since closed. */
  async stopById(id: string): Promise<void> {
    const l = this.live.get(id);
    if (!l) throw new Error("That service isn't known any more");
    await this.stop(l.state.worktree, [l.state.service]);
  }

  /** Forget a stopped service's log and row. */
  clear(id: string): void {
    const l = this.live.get(id);
    if (l && (l.state.status === "stopped" || l.state.status === "failed")) {
      this.live.delete(id);
      this.changed();
    }
  }
}
