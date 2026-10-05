import * as pty from "node-pty";
import { randomUUID } from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { WebContents } from "electron";
import { SessionInfo, SessionStatus, NewSessionRequest, slugBranch, AgentKind, type AgentUpdateNotice, type BroadcastOutcome } from "../shared/types";
import { Store, expandHome, MB_DIR } from "./store";
import { createWorktree, checkoutBranch } from "./worktrees";
import { adoEnv } from "./ado";
import { agentFor, AgentAdapter, type LaunchContext } from "./agents";
import { which, whichSync, quote } from "./shell";
import { mcpLaunch } from "./messaging";
import { conversationsOf, withConversation } from "./meters";
import { writeFileAtomic } from "./fileOps";

const BUFFER_MAX = 400_000; // bytes of scrollback kept per session for re-render

/**
 * Where a relaunched pane's earlier output ends: cursor shown and attributes
 * reset (whatever the old program left on), then a dim divider line. Leaving
 * the alternate screen also restores the cursor saved on entering it, so it's
 * only sent when the earlier output is still in there — otherwise the cursor
 * would jump to the top and the divider overwrite the history.
 */
export function restartDivider(at: Date, earlier: string): string {
  const entered = Math.max(earlier.lastIndexOf("\x1b[?1049h"), earlier.lastIndexOf("\x1b[?1047h"), earlier.lastIndexOf("\x1b[?47h"));
  const left = Math.max(earlier.lastIndexOf("\x1b[?1049l"), earlier.lastIndexOf("\x1b[?1047l"), earlier.lastIndexOf("\x1b[?47l"));
  const when = at.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${entered > left ? "\x1b[?1049l" : ""}\r\n\x1b[?25h\x1b[0m\x1b[2m── restarted ${when} · earlier output above ──\x1b[0m\r\n\r\n`;
}

/**
 * The app's environment minus any Claude Code session markers. When Mockingbird
 * is started from inside a Claude Code session, those markers (CLAUDECODE,
 * CLAUDE_CODE_CHILD_SESSION, the parent's session id and messaging socket)
 * would make every pane a child of that session: transcripts go unsaved, so
 * nothing can be resumed. Panes start login shells, which re-apply anything the
 * user sets in their own profile.
 */
export function paneEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "CLAUDECODE" || /^CLAUDE_(CODE_|PID$|EFFORT$|AGENT_SDK_|PREVIEW_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

type Queued = { text: string; submit: boolean };

interface LiveSession {
  info: SessionInfo;
  proc: pty.IPty;
  buffer: string;
  queued: Queued[]; // messages to deliver when idle
  lastInput: number; // ms of the user's last write into this pane, or of a message placed there for them to send
  draft: boolean; // the prompt holds unsent text: typed since the user's last Enter, or a message placed for them
  flushTimer: NodeJS.Timeout | null; // retry while the user is typing
  lastOutput: number; // ms of the pty's last output — a working pane that goes quiet may be stuck
  outputs: number; // chunks of output so far
  saved: number; // `outputs` when its scrollback was last written to disk
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  /** Messages a pane closed to resume hadn't been given yet; its relaunch delivers them. */
  private undelivered = new Map<string, Queued[]>();
  /** Each pane's scrollback is kept here, so a relaunched pane shows its earlier output. */
  scrollbackDir = path.join(MB_DIR, "scrollback");
  private wc: WebContents | null = null;
  /** Each agent CLI's installed version, as last read; new panes record it (see AgentUpdateNotice). */
  agentVersions: Partial<Record<AgentKind, string>> = {};

  private resolvedBins = new Map<string, string>();
  /** Bumped by resetBinCache, so a lookup started before a Settings change can't cache the old binary. */
  private binGeneration = 0;

  /** Called whenever the session list changes — drives the tray + Dock badge. */
  onChanged: (() => void) | null = null;

  constructor(private store: Store) {}

  private emitChanged(): void {
    this.wc?.send("sessions:changed", this.list());
    this.onChanged?.();
  }

  /** Drop the cached binary paths so a Settings change takes effect immediately. */
  resetBinCache(): void {
    this.resolvedBins.clear();
    this.binGeneration++;
  }

  /** The binary a fresh session of this agent would launch. */
  binFor(kind: AgentKind): string {
    return this.resolveBin(agentFor(kind));
  }

  /**
   * Look up every agent's binary without blocking — at startup and after a
   * Settings change — so binFor() is a cache hit by the time a session starts.
   */
  async warmBins(): Promise<void> {
    for (const agent of [agentFor("claude"), agentFor("codex")]) {
      const bin = this.store.settings[agent.binSetting];
      if (this.resolvedBins.has(agent.binSetting) || bin.includes("/")) continue;
      const generation = this.binGeneration;
      const found = await which(bin);
      if (generation !== this.binGeneration) continue; // looked up for settings since replaced
      // a bare name means "not found", as in resolveBin — cached too, so nothing looks it up again
      if (!this.resolvedBins.has(agent.binSetting)) this.resolvedBins.set(agent.binSetting, found ?? bin);
    }
  }

  private resolveBin(agent: AgentAdapter): string {
    const cached = this.resolvedBins.get(agent.binSetting);
    if (cached) return cached;
    // cold: warmBins() hasn't finished (or found nothing) — look it up now
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

  async create(req: NewSessionRequest): Promise<SessionInfo> {
    const settings = this.store.settings;
    let cwd: string;
    let branch: string | null = null;
    let repoPath = req.repoPath ? expandHome(req.repoPath) : null;

    const wanted =
      req.branchName?.trim() ||
      (req.ticketId && req.ticketTitle ? slugBranch(req.ticketId, req.ticketTitle) : null);
    if (req.cwd) {
      cwd = expandHome(req.cwd);
      if (!fs.existsSync(cwd)) throw new Error(`${cwd} doesn't exist any more`);
      branch = req.branchName?.trim() || null;
    } else if (repoPath && req.useWorktree) {
      branch = wanted || `mb-${Date.now().toString(36)}`;
      cwd = await createWorktree(repoPath, branch, req.baseBranch);
    } else if (repoPath && wanted) {
      // ticket branch in the checkout itself — one branch per checkout, so
      // another live session there on a different branch blocks this
      const other = [...this.live.values()].find(
        (s) => s.info.cwd === repoPath && s.info.status !== "dead" && s.info.branch && s.info.branch !== wanted
      );
      await checkoutBranch(repoPath, wanted, req.baseBranch, other?.info.branch ?? undefined);
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
    const commandFor = (a: AgentAdapter, r: NewSessionRequest, ctx: LaunchContext) => [this.resolveBin(a), ...a.launchArgs(r, ctx)].map(quote).join(" ");
    if (!req.shell) {
      claudeArgs = ["-ilc", `exec ${commandFor(agent, req, { mcp: mcpLaunch(id) })}`];
    } else if (req.shellResume) {
      // a terminal that had an agent running in it: bring the conversation
      // back, and leave the user at the shell prompt when they quit it. It
      // gets no messaging tools: terminals are outside agent messaging, since
      // a message typed in once the agent has quit would run as a command.
      const a = agentFor(req.shellResume.agent);
      claudeArgs = ["-ilc", `${commandFor(a, { ...req, shell: false, resumeSessionId: req.shellResume.id }, {})}; exec /bin/zsh -il`];
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
          // inherited by the agent and its hooks — including an agent the user
          // starts by hand inside a terminal pane — so every hook event names
          // its pane exactly; a folder alone is ambiguous (see statusFromHook)
          MOCKINGBIRD_SESSION: id,
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
      conversation: req.shellResume ?? (req.resumeSessionId ? { agent: req.agent ?? "claude", id: req.resumeSessionId } : undefined),
    };
    // a relaunched pane keeps its history of conversations (its token meter adds them up)
    const before = (req.reuseId ? this.store.state.sessions.find((x) => x.id === req.reuseId) : undefined) ?? {};
    const history = info.conversation ? withConversation(before, info.conversation.id) : conversationsOf(before);
    if (history.length) info.conversations = history;

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
    if (!req.shell) info.agentVersion = this.agentVersions[req.agent ?? "claude"];
    // a relaunch (same id) starts with what the pane showed before, and still
    // owes the messages that were waiting for it
    const earlier = req.reuseId ? this.readScrollback(req.reuseId) : "";
    const owed = [...(prior?.queued ?? []), ...(this.undelivered.get(info.id) ?? [])];
    this.undelivered.delete(info.id);
    const sess: LiveSession = {
      info,
      proc,
      buffer: earlier ? (earlier + restartDivider(new Date(), earlier)).slice(-BUFFER_MAX) : "",
      queued: owed,
      lastInput: 0,
      draft: false,
      flushTimer: null,
      lastOutput: Date.now(),
      outputs: 0,
      saved: 0,
    };
    this.live.set(info.id, sess);
    this.store.upsertSession(info);

    // both callbacks outlive kill(): ignore them once this pty is no longer the
    // live session for that id, or a dying pty marks its replacement dead
    proc.onData((data) => {
      if (this.live.get(info.id) !== sess) return;
      sess.buffer = (sess.buffer + data).slice(-BUFFER_MAX);
      sess.lastOutput = Date.now();
      sess.outputs++;
      if (info.stalledSince) {
        info.stalledSince = null;
        this.emitChanged();
      }
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
    // a terminal's kickoff is a command (a preset's "npm test -- --watch"): typed
    // once the login shell has had time to start, and run
    if (req.initialPrompt && req.shell && !req.shellResume) {
      const command = req.initialPrompt.replace(/\r?\n/g, " ; ");
      setTimeout(() => {
        if (this.live.get(info.id) === sess) proc.write(`${command}\r`);
      }, 1500);
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
  async restartAll(includeBusy: boolean): Promise<{
    restarted: string[];
    skipped: string[];
    failed: { id: string; error: string }[];
  }> {
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
      try {
        await this.restart(id);
        restarted.push(id);
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.emitChanged();
    return { restarted, skipped, failed };
  }

  private scrollbackFile = (id: string) => path.join(this.scrollbackDir, `${id.replace(/[^\w-]/g, "_")}.log`);

  /**
   * Debriefs don't outlive the app (their records are dropped at startup), so
   * their scrollback never goes to disk: it is held here from closing one to
   * resume until its relaunch.
   */
  private debriefScrollback = new Map<string, string>();

  private readScrollback(id: string): string {
    const held = this.debriefScrollback.get(id);
    if (held !== undefined) {
      this.debriefScrollback.delete(id);
      return held;
    }
    try {
      return fs.readFileSync(this.scrollbackFile(id), "utf8").slice(-BUFFER_MAX);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[sessions] couldn't read scrollback for ${id}:`, err);
      return "";
    }
  }

  private writeScrollback(s: LiveSession): void {
    if (!s.buffer) return;
    if (s.info.debrief) {
      this.debriefScrollback.set(s.info.id, s.buffer);
      return;
    }
    writeFileAtomic(this.scrollbackFile(s.info.id), s.buffer);
    s.saved = s.outputs;
  }

  private dropScrollback(id: string): void {
    this.debriefScrollback.delete(id);
    fs.rmSync(this.scrollbackFile(id), { force: true });
  }

  /** Write every pane's scrollback that changed since it was last written (and all of them when quitting). */
  saveScrollback(all = false): void {
    for (const s of this.live.values()) {
      if (s.info.debrief || (!all && s.saved === s.outputs)) continue;
      try {
        this.writeScrollback(s);
      } catch (err) {
        console.error(`[sessions] couldn't save scrollback for ${s.info.id}:`, err);
      }
    }
  }

  /** Mute or unmute a session's notifications; kept across restarts. */
  setMuted(id: string, muted: boolean): void {
    const s = this.live.get(id);
    if (!s) throw new Error("Session is no longer running");
    s.info.muted = muted || undefined;
    this.store.upsertSession(s.info);
    this.emitChanged();
  }

  /** Restart one pane in place: same id, its conversation resumed. */
  async restart(id: string): Promise<SessionInfo> {
    this.kill(id, false); // keep the store entry so relaunch can resume it
    const info = await this.relaunch(id);
    if (!info) throw new Error("no persisted session to resume");
    return info;
  }

  /**
   * Flag working panes whose terminal has been quiet for `quietMs` (an agent's
   * screen redraws constantly while it works, so silence means it may be
   * stuck). Output clears the flag. Returns whether anything changed.
   */
  checkStalls(now: number, quietMs: number): boolean {
    let changed = false;
    for (const s of this.live.values()) {
      const stalled = s.info.status === "working" && !s.info.shell && now - s.lastOutput >= quietMs;
      if (stalled && !s.info.stalledSince) {
        s.info.stalledSince = s.lastOutput;
        changed = true;
      } else if (!stalled && s.info.stalledSince) {
        s.info.stalledSince = null;
        changed = true;
      }
    }
    if (changed) this.emitChanged();
    return changed;
  }

  /** Read the installed versions; panes started before a version was known take the first one read. */
  setAgentVersions(v: Partial<Record<AgentKind, string>>): void {
    this.agentVersions = { ...this.agentVersions, ...v };
    for (const s of this.live.values()) {
      const kind = s.info.agent ?? "claude";
      if (!s.info.shell && !s.info.agentVersion && v[kind]) s.info.agentVersion = v[kind];
    }
  }

  /** Agents installed at a newer version than some running panes started with. */
  updateNotices(): AgentUpdateNotice[] {
    const out: AgentUpdateNotice[] = [];
    for (const kind of ["claude", "codex"] as AgentKind[]) {
      const installed = this.agentVersions[kind];
      if (!installed) continue;
      const behind = [...this.live.values()]
        .map((s) => s.info)
        .filter((i) => !i.shell && i.status !== "dead" && (i.agent ?? "claude") === kind && i.agentVersion && i.agentVersion !== installed)
        .map((i) => ({ id: i.id, title: i.ticketTitle ?? i.title, version: i.agentVersion! }));
      if (behind.length) out.push({ agent: kind, installed, sessions: behind });
    }
    return out;
  }

  /** Relaunch a persisted session in its old cwd, resuming the conversation. */
  async relaunch(id: string): Promise<SessionInfo | null> {
    const old = this.store.state.sessions.find((s) => s.id === id);
    if (!old) return null;
    // create() re-adds the record; only forget the old one once it has, or a
    // failed relaunch (missing worktree, spawn error) erases the session for good
    // --continue exits immediately when the cwd has no conversation yet (a
    // session that died at startup); such a session relaunches fresh instead
    // Resume the exact conversation this pane last ran when it's still on disk;
    // otherwise fall back to "most recent in this folder", which is ambiguous
    // when several chats started in the same folder (home, WorkTracker).
    const conv = old.conversation && agentFor(old.conversation.agent).conversationExists(old.conversation.id) ? old.conversation : null;
    const sameAgent = conv && conv.agent === (old.agent ?? "claude");
    const resume = !old.shell && !sameAgent && agentFor(old.agent).hasConversation(old.cwd);
    const info = await this.create({
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
      ...(old.shell ? (conv ? { shellResume: conv } : {}) : sameAgent ? { resumeSessionId: conv!.id } : {}),
      reuseId: old.id, // same id → persisted grid position and group still apply
      title: old.title,
      debrief: old.debrief,
      shell: old.shell,
      model: old.model ?? undefined,
      effort: old.effort ?? undefined,
      agent: old.agent,
    });
    // a muted pane stays muted through restarts
    if (old.muted) {
      info.muted = true;
      this.store.upsertSession(info);
    }
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
    // Enter sends the draft and Ctrl-C clears it; escape sequences (arrows, focus
    // reports) don't add text — except a bracketed paste, which is text.
    // Anything else leaves unsent text in the prompt.
    if (/[\r\x03]/.test(data) && !data.startsWith("\x1b[200~")) s.draft = false;
    else if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~")) s.draft = true;
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

  /** Close a pane. Unless `forget`, it stays resumable: its scrollback and undelivered messages are kept for its relaunch. */
  kill(id: string, forget = false): void {
    const s = this.live.get(id);
    if (s) {
      try {
        s.proc.kill();
      } catch {
        /* already dead */
      }
      if (s.flushTimer) clearTimeout(s.flushTimer);
      this.live.delete(id);
    }
    const owed = [...(this.undelivered.get(id) ?? []), ...(s?.queued ?? [])];
    this.undelivered.delete(id);
    if (owed.length && !forget) this.undelivered.set(id, owed);
    else if (owed.length) {
      console.warn(`[sessions] ${id} closed with ${owed.length} undelivered message(s): ${owed.map((m) => JSON.stringify(m.text.slice(0, 100))).join(", ")}`);
    }
    // the pane is closed whether or not its scrollback can be saved
    try {
      if (forget) this.dropScrollback(id);
      else if (s) this.writeScrollback(s);
    } catch (err) {
      console.error(`[sessions] couldn't ${forget ? "remove" : "save"} scrollback for ${id}:`, err);
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
   * a pending permission prompt). While the user has unsent text in that prompt
   * it waits for them to send it; see flushQueued.
   */
  deliverAgentMessage(id: string, message: string, submit: boolean): string {
    const s = this.live.get(id);
    if (!s) throw new Error(`session ${id} is not running`);
    s.queued.push({ text: message, submit });
    if (s.info.status === "idle") {
      this.flushQueued(s);
      this.emitChanged();
      return s.queued.length ? "queued — the user has an unsent draft in that pane" : submit ? "delivered" : "placed in its prompt for the user to send";
    }
    this.emitChanged();
    return "queued until its current turn ends";
  }

  /** Broadcast to sessions; queue for busy ones (delivered on the next idle).
   *  Shell sessions are always skipped — a broadcast typed into a shell would
   *  execute as commands — and so are debriefs, which are mid-interview. */
  broadcast(message: string, sessionIds: string[], whenIdle: boolean): BroadcastOutcome[] {
    const targets = sessionIds.length
      ? sessionIds
      : [...this.live.values()]
          .filter((s) => s.info.kind === "work" && !s.info.shell)
          .map((s) => s.info.id);
    const outcomes: BroadcastOutcome[] = [];
    for (const id of targets) {
      const s = this.live.get(id);
      if (!s || s.info.status === "dead" || s.info.shell || s.info.debrief) {
        outcomes.push({ id, outcome: "skipped" });
        continue;
      }
      if (!whenIdle) {
        this.sendMessage(id, message);
        outcomes.push({ id, outcome: "delivered" });
        continue;
      }
      // "waiting" counts as busy: sendMessage ends with Enter, which would
      // answer whatever prompt is blocking the session — including a pending
      // permission request the user has not looked at yet. An idle pane goes
      // through the queue too, which holds it while the user has unsent text
      // in the prompt (Enter would send that along with it).
      s.queued.push({ text: message, submit: true });
      if (s.info.status === "idle") this.flushQueued(s);
      outcomes.push({ id, outcome: s.queued.length ? "queued" : "delivered" });
    }
    this.emitChanged();
    return outcomes;
  }

  /**
   * Called by the hooks watcher. Every pane exports MOCKINGBIRD_SESSION, which
   * its agent's hooks inherit, so an event names its pane exactly. Events
   * without it (a pane started by an older build) fall back to the agent's own
   * conversation id, then to the folder — which is ambiguous: two panes can
   * share a folder, and an agent that cd's reports the new folder.
   */
  statusFromHook(ev: {
    status: SessionStatus;
    cwd?: string;
    reason?: string;
    conversationId?: string;
    agent?: AgentKind;
    paneId?: string;
  }): SessionInfo | null {
    // a tagged event that names no live pane comes from something else Mockingbird
    // runs (a Collaborate room) or a closed pane — never guess a pane for it
    const s = ev.paneId ? this.live.get(ev.paneId) ?? null : this.matchSession(ev.cwd, ev.conversationId);
    // events arrive up to a poll late: one written just before the agent exited
    // must not bring its dead pane back to life
    if (!s || s.info.status === "dead") return null;
    if (ev.conversationId) this.noteConversation(s, ev.agent ?? s.info.agent ?? "claude", ev.conversationId);
    this.setStatus(s.info.id, ev.status, ev.reason);
    // deliver queued broadcasts whenever the session frees up (a session can
    // reach idle from waiting too — e.g. a declined permission, or the idle
    // reminder — and those queues used to strand forever)
    if (ev.status === "idle") this.flushQueued(s);
    return s.info;
  }

  /** The pane's current conversation is what a relaunch resumes; /clear starts a new one. */
  private noteConversation(s: LiveSession, agent: AgentKind, id: string): void {
    const cur = s.info.conversation;
    if (cur?.id === id && cur.agent === agent && conversationsOf(s.info).includes(id)) return;
    s.info.conversations = withConversation(s.info, id);
    s.info.conversation = { agent, id };
    this.store.upsertSession(s.info);
  }

  /**
   * The pane an untagged event belongs to: the one running its conversation,
   * wherever that has cd'd to since; else one in its folder. statusFromHook
   * then records the conversation as that pane's.
   */
  private matchSession(cwd: string | undefined, conversationId?: string): LiveSession | null {
    const all = [...this.live.values()];
    if (conversationId) {
      const bound = all.find((s) => s.info.conversation?.id === conversationId);
      if (bound) return bound;
    }
    if (!cwd) return null;
    const inCwd = all.filter((s) => s.info.cwd === cwd);
    if (!inCwd.length) return null;
    if (conversationId) {
      // a pane with no conversation yet takes it; when every pane here runs
      // another one (the CLI was restarted inside a pane), the newest does
      return inCwd.find((s) => !s.info.conversation) ?? inCwd[inCwd.length - 1];
    }
    return inCwd[0];
  }

  /**
   * Deliver messages queued while a session was busy. Pasting next to an
   * unsent draft would send the user's half-written prompt with it, so a
   * pending draft holds the queue until the user sends it (their turn then
   * ends in idle, which flushes). A draft left untouched for DRAFT_GIVE_UP_MS
   * gets the messages placed after it without Enter, for the user to see and
   * send themselves.
   *
   * Enter submits everything in the prompt, so one message is submitted per
   * turn — the pane is then working, and the rest wait for it to end.
   * Messages meant to be left for the user go once none are left to submit,
   * and the text they leave in the prompt then counts as a draft.
   */
  private flushQueued(s: LiveSession): void {
    if (!s.queued.length || s.info.status === "dead") return;
    const DRAFT_GIVE_UP_MS = 120_000;
    const RECHECK_MS = 5_000;
    const idleFor = Date.now() - s.lastInput;
    if (s.draft) {
      if (idleFor < DRAFT_GIVE_UP_MS) {
        if (s.flushTimer) clearTimeout(s.flushTimer);
        s.flushTimer = setTimeout(() => {
          s.flushTimer = null;
          if (this.live.get(s.info.id) === s && s.info.status === "idle") this.flushQueued(s);
        }, Math.min(RECHECK_MS, DRAFT_GIVE_UP_MS - idleFor));
        return;
      }
      for (const m of s.queued.splice(0)) this.sendMessage(s.info.id, m.text, false);
      this.emitChanged();
      return;
    }
    const next = s.queued.findIndex((m) => m.submit);
    if (next >= 0) {
      const [m] = s.queued.splice(next, 1);
      this.sendMessage(s.info.id, m.text, true);
      this.setStatus(s.info.id, "working");
      return;
    }
    for (const m of s.queued.splice(0)) this.sendMessage(s.info.id, m.text, false);
    s.draft = true;
    s.lastInput = Date.now();
    this.emitChanged();
  }

  private setStatus(id: string, status: SessionStatus, reason?: string): void {
    const s = this.live.get(id);
    if (!s || s.info.status === "dead") return; // its pty has exited; only a relaunch (a new pty) revives it
    if (s.info.status === status && (status !== "waiting" || !reason)) return;
    s.info.status = status;
    if (status !== "working") s.info.stalledSince = null;
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
