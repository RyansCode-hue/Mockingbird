import type { AgentKind } from "./types";

/**
 * How close a session is to its context limit, when to warn about it, and
 * what re-reading a conversation is likely to cost. Pure: the renderer and
 * the main process both use it.
 */

// ---- context warnings ----------------------------------------------------------

/**
 * What Claude Code keeps free below the context window before it compacts by
 * itself (2.1.310: the output reserve, min(max output, 20k), plus a 13k
 * buffer). A 200k window auto-compacts at about 167k; 1M at about 967k.
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE or /autocompact can move it — the warning
 * then comes a little early or late, never mid-turn.
 */
export const CLAUDE_COMPACT_RESERVE = 33_000;

/**
 * The two warnings, as shares of the usable window (Claude: up to its
 * auto-compact point; Codex: the window it reports). 75% leaves room for a
 * few long turns — the time to compact on your own terms, while the details
 * are still there to keep. 90% is the last turn or two before Claude
 * compacts by itself (which keeps only its own summary) or Codex runs out:
 * 17k tokens on a 200k window.
 */
export const HEADS_UP = 0.75;
export const FIRM = 0.9;

export type ContextLevel = 0 | 1 | 2;

export interface ContextBudget {
  /** 0: fine · 1: heads-up · 2: firm. */
  level: ContextLevel;
  tokens: number;
  window: number;
  /** Where the agent compacts or stops by itself. */
  usable: number;
  /** Tokens used, % of `usable` (can pass 100 between a compaction's start and its end). */
  pct: number;
  /** Tokens left before `usable`, never below 0. */
  left: number;
  /** Claude compacts by itself at `usable`; Codex's own limit isn't reported, so its window stands in. */
  autoCompacts: boolean;
}

/** Where an agent compacts or runs out: Claude below its window by CLAUDE_COMPACT_RESERVE; Codex at its window. */
export function usableWindow(agent: AgentKind, window: number): number {
  if (agent === "claude" && window > CLAUDE_COMPACT_RESERVE * 2) return window - CLAUDE_COMPACT_RESERVE;
  return window;
}

export function contextBudget(r: { agent: AgentKind; tokens: number; window: number }): ContextBudget {
  const usable = usableWindow(r.agent, r.window);
  const share = usable > 0 ? r.tokens / usable : 0;
  return {
    level: share >= FIRM ? 2 : share >= HEADS_UP ? 1 : 0,
    tokens: r.tokens,
    window: r.window,
    usable,
    pct: share * 100,
    left: Math.max(0, usable - r.tokens),
    autoCompacts: r.agent === "claude",
  };
}

/** A session's warning dismissed at a level: it stays hidden there, and comes back at the next one. */
export interface Dismissal {
  level: 1 | 2;
}

/** The warning a pane shows: its level, unless dismissed at that level (or a higher one). */
export function shownLevel(level: ContextLevel, dismissed: Dismissal | undefined): ContextLevel {
  return level > (dismissed?.level ?? 0) ? level : 0;
}

/**
 * A dismissal still in force at `level`. One whose level the session has
 * dropped below (it compacted, or started a fresh conversation) is over: the
 * next rise warns again.
 */
export function keepDismissal(d: Dismissal | undefined, level: ContextLevel): Dismissal | undefined {
  return d && level >= d.level ? d : undefined;
}

/**
 * Why Compact can't be sent to a session now, or null when it can: only to
 * an idle session at its prompt, with nothing of the user's typed there —
 * never mid-turn (it would queue behind the turn, or interrupt it), never on
 * a permission prompt (Enter would answer it), never onto a draft (Enter
 * would send that along).
 */
export function compactBlocker(s: {
  status: string;
  shell?: boolean;
  remote?: boolean;
  draft?: boolean;
  starting?: boolean;
  compactSentAt?: number | null;
}, now = Date.now()): string | null {
  if (s.shell) return "A terminal has no context to compact";
  if (s.remote) return "It runs on a teammate's Mac";
  if (s.status === "dead") return "The session isn't running";
  if (s.status === "waiting") return "It's asking for permission: answer that first";
  if (s.status === "working") return "It's mid-turn: Compact once it's back at its prompt";
  if (s.status !== "idle") return `It's ${s.status}`;
  if (s.starting) return "It's still starting";
  if (s.draft) return "There's unsent text in its prompt: send or clear it first";
  if (s.compactSentAt && now - s.compactSentAt < COMPACT_RESEND_MS) return "Compact was just sent: it's compacting";
  return null;
}
/** A second Compact within this long of the first is refused: the first is still running (it reports no status of its own). */
export const COMPACT_RESEND_MS = 90_000;

// ---- what tokens cost ----------------------------------------------------------

/**
 * Relative weight per million tokens: [input, output, cache read, cache write]
 * (API list prices, as relative weights). Plans don't say what a 5-hour
 * window holds, so shares of it are estimated from these. A cache write is
 * 1.25× input, a cache read 0.1×.
 */
const CLAUDE_OPUS = [15, 75, 1.5, 18.75];
const CLAUDE_SONNET = [3, 15, 0.3, 3.75];
const CLAUDE_HAIKU = [1, 5, 0.1, 1.25];
// OpenAI caches without a write charge: a miss is plain input
const CODEX = [1.25, 10, 0.125, 1.25];

export function weightsFor(agent: AgentKind, model: string | null | undefined): number[] {
  if (agent === "codex") return CODEX;
  const m = (model ?? "").toLowerCase();
  if (/haiku/.test(m)) return CLAUDE_HAIKU;
  if (/sonnet/.test(m)) return CLAUDE_SONNET;
  return CLAUDE_OPUS; // opus, fable, and models not yet known: the dearer guess
}

/**
 * Weighted units per 1% of the 5-hour limit: what this Mac's sessions used in
 * the current window over its reported %. Null below 1% used, where the ratio
 * says nothing.
 */
export function unitsPerPct(windowUnits: number, usedPct: number): number | null {
  return usedPct >= 1 && windowUnits > 0 ? windowUnits / usedPct : null;
}

/** How long a prompt cache lasts with no request, when the agent hasn't said (Claude's default TTL). */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export interface PromptCache {
  /** The cached prefix was inside its TTL at the last report. */
  warm: boolean;
  /** When it goes cold, ms; null when the last response cached nothing. */
  expiresAt: number | null;
}

export interface CostEstimate {
  tokens: number;
  cold: boolean;
  /** A new conversation: nothing of it was ever cached. */
  fresh: boolean;
  /** Why it's taken to be cold or warm, in a few words. */
  why: string;
  /** Weighted units: what it costs as estimated, and what it would cost from a warm cache. */
  units: number;
  warmUnits: number;
  /** Estimated % of the 5-hour limit; null when the plan's reading can't say. */
  sharePct: number | null;
  /** Big enough to ask before doing it. */
  ask: boolean;
}

/**
 * Several resumes' estimates as one, so a batch (a stack's tabs, Reopen all) asks once: tokens and units added, a
 * share only when every one has one, cold when any is, and asked about when any would be alone.
 */
export function sumEstimates(es: readonly CostEstimate[]): CostEstimate {
  const add = (f: (e: CostEstimate) => number) => es.reduce((n, e) => n + f(e), 0);
  return {
    tokens: add((e) => e.tokens),
    cold: es.some((e) => e.cold),
    fresh: es.length > 0 && es.every((e) => e.fresh),
    why: (es.find((e) => e.cold) ?? es[0])?.why ?? "",
    units: add((e) => e.units),
    warmUnits: add((e) => e.warmUnits),
    sharePct: es.every((e) => e.sharePct !== null) ? add((e) => e.sharePct!) : null,
    ask: es.some((e) => e.ask),
  };
}

/** Ask before an action estimated at this much of the 5-hour limit or more… */
export const ASK_SHARE_PCT = 5;
/** …or, with no plan reading to estimate from, this many tokens re-read cold. */
export const ASK_TOKENS = 150_000;

/**
 * What the next request costs when it sends `tokens` of conversation: from
 * the cache when it's warm (0.1× input), written to it again when it's cold
 * (Claude: 1.25× input; Codex: plain input). `cache` is what the agent last
 * reported; without it the cache is taken to be cold once `lastAt` is more
 * than DEFAULT_CACHE_TTL_MS ago. `fresh`: a new conversation, never cached.
 */
export function rereadCost(o: {
  agent: AgentKind;
  model?: string | null;
  tokens: number;
  cache?: PromptCache | null;
  lastAt?: number | null;
  fresh?: boolean;
  now: number;
  unitsPerPct: number | null;
}): CostEstimate {
  const [input, , read, write] = weightsFor(o.agent, o.model);
  let cold: boolean;
  let why: string;
  if (o.fresh) {
    cold = true;
    why = "a new conversation has nothing cached";
  } else if (o.cache) {
    cold = !(o.cache.warm && o.cache.expiresAt !== null && o.cache.expiresAt > o.now);
    why = cold ? (o.cache.expiresAt !== null && o.cache.expiresAt <= o.now ? `its cache went cold ${ago(o.now - o.cache.expiresAt)} ago` : "its last reply cached nothing") : "its cache is still warm";
  } else if (o.lastAt) {
    const idle = o.now - o.lastAt;
    cold = idle > DEFAULT_CACHE_TTL_MS;
    why = cold ? `its last reply was ${ago(idle)} ago, past the cache's 5 minutes` : "it replied within the cache's 5 minutes";
  } else {
    cold = true;
    why = "its cache can't be known, so it's taken to be cold";
  }
  const coldWeight = o.agent === "claude" ? write : input;
  const warmUnits = (o.tokens * read) / 1e6;
  const units = cold ? (o.tokens * coldWeight) / 1e6 : warmUnits;
  const sharePct = o.unitsPerPct ? units / o.unitsPerPct : null;
  const ask = cold && (sharePct !== null ? sharePct >= ASK_SHARE_PCT : o.tokens >= ASK_TOKENS);
  return { tokens: o.tokens, cold, fresh: !!o.fresh, why, units, warmUnits, sharePct, ask };
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} hr${m % 60 ? ` ${m % 60} min` : ""}` : `${Math.floor(h / 24)} d`;
}

/** "380k", "1.2M", "900": tokens as said in a sentence. */
export function roughTokens(n: number): string {
  if (n >= 1e6) return `${(Math.round(n / 1e5) / 10).toString()}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "12%", "0.4%", "under 0.1%". */
export function roughShare(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${Math.round(pct * 10) / 10}%`;
  return "under 0.1%";
}

/**
 * The estimate in plain words: "Resuming this re-reads about 380k tokens,
 * roughly 12% of your 5-hour limit." `doing` starts the sentence.
 */
export function costSentence(doing: string, e: CostEstimate, what = "re-reads"): string {
  const share = e.sharePct === null ? "" : e.sharePct < 0.1 ? ", under 0.1% of your 5-hour limit" : `, roughly ${roughShare(e.sharePct)} of your 5-hour limit`;
  return `${doing} ${what} about ${roughTokens(e.tokens)} tokens${share}.`;
}

/** Why: cold or warm, and what that does to the price. */
export function costWhy(e: CostEstimate, agent: AgentKind): string {
  if (!e.cold) return `It's cheap now: ${e.why}, and a cached read costs about a tenth of new input.`;
  const factor = e.warmUnits > 0 ? Math.round(e.units / e.warmUnits) : null;
  if (e.fresh) return agent === "claude" ? "A new conversation has nothing cached: all of it is written to the cache, at about 1.25× the input price." : "A new conversation has nothing cached: all of it is sent as new input.";
  const price = agent === "claude" ? "written to the cache again at about 1.25× the input price" : "sent as new input";
  return `Cold: ${e.why}, so they're ${price}${factor ? ` — about ${factor}× what a warm cache would cost` : ""}.`;
}

/** A brief's length in tokens, roughly (about four characters each). */
export const briefTokens = (chars: number): number => Math.ceil(chars / 4);
