import * as path from "path";
import type { AssistantWindowAction } from "../src/shared/assistant";
import { resolveLayout } from "../src/shared/landscapeModel";
import type { SessionInfo } from "../src/shared/types";
import { areaKeyOf } from "../src/shared/landscape";
import { LandscapeStore } from "../src/main/landscape";
import type { AssistantDeps } from "../src/main/assistant/deps";
import type { GuardOp } from "../src/main/sessionGuards";
import { worldGroups, worldRooms, worldSessions, type WorldRoom } from "../src/main/assistant/world";
import { tempDir } from "./helpers";

/**
 * Fakes for the Assistant's layout, wires, rooms and settings tools (tools/layout.ts, wires.ts, rooms.ts,
 * settings.ts): a landscape kept by the real LandscapeStore in this file's temp HOME, over sessions the test holds.
 */

/** The deps these tools reach, for a test that never calls them: the guard lets everything by, the rest throw. */
export function unusedToolDeps(): Omit<AssistantDeps, "sessions" | "groups" | "rooms" | "toWindow" | "rename" | "relaunchRefusal" | "relaunch"> {
  const no = (name: string) => () => {
    throw new Error(`${name} isn't faked in this test`);
  };
  return {
    guard: () => null,
    landscapeState: no("landscapeState"),
    layoutSessions: no("layoutSessions"),
    patchLandscape: no("patchLandscape"),
    setGroup: no("setGroup"),
    renameGroup: no("renameGroup"),
    setMuted: no("setMuted"),
    muted: no("muted"),
    wireList: no("wireList"),
    wireAddRefusal: no("wireAddRefusal"),
    addWire: no("addWire"),
    removeWire: no("removeWire"),
    restoreWire: no("restoreWire"),
    wireRestorable: no("wireRestorable"),
    sendWaiting: no("sendWaiting"),
    ticketStage: no("ticketStage"),
    approveTicket: no("approveTicket"),
    houseBoard: no("houseBoard"),
    shareRefusal: no("shareRefusal"),
    shareGroup: no("shareGroup"),
    leaveRoom: no("leaveRoom"),
    takeoverTarget: no("takeoverTarget"),
    takeoverPlan: no("takeoverPlan"),
    takeOver: no("takeOver"),
    roomSandboxed: no("roomSandboxed"),
    setRoomSandbox: no("setRoomSandbox"),
    houseWrite: no("houseWrite"),
    settingsSeen: no("settingsSeen"),
    changeSetting: no("changeSetting"),
  };
}

let made = 0;

/** A session record, as main has it: in group `atticus` unless `over` says otherwise. */
export const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id,
    title: id,
    ticketTitle: null,
    repoPath: "/code/atticus",
    branch: "main",
    taskGroup: "atticus",
    status: "idle",
    agent: "claude",
    cwd: `/w/${id}`,
    kind: "work",
    waitingReason: null,
    waitingSince: null,
    createdAt: ++made,
    extraDirs: [],
    ticketId: null,
    ...over,
  }) as SessionInfo;

/** A teammate's room session (a live pane), owned by Nick, in group `group`. */
export const theirs = (id: string, group: string): SessionInfo =>
  info(`r~nick~${id}`, { taskGroup: group, room: { roomId: "R1", sessionId: id, owner: "nick", ownerName: "Nick", remote: true, online: true, live: true, lookers: [], cols: 80, rows: 24, git: null, repo: null, repoName: "atticus" } as unknown as SessionInfo["room"] });

export interface LandscapeWorld {
  deps: AssistantDeps;
  store: LandscapeStore;
  own: SessionInfo[];
  remote: SessionInfo[];
  /** What the deps were asked to do, in order. */
  did: string[];
  /** Why the session guards refuse an op on a session, by "op id" ("group a1"). */
  refuse: Map<string, string>;
  /** Session `id`'s group now. */
  groupOf(id: string): string | null;
}

/**
 * The landscape over `own` (this Mac's running sessions) and `remote` (teammates'), laid out once as the window would
 * lay it out (resolveLayout), then saved: every workspace has its place. `rooms` are the team rooms.
 */
export function landscapeWorld(own: SessionInfo[], o: { remote?: SessionInfo[]; closed?: SessionInfo[]; rooms?: WorldRoom[]; over?: Partial<AssistantDeps> } = {}): LandscapeWorld {
  const remote = o.remote ?? [];
  const closed = o.closed ?? [];
  const rooms = o.rooms ?? [];
  const did: string[] = [];
  const refuse = new Map<string, string>();
  const problems: string[] = [];
  const store = new LandscapeStore({ file: path.join(tempDir("assistant-landscape"), "landscape.json"), emit: () => {}, emitWires: () => {}, log: (context, err) => void problems.push(`${context}: ${String(err)}`), saveMs: 60_000 });
  store.update({ migratedAt: "2026-11-16T00:00:00.000Z" });
  const shown = () => [...own.filter((s) => !s.debrief), ...remote];
  const first = resolveLayout(store.get().landscape, shown(), undefined, [], null, closed);
  if (first.patch) store.update(first.patch);
  const record = (id: string) => own.find((s) => s.id === id) ?? closed.find((s) => s.id === id);
  const deps: AssistantDeps = {
    sessions: () => worldSessions({ own, remote, rooms }),
    groups: () => {
      const l = store.get().landscape;
      return worldGroups({ own, remote, areas: Object.keys(l.areas), stacks: Object.keys(l.stacks), rooms });
    },
    rooms: () => worldRooms(rooms),
    toWindow: (a: AssistantWindowAction) => void did.push(`window ${JSON.stringify(a)}`),
    rename: (id, title) => {
      did.push(`rename ${id} ${title}`);
      record(id)!.title = title;
    },
    relaunchRefusal: () => null,
    relaunch: async (id) => void did.push(`relaunch ${id}`),
    ...unusedToolDeps(),
    guard: (op: GuardOp, id: string) => {
      if (id.startsWith("r~")) return "That's a teammate's session: only its owner can do that";
      if (!record(id)) return "There's no such session on this Mac";
      return refuse.get(`${op} ${id}`) ?? null;
    },
    landscapeState: () => {
      if (problems.length) throw new Error(`the landscape store logged: ${problems.join("; ")}`);
      const st = store.get();
      return { landscape: st.landscape, rev: st.rev, problem: null };
    },
    layoutSessions: () => ({ shown: shown(), closed, known: [...own, ...remote, ...closed] }),
    patchLandscape: (patch) => {
      did.push(`patch ${Object.keys(patch).join(",")}`);
      return store.update(patch).rev;
    },
    setGroup: (id, group) => {
      const s = record(id);
      if (!s) throw new Error(id.startsWith("r~") ? "That's a teammate's session: only its owner can move it to another group" : `no session ${id}`);
      did.push(`group ${id} ${group}`);
      s.taskGroup = group;
    },
    renameGroup: (from, to) => {
      did.push(`renameGroup ${from} ${to}`);
      // as sessions:renameGroup does: the members read before their groups change, then the area follows them
      const members = own.filter((s) => areaKeyOf(s) === from).map((s) => s.id);
      const ghosts = closed.map((s) => ({ id: s.id, taskGroup: s.taskGroup }));
      const remap = (g: string | null) => (g === from ? to : g && g.startsWith(`${from}/`) ? to + g.slice(from.length) : g);
      for (const s of [...own, ...closed]) s.taskGroup = remap(s.taskGroup);
      store.groupRenamed(from, to, members, ghosts);
    },
    setMuted: (id, muted) => {
      const s = own.find((x) => x.id === id);
      if (!s) throw new Error("Session is no longer running");
      did.push(`mute ${id} ${muted}`);
      s.muted = muted || undefined;
    },
    muted: (id) => {
      const s = own.find((x) => x.id === id);
      return s ? !!s.muted : null;
    },
    ...o.over,
  };
  return { deps, store, own, remote, did, refuse, groupOf: (id) => record(id)?.taskGroup ?? null };
}
