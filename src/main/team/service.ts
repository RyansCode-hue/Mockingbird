import * as os from "os";
import * as path from "path";
import { loadIdentity, TEAM_DIR, type Identity } from "./identity";
import { ElectronPeerHost } from "./peerHost";
import { RoomStore } from "./rooms";
import { TeamCore, type PeerWire, type Team } from "./transport";
import { WebRtcWire } from "./webrtc";
import { allowCreatorsCommand, formatFingerprint, SIGNALING_PROTOCOL, type SignalingHealth } from "../../shared/team/protocol";
import type { Settings } from "../../shared/types";
import type { RoomState, TeamStatus } from "../../shared/team/types";

/**
 * Team rooms inside the app: this install's identity, its rooms, and the
 * WebRTC transport, with what the window asks for (Settings → Team, the
 * sidebar's shared groups, share and join). Nothing connects until there's
 * a room: no signaling, no hidden window.
 *
 * Later stages reach the transport through `team.transport`.
 */

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
}

export class TeamService {
  private core: TeamCore | null = null;
  private identity: Identity | null = null;
  private error: string | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

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
    const wire = this.d.wire ? this.d.wire(this.identity, log) : new WebRtcWire({ identity: this.identity, host: new ElectronPeerHost({ assetsDir: this.d.assetsDir, log }), log });
    this.core = new TeamCore({
      identity: this.identity,
      store: new RoomStore(path.join(dir, "rooms")).load(),
      wire,
      name: () => this.displayName(),
      groupKeyFor: (room) => this.localGroupFor(room),
      log,
    });
    this.core.onRoomsChanged(() => this.changed());
  }

  status(): TeamStatus {
    const s = this.d.settings();
    const base = { signalingUrl: s.signalingUrl ?? "", rooms: [], pending: [], peers: [], problems: [] };
    if (!this.core || !this.identity) return { ...base, self: null, error: this.error ?? "Team rooms haven't started" };
    return { ...base, self: { id: this.identity.id, name: this.displayName(), fingerprint: formatFingerprint(this.identity.id) }, ...this.core.status() };
  }

  /**
   * Share a top-level group as a room (or, when it already is one, a fresh
   * invite to it). Waits for the signaling Worker's answer, so a Worker that
   * refuses the room (this key isn't on ALLOWED_CREATORS) says so here, with
   * the fix, instead of handing out a code that can't work.
   */
  async shareGroup(groupKey: string, title: string, waitMs = 10_000): Promise<{ roomId: string; invite: string; warning?: string }> {
    const core = this.need();
    if (!groupKey || groupKey === "ungrouped" || groupKey === "assistant") throw new Error("Only a named group can be shared — name it first");
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
  static async checkSignaling(url: string): Promise<{ protocol: number; relay: boolean; creators: number | "any"; problem: string | null }> {
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
    return { protocol, relay: !!body.relay, creators, problem };
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
