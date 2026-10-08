import * as path from "path";
import { applyPlanOp, opFromTool, planOfRoom } from "./board";
import { agentContextText, excludePlanDir, pruneWarned, removePlanCopy, worktreesOf, writePlanCopy, type PlanCopy } from "./claims";
import { fetchOrigin, originKey, publishPlan, pushedBranchFiles, type PlanRender } from "./planGit";
import { TEAM_DIR } from "./identity";
import type { Team, Unsubscribe } from "./transport";
import { readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { BASE_NAMES, originUrl, publicUrl } from "../git";
import { mainCheckout } from "../runProfile";
import type { TeammateChanges } from "../conflicts";
import type { ClaimEvent } from "../hooks";
import {
  claimsFile,
  claimsRoom,
  describeChange,
  memberName,
  PLAN_BRANCH,
  PLAN_FILE,
  renderPlanMarkdown,
  type PlanWarningNotice,
  type PlanGitStatus,
  type PlanOp,
  type PlanRepoChoice,
  type PlanView,
  type TeammateBranch,
} from "../../shared/team/plan";
import { topOfKey, type SessionInfo } from "../../shared/types";
import type { MemberId, RoomEvent, RoomId, RoomState } from "../../shared/team/types";

/**
 * The plan board inside the app: keeps every room's board in git and in the
 * room repo's worktrees, answers the window and the agents' tool, turns the
 * claims check's warnings into notices, and reads teammates' pushed branches
 * for the overlap check.
 *
 * Git follows the room log: whoever made a change commits and pushes it right
 * away; a teammate's change is checked a little later (repairSyncMs), so a push
 * that failed on their side still lands, and when everyone's logs agree the
 * check finds the branch current and does nothing.
 */

export interface PlanServiceDeps {
  /** The rooms this install is in, with the local group each is shown as. */
  roomGroups: () => { roomId: RoomId; groupKey: string }[];
  /** Live sessions. */
  sessions: () => SessionInfo[];
  /** Folders that may be clones of a room's repo (sessions' repos, the repo index). */
  knownRepos: () => string[];
  emit: (channel: string, payload: unknown) => void;
  log: (context: string, err: unknown) => string;
  /** An OS notification. */
  notify?: (title: string, body: string, sessionId?: string) => void;
  /** Teammates' branch files changed: the overlap check should look again. */
  overlapsChanged?: () => void;
  /** Who commits the plan when the repo has no git identity of its own. */
  author: () => { name: string };
  /** Where the worktrees holding a copy are remembered (default ~/.mockingbird/team/plan-copies.json). */
  copiesFile?: string;
  timing?: Partial<Timing>;
}

interface Timing {
  /** After this install's own change: commit and push. */
  ownSyncMs: number;
  /** After a teammate's change: check origin has it. */
  repairSyncMs: number;
  /** How often sessions are looked at (new worktrees, branches to announce). */
  pollMs: number;
  /** How often teammates' branches are fetched. */
  fetchMs: number;
}

const DEFAULT_TIMING: Timing = { ownSyncMs: 300, repairSyncMs: 20_000, pollMs: 5_000, fetchMs: 5 * 60_000 };
const ORIGIN_TTL_MS = 5 * 60_000;
const REPEAT_NOTICE_MS = 10 * 60_000;
/** How long a conversation's "already warned" files are remembered. */
const WARNED_TTL_MS = 14 * 24 * 3_600_000;
const BASES = new Set([...BASE_NAMES.dev, ...BASE_NAMES.main, PLAN_BRANCH]);

let active: PlanService | null = null;

/**
 * What an agent launched in a room starts with (stage 2 appends it to a room
 * session's system prompt, and sets PLAN_CONTEXT_ENV so the SessionStart hook
 * doesn't add it again).
 */
export function roomAgentContext(roomId: RoomId): string {
  if (!active) throw new Error("The plan board hasn't started");
  return active.agentContext(roomId);
}

/** The mockingbird MCP tool update_team_plan, for a session (src/main/messaging.ts routes it here). */
export function planToolCall(sessionId: string, args: Record<string, unknown>): { result: string } | { error: string } {
  if (!active) return { error: "Mockingbird's team plan isn't running (team rooms couldn't start) — tell your user." };
  return active.toolCall(sessionId, args);
}

export class PlanService {
  private team: Team | null = null;
  private offs: Unsubscribe[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private t: Timing;
  private git = new Map<RoomId, PlanGitStatus & { timer?: ReturnType<typeof setTimeout>; due?: number; chain: Promise<void> }>();
  private origins = new Map<string, { main: string; key: string | null; url: string | null; at: number }>();
  /** Worktrees holding a copy, and the clone each belongs to. */
  private copies = new Map<string, string>();
  private copiesFile: string;
  private copyRun: Promise<void> | null = null;
  private copyAgain = false;
  private sessionSig = "";
  private roomsSig = "";
  private repeatNotices = new Map<string, number>();
  private teammates = new Map<RoomId, TeammateBranch[]>();
  private fetched = new Map<RoomId, { at: number; problem?: string }>();
  private emitTimers = new Map<RoomId, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private d: PlanServiceDeps) {
    this.t = { ...DEFAULT_TIMING, ...(d.timing ?? {}) };
    this.copiesFile = d.copiesFile ?? path.join(TEAM_DIR, "plan-copies.json");
  }

  start(team: Team): void {
    this.team = team;
    active = this;
    const v = readJsonOrSetAside(this.copiesFile, [], "the plan copies' list");
    for (const e of Array.isArray(v) ? v : []) if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") this.copies.set(e[0], e[1]);
    this.offs.push(
      team.onEvent("*", (e, room) => this.onEvent(e, room)),
      team.onPresence((roomId) => this.emitSoon(roomId)),
      team.onRoomsChanged(() => {
        for (const r of team.rooms()) this.emitSoon(r.id);
        // the copies name rooms and members: rewrite them only when those changed, not on every room event
        const sig = team
          .rooms()
          .map((r) => `${r.id}\t${r.name}\t${r.members.map((m) => `${m.id}=${m.name}`).join(",")}`)
          .sort()
          .join("\n");
        if (sig === this.roomsSig) return;
        this.roomsSig = sig;
        this.refreshCopies();
      })
    );
    this.timers.push(
      setInterval(() => void this.poll(), this.t.pollMs),
      setInterval(() => {
        for (const r of team.rooms()) {
          if (planOfRoom(r).repo) void this.refreshTeammates(r.id, true);
          if (this.git.get(r.id)?.state === "error") this.scheduleSync(r.id, 0);
        }
      }, this.t.fetchMs)
    );
    for (const t of this.timers) t.unref?.();
    try {
      pruneWarned(WARNED_TTL_MS);
    } catch (err) {
      this.d.log("team plan: forgetting old claim warnings", err);
    }
    this.refreshCopies();
    for (const r of team.rooms()) {
      if (!planOfRoom(r).repo) continue;
      // changes made while this app was closed, or pushes that failed then
      this.scheduleSync(r.id, this.t.repairSyncMs);
      void this.refreshTeammates(r.id, true);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs) off();
    for (const t of this.timers) clearInterval(t);
    for (const g of this.git.values()) if (g.timer) clearTimeout(g.timer);
    for (const t of this.emitTimers.values()) clearTimeout(t);
    if (active === this) active = null;
  }

  /** Every sync and copy write in flight, done (tests; quitting). */
  async idle(): Promise<void> {
    for (;;) {
      const chains = [...this.git.values()].map((g) => g.chain);
      await Promise.all([...chains, this.copyRun]);
      const settled = [...this.git.values()].every((g, i) => !g.timer && g.chain === chains[i]) && chains.length === this.git.size;
      if (settled && !this.copyRun) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // ---- the window -------------------------------------------------------------------------

  view(roomId: RoomId): PlanView {
    const room = this.room(roomId);
    const team = this.team!;
    const online = new Set(team.presence(roomId));
    const f = this.fetched.get(roomId);
    return {
      roomId,
      room: room.name,
      self: team.self.id,
      members: room.members.map((m) => ({ id: m.id, name: m.name, self: m.id === team.self.id, online: online.has(m.id) })),
      plan: planOfRoom(room),
      git: this.gitStatus(roomId),
      teammates: this.teammates.get(roomId) ?? [],
      fetchedAt: f?.at ?? 0,
      ...(f?.problem ? { fetchProblem: f.problem } : {}),
    };
  }

  /** One board change by this install's member; git and the copies follow. */
  apply(roomId: RoomId, op: PlanOp, via?: string): { pkg: string | null } {
    const { pkg } = applyPlanOp(this.need(), roomId, op, via);
    return { pkg };
  }

  /** Repos the plan can be kept in: clones of the room's sessions' repos first, then the rest Mockingbird knows. */
  async repoChoices(roomId: RoomId): Promise<PlanRepoChoice[]> {
    const group = this.groupOf(roomId);
    const inRoom = new Set(this.d.sessions().filter((s) => group && s.repoPath && topOfKey(s.taskGroup ?? "ungrouped") === group).map((s) => s.repoPath!));
    const out: PlanRepoChoice[] = [];
    for (const repo of [...new Set([...inRoom, ...this.d.knownRepos()])]) {
      const o = await this.origin(repo);
      if (!o.url || out.some((c) => c.path === o.main)) continue;
      out.push({ path: o.main, name: path.basename(o.main), origin: publicUrl(o.url), inRoom: inRoom.has(repo) });
    }
    return out.sort((a, b) => Number(b.inRoom) - Number(a.inRoom) || a.name.localeCompare(b.name));
  }

  /** Commit and push now, rewrite the copies, and fetch teammates' branches. */
  async syncNow(roomId: RoomId): Promise<PlanView> {
    this.room(roomId);
    this.scheduleSync(roomId, 0);
    this.refreshCopies();
    const g = this.gitEntry(roomId);
    await this.refreshTeammates(roomId, true);
    while (g.timer) await new Promise((r) => setTimeout(r, 10));
    await Promise.all([g.chain, this.copyRun]);
    return this.view(roomId);
  }

  // ---- agents ---------------------------------------------------------------------------------

  agentContext(roomId: RoomId): string {
    const room = this.room(roomId);
    return agentContextText({ name: room.name, teammates: room.members.filter((m) => m.id !== this.team!.self.id).map((m) => m.name) }, null);
  }

  toolCall(sessionId: string, args: Record<string, unknown>): { result: string } | { error: string } {
    const s = this.d.sessions().find((x) => x.id === sessionId);
    if (!s) return { error: "Your session is not known to Mockingbird (it may have been restarted)." };
    const group = s.taskGroup ? topOfKey(s.taskGroup) : null;
    const roomId = group ? this.d.roomGroups().find((r) => r.groupKey === group)?.roomId : undefined;
    if (!roomId || !this.team?.room(roomId)) return { error: "This session isn't in a shared team room, so it has no team plan." };
    let op: PlanOp;
    try {
      op = opFromTool(args);
    } catch (err) {
      return { error: (err as Error).message };
    }
    try {
      const { pkg } = this.apply(roomId, op, s.ticketTitle ?? s.title);
      const room = this.team.room(roomId)!;
      const last = planOfRoom(room).changes.at(-1);
      const done = last ? describeChange(last, (id) => memberName(room.members, id)) : "Done";
      return { result: `${done}${op.kind === "create" && pkg ? ` (id ${pkg})` : ""}. Your teammates see it now; ${PLAN_FILE} updates in a moment.` };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** A warning the claims check gave an agent (or its failure): the window shows it, and a held-back edit notifies. */
  claimEvent(e: ClaimEvent): void {
    if (e.kind === "failed") {
      const why = this.d.log("team plan: the claims check in an agent's hook failed (the edit went ahead unchecked)", e.message);
      this.d.emit("plan:warning", { at: Date.now(), sessionId: e.pane || null, sessionTitle: this.titleOf(e.pane), decision: "failed", tool: "", conflicts: [], error: why } satisfies PlanWarningNotice);
      return;
    }
    const w = e.warning;
    // an agent working through a teammate's file repeats the edit many times: one notice for those a while
    if (w.decision === "context") {
      const key = `${w.conversation}\n${w.conflicts.map((c) => `${c.root}/${c.file}`).sort().join("\n")}`;
      const last = this.repeatNotices.get(key) ?? 0;
      if (Date.now() - last < REPEAT_NOTICE_MS) return;
      this.repeatNotices.set(key, Date.now());
    }
    const live = this.d.sessions();
    const s = (w.pane && live.find((x) => x.id === w.pane)) || live.filter((x) => w.cwd && (w.cwd === x.cwd || w.cwd.startsWith(`${x.cwd}/`))).sort((a, b) => b.cwd.length - a.cwd.length)[0];
    const notice: PlanWarningNotice = { at: Date.now(), sessionId: s?.id ?? null, sessionTitle: s ? s.ticketTitle ?? s.title : path.basename(w.cwd || "an agent"), decision: w.decision, tool: w.tool, conflicts: w.conflicts };
    this.d.emit("plan:warning", notice);
    if (w.decision === "deny") {
      const first = w.conflicts[0];
      const hit = first?.hits[0];
      if (hit) this.d.notify?.(`${hit.owner.name}'s package`, `${notice.sessionTitle} tried to edit ${first.file} — it's in "${hit.title}". The agent was held back once and can go ahead.`, s?.id);
    }
  }

  // ---- overlaps --------------------------------------------------------------------------------

  /** Teammates' pushed branches with the files they change, for the overlap check. */
  teammateChanges(): TeammateChanges[] {
    const out: TeammateChanges[] = [];
    for (const [roomId, list] of this.teammates) for (const t of list) if (!t.problem && t.files.length) out.push({ roomId, member: t.member, name: t.name, branch: t.branch, repo: t.repo, files: t.files });
    return out;
  }

  // ---- internals --------------------------------------------------------------------------------

  private need(): Team {
    if (!this.team) throw new Error("Team rooms haven't started");
    return this.team;
  }

  private room(roomId: RoomId): RoomState {
    const room = this.need().room(roomId);
    if (!room) throw new Error(`Not a member of room ${roomId}`);
    return room;
  }

  private groupOf(roomId: RoomId): string | null {
    return this.d.roomGroups().find((r) => r.roomId === roomId)?.groupKey ?? null;
  }

  private titleOf(sessionId: string): string {
    const s = this.d.sessions().find((x) => x.id === sessionId);
    return s ? s.ticketTitle ?? s.title : "an agent";
  }

  private onEvent(e: RoomEvent, room: RoomState): void {
    if (!e.type.startsWith("plan.") || this.stopped) return;
    this.emitSoon(room.id);
    if (e.type === "plan.branches") {
      if (e.author !== this.team!.self.id) void this.refreshTeammates(room.id, true);
      return;
    }
    this.refreshCopies();
    if (e.type === "plan.repo") {
      this.sessionSig = ""; // announce this member's branches in the repo at the next poll
      void this.refreshTeammates(room.id, true);
    }
    this.scheduleSync(room.id, e.author === this.team!.self.id ? this.t.ownSyncMs : this.t.repairSyncMs);
  }

  private emitSoon(roomId: RoomId): void {
    if (this.emitTimers.has(roomId) || this.stopped) return;
    this.emitTimers.set(
      roomId,
      setTimeout(() => {
        this.emitTimers.delete(roomId);
        if (!this.team?.room(roomId)) return;
        try {
          this.d.emit("plan:changed", this.view(roomId));
        } catch (err) {
          this.d.log(`team plan: sending room ${roomId}'s board to the window`, err);
        }
      }, 50)
    );
  }

  private gitStatus(roomId: RoomId): PlanGitStatus {
    const g = this.git.get(roomId);
    const repo = planOfRoom(this.room(roomId)).repo;
    if (!repo) return { repo: null, clones: [], state: "unbound", copies: 0 };
    return {
      repo,
      clones: g?.clones ?? [],
      state: g?.state ?? "pending",
      ...(g?.commit ? { commit: g.commit } : {}),
      ...(g?.problem ? { problem: g.problem } : {}),
      copies: g?.copies ?? 0,
      ...(g?.copiesProblem ? { copiesProblem: g.copiesProblem } : {}),
    };
  }

  private gitEntry(roomId: RoomId) {
    let g = this.git.get(roomId);
    if (!g) this.git.set(roomId, (g = { repo: null, clones: [], state: "pending", copies: 0, chain: Promise.resolve() }));
    return g;
  }

  /** Commit and push the room's board after `delayMs` (an earlier time wins; one sync at a time per room). */
  private scheduleSync(roomId: RoomId, delayMs: number): void {
    if (this.stopped) return;
    const g = this.gitEntry(roomId);
    const due = Date.now() + delayMs;
    if (g.timer && g.due! <= due) return;
    if (g.timer) clearTimeout(g.timer);
    g.due = due;
    g.timer = setTimeout(() => {
      g.timer = undefined;
      g.chain = g.chain.then(() => this.syncGit(roomId));
    }, delayMs);
  }

  private async syncGit(roomId: RoomId): Promise<void> {
    const g = this.gitEntry(roomId);
    const room = this.team?.room(roomId);
    const repo = room ? planOfRoom(room).repo : null;
    if (!room || !repo) return;
    g.state = "syncing";
    this.emitSoon(roomId);
    try {
      const clones = await this.clonesOf(repo.origin);
      g.clones = clones;
      if (!clones.length) {
        g.state = "no-clone";
        g.problem = `No clone of ${repo.name} (${repo.origin}) here: clone it under one of your repo folders to keep the plan in git`;
        return;
      }
      for (const clone of clones) {
        const r = await publishPlan(clone, () => this.render(roomId), { roomId, author: this.d.author() });
        g.commit = { sha: r.commit, at: Date.now(), pushed: r.pushed };
        g.problem = r.pushed ? undefined : `${clone} has no origin remote: the plan is committed there but can't reach your teammates through git`;
      }
      g.state = g.problem ? "error" : "synced";
    } catch (err) {
      g.state = "error";
      g.problem = this.d.log(`team plan: committing ${PLAN_BRANCH} for room ${room.name}`, err);
    } finally {
      this.emitSoon(roomId);
    }
  }

  private render(roomId: RoomId): PlanRender {
    const room = this.room(roomId);
    const plan = planOfRoom(room);
    const last = plan.changes.at(-1);
    return {
      files: { "plan.md": renderPlanMarkdown(room, plan), "claims.json": `${JSON.stringify(claimsFile([claimsRoom(room, plan)]), null, 2)}\n` },
      message: `Plan: ${last ? describeChange(last, (id) => memberName(room.members, id)) : "the board"}\n\nRoom: ${room.name} (${room.id}). Written by Mockingbird from the team room's log.`,
    };
  }

  /** A folder's main checkout and origin (cached a few minutes). */
  private async origin(folder: string): Promise<{ main: string; url: string | null; key: string | null }> {
    const hit = this.origins.get(folder);
    if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit;
    let main = folder;
    let url: string | null = null;
    try {
      main = await mainCheckout(folder);
      url = await originUrl(main);
    } catch (err) {
      this.d.log(`team plan: reading ${folder}'s origin`, err);
    }
    const entry = { main, url, key: url ? originKey(url) : null, at: Date.now() };
    this.origins.set(folder, entry);
    return entry;
  }

  /** This install's clones (main checkouts) of the repo at `origin`. */
  private async clonesOf(origin: string): Promise<string[]> {
    const want = originKey(origin);
    const out: string[] = [];
    for (const folder of new Set(this.d.knownRepos())) {
      const o = await this.origin(folder);
      if (o.key === want && !out.includes(o.main)) out.push(o.main);
    }
    return out;
  }

  /** Rewrite every room repo's worktree copies (one pass at a time; a request during one runs another after). */
  private refreshCopies(): void {
    if (this.stopped) return;
    if (this.copyRun) {
      this.copyAgain = true;
      return;
    }
    this.copyRun = this.writeCopies()
      .catch((err) => void this.d.log("team plan: writing the plan into worktrees", err))
      .finally(() => {
        this.copyRun = null;
        if (this.copyAgain) {
          this.copyAgain = false;
          this.refreshCopies();
        }
      });
  }

  private async writeCopies(): Promise<void> {
    const team = this.need();
    const byClone = new Map<string, RoomState[]>();
    const roomsOfClone = new Map<RoomId, string[]>();
    for (const room of team.rooms()) {
      const repo = planOfRoom(room).repo;
      if (!repo) continue;
      const clones = await this.clonesOf(repo.origin);
      roomsOfClone.set(room.id, clones);
      for (const c of clones) byClone.set(c, [...(byClone.get(c) ?? []), room]);
    }
    const written = new Map<string, string>();
    const perRoom = new Map<RoomId, number>();
    const problems = new Map<RoomId, string>();
    const failed = new Set<string>();
    for (const [clone, rooms] of byClone) {
      try {
        await excludePlanDir(clone);
        const copyFor = (worktree: string): PlanCopy => ({
          plan: rooms.map((r) => renderPlanMarkdown(r, planOfRoom(r))).join("\n---\n\n"),
          claims: `${JSON.stringify(claimsFile(rooms.map((r) => claimsRoom(r, planOfRoom(r))), team.self.id), null, 2)}\n`,
          context: rooms.map((r) => agentContextText({ name: r.name, teammates: r.members.filter((m) => m.id !== team.self.id).map((m) => m.name) }, worktree)).join("\n\n"),
        });
        for (const wt of await worktreesOf(clone)) {
          writePlanCopy(wt, copyFor(wt));
          written.set(wt, clone);
          for (const r of rooms) perRoom.set(r.id, (perRoom.get(r.id) ?? 0) + 1);
        }
      } catch (err) {
        failed.add(clone);
        const why = this.d.log(`team plan: writing the plan into ${clone}'s worktrees`, err);
        for (const r of rooms) problems.set(r.id, `Couldn't write the plan into ${clone}'s worktrees: ${why}`);
      }
    }
    // a clone that failed keeps its copies as they were: removing them would turn the claims check off there
    for (const [wt, clone] of this.copies) {
      if (written.has(wt)) continue;
      if (failed.has(clone)) {
        written.set(wt, clone);
        continue;
      }
      try {
        removePlanCopy(wt);
      } catch (err) {
        this.d.log(`team plan: removing the stale plan copy in ${wt}`, err);
      }
    }
    const listOf = (m: Map<string, string>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1));
    const changed = JSON.stringify(listOf(written)) !== JSON.stringify(listOf(this.copies));
    this.copies = written;
    if (changed) writeFileAtomic(this.copiesFile, JSON.stringify(listOf(written), null, 2));
    for (const room of team.rooms()) {
      const g = this.gitEntry(room.id);
      const n = perRoom.get(room.id) ?? 0;
      const problem = problems.get(room.id);
      if (g.copies !== n || g.copiesProblem !== problem || (roomsOfClone.get(room.id)?.length ?? 0) !== g.clones.length) {
        g.copies = n;
        g.copiesProblem = problem;
        g.clones = roomsOfClone.get(room.id) ?? g.clones;
        this.emitSoon(room.id);
      }
    }
  }

  /** Sessions changed: new worktrees get their copy; this member's branches in each room are announced. */
  private async poll(): Promise<void> {
    const team = this.team;
    if (!team || this.stopped) return;
    const live = this.d.sessions().filter((s) => s.status !== "dead");
    const sig = live.map((s) => `${s.id}\t${s.cwd}\t${s.branch ?? ""}\t${s.taskGroup ?? ""}`).sort().join("\n");
    if (sig === this.sessionSig) return;
    this.sessionSig = sig;
    this.refreshCopies();
    for (const room of team.rooms()) {
      const repo = planOfRoom(room).repo;
      const group = this.groupOf(room.id);
      if (!repo || !group) continue;
      const want = originKey(repo.origin);
      const branches = new Set<string>();
      for (const s of live) {
        if (!s.repoPath || !s.branch || BASES.has(s.branch) || topOfKey(s.taskGroup ?? "ungrouped") !== group) continue;
        if ((await this.origin(s.repoPath)).key === want) branches.add(s.branch);
      }
      const mine = room.ext.memberBranches?.[team.self.id];
      const next = [...branches].sort();
      // a repo chosen before origins were checked for credentials can still carry them
      const origin = publicUrl(repo.origin);
      if (mine && mine.origin === origin && mine.branches.join("\n") === next.join("\n")) continue;
      if (!mine && !next.length) continue;
      try {
        team.publish(room.id, "plan.branches", { origin, branches: next });
      } catch (err) {
        this.d.log(`team plan: announcing your branches in room ${room.name}`, err);
      }
    }
  }

  /** Read teammates' announced branches from origin (fetching first when `fetch`), and the files each changes. */
  private async refreshTeammates(roomId: RoomId, fetch: boolean): Promise<void> {
    const team = this.team;
    const room = team?.room(roomId);
    const repo = room ? planOfRoom(room).repo : null;
    if (!team || !room || !repo) return;
    const clones = await this.clonesOf(repo.origin);
    const want = originKey(repo.origin);
    const out: TeammateBranch[] = [];
    let problem: string | undefined;
    for (const clone of clones.slice(0, 1)) {
      if (fetch) {
        try {
          await fetchOrigin(clone);
          problem = undefined;
        } catch (err) {
          problem = this.d.log(`team plan: fetching teammates' branches into ${clone}`, err);
        }
        this.fetched.set(roomId, { at: Date.now(), ...(problem ? { problem } : {}) });
      }
      for (const [member, mb] of Object.entries(room.ext.memberBranches ?? {}) as [MemberId, { origin: string; branches: string[] }][]) {
        if (member === team.self.id || originKey(mb.origin) !== want) continue;
        const name = memberName(room.members, member);
        for (const branch of mb.branches) {
          const r = await pushedBranchFiles(clone, branch).catch((err: Error) => ({ problem: err.message }));
          if ("problem" in r) out.push({ member, name, branch, repo: clone, files: [], problem: r.problem });
          else out.push({ member, name, branch, repo: clone, files: r.files });
        }
      }
    }
    const before = JSON.stringify(this.teammates.get(roomId) ?? []);
    this.teammates.set(roomId, out);
    if (JSON.stringify(out) !== before) this.d.overlapsChanged?.();
    this.emitSoon(roomId);
  }
}
