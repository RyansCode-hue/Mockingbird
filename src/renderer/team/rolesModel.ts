import { OWNER_CLAIM_WAIT_MS } from "../../shared/team/protocol";
import type { MemberId, RoomRole, TeamRoomSummary } from "../../shared/team/types";

/**
 * Room roles as the window shows them (docs/team-rooms.md → Room roles),
 * from the room's summary: who holds which role, what this install may do
 * to whom, and the ownership claim's state. The room log decides; these only
 * say what the buttons offer (each action is checked again where it's made).
 */

type Room = Pick<TeamRoomSummary, "members" | "owner" | "admins" | "claim" | "claimOpensAt">;

export function roleIn(room: Room, id: MemberId): RoomRole | null {
  if (!room.members.some((m) => m.id === id)) return null;
  if (room.owner === id) return "owner";
  return room.admins?.includes(id) ? "admin" : "member";
}

export const selfOf = (room: Room) => room.members.find((m) => m.self);

/** This install's role in the room. */
export function myRole(room: Room): RoomRole | null {
  const me = selfOf(room);
  return me ? roleIn(room, me.id) : null;
}

/** May this install remove `target` (the room log's rule, mayRemove, as the summary knows it)? */
export function canRemove(room: Room, target: MemberId, now = Date.now()): boolean {
  const mine = myRole(room);
  const theirs = roleIn(room, target);
  if (!mine || !theirs || selfOf(room)?.id === target) return false;
  if (room.claim?.from === target && now < room.claim.at + OWNER_CLAIM_WAIT_MS) return false;
  return mine === "owner" || (mine === "admin" && theirs === "member");
}

/** What the owner can do to a member's role. */
export function roleChanges(room: Room, target: MemberId): { makeAdmin: boolean; removeAdmin: boolean; handOver: boolean } {
  const owner = myRole(room) === "owner" && selfOf(room)?.id !== target;
  const theirs = roleIn(room, target);
  return { makeAdmin: owner && theirs === "member", removeAdmin: owner && theirs === "admin", handOver: owner && !!theirs };
}


const nameIn = (room: Room, id: MemberId | null | undefined, you = "you") => {
  const m = room.members.find((x) => x.id === id);
  return m ? (m.self ? you : m.name) : "nobody";
};

/** One line under a room's members saying who holds which role and what that lets them do. */
export function rolesLine(room: Room): string {
  const owner = nameIn(room, room.owner, "You");
  const admins = (room.admins ?? []).map((id) => nameIn(room, id));
  const role = myRole(room);
  const what =
    role === "owner"
      ? "You own the room: you make admins, hand over ownership, and set where backups go and its House project."
      : role === "admin"
        ? "You're an admin: you accept or decline joins, remove members and set the room's rules."
        : "Admins accept joins, remove members and set the room's rules.";
  const owns = owner === "You" ? "" : `${owner} owns the room. `;
  const adm = admins.length ? `Admins: ${admins.join(", ")}. ` : "";
  return `${owns}${adm}${what}`;
}

/**
 * The ownership claim, as this install sees it:
 *   contest   a claim took ownership from you: you can take it back
 *   claimed   someone claimed it from someone else (for the line saying so)
 *   can-claim you're the claimant and the owner hasn't been heard from long enough
 *   waiting   you're the claimant; the owner was heard from recently (opensAt)
 */
export type ClaimState = { kind: "contest"; by: string } | { kind: "claimed"; by: string; from: string } | { kind: "can-claim"; owner: string } | { kind: "waiting"; owner: string; opensAt: number } | null;

export function claimState(room: Room, now = Date.now()): ClaimState {
  const me = selfOf(room);
  if (!me) return null;
  if (room.claim?.from === me.id && room.members.some((m) => m.id === room.claim!.from)) return { kind: "contest", by: nameIn(room, room.owner) };
  if (room.claim) return { kind: "claimed", by: nameIn(room, room.claim.by, "You"), from: nameIn(room, room.claim.from) };
  if (room.claimOpensAt == null || room.owner === me.id) return null;
  return now >= room.claimOpensAt ? { kind: "can-claim", owner: nameIn(room, room.owner) } : { kind: "waiting", owner: nameIn(room, room.owner), opensAt: room.claimOpensAt };
}
