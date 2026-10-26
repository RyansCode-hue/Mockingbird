import * as path from "path";
import { isBase, type HouseService } from "./houseService";
import { samePath } from "../handlers";
import { named } from "../../shared/team/agentText";
import { BRANCH_RE, isTicketNumber } from "../../shared/team/house";
import {
  holderOf,
  ticketBranch,
  ticketBrief,
  ticketSessionTitle,
  type TicketRepo,
  type TicketSessionFailure,
  type TicketSessionPlan,
  type TicketSessionRequest,
  type TicketSessionResult,
  type TicketSessionStep,
} from "../../shared/team/ticketSession";
import { AGENT_KINDS, AGENT_NAME, type AgentKind, type NewSessionRequest, type SessionInfo } from "../../shared/types";
import type { RoomId } from "../../shared/team/types";

/**
 * A session from a House ticket in one go (docs/team-rooms.md, "Start a
 * session from a ticket"): claim the ticket as this member, make its branch's
 * worktree in a clone of the room's repository, and start an agent there in
 * the room's group with the ticket as its brief. The steps reuse the board's
 * claim and release (HouseService.write, this member's builder token) and New
 * session's start (SessionManager.create, which makes the worktree); this
 * file only orders them and undoes what one did when a later one fails.
 *
 * Every refusal is a TicketSessionFailure naming the step: nothing after it
 * ran, and a claim Start made is released again — or, when that fails too,
 * the answer says it's still held (`stillClaimed`).
 */

export interface TicketSessionDeps {
  house: Pick<HouseService, "ticket" | "write" | "startContext" | "roomRepos">;
  /** The repos this Mac knows (the repo index): offered when no session in the room has worked in one yet. */
  knownRepos: () => string[];
  /** New session's start: the worktree on `branchName`, then the agent in it. */
  createSession: (req: NewSessionRequest) => Promise<SessionInfo>;
  /** The dev/main-style branch a repo's new branches are cut from (origin/<base>); null: the repo's HEAD. */
  baseOf: (repo: string) => Promise<string | null>;
  log: (context: string, err: unknown) => string;
}

/** Repos offered when the room's repository isn't known, at most; and how many of them get their base read for the plan. */
const GUESSES_MAX = 40;
const BASES_READ = 5;

export class TicketSessions {
  constructor(private d: TicketSessionDeps) {}

  /** What Start would do for ticket `n`, read now: who has it, its branch, the clones to start in. Throws a message fit for the user. */
  async plan(roomId: RoomId, n: number): Promise<TicketSessionPlan> {
    if (!isTicketNumber(n)) throw new Error(`${n} isn't a ticket number`);
    const ctx = this.d.house.startContext(roomId);
    if (!ctx.group) throw new Error(`Room ${named(ctx.room)} isn't shared from this Mac's sidebar any more`);
    const v = await this.d.house.ticket(roomId, n);
    if ("error" in v) throw new Error(v.error);
    const holder = holderOf(v.detail, v.owner);
    const { branch, from } = ticketBranch(v.detail, holder, ctx.branches);
    const { repos, note } = await this.repos(roomId, ctx.room, ctx.project ?? "", n);
    const withBases = await Promise.all(repos.map(async (p, i): Promise<TicketRepo> => ({ path: p, name: path.basename(p), base: i < BASES_READ && from === "new" ? await this.base(p) : null })));
    return { roomId, room: ctx.room, group: ctx.group, project: ctx.project ?? "", n, title: v.detail.title, holder, branch, branchFrom: from, repos: withBases, repoNote: note };
  }

  /** Claim, make the worktree, start the agent. Every failure says which step stopped it and leaves the House as it was. */
  async start(roomId: RoomId, req: Partial<TicketSessionRequest>): Promise<TicketSessionResult> {
    const fail = (step: TicketSessionStep, error: string, more: Partial<TicketSessionFailure> = {}): TicketSessionFailure => ({ error, step, ...more });
    const n = Number(req.n);
    if (!isTicketNumber(n)) return fail("read", "That isn't a ticket number");
    const agent: AgentKind = AGENT_KINDS.includes(req.agent as AgentKind) ? (req.agent as AgentKind) : "claude";
    const ctx = this.d.house.startContext(roomId);
    if (!ctx.group || !ctx.project) return fail("read", ctx.project ? `Room ${named(ctx.room)} isn't shared from this Mac's sidebar any more` : `Room ${named(ctx.room)} isn't connected to a House project`);

    // 1. the ticket as the House has it now: who has it decides whether Start claims it
    const v = await this.d.house.ticket(roomId, n);
    if ("error" in v) return fail("read", `Couldn't read #${n} from the House, so nothing was started: ${v.error}`);
    const holder = holderOf(v.detail, v.owner);
    if (holder.state === "closed") return fail("closed", `#${n} is ${v.detail.status}: only open tickets get a session (staff reopen closed ones).`);
    if (holder.state === "taken") return fail("claim", `#${n} is ${holder.by}'s${v.detail.claim?.branch ? `, on ${v.detail.claim.branch}` : ""}: nothing was started. Ask ${holder.by} to release it, or start on another ticket.`, { takenBy: holder.by });

    // 2. a clone of the room's repository, before anything is written
    const repoPath = String(req.repoPath ?? "");
    const { repos, note } = await this.repos(roomId, ctx.room, ctx.project, n);
    const repo = repos.find((p) => repoPath && samePath(p, repoPath));
    if (!repo) return fail("repo", !repos.length ? note ?? "No repository to start in" : `${repoPath || "No folder"} isn't a clone of room ${named(ctx.room)}'s repository here: pick one of ${repos.map((p) => path.basename(p)).join(", ")}.`);

    const picked = ticketBranch(v.detail, holder, ctx.branches);
    const branch = picked.from === "new" && req.branch?.trim() ? req.branch.trim() : picked.branch;
    if (!BRANCH_RE.test(branch)) return fail("branch", `${JSON.stringify(branch)} isn't a branch name git would take`);
    if (isBase(branch)) return fail("branch", `${branch} is a base branch: a ticket's work goes on its own branch (feature/${n}-…)`);

    // 3. the claim, unless it's this member's already
    let claimed = false;
    if (holder.state === "free") {
      try {
        await this.d.house.write(roomId, { kind: "claim", n, branch });
        claimed = true;
      } catch (err) {
        const why = (err as Error).message;
        if (!/\b409\b/.test(why)) return fail("claim", `Couldn't claim #${n}, so nothing was started: ${why}`);
        // someone claimed it since it was read: say who, as the House has it now
        const now = await this.d.house.ticket(roomId, n);
        if ("error" in now) this.d.log(`team House board: reading who claimed #${n} after the House refused Start's claim`, now.error);
        const by = "error" in now ? null : now.owner?.name ?? now.detail.claim?.by ?? null;
        return fail("claim", `${by ? `${by} claimed #${n}` : `Someone claimed #${n}`} just before you, so nothing was started. The House answered: ${why}`, by ? { takenBy: by } : {});
      }
    }

    // 4. the worktree and the agent, in the room's group, briefed on the ticket
    const base = picked.from === "new" ? await this.base(repo) : null;
    try {
      const session = await this.d.createSession({
        repoPath: repo,
        useWorktree: true,
        branchName: branch,
        ...(base ? { baseBranch: base } : {}),
        taskGroup: ctx.group,
        agent,
        title: ticketSessionTitle(n, v.detail.title),
        initialPrompt: ticketBrief({ detail: v.detail, project: ctx.project, room: ctx.room, branch, claimed }),
      });
      const who = AGENT_NAME[agent];
      return { session, claimed, branch, message: claimed ? `Claimed #${n} and started ${who} on ${branch}` : `Started ${who} on ${branch} (#${n} was yours already)` };
    } catch (err) {
      const why = this.d.log(`team House board: starting a session on #${n} in ${repo} (${branch})`, err);
      if (!claimed) return fail("session", `Couldn't make #${n}'s worktree or start its session: ${why}. #${n} stays yours, as it was.`);
      try {
        await this.d.house.write(roomId, { kind: "release", n });
        return fail("session", `Couldn't make #${n}'s worktree or start its session: ${why}. Released #${n} again, so it's unclaimed as before.`);
      } catch (e2) {
        const why2 = this.d.log(`team House board: releasing #${n} after its session didn't start`, e2);
        return fail("session", `Couldn't make #${n}'s worktree or start its session: ${why}. #${n} is still claimed by you on ${branch}: releasing it failed (${why2}).`, { stillClaimed: true });
      }
    }
  }

  /**
   * Clones of the room's repository to start in. The room's sessions name it
   * by origin; when none has worked in a repository yet, any known repo may be
   * picked, one named like the House project first. `note` says which
   * repository is needed when none is offered, or that the offer is a guess.
   */
  private async repos(roomId: RoomId, room: string, project: string, n: number): Promise<{ repos: string[]; note: string | null }> {
    const known = await this.d.house.roomRepos(roomId);
    const clones = [...new Set(known.flatMap((r) => r.clones))];
    if (clones.length) return { repos: clones, note: null };
    if (known.length) {
      const which = known.map((r) => `${r.names.length ? r.names.join(" / ") : path.basename(r.key)} (${r.key})`).join(", or ");
      return { repos: [], note: `#${n}'s work goes in room ${named(room)}'s repository, ${which}, which isn't cloned on this Mac. Clone it into one of your repo folders (Settings → General), then start again.` };
    }
    const all = this.d.knownRepos();
    const alike = all.filter((p) => !!project && path.basename(p).toLowerCase() === project.toLowerCase());
    const offered = [...alike, ...all.filter((p) => !alike.includes(p))].slice(0, GUESSES_MAX);
    if (!offered.length) return { repos: [], note: `No session in room ${named(room)} has worked in a repository yet, and there's none in your repo folders (Settings → General): clone the one #${n}'s work goes in first.` };
    return {
      repos: offered,
      note: `No session in room ${named(room)} has worked in a repository yet, so Mockingbird doesn't know which one #${n}'s work goes in${alike.length ? `: ${path.basename(alike[0])} is named like the House project` : ""}. Pick the clone it goes in.`,
    };
  }

  private async base(repo: string): Promise<string | null> {
    try {
      return await this.d.baseOf(repo);
    } catch (err) {
      // a new branch is then cut from the clone's HEAD, as New session does without a base
      this.d.log(`team House board: reading ${repo}'s base branch for a ticket's new branch`, err);
      return null;
    }
  }
}
