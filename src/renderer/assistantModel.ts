import type { AssistantCard, AssistantStep, AssistantView } from "../shared/assistant";

/** The app Assistant's window-side rules (docs/assistant.md → The sheet and ⌘K): where ⌘K offers it, what the sheet offers when. */

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

/** The next moment something the sheet shows changes on its own (an Undo going, a card lapsing), or null for none. */
export function nextChange(view: AssistantView, now: number): number | null {
  const steps = [...view.turns.flatMap((t) => t.steps), ...view.runs.flatMap((r) => r.steps)];
  const ends = [...steps.filter((s) => undoLive(s, now)).map((s) => s.undoUntil!), ...view.cards.filter((c) => c.state === "open" && c.expiresAt > now).map((c) => c.expiresAt)];
  return ends.length ? Math.min(...ends) : null;
}
