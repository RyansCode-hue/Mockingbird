import type { SessionInfo } from "../../shared/types";
import type { RoomSessionTag } from "../../shared/team/livePanes";
import type { TeamRoomSummary } from "../../shared/team/types";

/**
 * Team rooms' sessions as words: the second line of a room session's row, a
 * room header's presence, and the Sessions view's "Connected sessions" line.
 * Plain logic, kept apart from the components so it's tested without a DOM.
 */

/** "Nick Smith" → "Nick". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Nick" → "Nick's", "James" → "James's". */
const possessive = (name: string) => `${name}'s`;

/** "Nick", "Nick and Sam", "Nick, Sam and Lee". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A room session's second line: whose it is, whether it runs, and who's
 * looking at it — "Nick's session · live · Nick is in it". The owner's
 * initials and the lookers' initials said the same in two badges; when the
 * owner is the one looking, it says so once.
 */
export function roomRowLine(room: RoomSessionTag): string {
  const owner = firstName(room.ownerName);
  const parts = [room.remote ? `${possessive(owner)} session` : "Your session"];
  if (room.remote) parts.push(!room.online ? "offline" : !room.live ? "closed there" : "live");
  else if (room.takenOver) parts.push(room.takenOver.back ? "taken back into another session" : `continued by ${firstName(room.takenOver.byName)}`);
  const inIt = room.lookers.filter((l) => l.focused).map((l) => firstName(l.name));
  const watching = room.lookers.filter((l) => !l.focused).map((l) => firstName(l.name));
  if (inIt.length) parts.push(`${listNames(inIt)} ${inIt.length === 1 ? "is" : "are"} in it`);
  if (watching.length) parts.push(`${listNames(watching)} ${watching.length === 1 ? "has" : "have"} it open`);
  return parts.join(" · ");
}

/** A room's presence in words: "Shared room · Nick online", or why it isn't reaching anyone. */
export function roomPresence(room: TeamRoomSummary): string {
  const others = room.members.filter((m) => !m.self);
  const online = others.filter((m) => room.online.includes(m.id)).map((m) => firstName(m.name));
  const who = !others.length ? "just you so far" : online.length ? `${listNames(online)} online` : "no one else online";
  return `Shared room · ${room.signaling === "online" ? who : room.signaling === "connecting" ? "connecting…" : "can't reach the server"}`;
}

/** The Sessions view's line for the rooms — how many of teammates' sessions run, who's online — and where clicking it goes. */
export interface ConnectedSummary {
  /** Teammates' room sessions running now, across rooms. */
  live: number;
  /** Teammates connected to any room, by first name. */
  online: string[];
  rooms: number;
  /** "Connected sessions · 4". */
  title: string;
  /** "Nick online · 2 rooms". */
  sub: string;
  /** The room clicking it opens: the only one, else none (the room list). */
  roomId: string | null;
}

export function connectedSummary(rooms: readonly TeamRoomSummary[], sessions: readonly Pick<SessionInfo, "room">[]): ConnectedSummary {
  const ids = new Set(rooms.map((r) => r.id));
  const live = sessions.filter((s) => s.room?.remote && s.room.live && ids.has(s.room.roomId)).length;
  const online = new Map<string, string>();
  for (const r of rooms) for (const m of r.members) if (!m.self && r.online.includes(m.id)) online.set(m.id, firstName(m.name));
  const names = [...online.values()];
  const who = names.length > 2 ? `${names.length} teammates online` : names.length ? `${listNames(names)} online` : "no one online";
  return {
    live,
    online: names,
    rooms: rooms.length,
    title: `Connected sessions · ${live}`,
    sub: `${who} · ${rooms.length === 1 ? "1 room" : `${rooms.length} rooms`}`,
    roomId: rooms.length === 1 ? rooms[0].id : null,
  };
}
