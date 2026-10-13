import { useEffect, useState } from "react";
import { SetRow } from "../SetRow";
import { Toggle } from "../Toggle";
import { settled } from "../settled";
import { isErr } from "../../shared/types";
import type { MigrationsView } from "../../shared/team/migrations";

/**
 * Migration number reservations (docs/team-rooms.md, "Teammates' changes and
 * migration numbers"): one line on the House board saying who holds which
 * number, and the room admin's settings in Settings → Team — the check that
 * holds back agents' unreserved new migrations, and each repository's
 * folders where detection got them wrong.
 */

type Err = { error: string };

/** A room's reservations, kept current. */
function useMigrations(roomId: string): MigrationsView | Err | null {
  const [view, setView] = useState<MigrationsView | Err | null>(null);
  useEffect(() => {
    let alive = true;
    window.mb.teamChangesView(roomId).then((v: MigrationsView | Err) => {
      if (!alive) return;
      if (isErr(v)) console.error(`[mockingbird] couldn't read room ${roomId}'s migration reservations:`, v.error);
      setView(v);
    });
    const off = window.mb.onTeamChangesChanged((v: MigrationsView) => {
      if (v?.roomId === roomId) setView(v);
    });
    return () => {
      alive = false;
      off();
    };
  }, [roomId]);
  return view;
}

/** "Migrations: 0025 Nick (#447), 0026 You (#453)", under the House board's heading. */
export function MigrationsLine({ roomId }: { roomId: string }) {
  const view = useMigrations(roomId);
  if (!view) return null;
  if (isErr(view)) return <div className="house-problem">Migration reservations couldn't be read: {view.error}</div>;
  if (!view.reservations.length && !view.problems.length) return null;
  const folders = new Set(view.reservations.map((r) => `${r.repo}/${r.folder}`));
  return (
    <>
      {view.reservations.length > 0 && (
        <div className="mig-line" title={view.check ? "Agents reserve a number before adding a migration; an unreserved new one is held back once." : "The room's admin turned the migration check off: agents still reserve, nothing holds an unreserved one back."}>
          <b>Migrations:</b>{" "}
          {view.reservations.map((r, i) => (
            <span key={r.id} className={r.clash ? "mig-clash" : undefined} title={`${r.folder} in ${r.repo} · ${r.session}${r.branch ? ` · ${r.branch}` : ""}${r.clash ? " · reserved by someone else first: reserve again" : ""}`}>
              {i > 0 && ", "}
              {folders.size > 1 && <span className="house-dim">{r.folder}/</span>}
              {r.label} {r.self ? "You" : r.member}
              {r.ticket ? ` (${r.ticket})` : ""}
              {r.clash ? " — clash" : ""}
            </span>
          ))}
        </div>
      )}
      {view.problems.map((p) => (
        <div key={p} className="house-problem">
          {p}
        </div>
      ))}
    </>
  );
}

/** Settings → Team, per room: the migration check (its admin's), and the folders where detection got them wrong. */
export function RoomMigrationsSetting({ roomId }: { roomId: string }) {
  const view = useMigrations(roomId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  if (!view) return null;
  if (isErr(view)) return <div className="err">Couldn't read this room's migration settings: {view.error}</div>;
  const set = async (on: boolean) => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamChangesSetCheck(roomId, on), on ? "Couldn't turn the migration check on" : "Couldn't turn the migration check off");
    setBusy(false);
    if (isErr(r)) setError(r.error);
  };
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError("");
    const folders = editing.text.split(",").map((f) => f.trim()).filter(Boolean);
    const r = await settled(window.mb.teamChangesSetFolders(roomId, editing.key, folders), "Couldn't set the migration folders");
    setBusy(false);
    if (isErr(r)) return setError(r.error);
    setEditing(null);
  };
  const who = view.canChange ? "It applies to everyone's agents in the room." : `Only ${view.adminName ?? "the room's admin"}, the room's admin, can change it.`;
  return (
    <>
      <SetRow
        title="Hold back unreserved migrations"
        note={`Agents reserve the next migration number (reserve_migration_number) before adding a numbered migration; with this on, an agent's new migration file whose number isn't reserved for its user is held back once and told to reserve. ${who}`}
      >
        <Toggle label="Hold back unreserved migrations" on={view.check} disabled={!view.canChange || busy} title={view.canChange ? undefined : `Only ${view.adminName ?? "the room's admin"}, the room's admin, can change this`} onChange={(on) => void set(on)} />
      </SetRow>
      {view.repos.map((r) => (
        <SetRow
          key={r.key}
          title={`Migration folders · ${r.label}`}
          note={r.problem ? `Couldn't be read here: ${r.problem}` : r.override ? `Set by the room's admin (Mockingbird found ${r.detected.join(", ") || "none"}).` : r.detected.length ? "Found by Mockingbird: folders whose files mostly start with a number." : "Mockingbird found none here."}
        >
          {editing?.key === r.key ? (
            <span className="mig-edit">
              <input type="text" autoFocus value={editing.text} placeholder="db/migrations, other/folder" aria-label={`Migration folders for ${r.label}`} onChange={(e) => setEditing({ key: r.key, text: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void save()} />
              <button className="primary" disabled={busy} onClick={() => void save()}>
                Save
              </button>
              <button className="outline" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <code className="mig-folders">{(r.override ?? r.detected).join(", ") || "—"}</code>
              {view.canChange && (
                <button className="outline" disabled={busy} title="Name the folders yourself; leave it empty to go back to what Mockingbird finds" onClick={() => setEditing({ key: r.key, text: (r.override ?? r.detected).join(", ") })}>
                  Change…
                </button>
              )}
            </>
          )}
        </SetRow>
      ))}
      {error && <div className="err">{error}</div>}
    </>
  );
}
