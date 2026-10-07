import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { settled } from "../settled";
import { ago } from "../../shared/format";
import { AGENT_NAME, isErr } from "../../shared/types";
import { backupFreshness, type RoomSessionBackupView, type TakeoverPlan, type TakeoverResult, type TakeoverView } from "../../shared/team/takeover";
import type { TeamRoomSummary } from "../../shared/team/types";

/**
 * Take-over in the window (docs/team-rooms.md): how fresh each room session's
 * backup is, and "Take over" on a teammate's session with a confirm dialog
 * naming the snapshot and whether the whole conversation is here.
 *
 * Each room session is one row in the sidebar and one pane (live panes): the
 * row and the pane header carry BackupFreshness, and a teammate's also
 * TakeOverButton, found by backupOf. RoomBackupWarnings lists what has no
 * row: this Mac's sessions that couldn't be backed up, and backups it
 * couldn't delete.
 */

/** The take-over view from main, kept current; an { error } when it couldn't be read. */
export function useTakeover(): TakeoverView | { error: string } | null {
  const [view, setView] = useState<TakeoverView | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    settled(window.mb.teamTakeover(), "Couldn't read the room backups").then((v: TakeoverView | { error: string }) => {
      if (!alive) return;
      if (isErr(v)) console.error("[mockingbird]", v.error);
      setView(v);
    });
    const off = window.mb.onTeamTakeoverChanged((v: TakeoverView) => setView(v));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return view;
}

/** The time, moving on every half minute, so "2m ago" stays true. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const short = (sha: string) => sha.slice(0, 8);
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** "backed up 2m ago", "backup failed: …", "latest only on Nick's laptop", or who took it over. */
export function BackupFreshness({ view }: { view: RoomSessionBackupView }) {
  const now = useNow();
  const f = backupFreshness(view, now);
  const tip = [
    `Newest snapshot ${short(view.latest.sha)}, taken ${ago(view.latest.takenAt, now)}`,
    view.pushed ? `On origin: ${short(view.pushed.sha)}, pushed ${ago(view.pushed.at, now)}` : "Not on origin yet",
    !view.self && view.peerCopy ? `Copied to this Mac: ${short(view.peerCopy.sha)}` : "",
    view.problem ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`tk-fresh ${f.tone}`} title={tip}>
      {f.text}
      {view.problem && !view.takenOver && <span className="tk-fresh warn"> · not sent to teammates</span>}
    </span>
  );
}

/**
 * "Take over" on a teammate's room session (its sidebar row and pane header):
 * prominent while the owner is offline. The confirm dialog is the window's
 * (TakeOverDialog), so it outlives the row and the take-over it confirms.
 */
export function TakeOverButton({ view, onOpen }: { view: RoomSessionBackupView; onOpen: (view: RoomSessionBackupView) => void }) {
  if (view.self || view.takenOver || view.dropped) return null;
  return (
    <button
      className={`tk-btn ${view.ownerOnline ? "outline" : "primary"}`}
      title={view.ownerOnline ? `Continue this session on your Mac (${view.ownerName} is connected)` : `${view.ownerName} is offline — continue this session on your Mac`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(view);
      }}
    >
      Take over
    </button>
  );
}

/**
 * What the sidebar rows don't show about a shared group's backups: this
 * Mac's room sessions that couldn't be backed up at all, and backups it
 * should have deleted and couldn't.
 */
export function RoomBackupWarnings({ room, view }: { room: TeamRoomSummary; view: TakeoverView | { error: string } | null }) {
  if (!view) return null;
  if (isErr(view)) {
    return (
      <div className="tk-rows">
        <div className="tk-row-note warn">{view.error}</div>
      </div>
    );
  }
  const warnings = [
    ...view.unbacked.filter((u) => u.roomId === room.id).map((u) => ({ ...u, what: "not backed up" })),
    ...view.cleanup.filter((u) => u.roomId === room.id).map((u) => ({ ...u, what: "backup not deleted from origin" })),
  ];
  if (!warnings.length) return null;
  return (
    <div className="tk-rows">
      {warnings.map((u) => (
        <div key={`${u.what}:${u.sessionId}`} className="tk-row" title={u.problem}>
          <div className="tk-line">
            <span className="dot waiting" />
            <span className="tk-name">{u.title}</span>
          </div>
          <div className="tk-sub">
            <span className="tk-fresh warn">
              {u.what}: {u.problem}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Confirm a take-over: which snapshot, whether the conversation is whole, which clone. */
export function TakeOverDialog({ view, onClose }: { view: RoomSessionBackupView; onClose: () => void }) {
  const [clone, setClone] = useState<string | null>(null);
  const [plan, setPlan] = useState<TakeoverPlan | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<TakeoverResult | null>(null);
  const now = useNow();
  useEffect(() => {
    let live = true;
    setPlan(null);
    settled(window.mb.teamTakeoverPlan(view.roomId, view.sessionId, clone), "Couldn't check what's here").then((p: TakeoverPlan | { error: string }) => live && setPlan(p));
    return () => {
      live = false;
    };
  }, [view.roomId, view.sessionId, clone]);
  const choose = async () => {
    const dir = await settled(window.mb.pickPath({}), "Couldn't open the folder picker");
    if (isErr(dir)) return setError(dir.error);
    if (dir) setClone(String(dir));
  };
  const go = async () => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamTakeOver(view.roomId, view.sessionId, clone), "Couldn't take over");
    setBusy(false);
    if (isErr(r)) return setError(r.error);
    setDone(r);
  };
  const p = plan && !isErr(plan) ? plan : null;
  const from = (src: "peer" | "origin") => (src === "peer" ? `copied from ${view.ownerName}'s laptop` : "the backup on origin");
  return (
    <Modal className="modal tk-dlg" onClose={onClose} closeOnBackdrop={!busy}>
      <h3>Take over “{view.session.title}”</h3>
      <div className="sub-h">
        {view.ownerOnline ? `${view.ownerName} is connected — tell them first.` : `${view.ownerName} is offline.`} The session continues on this Mac under your account, in a worktree of your
        clone on its branch. {view.ownerName} sees it as taken over.
      </div>
      {plan === null && <div className="fp-note">Checking this Mac and origin…</div>}
      {isErr(plan) && <div className="err">{plan.error}</div>}
      {p && (
        <dl className="tk-facts">
          <dt>Repository</dt>
          <dd>
            {p.clone ? <span className="tk-path">{p.clone}</span> : <span className="warn">No clone of {p.originUrl} among your repositories.</span>}{" "}
            <button className="outline tk-small" onClick={choose} disabled={busy}>
              {p.clone ? "Another…" : "Choose your clone…"}
            </button>
          </dd>
          <dt>Snapshot</dt>
          <dd>
            {p.snapshot ? (
              <>
                {short(p.snapshot.sha)}, taken {ago(p.snapshot.takenAt, now)} — {from(p.snapshot.source)}
                {p.other && (
                  <div className="tk-quiet">
                    Older: {short(p.other.sha)} from {from(p.other.source)}, {ago(p.other.takenAt, now)}
                  </div>
                )}
                {p.latestMissing && <div className="warn">A newer snapshot is only on {p.ownerName}'s laptop: work from its last turns isn't here.</div>}
                {p.snapshot.skipped.length > 0 && <div className="tk-quiet">Too big to carry: {p.snapshot.skipped.join(", ")}</div>}
              </>
            ) : p.clone ? (
              <span className="warn">None reached this Mac or origin — the work is only on {p.ownerName}'s laptop.</span>
            ) : (
              <span className="tk-quiet">Chosen once your clone is known.</span>
            )}
            {p.originProblem && <div className="warn">Couldn't read origin's backup: {p.originProblem}</div>}
          </dd>
          <dt>Conversation</dt>
          <dd>
            {p.conversation.kind === "full" && <>The whole conversation ({size(p.conversation.bytes)}) — {AGENT_NAME[p.agent]} resumes where it left off.</>}
            {p.conversation.kind === "partial" && (
              <span className="warn">
                Only {size(p.conversation.have)} of {size(p.conversation.of)} reached this Mac. {AGENT_NAME[p.agent]} starts from a summary of that and says so.
              </span>
            )}
            {p.conversation.kind === "none" && <span className="warn">It didn't reach this Mac. {AGENT_NAME[p.agent]} starts from the files alone and says so.</span>}
          </dd>
          <dt>Branch</dt>
          <dd>{p.branch ?? "(detached)"}</dd>
        </dl>
      )}
      {error && <div className="err">{error}</div>}
      {done && (
        <div className="fp-note">
          Running here now, on {done.branch ?? "a detached HEAD"}
          {done.renamedFrom ? ` (${done.renamedFrom} was in use here)` : ""} in {done.cwd}.
        </div>
      )}
      <div className="row">
        <button className="outline" onClick={onClose} disabled={busy}>
          {done ? "Close" : "Cancel"}
        </button>
        {!done && (
          <button className="primary" onClick={go} disabled={busy || !p?.clone || !p.snapshot}>
            {busy ? "Taking over…" : "Take over"}
          </button>
        )}
      </div>
    </Modal>
  );
}

