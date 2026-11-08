/**
 * The status bar's notes of reads that failed, one for each source, so one read's retries never overwrite another's
 * note. A note dismissed stays dismissed while its source keeps failing with the same words, as a read retried on a
 * timer would otherwise bring it straight back; a different failure is news, and a success forgets it.
 */
export type ReadNotes = {
  /** What's on the bar: each source's note. */
  shown: Readonly<Record<string, string>>;
  /** What was dismissed: each source's words, until it's read, or fails with others. */
  dismissed: Readonly<Record<string, string>>;
};

export const NO_READ_NOTES: ReadNotes = { shown: {}, dismissed: {} };

const without = (r: Readonly<Record<string, string>>, key: string): Record<string, string> => {
  const { [key]: _, ...rest } = r;
  return rest;
};

/** Reading `what` failed, saying `text`. */
export function noteFailed(n: ReadNotes, what: string, text: string): ReadNotes {
  if (Object.hasOwn(n.dismissed, what) && n.dismissed[what] === text) return n;
  if (Object.hasOwn(n.shown, what) && n.shown[what] === text) return n;
  return { shown: { ...n.shown, [what]: text }, dismissed: without(n.dismissed, what) };
}

/** `what` was read. */
export function noteCleared(n: ReadNotes, what: string): ReadNotes {
  if (!Object.hasOwn(n.shown, what) && !Object.hasOwn(n.dismissed, what)) return n;
  return { shown: without(n.shown, what), dismissed: without(n.dismissed, what) };
}

/** `what`'s note was dismissed. */
export function noteDismissed(n: ReadNotes, what: string): ReadNotes {
  if (!Object.hasOwn(n.shown, what)) return n;
  return { shown: without(n.shown, what), dismissed: { ...n.dismissed, [what]: n.shown[what] } };
}
