import * as os from "os";
import * as path from "path";
import { loadIdentity, TEAM_DIR, type Identity } from "./identity";
import { ElectronPeerHost } from "./peerHost";
import { RoomStore } from "./rooms";
import { TeamCore, type LeftInfo, type PeerWire, type RevokeOutcome, type Team } from "./transport";
import { WebRtcWire } from "./webrtc";
import { allowCreatorsCommand, formatFingerprint, SIGNALING_PROTOCOL, type SignalingHealth } from "../../shared/team/protocol";
import { isShareableGroup, type Settings } from "../../shared/types";
import type { LeaveOutcome, RemoveOutcome, RoomId, RoomState, TeamNotice, TeamStatus } from "../../shared/team/types";

/**
 * Team rooms inside the app: this install's identity, its rooms, and the
 * WebRTC transport, with what the window asks for (Settings → Team, the
 * sidebar's shared groups, share and join). Nothing connects until there's
 * a room: no signaling, no hidden window.
 *
 * Later stages reach the transport through `team.transport`.
 *
 * Leaving a room (or being removed from one) ends with nothing of it left on
 * this Mac: each stage that kept something of the room is a RoomCleanup and
 * forgets it (live panes, chat, plan copies, backups and hidden refs), then
 * the room's folder goes. The group stays, as an ordinary local group whose
 * sessions keep running. What couldn't be cleaned up is listed in a notice;
 * a room whose folder couldn't be deleted is cleaned up again on the next start.
 */

/** A stage that keeps something of a room, told when this install isn't in it any more. */
export interface RoomCleanup {
  /** What it keeps, for a notice when it fails ("the plan copies"). */
  what: string;
  /** Forget the room. Resolves with what couldn't be cleaned up (one sentence each), or rejects. */
  roomLeft(room: RoomState, groupKey: string | null): Promise<string[]> | string[];
}

export interface TeamServiceDeps {
  settings: () => Settings;
  /** Top-level group keys this install already uses, so a joined room never merges into a private group. */
  localGroups: () => string[];
  /** The window's copy of the status changed. */
  emit: (status: TeamStatus) => void;
  log: (context: string, err: unknown) => string;
  /** Where peerhost.html and its scripts are (dist/). */
  assetsDir: string;
  dir?: string;
  /** How members connect (default: WebRTC through the hidden peer host; tests: the loopback). */
  wire?: (identity: Identity, log: (msg: string) => void) => PeerWire;
  /** The stages that keep something of a room, in the order they forget it (the room's folder goes last). */
  cleanup?: () => RoomCleanup[];
  /** A desktop notification (this install was removed from a room). */
  notify?: (title: string, body: string) => void;
}

export class TeamService {
  private core: TeamCore | null = null;
  private identity: Identity | null = null;
  private error: string | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private notices: TeamNotice[] = [];
  /** Rooms being forgotten here: one cleanup at a time per room. */
  private forgetting = new Map<RoomId, Promise<string[]>>();
  private leavingNow = new Set<RoomId>();
  private nextNotice = 1;

  constructor(private d: TeamServiceDeps) {}

  /** The transport for other stages; null when the identity couldn't be read. */
  get transport(): Team | null {
    return this.core;
  }

  start(): void {
    if (this.core) return;
    const dir = this.d.dir ?? TEAM_DIR;
    try {
      this.identity = loadIdentity(dir);
    } catch (err) {
      this.error = this.d.log("team identity", err);
      return;
    }
    const log = (m: string) => this.d.log("team", m);
    const wire = this.d.wire ? this.d.wire(this.identity, log) : new WebRtcWire({ identity: this.identity, host: new ElectronPeerHost({ assetsDir: this.d.assetsDir, log }), log, relayOnly: process.env.MOCKINGBIRD_E2E_RELAY_ONLY === "1" });
    this.core = new TeamCore({
      identity: this.identity,
      store: new RoomStore(path.join(dir, "rooms")).load(),
      wire,
      name: () => this.displayName(),
      groupKeyFor: (room) => this.localGroupFor(room),
      log,
    });
    this.core.onRoomsChanged(() => this.changed());
    this.core.onLeft((roomId, info) => void this.ended(roomId, info));
  }

  status(): TeamStatus {
    const s = this.d.settings();
    const base = { signalingUrl: s.signalingUrl ?? "", rooms: [], pending: [], peers: [], problems: [], notices: this.notices };
    if (!this.core || !this.identity) return { ...base, self: null, error: this.error ?? "Team rooms haven't started" };
    return { ...base, self: { id: this.identity.id, name: this.displayName(), fingerprint: formatFingerprint(this.identity.id) }, ...this.core.status() };
  }

  // ---- leaving and removing -------------------------------------------------------------------

  /**
   * Leave a room: teammates connected now hear it (the others from them, or
   * from the Worker, later), the signaling Worker cuts this install's key
   * off, then everything of the room on this Mac is deleted. Throws only
   * before anything changed; what didn't work afterwards is in the answer
   * (and in a notice).
   */
  async leaveRoom(roomId: RoomId): Promise<LeaveOutcome> {
    const core = this.need();
    const room = core.room(roomId);
    if (!room) throw new Error("You're not in that room");
    if (this.leavingNow.has(roomId)) throw new Error(`Already leaving ${room.name}`);
    this.leavingNow.add(roomId);
    try {
      const groupKey = core.localGroupOf(roomId);
      const left = await core.leave(roomId);
      const nameOf = (id: string) => room.members.find((m) => m.id === id)?.name ?? id.slice(0, 8);
      const worker = workerProblem(left.revoke, "you");
      const problems = await this.forgetHere(roomId, left.room, groupKey);
      const outcome: LeaveOutcome = { roomName: room.name, told: left.told.map(nameOf), notTold: left.missed.map(nameOf), worker, problems };
      if (problems.length || worker) this.notice({ roomId, roomName: room.name, kind: "left", problems, ...(worker ? { worker } : {}) });
      this.changed();
      return outcome;
    } finally {
      this.leavingNow.delete(roomId);
    }
  }

  /**
   * Remove a teammate (the room's admin only): every member's Mockingbird
   * drops them, theirs deletes the room, and the signaling Worker cuts their
   * key off. Removing someone already removed asks the Worker again.
   */
  async removeMember(roomId: RoomId, memberId: string): Promise<RemoveOutcome> {
    const core = this.need();
    const room = core.room(roomId);
    if (!room) throw new Error("You're not in that room");
    const name = (room.members.find((m) => m.id === memberId) ?? room.former?.find((m) => m.id === memberId))?.name ?? memberId.slice(0, 8);
    const r = await core.removeMember(roomId, memberId);
    this.changed();
    return { name, delivered: r.delivered, worker: workerProblem(r.revoke, name) };
  }

  dismissNotice(id: string): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.changed();
  }

  /**
   * Rooms this install isn't in any more but still holds (a cleanup cut short
   * by quitting, or a folder that couldn't be deleted): cleaned up now. Run
   * once the stages that keep room data have started.
   */
  async finishLeftRooms(): Promise<void> {
    const core = this.core;
    if (!core) return;
    for (const { roomId, info } of core.leftRooms()) await this.ended(roomId, info, true);
  }

  /** This install's membership ended without it leaving here: removed by the admin, or a leave that didn't finish. */
  private async ended(roomId: RoomId, info: LeftInfo, resumed = false): Promise<void> {
    if (this.leavingNow.has(roomId)) return;
    const problems = await this.forgetHere(roomId, info.room, this.core?.localGroupOf(roomId) ?? null);
    if (info.by) {
      const by = info.byName ?? "A teammate";
      this.notice({ roomId, roomName: info.room.name, kind: "removed", by, problems });
      try {
        this.d.notify?.(`${by} removed you from ${info.room.name}`, problems.length ? `It's deleted from this Mac, except: ${problems.join(" · ")}` : "The room is deleted from this Mac; its group and sessions stay, as local ones.");
      } catch (err) {
        this.d.log("team: telling about the removal", err);
      }
    } else if (problems.length || !resumed) {
      this.notice({ roomId, roomName: info.room.name, kind: "left", problems });
    }
  }

  /** Every stage forgets the room, then its folder goes. Resolves with what couldn't be cleaned up; never rejects. */
  private forgetHere(roomId: RoomId, room: RoomState, groupKey: string | null): Promise<string[]> {
    const running = this.forgetting.get(roomId);
    if (running) return running;
    const run = (async () => {
      const problems: string[] = [];
      for (const part of this.d.cleanup?.() ?? []) {
        try {
          problems.push(...(await part.roomLeft(room, groupKey)));
        } catch (err) {
          problems.push(`${part.what[0].toUpperCase()}${part.what.slice(1)} couldn't be cleaned up: ${this.d.log(`team: forgetting ${part.what} of room ${roomId}`, err)}`);
        }
      }
      try {
        this.core?.forget(roomId);
      } catch (err) {
        problems.push(`The room's folder couldn't be deleted (it's tried again when Mockingbird next starts): ${this.d.log(`team: deleting room ${roomId}`, err)}`);
      }
      return problems;
    })().finally(() => this.forgetting.delete(roomId));
    this.forgetting.set(roomId, run);
    return run;
  }

  private notice(n: Omit<TeamNotice, "id" | "at">): void {
    this.notices = [...this.notices.filter((x) => x.roomId !== n.roomId), { ...n, id: `n${this.nextNotice++}`, at: Date.now() }].slice(-20);
    this.changed();
  }

  /**
   * Share a top-level group as a room (or, when it already is one, a fresh
   * invite to it). Waits for the signaling Worker's answer, so a Worker that
   * refuses the room (this key isn't on ALLOWED_CREATORS) says so here, with
   * the fix, instead of handing out a code that can't work.
   */
  async shareGroup(groupKey: string, title: string, waitMs = 10_000): Promise<{ roomId: string; invite: string; warning?: string }> {
    const core = this.need();
    if (!isShareableGroup(groupKey)) throw new Error("Only a named group can be shared — name it first");
    const existing = core.roomForGroup(groupKey);
    const room = existing ?? core.createRoom({ name: title || groupKey, groupKey, signalingUrl: (this.d.settings().signalingUrl ?? "").trim() });
    if (existing && core.signalingState(room.id)?.problem) core.wake(room.id); // shared again after fixing the Worker: ask it now
    this.changed();
    const st = await core.signalingSettled(room.id, waitMs);
    if (st?.code === "creation-refused") {
      // a room the Worker won't host isn't kept: sharing again (once allowed) makes a fresh one
      if (!existing) core.discardUnsharedRoom(room.id);
      this.changed();
      throw new Error(`${st.problem}.\n\nOn the Worker, once: ${allowCreatorsCommand([this.identity!.id])}\n(list every creator's fingerprint, comma-separated: the secret is replaced each time). Then share again.`);
    }
    if (st?.problem) throw new Error(st.problem);
    const invite = core.createInvite(room.id);
    return st?.signaling === "online"
      ? { roomId: room.id, invite }
      : { roomId: room.id, invite, warning: "The signaling server hasn't answered yet: the code works once this Mockingbird reaches it." };
  }

  createInvite(roomId: string): string {
    return this.need().createInvite(roomId);
  }

  join(code: string): { roomId: string; name: string } {
    const r = this.need().join(code);
    this.changed();
    return r;
  }

  cancelJoin(roomId: string): void {
    this.need().cancelJoin(roomId);
  }

  /** A group was renamed here: a room shown as it follows. */
  groupRenamed(oldKey: string, newKey: string): void {
    const core = this.core;
    const room = core?.roomForGroup(oldKey);
    if (core && room) core.bindGroup(room.id, newKey);
  }

  settingsChanged(before: Settings, after: Settings): void {
    if ((before.teamName ?? "") !== (after.teamName ?? "")) {
      try {
        this.core?.nameChanged();
      } catch (err) {
        this.d.log("team: telling rooms the new name", err);
      }
    }
    this.changed();
  }

  /** After sleep: reconnect everything now. */
  wake(): void {
    this.core?.wake();
  }

  stop(): void {
    this.core?.close();
    this.core = null;
  }

  /** Is the signaling Worker at `url` there, and on this app's protocol? */
  static async checkSignaling(url: string): Promise<{ protocol: number; relay: boolean; creators: number | "any"; revoke: boolean; problem: string | null }> {
    if (!/^https?:\/\/[^\s]+$/.test(url.trim())) throw new Error("The signaling URL starts with https:// (the address `npx wrangler deploy` printed)");
    const res = await fetch(`${url.trim().replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`The signaling server answered ${res.status}`);
    const body = (await res.json()) as Partial<SignalingHealth>;
    if (body.service !== "mockingbird-signaling") throw new Error("That address isn't Mockingbird's signaling Worker");
    const protocol = Number(body.protocol);
    const creators = body.creators === "any" ? "any" : Number(body.creators ?? 0);
    const problem =
      protocol < SIGNALING_PROTOCOL
        ? "The Worker is older than this Mockingbird — redeploy it (cd signaling && npx wrangler deploy)"
        : protocol > SIGNALING_PROTOCOL
          ? "The Worker is newer than this Mockingbird — update Mockingbird"
          : creators === 0
            ? "The Worker doesn't allow new rooms yet — add your fingerprint to its ALLOWED_CREATORS secret (the command is below)"
            : body.creatorsInvalid
              ? `${body.creatorsInvalid} of the Worker's ALLOWED_CREATORS entries aren't fingerprints — set the secret again`
              : null;
    return { protocol, relay: !!body.relay, creators, revoke: Array.isArray(body.features) && body.features.includes("revoke"), problem };
  }

  private need(): TeamCore {
    if (!this.core) throw new Error(this.error ?? "Team rooms haven't started");
    return this.core;
  }

  private displayName(): string {
    const name = (this.d.settings().teamName ?? "").trim();
    if (name) return name.slice(0, 100);
    try {
      return os.userInfo().username;
    } catch (err) {
      this.d.log("team: reading the user name", err);
      return "teammate";
    }
  }

  /** The local group a joined room is shown as: its own name, unless a private group here already has it. */
  private localGroupFor(room: RoomState): string {
    const taken = new Set([...this.d.localGroups(), ...(this.core?.boundGroups() ?? [])]);
    if (!taken.has(room.groupKey)) return room.groupKey;
    for (let i = 1; ; i++) {
      const key = i === 1 ? `${room.groupKey} (team)` : `${room.groupKey} (team ${i})`;
      if (!taken.has(key)) return key;
    }
  }

  private changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      try {
        this.d.emit(this.status());
      } catch (err) {
        this.d.log("team: sending the status to the window", err);
      }
    }, 100);
  }
}

/**
 * Why the signaling Worker didn't cut `who` off ("you": this install, leaving),
 * in a sentence for the window; null when it did.
 */
export function workerProblem(r: RevokeOutcome, who: string): string | null {
  if (r.ok) return null;
  const them = who === "you" ? "this Mockingbird" : who;
  switch (r.reason) {
    case "unsupported":
      return `Your signaling Worker is older and doesn't know how to cut members off. Update your signaling Worker (cd signaling && npx wrangler deploy) to also cut ${who === "you" ? "this Mockingbird" : "them"} off at the Worker.`;
    case "refused":
      return `The signaling Worker didn't cut ${them} off: ${r.message.replace(/^the signaling Worker refused: /, "")}.`;
    case "offline":
      return `The signaling Worker couldn't be reached to cut ${them} off (${r.message}); the room's admin asks it again whenever they connect.`;
    case "failed":
      return `The signaling Worker didn't confirm it cut ${them} off (${r.message}); the room's admin asks it again whenever they connect.`;
  }
}
