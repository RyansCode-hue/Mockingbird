/**
 * Text that doesn't show as what it is: characters that draw as nothing or reorder what's around them, and control
 * characters, which a terminal acts on rather than shows. A plan or a template is laid out as the user read it, so
 * neither may hold them where the user reads it and an agent or a shell is sent it.
 */

/**
 * Every character that draws as nothing or reorders text: format characters (`\p{Cf}`: bidi controls and marks,
 * zero-width characters, the soft hyphen, tag characters), U+2065 (unassigned, in the range), the Hangul fillers
 * (U+115F, U+1160, U+3164, U+FFA0), the combining grapheme joiner (U+034F) and the variation selectors (U+FE00–FE0F,
 * U+E0100–E01EF), which are marks by Unicode's reckoning and invisible all the same.
 */
export const INVISIBLE_RE = /[\p{Cf}\u2060-\u2069\u115f\u1160\u3164\uffa0\u034f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/**
 * Control characters but newline and tab: C0, DEL and C1. Typed into a shell they recall history, edit the line or
 * start an escape sequence, so what runs differs from what was shown; in an agent's prompt a carriage return sends it.
 */
export const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** Whether `text` holds a character of `re`'s, without leaving the global regex's position behind. */
const holds = (re: RegExp, text: string): boolean => {
  re.lastIndex = 0;
  const found = re.test(text);
  re.lastIndex = 0;
  return found;
};

/** Why `text`, at `where`, can't be laid out as it shows, or null: it holds invisible or control characters. */
export function hiddenTextRefusal(where: string, text: string): string | null {
  if (holds(CONTROL_RE, text)) return `${where} holds control characters, which a terminal or an agent acts on rather than shows: retype it.`;
  if (holds(INVISIBLE_RE, text)) return `${where} holds invisible characters, which can hide or reorder text where you read it: retype it.`;
  return null;
}

/** `s` with its invisible and control characters taken out, on one line, at most `max` characters: a title as it's shown and sent. */
export function visibleLine(s: unknown, max = 200): string {
  return String(s ?? "")
    .replace(INVISIBLE_RE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}
