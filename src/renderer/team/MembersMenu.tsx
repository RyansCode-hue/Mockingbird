import { useRef, useState } from "react";
import { AnchoredPopover } from "../Popover";
import { initialsOf, RoleNotice, RoomWarnings, useMemberActions, type MemberDialog } from "../Team";
import { RoomBackupWarnings } from "./TakeOver";
import { roleIn } from "./rolesModel";
import { firstName } from "./connectedModel";
import type { Follow } from "./RoomLive";
import { titleOf } from "../appModel";
import { ago, agoShort, plural } from "../../shared/format";
import { isErr, type SessionInfo } from "../../shared/types";
import type { MemberView } from "../../shared/team/livePanes";
import type { PeerStatus, TeamRoomSummary } from "../../shared/team/types";
import type { TakeoverView } from "../../shared/team/takeover";

/**
 * A room's backups in one line, for its Members menu: where they go and when this Mac's newest was taken; null when
 * the take-over view hasn't been read (its failure is said by RoomBackupWarnings).
 */
export function backupLine(room: TeamRoomSummary, view: TakeoverView | { error: string } | null, now = Date.now()): string | null {
  if (!view || isErr(view)) return null;
  const setting = view.rooms.find((r) => r.roomId === room.id);
  const mine = view.sessions.filter((s) => s.roomId === room.id && s.self);
  const where = setting?.toOrigin && setting.consent ? `to teammates and ${setting.remote}` : "to teammates";
  if (!mine.length) return `Backups go ${where} · none of yours yet`;
  const newest = Math.max(...mine.map((s) => s.latest.takenAt));
  return `Backups go ${where} · last ${ago(newest, now)}`;
}

/** What a teammate is doing in the room, in words: "online · watching Builder", "offline 2h". */
export function presenceLine(room: TeamRoomSummary, m: { id: string; self: boolean }, views: readonly MemberView[], peers: readonly PeerStatus[], sessions: readonly SessionInfo[], now = Date.now()): string {
  if (m.self) return "";
  if (!room.online.includes(m.id)) {
    const p = peers.find((x) => x.id === m.id);
    return p && p.state === "offline" ? `offline ${agoShort(p.since, now)}` : "offline";
  }
  const v = views.find((x) => x.member === m.id);
  const s = v?.focused ? sessions.find((x) => x.id === v.focused) : undefined;
  return s ? `online · watching ${titleOf(s)}` : "online";
}

/**
 * A room area's Members ▾ (design P): the room's members with their presence and roles, and what this install may
 * do to each, from the Team view's own hooks and dialogs (useMemberActions: make or remove admin, hand over
 * ownership, remove; RoleNotice: claiming ownership; LeaveRoomDialog), never copies of them; then join requests,
 * backups and their failures, Invite, Follow a member and Leave room.
 */
export function MembersMenu({
  room,
  views,
  peers,
  sessions,
  follow,
  takeover,
  onInvite,
  onReviewJoins,
  onSettings,
  onDialog,
}: {
  room: TeamRoomSummary;
  /** Connected teammates' views (team:live): what each is looking at. */
  views: readonly MemberView[];
  peers: readonly PeerStatus[];
  sessions: readonly SessionInfo[];
  follow: Follow;
  takeover: TakeoverView | { error: string } | null;
  onInvite: () => void;
  /** Show the join requests this install answers for the room (the admin's prompt). */
  onReviewJoins: () => void;
  /** Settings → Team, where the room's backups are set. */
  onSettings: () => void;
  /**
   * Show one of the room's dialogs (remove, hand over, leave, claim): the app's (MemberDialogs), never this menu's. In
   * the header it would be inside the landscape's scaled world, and gone with the header as the zoom or a collapse
   * takes it away.
   */
  onDialog: (d: MemberDialog) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const acts = useMemberActions(room, onDialog);
  const close = () => setOpen(false);
  /** Closed first, so a dialog the action opens isn't closed with the menu. */
  const run = (f: () => void) => () => {
    close();
    f();
  };
  const others = room.members.filter((m) => !m.self);
  const asked = (room.requests ?? []).filter((r) => r.role === "admin" && r.state === "waiting");
  const passed = (room.requests ?? []).filter((r) => r.role === "inviter" && (r.state === "waiting" || r.state === "forwarding"));
  const followable = follow.candidates.filter((v) => others.some((m) => m.id === v.member));
  const backups = backupLine(room, takeover);
  // the first teammate this install can do something to shows those actions, as P does; a press picks another
  const actionable = others.find((m) => acts.actionsFor(m).length)?.id ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const shownFor = picked ?? actionable;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`ls-ah-btn ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip="The room's members: who's online, roles, join requests, backups"
        onClick={() => setOpen((o) => !o)}
      >
        Members <span className="caret">▾</span>
        {asked.length > 0 && <span className="ls-ah-n" title={`${plural(asked.length, "join request")} waiting for you`}>{asked.length}</span>}
      </button>
      {open && btn.current && (
        <AnchoredPopover anchor={btn.current} className="ls-members" label={`${room.name}: members`} onClose={close}>
          <div className="lsm-head">
            {room.name} room · {plural(room.members.length, "member")}
          </div>
          {room.members.map((m) => {
            const role = roleIn(room, m.id);
            const list = m.self ? [] : acts.actionsFor(m);
            const presence = presenceLine(room, m, views, peers, sessions);
            const online = m.self || room.online.includes(m.id);
            return (
              <div
                key={m.id}
                className={`lsm-member ${shownFor === m.id ? "on" : ""}`}
                data-member={m.id}
                onClick={() => list.length && setPicked(m.id)}
              >
                <div className="lsm-line">
                  <span className={`lsm-av ${m.self ? "self" : online ? "online" : ""}`}>{initialsOf(m.name).slice(0, 1)}</span>
                  <span className="lsm-name">
                    {m.self ? firstName(m.name) : m.name}
                    {m.self ? <span className="dim"> (you)</span> : <span className={`lsm-presence ${online ? "online" : ""}`}> {presence}</span>}
                  </span>
                  <span className={`lsm-role ${role ?? "member"}`}>{role ?? "member"}</span>
                </div>
                {shownFor === m.id && list.length > 0 && (
                  <div className="lsm-acts">
                    {list.map((a) =>
                      a === "-" ? null : (
                        <button key={a.key} type="button" className={`link ${a.danger ? "danger" : ""}`} title={a.title} onClick={run(() => a.onPick())}>
                          {a.menuLabel ?? a.label}
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <RoleNotice room={room} onClaim={run(() => onDialog({ kind: "claim", room }))} />
          {acts.error && <div className="err lsm-err">{acts.error}</div>}
          <div className="lsm-sep" />
          {asked.length > 0 && (
            <div className="lsm-row warn">
              <span>{plural(asked.length, "join request")}</span>
              <button type="button" className="link" onClick={run(onReviewJoins)}>
                Review
              </button>
            </div>
          )}
          {passed.map((r) => (
            <div key={`${r.id}:${r.at}`} className="lsm-row dim">
              <span>
                {r.name}'s request is with {r.adminName}
              </span>
            </div>
          ))}
          {backups && (
            <div className="lsm-row">
              <span>{backups}</span>
              <button type="button" className="link dim" onClick={run(onSettings)}>
                Settings
              </button>
            </div>
          )}
          <RoomBackupWarnings room={room} view={takeover} />
          <RoomWarnings room={room} />
          <div className="lsm-buttons">
            <button type="button" className="outline" onClick={run(onInvite)}>
              Invite…
            </button>
            {follow.leader && others.some((m) => m.id === follow.leader!.id) ? (
              <button type="button" className="outline" onClick={run(follow.stop)}>
                Stop following {firstName(follow.leader.name)}
              </button>
            ) : (
              followable.map((v) => (
                <button key={v.member} type="button" className="outline" title={`Fly to what ${v.name} is in, and keep following it`} onClick={run(() => follow.follow(v.member))}>
                  Follow {firstName(v.name)}
                </button>
              ))
            )}
            <button type="button" className="link danger lsm-leave" onClick={run(() => onDialog({ kind: "leave", room }))}>
              Leave room…
            </button>
          </div>
        </AnchoredPopover>
      )}
    </>
  );
}
