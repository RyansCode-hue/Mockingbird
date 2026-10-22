import React, { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { SetRow } from "./SetRow";
import { Toggle } from "./Toggle";
import { CopyToast, useCopyNote } from "./copyNote";
import { RoomBackupsSetting } from "./team/RoomBackups";
import { RoomMigrationsSetting } from "./team/Migrations";
import { RemoteActivity } from "./team/RemoteActivity";
import { isErr, type Settings } from "../shared/types";
import { allowCreatorsCommand } from "../shared/team/protocol";
import type { LeaveOutcome, PeerStatus, RemoveOutcome, TeamNotice, TeamRoomSummary, TeamStatus } from "../shared/team/types";
import { OLD_WORKER_APPROVE, pendingJoinText, RoomJoinRequests } from "./team/JoinRequests";
import type { ConnectedSummary } from "./team/connectedModel";
import { ChatIcon as TeamIcon } from "./Icons";
import { plural } from "../shared/format";

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
 * The Sessions view's one line for the team rooms, where their groups used to
 * be listed: how many of teammates' sessions run and who's online. It opens
 * the Team view — the only room's, or the room list.
 */
export function ConnectedLine({ summary, onOpen }: { summary: ConnectedSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="connected-line"
      title={`${plural(summary.live, "teammate's session")} running in ${plural(summary.rooms, "team room")}${summary.online.length ? ` · online: ${summary.online.join(", ")}` : ""} — open the Team view`}
      onClick={onOpen}
    >
      <TeamIcon />
      <span className="cl-text">
        <span className="cl-title">{summary.title}</span>
        <span className={`cl-sub ${summary.online.length ? "on" : ""}`}>{summary.sub}</span>
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

/** Who lets a code's holder in: the room's admin (this install, or the teammate it's sent to for approval). */
function AdminAccepts({ room, self }: { room: TeamRoomSummary; self?: string }) {
  const admin = room.members.find((m) => m.id === room.admin);
  return (
    <>
      <div className="hint">
        {admin?.self
          ? "You're the room's admin: when they use it, Mockingbird asks you to accept them."
          : `When they use it, it's sent to ${admin?.name ?? "the room's admin"} (the room's admin) for approval.`}
      </div>
      {room.workerApprove === false && <div className="hint warn">{OLD_WORKER_APPROVE}</div>}
      <RoomJoinRequests room={room} self={self} />
    </>
  );
}

/** Share a group as a room: shows a one-time invite code to send a teammate. */
export function ShareRoomDialog({ groupKey, title, onClose }: { groupKey: string; title: string; onClose: () => void }) {
  const [code, setCode] = useState<{ roomId: string; invite: string; warning?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const status = useTeamStatus();
  const st = status && !isErr(status) ? status : null;
  const room = code ? st?.rooms.find((r) => r.id === code.roomId) : undefined;
  useEffect(() => {
    setError(null);
    window.mb.teamShareGroup(groupKey, title).then((r: { roomId: string; invite: string; warning?: string } | { error: string }) => (isErr(r) ? setError(r.error) : setCode(r)));
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

/** Who the admin is, in words: the creator, or the longest-standing member once the creator has left. */
export function adminLine(room: TeamRoomSummary): string {
  const admin = room.members.find((m) => m.id === room.admin);
  const role = room.admin && room.admin === room.creator ? "its creator" : "its longest-standing member, since the creator left";
  if (!admin) return "Nobody can remove members of this room.";
  return admin.self ? `You're this room's admin (${role}): you can remove members.` : `${admin.name} is this room's admin (${role}) and can remove members.`;
}

/** Leave a room: what happens on each side, then what did. */
export function LeaveRoomDialog({ room, onClose }: { room: TeamRoomSummary; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<LeaveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const others = room.members.filter((m) => !m.self);
  const names = others.map((m) => m.name).join(", ");
  // leaving as the admin hands it on: to the creator if still here, else the longest-standing member
  const isAdmin = room.members.some((m) => m.self && m.id === room.admin);
  const nextAdmin = isAdmin ? (others.find((m) => m.id === room.creator) ?? others[0]) : undefined;
  const leave = async () => {
    setBusy(true);
    setError(null);
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
              {nextAdmin && ` ${nextAdmin.name} becomes the admin, who can remove members.`}
            </>
          ) : (
            <>You're the room's last member: nobody else has it.</>
          )}
        </li>
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
        <button className="outline danger-btn" disabled={busy} onClick={leave}>
          {busy ? "Leaving…" : "Leave room"}
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

/** A room's members in Settings → Team: who's the admin, and Remove… for the admin. */
function RoomMembers({ room, onRemove }: { room: TeamRoomSummary; onRemove: (m: { id: string; name: string }) => void }) {
  const isAdmin = room.members.some((m) => m.self && m.id === room.admin);
  return (
    <div className="team-members">
      {room.members.map((m) => (
        <div key={m.id} className="team-member">
          <span className="team-initials">{initialsOf(m.name)}</span>
          <span className="team-member-name">
            {m.name}
            {m.self ? " (you)" : ""}
          </span>
          {m.id === room.admin && <span className="team-admin" title={adminLine(room)}>admin</span>}
          {room.online.includes(m.id) && <span className="team-link direct">connected</span>}
          {isAdmin && !m.self && (
            <button className="link danger" onClick={() => onRemove(m)}>
              Remove…
            </button>
          )}
        </div>
      ))}
      <div className="set-row-note">
        {adminLine(room)}
        {room.former?.length ? ` Left: ${room.former.map((f) => f.name).join(", ")}.` : ""}
      </div>
    </div>
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
  const [removing, setRemoving] = useState<{ room: TeamRoomSummary; member: { id: string; name: string } } | null>(null);
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
      {st && !st.peers.length && <div className="set-note">No teammates yet. Share a group from its row in the sidebar (⇪), or join a room with a code.</div>}
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
          <RoomBackupsSetting room={r} />
          <RoomMigrationsSetting roomId={r.id} />
          <RoomMembers room={r} onRemove={(member) => setRemoving({ room: r, member })} />
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
      {removing && <RemoveMemberDialog room={removing.room} member={removing.member} onClose={() => setRemoving(null)} />}
    </>
  );
}
