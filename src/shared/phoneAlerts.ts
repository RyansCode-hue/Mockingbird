import { oneLine } from "./team/agentText";

/**
 * Phone alerts (Settings → Notifications → Phone alerts): an iMessage to the
 * user's own handle when a session waits on them or finishes while they're
 * away from the Mac, and — opted into separately — replies from that
 * self-conversation that answer it. This file holds what both processes need:
 * the settings, what an alert says, and what a reply may say.
 *
 * An alert never carries what an agent wrote, a command's arguments or a
 * file's contents: a session's title, its group or ticket, and what it waits
 * on in Mockingbird's words ("permission: Bash"), each on one line, anything
 * shaped like a credential hidden, the whole capped at ALERT_MAX.
 */

export interface PhoneAlertSettings {
  enabled: boolean;
  /** The user's own iMessage handle: their Apple ID email, or their number with its country code. */
  handle: string;
  /** Away once the Mac has had no keyboard or mouse input for this long (or its screen is locked). */
  idleMinutes: number;
  /** Also alert when a session finishes its turn, not only when it waits on you. */
  finished: boolean;
  /** Read replies from the self-conversation (needs Full Disk Access). */
  replies: boolean;
}

export const PHONE_DEFAULTS: PhoneAlertSettings = { enabled: false, handle: "", idleMinutes: 10, finished: true, replies: false };

export const phoneSettings = (s?: Partial<PhoneAlertSettings> | null): PhoneAlertSettings => ({ ...PHONE_DEFAULTS, ...(s ?? {}) });

export const IDLE_MINUTES_CHOICES = [5, 10, 15, 30, 60] as const;

/** The longest an alert's text may be, all sessions in it together. */
export const ALERT_MAX = 600;
/** A session's title in an alert. */
const TITLE_MAX = 60;
/** A reply's text for a session's prompt. */
export const REPLY_TEXT_MAX = 500;

/**
 * The user's handle as Messages and chat.db spell it: an email in lower case,
 * or a phone number as + and its digits. Null for anything else — a number
 * without its country code can't be told apart from someone else's.
 */
export function normalizeHandle(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (/^[^\s@"'\\]{1,64}@[^\s@"'\\]{1,190}\.[A-Za-z]{2,24}$/.test(s)) return s.toLowerCase();
  const digits = s.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  return null;
}

export const HANDLE_HINT = "Your Apple ID email, or your number with its country code (+1 555 123 4567)";

/** What a session waits on, as the pane's banner says it: "permission: Bash", "waiting for you". */
export function shortReason(reason: string | null): string {
  if (!reason) return "waiting for you";
  const perm = reason.match(/needs your permission to (?:use )?(.+)/i);
  if (perm) return `permission: ${perm[1]}`;
  if (/waiting for your input/i.test(reason)) return "waiting for you";
  return reason;
}

/** The tool a permission request names ("Claude needs your permission to use Bash" → Bash); null for anything else. */
export function permissionTool(reason: string | null | undefined): string | null {
  const m = /needs your permission to (?:use )?([A-Za-z0-9_.:-]{1,64})/i.exec(reason ?? "");
  return m ? m[1] : null;
}

export type AlertKind = "permission" | "question" | "finished";

export function alertKind(status: "waiting" | "idle", reason: string | null | undefined): AlertKind {
  if (status === "idle") return "finished";
  return permissionTool(reason) ? "permission" : "question";
}

/**
 * Anything in `s` shaped like a credential, hidden: API keys and tokens by
 * their known prefixes, JWTs, URLs with a password, and any unbroken run of
 * 32+ key-like characters. Titles and group names are the user's own words,
 * but an agent can name a session, and a pasted token in one must not travel.
 */
export function hideSecrets(s: string): string {
  return s
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi, (m) => m.replace(/:[^:@]+@$/, ":[hidden]@"))
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[hidden]")
    .replace(/\b(?:gh[pousr]|github_pat|glpat|xox[abprs])[_-][A-Za-z0-9_-]{10,}/g, "[hidden]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[hidden]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[hidden]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[hidden]");
}

/** `s` as an alert may say it: one line, no credentials, at most `max` characters. */
export const alertLine = (s: unknown, max: number): string => {
  const t = hideSecrets(oneLine(s, Infinity));
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** One session in an alert. `code` is set when replies are on and the kind takes one. */
export interface AlertItem {
  kind: AlertKind;
  title: string;
  /** Its ticket or group, if it has one. */
  where: string | null;
  /** For a permission request: the tool. */
  tool: string | null;
  code: string | null;
}

const what = (i: AlertItem): string =>
  i.kind === "permission" ? `needs permission: ${alertLine(i.tool ?? "a tool", 40)}` : i.kind === "question" ? "has a question for you" : "finished";

const how = (i: AlertItem): string => {
  if (!i.code) return i.kind === "question" ? "Answer it at your Mac." : "";
  if (i.kind === "permission") return `Reply ${i.code} 1 to allow once, ${i.code} 2 to deny.`;
  if (i.kind === "finished") return `Reply ${i.code} and a message to send it to the session.`;
  return "Answer it at your Mac.";
};

const name = (i: AlertItem, max: number): string => {
  const where = i.where ? alertLine(i.where, 24) : "";
  return `“${alertLine(i.title, max)}”${where ? ` (${where})` : ""}`;
};

/**
 * An alert's text. One session: a sentence and how to reply. Several: a
 * count, then a line each. Sessions that don't fit in ALERT_MAX are counted
 * at the end ("+2 more at your Mac"), never cut mid-line.
 */
export function alertText(items: AlertItem[]): string {
  if (!items.length) return "";
  if (items.length === 1) {
    const i = items[0];
    const t = `Mockingbird: ${name(i, TITLE_MAX)} ${what(i)}. ${how(i)}`.trim();
    return t.length <= ALERT_MAX ? t : `${t.slice(0, ALERT_MAX - 1)}…`;
  }
  const waiting = items.filter((i) => i.kind !== "finished").length;
  const head = `Mockingbird: ${items.length} sessions${waiting ? `, ${waiting} waiting on you` : " finished"}`;
  const lines: string[] = [head];
  let len = head.length;
  let shown = 0;
  for (const i of items) {
    const line = `${i.code ? `${i.code} ` : "• "}${name(i, 40)} ${what(i)}`;
    const more = items.length - shown - 1;
    const tail = more ? `\n+${more} more at your Mac` : "";
    if (len + 1 + line.length + tail.length > ALERT_MAX - 80) break;
    lines.push(line);
    len += 1 + line.length;
    shown++;
  }
  if (shown < items.length) lines.push(`+${items.length - shown} more at your Mac`);
  const coded = items.slice(0, shown).filter((i) => i.code);
  if (coded.some((i) => i.kind === "permission")) lines.push("Reply CODE 1 to allow once, CODE 2 to deny");
  if (coded.some((i) => i.kind === "finished")) lines.push("Reply CODE and a message to send it to that session");
  const t = lines.join("\n");
  return t.length <= ALERT_MAX ? t : `${t.slice(0, ALERT_MAX - 1)}…`;
}

// ---- reply codes and replies ---------------------------------------------------------------

/** Letters and digits that can't be misread for each other (no B/8, I/1, O/0, S/5, Z/2). */
export const CODE_LETTERS = "ACDEFGHJKLMNPQRTUVWXY";
export const CODE_DIGITS = "34679";
const CODE_RE = new RegExp(`^#?([${CODE_LETTERS}][${CODE_DIGITS}])$`, "i");

export type ReplyAction = { code: string; action: "allow" } | { code: string; action: "deny" } | { code: string; action: "text"; text: string };

const ALLOW = /^(?:1|allow|yes|y)$/i;
const DENY = /^(?:2|deny|no|n)$/i;

/**
 * What a message in the self-conversation asks, if it's a reply at all: it
 * starts with a code ("K4 1", "#K4 deploy it") or is an answer then a code
 * ("1 K4"). Anything else — a note to self, an alert Mockingbird sent — is
 * null. A text reply keeps its words; parseReply doesn't judge them
 * (replyTextProblem does).
 */
export function parseReply(raw: unknown): ReplyAction | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > REPLY_TEXT_MAX + 16) return null;
  const words = s.split(/\s+/);
  const first = CODE_RE.exec(words[0].replace(/[:.,]$/, ""));
  if (first) {
    const code = first[1].toUpperCase();
    const rest = s.slice(words[0].length).replace(/^\s*[:\-–—]?\s*/, "");
    if (!rest) return null;
    if (ALLOW.test(rest)) return { code, action: "allow" };
    if (DENY.test(rest)) return { code, action: "deny" };
    return { code, action: "text", text: rest };
  }
  if (words.length === 2) {
    const last = CODE_RE.exec(words[1].replace(/[.!]$/, ""));
    if (last) {
      const code = last[1].toUpperCase();
      if (ALLOW.test(words[0])) return { code, action: "allow" };
      if (DENY.test(words[0])) return { code, action: "deny" };
    }
  }
  return null;
}

/**
 * Why a reply's text can't go into a session's prompt, or null. Agents read
 * a leading ! as a shell command and a leading / as one of their own commands
 * (/permissions among them), and # as a memory edit in older Claude Code:
 * none of those is a message, so they're refused rather than rewritten.
 */
export function replyTextProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return "the message is empty";
  if (t.length > REPLY_TEXT_MAX) return `the message is ${t.length} characters; the limit is ${REPLY_TEXT_MAX}`;
  if (/^[!/#]/.test(t)) return `a message can't start with ${t[0]}: agents read that as a command`;
  return null;
}

// ---- status, for Settings ------------------------------------------------------------------

export type RepliesState =
  /** Replies are off: nothing reads Messages. */
  | "off"
  /** Reading works. */
  | "ok"
  /** macOS refused: Full Disk Access isn't granted to Mockingbird. */
  | "no-access"
  /** This build doesn't read Messages (a development build). */
  | "dev"
  | "error";

export interface PhoneStatus {
  away: { away: boolean; why: "locked" | "idle" | "manual" | null; idleSeconds: number };
  /** The last alert or test sent, and how it went. */
  last: { at: number; ok: boolean; detail: string; test: boolean } | null;
  replies: { state: RepliesState; detail: string };
  /** Alerts whose replies are still taken. */
  open: number;
  /** A development build: sends are logged, never made. */
  dev: boolean;
}
