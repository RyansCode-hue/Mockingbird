import * as fs from "fs";
import { originRepoOf } from "./prStatus";
import { shownFailure } from "./safeGit";
import type { PipelineStore } from "./pipeline";
import type { OfferHow } from "./wireDelivery";
import type { PrMerge } from "./wirePrompt";
import type { MergeFill } from "./wireTools";
import { plainLine } from "../shared/team/agentText";
import { BY_MERGE, BY_YOU, PR_WATCH_NEEDS_YOU, latestPr, prAskedState, prNeedsYou, samePrPlace, ticketOfSession, type PipelinePr, type PrRepo, type PrState, type SessionInfo, type TicketPipeline } from "../shared/types";
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
 * reaches it. A wire's source's repository is read from its origin once, as it begins waiting, and kept on the wire
 * (`sourceRepo`): an agent changing its origin later can't point its wire at another repository's pull requests.
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

/** A pr-merged wire's source's repository: as recorded on the wire, unread yet, or why it couldn't be read or recorded. */
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
  if ("error" in repo) return { blocked: `Which pull requests are “${source.title}”'s can't be told: ${repo.error}.` };
  const place = { ...repo, branch: source.branch };
  const prs = Array.isArray(p?.prs) ? p!.prs : [];
  const blocked: string[] = [];
  const blocking: string[] = [];
  const open: string[] = [];
  for (const target of ["dev", "main"] as const) {
    const pr = latestPr(prs, target, (x) => samePrPlace(x, place));
    if (!pr || w.fired?.includes(pr.url) || pr.mergedAt) continue;
    if (pr.closedAt) blocked.push(`${prName(pr)} was closed without merging.`);
    else if (pr.watch) blocked.push(`Can't tell whether ${prName(pr)} merged (${tries(pr.watch.failures)}): ${pr.watch.why}`);
    else open.push(prName(pr));
    if (pr.closedAt || pr.watch) blocking.push(pr.url);
  }
  if (blocked.length) return { blocked: blocked.join(" "), prs: blocking };
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
  /**
   * Record `repo` as wire `wire`'s source's repository for the wait that began at `since` (WireService.pinSourceRepo):
   * null when it's written or the wire has moved on, why not when the book refused the write.
   */
  pinRepo: (wire: string, since: number | undefined, repo: PrRepo) => string | null;
  offer: (me: SessionInfo, f: MergeFill, how: OfferHow) => FinishOutcome;
  /** Tell the user, under the notification settings; a click shows session `session`'s pane. */
  notify: (session: string | null, title: string, body: string) => void;
  /** pipeline.json changed: the windows hear of it. */
  onChanged: () => void;
  /** A check, Check now or Mark merged… is done, changed anything or not: what a pr-merged wire shows (view) may have. */
  onChecked?: () => void;
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
  /** Why a source's repository couldn't be read or recorded for its wires that have none yet, by session, as of the last check. */
  private sourceFailures = new Map<string, { error: string }>();
  /** The pr-merged handoffs as the wire book last gave them: while it can't be read, what they wait on is still read. */
  private lastWaiting: Waiting[] | null = null;
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
      const wires = this.waiting();
      const watched = this.watched(wires ?? this.lastWaiting ?? []);
      for (const { id, pr } of watched) {
        const every = pr.closedAt ? PR_BACKOFF_MAX_MS : PR_TTL_MS;
        const due = pr.watch ? pr.watch.at + backoffMs(pr.watch.failures) : (this.lastRead.get(pr.url) ?? -Infinity) + every;
        if (at + TICK_SLACK_MS >= due) await this.check(id, pr, at);
      }
      // a pull request nothing waits on any more keeps no failures, so it needs nobody; while the wire book can't be
      // read, what its wires wait on isn't known, which isn't "nothing", so what they kept stays
      if (wires) {
        const live = new Set(watched.map((x) => x.pr.url));
        for (const [id, p] of this.tickets()) for (const pr of p.prs) if (pr.watch && !live.has(pr.url)) this.save(id, pr, "its watch's failures cleared", () => this.o.pipeline.prWatched(id, pr.url, null));
      }
      await this.fire();
    });
  }

  /** Each pr-merged wire with no source repository recorded yet gets one now, as one is made or set so. */
  recordSources(): Promise<void> {
    return this.serial(() => this.readSources());
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
      const prs = url === undefined ? this.watched(this.waiting() ?? this.lastWaiting ?? []).flatMap((x) => (x.id === ticket ? [x.pr] : [])) : p.prs.filter((x) => x.url === url && !x.mergedAt);
      if (url !== undefined && !prs.length) throw new Error(p.prs.some((x) => x.url === url) ? "That pull request is merged already: there's nothing to check." : `#${ticket} has no pull request ${url}`);
      const nowhere: PipelinePr[] = [];
      for (const pr of prs) if ((await this.check(ticket, pr, at)) === "nowhere") nowhere.push(pr);
      await this.fire(ticket);
      // asked for, a pull request with nowhere to read it from is said, where a check passes over it
      if (nowhere.length) throw new Error(nowhere.map((pr) => `${prName(pr)} can't be read: there's no folder or session on ${pr.branch} to read it from (it's from before Mockingbird kept a pull request's folder). A session on ${pr.branch} in ${pr.repo} lets it be read.`).join(" "));
      return this.o.pipeline.get(ticket)!;
    });
  }

  /**
   * The user's Mark merged…, for a pull request the watch can't read (or that its provider says was closed): merged now,
   * by them, which moves the ticket as a merge does, and readies its wires with {pr} saying they marked it. Their gates
   * ask. A window call only.
   *
   * It marks only what the user was asked about: a pull request that still needs them (prNeedsYou), in the state
   * `asked` names (prAskedState). Checked in the queue, so a Check now ahead of it that reads the PR again, open and
   * readable or closed since, refuses it.
   */
  markMerged(ticket: string, url: string, asked: string): Promise<TicketPipeline> {
    return this.serial(async () => {
      const p = this.o.pipeline.get(ticket);
      const prs = p?.prs;
      const pr = Array.isArray(prs) ? prs.find((x) => x.url === url) : undefined;
      // a merged or missing one is prMerged's to refuse, as before
      if (p && pr && !pr.mergedAt) {
        const now = pr.closedAt ? `its provider says it was closed without merging` : pr.watch ? `Mockingbird still can't read it` : `Mockingbird reads it again`;
        if (!prNeedsYou(p, pr)) throw new Error(`${prName(pr)} doesn't need you any more (${now}): nothing was marked.`);
        if (prAskedState(pr) !== asked) throw new Error(`${prName(pr)} has changed since you were asked (${now}): nothing was marked. Ask again.`);
      }
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
    return mergeViewOf(w, source, source?.ticket ? this.o.pipeline.get(source.ticket) : null, this.repoOf(w));
  }

  /** Wire `w`'s source's repository: the one recorded on it, else why it couldn't be read or recorded, else unread yet. */
  private repoOf(w: Wire): SourceRepo {
    return w.sourceRepo ?? this.sourceFailures.get(w.from);
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
      if (this.changed) {
        this.changed = false;
        this.o.onChanged();
      }
      this.o.onChecked?.();
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

  /**
   * Each pr-merged wire with no source repository recorded gets its source's: read from its folder's origin (or its
   * repository's, once that folder's gone) and recorded on the wire for this wait, so the PRs it waits on are that
   * repository's from then on. One recorded already isn't read again. Why one couldn't be read or recorded is kept for
   * its gate, by source, and logged once while it lasts.
   */
  private async readSources(): Promise<void> {
    const book = this.o.wires().book;
    if (!book) return;
    const bySource = new Map<string, [string, Wire][]>();
    for (const [id, w] of wiresInOrder(book.links)) if (w.when === "pr-merged" && carriesWork(w.type) && !w.sourceRepo) bySource.set(w.from, [...(bySource.get(w.from) ?? []), [id, w]]);
    for (const id of [...this.sourceFailures.keys()]) if (!bySource.has(id)) this.sourceFailures.delete(id);
    for (const [id, wires] of bySource) {
      const s = this.session(id);
      const folder = s && [s.cwd, s.repoPath].find((f): f is string => !!f && this.exists(f));
      const got = !s ? undefined : !folder ? new Error(`its folder, ${s.cwd}, isn't there any more`) : await this.originAt(folder);
      let failure: { error: string; what: string; err: unknown } | null = null;
      if (got instanceof Error) failure = { error: `its origin couldn't be read (${plainLine(shownFailure(got), 200)})`, what: `merge watch: session ${id}'s origin couldn't be read, so which pull requests its pr-merged wires wait on can't be told`, err: got };
      else if (got)
        for (const [wire, w] of wires) {
          const refused = this.o.pinRepo(wire, w.since, got);
          if (refused) failure = { error: `its repository couldn't be recorded on the wire (${plainLine(refused, 200)})`, what: `merge watch: session ${id}'s repository couldn't be recorded on its wire ${wire}, so which pull requests it waits on can't be told`, err: new Error(refused) };
        }
      if (!failure) {
        this.stopped.delete(`origin ${id}`);
        this.sourceFailures.delete(id);
        continue;
      }
      if (this.stopped.get(`origin ${id}`) !== failure.error) this.o.log(failure.what, failure.err);
      this.stopped.set(`origin ${id}`, failure.error);
      this.sourceFailures.set(id, { error: failure.error });
    }
  }

  /**
   * The pr-merged handoffs, each with its source's ticket, branch and repository; null when the wire book can't be read,
   * which isn't "none" (logged once while it lasts).
   */
  private waiting(): Waiting[] | null {
    const state = this.o.wires();
    if (!state.book) {
      this.once("book", state.refused ?? "it can't be read", "merge watch: the wire book can't be read, so what its pr-merged wires wait on isn't known: their pull requests are read as before, their failures kept, and merges offered once it can be read");
      return null;
    }
    this.stopped.delete("book");
    this.lastWaiting = wiresInOrder(state.book.links).flatMap(([wire, w]) => {
      if (w.when !== "pr-merged" || !carriesWork(w.type)) return [];
      const s = this.session(w.from);
      const ticket = s && ticketOfSession(s);
      return ticket && s.branch ? [{ wire, from: w.from, ticket, branch: s.branch, repo: this.repoOf(w), since: w.since ?? w.createdAt, fired: w.fired ?? [] }] : [];
    });
    return this.lastWaiting;
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
  private watched(wires: readonly Waiting[]): { id: string; pr: PipelinePr }[] {
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

  /**
   * Read pull request `pr` of ticket `id`, in the check that began at `at`, and save what it says. "nowhere" for one from
   * before folders were kept with no session on its branch: not read, and not counted as failing.
   */
  private async check(id: string, pr: PipelinePr, at: number): Promise<"nowhere" | void> {
    let st: PrState;
    try {
      const root = await this.rootOf(id, pr);
      if (root === null) {
        this.once(`skip ${pr.url}`, "no folder", `merge watch: #${id}'s ${prName(pr)} (${pr.url}) isn't read: it's from before Mockingbird kept a PR's folder, and no session is on ${pr.branch}`);
        return "nowhere";
      }
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

  /**
   * Whether merged pull request `pr` came after `since`: this run saw it open since then, or its provider's time says
   * so; an unknown time only the first way. Seen open counts whatever time the provider gives, as its clock and this
   * Mac's can differ: a merge found after a read that found it open came after that read.
   */
  private after(pr: PipelinePr, since: number): boolean {
    if ((this.seenOpenAt.get(pr.url) ?? -Infinity) >= since) return true;
    return !pr.mergedAtUnknown && (pr.mergedAt ?? -Infinity) >= since;
  }

  /**
   * Each merged pull request offered to the pr-merged wires waiting on it that haven't had it: from a session on its
   * ticket, branch and repository, waiting since before it merged. A wire the rules refuse now, or that couldn't be filled
   * in, is left for the next check.
   */
  private async fire(only?: string): Promise<void> {
    // while the book can't be read its gates say so, and merges are offered once it can
    const wires = this.waiting();
    for (const [id, p] of this.tickets()) {
      if (only !== undefined && id !== only) continue;
      for (const pr of p.prs) {
        if (!pr.mergedAt) continue;
        const bySource = new Map<string, string[]>();
        for (const w of wires ?? []) {
          const place = w.ticket === id ? this.placeOf(w) : null;
          if (place && samePrPlace(pr, place) && !w.fired.includes(pr.url) && this.after(pr, w.since)) bySource.set(w.from, [...(bySource.get(w.from) ?? []), w.wire]);
        }
        for (const [from, ids] of bySource) await this.offerTo(this.session(from)!, id, pr, ids);
        // a merge seen happening goes by an automatic gate only from the check that saw it: offered later (its wires
        // couldn't be read, or couldn't take it, then) it asks
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
        : `${prName(pr)} merged before Mockingbird saw it happen (while it wasn't running, before its first check since starting, or while this wire couldn't be read or couldn't take it), so its gate asks rather than sending by itself.`;
    const refusedStep = (wire: string, why: string) => this.once(`${wire} ${pr.url}`, why, `merge watch: ${me.id}'s wire ${wire} didn't take #${ticket}'s ${prName(pr)} merging; it's offered again at the next check`);
    let out: FinishOutcome;
    try {
      const fill = await this.o.fill(me, { ticket, pr, ...(this.titles.has(pr.url) ? { title: this.titles.get(pr.url) } : {}) }, wires);
      if ("refused" in fill) out = fill;
      else {
        // a wire the rules refuse now isn't filled in, {diff} and {files} unread, until they don't
        for (const s of fill.skipped) refusedStep(s.wire, s.why);
        if (!fill.fills.length) return;
        out = this.o.offer(me, fill, { origin: "merge", ...(hold ? { hold } : {}) });
      }
    } catch (err) {
      return this.once(`${wires.join(" ")} ${pr.url}`, message(err), what, err);
    }
    if ("refused" in out) return this.once(`${wires.join(" ")} ${pr.url}`, out.refused, what);
    for (const step of out.steps) {
      if (step.does === "refused") refusedStep(step.wire, step.why ?? "refused");
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
