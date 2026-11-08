import { createContext, useContext, useEffect, useRef, useState } from "react";
import { formatShare, formatTokens, isErr, isWorkItemId, stageLabel, ticketIdOf, topOfKey, totalTokens, type BranchStat, type IpcResult, type LastReply, type SessionInfo, type SessionMeter, type TicketPipeline } from "../shared/types";
import { agoShort, plural } from "../shared/format";
import { useFolderRefresh } from "./folderWatch";
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

/** A badge's source as read: not yet, what it said, or why it couldn't be read. */
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

/**
 * The diff badge: "+214 −38" since the worktree forked from its base; "—" when it couldn't be read; none without a
 * source, and none when nothing changed (nothing to say, which isn't a failure).
 */
export function diffBadge(read: Read<BranchStat> | null): Badge | null {
  if (!read || read.state === "loading") return null;
  if (read.state === "failed") return { key: "diff", text: FAILED, failed: true, title: `Couldn't read its changes against its base: ${read.error}` };
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
 * session with no ticket or no PR from its branch; "—" when the pipelines couldn't be read.
 */
export function prBadge(s: Pick<SessionInfo, "ticketId" | "taskGroup" | "branch">, read: PipelinesRead, now = Date.now()): Badge | null {
  const ticket = ticketOfSession(s);
  if (!ticket || !s.branch) return null;
  if (read.error) return { key: "pr", text: FAILED, failed: true, title: `Couldn't read the ticket pipelines: ${read.error}` };
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
 * current 5-hour limit, "22M · 14%". None before it has used any; "—" when the meters couldn't be read.
 */
export function costBadge(meter: SessionMeter | undefined, metersError: string | null): Badge | null {
  if (metersError) return { key: "cost", text: FAILED, failed: true, title: `Couldn't read the token meters: ${metersError}` };
  const tokens = meter ? totalTokens(meter.tokens) : 0;
  if (!meter || !tokens) return null;
  const share = meter.window?.sharePct ?? null;
  return {
    key: "cost",
    text: share === null ? formatTokens(tokens) : `${formatTokens(tokens)} · ${formatShare(share)}`,
    title: [`${formatTokens(tokens)} tokens over its conversations`, share === null ? null : `≈${formatShare(share)} of the current 5-hour limit, its cost on the plan`].filter(Boolean).join("\n"),
  };
}

/** "What it did" as a card's line under its title: the latest message's first line, "—" when it couldn't be read, none before it has said anything. */
export function didLine(read: Read<LastReply> | null, now = Date.now()): { text: string; title: string; failed: boolean } | null {
  if (!read || read.state === "loading") return null;
  if (read.state === "failed") return { text: FAILED, title: `Couldn't read what it last said: ${read.error}`, failed: true };
  const r = read.value;
  return r.line ? { text: r.line, title: `What it said last${r.at ? `, ${agoShort(r.at, now)} ago` : ""}:\n${r.line}`, failed: false } : null;
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

/**
 * One source read for a badge, by `key` (null: there's none, and no badge): read when the key changes, which first
 * forgets what the last key read, and again on `reread`. A read that fails replaces the value, never keeping the one
 * before; only the newest read's answer is taken. A failure is said in the console with `what` and `who` (the session).
 */
function useRead<T>(key: string | null, what: string, who: string, read: () => Promise<IpcResult<T>>): [Read<T> | null, () => void] {
  const [got, setGot] = useState<{ key: string; read: Read<T> } | null>(null);
  const seq = useRef(0);
  const now = useRef({ key, who, read });
  now.current = { key, who, read };
  const reread = useRef(() => {
    const { key: k, who: w, read: r } = now.current;
    if (!k) return;
    const n = ++seq.current;
    void settled(r()).then((reply) => {
      if (n !== seq.current || now.current.key !== k) return;
      const next = readOf<T>(reply as T | { error: string });
      logFailure(failuresSaid, what, w, next);
      setGot({ key: k, read: next });
    });
  }).current;
  useEffect(reread, [key]);
  if (!key) return [null, reread];
  return [got?.key === key ? got.read : { state: "loading" }, reread];
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
 * A session's diff against its area repo's base: read while `on`, refreshed when its folder changes, with the same
 * folder watch the Changes view refreshes on (useFolderRefresh) and its fallback. None for a teammate's session (its
 * folder is on their Mac), a terminal or session outside git, or one that has exited.
 */
export function useDiff(s: SessionInfo, area: string, on: boolean): Read<BranchStat> | null {
  const env = useContext(BadgeContext);
  const base = env.baseOf(s, area);
  const root = on && s.repoPath && !s.room?.remote && s.status !== "dead" ? s.cwd : null;
  const [read, reread] = useRead<BranchStat>(root && `${s.id}\0${root}\0${base ?? ""}`, "its changes against its base", s.id, () => window.mb.branchStat(s.id, base));
  useFolderRefresh(root, reread, 30_000);
  return read;
}

/**
 * A session's "what it did": read while `on`, and again as its turn moves on (its status, its turn's end, its
 * conversation), since that's when its transcript gains a message. None for a terminal or a teammate's session.
 */
export function useDid(s: SessionInfo, on: boolean): Read<LastReply> | null {
  const key = on && !s.shell && !s.room?.remote ? s.id : null;
  const turn = `${s.status}|${s.finishedAt ?? ""}|${s.conversation?.id ?? ""}`;
  const [read, reread] = useRead<LastReply>(key, "what it last said", s.id, () => window.mb.lastReply(s.id));
  const first = useRef(true);
  useEffect(() => {
    // the key's own read covers the first render
    if (first.current) first.current = false;
    else reread();
  }, [turn]);
  return read;
}

/** A card's badges, in the footer's order (design D: diff, then PR, then cost at the end). */
export function useCardBadges(s: SessionInfo, area: string, meter: SessionMeter | undefined): { badges: Badge[]; did: ReturnType<typeof didLine> } {
  const env = useContext(BadgeContext);
  const diff = useDiff(s, area, true);
  const did = useDid(s, true);
  const pipelines = usePipelinesRead();
  const own = !s.room?.remote;
  const badges = [diffBadge(diff), prBadge(s, pipelines), own ? costBadge(meter, env.metersError) : null].filter((b): b is Badge => !!b);
  return { badges, did: didLine(did) };
}

/** Badges as drawn in a card's footer (or the workspace's): each cut short before it can leave it. */
export function BadgeRow({ badges }: { badges: readonly Badge[] }) {
  if (!badges.length) return null;
  return (
    <span className="ls-badges">
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
      <span className="v">{b.lines ? <><span className="add">+{b.lines.add}</span> <span className="del">−{b.lines.del}</span></> : b.text}</span>
    </div>
  );
}
