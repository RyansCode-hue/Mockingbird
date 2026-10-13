/**
 * Team rooms: migration number reservations (docs/team-rooms.md, "Teammates'
 * changes and migration numbers"). Two branches that each add migration 0025
 * conflict when the second one merges; a room member's agent reserves the
 * next number first (`migration.reserved`, a signed room event), and
 * Mockingbird holds back an agent creating a migration file whose number
 * isn't reserved for its user.
 *
 * Plain code with no Node or Electron APIs: the window, the main process and
 * the generated hook script (which embeds migrationHit and
 * migrationHookResponse by their source) all use it.
 */
import { PLAN_DIR } from "./claims";
import type { MemberId, RoomId } from "./types";

/** Each worktree's copy of its room's migration folders and live reservations, for the hook. */
export const MIGRATIONS_FILE = `${PLAN_DIR}/migrations.json`;

/** The agents' tools for reservations. */
export const MIGRATION_TOOL = { reserve: "reserve_migration_number", list: "list_migration_reservations", release: "release_migration_number" } as const;

/** At most this many reservations a room keeps: released ones go first (live ones are never dropped). */
export const MAX_RESERVATIONS = 400;
/** A migration number's digits: up to 15, so every one is a safe integer (timestamps like 20261012093000 fit). */
export const MAX_DIGITS = 15;

/**
 * A migration file's number, from its name: an optional V (Flyway's
 * V25__x.sql), the digits, then `_`, `-` or `.` — 0024_add_x.sql,
 * V25__x.sql, 20261012_x.rb, 001-init.sql. Null for anything else.
 */
export function parseMigrationName(name: string): { prefix: string; digits: string; number: number } | null {
  const m = /^([Vv]?)(\d{1,15})(?=[_.-])/.exec(String(name));
  if (!m) return null;
  return { prefix: m[1], digits: m[2], number: Number(m[2]) };
}

/** A folder Mockingbird takes for numbered migrations, and how its files are named. */
export interface MigrationFolder {
  /** Repository-relative, without a trailing slash. */
  folder: string;
  /** The digits most of its files' numbers have (0024 → 4); 0 when they aren't padded. */
  width: number;
  /** What most of its files' numbers start with: "" or "V". */
  prefix: string;
  /** One of its files, to show the pattern. */
  example: string | null;
  /** How many of its files are numbered, of how many. */
  numbered: number;
  files: number;
}

/** Folders never taken for migrations: dependencies and build output. */
const SKIPPED_RE = /(^|\/)(node_modules|vendor|dist|build|out|bin|obj|target|\.git|\.mockingbird|__pycache__|coverage)(\/|$)/;
/** Folder names that say "migrations". */
const HINT_RE = /(^|\/)([^/]*migrat[^/]*|db|database|schema|sql|versions|flyway|liquibase|changelogs?)(\/|$)/i;
/** Files that don't count against a folder being "mostly numbered". */
const IGNORED_FILE_RE = /^(\.|readme|license|__init__\.py$|index\.(ts|js)$|go\.mod$)/i;

const mostCommon = <T>(xs: T[], fallback: T): T => {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = fallback;
  let n = 0;
  for (const [x, c] of counts) if (c > n) [best, n] = [x, c];
  return best;
};

/**
 * The repository's numbered migration folders, from its files
 * (repository-relative paths, as git lists them). A folder counts when most
 * of its files (60%) start with a number, and either its path says so
 * (migrations, migrate, db, schema, sql, versions…) or two or more of its
 * numbered files are .sql. Dependency and build folders never count.
 * Sorted by path.
 */
export function detectMigrationFolders(files: readonly string[]): MigrationFolder[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const p = String(f).replace(/\\/g, "/").replace(/^\/+/, "");
    const i = p.lastIndexOf("/");
    if (i <= 0) continue; // the repository's top folder is never a migrations folder
    const dir = p.slice(0, i);
    if (SKIPPED_RE.test(dir)) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), p.slice(i + 1)]);
  }
  const out: MigrationFolder[] = [];
  for (const [folder, names] of byDir) {
    const counted = names.filter((n) => !IGNORED_FILE_RE.test(n));
    const parsed = counted.map((n) => ({ n, p: parseMigrationName(n) })).filter((x): x is { n: string; p: NonNullable<ReturnType<typeof parseMigrationName>> } => !!x.p);
    if (!parsed.length || parsed.length / counted.length < 0.6) continue;
    const hint = HINT_RE.test(folder);
    const sql = parsed.filter((x) => /\.sql$/i.test(x.n)).length >= 2;
    if (!hint && !sql) continue;
    if (parsed.length < 2 && !/migrat/i.test(folder)) continue;
    out.push({ folder, ...patternOf(counted), files: counted.length });
  }
  return out.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/**
 * How a folder's files write their numbers: the padding most of them have
 * (0 when none is padded), the prefix most have ("" or "V"), its
 * highest-numbered file as an example, and how many are numbered.
 */
export function patternOf(names: readonly string[]): Omit<MigrationFolder, "folder" | "files"> {
  const parsed = names.map((n) => ({ n: String(n).split("/").pop() ?? "", p: parseMigrationName(String(n).split("/").pop() ?? "") })).filter((x): x is { n: string; p: NonNullable<ReturnType<typeof parseMigrationName>> } => !!x.p);
  const digits = parsed.map((x) => x.p.digits);
  const padded = digits.some((d) => d.length > 1 && d.startsWith("0"));
  return {
    width: padded ? mostCommon(digits.map((d) => d.length), 0) : 0,
    prefix: mostCommon(parsed.map((x) => x.p.prefix.toUpperCase()), ""),
    example: [...parsed].sort((a, b) => b.p.number - a.p.number)[0]?.n ?? null,
    numbered: parsed.length,
  };
}

/** The numbers of the migration files among `names` (file names, or paths: only the last part counts). */
export function migrationNumbers(names: readonly string[]): number[] {
  return names.map((n) => parseMigrationName(String(n).split("/").pop() ?? "")).filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.number);
}

/** The next free number: higher than every one taken (1 when none is). */
export function nextMigrationNumber(taken: readonly number[]): number {
  let max = 0;
  for (const n of taken) if (Number.isSafeInteger(n) && n > max) max = n;
  return max + 1;
}

/** A number as the folder writes it: "0025", "V26", "20261013". */
export function migrationLabel(n: number, folder: Pick<MigrationFolder, "width" | "prefix">): string {
  return `${folder.prefix}${String(n).padStart(folder.width, "0")}`;
}

/** A repository-relative folder as reservations and settings take it: no `..`, no leading or trailing slash, no control characters. */
export function checkFolder(v: unknown): string {
  if (typeof v !== "string") throw new Error("folder must be text");
  const f = v.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!f || f.length > 200) throw new Error("folder must be 1–200 characters");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(f)) throw new Error("folder has control characters");
  if (f.startsWith("/") || f.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Error("folder must be a path inside the repository");
  return f;
}

// ---- the room's record ----------------------------------------------------------------------

/** Why a reservation ended: released by hand, its number reached the base branch, its branch went, or its member left the room. */
export type ReleaseReason = "released" | "merged" | "branch-gone" | "left-room";
export const RELEASE_REASONS: ReleaseReason[] = ["released", "merged", "branch-gone"];

/** A reservation as every member's room state holds it. Its id is its event's. */
export interface MigrationReservation {
  id: string;
  /** Who reserved it. */
  by: MemberId;
  at: number;
  /** The repository's origin (branchFiles.ts originKey: never a user name or token). */
  repo: string;
  folder: string;
  number: number;
  /** As the folder writes it: "0025". */
  label: string;
  /** The session whose agent reserved it. */
  session: { id: string; title: string };
  ticket: string | null;
  branch: string | null;
  released?: { by: MemberId; at: number; reason: ReleaseReason };
  /** Another member reserved the same number first in the room's order: this one doesn't count (that event's id). */
  clash?: string;
}

export interface MigrationsRoomState {
  reservations: Record<string, MigrationReservation>;
}

declare module "./types" {
  interface RoomEventBodies {
    "migration.reserved": { repo: string; folder: string; number: number; label: string; session: { id: string; title: string }; ticket: string | null; branch: string | null };
    /** `reservation`: the migration.reserved event's id. Counts from its author, or the room's admin. */
    "migration.released": { reservation: string; reason: ReleaseReason };
  }
  interface RoomExtensions {
    migrations: MigrationsRoomState;
  }
}

/** A reservation that holds its number: neither released nor beaten to it. */
export const isLive = (r: MigrationReservation): boolean => !r.released && !r.clash;

// ---- the hook's copy ------------------------------------------------------------------------

/** What the hook reads in each worktree: the room's migration folders for its repository, and who holds which number. */
export interface MigrationsFile {
  mockingbird: "room-migrations/1";
  /** Whose checkout this is: their own reservations never hold an edit back. */
  self?: MemberId;
  rooms: {
    roomId: RoomId;
    room: string;
    /** The room's admin left the check on (the default). */
    check: boolean;
    folders: string[];
    reservations: { folder: string; number: number; label: string; member: { id: MemberId; name: string }; session: string; ticket: string | null; branch: string | null }[];
  }[];
}

export const migrationsFile = (rooms: MigrationsFile["rooms"], self?: MemberId): MigrationsFile => ({ mockingbird: "room-migrations/1", ...(self ? { self } : {}), rooms });

/** A new migration file the hook holds back: its number and who has it, if anyone. */
export interface MigrationHit {
  file: string;
  folder: string;
  number: number;
  /** As the file names it: "0025". */
  label: string;
  room: string;
  /** Who reserved the number; null: nobody has. */
  holder: { name: string; session: string; ticket: string | null; branch: string | null } | null;
}

/**
 * Whether creating `rel` (a path relative to the checkout the file is in,
 * that doesn't exist yet) adds a migration its user hasn't reserved: in a
 * room with the check on, in one of its migration folders, numbered, and
 * that number either someone else's or nobody's. Null when it's fine.
 *
 * Self-contained (no outside references): the hook script embeds its source.
 */
export function migrationHit(file: MigrationsFile, rel: string): MigrationHit | null {
  const norm = String(rel).split("\\").join("/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (!norm || norm === ".." || norm.startsWith("../")) return null;
  const i = norm.lastIndexOf("/");
  if (i <= 0) return null;
  const folder = norm.slice(0, i);
  const m = /^([Vv]?)(\d{1,15})(?=[_.-])/.exec(norm.slice(i + 1));
  if (!m) return null;
  const number = Number(m[2]);
  for (const room of file?.rooms ?? []) {
    if (!room.check || !(room.folders ?? []).includes(folder)) continue;
    const holders = (room.reservations ?? []).filter((r) => r.folder === folder && r.number === number);
    if (holders.some((r) => r.member && r.member.id === file.self)) return null;
    const h = holders[0];
    return { file: norm, folder, number, label: m[1] + m[2], room: room.room, holder: h ? { name: h.member.name, session: h.session, ticket: h.ticket, branch: h.branch } : null };
  }
  return null;
}

/**
 * What the PreToolUse hook answers when an agent creates a migration file its
 * user hasn't reserved: held back once, with the reason and what to do; the
 * same edit again goes through. Names, titles and branches come from
 * teammates: each on one line, quoted unless plain words (agentText.ts,
 * repeated here).
 *
 * Self-contained: the hook script embeds its source.
 */
export function migrationHookResponse(hits: MigrationHit[]): { reason: string; system: string } {
  const line = (s: unknown) =>
    String(s ?? "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ")
      .trim()
      .slice(0, 120)
      .trim();
  const quote = (s: unknown) => JSON.stringify(line(s)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const named = (s: unknown) => (/^[\p{L}\p{N}][\p{L}\p{N} ._'@/-]*$/u.test(line(s)) ? line(s) : quote(s));
  const whose = (h: MigrationHit) => {
    if (!h.holder) return "which isn't reserved for your user";
    const extra = [h.holder.ticket ? `ticket #${named(String(h.holder.ticket).replace(/^#/, ""))}` : null, h.holder.branch ? `branch ${named(h.holder.branch)}` : null].filter(Boolean).join(", ");
    return `which ${named(h.holder.name)}'s session ${quote(h.holder.session)}${extra ? ` (${extra})` : ""} reserved`;
  };
  const parts = hits.map((h) => `${quote(h.file)} would add migration ${h.label} to ${quote(h.folder)}, ${whose(h)}`);
  const folders = [...new Set(hits.map((h) => quote(h.folder)))].join(", ");
  return {
    reason:
      `Mockingbird held this edit back once: ${parts.join("; ")}. Two branches that add the same migration number conflict when they merge. ` +
      `Reserve a number first with the mockingbird reserve_migration_number tool (folder ${folders}) and name the file with the number it returns. ` +
      "If this file must be created as it is, make the same edit again: Mockingbird won't stop it again in this conversation.",
    system: `Mockingbird: ${parts.join("; ")}. The agent was held back once and told to reserve a number; it can repeat the edit to go ahead.`,
  };
}

// ---- what the window is told ----------------------------------------------------------------

/** A room's reservations and migration settings, for the House board's line and Settings → Team. */
export interface MigrationsView {
  roomId: RoomId;
  /** The check is on (the default): agents' unreserved new migrations are held back once. */
  check: boolean;
  /** This install is the room's admin, who alone changes the setting. */
  canChange: boolean;
  adminName: string | null;
  /** The room's repositories here, with the folders detected and any override. */
  repos: { key: string; label: string; detected: string[]; override: string[] | null; problem?: string }[];
  /** Live reservations (and clashes), oldest first. */
  reservations: { id: string; label: string; folder: string; repo: string; member: string; self: boolean; session: string; ticket: string | null; branch: string | null; at: number; clash: boolean }[];
  /** What couldn't be read or done (a fetch, an auto-release), newest last. */
  problems: string[];
}
