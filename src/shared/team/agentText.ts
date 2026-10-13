/**
 * Text a teammate or the House controls (member and room names, session
 * titles, branches, artifact names), as it goes into what an agent reads:
 * on one line, so it can't start a line of its own that looks like
 * Mockingbird's, and quoted where it sits among Mockingbird's words, so it
 * can't close the quotes or open a <fence> of its own.
 */

/** Control characters, newlines and Unicode line breaks included: never in a member's or a room's name (rooms.ts). */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_RUNS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g;

/** `s` on one line: control characters and runs of white space become one space; trimmed, at most `max` characters. */
export function oneLine(s: unknown, max = 200): string {
  return String(s ?? "")
    .replace(CONTROL_RUNS_RE, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** `s` on one line, JSON-quoted, with `<` and `>` escaped: "Nick \u003cdev\u003e". */
export function quoted(s: unknown, max = 200): string {
  return JSON.stringify(oneLine(s, max)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** `s` on one line with `<` and `>` as ‹ ›, for text inside a <fence>: it can't close the fence or open one of its own. Past `max` characters it ends in "…". */
export function fenced(s: unknown, max = 200): string {
  const t = oneLine(s, Infinity).replace(/</g, "‹").replace(/>/g, "›");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Many lines a teammate controls (a diff of their work), between `<tag>` and
 * `</tag>`: the tag is taken out of the text, so it can't end the fence early
 * and go on as Mockingbird's words.
 */
export function block(tag: string, text: string): string {
  const re = new RegExp(`<(\\/?)(${tag.replace(/[^\w-]/g, "")})`, "gi");
  return `<${tag}>\n${String(text).replace(re, "‹$1$2")}\n</${tag}>`;
}

/** Plain words: letters and digits, with spaces and . _ ' @ / - between them. */
const PLAIN_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'@/-]*$/u;

/** A name or a branch among Mockingbird's words: as it is when it's plain words (Nick, 5110-donorApi), else quoted. */
export function named(s: unknown, max = 100): string {
  const t = oneLine(s, max);
  return PLAIN_RE.test(t) ? t : quoted(t, max);
}
