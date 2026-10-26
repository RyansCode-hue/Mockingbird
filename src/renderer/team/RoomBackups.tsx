import { useState } from "react";
import { Modal } from "../Modal";
import { Pick } from "../Menu";
import { SetRow } from "../SetRow";
import { Toggle } from "../Toggle";
import { settled } from "../settled";
import { useTakeover } from "./TakeOver";
import { ago } from "../../shared/format";
import { isErr } from "../../shared/types";
import { AWAY_HOURS, type RoomBackupSetting } from "../../shared/team/takeover";
import type { TeamRoomSummary } from "../../shared/team/types";

/**
 * Settings → Team, per room: whether room sessions' backups also go to origin
 * (docs/team-rooms.md, "Take-over"). Off by default — snapshots go only peer
 * to peer. The room's owner alone makes it available, after a warning that
 * anyone who can read the repository can fetch them; each member then allows
 * it for their own sessions or not (BackupConsentPrompt, and the row below
 * the owner's switch). Nobody's work goes to origin on the owner's word alone.
 */
export function RoomBackupsSetting({ room }: { room: TeamRoomSummary }) {
  const view = useTakeover();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!view) return null;
  if (isErr(view)) return <div className="err">Couldn't read where this room's backups go: {view.error}</div>;
  const s = view.rooms.find((r) => r.roomId === room.id);
  if (!s) return null;
  const set = async (on: boolean) => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamSetBackupsToOrigin(room.id, on), on ? `Couldn't turn on backups to ${s.remote}` : `Couldn't turn off backups to ${s.remote}`);
    setBusy(false);
    if (isErr(r)) return setError(r.error);
    setConfirming(false);
  };
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamSetBackupConsent(room.id, allow), allow ? `Couldn't start backing up to ${s.remote}` : `Couldn't stop backing up to ${s.remote}`);
    setBusy(false);
    if (isErr(r)) setError(r.error);
  };
  return (
    <>
      <SetRow title={`Also back up to ${s.remote}`} note={<BackupsNote s={s} />}>
        <Toggle
          label={`Also back up to ${s.remote}: ${room.name}`}
          on={s.toOrigin}
          disabled={!s.canChange || busy}
          title={s.canChange ? undefined : `Only ${s.adminName ?? "the room's owner"}, the room's owner, can change this`}
          onChange={(on) => (on ? setConfirming(true) : void set(false))}
        />
      </SetRow>
      <SetRow
        title={`Back up my sessions to ${s.remote}`}
        note={
          !s.toOrigin
            ? `Available once ${s.canChange ? "you turn" : `${s.adminName ?? "the room's owner"} turns`} on backups to ${s.remote} above. Yours stay peer to peer until you allow it.`
            : s.consent
              ? `Your room sessions' snapshots also go to ${s.remote} after each turn. Turning this off deletes the ones you pushed.`
              : `Your room sessions' backups stay peer to peer${s.consent === false ? " (you chose Not now)" : ""}: teammates can take them over only from copies that reached their Mac.`
        }
      >
        <Toggle label={`Back up my sessions to ${s.remote}: ${room.name}`} on={s.toOrigin && s.consent === true} disabled={!s.toOrigin || busy} onChange={(on) => void answer(on)} />
      </SetRow>
      {error && !confirming && <div className="err">{error}</div>}
      {confirming && (
        <Modal className="modal team-dlg" onClose={busy ? undefined : () => setConfirming(false)}>
          <h3>
            Back up {room.name}'s sessions to {s.remote}?
          </h3>
          <div className="sub-h">Until now, backups have gone only to teammates' Macs, peer to peer.</div>
          <ul className="team-effects">
            <li>
              Each member is asked once whether <b>their own sessions</b> in this room may push a snapshot after each agent turn — uncommitted and untracked files, except secrets
              (<code>.env</code> files, keys, certificates, credential files) — to a hidden ref on {s.remote} (<code>refs/mockingbird/rooms/…</code>). The conversation never goes
              there. Nobody's work goes there until they allow it.
            </li>
            <li className="warn">
              <b>Anyone with read access to the repository</b> can fetch those snapshots, not only this room's members.
            </li>
            <li>A teammate can then take a session over while its owner's laptop is off.</li>
            <li>Each push runs the repository's pre-push hook (a secret scanner, say); if the hook refuses it, the session shows the backup failed.</li>
            <li>Turning it off later — here, or a member for their own — deletes from {s.remote} the backups each member pushed.</li>
          </ul>
          {error && <div className="err">{error}</div>}
          <div className="row">
            <button className="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="primary" disabled={busy} onClick={() => void set(true)}>
              {busy ? "Turning on…" : `Back up to ${s.remote}`}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** What the setting does, and who can change it. */
function BackupsNote({ s }: { s: RoomBackupSetting }) {
  const who = s.canChange ? "It makes the option available to every member; each one allows it for their own sessions." : `Only ${s.adminName ?? "the room's owner"}, the room's owner, can change it.`;
  const changed = s.changed ? ` ${s.changed.self ? "You" : s.changed.byName} turned it ${s.toOrigin ? "on" : "off"} ${ago(s.changed.at)}.` : "";
  return (
    <>
      {s.toOrigin
        ? `After each agent turn, the snapshots of members who allow it — uncommitted and untracked files, never secrets — also go to a hidden ref on ${s.remote}, so a teammate can take over while their laptop is off. Anyone with read access to the repository can fetch them.`
        : `Off: snapshots go only to teammates' Macs, peer to peer, while you're connected. On: members who allow it also back up to a hidden ref on ${s.remote} after each turn, so a teammate can take over while their laptop is off — and anyone with read access to the repository can fetch them.`}{" "}
      {who}
      {changed}
    </>
  );
}

/**
 * Asked once per room, when its owner makes backups to origin available:
 * whether this member's own sessions may go there. Allow / Not now, kept on
 * this Mac (Settings → Team changes it later). Closing it asks again on the
 * next start.
 */
export function BackupConsentPrompt({ setting: s, roomName, onLater }: { setting: RoomBackupSetting; roomName: string; onLater: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamSetBackupConsent(s.roomId, allow), "Couldn't save your answer");
    setBusy(false);
    if (isErr(r)) setError(r.error);
  };
  return (
    <Modal className="modal team-dlg tk-consent" onClose={busy ? undefined : onLater} closeOnBackdrop={false}>
      <h3>Back up my room sessions to {s.remote === "origin" ? "origin" : `${s.remote} (origin)`}?</h3>
      <div className="sub-h">
        {s.canChange ? "You" : (s.adminName ?? "The room's owner")} made backups to {s.remote} available in {roomName}. Your sessions there go only to teammates' Macs, peer to peer, unless you allow it.
      </div>
      <ul className="team-effects">
        <li>After each agent turn, a snapshot of your room session — uncommitted and untracked files, never secrets — goes to a hidden ref on {s.remote}.</li>
        <li className="warn">
          <b>Anyone with read access to the repository</b> can fetch it, not only this room's members.
        </li>
        <li>A teammate can then take your session over while your laptop is off (when you've allowed that while you're away).</li>
        <li>You can turn it off in Settings → Team; what you pushed is deleted then.</li>
      </ul>
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={busy} onClick={() => void answer(false)}>
          Not now
        </button>
        <button className="primary" disabled={busy} onClick={() => void answer(true)}>
          Allow
        </button>
      </div>
    </Modal>
  );
}

const HOURS_LABEL: Record<(typeof AWAY_HOURS)[number], string> = { 8: "8 hours", 24: "a day", 72: "3 days", 168: "a week" };

/**
 * Settings → Team, per room: "While I'm away" — this member allows teammates
 * to take over their room sessions (all of them, or one) while they're
 * offline, until it expires. A grant their Mockingbird signs; without one an
 * offline member's sessions can't be taken over at all. Stop withdraws it.
 */
export function RoomAwaySetting({ room }: { room: TeamRoomSummary }) {
  const view = useTakeover();
  const [hours, setHours] = useState<(typeof AWAY_HOURS)[number]>(24);
  const [scope, setScope] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!view || isErr(view)) return null;
  const s = view.rooms.find((r) => r.roomId === room.id);
  if (!s) return null;
  const mine = view.sessions.filter((v) => v.roomId === room.id && v.self && !v.takenOver && !v.dropped);
  const titleOf = (id: string) => mine.find((v) => v.sessionId === id)?.session.title ?? "a session that's gone";
  const set = async (away: { hours: number; sessions: string[] | null } | null) => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamSetAwayGrant(room.id, away), away ? "Couldn't allow take-overs while you're away" : "Couldn't stop allowing take-overs");
    setBusy(false);
    if (isErr(r)) setError(r.error);
  };
  const until = s.away ? new Date(s.away.expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  const which = s.away ? (s.away.sessions === null ? "all your sessions" : s.away.sessions.map((id) => `“${titleOf(id)}”`).join(", ")) : "";
  return (
    <>
      <SetRow
        title="While I'm away"
        note={
          s.away
            ? `Teammates may take over ${which} in this room while you're offline, until ${until}. Your Mockingbird signed it; it stops then, or now with Stop.`
            : "Off: while you're offline, nobody can take over your sessions in this room. Online, you're always asked first (Hand over / Keep it). Allow it before you leave, for all your sessions or one."
        }
      >
        {s.away ? (
          <button className="outline" disabled={busy} onClick={() => void set(null)}>
            Stop
          </button>
        ) : (
          <>
            <Pick title={`Which of your sessions in ${room.name}`} value={scope} disabled={busy} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All my sessions</option>
              {mine.map((v) => (
                <option key={v.sessionId} value={v.sessionId}>
                  {v.session.title}
                </option>
              ))}
            </Pick>
            <Pick title="For how long" value={hours} disabled={busy} onChange={(e) => setHours(Number(e.target.value) as (typeof AWAY_HOURS)[number])}>
              {AWAY_HOURS.map((h) => (
                <option key={h} value={h}>
                  for {HOURS_LABEL[h]}
                </option>
              ))}
            </Pick>
            <button className="outline" disabled={busy} onClick={() => void set({ hours, sessions: scope === "all" ? null : [scope] })}>
              Allow
            </button>
          </>
        )}
      </SetRow>
      {error && <div className="err">{error}</div>}
    </>
  );
}
