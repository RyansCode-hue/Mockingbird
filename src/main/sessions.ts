import * as pty from "node-pty";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { WebContents } from "electron";
import { SessionInfo, SessionStatus, NewSessionRequest, slugBranch, AgentKind } from "../shared/types";
import { Store, expandHome } from "./store";
import { createWorktree, checkoutBranch } from "./worktrees";
import { adoEnv } from "./ado";
import { agentFor, AgentAdapter } from "./agents";
import { whichSync } from "./shell";
import { mcpLaunch } from "./messaging";

const BUFFER_MAX = 400_000; // bytes of scrollback kept per session for re-render

/**
 * The app's environment minus any Claude Code session markers. When Mockingbird
 * is started from inside a Claude Code session, those markers (CLAUDECODE,
 * CLAUDE_CODE_CHILD_SESSION, the parent's session id and messaging socket)
 * would make every pane a child of that session: transcripts go unsaved, so
 * nothing can be resumed. Panes start login shells, which re-apply anything the
 * user sets in their own profile.
 */
function paneEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "CLAUDECODE" || /^CLAUDE_(CODE_|PID$|EFFORT$|AGENT_SDK_|PREVIEW_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

interface LiveSession {
  info: SessionInfo;
  proc: pty.IPty;
  buffer: string;
  queued: { text: string; submit: boolean }[]; // messages to deliver when idle
  lastInput: number; // ms of the user's last write into this pane
  flushTimer: NodeJS.Timeout | null; // retry while the user is typing
  claudeId: string | null; // Claude Code's own session_id, claimed from the first hook event
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private wc: WebContents | null = null;

  private resolvedBins = new Map<string, string>();

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
    this.resolvedBins.clear();
  }

  /** The binary a fresh session of this agent would launch. */
  binFor(kind: AgentKind): string {
    return this.resolveBin(agentFor(kind));
  }

  private resolveBin(agent: AgentAdapter): string {
    const cached = this.resolvedBins.get(agent.binSetting);
    if (cached) return cached;
    const bin = this.store.settings[agent.binSetting];
    let resolved = bin;
    if (bin.includes("/")) resolved = expandHome(bin);
    else {
      // a bare name means "not found" to callers; the pane's own shell reports it on launch
      resolved = whichSync(bin) ?? bin;
    }
    this.resolvedBins.set(agent.binSetting, resolved);
    return resolved;
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

    const wanted =
      req.branchName?.trim() ||
      (req.ticketId && req.ticketTitle ? slugBranch(req.ticketId, req.ticketTitle) : null);
    if (repoPath && req.useWorktree) {
      branch = wanted || `mb-${Date.now().toString(36)}`;
      cwd = createWorktree(repoPath, branch, req.baseBranch);
    } else if (repoPath && wanted) {
      // ticket branch in the checkout itself — one branch per checkout, so
      // another live session there on a different branch blocks this
      const other = [...this.live.values()].find(
        (s) => s.info.cwd === repoPath && s.info.status !== "dead" && s.info.branch && s.info.branch !== wanted
      );
      checkoutBranch(repoPath, wanted, req.baseBranch, other?.info.branch ?? undefined);
      branch = wanted;
      cwd = repoPath;
    } else {
      // repo-less: claude sessions run in the WorkTracker (assistant), plain
      // terminals just open at home
      // repo-less: debrief assistants live in the WorkTracker folder (their
      // instructions and digests are there); plain chats and shells run in
      // home — which is also where claude finds conversations started from a
      // bare terminal, so --continue/--resume can pick those up
      cwd = repoPath ?? (req.debrief ? expandHome(settings.workTrackerPath) : os.homedir());
    }

    const agent = agentFor(req.agent);

    // Spawn via a login shell: /bin/zsh always execs cleanly under posix_spawnp,
    // handles claude being a wrapper script, and brings the user's PATH along.
    // shell sessions skip claude entirely — just an interactive zsh in the cwd.
    const shellArgs = ["-il"];
    let claudeArgs: string[] = shellArgs;
    const id = req.reuseId ?? randomUUID().slice(0, 8);
    if (!req.shell) {
      const cmdline = [this.resolveBin(agent), ...agent.launchArgs(req, { mcp: mcpLaunch(id) })].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
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
          ...paneEnv(),
          MOCKINGBIRD: "1",
          // debriefs get PAT auth for the az DevOps CLI (AZURE_DEVOPS_EXT_PAT)
          // so ticket/PR queries work without az login or an MCP server
          ...(req.debrief ? adoEnv(this.store) : {}),
        } as Record<string, string>,
      });
    } catch (err) {
      throw new Error(
        `Failed to launch ${req.shell ? "a terminal" : `"${this.resolveBin(agent)}"`} in ${cwd}: ${err instanceof Error ? err.message : err}. ` +
          `If it isn't found, set its full path in Settings → ${agent.label.toLowerCase()} binary.`
      );
    }

    const info: SessionInfo = {
      id,
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
      model: req.model || undefined,
      effort: req.effort || undefined,
      agent: req.shell ? undefined : req.agent ?? "claude",
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
    const sess: LiveSession = { info, proc, buffer: "", queued: [], claudeId: null, lastInput: 0, flushTimer: null };
    this.live.set(info.id, sess);
    this.store.upsertSession(info);

    // both callbacks outlive kill(): ignore them once this pty is no longer the
    // live session for that id, or a dying pty marks its replacement dead
    proc.onData((data) => {
      if (this.live.get(info.id) !== sess) return;
      sess.buffer = (sess.buffer + data).slice(-BUFFER_MAX);
      this.wc?.send("session:data", info.id, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.live.get(info.id) !== sess) return;
      info.exitCode = exitCode;
      this.setStatus(info.id, "dead");
    });

    // kickoff prompt (e.g. the ADO ticket) — sent once claude has had time to boot
    if (req.initialPrompt && !req.shell && !agent.promptInArgs) {
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
    // --continue exits immediately when the cwd has no conversation yet (a
    // session that died at startup); such a session relaunches fresh instead
    const resume = !old.shell && agentFor(old.agent).hasConversation(old.cwd);
    const info = this.create({
      repoPath: old.repoPath,
      ticketId: old.ticketId ?? undefined,
      ticketTitle: old.ticketTitle ?? undefined,
      // a worktree session has cwd ≠ repoPath and is recreated as one; an
      // in-checkout session just runs where it was, on whatever branch is out
      ...(old.branch && old.repoPath && old.cwd !== expandHome(old.repoPath)
        ? { branchName: old.branch, useWorktree: true }
        : { useWorktree: false }),
      taskGroup: old.taskGroup ?? undefined,
      extraDirs: old.extraDirs,
      resume,
      reuseId: old.id, // same id → persisted grid position and group still apply
      title: old.title,
      debrief: old.debrief,
      shell: old.shell,
      model: old.model ?? undefined,
      effort: old.effort ?? undefined,
      agent: old.agent,
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
    const s = this.live.get(id);
    if (!s) return;
    s.lastInput = Date.now();
    s.proc.write(data);
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

  /** Inject a chat message into a session (paste, then submit unless told not to). */
  sendMessage(id: string, message: string, submit = true): void {
    const s = this.live.get(id);
    if (!s) return;
    // bracketed paste so multi-line messages arrive as one prompt
    s.proc.write(`\x1b[200~${message}\x1b[201~`);
    if (submit) setTimeout(() => s.proc.write("\r"), 120);
  }

  /**
   * Deliver a message from another agent session. An idle session gets it now;
   * a busy or blocked one gets it when its turn ends (Enter would otherwise answer
   * a pending permission prompt). Either way it waits while the user is typing in
   * that pane, so it never lands in the middle of their draft.
   */
  deliverAgentMessage(id: string, message: string, submit: boolean): string {
    const s = this.live.get(id);
    if (!s) throw new Error(`session ${id} is not running`);
    s.queued.push({ text: message, submit });
    if (s.info.status === "idle") {
      this.flushQueued(s);
      this.emitChanged();
      return s.queued.length ? "queued — the user is typing in that pane" : submit ? "delivered" : "placed in its prompt for the user to send";
    }
    this.emitChanged();
    return "queued until its current turn ends";
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
      else s.queued.push({ text: message, submit: true });
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
    if (!s.queued.length || s.info.status === "dead") return;
    const QUIET_MS = 8000;
    const typedAgo = Date.now() - s.lastInput;
    if (typedAgo < QUIET_MS) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        if (this.live.get(s.info.id) === s && s.info.status === "idle") this.flushQueued(s);
      }, QUIET_MS - typedAgo + 200);
      return;
    }
    const msgs = s.queued.splice(0);
    for (const m of msgs) this.sendMessage(s.info.id, m.text, m.submit);
    if (msgs.some((m) => m.submit)) this.setStatus(s.info.id, "working");
    else this.emitChanged();
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
