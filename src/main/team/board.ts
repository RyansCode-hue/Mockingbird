import { defineEventType, roomOwner } from "./rooms";
import { emptyHouse, HOUSE_PROJECT_RE, isTicketNumber, MAX_TRACKED, NUDGE_CHANGES, VIA_MAX, type HouseRoomState } from "../../shared/team/house";
import type { RoomState } from "../../shared/team/types";

/**
 * The House board's room events (docs/team-rooms.md, "Radley House board"):
 * their checks (an event that fails one is refused, from anyone) and their
 * reducers into `room.ext.house`. Importing this module registers them, so it
 * must load before any room log does (index.ts imports it, through the House
 * service, ahead of starting the team service).
 *
 * The work-package board's `plan.*` events in older rooms' logs aren't
 * defined any more: they load like any unknown type, kept and passed on
 * without changing the state.
 */

const isObj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b);
const ticket = (b: unknown) => {
  if (!isObj(b)) throw new Error("no body");
  if (!isTicketNumber(b.n)) throw new Error("n must be a House ticket number");
};

const houseOf = (state: RoomState): HouseRoomState => (state.ext.house ??= emptyHouse());

defineEventType("house.project", {
  validate(b) {
    if (!isObj(b)) throw new Error("no body");
    if (b.project !== null && (typeof b.project !== "string" || !HOUSE_PROJECT_RE.test(b.project))) throw new Error("project must be a House project name or null");
  },
  reduce(state, e) {
    // the room's owner at this point in its order decides (an owner-only setting), the same on every member
    if (roomOwner(state) !== e.author) return;
    const h = houseOf(state);
    h.project = e.body.project;
    h.projectBy = e.author;
  },
});

defineEventType("house.track", {
  validate: ticket,
  reduce(state, e) {
    const h = houseOf(state);
    if (h.tracked.some((t) => t.n === e.body.n) || h.tracked.length >= MAX_TRACKED) return;
    h.tracked.push({ n: e.body.n, by: e.author, at: e.at });
  },
});

defineEventType("house.untrack", {
  validate: ticket,
  reduce(state, e) {
    const h = houseOf(state);
    h.tracked = h.tracked.filter((t) => t.n !== e.body.n);
  },
});

defineEventType("house.nudge", {
  validate(b) {
    ticket(b);
    const x = b as Record<string, unknown>;
    if (x.change !== undefined && !NUDGE_CHANGES.includes(x.change as never)) throw new Error("bad change");
    if (x.via !== undefined && (typeof x.via !== "string" || x.via.length > VIA_MAX)) throw new Error(`via must be text of up to ${VIA_MAX} characters`);
  },
  reduce() {
    // a signal to read the ticket again; the House holds what changed
  },
});

/** The room's part of the board (empty before its first event). */
export function houseOfRoom(room: RoomState): HouseRoomState {
  return room.ext.house ?? emptyHouse();
}
