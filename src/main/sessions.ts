import * as pty from "node-pty";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import * as os from "os";
import { WebContents } from "electron";
import { SessionInfo, SessionStatus, NewSessionRequest, slugBranch } from "../shared/types";
import { Store, expandHome } from "./store";
import { createWorktree } from "./worktrees";
import { adoEnv } from "./ado";

const BUFFER_MAX = 400_000; // bytes of scrollback kept per session for re-render

interface LiveSession {
  info: SessionInfo;
  proc: pty.IPty;
  buffer: string;
  queued: string[]; // messages to deliver when idle
  claudeId: string | null; // Claude Code's own session_id, claimed from the first hook event
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private wc: WebContents | null = null;

  private resolvedBin: string | null = null;

  /** Called whenever the session list changes — drives the tray + Dock badge. */
  onChanged: (() => void) | null = null;

  constructor(private store: Store) {}

  private emitChanged(): void {
    this.wc?.send("sessions:changed", this.list());
    this.onChanged?.();
  }

  /** Resolve the claude binary via a login shell so packaged .app launches find it too. */
  /** Drop the cached claude path so a Settings change takes effect immediately. */
  resetBinCache(): void {
    this.resolvedBin = null;
  }

  private resolveClaude(): string {
    if (this.resolvedBin) return this.resolvedBin;
    const bin = this.store.settings.claudeBin;
    if (bin.includes("/")) return (this.resolvedBin = expandHome(bin));
    try {
      const found = execFileSync("/bin/zsh", ["-lc", `command -v ${bin}`], { encoding: "utf8" })
        .trim()
        .split("\n")
        .pop();
      if (found) return (this.resolvedBin = found);
    } catch {
      /* fall through to bare name */
    }
    return (this.resolvedBin = bin);
  }

  attach(wc: WebContents): void {
    this.wc = wc;
  }

  list(): SessionInfo[] {
    return [...this.live.values()].map((s) => ({ ...s.info, queuedCount: s.queued.length }));
  }

  /** Sessions persisted from a previous app run that aren't live now. */
  resumable(): SessionInfo[] {
    const liveIds = new Set(this.live.keys());
    return this.store.state.sessions.filter((s) => !liveIds.has(s.id));
  }

  create(req: NewSessionRequest): SessionInfo {
    const settings = this.store.settings;
    let cwd: string;
    let branch: string | null = null;
    let repoPath = req.repoPath ? expandHome(req.repoPath) : null;

    if (repoPath && req.useWorktree) {
      branch =
        req.branchName?.trim() ||
        (req.ticketId && req.ticketTitle ? slugBranch(req.ticketId, req.ticketTitle) : null) ||
        `mb-${Date.now().toString(36)}`;
      cwd = createWorktree(repoPath, branch, req.baseBranch);
    } else {
      // repo-less: claude sessions run in the WorkTracker (assistant), plain
      // terminals just open at home
      cwd = repoPath ?? (req.shell ? os.homedir() : expandHome(settings.workTrackerPath));
    }

    const args: string[] = [];
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    else if (req.resume) args.push("--continue");
    for (const d of req.extraDirs ?? []) args.push("--add-dir", expandHome(d));

    // Spawn via a login shell: /bin/zsh always execs cleanly under posix_spawnp,
    // handles claude being a wrapper script, and brings the user's PATH along.
    // shell sessions skip claude entirely — just an interactive zsh in the cwd.
    const shellArgs = ["-il"];
    let claudeArgs: string[] = shellArgs;
    if (!req.shell) {
      const bin = this.resolveClaude();
      const cmdline = [bin, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
      claudeArgs = ["-ilc", `exec ${cmdline}`];
    }
    let proc: pty.IPty;
    try {
      proc = pty.spawn("/bin/zsh", claudeArgs, {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd,
        env: {
          ...process.env,
          MOCKINGBIRD: "1",
          // debriefs get PAT auth for the az DevOps CLI (AZURE_DEVOPS_EXT_PAT)
          // so ticket/PR queries work without az login or an MCP server
          ...(req.debrief ? adoEnv(this.store) : {}),
        } as Record<string, string>,
      });
    } catch (err) {
      throw new Error(
        `Failed to launch ${req.shell ? "a terminal" : `"${this.resolveClaude()}"`} in ${cwd}: ${err instanceof Error ? err.message : err}. ` +
          `If claude isn't found, set its full path in Settings → claude binary (try: which claude).`
      );
    }

    const info: SessionInfo = {
      id: req.reuseId ?? randomUUID().slice(0, 8),
      title:
        req.title ??
        (req.ticketId && req.ticketTitle
          ? `#${req.ticketId.replace(/^#/, "")} — ${req.ticketTitle}`
          : branch ?? (repoPath ? repoPath.split("/").pop()! : req.shell ? "terminal" : "assistant")),
      repoPath,
      cwd,
      branch,
      ticketId: req.ticketId ?? null,
      ticketTitle: req.ticketTitle ?? null,
      taskGroup: req.taskGroup ?? req.ticketId ?? null,
      status: req.shell ? "idle" : "working", // shells have no hooks — grey until claude runs inside
      createdAt: Date.now(),
      kind: repoPath ? "work" : "assistant",
      extraDirs: req.extraDirs ?? [],
      waitingReason: null,
      waitingSince: null,
      debrief: req.debrief || undefined,
      shell: req.shell || undefined,
    };

    // reuseId re-creates an existing id (relaunch): kill the old pty first or it
    // keeps running, unreachable, still pumping data under the same id
    const prior = this.live.get(info.id);
    if (prior) {
      try {
        prior.proc.kill();
      } catch {
        /* already dead */
      }
    }
    const sess: LiveSession = { info, proc, buffer: "", queued: [], claudeId: null };
    this.live.set(info.id, sess);
    this.store.upsertSession(info);

    // both callbacks outlive kill(): ignore them once this pty is no longer the
    // live session for that id, or a dying pty marks its replacement dead
    proc.onData((data) => {
      if (this.live.get(info.id) !== sess) return;
      sess.buffer = (sess.buffer + data).slice(-BUFFER_MAX);
      this.wc?.send("session:data", info.id, data);
    });
    proc.onExit(() => {
      if (this.live.get(info.id) !== sess) return;
      this.setStatus(info.id, "dead");
    });

    // kickoff prompt (e.g. the ADO ticket) — sent once claude has had time to boot
    if (req.initialPrompt && !req.shell) {
      const prompt = req.initialPrompt;
      setTimeout(() => this.sendMessage(info.id, prompt), 6000);
    }

    this.emitChanged();
    return info;
  }

  /**
   * Restart claude sessions in place — same id, same grid slot, conversation
   * resumed with --continue. This is what you want after the CLI prints
   * "Update installed · Restart to update": every pane picks up the new binary
   * without losing its history. Shells and dead panes are left alone.
   */
  restartAll(includeBusy: boolean): {
    restarted: string[];
    skipped: string[];
    failed: { id: string; error: string }[];
  } {
    const restarted: string[] = [];
    const skipped: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const s of [...this.live.values()]) {
      const { id, status, shell } = s.info;
      if (shell || status === "dead") continue;
      if (!includeBusy && (status === "working" || status === "waiting")) {
        skipped.push(id); // mid-turn: killing it would drop the answer in flight
        continue;
      }
      this.kill(id, false); // keep the store entry so relaunch can resume it
      try {
        if (this.relaunch(id)) restarted.push(id);
        else failed.push({ id, error: "no persisted session to resume" });
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.emitChanged();
    return { restarted, skipped, failed };
  }

  /** Relaunch a persisted session in its old cwd, resuming the conversation. */
  relaunch(id: string): SessionInfo | null {
    const old = this.store.state.sessions.find((s) => s.id === id);
    if (!old) return null;
    // create() re-adds the record; only forget the old one once it has, or a
    // failed relaunch (missing worktree, spawn error) erases the session for good
    const info = this.create({
      repoPath: old.repoPath,
      ticketId: old.ticketId ?? undefined,
      ticketTitle: old.ticketTitle ?? undefined,
      branchName: old.branch ?? undefined,
      useWorktree: !!old.branch,
      taskGroup: old.taskGroup ?? undefined,
      extraDirs: old.extraDirs,
      resume: true,
      reuseId: old.id, // same id → persisted grid position and group still apply
      title: old.title,
      debrief: old.debrief,
      shell: old.shell,
    });
    return info;
  }

  /**
   * Passive snapshot of every live coding session for the daily digest:
   * metadata plus the ANSI-stripped tail of the terminal buffer. Reads only —
   * nothing is ever written to a pty, so no session is interrupted.
   */
  digest(): { info: SessionInfo; tail: string }[] {
    const ansi = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|\r/g;
    return [...this.live.values()]
      .filter((s) => !s.info.debrief)
      .map((s) => ({
        info: { ...s.info },
        tail: s.buffer
          .replace(ansi, "")
          .split("\n")
          .map((l) => l.trimEnd())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .slice(-3000),
      }));
  }

  /** Manual override for a stale waiting state — marks the session idle. */
  clearWaiting(id: string): void {
    const s = this.live.get(id);
    if (!s || s.info.status !== "waiting") return;
    this.setStatus(id, "idle");
    this.flushQueued(s);
  }

  /** Move a session (live or previous) to a task group; null removes it from its group. */
  setGroup(id: string, group: string | null): void {
    const g = group?.trim() || null;
    const s = this.live.get(id);
    if (s) {
      s.info.taskGroup = g;
      this.store.upsertSession(s.info);
    } else {
      const p = this.store.state.sessions.find((x) => x.id === id);
      if (p) {
        p.taskGroup = g;
        this.store.save();
      }
    }
    this.emitChanged();
  }

  rename(id: string, title: string): void {
    const s = this.live.get(id);
    if (s) {
      s.info.title = title;
      s.info.ticketTitle = s.info.ticketTitle ? title : s.info.ticketTitle;
      this.store.upsertSession(s.info);
    } else {
      const p = this.store.state.sessions.find((x) => x.id === id);
      if (p) {
        p.title = title;
        this.store.save();
      }
    }
    this.emitChanged();
  }

  renameGroup(oldKey: string, newKey: string): void {
    // prefix-aware: renaming group "5101" must carry "5101/etl" → "X/etl"
    const remap = (g: string | null): string | null =>
      g === oldKey ? newKey : g && g.startsWith(oldKey + "/") ? newKey + g.slice(oldKey.length) : g;
    for (const s of this.live.values()) {
      const n = remap(s.info.taskGroup);
      if (n !== s.info.taskGroup) {
        s.info.taskGroup = n;
        this.store.upsertSession(s.info);
      }
    }
    for (const p of this.store.state.sessions) {
      const n = remap(p.taskGroup);
      if (n !== p.taskGroup) p.taskGroup = n;
    }
    this.store.save();
    this.emitChanged();
  }

  write(id: string, data: string): void {
    this.live.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.live.get(id)?.proc.resize(cols, rows);
    } catch {
      /* dead pty */
    }
  }

  buffer(id: string): string {
    return this.live.get(id)?.buffer ?? "";
  }

  kill(id: string, forget = false): void {
    const s = this.live.get(id);
    if (s) {
      try {
        s.proc.kill();
      } catch {
        /* already dead */
      }
      this.live.delete(id);
    }
    if (forget) this.store.removeSession(id);
    this.emitChanged();
  }

  /** Inject a chat message into a session (paste + submit). */
  sendMessage(id: string, message: string): void {
    const s = this.live.get(id);
    if (!s) return;
    // bracketed paste so multi-line messages arrive as one prompt
    s.proc.write(`\x1b[200~${message}\x1b[201~`);
    setTimeout(() => s.proc.write("\r"), 120);
  }

  /** Broadcast to sessions; queue for busy ones (delivered on the next idle).
   *  Shell sessions are always skipped — a broadcast typed into a shell would
   *  execute as commands — and so are debriefs, which are mid-interview. */
  broadcast(message: string, sessionIds: string[], whenIdle: boolean): void {
    const targets = sessionIds.length
      ? sessionIds
      : [...this.live.values()]
          .filter((s) => s.info.kind === "work" && !s.info.shell)
          .map((s) => s.info.id);
    for (const id of targets) {
      const s = this.live.get(id);
      if (!s || s.info.status === "dead" || s.info.shell || s.info.debrief) continue;
      // "waiting" counts as busy: sendMessage ends with Enter, which would
      // answer whatever prompt is blocking the session — including a pending
      // permission request the user has not looked at yet
      if (!whenIdle || s.info.status === "idle") this.sendMessage(id, message);
      else s.queued.push(message);
    }
    this.emitChanged();
  }

  /**
   * Called by the hooks watcher. cwd alone does not identify a session —
   * debriefs and assistant sessions share the WorkTracker directory and two
   * sessions can share one worktree — so events are routed by Claude Code's own
   * session_id, claimed by the first event a session emits.
   */
  statusByCwd(
    cwd: string,
    status: SessionStatus,
    reason?: string,
    claudeId?: string
  ): SessionInfo | null {
    const s = this.matchSession(cwd, claudeId);
    if (!s) return null;
    this.setStatus(s.info.id, status, reason);
    // deliver queued broadcasts whenever the session frees up (a session can
    // reach idle from waiting too — e.g. a declined permission, or the idle
    // reminder — and those queues used to strand forever)
    if (status === "idle") this.flushQueued(s);
    return s.info;
  }

  private matchSession(cwd: string, claudeId?: string): LiveSession | null {
    const inCwd = [...this.live.values()].filter((s) => s.info.cwd === cwd);
    if (!inCwd.length) return null;
    if (claudeId) {
      const bound = inCwd.find((s) => s.claudeId === claudeId);
      if (bound) return bound;
      const free = inCwd.find((s) => s.claudeId === null);
      if (free) {
        free.claudeId = claudeId;
        return free;
      }
      // every session in this cwd is bound to some other claude run (the CLI was
      // restarted inside a pane): rebind the newest one rather than misroute
      const newest = inCwd[inCwd.length - 1];
      newest.claudeId = claudeId;
      return newest;
    }
    return inCwd[0];
  }

  /** Deliver messages queued while a session was busy, then mark it working again. */
  private flushQueued(s: LiveSession): void {
    if (!s.queued.length) return;
    const msgs = s.queued.splice(0);
    for (const m of msgs) this.sendMessage(s.info.id, m);
    this.setStatus(s.info.id, "working");
  }

  private setStatus(id: string, status: SessionStatus, reason?: string): void {
    const s = this.live.get(id);
    if (!s) return;
    if (s.info.status === status && (status !== "waiting" || !reason)) return;
    s.info.status = status;
    if (status === "waiting") {
      s.info.waitingReason = reason ?? s.info.waitingReason ?? null;
      s.info.waitingSince = s.info.waitingSince ?? Date.now();
    } else {
      s.info.waitingReason = null;
      s.info.waitingSince = null;
    }
    this.store.upsertSession(s.info);
    this.emitChanged();
  }
}
