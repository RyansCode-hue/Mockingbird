import { defineEventType, onMemberRemoved, roomAdmin } from "./rooms";
import { CONTROL_CHARS_RE } from "../../shared/team/agentText";
import { BRANCH_RE } from "../../shared/team/house";
import { SESSION_ID_RE } from "../../shared/team/takeover";
import { checkFolder, isLive, MAX_DIGITS, MAX_RESERVATIONS, RELEASE_REASONS, type MigrationReservation, type MigrationsRoomState } from "../../shared/team/migrations";
import type { RoomState } from "../../shared/team/types";

/**
 * Migration number reservations' room events (docs/team-rooms.md,
 * "Teammates' changes and migration numbers"): their checks — an event that
 * fails one is refused, from anyone — and their reducers into
 * `room.ext.migrations`. Importing this module registers them, so it loads
 * before any room log does (index.ts imports it through teamChanges.ts).
 *
 * The first reservation of a number in the room's order holds it: a later
 * one of the same number in the same repository and folder (two members
 * reserving at once, or while apart) is kept but marked `clash`, the same on
 * every member, and holds nothing.
 */

const isObj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b);

/** One line of 1–max characters: names and titles go into what agents read. */
const oneLineText = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string" || v.length < 1 || v.length > max) throw new Error(`${what} must be text of 1–${max} characters`);
  if (CONTROL_CHARS_RE.test(v)) throw new Error(`${what} has control characters (a line break?)`);
  return v;
};

/** An origin key (branchFiles.ts originKey): never credentials, never a line break. */
export function checkRepoKey(v: unknown): string {
  const k = oneLineText(v, "repo", 300);
  if (/\s/.test(k) || /:\/\/[^/]*@/.test(k)) throw new Error("repo must be an origin without a user name or token");
  return k;
}

const migrations = (state: RoomState): MigrationsRoomState => (state.ext.migrations ??= { reservations: {} });

defineEventType("migration.reserved", {
  validate(b) {
    if (!isObj(b)) throw new Error("no body");
    checkRepoKey(b.repo);
    if (checkFolder(b.folder) !== b.folder) throw new Error("folder isn't in its plain form");
    if (!Number.isSafeInteger(b.number) || (b.number as number) < 0 || String(b.number).length > MAX_DIGITS) throw new Error(`number must be a whole number of at most ${MAX_DIGITS} digits`);
    if (typeof b.label !== "string" || !/^[Vv]?\d{1,15}$/.test(b.label) || Number(b.label.replace(/^[Vv]/, "")) !== b.number) throw new Error("label must be the number as the folder writes it");
    if (!isObj(b.session) || typeof b.session.id !== "string" || !SESSION_ID_RE.test(b.session.id)) throw new Error("bad session");
    oneLineText(b.session.title, "session title", 200);
    if (b.ticket !== null) oneLineText(b.ticket, "ticket", 64);
    if (b.branch !== null && (typeof b.branch !== "string" || !BRANCH_RE.test(b.branch) || CONTROL_CHARS_RE.test(b.branch))) throw new Error("bad branch");
  },
  reduce(state, e) {
    const m = migrations(state);
    if (m.reservations[e.id]) return;
    const b = e.body;
    const first = Object.values(m.reservations).find((r) => isLive(r) && r.repo === b.repo && r.folder === b.folder && r.number === b.number);
    m.reservations[e.id] = {
      id: e.id,
      by: e.author,
      at: e.at,
      repo: b.repo,
      folder: b.folder,
      number: b.number,
      label: b.label,
      session: { id: b.session.id, title: b.session.title },
      ticket: b.ticket,
      branch: b.branch,
      ...(first ? { clash: first.id } : {}),
    };
    prune(m);
  },
});

defineEventType("migration.released", {
  validate(b) {
    if (!isObj(b)) throw new Error("no body");
    if (typeof b.reservation !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(b.reservation)) throw new Error("bad reservation id");
    if (!RELEASE_REASONS.includes(b.reason as never)) throw new Error(`reason must be one of ${RELEASE_REASONS.join(", ")}`);
  },
  reduce(state, e) {
    const r = state.ext.migrations?.reservations[e.body.reservation];
    if (!r || r.released) return;
    // its member, or the room's admin (a reservation whose member's Mac is gone for good)
    if (e.author !== r.by && e.author !== roomAdmin(state)) return;
    r.released = { by: e.author, at: e.at, reason: e.body.reason };
  },
});

// a member who leaves or is removed gives their numbers back
onMemberRemoved("migrations", (state, member, e) => {
  for (const r of Object.values(state.ext.migrations?.reservations ?? {})) if (r.by === member && !r.released) r.released = { by: e.author, at: e.at, reason: "left-room" };
});

/** Released reservations beyond MAX_RESERVATIONS go, oldest first; live ones stay. */
function prune(m: MigrationsRoomState): void {
  const all = Object.values(m.reservations);
  if (all.length <= MAX_RESERVATIONS) return;
  const gone = all.filter((r) => !isLive(r)).slice(0, all.length - MAX_RESERVATIONS);
  for (const r of gone) delete m.reservations[r.id];
}

/** A room's reservations, oldest first. */
export const reservationsOf = (room: RoomState): MigrationReservation[] => Object.values(room.ext.migrations?.reservations ?? {}).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

/** Whether the room's admin left the migration check on (the default). */
export const migrationCheckOn = (room: RoomState | null | undefined): boolean => room?.ext.settings?.migrationCheck !== false;

/** The room admin's folder override for a repository (by origin key), or null: detection decides. */
export const migrationFoldersOverride = (room: RoomState | null | undefined, key: string): string[] | null => {
  const f = room?.ext.settings?.migrationFolders?.[key];
  return Array.isArray(f) && f.length ? f : null;
};
