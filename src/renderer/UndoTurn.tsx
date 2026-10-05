import React, { useEffect, useState } from "react";
import type { SessionInfo, TurnChange, TurnSnapshot } from "../shared/types";
import { plural } from "./changeCount";

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

/**
 * Put a session's files back as they were before one of its recent turns.
 * Shows what would change first; the restore is itself recorded, so it can
 * be undone the same way. The conversation isn't rewound.
 */
export function UndoTurnDialog({ session, onClose, onTellAgent }: { session: SessionInfo; onClose: () => void; onTellAgent: (text: string) => void }) {
  const [list, setList] = useState<Result<{ snapshots: TurnSnapshot[]; lastError: string | null }> | null>(null);
  const [pick, setPick] = useState<TurnSnapshot | null>(null);
  const [changes, setChanges] = useState<Result<TurnChange[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ restored: number; removed: number; snap: TurnSnapshot } | null>(null);
  const [error, setError] = useState("");
  const load = () => window.mb.turnsList(session.id).then(setList, (err: unknown) => setList({ error: `Couldn't list the turns: ${String(err)}` }));
  useEffect(() => {
    load();
  }, [session.id]);
  // the list shown is always the picked turn's: a slower answer for an earlier pick is dropped
  useEffect(() => {
    setChanges(null);
    if (!pick) return;
    let live = true;
    window.mb.turnsChanges(session.id, pick.n).then(
      (r: Result<TurnChange[]>) => live && setChanges(r),
      (err: unknown) => live && setChanges({ error: `Couldn't compare with the files now: ${String(err)}` })
    );
    return () => {
      live = false;
    };
  }, [session.id, pick?.n]);
  const restore = async () => {
    if (!pick) return;
    setBusy(true);
    setError("");
    const r = await window.mb.turnsRestore(session.id, pick.n).catch((err: unknown) => ({ error: String(err) }));
    setBusy(false);
    if (isErr(r)) return setError(r.error);
    setDone({ restored: r.restored, removed: r.removed, snap: pick });
    setPick(null);
    load();
  };
  const snaps = list && !isErr(list) ? list.snapshots : [];
  const c = changes && !isErr(changes) ? changes : null;
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal undo-dlg" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>Undo a turn — {session.ticketTitle ?? session.title}</h3>
        <div className="sub-h">
          Puts the files back as they were before one of the agent's recent turns — its own edits and anything its commands changed. The branch, the staged
          changes and the conversation stay as they are, and ignored files aren't touched.
        </div>
        {list === null && <div className="fp-note">Loading…</div>}
        {isErr(list) && <div className="err">{list.error}</div>}
        {list && !isErr(list) && list.lastError && <div className="fp-note warn">The last turn wasn't recorded: {list.lastError}</div>}
        {done && (
          <div className="undo-done">
            Restored {plural(done.restored, "file")}
            {done.removed ? ` and removed ${done.removed}` : ""}. The conversation isn't rewound, so the agent still thinks its changes are there.
            <button
              className="outline"
              onClick={() =>
                onTellAgent(
                  done.snap.beforeUndo
                    ? "I redid the file changes I had undone — the files are back as they were before my undo. "
                    : `I undid the file changes from your turn for "${done.snap.prompt.slice(0, 120)}" — the files are back as they were before it. `
                )
              }
            >
              Tell the agent
            </button>
          </div>
        )}
        {snaps.length === 0 && list && !isErr(list) && <div className="fp-note">No turns recorded yet. Each prompt you send from now on is recorded first.</div>}
        <div className="undo-list">
          {snaps.map((s) => (
            <button key={s.n} className={`undo-row ${pick?.n === s.n ? "on" : ""}`} onClick={() => setPick(s)}>
              <span className="undo-when">{ago(s.at)}</span>
              <span className="undo-what">{s.beforeUndo ? "Before your undo — restoring this puts the undone changes back" : s.prompt || "(no prompt text)"}</span>
            </button>
          ))}
        </div>
        {pick && (
          <div className="undo-preview">
            {changes === null && <div className="fp-note">Comparing with the files now…</div>}
            {isErr(changes) && <div className="err">{changes.error}</div>}
            {c && c.length === 0 && <div className="fp-note">The files are already as they were then.</div>}
            {c && c.length > 0 && (
              <>
                <div className="pl-dim">
                  Restoring puts back {plural(c.filter((x) => x.action === "restore").length, "file")} and removes {c.filter((x) => x.action === "remove").length} created since:
                </div>
                <div className="undo-files">
                  {c.map((x) => (
                    <div key={x.path} className={x.action}>
                      <span>{x.action === "restore" ? "↺" : "−"}</span> {x.path}
                    </div>
                  ))}
                </div>
              </>
            )}
            {pick.skipped.length > 0 && <div className="fp-note warn">Not recorded (over 5 MB), so left as they are: {pick.skipped.join(", ")}</div>}
          </div>
        )}
        {error && <div className="err">{error}</div>}
        <div className="row">
          <button className="outline" onClick={onClose}>Close</button>
          <button className="primary" disabled={!pick || !c || c.length === 0 || busy} onClick={restore}>
            {busy ? "Restoring…" : "Restore these files"}
          </button>
        </div>
      </div>
    </div>
  );
}
