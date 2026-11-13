import React, { useEffect, useRef, useState } from "react";
import { presenceTurn, useChange } from "./motion";
import { Modal } from "./Modal";
import { SetRow } from "./SetRow";
import { Toggle } from "./Toggle";
import { CopyToast, useCopyNote } from "./copyNote";
import { RoomBackupsSetting } from "./team/RoomBackups";
import { RoomMigrationsSetting } from "./team/Migrations";
import { RemoteActivity } from "./team/RemoteActivity";
import { isErr, type Settings } from "../shared/types";
import { allowCreatorsCommand } from "../shared/team/protocol";
import { settled } from "./settled";
import type { LeaveOutcome, PeerStatus, RemoveOutcome, TeamNotice, TeamRoomSummary, TeamStatus } from "../shared/team/types";
import { OLD_WORKER_APPROVE, pendingJoinText, RoomJoinRequests } from "./team/JoinRequests";
import type { ConnectedSummary } from "./team/connectedModel";
import { ChatIcon as TeamIcon } from "./Icons";
import { plural } from "../shared/format";
import { tidyMenu, type MenuEntry } from "./ContextMenu";
import { canRemove, claimState, myRole, roleChanges, roleIn, rolesLine } from "./team/rolesModel";

/**
 * Team rooms in the window (stage 1): Settings → Team, sharing a group as a
 * room, joining one by code, and the sidebar's shared badge. See
 * docs/team-rooms.md.
 */

/** The team status from main, kept current; an { error } when it couldn't be read. */
export function useTeamStatus(): TeamStatus | { error: string } | null {
  const [status, setStatus] = useState<TeamStatus | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    window.mb.teamStatus().then((s: TeamStatus | { error: string }) => {
      if (!alive) return;
      if (isErr(s)) console.error("[mockingbird] couldn't read the team status:", s.error);
      setStatus(s);
    });
    const off = window.mb.onTeamChanged((s: TeamStatus) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

/** "Nick Smith" → "NS", "nick" → "N". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0][0] : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const LINK_LABEL: Record<PeerStatus["state"], string> = {
  direct: "connected · direct",
  turn: "connected · via TURN relay",
  connecting: "connecting…",
  offline: "offline",
  "needs-update": "needs an update",
  error: "refused",
};

/** The room a sidebar group is shown as, if it's shared. */
export function roomOfGroup(status: TeamStatus | { error: string } | null, groupKey: string): TeamRoomSummary | undefined {
  return status && !isErr(status) ? status.rooms.find((r) => r.groupKey === groupKey) : undefined;
}

/**
 * The area tree's one line for the team rooms, under it: how many of teammates' sessions run and who's online. It
 * goes to the only room's area and opens its chat, or with several lists the rooms.
 */
export function ConnectedLine({ summary, onOpen, problem = null }: { summary: ConnectedSummary; onOpen: () => void; problem?: string | null }) {
  // a teammate connecting or leaving turns the presence dot (the line's ::before)
  const sub = useRef<HTMLSpanElement>(null);
  useChange(summary.online.length, (was, now) => sub.current && presenceTurn(sub.current, null, now > was, "::before"));
  return (
    <button
      type="button"
      className="connected-line"
      title={`${plural(summary.live, "teammate's session")} running in ${plural(summary.rooms, "team room")}${summary.online.length ? ` · online: ${summary.online.join(", ")}` : ""}${problem ? ` · teammates' sessions on screen here may not stream: ${problem}` : ""} — ${summary.roomId ? "go to its area and open its chat" : "list the rooms"}`}
      onClick={onOpen}
    >
      <TeamIcon />
      <span className="cl-text">
        <span className="cl-title">{summary.title}</span>
        <span ref={sub} className={`cl-sub ${summary.online.length ? "on" : ""}`}>
          {summary.sub}
        </span>
        {problem && <span className="cl-problem">Couldn't say what's on screen here: {problem}</span>}
      </span>
      <span className="cl-go" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/**
 * The one step that lets this Mockingbird create rooms: the signaling Worker
 * refuses new rooms from keys not on its ALLOWED_CREATORS secret (anyone who
 * learned its URL could otherwise use its TURN relay).
 */
export function AllowCreatorStep({ id }: { id: string }) {
  const [note, copy] = useCopyNote();
  const command = allowCreatorsCommand([id]);
  return (
    <div className="team-allow">
      <div className="set-row-title">Let this Mockingbird create rooms</div>
      <div className="set-row-note">
        The Worker only lets listed fingerprints create rooms (joining with a code needs nothing). Run once in this repo; for several creators, list their
        fingerprints comma-separated in one command — the secret is replaced each time.
      </div>
      <div className="team-cmd">
        <code>{command}</code>
        <button className="outline" onClick={() => copy(command, "the command")}>
          Copy
        </button>
        <CopyToast note={note} failed="Couldn't copy" />
      </div>
    </div>
  );
}

/** Why sharing a group as a room failed; a Worker that refuses new rooms from this key gets the one command that fixes it. */
export function ShareError({ error }: { error: string }) {
  const status = useTeamStatus();
  const self = status && !isErr(status) ? status.self : null;
  if (!/ALLOWED_CREATORS/.test(error)) return <div className="err">{error}</div>;
  return (
    <>
      <div className="err">The signaling Worker refused to create this room: it only lets fingerprints on its ALLOWED_CREATORS list create rooms.</div>
      {self && <AllowCreatorStep id={self.id} />}
    </>
  );
}

/** A room's one-time invite code to send a teammate: the code, Copy, how it's used, and any warning about it. */
export function InviteCode({ invite, warning }: { invite: string; warning?: string }) {
  const [note, copy] = useCopyNote();
  return (
    <>
      <label>Invite code</label>
      <div className="team-invite">
        <textarea className="team-code" readOnly value={invite} onFocus={(e) => e.currentTarget.select()} />
        <button className="primary" onClick={() => copy(invite, "the invite code")}>
          Copy
        </button>
        <CopyToast note={note} failed="Couldn't copy" />
      </div>
      {warning && <div className="err">{warning}</div>}
      <div className="hint">Works once, for 7 days. Your teammate pastes it into Join a room… (in the Team tab, New/Import Session → Connected, or ⌘K). Your Mockingbird must be open for them to join.</div>
    </>
  );
}

/** Who lets a code's holder in: the room's owner or an admin (this install, or the teammates it's sent to for approval). */
function AdminAccepts({ room, self }: { room: TeamRoomSummary; self?: string }) {
  const role = myRole(room);
  const deciders = [room.owner, ...(room.admins ?? [])].map((id) => room.members.find((m) => m.id === id && !m.self)?.name).filter(Boolean);
  return (
    <>
      <div className="hint">
        {role === "owner" || role === "admin"
          ? `You're the room's ${role}: when they use it, Mockingbird asks you to accept them${deciders.length ? ` (or ${deciders.join(" or ")} does)` : ""}.`
          : `When they use it, it's sent to ${deciders.join(" or ") || "the room's owner"} for approval.`}
      </div>
      {room.workerApprove === false && <div className="hint warn">{OLD_WORKER_APPROVE}</div>}
      <RoomJoinRequests room={room} self={self} />
    </>
  );
}

/** Share a group as a room: shows a one-time invite code to send a teammate. */
export function ShareRoomDialog({
  groupKey,
  title,
  onClose,
  shared,
}: {
  groupKey: string;
  title: string;
  onClose: () => void;
  /** Shown once this dialog made the room (not for an Invite to one there already): what else the group's area offers it (its artifacts). */
  shared?: (roomId: string) => React.ReactNode;
}) {
  const [code, setCode] = useState<{ roomId: string; invite: string; warning?: string; created?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const status = useTeamStatus();
  const st = status && !isErr(status) ? status : null;
  const room = code ? st?.rooms.find((r) => r.id === code.roomId) : undefined;
  useEffect(() => {
    setError(null);
    window.mb.teamShareGroup(groupKey, title).then((r: { roomId: string; invite: string; warning?: string; created: boolean } | { error: string }) => (isErr(r) ? setError(r.error) : setCode(r)));
  }, [groupKey, title, attempt]);
  const fresh = async () => {
    if (!code) return;
    const r: { invite: string } | { error: string } = await window.mb.teamCreateInvite(code.roomId);
    if (isErr(r)) setError(r.error);
    else setCode({ ...code, invite: r.invite });
  };
  return (
    <Modal className="modal team-dlg" onClose={onClose}>
      <h3>Share {title} as a team room</h3>
      <div className="sub-h">
        Teammates who join see this group as a shared room. Sessions outside rooms are never visible to anyone.
      </div>
      {error && <ShareError error={error} />}
      {!code && !error && <div className="hint">Creating the room and checking with the signaling server…</div>}
      {code && <InviteCode invite={code.invite} warning={code.warning} />}
      {code?.created && shared?.(code.roomId)}
      {room && <AdminAccepts room={room} self={st?.self?.id} />}
      <div className="row">
        {error && (
          <button className="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        )}
        {code && (
          <button className="outline" onClick={fresh}>
            New code
          </button>
        )}
        <button className="outline" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Paste a room code: joins once the inviter's Mockingbird accepts and the room has been copied. */
export function JoinRoomDialog({ onClose }: { onClose: () => void }) {
  const status = useTeamStatus();
  const [text, setText] = useState("");
  const [joining, setJoining] = useState<{ roomId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const st = status && !isErr(status) ? status : null;
  const joined = joining && st?.rooms.find((r) => r.id === joining.roomId);
  const pending = joining && st?.pending.find((p) => p.roomId === joining.roomId);
  const join = async () => {
    setError(null);
    const r: { roomId: string; name: string } | { error: string } = await window.mb.teamJoin(text.trim());
    if (isErr(r)) setError(r.error);
    else setJoining(r);
  };
  return (
    <Modal className="modal team-dlg" onClose={onClose}>
      <h3>Join a team room</h3>
      <div className="sub-h">Paste the code a teammate sent you. It names the room and their signaling server; nothing else needs setting up.</div>
      {!joining && (
        <>
          <label>Room code</label>
          <textarea className="team-code" autoFocus placeholder="e.g. MBR1-…" value={text} onChange={(e) => setText(e.target.value)} />
        </>
      )}
      {joining && !joined && pending && <div className={pending.state === "declined" || pending.state === "rejected" ? "err" : "hint"}>{pendingJoinText(pending)}</div>}
      {joining && !joined && pending?.state === "approval" && (
        <div className="hint">The room's admin lets people in. They may ask you to read out your fingerprint (Settings → Team) to check it's you.</div>
      )}
      {joined && <div className="set-note ok">Joined {joined.name}. It's in the sidebar as {joined.groupKey}.</div>}
      {error && <div className="err">{error}</div>}
      <div className="row">
        {joining && pending && !joined && (
          <button
            className="outline"
            onClick={async () => {
              const r = await window.mb.teamCancelJoin(joining.roomId);
              if (isErr(r)) return setError(r.error);
              onClose();
            }}
          >
            Cancel joining
          </button>
        )}
        <button className="outline" onClick={onClose}>
          {joining ? "Close" : "Cancel"}
        </button>
        {!joining && (
          <button className="primary" disabled={!text.trim()} onClick={join}>
            Join
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---- leaving and removing --------------------------------------------------------------------

const OLD_WORKER = "Your signaling Worker is older and can't cut members off: update it (cd signaling && npx wrangler deploy) to also cut them off at the Worker.";

const OLD_WORKER_ROLES = "Your signaling Worker is older and only knows the room's first admin: joins an admin accepts and removals they make reach it through that admin's Mockingbird, when it's online. Update it (cd signaling && npx wrangler deploy).";

/** A member's role as a chip: owner or admin (members have none). */
export function RoleChip({ room, id, className = "team-role" }: { room: TeamRoomSummary; id: string; className?: string }) {
  const role = roleIn(room, id);
  if (role !== "owner" && role !== "admin") return null;
  const title = role === "owner" ? "Owns the room: makes admins, hands over ownership, sets where backups go and the House project" : "Admin: accepts or declines joins, removes members, sets the room's rules";
  return (
    <span className={`${className} ${role}`} title={title}>
      {role}
    </span>
  );
}

/**
 * What this install can do to a teammate's role and membership — one list,
 * for the Team tab's right-click menu and Settings → Team's buttons — and the
 * dialogs those open. The room log checks each again (rooms.ts).
 */
export function useMemberActions(room: TeamRoomSummary, open?: (d: MemberDialog) => void) {
  const [removing, setRemovingHere] = useState<{ id: string; name: string } | null>(null);
  const [handing, setHandingHere] = useState<{ id: string; name: string } | null>(null);
  // with `open`, the dialogs are its owner's to show (MemberDialogs), so they outlive what opened them
  const setRemoving = (m: { id: string; name: string }) => (open ? open({ kind: "remove", room, member: m }) : setRemovingHere(m));
  const setHanding = (m: { id: string; name: string }) => (open ? open({ kind: "handover", room, member: m }) : setHandingHere(m));
  const [error, setError] = useState<string | null>(null);
  const setAdmin = async (m: { id: string; name: string }, admin: boolean) => {
    setError(null);
    const r: unknown = await window.mb.teamSetAdmin(room.id, m.id, admin);
    if (isErr(r)) setError(`Couldn't change ${m.name}'s role: ${r.error}`);
  };
  const actionsFor = (m: { id: string; name: string }): MenuEntry[] => {
    const can = roleChanges(room, m.id);
    return tidyMenu([
      can.makeAdmin && { key: "admin", label: "Make admin", title: `${m.name} can then accept joins, remove members and set the room's rules`, onPick: () => void setAdmin(m, true) },
      can.removeAdmin && { key: "unadmin", label: "Remove admin", menuLabel: "Remove as admin", title: `${m.name} goes back to being a member`, onPick: () => void setAdmin(m, false) },
      can.handOver && { key: "owner", label: "Hand over…", menuLabel: "Hand over ownership…", title: `Make ${m.name} the room's owner; you stay an admin`, onPick: () => setHanding(m) },
      "-",
      canRemove(room, m.id) && { key: "remove", label: "Remove…", menuLabel: "Remove from the room…", danger: true, onPick: () => setRemoving(m) },
    ]);
  };
  const dialogs = (
    <>
      {removing && <RemoveMemberDialog room={room} member={removing} onClose={() => setRemovingHere(null)} />}
      {handing && <HandOverDialog room={room} member={handing} onClose={() => setHandingHere(null)} />}
    </>
  );
  return { actionsFor, dialogs, error, clearError: () => setError(null) };
}

/** A room dialog asked for from somewhere that may go before it's answered (an area's Members ▾ on the landscape). */
export type MemberDialog =
  | { kind: "remove" | "handover"; room: TeamRoomSummary; member: { id: string; name: string } }
  | { kind: "leave" | "claim"; room: TeamRoomSummary };

/**
 * The room dialogs MemberDialog asks for, the Team view's own: shown by the app, outside whatever asked, so they're
 * drawn over everything at their own size and stay open as the asker goes. The room as `rooms` has it now, or as it
 * was asked for once it's gone (leaving it says what it did).
 */
export function MemberDialogs({ dialog, rooms, onClose }: { dialog: MemberDialog | null; rooms: readonly TeamRoomSummary[]; onClose: () => void }) {
  if (!dialog) return null;
  const room = rooms.find((r) => r.id === dialog.room.id) ?? dialog.room;
  if (dialog.kind === "remove") return <RemoveMemberDialog room={room} member={dialog.member} onClose={onClose} />;
  if (dialog.kind === "handover") return <HandOverDialog room={room} member={dialog.member} onClose={onClose} />;
  if (dialog.kind === "leave") return <LeaveRoomDialog room={room} onClose={onClose} />;
  return <ClaimOwnershipDialog room={room} onClose={onClose} />;
}

/** Hand ownership to a teammate (the owner only): what changes, then done. */
export function HandOverDialog({ room, member, onClose }: { room: TeamRoomSummary; member: { id: string; name: string }; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handOver = async () => {
    setBusy(true);
    setError(null);
    const r: unknown = await window.mb.teamHandOver(room.id, member.id);
    setBusy(false);
    if (isErr(r)) setError(r.error);
    else onClose();
  };
  return (
    <Modal className="modal team-dlg" onClose={busy ? undefined : onClose}>
      <h3>
        Hand {room.name} over to {member.name}?
      </h3>
      <div className="sub-h">Only {member.name} can hand it back.</div>
      <ul className="team-effects">
        <li>
          <b>{member.name}</b> becomes the room's owner: makes and removes admins, hands ownership on, and sets where backups go and the room's House project.
        </li>
        <li>
          <b>You</b> stay an admin: you can still accept joins, remove members and set the room's rules — until {member.name} changes that.
        </li>
        <li>Everyone sees it in the room's chat.</li>
      </ul>
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={handOver}>
          {busy ? "Handing over…" : `Hand over to ${member.name}`}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The ownership claim, where it concerns this install: a claim took the room
 * from you (take it back), or you may claim it from an owner who hasn't been
 * heard from for 14 days. `detail` also says when a claim opens (Settings).
 * With `onClaim`, the claim's dialog is its owner's to show (MemberDialogs).
 */
export function RoleNotice({ room, detail = false, onClaim }: { room: TeamRoomSummary; detail?: boolean; onClaim?: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = claimState(room);
  if (!c) return null;
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    const r = await call();
    setBusy(false);
    if (isErr(r)) setError(r.error);
  };
  if (c.kind === "claimed") return detail ? <div className="set-row-note">{c.by} claimed ownership of the room from {c.from}, who can take it back.</div> : null;
  if (c.kind === "waiting") return detail ? <div className="set-row-note">If {c.owner} isn't heard from in the room by {new Date(c.opensAt).toLocaleDateString()}, you can claim its ownership.</div> : null;
  return (
    <div className="role-notice">
      {c.kind === "contest" ? (
        <>
          <span>{c.by} claimed ownership of the room while you were away.</span>
          <button className="outline" disabled={busy} onClick={() => run(() => window.mb.teamContestClaim(room.id))}>
            {busy ? "Taking it back…" : "Take it back"}
          </button>
        </>
      ) : (
        <>
          <span>{c.owner}, the room's owner, hasn't been heard from in it for 14 days.</span>
          <button className="outline" onClick={() => (onClaim ? onClaim() : setAsking(true))}>
            Claim ownership…
          </button>
        </>
      )}
      {error && <div className="err">{error}</div>}
      {asking && c.kind === "can-claim" && <ClaimOwnershipDialog room={room} onClose={() => setAsking(false)} />}
    </div>
  );
}

/** Claim a room's ownership from an owner who hasn't been heard from for 14 days: what changes, then done. */
export function ClaimOwnershipDialog({ room, onClose }: { room: TeamRoomSummary; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = claimState(room);
  const owner = c && "owner" in c ? c.owner : "its owner";
  const claim = async () => {
    setBusy(true);
    setError(null);
    const r: unknown = await window.mb.teamClaimOwnership(room.id);
    setBusy(false);
    if (isErr(r)) setError(r.error);
    else onClose();
  };
  return (
    <Modal className="modal team-dlg" onClose={busy ? undefined : onClose}>
      <h3>Claim ownership of {room.name}?</h3>
      <div className="sub-h">For a room whose owner is gone for good. If {owner} is only away, ask them to hand it over instead.</div>
      <ul className="team-effects">
        <li>
          <b>You</b> become the owner: you make admins and set where backups go and the room's House project.
        </li>
        <li>
          <b>Everyone</b> sees the claim in the room's chat. {owner} can take ownership back whenever they're next online, and can't be removed from the room for 14 days.
        </li>
      </ul>
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={claim}>
          {busy ? "Claiming…" : "Claim ownership"}
        </button>
      </div>
    </Modal>
  );
}

/** Leave a room: what happens on each side, then what did. The owner hands ownership to a teammate first. */
export function LeaveRoomDialog({ room, onClose }: { room: TeamRoomSummary; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<LeaveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const others = room.members.filter((m) => !m.self);
  const names = others.map((m) => m.name).join(", ");
  const owner = myRole(room) === "owner" && others.length > 0;
  // the longest-standing admin is the likely heir; any teammate can be picked
  const [heir, setHeir] = useState(() => (room.admins ?? []).find((id) => others.some((m) => m.id === id)) ?? others[0]?.id ?? "");
  const heirName = others.find((m) => m.id === heir)?.name ?? "";
  const leave = async () => {
    setBusy(true);
    setError(null);
    if (owner) {
      const h: unknown = await window.mb.teamHandOver(room.id, heir);
      if (isErr(h)) {
        setBusy(false);
        return setError(`Couldn't hand ownership to ${heirName}, so you're still in the room: ${h.error}`);
      }
    }
    const r: LeaveOutcome | { error: string } = await window.mb.teamLeaveRoom(room.id);
    setBusy(false);
    if (isErr(r)) setError(r.error);
    else setDone(r);
  };
  if (done) {
    return (
      <Modal className="modal team-dlg" onClose={onClose}>
        <h3>You left {done.roomName}</h3>
        <div className="sub-h">It's deleted from this Mac. Group {room.groupKey} stays as an ordinary group; its sessions keep running, no longer shared.</div>
        <ul className="team-effects">
          {done.told.length > 0 && <li>{done.told.join(", ")} heard it.</li>}
          {done.notTold.length > 0 && <li>{done.notTold.join(", ")} weren't connected: they hear it from a teammate, or from the signaling Worker, when they're next online.</li>}
          {done.worker && <li className="warn">{done.worker}</li>}
        </ul>
        {done.problems.length > 0 && (
          <>
            <div className="set-row-title">Not cleaned up</div>
            <ul className="team-effects">
              {done.problems.map((p) => (
                <li key={p} className="warn">
                  {p}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="row">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal className="modal team-dlg" onClose={busy ? undefined : onClose}>
      <h3>Leave {room.name}?</h3>
      <div className="sub-h">Coming back takes a new invite code from someone still in the room.</div>
      <ul className="team-effects">
        <li>
          <b>On this Mac</b> the room is deleted: its log and chat, its artifacts, the room's files in your worktrees (and agents' copies of artifacts), the conversations and snapshots teammates sent, and
          your sessions' backups, including any pushed to origin. Group {room.groupKey} stays as an ordinary group, and its sessions keep running — no longer shared.
        </li>
        <li>
          {others.length ? (
            <>
              <b>{names}</b> {others.length === 1 ? "sees" : "see"} you leave: your sessions disappear from {others.length === 1 ? "their" : "each"} Mockingbird and the chat says you
              left. {others.length === 1 ? "Their copy of the room stays." : "Their copies of the room stay."}
            </>
          ) : (
            <>You're the room's last member: nobody else has it.</>
          )}
        </li>
        {owner && (
          <li>
            <b>You own the room</b>, so ownership goes to a teammate first — they make admins and set where backups go and the room's House project:{" "}
            <select className="team-heir" aria-label="Hand ownership to" value={heir} disabled={busy} onChange={(e) => setHeir(e.target.value)}>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {roleIn(room, m.id) === "admin" ? " (admin)" : ""}
                </option>
              ))}
            </select>
          </li>
        )}
        <li>
          <b>The signaling Worker</b> cuts your key off: no more connections, invites or relay for this room.
        </li>
        {room.workerRevoke === false && <li className="warn">{OLD_WORKER}</li>}
      </ul>
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="outline danger-btn" disabled={busy || (owner && !heir)} onClick={leave}>
          {busy ? "Leaving…" : owner ? `Hand over to ${heirName} and leave` : "Leave room"}
        </button>
      </div>
    </Modal>
  );
}

/** Remove a teammate from a room (its admin only): what happens on each side, then what did. */
export function RemoveMemberDialog({ room, member, onClose }: { room: TeamRoomSummary; member: { id: string; name: string }; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RemoveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    const r: RemoveOutcome | { error: string } = await window.mb.teamRemoveMember(room.id, member.id);
    setBusy(false);
    if (isErr(r)) setError(r.error);
    else setDone(r);
  };
  const others = room.members.filter((m) => !m.self && m.id !== member.id).map((m) => m.name);
  if (done) {
    return (
      <Modal className="modal team-dlg" onClose={onClose}>
        <h3>
          {done.name} is out of {room.name}
        </h3>
        <ul className="team-effects">
          <li>{done.delivered ? `${done.name}'s Mockingbird heard it and deletes the room there.` : `${done.name} wasn't connected: their Mockingbird deletes the room when it's next online.`}</li>
          <li className={done.worker ? "warn" : undefined}>{done.worker ?? `The signaling Worker cut ${done.name} off.`}</li>
        </ul>
        {error && <div className="err">{error}</div>}
        <div className="row">
          {done.worker && (
            <button className="outline" disabled={busy} onClick={remove}>
              {busy ? "Asking…" : "Ask the Worker again"}
            </button>
          )}
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal className="modal team-dlg" onClose={busy ? undefined : onClose}>
      <h3>
        Remove {member.name} from {room.name}?
      </h3>
      <div className="sub-h">They can come back only with a new invite code.</div>
      <ul className="team-effects">
        <li>
          <b>On {member.name}'s Mac</b> Mockingbird deletes the room once it hears — now if they're connected, else when they're next online — and their group stays as an
          ordinary one, its sessions running. A Mockingbird that's older, or doesn't cooperate, can't be made to delete anything: what cuts them off is the Worker.
        </li>
        <li>
          <b>{others.length ? `You and ${others.join(", ")}` : "You"}</b>: {member.name}'s sessions leave the room, and the conversations and snapshots of them copied here are
          deleted. The chat says you removed them; commits and their Co-authored-by trailers stay.
        </li>
        <li>
          <b>The signaling Worker</b> cuts their key off: their connections, the invites they made and relay access for this room.
        </li>
        {room.workerRevoke === false && <li className="warn">{OLD_WORKER}</li>}
      </ul>
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="outline danger-btn" disabled={busy} onClick={remove}>
          {busy ? "Removing…" : `Remove ${member.name}`}
        </button>
      </div>
    </Modal>
  );
}

/** What this Mac refused from a teammate in a room, or noticed about it (this install's key connected elsewhere): one line each, repeats counted. */
export function RoomWarnings({ room }: { room: TeamRoomSummary }) {
  if (!room.warnings?.length) return null;
  return (
    <div className="room-warnings">
      {room.warnings.map((w) => (
        <div key={w.key} className="room-warning" title={`First ${new Date(w.since).toLocaleString()}`}>
          {w.text}
          {w.count > 1 ? ` (${w.count} times, last at ${new Date(w.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})` : ""}
        </div>
      ))}
    </div>
  );
}

/** Rooms this install left or was removed from, with what couldn't be cleaned up, until dismissed. */
export function TeamNotices({ notices }: { notices: TeamNotice[] | undefined }) {
  if (!notices?.length) return null;
  return (
    <div className="team-notices">
      {notices.map((n) => (
        <div key={n.id} className={`team-notice ${n.problems.length || n.worker ? "warn" : ""}`}>
          <div className="team-notice-text">
            <b>{n.kind === "removed" ? `${n.by ?? "A teammate"} removed you from ${n.roomName}` : `You left ${n.roomName}`}</b>
            {n.problems.length || n.worker ? (
              <ul>
                {n.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {n.worker && <li>{n.worker}</li>}
              </ul>
            ) : (
              <div>It's deleted from this Mac; its group and sessions stay, as local ones.</div>
            )}
          </div>
          <button className="link" onClick={() => window.mb.teamDismissNotice(n.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

/** A room's members in Settings → Team: each one's role, and what this install's role lets it change. */
function RoomMembers({ room }: { room: TeamRoomSummary }) {
  const acts = useMemberActions(room);
  return (
    <div className="team-members">
      {room.members.map((m) => (
        <div key={m.id} className="team-member">
          <span className="team-initials">{initialsOf(m.name)}</span>
          <span className="team-member-name">
            {m.name}
            {m.self ? " (you)" : ""}
          </span>
          <RoleChip room={room} id={m.id} />
          {room.online.includes(m.id) && <span className="team-link direct">connected</span>}
          {!m.self && (
            <span className="team-member-acts">
              {acts.actionsFor(m).map((a) =>
                a === "-" ? null : (
                  <button key={a.key} className={`link ${a.danger ? "danger" : ""}`} title={a.title} onClick={() => a.onPick()}>
                    {a.label}
                  </button>
                )
              )}
            </span>
          )}
        </div>
      ))}
      <div className="set-row-note">
        {rolesLine(room)}
        {room.former?.length ? ` Left: ${room.former.map((f) => f.name).join(", ")}.` : ""}
      </div>
      {room.workerRoles === false && (room.admins?.length ?? 0) > 0 && <div className="set-row-note warn">{OLD_WORKER_ROLES}</div>}
      <RoleNotice room={room} detail />
      {acts.error && <div className="err">{acts.error}</div>}
      {acts.dialogs}
    </div>
  );
}

/**
 * Settings → Team, per room: whether this Mac runs the room's Claude and Codex sessions in the room's sandbox (on by
 * default). Turning it off asks first; it's this Mac's alone and applies as sessions start or restart. Main keeps it
 * (team:setRoomSandbox) and says what it is in the team status, so no copy of the settings here can change it.
 */
function RoomSandboxSetting({ room }: { room: TeamRoomSummary }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const on = room.sandboxed !== false;
  const set = async (sandboxed: boolean) => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamSetRoomSandbox(room.id, sandboxed), sandboxed ? "Couldn't turn the room's sandbox on" : "Couldn't turn the room's sandbox off");
    setBusy(false);
    if (isErr(r)) return setError(r.error);
    setConfirming(false);
  };
  return (
    <>
      <SetRow
        title="Sandbox this room's sessions"
        note={
          on
            ? "On this Mac, its Claude and Codex sessions run in the room's sandbox: away from your credentials, your MCP servers and your home folder. Teammates' Macs decide for themselves."
            : "Off on this Mac: its Claude and Codex sessions run like your own, with your credentials, MCP servers and home folder. Teammates' Macs decide for themselves. Applies as sessions start or restart."
        }
      >
        <Toggle label={`Sandbox this room's sessions: ${room.name}`} on={on} disabled={busy} onChange={(v) => (v ? void set(true) : setConfirming(true))} />
      </SetRow>
      {error && !confirming && <div className="err">{error}</div>}
      {confirming && (
        <Modal className="modal team-dlg" onClose={busy ? undefined : () => setConfirming(false)}>
          <h3>Run sessions without the sandbox in {room.name}?</h3>
          <div className="sub-h">On this Mac only, as its sessions start or restart.</div>
          <ul className="team-effects">
            <li>
              Its Claude and Codex sessions run like your own: with your git and GitHub credentials, your MCP servers (Slack…), <code>~/.claude</code>, Docker and your
              caches.
            </li>
            <li className="warn">
              So does anyone you let type into them, and anything a teammate's agent sends them. What teammates put in the room — House tickets, room artifacts, their
              changes — reaches an agent with your credentials and MCP servers too.
            </li>
            <li>Teammates' Macs decide for themselves: this changes nothing on theirs.</li>
          </ul>
          {error && <div className="err">{error}</div>}
          <div className="row">
            <button className="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="primary" disabled={busy} onClick={() => void set(false)}>
              {busy ? "Turning off…" : "Turn the sandbox off"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Settings → Team. */
export function TeamSection({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const status = useTeamStatus();
  const [name, setName] = useState(settings.teamName ?? "");
  const [url, setUrl] = useState(settings.signalingUrl ?? "");
  const [check, setCheck] = useState<{ ok: boolean; msg: string } | null>(null);
  const [dialog, setDialog] = useState<"join" | { groupKey: string; title: string } | null>(null);
  const [leaving, setLeaving] = useState<TeamRoomSummary | null>(null);
  const [note, copy] = useCopyNote();
  const st = status && !isErr(status) ? status : null;

  const saveUrl = () => {
    const v = url.trim().replace(/\/+$/, "");
    if (v !== (settings.signalingUrl ?? "")) onChange({ signalingUrl: v });
  };
  const checkUrl = async () => {
    saveUrl();
    setCheck({ ok: true, msg: "Checking…" });
    const r: { protocol: number; relay: boolean; creators: number | "any"; revoke?: boolean; problem: string | null } | { error: string } = await window.mb.teamCheckSignaling(url.trim());
    if (isErr(r)) setCheck({ ok: false, msg: r.error });
    else if (r.problem) setCheck({ ok: false, msg: r.problem });
    else {
      const creators = r.creators === "any" ? "anyone can create rooms (local test server)" : `${r.creators} room creator${r.creators === 1 ? "" : "s"} allowed`;
      const revoke = r.revoke === false ? " · can't cut off removed members yet: redeploy it (cd signaling && npx wrangler deploy)" : "";
      setCheck({ ok: true, msg: `Reachable · protocol ${r.protocol} · ${creators} · ${r.relay ? "TURN relay configured" : "no TURN relay (set its secrets for strict networks)"}${revoke}` });
    }
  };

  return (
    <>
      <h2>Team</h2>
      <p className="set-lede">
        Share a group as a room and teammates join it with a code. Mockingbirds then talk laptop to laptop (WebRTC, end-to-end encrypted); the signaling Worker
        only introduces them.
      </p>
      {status && isErr(status) && <div className="err">Couldn't read the team status: {status.error}</div>}
      {st?.error && <div className="err">{st.error}</div>}
      <TeamNotices notices={st?.notices} />
      <SetRow title="Your name" note="What teammates see next to your sessions and messages">
        <input
          type="text"
          className="team-input"
          placeholder={st?.self?.name ?? "Your name"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== (settings.teamName ?? "") && onChange({ teamName: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </SetRow>
      <SetRow title="Signaling URL" note="Your signaling Worker's address. New rooms use it; teammates don't need it — invite codes carry it.">
        <input type="text" className="team-input wide" placeholder="e.g. https://signaling.you.workers.dev" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={saveUrl} />
        <button className="outline" disabled={!url.trim()} onClick={checkUrl}>
          Check
        </button>
      </SetRow>
      {check && <div className={check.ok ? "set-note ok" : "err"}>{check.msg}</div>}
      <p className="set-lede team-deploy">
        No Worker yet? Deploy it once to a free Cloudflare account: <code>cd signaling && npx wrangler login && npx wrangler deploy</code>, allow this
        Mockingbird to create rooms (below), then paste the printed workers.dev URL above. signaling/README.md has the optional TURN relay step (for
        teammates behind strict firewalls).
      </p>
      <SetRow title="This Mockingbird's fingerprint" note="Teammates can compare it with what their Mockingbird shows for you">
        <span style={{ position: "relative" }}>
          <code className="team-fp">{st?.self?.fingerprint ?? "—"}</code>
          {st?.self && (
            <button className="outline" onClick={() => copy(st.self!.fingerprint, "the fingerprint")}>
              Copy
            </button>
          )}
          <CopyToast note={note} failed="Couldn't copy" />
        </span>
      </SetRow>
      {st?.self && <AllowCreatorStep id={st.self.id} />}
      <SetRow
        title="Room sessions run inline"
        note="So teammates can scroll them: Claude Code and Codex print on the terminal's normal screen, and teammates' copies keep the history to scroll through on their own. Full screen keeps it inside the agent, so a copy shows one screen of it. Inline, your room sessions go without the full-screen views: Claude Code's flicker-free renderer, clicking in it, copy on select and Focus view, and Codex's full-screen transcript. Inline also hands teammates everything a session's terminal keeps, as far back as it goes, not just the screen you see: whatever it ever printed (a secret an agent showed, say) is in their scrollback too. Applies to room sessions as they start or restart."
      >
        <Toggle
          label="Room sessions run inline so teammates can scroll them"
          on={settings.roomSessionsInline !== false}
          onChange={(v) => onChange({ roomSessionsInline: v })}
        />
      </SetRow>

      <div className="set-sub">Teammates</div>
      {st && !st.peers.length && <div className="set-note">No teammates yet. Share an area from its ⋯ menu (Share as a team room…), or join a room with a code.</div>}
      {st?.peers.map((p) => (
        <SetRow key={p.id} title={p.name} note={`${p.detail ? `${p.detail} · ` : ""}${p.id.replace(/(.{4})(?=.)/g, "$1 ")}`}>
          <span className={`team-link ${p.state}`}>{LINK_LABEL[p.state]}</span>
        </SetRow>
      ))}

      <div className="set-sub">Rooms</div>
      {st?.rooms.map((r) => (
        <div key={r.id} className="team-room">
          <SetRow title={r.name} note={`Group ${r.groupKey} · signaling ${r.signaling}${r.problem ? ` — ${r.problem}` : ""}`}>
            <button className="outline" onClick={() => setDialog({ groupKey: r.groupKey, title: r.name })}>
              Invite…
            </button>
            <button className="outline" onClick={() => setLeaving(r)}>
              Leave room…
            </button>
          </SetRow>
          <RoomWarnings room={r} />
          <RoomSandboxSetting room={r} />
          <RoomBackupsSetting room={r} />
          <RoomMigrationsSetting roomId={r.id} />
          <RoomMembers room={r} />
          <RoomJoinRequests room={r} self={st?.self?.id} />
        </div>
      ))}
      {st?.pending.map((p) => (
        <SetRow key={p.roomId} title={`${p.name} (joining)`} note={pendingJoinText(p)}>
          <button
            className="outline"
            onClick={async () => {
              const r = await window.mb.teamCancelJoin(p.roomId);
              if (isErr(r)) setCheck({ ok: false, msg: `Couldn't cancel: ${r.error}` });
            }}
          >
            {p.state === "rejected" || p.state === "declined" ? "Dismiss" : "Cancel"}
          </button>
        </SetRow>
      ))}
      <div className="set-actions">
        <button className="outline strong" onClick={() => setDialog("join")}>
          Join a room…
        </button>
      </div>
      <RemoteActivity />
      {st?.problems.map((p) => (
        <div key={p} className="err">
          {p}
        </div>
      ))}
      {dialog === "join" && <JoinRoomDialog onClose={() => setDialog(null)} />}
      {dialog && dialog !== "join" && <ShareRoomDialog groupKey={dialog.groupKey} title={dialog.title} onClose={() => setDialog(null)} />}
      {leaving && <LeaveRoomDialog room={leaving} onClose={() => setLeaving(null)} />}
    </>
  );
}
