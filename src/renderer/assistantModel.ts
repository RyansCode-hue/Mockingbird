import { ASSISTANT_LIMITS, type AssistantCard, type AssistantStep, type AssistantView } from "../shared/assistant";

/** The app Assistant's window-side rules (docs/assistant.md → The tab and ⌘K): where ⌘K offers it, what the tab offers when. */

/** This many words read as a sentence: Ask Assistant comes first. */
export const ASK_FIRST_WORDS = 3;

/** A label's or a query's words, lowercased, without punctuation: "Go to #5102 —" is go, to, 5102. */
const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Where ⌘K's Ask row goes for what was typed, given the labels of the rows it matched: nowhere for nothing; first when
 * nothing matches or it reads as a sentence; last otherwise. Words that all begin words of one row's label ("go to
 * 5102" for "Go to #5102 Pathways…", "Toggle the log panel") are that row's command however many there are, so ⏎ still
 * runs it.
 */
export function askPlace(query: string, labels: readonly string[]): "none" | "first" | "last" {
  const typed = wordsOf(query);
  if (!query.trim()) return "none";
  if (!labels.length) return "first";
  const commandOf = (label: string) => {
    const words = wordsOf(label);
    return typed.length > 0 && typed.every((t) => words.some((w) => w.startsWith(t)));
  };
  if (labels.some(commandOf)) return "last";
  return query.trim().split(/\s+/).length >= ASK_FIRST_WORDS ? "first" : "last";
}

/** A direct step's Undo is offered while its window is open. */
export const undoLive = (s: AssistantStep, now: number): boolean => s.tier === "direct" && s.state === "done" && typeof s.undoUntil === "number" && s.undoUntil > now;

/** A card's state as shown: an open one past its time is expired (main expires it, and until it says so it's offered no more). */
export const cardState = (c: AssistantCard, now: number): AssistantCard["state"] => (c.state === "open" && c.expiresAt <= now ? "expired" : c.state);

/** The next moment something the tab shows changes on its own (an Undo going, a card lapsing), or null for none. */
export function nextChange(view: AssistantView, now: number): number | null {
  const steps = [...view.turns.flatMap((t) => t.steps), ...view.runs.flatMap((r) => r.steps)];
  const ends = [...steps.filter((s) => undoLive(s, now)).map((s) => s.undoUntil!), ...view.cards.filter((c) => c.state === "open" && c.expiresAt > now).map((c) => c.expiresAt)];
  return ends.length ? Math.min(...ends) : null;
}

/** What the empty tab offers to put in the message box. */
export const ASK_EXAMPLES: readonly string[] = ["What's waiting on me?", "Which sessions have unpushed commits?", "When a session finishes, notify me"];

const count = (n: number): string => n.toLocaleString("en-US");

/**
 * What the message box's text asks, trimmed as main trims it; or why it doesn't: null for nothing typed (Enter does
 * nothing), else that it's past the limit, said rather than cut.
 */
export function askable(text: string): { ok: true; text: string } | { ok: false; why: string | null } {
  const t = text.trim();
  if (!t) return { ok: false, why: null };
  if (t.length > ASSISTANT_LIMITS.maxQuestion) return { ok: false, why: `That's ${count(t.length)} characters: the Assistant takes at most ${count(ASSISTANT_LIMITS.maxQuestion)}` };
  return { ok: true, text: t };
}

/** The message box's count once it nears the limit ("3,812 / 4,000"); null before then. */
export function askCounter(text: string): string | null {
  const n = text.trim().length;
  return n >= ASSISTANT_LIMITS.maxQuestion * 0.9 ? `${count(n)} / ${count(ASSISTANT_LIMITS.maxQuestion)}` : null;
}

/** The question asked last, answered or refused (↑ in an empty message box brings it back); null before any. */
export function lastQuestion(turns: readonly { at: number; text: string }[], failures: readonly { at: number; text: string }[]): string | null {
  let last: { at: number; text: string } | null = null;
  for (const q of [...turns, ...failures]) if (!last || q.at >= last.at) last = q;
  return last?.text ?? null;
}
