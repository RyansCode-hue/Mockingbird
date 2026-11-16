import { LOOSE_GROUP } from "../../shared/landscape";
import { isPermissionMode, type PermissionMode } from "../../shared/permissionModes";
import { splitGroupKey, topOfKey, type SessionInfo } from "../../shared/types";
import type { AssistantGroup, AssistantRoom, AssistantSession } from "./deps";

/**
 * The app as the Assistant's deps give it (deps.ts), from what main holds: this Mac's sessions, teammates' room
 * sessions (live panes), the team rooms and the landscape's areas and stacks. Field by field, so nothing of a session's
 * output or folder goes along.
 */

/** A team room as these read it. */
export interface WorldRoom {
  id: string;
  name: string;
  groupKey: string;
  members: { name: string; self: boolean }[];
  online: string[];
}

// a record written before permission modes, or by a newer Mockingbird, reads as the default
const modeOf = (s: SessionInfo): PermissionMode => (isPermissionMode(s.permissionMode) ? s.permissionMode : "default");

const groupOf = (s: SessionInfo): string | null => (s.taskGroup && topOfKey(s.taskGroup) !== LOOSE_GROUP ? s.taskGroup : null);

/** This Mac's sessions on the landscape (debriefs live elsewhere), then teammates' room sessions. */
export function worldSessions(o: { own: SessionInfo[]; remote: SessionInfo[]; rooms: WorldRoom[] }): AssistantSession[] {
  const roomOfGroup = (key: string | null) => (key ? (o.rooms.find((r) => r.groupKey === topOfKey(key))?.name ?? null) : null);
  const one = (s: SessionInfo, mine: boolean): AssistantSession => ({
    id: s.id,
    title: s.ticketTitle ?? s.title,
    agent: s.shell ? "terminal" : (s.agent ?? "claude"),
    status: s.status,
    waitingReason: s.status === "waiting" ? s.waitingReason : null,
    waitingSince: s.status === "waiting" ? s.waitingSince : null,
    group: groupOf(s),
    room: mine ? roomOfGroup(s.taskGroup) : (o.rooms.find((r) => r.id === s.room?.roomId)?.name ?? roomOfGroup(s.taskGroup)),
    repo: s.room?.repoName ?? (s.repoPath ? (s.repoPath.split("/").filter(Boolean).pop() ?? null) : null),
    branch: s.branch,
    model: s.model ?? null,
    permissionMode: modeOf(s),
    mine,
    ...(mine ? {} : { owner: s.room?.ownerName ?? "a teammate" }),
    helpdesk: s.role === "tasks",
  });
  return [...o.own.filter((s) => !s.debrief && !s.planned).map((s) => one(s, true)), ...o.remote.map((s) => one(s, false))];
}

/** Every top-level group: its sessions', its area's, its stacks' and its room's. */
export function worldGroups(o: { own: SessionInfo[]; remote: SessionInfo[]; areas: string[]; stacks: string[]; rooms: WorldRoom[] }): AssistantGroup[] {
  const keys = new Set<string>();
  const subs = new Map<string, Set<string>>();
  const note = (key: string | null | undefined) => {
    if (!key) return;
    const { top, sub } = splitGroupKey(key);
    if (top === LOOSE_GROUP) return;
    keys.add(top);
    if (sub) subs.set(top, (subs.get(top) ?? new Set()).add(`${top}/${sub}`));
  };
  const own = o.own.filter((s) => !s.debrief && !s.planned);
  for (const s of [...own, ...o.remote]) note(s.taskGroup);
  for (const k of [...o.areas, ...o.stacks, ...o.rooms.map((r) => r.groupKey)]) note(k);
  return [...keys].sort().map((key) => ({
    key,
    stacks: [...(subs.get(key) ?? [])].sort(),
    sessions: own.filter((s) => s.status !== "dead" && s.taskGroup && topOfKey(s.taskGroup) === key).length,
    room: o.rooms.find((r) => r.groupKey === key)?.name ?? null,
    area: o.areas.includes(key),
  }));
}

export function worldRooms(rooms: WorldRoom[]): AssistantRoom[] {
  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    group: r.groupKey,
    members: [...r.members].sort((a, b) => Number(b.self) - Number(a.self)).map((m) => m.name),
    online: r.online.length,
  }));
}
