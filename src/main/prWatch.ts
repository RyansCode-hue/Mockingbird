import * as fs from "fs";
import { originRepoOf } from "./prStatus";
import { shownFailure } from "./safeGit";
import type { PipelineStore } from "./pipeline";
import type { OfferHow } from "./wireDelivery";
import type { PrMerge } from "./wirePrompt";
import type { MergeFill } from "./wireTools";
import { plainLine } from "../shared/team/agentText";
import { BY_MERGE, BY_YOU, PR_WATCH_NEEDS_YOU, latestPr, samePrPlace, ticketOfSession, type PipelinePr, type PrRepo, type PrState, type SessionInfo, type TicketPipeline } from "../shared/types";
import { carriesWork, wiresInOrder, type FinishOutcome, type MergeView, type Wire, type WireEnd, type WireState } from "../shared/wires";

/**
 * A pull request merging as a wire's When (docs/landscape-wires.md, W16). Every PR_TTL_MS it reads each pull request in
 * pipeline.json that something waits on and hasn't merged: the ticket's latest to a target while it's at that PR's stage,
 * or the latest to a target from a pr-merged wire's source's repository and branch. A merge is saved (when, its merge
 * commit), moves the ticket on from its PR stage when it's the ticket's latest to that target, and readies each such
 * wire once per PR, through delivery's offer. A read that fails is never taken for "not merged": it's logged, kept on the
 * PR (`watch`), drawn on the wire as blocked and shown on the PR's row, backs off to PR_BACKOFF_MAX_MS, and after
 * PR_WATCH_NEEDS_YOU in a row needs the user (prNeedsYou, a notice), who can Check now or Mark merged… on that row. A
 * closed one is still read, every PR_BACKOFF_MAX_MS, in case it's reopened. Mark merged… is a window call only: no tool
 * reaches it.
 */

/** How often a pull request something waits on is read: the pane's lookup's two minutes. */
export const PR_TTL_MS = 120_000;
/** The longest a failing read backs off to, and how often a closed one is read again. */
export const PR_BACKOFF_MAX_MS = 10 * 60_000;
/** The first check after a start, once the window and team rooms have had a moment. */
export const PR_FIRST_CHECK_MS = 15_000;
/** How early a check may come and still find a read due: a timer's tick isn't to the millisecond. */
const TICK_SLACK_MS = 5_000;

/** How long after `failures` failed reads in a row the next is due: 2, 4, 8, then 10 minutes. */
export const backoffMs = (failures: number): number => Math.min(PR_BACKOFF_MAX_MS, PR_TTL_MS * 2 ** Math.max(0, failures - 1));

/** "PR 4231 to dev", "PR #9 to main". */
export const prName = (pr: Pick<PipelinePr, "provider" | "id" | "target">): string => `PR ${pr.provider === "ado" ? pr.id : `#${pr.id}`} to ${pr.target}`;

const tries = (n: number) => `${n} ${n === 1 ? "try" : "tries"}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A pr-merged wire's source's repository, as the merge watch last read its origin: unread yet, or why it couldn't be. */
export type SourceRepo = PrRepo | { error: string } | undefined;

/**
 * What pr-merged wire `w` shows while nothing waits at its gate, from its source's ticket record `p` and repository
 * `repo`: blocked while its source isn't on a ticket and a branch, while its origin can't be read, while the latest PR
 * to a target from that repository and branch can't be read (the reason and how many tries) or was closed without
 * merging; otherwise what it waits for. A PR it has fired for is behind it.
 */
export function mergeViewOf(w: Wire, source: Pick<WireEnd, "title" | "ticket" | "branch"> | null, p: TicketPipeline | null, repo: SourceRepo): MergeView | null {
  if (w.when !== "pr-merged" || !source) return null;
  if (!source.ticket || !source.branch) return { blocked: `“${source.title}” isn't on a ticket and a branch, so there's no pull request of its to wait for.` };
  if (p?.stage === "done") return { waits: `#${source.ticket} is Done, so its pull requests aren't watched.` };
  if (!repo) return { waits: `Its pull requests are first checked within ${PR_TTL_MS / 60_000} minutes.` };
  if ("error" in repo) return { blocked: `Which pull requests are “${source.title}”'s can't be told: its origin couldn't be read (${repo.error}).` };
  const place = { ...repo, branch: source.branch };
  const prs = Array.isArray(p?.prs) ? p!.prs : [];
  const blocked: string[] = [];
  const open: string[] = [];
  for (const target of ["dev", "main"] as const) {
    const pr = latestPr(prs, target, (x) => samePrPlace(x, place));
    if (!pr || w.fired?.includes(pr.url) || pr.mergedAt) continue;
    if (pr.closedAt) blocked.push(`${prName(pr)} was closed without merging.`);
    else if (pr.watch) blocked.push(`Can't tell whether ${prName(pr)} merged (${tries(pr.watch.failures)}): ${pr.watch.why}`);
    else open.push(prName(pr));
  }
  if (blocked.length) return { blocked: blocked.join(" ") };
  return { waits: open.length ? `Waits for ${open.join(" or ")} to merge.` : `Waits for a pull request from ${source.branch} in ${repo.repo}.` };
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
  /** A folder's repository as a pull request records it (originRepoOf, through guardedGit); throws when it can't be read. */
  originOf?: (folder: string) => Promise<PrRepo>;
  now?: () => number;
  exists?: (folder: string) => boolean;
}

/** A pr-merged handoff, by its source: the PRs it waits on are its source ticket's from `repo` and `branch`. */
interface Waiting {
  wire: string;
  from: string;
  ticket: string;
  branch: string;
  repo: SourceRepo;
  /** When it began waiting: a merge from before isn't one it waited for. */
  since: number;
  fired: string[];
}

export class PrWatch {
  /** When each pull request was last read without failing, this run (the check's start). */
  private lastRead = new Map<string, number>();
  /** When a read this run last found each pull request not merged: one found merged after that was seen merging. */
  private seenOpenAt = new Map<string, number>();
  /** Merges a read saw happen, until their wires have been offered them: only these may go by an automatic gate. */
  private fresh = new Set<string>();
  /** Each PR's title from its last read, for {pr}. */
  private titles = new Map<string, string>();
  /** Each pr-merged wire's source's repository, by session, as of the last check. */
  private sourceRepos = new Map<string, SourceRepo>();
  /** Folders' origins read this check, so each is read once per check. */
  private origins = new Map<string, Promise<PrRepo | Error>>();
  /** What last stopped a wire taking a merge ("<wire> <url>"), or a PR being read, so it's logged once while it lasts. */
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
      const at = this.now();
      await this.readSources();
      const watched = this.watched();
      for (const { id, pr } of watched) {
        const every = pr.closedAt ? PR_BACKOFF_MAX_MS : PR_TTL_MS;
        const due = pr.watch ? pr.watch.at + backoffMs(pr.watch.failures) : (this.lastRead.get(pr.url) ?? -Infinity) + every;
        if (at + TICK_SLACK_MS >= due) await this.check(id, pr, at);
      }
      // a pull request nothing waits on any more keeps no failures, so it needs nobody
      const live = new Set(watched.map((x) => x.pr.url));
      for (const [id, p] of this.tickets()) for (const pr of p.prs) if (pr.watch && !live.has(pr.url)) this.save(id, pr, "its watch's failures cleared", () => this.o.pipeline.prWatched(id, pr.url, null));
      await this.fire();
    });
  }

  /**
   * The user's Check now: ticket `ticket`'s pull request `url` read at once (closed included), or, with no `url`, each
   * of the ticket's that something waits on.
   */
  checkNow(ticket: string, url?: string): Promise<TicketPipeline> {
    return this.serial(async () => {
      const at = this.now();
      const p = this.o.pipeline.get(ticket);
      if (!p || !Array.isArray(p.prs)) throw new Error(`#${ticket} isn't tracked in the ticket pipeline`);
      await this.readSources();
      const prs = url === undefined ? this.watched().flatMap((x) => (x.id === ticket ? [x.pr] : [])) : p.prs.filter((x) => x.url === url && !x.mergedAt);
      if (url !== undefined && !prs.length) throw new Error(p.prs.some((x) => x.url === url) ? "That pull request is merged already: there's nothing to check." : `#${ticket} has no pull request ${url}`);
      for (const pr of prs) await this.check(ticket, pr, at);
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
      await this.readSources();
      await this.fire(ticket);
      return r.pipeline;
    });
  }

  /** What pr-merged wire `w`, from `source`, shows while nothing waits at its gate (mergeViewOf). */
  view(w: Wire, source: WireEnd | null): MergeView | null {
    return mergeViewOf(w, source, source?.ticket ? this.o.pipeline.get(source.ticket) : null, source ? this.sourceRepos.get(source.id) : undefined);
  }

  // ---- what's watched -----------------------------------------------------------------------------

  /** One at a time, so a Check now never reads or offers alongside a check. The caller hears a failure; the queue goes on. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      this.origins = new Map();
      return fn();
    });
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

  private exists(folder: string): boolean {
    return (this.o.exists ?? fs.existsSync)(folder);
  }

  /** Folder `folder`'s repository, read once this check; an Error when it can't be. */
  private originAt(folder: string): Promise<PrRepo | Error> {
    let o = this.origins.get(folder);
    if (!o) {
      const read = this.o.originOf ?? ((f: string) => originRepoOf(f).then((r) => r.repo));
      o = read(folder).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      this.origins.set(folder, o);
    }
    return o;
  }

  /** Each pr-merged wire's source's repository, from its folder (or its repository's, once that's gone): the PRs it waits on are that repository's. */
  private async readSources(): Promise<void> {
    const book = this.o.wires().book;
    if (!book) return;
    const ids = new Set(Object.values(book.links).flatMap((w) => (w.when === "pr-merged" && carriesWork(w.type) ? [w.from] : [])));
    for (const id of ids) {
      const s = this.session(id);
      const folder = s && [s.cwd, s.repoPath].find((f): f is string => !!f && this.exists(f));
      const got = !s ? undefined : !folder ? new Error(`its folder, ${s.cwd}, isn't there any more`) : await this.originAt(folder);
      const repo: SourceRepo = got instanceof Error ? { error: plainLine(shownFailure(got), 200) } : got;
      if (repo && "error" in repo && this.stopped.get(`origin ${id}`) !== repo.error) this.o.log(`merge watch: session ${id}'s origin couldn't be read, so which pull requests its pr-merged wires wait on can't be told`, got);
      if (repo && "error" in repo) this.stopped.set(`origin ${id}`, repo.error);
      else this.stopped.delete(`origin ${id}`);
      this.sourceRepos.set(id, repo);
    }
  }

  /** The pr-merged handoffs, each with its source's ticket, branch and repository. */
  private waiting(): Waiting[] {
    const book = this.o.wires().book;
    if (!book) return [];
    return wiresInOrder(book.links).flatMap(([wire, w]) => {
      if (w.when !== "pr-merged" || !carriesWork(w.type)) return [];
      const s = this.session(w.from);
      const ticket = s && ticketOfSession(s);
      return ticket && s.branch ? [{ wire, from: w.from, ticket, branch: s.branch, repo: this.sourceRepos.get(w.from), since: w.since ?? w.createdAt, fired: w.fired ?? [] }] : [];
    });
  }

  /** `w`'s source's place (repository and branch), once its origin has been read. */
  private placeOf(w: Waiting): Pick<PipelinePr, "provider" | "repo" | "branch"> | null {
    return w.repo && !("error" in w.repo) ? { ...w.repo, branch: w.branch } : null;
  }

  /**
   * The pull requests something waits on, not merged (closed included): the ticket's latest to a target while it's at
   * that PR's stage, and the latest to each target from a pr-merged wire's source's repository and branch that it
   * hasn't fired for. An older one is behind its replacement.
   */
  private watched(): { id: string; pr: PipelinePr }[] {
    const wires = this.waiting();
    const out = new Map<string, { id: string; pr: PipelinePr }>();
    for (const [id, p] of this.tickets()) {
      for (const target of ["dev", "main"] as const) {
        if (p.stage === (target === "dev" ? "pr-dev" : "pr-main")) {
          const pr = latestPr(p.prs, target);
          if (pr && !pr.mergedAt) out.set(pr.url, { id, pr });
        }
        for (const w of wires) {
          const place = w.ticket === id ? this.placeOf(w) : null;
          const pr = place && latestPr(p.prs, target, (x) => samePrPlace(x, place));
          if (pr && !pr.mergedAt && !w.fired.includes(pr.url)) out.set(pr.url, { id, pr });
        }
      }
    }
    return [...out.values()];
  }

  /**
   * Where pull request `pr` is read: the folder it was opened from, else a session's (or its repository's) on its ticket
   * and branch whose origin is the PR's repository. Null for a PR from before folders were kept with no session on its
   * branch: there's nowhere to read it, and it isn't counted as failing.
   */
  private async rootOf(id: string, pr: PipelinePr): Promise<string | null> {
    if (pr.root && this.exists(pr.root)) return pr.root;
    const on = [...this.o.sessions.list(), ...this.o.sessions.resumable()].filter((s) => ticketOfSession(s) === id && s.branch === pr.branch);
    if (!pr.root && !on.length) return null;
    for (const f of new Set([...on.map((s) => s.cwd), ...on.flatMap((s) => (s.repoPath ? [s.repoPath] : []))])) {
      if (!this.exists(f)) continue;
      const o = await this.originAt(f);
      if (!(o instanceof Error) && o.provider === pr.provider && o.repo === pr.repo) return f;
    }
    const none = `no session of #${id}'s on ${pr.branch} has ${pr.repo} as its origin`;
    throw new Error(pr.root ? `its folder, ${pr.root}, isn't there any more, and ${none}` : none);
  }

  // ---- reading ----------------------------------------------------------------------------------

  /** Read pull request `pr` of ticket `id`, in the check that began at `at`, and save what it says. */
  private async check(id: string, pr: PipelinePr, at: number): Promise<void> {
    let st: PrState;
    try {
      const root = await this.rootOf(id, pr);
      if (root === null) return this.once(`skip ${pr.url}`, "no folder", `merge watch: #${id}'s ${prName(pr)} (${pr.url}) isn't read: it's from before Mockingbird kept a PR's folder, and no session is on ${pr.branch}`);
      st = await this.o.read(pr, root);
    } catch (err) {
      return this.failed(id, pr, err, at);
    }
    this.stopped.delete(`skip ${pr.url}`);
    this.lastRead.set(pr.url, at);
    if (st.title) this.titles.set(pr.url, st.title);
    if (st.state === "merged") {
      if (this.seenOpenAt.has(pr.url)) this.fresh.add(pr.url);
      const commit = st.mergeCommit ? ` (${st.mergeCommit.slice(0, 12)})` : "";
      this.save(id, pr, "its merge", () =>
        this.o.pipeline.prMerged(id, pr.url, { at: st.mergedAt ?? at, timeUnknown: st.mergedAt === undefined, commit: st.mergeCommit, by: BY_MERGE, note: `${prName(pr)} merged${commit}.` })
      );
    } else if (st.state === "closed") {
      if (pr.closedAt) return;
      if (this.save(id, pr, "its closing", () => this.o.pipeline.prClosed(id, pr.url, st.closedAt ?? at)))
        this.o.notify(pr.by ?? null, `#${id}: ${prName(pr)} was closed without merging`, `Nothing waiting on it goes until it's reopened and merges, or another pull request from ${pr.branch} replaces it. Check now and Mark merged… are on its row in the ticket's pipeline.`);
    } else {
      this.seenOpenAt.set(pr.url, at);
      if (pr.closedAt) this.save(id, pr, "its reopening", () => this.o.pipeline.prClosed(id, pr.url, null));
      else if (pr.watch) this.save(id, pr, "a read working again", () => this.o.pipeline.prWatched(id, pr.url, null));
    }
  }

  /** A read that failed: logged, kept on the PR with how many in a row, and at PR_WATCH_NEEDS_YOU the user told. */
  private failed(id: string, pr: PipelinePr, err: unknown, at: number): void {
    const failures = (pr.watch?.failures ?? 0) + 1;
    const why = plainLine(shownFailure(err), 300) || "the read failed without saying why";
    this.o.log(`merge watch: #${id}'s ${prName(pr)} (${pr.url}) couldn't be read, ${tries(failures)} in a row; the next in ${backoffMs(failures) / 60_000} minutes`, err);
    const saved = this.save(id, pr, "its failed read", () => this.o.pipeline.prWatched(id, pr.url, { failures, why, at }));
    if (saved && failures === PR_WATCH_NEEDS_YOU) this.o.notify(pr.by ?? null, `#${id}: can't tell whether ${prName(pr)} merged`, `${tries(failures)} failed: ${why}\nCheck now and Mark merged… are on its row in the ticket's pipeline.`);
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

  /** Whether merged pull request `pr` came after `since`: an unknown time is old, unless this run saw it open since then. */
  private after(pr: PipelinePr, since: number): boolean {
    return pr.mergedAtUnknown ? (this.seenOpenAt.get(pr.url) ?? -Infinity) >= since : (pr.mergedAt ?? -Infinity) >= since;
  }

  /**
   * Each merged pull request offered to the pr-merged wires waiting on it that haven't had it: from a session on its
   * ticket, branch and repository, waiting since before it merged. A wire the rules refuse now, or that couldn't be filled
   * in, is left for the next check.
   */
  private async fire(only?: string): Promise<void> {
    if (!this.o.wires().book) return; // its gates say the wires can't be read; merges are offered once they can
    const wires = this.waiting();
    for (const [id, p] of this.tickets()) {
      if (only !== undefined && id !== only) continue;
      for (const pr of p.prs) {
        if (!pr.mergedAt) continue;
        const bySource = new Map<string, string[]>();
        for (const w of wires) {
          const place = w.ticket === id ? this.placeOf(w) : null;
          if (place && samePrPlace(pr, place) && !w.fired.includes(pr.url) && this.after(pr, w.since)) bySource.set(w.from, [...(bySource.get(w.from) ?? []), w.wire]);
        }
        for (const [from, ids] of bySource) await this.offerTo(this.session(from)!, id, pr, ids);
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
      return this.once(`${wires.join(" ")} ${pr.url}`, message(err), what, err);
    }
    if ("refused" in out) return this.once(`${wires.join(" ")} ${pr.url}`, out.refused, what);
    for (const step of out.steps) {
      if (step.does === "refused") this.once(`${step.wire} ${pr.url}`, step.why ?? "refused", `merge watch: ${me.id}'s wire ${step.wire} didn't take #${ticket}'s ${prName(pr)} merging; it's offered again at the next check`);
      else this.stopped.delete(`${step.wire} ${pr.url}`);
    }
    const waiting = out.steps.filter((s) => s.pending && s.went?.state !== "sent" && s.went?.state !== "sending");
    if (waiting.length) this.o.notify(me.id, `#${ticket}: ${prName(pr)} merged`, `${me.ticketTitle ?? me.title} → ${waiting.map((s) => s.toTitle).join(", ")}: ready at the gate.`);
  }

  /** Something that stops a PR being read or a merge reaching a wire (`key`): logged once while it's the same. */
  private once(key: string, why: string, what: string, err?: unknown): void {
    if (this.stopped.get(key) === why) return;
    this.stopped.set(key, why);
    this.o.log(what, err ?? new Error(why));
  }
}
