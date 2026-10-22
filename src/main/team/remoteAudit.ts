import * as fs from "fs";
import * as path from "path";
import { oneLine } from "../../shared/team/agentText";
import type { AuditEntry, AuditKind } from "../../shared/team/audit";
import type { MemberId, RoomId, RoomState } from "../../shared/team/types";
import { TEAM_DIR } from "./identity";
import { memberName } from "./roomSessions";
import type { Team, TappedRequest, Unsubscribe } from "./transport";

/**
 * The audit log of remote actions on this Mac (docs/team-rooms.md, "Remote
 * activity"): ~/.mockingbird/team/audit.log, one JSON line per entry,
 * owner-only (0600), only ever appended to; past MAX_BYTES it becomes
 * audit.log.1 (the one before is dropped) and a new one starts.
 *
 * It keeps who did what to which session, when and how much — never what was
 * typed, said or sent. Keystrokes, scrollback reads and file pieces come many
 * at a time, so they're gathered into one entry per teammate and session
 * until they pause for QUIET_MS (or for at most SPAN_MS).
 *
 * Most entries come from the transport's request tap (messages, take-over
 * asks, artifacts, scrollback, backups sent); typing consent and keystrokes
 * from the live panes, which alone know whether a teammate may type.
 */

export const AUDIT_FILE = path.join(TEAM_DIR, "audit.log");
const MAX_BYTES = 1_000_000;
const QUIET_MS = 30_000;
const SPAN_MS = 10 * 60_000;
const TITLE_MAX = 80;

export interface RemoteAuditDeps {
  file?: string;
  maxBytes?: number;
  now?: () => number;
  log: (context: string, err: unknown) => void;
  timing?: { quietMs?: number; spanMs?: number };
}

/** Who and where, as an entry names them. */
export interface AuditWho {
  roomId?: RoomId;
  member?: MemberId;
  session?: string;
  title?: string | null;
}

type Pending = { entry: AuditEntry; timer: ReturnType<typeof setTimeout> | null };

export class RemoteAudit {
  readonly file: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly spanMs: number;
  private size: number | null = null;
  private pending = new Map<string, Pending>();
  private team: Team | null = null;
  private offs: Unsubscribe[] = [];
  private failing = false;

  constructor(private d: RemoteAuditDeps) {
    this.file = d.file ?? AUDIT_FILE;
    this.maxBytes = d.maxBytes ?? MAX_BYTES;
    this.now = d.now ?? Date.now;
    this.quietMs = d.timing?.quietMs ?? QUIET_MS;
    this.spanMs = d.timing?.spanMs ?? SPAN_MS;
  }

  /** Hear the team's requests and take-overs. */
  watch(team: Team): void {
    this.unwatch();
    this.team = team;
    if (team.tapRequests) this.offs.push(team.tapRequests((r) => this.tapped(r)));
    else this.d.log("team: audit log", "this transport can't report requests: messages, take-over asks and files served won't be logged");
    this.offs.push(
      team.onEvent("session.takenOver", (e, room) => {
        if (e.author === team.self.id || e.body.from !== team.self.id) return;
        const title = room.ext.takeover?.sessions[e.body.sessionId]?.session.title ?? null;
        this.record("takeover", { roomId: room.id, member: e.author, session: e.body.sessionId, title });
      })
    );
  }

  unwatch(): void {
    for (const off of this.offs.splice(0)) off();
    this.team = null;
  }

  /** Write everything gathered and stop listening. */
  stop(): void {
    this.unwatch();
    this.flush();
  }

  /** One entry, written now. */
  record(kind: AuditKind, who: AuditWho, more: Partial<AuditEntry> = {}): void {
    this.append({ at: this.now(), kind, ...this.names(who), ...more });
  }

  /**
   * Add to a gathered entry: `n` more of them, `bytes` more in size. Written
   * once they pause, or after SPAN_MS, whichever comes first. Entries with a
   * different `reason` are gathered apart.
   */
  count(kind: AuditKind, who: AuditWho, bytes: number, more: { reason?: string } = {}): void {
    const key = [kind, who.roomId, who.member, who.session, more.reason].join("\n");
    const at = this.now();
    let p = this.pending.get(key);
    if (p && at - (p.entry.since ?? at) >= this.spanMs) {
      this.write(key);
      p = undefined;
    }
    if (!p) {
      p = { entry: { at, kind, ...this.names(who), n: 0, bytes: 0, since: at, ...more }, timer: null };
      this.pending.set(key, p);
    }
    p.entry.at = at;
    p.entry.n! += 1;
    p.entry.bytes! += bytes;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.write(key), this.quietMs);
    p.timer.unref?.();
  }

  /** Write every gathered entry now. */
  flush(): void {
    for (const key of [...this.pending.keys()]) this.write(key);
  }

  /** The last `n` entries, newest first (gathered ones not yet written included). */
  recent(n = 50): AuditEntry[] {
    const lines: string[] = [];
    for (const file of [this.file, `${this.file}.1`]) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      lines.unshift(...text.split("\n").filter(Boolean));
      if (lines.length >= n) break;
    }
    const out: AuditEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        this.d.log("team: audit log", `skipped a line of ${this.file} that isn't JSON`);
      }
    }
    for (const p of this.pending.values()) out.push({ ...p.entry });
    return out.sort((a, b) => b.at - a.at).slice(0, n);
  }

  // ---- what each request says ------------------------------------------------------------

  private tapped(r: TappedRequest): void {
    const p = (r.params ?? {}) as Record<string, any>;
    const who = { roomId: r.roomId, member: r.peer };
    if (r.dir === "out") {
      if (r.method === "takeover.snapshot" && typeof p.sessionId === "string") {
        this.count("backup.sent", { ...who, session: p.sessionId, title: this.ownTitle(r.roomId, p.sessionId) }, base64Bytes(p.bundle));
      }
      return;
    }
    switch (r.method) {
      case "agents.send": {
        const outcome = r.ok ? (r.result as { status?: string } | null)?.status ?? "answered" : `refused: ${r.error}`;
        const toTitle = r.ok ? (r.result as { toTitle?: unknown } | null)?.toTitle : undefined;
        this.record(
          "message",
          { ...who, session: typeof p.to === "string" ? p.to : undefined, title: typeof toTitle === "string" ? toTitle : null },
          { bytes: typeof p.text === "string" ? Buffer.byteLength(p.text) : 0, outcome: oneLine(outcome, 200), ...(typeof p.from?.title === "string" ? { from: oneLine(p.from.title, TITLE_MAX) } : {}) }
        );
        return;
      }
      case "takeover.ask": {
        const outcome = r.ok ? (r.result as { answer?: string } | null)?.answer ?? "answered" : `refused: ${r.error}`;
        this.record("takeover.asked", { ...who, session: typeof p.sessionId === "string" ? p.sessionId : undefined, title: this.ownTitle(r.roomId, p.sessionId) }, { outcome: oneLine(outcome, 200) });
        return;
      }
      case "artifact.chunk": {
        if (!r.ok || typeof p.sha256 !== "string") return;
        this.count("artifact.served", { ...who, session: p.sha256.slice(0, 12), title: this.artifactName(r.roomId, p.sha256) }, base64Bytes((r.result as { data?: unknown } | null)?.data));
        return;
      }
      case "pty.scrollback": {
        if (!r.ok || typeof p.session !== "string") return;
        const data = (r.result as { data?: unknown } | null)?.data;
        this.count("scrollback", { ...who, session: p.session, title: this.liveTitle(r.roomId, p.session) }, typeof data === "string" ? Buffer.byteLength(data) : 0);
        return;
      }
    }
  }

  private room(roomId: RoomId | undefined): RoomState | undefined {
    return roomId ? this.team?.room(roomId) : undefined;
  }

  private ownTitle(roomId: RoomId | undefined, sessionId: unknown): string | null {
    if (typeof sessionId !== "string") return null;
    return this.room(roomId)?.ext.takeover?.sessions[sessionId]?.session.title ?? this.liveTitle(roomId, sessionId);
  }

  private liveTitle(roomId: RoomId | undefined, sessionId: string): string | null {
    const room = this.room(roomId);
    const self = this.team?.self.id;
    const rec = room && self ? room.ext.sessions?.[`${self}:${sessionId}`] : undefined;
    return rec ? rec.ticketTitle ?? rec.title : null;
  }

  private artifactName(roomId: RoomId | undefined, sha: string): string | null {
    const item = this.room(roomId)?.ext.artifacts?.items.find((a) => a.kind === "file" && a.sha256 === sha);
    return item?.name ?? null;
  }

  private names(who: AuditWho): Partial<AuditEntry> {
    const room = this.room(who.roomId);
    return {
      ...(room ? { room: oneLine(room.name, TITLE_MAX) } : who.roomId ? { room: who.roomId } : {}),
      ...(who.member ? { member: room ? memberName(room.members, who.member) : who.member.slice(0, 8), memberId: who.member } : {}),
      ...(who.session ? { session: who.session } : {}),
      ...(who.title ? { title: oneLine(who.title, TITLE_MAX) } : {}),
    };
  }

  // ---- the file -----------------------------------------------------------------------------

  private write(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (p.timer) clearTimeout(p.timer);
    this.append(p.entry);
  }

  private append(entry: AuditEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      if (this.size === null) this.open();
      if (this.size! + line.length > this.maxBytes && this.size! > 0) {
        fs.renameSync(this.file, `${this.file}.1`);
        this.size = 0;
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size! += Buffer.byteLength(line);
      this.failing = false;
    } catch (err) {
      this.size = null;
      // said once per spell, so a full disk doesn't fill main.log too
      if (!this.failing) this.d.log(`team: writing the audit log ${this.file}`, err);
      this.failing = true;
    }
  }

  /** The first write of this run: the folder exists, the file is the owner's alone. */
  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(this.file, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw new Error(`${this.file} is a symbolic link: not writing through it`);
    if (st && (st.mode & 0o077) !== 0) fs.chmodSync(this.file, 0o600);
    this.size = st?.size ?? 0;
  }
}

function base64Bytes(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  const pad = v.endsWith("==") ? 2 : v.endsWith("=") ? 1 : 0;
  return Math.floor((v.length * 3) / 4) - pad;
}
