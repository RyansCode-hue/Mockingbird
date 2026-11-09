import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { formatShare, formatTokens, isErr, isWorkItemId, stageLabel, ticketIdOf, topOfKey, totalTokens, type BranchStat, type IpcResult, type LastReply, type SessionInfo, type SessionMeter, type TicketPipeline } from "../shared/types";
import { agoShort, plural } from "../shared/format";
import { onFolderChanged } from "./folderWatch";
import { settled } from "./settled";
import { usePipelinesRead, type PipelinesRead } from "./TicketPipeline";

/**
 * A workspace's badges on the landscape (docs/landscape.md, Card badges): its diff against its area repo's base, its
 * ticket's pull request, its cost and tokens, and "what it did", the first line of its agent's latest message. Each
 * reads one source, and a source that fails shows "—", with the reason on hover and in the console, never the value
 * it had before: a badge that can't be read again doesn't go on saying what it last read.
 */

/** What a badge whose source failed shows. */
export const FAILED = "—";

/** A source as read: not yet, what it said, or why it couldn't be read. */
export type Read<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; error: string };

/** A badge as drawn: its text (for the diff, its added and removed counts apart), what hovering says, and whether its source failed. */
export interface Badge {
  key: "diff" | "pr" | "cost";
  text: string;
  title: string;
  failed?: boolean;
  /** The diff's counts, drawn in green and red. */
  lines?: { add: number; del: number };
}

/** A failed badge says which it is ("diff —"): a row of bare dashes wouldn't say what's missing. */
const LABEL: Record<Badge["key"], string> = { diff: "diff", pr: "PR", cost: "cost" };
const failedBadge = (key: Badge["key"], title: string): Badge => ({ key, text: `${LABEL[key]} ${FAILED}`, failed: true, title });

/**
 * The diff badge: "+214 −38" since the worktree forked from its base; "diff —" when it couldn't be read; none
 * without a source, and none when nothing changed (nothing to say, which isn't a failure).
 */
export function diffBadge(read: Read<BranchStat> | null): Badge | null {
  if (!read || read.state === "loading") return null;
  if (read.state === "failed") return failedBadge("diff", `Couldn't read its changes against its base: ${read.error}`);
  const d = read.value;
  if (!d.files && !d.insertions && !d.deletions) return null;
  return {
    key: "diff",
    text: `+${d.insertions} −${d.deletions}`,
    lines: { add: d.insertions, del: d.deletions },
    title: `${plural(d.files, "file")} changed since it forked from ${d.base}: ${d.insertions} lines added, ${d.deletions} removed (its commits and uncommitted changes; new files count once they're added)`,
  };
}

/** The ticket a session counts toward: its own, or its group's when that's named after a work item (as the meters count). */
export function ticketOfSession(s: Pick<SessionInfo, "ticketId" | "taskGroup">): string | null {
  if (s.ticketId) return ticketIdOf(s.ticketId);
  const top = s.taskGroup ? topOfKey(s.taskGroup) : "";
  return top && isWorkItemId(top) ? top : null;
}

/**
 * The PR badge, from the ticket pipelines (pipeline.json): the newest pull request opened for the session's ticket
 * from its branch, "PR #88", with where it goes and the ticket's stage on hover. Pipeline.json keeps which PRs Mockingbird
 * opened, not whether each is approved or merged since (the live footer's PR cell asks the provider). None for a
 * session with no ticket or no PR from its branch; "PR —" when the pipelines couldn't be read.
 */
export function prBadge(s: Pick<SessionInfo, "ticketId" | "taskGroup" | "branch">, read: PipelinesRead, now = Date.now()): Badge | null {
  const ticket = ticketOfSession(s);
  if (!ticket || !s.branch) return null;
  if (read.error) return failedBadge("pr", `Couldn't read the ticket pipelines: ${read.error}`);
  const p: TicketPipeline | undefined = read.all[ticket];
  const pr = p?.prs.filter((x) => x.branch === s.branch).sort((a, b) => b.at - a.at)[0];
  if (!p || !pr) return null;
  return {
    key: "pr",
    text: `PR #${pr.id}`,
    title: `Pull request #${pr.id}, ${pr.branch} → ${pr.base}, opened ${agoShort(pr.at, now)} ago\n#${ticket} is at ${stageLabel(p.stage)}\n${pr.url}`,
  };
}

/**
 * The cost badge, from the token meters: its tokens over all its conversations and, on a plan, its share of the
 * current 5-hour limit, "22M · 14%". None before it has used any, and never for a terminal (it has no agent to
 * cost anything); "cost —" when the meters couldn't be read.
 */
export function costBadge(s: Pick<SessionInfo, "shell">, meter: SessionMeter | undefined, metersError: string | null): Badge | null {
  if (s.shell) return null;
  if (metersError) return failedBadge("cost", `Couldn't read the token meters: ${metersError}`);
  const tokens = meter ? totalTokens(meter.tokens) : 0;
  if (!meter || !tokens) return null;
  const share = meter.window?.sharePct ?? null;
  return {
    key: "cost",
    text: share === null ? formatTokens(tokens) : `${formatTokens(tokens)} · ${formatShare(share)}`,
    title: [`${formatTokens(tokens)} tokens over its conversations`, share === null ? null : `≈${formatShare(share)} of the current 5-hour limit, its cost on the plan`].filter(Boolean).join("\n"),
  };
}

/**
 * "What it did" as a card's line under its title: the latest message's first line; "—" when it couldn't be read, or
 * when the part of the transcript read held no message (`why` says so on hover); none before it has said anything.
 */
export function didLine(read: Read<LastReply> | null, now = Date.now()): { text: string; title: string; failed: boolean } | null {
  if (!read || read.state === "loading") return null;
  if (read.state === "failed") return { text: FAILED, title: `Couldn't read what it last said: ${read.error}`, failed: true };
  const r = read.value;
  if (!r.line) return r.why ? { text: FAILED, title: `Couldn't find what it last said: ${r.why}`, failed: true } : null;
  return { text: r.line, title: `What it said last${r.at ? `, ${agoShort(r.at, now)} ago` : ""}:\n${r.line}`, failed: false };
}

/** A line as compared for repeating: its leading bullet or marker, markdown marks and spacing let go. */
const bare = (s: string) =>
  s
    .replace(/^[\s●⏺•◦∙·*>\-–]+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/…$/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Whether a card's terminal line only repeats its "what it did" line (an idle agent's last output is its last message):
 * the same words, or one the start of the other (either may be cut short).
 */
export function repeatsDid(terminalLine: string | null, did: string | null): boolean {
  if (!terminalLine || !did) return false;
  const a = bare(terminalLine);
  const b = bare(did);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 12 && (a.startsWith(b) || b.startsWith(a)));
}

/** A source's reply as a read: a failure ({ error }, or a rejection `settled` turned into one) is a failed read. */
export const readOf = <T,>(r: T | { error: string }): Read<T> => (isErr(r) ? { state: "failed", error: r.error } : { state: "ok", value: r as T });

/**
 * A failed read said in the console with what and whose it was, once for each different reason (a source polled
 * every few seconds that keeps failing says so once, not every time).
 */
export function logFailure(said: Map<string, string>, what: string, id: string, read: Read<unknown>): void {
  if (read.state !== "failed") {
    if (read.state === "ok") said.delete(`${what}:${id}`);
    return;
  }
  if (said.get(`${what}:${id}`) === read.error) return;
  said.set(`${what}:${id}`, read.error);
  console.warn(`[mockingbird] a landscape card couldn't read ${what} for ${id}: ${read.error}`);
}
const failuresSaid = new Map<string, string>();

/** How long a read nothing shows any more is kept: a card drawn again (a zoom, a remount) within it reads nothing. */
export const READ_KEEP_MS = 60_000;

interface Entry<T> {
  read: Read<T>;
  seq: number;
  /** A read is on its way. */
  reading: boolean;
  /** Each card showing it: whose card it is, and how that card reads it. */
  watchers: Map<() => void, { who: string; load: () => Promise<IpcResult<T>> }>;
  folder: string | null;
  /** What the read was made for (a session's turn), when that says whether it's still current. */
  turn: string | undefined;
  /** Its source changed while no card showed it: the next card to show it reads it again. */
  stale: boolean;
  drop: ReturnType<typeof setTimeout> | null;
}

/**
 * Reads shared by every card showing the same source (a folder's diff, a session's last message), by key: read when
 * first shown, then again on `refresh`, for another turn, or for a card shown again when its source changed meanwhile
 * or its read failed. A read goes through a card showing it now, as one that has gone may be a closed session's, which
 * main refuses (and a failure is read again when a card goes, as it may have been that card's). A read that fails
 * replaces the value, never keeping the one before; only the newest read's answer is taken; a failure is said in the
 * console with `what` and the sessions whose cards show it. Kept for `keepMs` after the last card showing it goes.
 */
export function readStore<T>(what: string, keepMs = READ_KEEP_MS) {
  const entries = new Map<string, Entry<T>>();
  const LOADING: Read<T> = { state: "loading" };
  const run = (key: string) => {
    const e = entries.get(key);
    if (!e) return;
    const watcher = [...e.watchers.values()].at(-1);
    if (!watcher) {
      e.stale = true;
      return;
    }
    e.stale = false;
    e.reading = true;
    const n = ++e.seq;
    void settled(watcher.load()).then((reply) => {
      if (entries.get(key) !== e || n !== e.seq) return;
      e.reading = false;
      e.read = readOf<T>(reply as T | { error: string });
      logFailure(failuresSaid, what, [...new Set([...e.watchers.values()].map((w) => w.who))].sort().join(", ") || key, e.read);
      e.watchers.forEach((_, l) => l());
    });
  };
  const failedNow = (e: Entry<T>) => e.read.state === "failed" && !e.reading;
  return {
    /** Show `key`'s read to `listener` until the returned function is called; read when it hasn't a current one. */
    watch(key: string, o: { who: string; folder: string | null; load: () => Promise<IpcResult<T>>; turn?: string }, listener: () => void): () => void {
      let e = entries.get(key);
      const fresh = !e;
      if (!e) entries.set(key, (e = { read: LOADING, seq: 0, reading: false, watchers: new Map(), folder: o.folder, turn: o.turn, stale: false, drop: null }));
      const entry = e;
      if (entry.drop) clearTimeout(entry.drop);
      entry.drop = null;
      entry.watchers.set(listener, { who: o.who, load: o.load });
      const otherTurn = o.turn !== undefined && o.turn !== entry.turn;
      if (otherTurn) entry.turn = o.turn;
      if (fresh || otherTurn || entry.stale || failedNow(entry)) run(key);
      return () => {
        entry.watchers.delete(listener);
        if (entry.watchers.size) {
          if (failedNow(entry)) run(key);
          return;
        }
        entry.drop = setTimeout(() => entries.get(key) === entry && !entry.watchers.size && entries.delete(key), keepMs);
      };
    },
    get: (key: string): Read<T> => entries.get(key)?.read ?? LOADING,
    refresh: run,
    /** The turn `key`'s read should be of now: read again when it was made for another. */
    turnIs(key: string, turn: string): void {
      const e = entries.get(key);
      if (!e || e.turn === turn) return;
      e.turn = turn;
      run(key);
    },
    /** Read again the sources `test` picks (a folder that changed); one no card shows, when one next does. */
    refreshWhere(test: (folder: string | null) => boolean): void {
      for (const [key, e] of entries) if (test(e.folder)) run(key);
    },
    /** Read again what failed, which may have been passing: a locked database, a file being replaced. */
    refreshFailed(): void {
      for (const [key, e] of entries) if (failedNow(e)) run(key);
    },
  };
}
type ReadStore<T> = ReturnType<typeof readStore<T>>;

/** A store's read of `key` (null: nothing to read, and no badge), shown while this component is. */
function useStoreRead<T>(store: ReadStore<T>, key: string | null, o: { who: string; folder: string | null; load: () => Promise<IpcResult<T>>; turn?: string }): Read<T> | null {
  const opts = useRef(o);
  opts.current = o;
  const subscribe = useCallback(
    (listener: () => void) => (key ? store.watch(key, { who: opts.current.who, folder: opts.current.folder, load: () => opts.current.load(), turn: opts.current.turn }, listener) : () => {}),
    [store, key]
  );
  const read = useSyncExternalStore(subscribe, () => (key ? store.get(key) : null));
  return key ? read : null;
}

/** The diffs, one read per folder and base, read again when the folder changes and by one slow window-wide safety net. */
const diffs = readStore<BranchStat>("its changes against its base");
/** The last messages, one read per session, read again as its turn moves on, or by the safety net when the read failed. */
const replies = readStore<LastReply>("what it last said");
/** The safety net, for what the folder watch can't see (a commit in a worktree, whose git folder is the main repository's) and reads that failed. */
export const DIFF_SAFETY_MS = 60_000;
let keepingCurrent = false;
function keepReadsCurrent(): void {
  if (keepingCurrent) return;
  keepingCurrent = true;
  onFolderChanged((root) => !document.hidden && diffs.refreshWhere((folder) => folder === root));
  const safety = () => {
    if (document.hidden) return;
    diffs.refreshWhere(() => true);
    replies.refreshFailed();
  };
  setInterval(safety, DIFF_SAFETY_MS);
  document.addEventListener("visibilitychange", safety);
}

/** What the badges need from the window (main.tsx provides it around the landscape). */
export interface BadgeEnv {
  /** The base branch of the area repo the session works in (null: the repository's own). */
  baseOf: (s: SessionInfo, area: string) => string | null;
  /** Why the token meters couldn't be read, or null. */
  metersError: string | null;
}
export const BadgeContext = createContext<BadgeEnv>({ baseOf: () => null, metersError: null });

/**
 * A session's diff against its area repo's base: read while `on`, shared with every other card on its folder, and
 * read again when the folder changes (the folder watch the Changes view refreshes on). None for a teammate's session
 * (its folder is on their Mac), a terminal or session outside git, or one that has exited.
 */
export function useDiff(s: SessionInfo, area: string, on: boolean): Read<BranchStat> | null {
  const env = useContext(BadgeContext);
  const base = env.baseOf(s, area);
  const root = on && s.repoPath && !s.room?.remote && s.status !== "dead" ? s.cwd : null;
  if (root) keepReadsCurrent();
  return useStoreRead(diffs, root && `${root}\0${base ?? ""}`, { who: s.id, folder: root, load: () => window.mb.branchStat(s.id, base) });
}

/**
 * A session's "what it did": read while `on`, and again as its turn moves on (its status, its turn's end, its
 * conversation), since that's when its transcript gains a message, whether its card was on screen for that or not.
 * None for a terminal or a teammate's session.
 */
export function useDid(s: SessionInfo, on: boolean): Read<LastReply> | null {
  const key = on && !s.shell && !s.room?.remote ? s.id : null;
  const turn = `${s.status}|${s.finishedAt ?? ""}|${s.conversation?.id ?? ""}`;
  if (key) keepReadsCurrent();
  const read = useStoreRead(replies, key, { who: s.id, folder: null, load: () => window.mb.lastReply(s.id), turn });
  useEffect(() => {
    if (key) replies.turnIs(key, turn);
  }, [turn, key]);
  return read;
}

/** A card's badges, in the footer's order (design D: diff, then PR, then cost at the end). */
export function useCardBadges(s: SessionInfo, area: string, meter: SessionMeter | undefined): { badges: Badge[]; did: ReturnType<typeof didLine> } {
  const env = useContext(BadgeContext);
  const diff = useDiff(s, area, true);
  const did = useDid(s, true);
  const pipelines = usePipelinesRead();
  const own = !s.room?.remote;
  const badges = [diffBadge(diff), prBadge(s, pipelines), own ? costBadge(s, meter, env.metersError) : null].filter((b): b is Badge => !!b);
  return { badges, did: didLine(did) };
}

/**
 * Badges as drawn at the end of a card's footer: on its one line, the cost last, at the right. Short of width, whole
 * badges give way, the last first: one that doesn't fit beside those before it wraps onto a line the row never shows.
 * `lead` starts the same line and goes the same way, last of all.
 */
export function BadgeRow({ badges, lead }: { badges: readonly Badge[]; lead?: ReactNode }) {
  if (!badges.length && !lead) return null;
  return (
    <span className="ls-badges">
      {lead}
      {badges.map((b) => (
        <span key={b.key} className={`ls-badge b-${b.key} ${b.failed ? "failed" : ""}`} data-badge={b.key} title={b.title}>
          {b.lines ? (
            <>
              <span className="add">+{b.lines.add}</span> <span className="del">−{b.lines.del}</span>
            </>
          ) : (
            b.text
          )}
        </span>
      ))}
    </span>
  );
}

/** The diff as a cell of the workspace's footer in the live and read-only bands (its rail has the PR and the tokens already). */
export function DiffCell({ s, area, on }: { s: SessionInfo; area: string; on: boolean }) {
  const b = diffBadge(useDiff(s, area, on));
  if (!b) return null;
  return (
    <div className={`cell ls-diff ${b.failed ? "failed" : ""}`} data-badge="diff" title={b.title}>
      <span className="k">Diff</span>
      <span className="v">{b.lines ? <><span className="add">+{b.lines.add}</span> <span className="del">−{b.lines.del}</span></> : FAILED}</span>
    </div>
  );
}
