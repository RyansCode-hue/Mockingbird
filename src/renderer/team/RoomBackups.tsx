import { useState } from "react";
import { Modal } from "../Modal";
import { SetRow } from "../SetRow";
import { Toggle } from "../Toggle";
import { settled } from "../settled";
import { useTakeover } from "./TakeOver";
import { ago } from "../../shared/format";
import { isErr } from "../../shared/types";
import type { RoomBackupSetting } from "../../shared/team/takeover";
import type { TeamRoomSummary } from "../../shared/team/types";

/**
 * Settings → Team, per room: whether room sessions' backups also go to origin
 * (docs/team-rooms.md, "Take-over"). Off by default — snapshots go only peer
 * to peer. The room's admin alone turns it on, for everyone's sessions, after
 * a warning that anyone who can read the repository can fetch them.
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
  return (
    <>
      <SetRow title={`Also back up to ${s.remote}`} note={<BackupsNote s={s} />}>
        <Toggle
          label={`Also back up to ${s.remote}: ${room.name}`}
          on={s.toOrigin}
          disabled={!s.canChange || busy}
          title={s.canChange ? undefined : `Only ${s.adminName ?? "the room's admin"}, the room's admin, can change this`}
          onChange={(on) => (on ? setConfirming(true) : void set(false))}
        />
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
              After each agent turn, <b>every member's sessions in this room</b> push a snapshot — uncommitted and untracked files, except secrets (<code>.env</code> files,
              keys, certificates, credential files) — to a hidden ref on {s.remote} (<code>refs/mockingbird/rooms/…</code>). The conversation never goes there.
            </li>
            <li className="warn">
              <b>Anyone with read access to the repository</b> can fetch those snapshots, not only this room's members.
            </li>
            <li>A teammate can then take a session over while its owner's laptop is off.</li>
            <li>Each push runs the repository's pre-push hook (a secret scanner, say); if the hook refuses it, the session shows the backup failed.</li>
            <li>Turning it off later deletes from {s.remote} the backups each member pushed.</li>
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
  const who = s.canChange ? "It applies to everyone's sessions in the room." : `Only ${s.adminName ?? "the room's admin"}, the room's admin, can change it.`;
  const changed = s.changed ? ` ${s.changed.self ? "You" : s.changed.byName} turned it ${s.toOrigin ? "on" : "off"} ${ago(s.changed.at)}.` : "";
  return (
    <>
      {s.toOrigin
        ? `After each agent turn, room sessions' snapshots — uncommitted and untracked files, never secrets — also go to a hidden ref on ${s.remote}, so a teammate can take over while your laptop is off. Anyone with read access to the repository can fetch them.`
        : `Off: snapshots go only to teammates' Macs, peer to peer, while you're connected. On: they also go to a hidden ref on ${s.remote} after each turn, so a teammate can take over while your laptop is off — and anyone with read access to the repository can fetch them.`}{" "}
      {who}
      {changed}
    </>
  );
}
