import { useEffect, useState } from "react";
import { isErr } from "../../shared/types";
import { agoShort } from "../../shared/format";
import { auditWords, type AuditEntry } from "../../shared/team/audit";
import { settled } from "../settled";

const SHOWN = 50;

/**
 * Settings → Team → Recent remote activity: the audit log's last entries in
 * words, newest first (docs/team-rooms.md, "Remote activity").
 */
export function RemoteActivity() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    const r = await settled(window.mb.teamAuditRecent(SHOWN), "Couldn't read the audit log");
    if (isErr(r)) return setError(r.error);
    setEntries(r as AuditEntry[]);
    setError("");
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <div className="set-sub">Recent remote activity</div>
      <div className="set-note">
        What teammates did on this Mac, newest first: asking to type and typing, agent messages, take-overs, files and backups they got. Kept in ~/.mockingbird/team/audit.log, readable only by you — who,
        which session, when and how much, never what was typed or said.
      </div>
      {error && <div className="err">{error}</div>}
      {entries && !entries.length && <div className="set-note">Nothing yet.</div>}
      {!!entries?.length && (
        <ul className="audit-list">
          {entries.map((e, i) => (
            <li key={`${e.at}-${e.kind}-${i}`} title={`${new Date(e.at).toLocaleString()}${e.room ? ` · room ${e.room}` : ""}`}>
              <span className="when">{agoShort(e.at)}</span>
              <span className="what">{auditWords(e)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="set-actions">
        <button className="outline" onClick={() => void load()}>
          Refresh
        </button>
      </div>
    </>
  );
}
