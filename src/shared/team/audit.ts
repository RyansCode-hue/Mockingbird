/**
 * The audit log of remote actions (docs/team-rooms.md, "Remote activity"):
 * one line per thing a teammate did on this Mac, or asked it for — typing
 * asked, allowed, refused and delivered; agent messages; take-overs and
 * hand-overs; scrollback, artifacts and backups served. It records who,
 * which session, when and how much — never what was typed or said.
 */

export type AuditKind =
  /** A teammate asked to type into a session of this Mac's. */
  | "typing.asked"
  /** This Mac's person let them (`until`: null while the session runs). */
  | "typing.allowed"
  | "typing.denied"
  /** This Mac's person took it back. */
  | "typing.revoked"
  | "typing.expired"
  /** The session closed, left the room, was taken over or became a terminal (its agent quit), which ends every grant. */
  | "typing.ended"
  /** A teammate's keys written into a session: `n` writes, `bytes` in all, from `since` to `at`. */
  | "input"
  /** A teammate's keys refused: not allowed (`reason` "view-only") or the agent was asking for permission ("prompt"). */
  | "input.refused"
  /** A teammate read a session's scrollback (opening it, or catching up): `n` reads, `bytes` in all. */
  | "scrollback"
  /** A teammate's agent messaged one of this Mac's sessions: `bytes` of text, `outcome`. */
  | "message"
  /** A teammate asked to continue a session on their laptop: `outcome` handed-over, kept, timeout, refused. */
  | "takeover.asked"
  /** A teammate took one of this Mac's sessions over (it continues on their laptop). */
  | "takeover"
  /** A teammate fetched a room artifact's file from this Mac: `n` pieces, `bytes` in all. */
  | "artifact.served"
  /** A backup of one of this Mac's sessions went to a teammate's Mac, where their agents can read its files and diffs. */
  | "backup.sent"
  /** Phone alerts: an iMessage to the user's own handle about `n` sessions (`session`/`title`: the first), `outcome` sent or why not. */
  | "phone.alert"
  /** Phone alerts: a reply from the user's phone, and what Mockingbird did with it (`outcome`; `bytes` of text for a message). */
  | "phone.reply"
  /**
   * The app Assistant (docs/assistant.md) did something: `tool`, on `session`/`title` when it names one, from `source`
   * (a turn's direct step, a card the user confirmed, an Undo, a standing rule); `outcome` is the step's line and result.
   */
  | "assistant.action";

/** What made the Assistant act: a direct step of a turn, a card's Do it, an Undo, or a standing rule. */
export type AssistantSource = "step" | "card" | "undo" | "rule";

export interface AuditEntry {
  /** When (for an aggregate: the last of it). */
  at: number;
  kind: AuditKind;
  /** The room's name, as it was then. */
  room?: string;
  /** The teammate, by name and id. */
  member?: string;
  memberId?: string;
  /** This Mac's session involved, by id and title. */
  session?: string;
  title?: string;
  /** For a message: the sending session on the teammate's laptop, as they name it. */
  from?: string;
  /** How many (writes, reads, pieces), and their size. Never their content. */
  n?: number;
  bytes?: number;
  /** An aggregate's first. */
  since?: number;
  /** A grant's end: null while the session runs. */
  until?: number | null;
  /** What came of it, in Mockingbird's words (never the teammate's). */
  outcome?: string;
  /** assistant.action: the Assistant's tool, and what made it act. */
  tool?: string;
  source?: AssistantSource;
  reason?: string;
}

const size = (bytes: number | undefined): string => {
  const b = bytes ?? 0;
  if (b < 1024) return `${b} byte${b === 1 ? "" : "s"}`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

const times = (n: number | undefined, one: string, many = `${one}s`) => `${n ?? 0} ${(n ?? 0) === 1 ? one : many}`;

const ASSISTANT_SOURCE_WORDS: Record<AssistantSource, string> = { step: "asked", card: "you confirmed", undo: "Undo", rule: "a standing rule" };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** An entry in plain words, for Settings → Team → Recent remote activity. */
export function auditWords(e: AuditEntry): string {
  const who = e.member ?? "A teammate";
  const what = e.title ? `“${e.title}”` : e.session ? `session ${e.session}` : "a session";
  const span = e.since && e.at - e.since >= 60_000 ? `, ${clock(e.since)}–${clock(e.at)}` : "";
  switch (e.kind) {
    case "typing.asked":
      return `${who} asked to type in ${what}`;
    case "typing.allowed":
      return `You let ${who} type in ${what} ${e.until ? `until ${clock(e.until)}` : "while it runs"}`;
    case "typing.denied":
      return `You didn't let ${who} type in ${what}`;
    case "typing.revoked":
      return `You stopped ${who} typing in ${what}`;
    case "typing.expired":
      return `${who}'s time to type in ${what} ran out`;
    case "typing.ended":
      return `${who} can't type in ${what} any more: ${e.reason ?? "it ended"}`;
    case "input":
      return `${who} typed into ${what}: ${times(e.n, "write")}, ${size(e.bytes)}${span}`;
    case "input.refused":
      return `Refused ${who}'s typing in ${what} (${times(e.n, "write")}, ${size(e.bytes)}): ${e.reason === "prompt" ? "its agent was asking for permission" : "they weren't allowed to type"}${span}`;
    case "scrollback":
      return `${who} read ${what}'s terminal history: ${times(e.n, "time")}, ${size(e.bytes)}${span}`;
    case "message":
      return `${who}'s agent${e.from ? ` “${e.from}”` : ""} messaged ${what} (${size(e.bytes)}): ${e.outcome ?? "unknown outcome"}`;
    case "takeover.asked":
      return `${who} asked to continue ${what} on their laptop: ${e.outcome ?? "no answer"}`;
    case "takeover":
      return `${who} took over ${what}: it continues on their laptop`;
    case "artifact.served":
      return `${who} fetched ${e.title ? `“${e.title}”` : "a room file"} from this Mac: ${size(e.bytes)}${span}`;
    case "backup.sent":
      return `A backup of ${what} went to ${who}'s Mac (${size(e.bytes)}): their agents can read its files and diffs`;
    case "phone.alert":
      return `Phone alert about ${what}${(e.n ?? 1) > 1 ? ` and ${times((e.n ?? 1) - 1, "more session")}` : ""}: ${e.outcome ?? "sent"}`;
    case "phone.reply":
      return `From your phone, ${what}: ${e.outcome ?? "no outcome"}${e.bytes ? ` (${size(e.bytes)})` : ""}`;
    case "assistant.action":
      return `Assistant${e.source ? ` (${ASSISTANT_SOURCE_WORDS[e.source]})` : ""}: ${e.outcome ?? e.tool ?? "an action"}`;
  }
}
