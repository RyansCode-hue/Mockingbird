import * as fs from "fs";
import { shownFailure } from "./safeGit";
import type { PipelineStore } from "./pipeline";
import type { OfferHow } from "./wireDelivery";
import type { PrMerge } from "./wirePrompt";
import type { MergeFill } from "./wireTools";
import { plainLine } from "../shared/team/agentText";
import { BY_MERGE, BY_YOU, PR_WATCH_NEEDS_YOU, ticketOfSession, type PipelinePr, type PrState, type SessionInfo, type TicketPipeline } from "../shared/types";
import { carriesWork, wiresInOrder, type FinishOutcome, type MergeView, type Wire, type WireEnd, type WireState } from "../shared/wires";

/**
 * A pull request merging as a wire's When (docs/landscape-wires.md, W16). Every PR_TTL_MS it reads each pull request in
 * pipeline.json that something waits on and hasn't merged or closed: its ticket at that PR's stage, or a pr-merged wire
 * from a session on its ticket and branch. A merge is saved (when, its merge commit), moves the ticket on from its PR
 * stage, and readies each such wire once per PR, through delivery's offer. A read that fails is never taken for "not
 * merged": it's logged, kept on the PR (`watch`), drawn on the wire as blocked and shown on the PR's row, backs off to
 * PR_BACKOFF_MAX_MS, and after PR_WATCH_NEEDS_YOU in a row needs the user (prNeedsYou, a notice), who can Check now or
 * Mark merged…. Mark merged… is a window call only: no tool reaches it.
 */

/** How often a pull request something waits on is read: the pane's lookup's two minutes. */
export const PR_TTL_MS = 120_000;
/** The longest a failing read backs off to. */
export const PR_BACKOFF_MAX_MS = 10 * 60_000;
/** The first check after a start, once the window and team rooms have had a moment. */
export const PR_FIRST_CHECK_MS = 15_000;

/** How long after `failures` failed reads in a row the next is due: 2, 4, 8, then 10 minutes. */
export const backoffMs = (failures: number): number => Math.min(PR_BACKOFF_MAX_MS, PR_TTL_MS * 2 ** Math.max(0, failures - 1));

/** "PR 4231 to dev", "PR #9 to main". */
export const prName = (pr: Pick<PipelinePr, "provider" | "id" | "target">): string => `PR ${pr.provider === "ado" ? pr.id : `#${pr.id}`} to ${pr.target}`;

const tries = (n: number) => `${n} ${n === 1 ? "try" : "tries"}`;

/** Ticket `p`'s latest pull request to each target from `branch`: an older one to the same target has been replaced by it. */
function latestByTarget(p: TicketPipeline | null, branch: string): PipelinePr[] {
  const prs = Array.isArray(p?.prs) ? p!.prs : [];
  return (["dev", "main"] as const).flatMap((t) => {
    const xs = prs.filter((x) => x.branch === branch && x.target === t);
    return xs.length ? [xs.reduce((a, b) => (b.at > a.at ? b : a))] : [];
  });
}

/**
 * What pr-merged wire `w` shows while nothing waits at its gate, from its source's ticket record `p`: blocked while its
 * source isn't on a ticket and a branch, while the latest PR to a target from that branch can't be read (the reason and
 * how many tries) or was closed without merging; otherwise what it waits for. A PR it has fired for is behind it.
 */
export function mergeViewOf(w: Wire, source: Pick<WireEnd, "title" | "ticket" | "branch"> | null, p: TicketPipeline | null): MergeView | null {
  if (w.when !== "pr-merged" || !source) return null;
  if (!source.ticket || !source.branch) return { blocked: `“${source.title}” isn't on a ticket and a branch, so there's no pull request of its to wait for.` };
  if (p?.stage === "done") return { waits: `#${source.ticket} is Done, so its pull requests aren't watched.` };
  const blocked: string[] = [];
  const open: string[] = [];
  for (const pr of latestByTarget(p, source.branch)) {
    if (w.fired?.includes(pr.id) || pr.mergedAt) continue;
    if (pr.closedAt) blocked.push(`${prName(pr)} was closed without merging.`);
    else if (pr.watch) blocked.push(`Can't tell whether ${prName(pr)} merged (${tries(pr.watch.failures)}): ${pr.watch.why}`);
    else open.push(prName(pr));
  }
  if (blocked.length) return { blocked: blocked.join(" ") };
  return { waits: open.length ? `Waits for ${open.join(" or ")} to merge.` : `Waits for a pull request from ${source.branch}.` };
}

export interface PrWatchOptions {
  pipeline: Pick<PipelineStore, "all" | "get" | "prMerged" | "prClosed" | "prWatched">;
  /** Pull request `pr` as its provider has it now, read in folder `root` (prStateById, with that folder's prDeps). */
  read: (pr: PipelinePr, root: string) => Promise<PrState>;
  sessions: { list(): SessionInfo[]; resumable(): SessionInfo[] };
  wires: () => WireState;
  /** A merge's fill (WireTools.planMerge), and the one writer of pendings (WireDelivery.offer). */
  fill: (me: SessionInfo, merge: PrMerge, wires: readonly string[]) => Promise<MergeFill | { refused: string }>;
  offer: (me: SessionInfo, f: MergeFill, how: OfferHow) => FinishOutcome;
  /** Tell the user, under the notification settings; a click shows session `session`'s pane. */
  notify: (session: string | null, title: string, body: string) => void;
  /** pipeline.json changed: the windows hear of it. */
  onChanged: () => void;
  log: (context: string, err: unknown) => void;
  now?: () => number;
  exists?: (folder: string) => boolean;
}

export class PrWatch {
  /** When each pull request was last read without failing, this run. */
  private lastRead = new Map<string, number>();
  /** Pull requests a read this run found not merged: one found merged after that was seen merging. */
  private seenOpen = new Set<string>();
  /** Merges a read saw happen, until their wires have been offered them: only these may go by an automatic gate. */
  private fresh = new Set<string>();
  /** Each PR's title from its last read, for {pr}. */
  private titles = new Map<string, string>();
  /** What last stopped a wire taking a merge ("<wire> <url>"), so it's logged once while it lasts. */
  private stopped = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private changed = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: PrWatchOptions) {}

  private now = (): number => (this.o.now ?? Date.now)();

  /** The checks every PR_TTL_MS, the first PR_FIRST_CHECK_MS after the start. */
  start(): void {
    if (this.timers.length) return;
    const tick = () => void this.tick().catch((err) => this.o.log("merge watch: a check failed", err));
    this.timers = [setTimeout(tick, PR_FIRST_CHECK_MS), setInterval(tick, PR_TTL_MS)];
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** One check: each pull request that's due read, then each merge offered to the wires that haven't had it. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const watched = this.watched();
      const now = this.now();
      for (const { id, pr } of watched) {
        const due = pr.watch ? pr.watch.at + backoffMs(pr.watch.failures) : (this.lastRead.get(pr.url) ?? 0) + PR_TTL_MS;
        if (now >= due) await this.check(id, pr);
      }
      // a pull request nothing waits on any more keeps no failures, so it needs nobody
      const live = new Set(watched.map((x) => x.pr.url));
      for (const [id, p] of this.tickets()) for (const pr of p.prs) if (pr.watch && !live.has(pr.url)) this.save(id, pr, "its watch's failures cleared", () => this.o.pipeline.prWatched(id, pr.url, null));
      await this.fire();
    });
  }

  /** The user's Check now: ticket `ticket`'s pull request `url` read at once, or each it has that hasn't merged or closed. */
  checkNow(ticket: string, url?: string): Promise<TicketPipeline> {
    return this.serial(async () => {
      const p = this.o.pipeline.get(ticket);
      if (!p || !Array.isArray(p.prs)) throw new Error(`#${ticket} isn't tracked in the ticket pipeline`);
      const prs = p.prs.filter((x) => !x.mergedAt && (url === undefined ? !x.closedAt : x.url === url));
      if (url !== undefined && !prs.length) throw new Error(p.prs.some((x) => x.url === url) ? "That pull request is merged already: there's nothing to check." : `#${ticket} has no pull request ${url}`);
      for (const pr of prs) await this.check(ticket, pr);
      await this.fire(ticket);
      return this.o.pipeline.get(ticket)!;
    });
  }

  /**
   * The user's Mark merged…, for a pull request the watch can't read (or that its provider says was closed): merged now,
   * by them, which moves the ticket as a merge does, and readies its wires with {pr} saying they marked it. Their gates
   * ask. A window call only.
   */
  markMerged(ticket: string, url: string): Promise<TicketPipeline> {
    return this.serial(async () => {
      const prs = this.o.pipeline.get(ticket)?.prs;
      const pr = Array.isArray(prs) ? prs.find((x) => x.url === url) : undefined;
      const why = pr?.watch ? `: Mockingbird couldn't read it (${pr.watch.why})` : pr?.closedAt ? `: ${pr.provider === "ado" ? "Azure DevOps" : "GitHub"} said it was closed without merging` : "";
      const r = this.o.pipeline.prMerged(ticket, url, { at: this.now(), by: BY_YOU, note: `You marked ${pr ? prName(pr) : url} merged${why}.` });
      this.changed = true;
      await this.fire(ticket);
      return r.pipeline;
    });
  }

  /** What pr-merged wire `w`, from `source`, shows while nothing waits at its gate (mergeViewOf). */
  view(w: Wire, source: WireEnd | null): MergeView | null {
    return mergeViewOf(w, source, source?.ticket ? this.o.pipeline.get(source.ticket) : null);
  }

  /** The pull requests from session `from`'s ticket and branch that have merged: a wire set to wait for a merge now didn't wait for those. */
  mergedBefore(from: string): number[] {
    const s = this.session(from);
    const ticket = s && ticketOfSession(s);
    const prs = ticket ? this.o.pipeline.get(ticket)?.prs : null;
    return s?.branch && Array.isArray(prs) ? prs.filter((x) => x.branch === s.branch && x.mergedAt).map((x) => x.id) : [];
  }

  // ---- reading ----------------------------------------------------------------------------------

  /** One at a time, so a Check now never reads or offers alongside a check. The caller hears a failure; the queue goes on. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run.finally(() => {
      if (!this.changed) return;
      this.changed = false;
      this.o.onChanged();
    });
  }

  private tickets(): [string, TicketPipeline][] {
    return Object.entries(this.o.pipeline.all()).filter(([, p]) => !!p && p.stage !== "done" && Array.isArray(p.prs));
  }

  private session(id: string): SessionInfo | undefined {
    return this.o.sessions.list().find((s) => s.id === id) ?? this.o.sessions.resumable().find((s) => s.id === id);
  }

  /** The sources of pr-merged wires, as "<ticket> <branch>", each with the PR ids its wire has fired for. */
  private waitingWires(): { ticket: string; branch: string; fired: number[] }[] {
    const book = this.o.wires().book;
    if (!book) return [];
    return Object.values(book.links).flatMap((w) => {
      if (w.when !== "pr-merged" || !carriesWork(w.type)) return [];
      const s = this.session(w.from);
      const ticket = s && ticketOfSession(s);
      return ticket && s.branch ? [{ ticket, branch: s.branch, fired: w.fired ?? [] }] : [];
    });
  }

  /** The pull requests something waits on, not merged or closed: a ticket at that PR's stage, or a pr-merged wire from its ticket and branch. */
  private watched(): { id: string; pr: PipelinePr }[] {
    const wires = this.waitingWires();
    return this.tickets().flatMap(([id, p]) =>
      p.prs.flatMap((pr) => {
        if (pr.mergedAt || pr.closedAt) return [];
        const stage = p.stage === (pr.target === "dev" ? "pr-dev" : "pr-main");
        return stage || wires.some((w) => w.ticket === id && w.branch === pr.branch && !w.fired.includes(pr.id)) ? [{ id, pr }] : [];
      })
    );
  }

  /** Where pull request `pr` is read: the folder it was opened from, else a session's on its ticket and branch (or that session's repository). */
  private rootOf(id: string, pr: PipelinePr): string {
    const exists = this.o.exists ?? fs.existsSync;
    const on = [...this.o.sessions.list(), ...this.o.sessions.resumable()].filter((s) => ticketOfSession(s) === id && s.branch === pr.branch);
    const found = [pr.root, ...on.map((s) => s.cwd), ...on.map((s) => s.repoPath)].find((f): f is string => !!f && exists(f));
    if (found) return found;
    throw new Error(pr.root ? `its folder, ${pr.root}, isn't there any more, and no session of #${id}'s is on ${pr.branch}` : `no session of #${id}'s is on ${pr.branch} to read it from`);
  }

  /** Read pull request `pr` of ticket `id`, and save what it says. */
  private async check(id: string, pr: PipelinePr): Promise<void> {
    let st: PrState;
    try {
      st = await this.o.read(pr, this.rootOf(id, pr));
    } catch (err) {
      return this.failed(id, pr, err);
    }
    const now = this.now();
    this.lastRead.set(pr.url, now);
    if (st.title) this.titles.set(pr.url, st.title);
    if (st.state === "merged") {
      if (this.seenOpen.has(pr.url)) this.fresh.add(pr.url);
      const commit = st.mergeCommit ? ` (${st.mergeCommit.slice(0, 12)})` : "";
      this.save(id, pr, "its merge", () => this.o.pipeline.prMerged(id, pr.url, { at: st.mergedAt ?? now, commit: st.mergeCommit, by: BY_MERGE, note: `${prName(pr)} merged${commit}.` }));
    } else if (st.state === "closed") {
      if (pr.closedAt) return;
      if (this.save(id, pr, "its closing", () => this.o.pipeline.prClosed(id, pr.url, st.closedAt ?? now)))
        this.o.notify(pr.by ?? null, `#${id}: ${prName(pr)} was closed without merging`, `Nothing waiting on it goes until another pull request from ${pr.branch} merges, or you mark it merged.`);
    } else {
      this.seenOpen.add(pr.url);
      if (pr.closedAt) this.save(id, pr, "its reopening", () => this.o.pipeline.prClosed(id, pr.url, null));
      else if (pr.watch) this.save(id, pr, "a read working again", () => this.o.pipeline.prWatched(id, pr.url, null));
    }
  }

  /** A read that failed: logged, kept on the PR with how many in a row, and at PR_WATCH_NEEDS_YOU the user told. */
  private failed(id: string, pr: PipelinePr, err: unknown): void {
    const failures = (pr.watch?.failures ?? 0) + 1;
    const why = plainLine(shownFailure(err), 300) || "the read failed without saying why";
    this.o.log(`merge watch: #${id}'s ${prName(pr)} (${pr.url}) couldn't be read, ${tries(failures)} in a row; the next in ${backoffMs(failures) / 60_000} minutes`, err);
    const saved = this.save(id, pr, "its failed read", () => this.o.pipeline.prWatched(id, pr.url, { failures, why, at: this.now() }));
    if (saved && failures === PR_WATCH_NEEDS_YOU) this.o.notify(pr.by ?? null, `#${id}: can't tell whether ${prName(pr)} merged`, `${tries(failures)} failed: ${why}\nCheck now, or Mark merged…, in the ticket's pipeline.`);
  }

  /** A change to ticket `id`'s record of `pr`; one that can't be saved is logged, and the next check tries again. */
  private save(id: string, pr: PipelinePr, what: string, change: () => unknown): boolean {
    try {
      change();
      this.changed = true;
      return true;
    } catch (err) {
      this.o.log(`merge watch: #${id}'s ${prName(pr)}: ${what} couldn't be saved`, err);
      return false;
    }
  }

  // ---- offering a merge to its wires -------------------------------------------------------------

  /**
   * Each merged pull request offered to the pr-merged wires from its ticket and branch that haven't had it: one made
   * before it merged, from a session on that ticket and branch. A wire the rules refuse now, or that couldn't be filled
   * in, is left for the next check.
   */
  private async fire(only?: string): Promise<void> {
    const book = this.o.wires().book;
    if (!book) return; // its gates say the wires can't be read; merges are offered once they can
    for (const [id, p] of this.tickets()) {
      if (only !== undefined && id !== only) continue;
      for (const pr of p.prs) {
        if (!pr.mergedAt) continue;
        const bySource = new Map<string, string[]>();
        for (const [wid, w] of wiresInOrder(book.links)) {
          if (w.when !== "pr-merged" || !carriesWork(w.type) || w.fired?.includes(pr.id) || w.createdAt > pr.mergedAt) continue;
          const s = this.session(w.from);
          if (s && ticketOfSession(s) === id && s.branch === pr.branch) bySource.set(w.from, [...(bySource.get(w.from) ?? []), wid]);
        }
        for (const [from, wires] of bySource) await this.offerTo(this.session(from)!, id, pr, wires);
        this.fresh.delete(pr.url);
      }
    }
  }

  private async offerTo(me: SessionInfo, ticket: string, pr: PipelinePr, wires: string[]): Promise<void> {
    const what = `merge watch: #${ticket}'s ${prName(pr)} merging, for ${me.id}'s wires ${wires.join(", ")}`;
    const hold = pr.mergedBy
      ? `You marked ${prName(pr)} merged, so its gate asks rather than sending by itself.`
      : this.fresh.has(pr.url)
        ? undefined
        : `${prName(pr)} merged before Mockingbird saw it happen (while it wasn't running, before its first check since starting, or while this wire couldn't take it), so its gate asks rather than sending by itself.`;
    let out: FinishOutcome;
    try {
      const fill = await this.o.fill(me, { ticket, pr, ...(this.titles.has(pr.url) ? { title: this.titles.get(pr.url) } : {}) }, wires);
      out = "refused" in fill ? fill : this.o.offer(me, fill, { origin: "merge", ...(hold ? { hold } : {}) });
    } catch (err) {
      return this.heldBack(wires.join(" "), pr, what, err instanceof Error ? err.message : String(err), err);
    }
    if ("refused" in out) return this.heldBack(wires.join(" "), pr, what, out.refused);
    for (const step of out.steps) {
      if (step.does === "refused") this.heldBack(step.wire, pr, `merge watch: ${me.id}'s wire ${step.wire} didn't take #${ticket}'s ${prName(pr)} merging; it's offered again at the next check`, step.why ?? "refused");
      else this.stopped.delete(`${step.wire} ${pr.url}`);
    }
    const waiting = out.steps.filter((s) => s.pending && s.went?.state !== "sent" && s.went?.state !== "sending");
    if (waiting.length) this.o.notify(me.id, `#${ticket}: ${prName(pr)} merged`, `${me.ticketTitle ?? me.title} → ${waiting.map((s) => s.toTitle).join(", ")}: ready at the gate.`);
  }

  /** What stopped a merge reaching wire(s) `key`: logged once while it's the same. */
  private heldBack(key: string, pr: PipelinePr, what: string, why: string, err?: unknown): void {
    const k = `${key} ${pr.url}`;
    if (this.stopped.get(k) === why) return;
    this.stopped.set(k, why);
    this.o.log(what, err ?? new Error(why));
  }
}
