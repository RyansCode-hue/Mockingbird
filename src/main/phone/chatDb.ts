import { execFile } from "child_process";
import * as os from "os";
import * as path from "path";
import { normalizeHandle } from "../../shared/phoneAlerts";

/**
 * Replies to phone alerts, read from Messages' own database
 * (~/Library/Messages/chat.db). macOS lets an app read it only with Full Disk
 * Access: Messages has no AppleScript for reading messages, and its
 * "message received" script handlers are gone from current macOS.
 *
 * Only the user's self-conversation is read: a one-to-one iMessage chat
 * whose one participant is the user's own handle. Other conversations'
 * messages are never selected — the queries name the self-chat's rows, so
 * their text never leaves the database. Reads go through /usr/bin/sqlite3,
 * read-only; the handle is spliced in only as a hex literal, so nothing in
 * it can be SQL.
 */
export const CHAT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");

/** A message in the self-conversation, newer than the cursor it was asked for. */
export interface SelfMessage {
  rowid: number;
  /** When it was sent, in ms since 1970. */
  at: number;
  text: string;
  fromMe: boolean;
}

/** Where replies come from (a fixture database in tests). */
export interface MessageSource {
  /** The newest message's row id: replies are rows after it. Reads no message. */
  top(): Promise<number>;
  /** Messages in `handle`'s self-conversation after row `after`, oldest first, and the last row looked at (the next call's `after`). */
  selfMessages(handle: string, after: number): Promise<{ messages: SelfMessage[]; through: number }>;
}

export type ChatDbProblem = "no-access" | "missing" | "failed";

export class ChatDbError extends Error {
  constructor(
    readonly problem: ChatDbProblem,
    message: string
  ) {
    super(message);
  }
}

/** sqlite3's failure, in words for Settings. */
export function chatDbProblem(stderr: string, file: string): ChatDbError {
  const e = stderr.trim();
  if (/authorization denied|operation not permitted|not authorized/i.test(e)) {
    return new ChatDbError("no-access", "macOS won't let Mockingbird read Messages: grant it Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then check again.");
  }
  if (/unable to open database|no such file/i.test(e)) return new ChatDbError("missing", `There's no Messages database at ${file}: Messages hasn't been used on this Mac, or Full Disk Access isn't granted.`);
  if (/no such table|no such column/i.test(e)) return new ChatDbError("failed", `Messages' database isn't laid out as Mockingbird expects (${e.slice(0, 200)}): replies can't be read on this macOS.`);
  return new ChatDbError("failed", `Couldn't read Messages' database: ${e.slice(0, 300) || "sqlite3 failed without saying why"}`);
}

/** Apple's clock: since 2001-01-01, in nanoseconds (seconds before macOS 10.13). */
const APPLE_EPOCH_MS = 978_307_200_000;
export const appleDateMs = (d: number): number => (d > 1e12 ? d / 1e6 : d * 1000) + APPLE_EPOCH_MS;

/**
 * The text of a message whose `text` column is empty, from its
 * attributedBody: an NSAttributedString in Apple's typedstream format. The
 * string follows the NSString class name: a '+' byte, its length (one byte;
 * 0x81 and two bytes; 0x82 and four, little-endian), then UTF-8.
 */
export function attributedText(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const b = Buffer.from(hex, "hex");
  const at = b.indexOf("NSString");
  if (at < 0) return null;
  let i = b.indexOf(0x2b, at + 8);
  if (i < 0 || i > at + 16) return null;
  i++;
  let len = b[i++];
  if (len === 0x81) {
    len = b.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    len = b.readUInt32LE(i);
    i += 4;
  }
  if (len === undefined || i + len > b.length) return null;
  return b.subarray(i, i + len).toString("utf8");
}

/** A string as a SQLite literal that can't be anything but that string. */
const hexText = (s: string) => `CAST(X'${Buffer.from(s, "utf8").toString("hex")}' AS TEXT)`;

const int = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`not a row id: ${n}`);
  return n;
};

export type RunFile = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }, cb: (err: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void) => unknown;

export class ChatDb implements MessageSource {
  constructor(
    readonly file: string = CHAT_DB,
    private run: RunFile = execFile as unknown as RunFile,
    private sqlite = "/usr/bin/sqlite3"
  ) {}

  private query<T>(sql: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.run(this.sqlite, ["-readonly", "-json", this.file, sql], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, out, stderr) => {
        if (err) return reject(err.killed ? new ChatDbError("failed", "Reading Messages' database took over 15 seconds") : chatDbProblem(String(stderr ?? "") || err.message, this.file));
        const text = String(out ?? "").trim();
        try {
          resolve(text ? (JSON.parse(text) as T[]) : []);
        } catch {
          reject(new ChatDbError("failed", `sqlite3 answered something that isn't JSON: ${text.slice(0, 120)}`));
        }
      });
    });
  }

  async top(): Promise<number> {
    const rows = await this.query<{ top: number | null }>("SELECT MAX(ROWID) AS top FROM message;");
    return Number(rows[0]?.top ?? 0);
  }

  /**
   * The self-conversation's chats: iMessage, one-to-one (style 45), named by
   * the handle, with no participant but the handle itself. A group chat, an
   * SMS thread, or a chat someone else is in never counts.
   */
  private async selfChats(handle: string): Promise<number[]> {
    const chats = await this.query<{ id: number }>(
      `SELECT ROWID AS id FROM chat WHERE style = 45 AND service_name = 'iMessage' AND lower(chat_identifier) = lower(${hexText(handle)});`
    );
    if (!chats.length) return [];
    const ids = chats.map((c) => int(Number(c.id)));
    const members = await this.query<{ chat: number; handle: string | null }>(
      `SELECT j.chat_id AS chat, h.id AS handle FROM chat_handle_join j LEFT JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id IN (${ids.join(",")});`
    );
    return ids.filter((id) => {
      const own = members.filter((m) => Number(m.chat) === id);
      return own.length > 0 && own.every((m) => normalizeHandle(m.handle) === handle);
    });
  }

  async selfMessages(handle: string, after: number): Promise<{ messages: SelfMessage[]; through: number }> {
    const chats = await this.selfChats(handle);
    if (!chats.length) return { messages: [], through: after };
    type Row = { rowid: number; date: number; fromMe: number; service: string | null; handle: string | null; text: string | null; body: string | null; itemType: number | null; assoc: number | null };
    const rows = await this.query<Row>(
      "SELECT m.ROWID AS rowid, m.date AS date, m.is_from_me AS fromMe, m.service AS service, h.id AS handle, m.text AS text, " +
        "CASE WHEN m.text IS NULL OR m.text = '' THEN hex(m.attributedBody) END AS body, m.item_type AS itemType, m.associated_message_type AS assoc " +
        "FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id " +
        `WHERE j.chat_id IN (${chats.join(",")}) AND m.ROWID > ${int(after)} ORDER BY m.ROWID LIMIT 200;`
    );
    const out: SelfMessage[] = [];
    let through = after;
    for (const r of rows) {
      through = Math.max(through, Number(r.rowid));
      // an iMessage (Apple vouches for its sender), a plain message (no tapback, no group event), from the handle itself
      if (r.service !== "iMessage" || (r.itemType ?? 0) !== 0 || (r.assoc ?? 0) !== 0) continue;
      if (!r.fromMe && normalizeHandle(r.handle) !== handle) continue;
      const text = r.text || attributedText(r.body);
      if (!text) continue;
      out.push({ rowid: Number(r.rowid), at: appleDateMs(Number(r.date)), text, fromMe: !!r.fromMe });
    }
    return { messages: out, through };
  }
}
