import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { settled } from "../settled";
import { ago, plural } from "../../shared/format";
import { AGENT_NAME, isErr } from "../../shared/types";
import {
  backupFreshness,
  leftCopyText,
  type IncomingAsk,
  type LeftCopy,
  type OutgoingAsk,
  type ReceivedChanges,
  type RoomSessionBackupView,
  type TakeoverPlan,
  type TakeoverResult,
  type TakeoverView,
} from "../../shared/team/takeover";
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
 *
 * A connected owner is asked first: HandOverPrompt is theirs. A copy a
 * teammate continued is stopped here and shows LeftCopyPanel (its pane) and
 * LeftCopyLine (its row): Take it back, and Send the changes the teammate
 * lacks. Changes sent that way land on the teammate's session as
 * ReceivedNotice, reviewed and applied in ReceivedDialog.
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
export function TakeOverButton({ view, onOpen, asking }: { view: RoomSessionBackupView; onOpen: (view: RoomSessionBackupView) => void; asking?: OutgoingAsk | null }) {
  if (view.self || view.takenOver || view.dropped) return null;
  if (asking) {
    return (
      <button className="tk-btn outline show" disabled title={asking.state === "asking" ? `Waiting for ${asking.ownerName} to answer` : `${asking.ownerName} is handing it over`}>
        {asking.state === "asking" ? `Asking ${asking.ownerName}…` : "Handing over…"}
      </button>
    );
  }
  return (
    <button
      className={`tk-btn ${view.ownerOnline ? "outline" : "primary"}`}
      title={view.ownerOnline ? `Ask ${view.ownerName} to hand this session over to your Mac (they're connected)` : `${view.ownerName} is offline — continue this session on your Mac`}
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

/** "1:42": what's left until `deadline`. */
const countdown = (deadline: number, now: number) => {
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Confirm a take-over: which snapshot, whether the conversation is whole,
 * which clone. A connected owner is asked first (`asking` follows the
 * request); when they keep it, don't answer or drop offline, the dialog says
 * so and checks again — offline, the take-over can then go ahead.
 */
export function TakeOverDialog({ view, asking, onClose, takeBack }: { view: RoomSessionBackupView; asking?: OutgoingAsk | null; onClose: () => void; takeBack?: boolean }) {
  const [clone, setClone] = useState<string | null>(null);
  const [plan, setPlan] = useState<TakeoverPlan | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<TakeoverResult | null>(null);
  const [checks, setChecks] = useState(0);
  const now = useNow(busy ? 1000 : 30_000);
  useEffect(() => {
    let live = true;
    settled(window.mb.teamTakeoverPlan(view.roomId, view.sessionId, clone), "Couldn't check what's here").then((p: TakeoverPlan | { error: string }) => live && setPlan(p));
    return () => {
      live = false;
    };
  }, [view.roomId, view.sessionId, clone, checks]);
  const choose = async () => {
    const dir = await settled(window.mb.pickPath({}), "Couldn't open the folder picker");
    if (isErr(dir)) return setError(dir.error);
    if (dir) {
      setPlan(null);
      setClone(String(dir));
    }
  };
  // hidden while the owner decides or their turn finishes: the take-over carries on, and a failure is still told
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const go = async () => {
    setBusy(true);
    setError("");
    const r = await settled(window.mb.teamTakeOver(view.roomId, view.sessionId, clone), "Couldn't take over");
    if (!shown.current) {
      if (isErr(r)) alert(`“${view.session.title}”: ${r.error}`);
      return;
    }
    setBusy(false);
    if (isErr(r)) {
      setError(r.error);
      setChecks((n) => n + 1); // the owner may have kept it or gone offline: what's possible now
      return;
    }
    setDone(r);
  };
  const p = plan && !isErr(plan) ? plan : null;
  const online = p ? p.ownerOnline : view.ownerOnline;
  const from = (src: "peer" | "origin") => (src === "peer" ? `copied from ${view.ownerName}'s laptop` : "the backup on origin");
  const verb = takeBack ? "Take back" : "Take over";
  return (
    <Modal className="modal tk-dlg" onClose={onClose} closeOnBackdrop={!busy}>
      <h3>
        {verb} “{view.session.title}”
      </h3>
      <div className="sub-h">
        {online
          ? `${view.ownerName} is connected, so they're asked first: their turn in progress finishes, and the session continues here from exactly where it stopped on their laptop. If they keep it or don't answer within 2 minutes, it stays with them.`
          : `${view.ownerName} is offline. Their copy stops when their Mockingbird is back, and keeps its files.`}{" "}
        The session continues on this Mac under your account, in a worktree of your clone on its branch.
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
      {busy && asking && (
        <div className="fp-note tk-asking">
          {asking.state === "asking"
            ? `Waiting for ${asking.ownerName} to answer — kept in ${countdown(asking.deadline, now)} if they don't.`
            : `${asking.ownerName} is handing it over: their turn finishes, then the backup comes straight here and their agent stops.`}
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {done && (
        <div className="fp-note">
          Running here now, on {done.branch ?? "a detached HEAD"}
          {done.renamedFrom ? ` (${done.renamedFrom} was in use here)` : ""} in {done.cwd}.
        </div>
      )}
      <div className="row">
        <button className="outline" onClick={onClose} disabled={busy && !asking} title={busy && asking ? "Hide this: it carries on, and you're told if it doesn't happen" : undefined}>
          {done ? "Close" : busy && asking ? "Hide" : "Cancel"}
        </button>
        {!done && (
          <button className="primary" onClick={go} disabled={busy || !p?.clone || !p.snapshot}>
            {busy ? (online ? `Asking ${view.ownerName}…` : `${verb === "Take back" ? "Taking back" : "Taking over"}…`) : online ? `Ask ${view.ownerName}` : verb}
          </button>
        )}
      </div>
    </Modal>
  );
}

/**
 * A teammate asks to continue one of this Mac's sessions on their laptop:
 * Hand over or Keep, kept by itself when the time runs out. While it's being
 * handed over, says what's happening.
 */
export function HandOverPrompt({ ask, onShow }: { ask: IncomingAsk; onShow?: (sessionId: string) => void }) {
  const now = useNow(1000);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const answer = async (a: "handover" | "keep") => {
    setSent(true);
    setError("");
    const r = await settled(window.mb.teamTakeoverAnswer(ask.askId, a), "Couldn't answer");
    if (isErr(r)) {
      setSent(false);
      setError(r.error);
    }
  };
  const waiting = ask.state === "waiting";
  return (
    <Modal className="modal tk-dlg tk-ask" onClose={() => waiting && !sent && void answer("keep")} closeOnBackdrop={false}>
      <h3>
        {ask.fromName} wants to continue “{ask.title}” on their laptop
      </h3>
      {waiting ? (
        <>
          <div className="sub-h">
            <b>Hand over</b>: the turn in progress finishes, Mockingbird backs the session up and sends it straight to {ask.fromName}, then stops the agent here. Your worktree stays exactly
            as it is, and you can take the session back later.
            <br />
            <b>Keep</b>: it carries on here, and {ask.fromName} is told.
          </div>
          <div className="fp-note tk-quiet">Kept in {countdown(ask.deadline, now)} if you don't answer.</div>
        </>
      ) : (
        <div className="fp-note">Handing it over to {ask.fromName}: waiting for the turn to finish, then the backup goes to them and the agent stops here…</div>
      )}
      {error && <div className="err">{error}</div>}
      <div className="row">
        {onShow && (
          <button className="outline" onClick={() => onShow(ask.sessionId)}>
            Show the session
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="outline" onClick={() => answer("keep")} disabled={!waiting || sent}>
          Keep
        </button>
        <button className="primary" onClick={() => answer("handover")} disabled={!waiting || sent}>
          {waiting ? "Hand over" : "Handing over…"}
        </button>
      </div>
    </Modal>
  );
}


/** Send a left copy's changes to whoever continues it; the outcome comes back as text (or an error). */
async function sendLeft(l: LeftCopy): Promise<string | null> {
  const r = await settled(window.mb.teamTakeoverSendLeft(l.roomId, l.sessionId), `Couldn't send the changes to ${l.now.ownerName}`);
  return isErr(r) ? r.error : null;
}

/** What a left copy has that whoever continues it lacks, in words; null when there's nothing to say. */
function unsentText(l: LeftCopy): { tone: "warn" | "muted"; text: string } | null {
  if (!l.unsent) return { tone: "muted", text: "Checking this copy's files…" };
  if ("error" in l.unsent) return { tone: "warn", text: `Couldn't tell what ${l.now.ownerName} lacks: ${l.unsent.error}` };
  const n = l.unsent.files.length;
  if (n) return { tone: "warn", text: l.now.self ? `This copy has ${plural(n, "changed file")} the session here doesn't — they stay in its folder` : `This copy has ${plural(n, "changed file")} ${l.now.ownerName} doesn't have` };
  if (l.sent) return { tone: "muted", text: `Its changes were sent to ${l.now.ownerName} ${ago(l.sent.at)}` };
  return null;
}

/**
 * The pane of a copy a teammate continued: stopped, its files untouched.
 * Take it back (once their copy has a backup), Close, and — when this copy
 * has changes they lack — Send them.
 */
export function LeftCopyPanel({ left, onTakeBack, onClose }: { left: LeftCopy; onTakeBack: () => void; onClose: () => void }) {
  const [error, setError] = useState("");
  const u = unsentText(left);
  const n = left.unsent && !("error" in left.unsent) ? left.unsent.files.length : 0;
  useEffect(() => {
    void settled(window.mb.teamTakeoverCheckLeft(left.roomId, left.sessionId), "Couldn't count this copy's changes").then((r) => isErr(r) && setError(r.error));
  }, [left.roomId, left.sessionId]);
  return (
    <div className="tk-left">
      <div className="tk-left-title">{leftCopyText(left)}</div>
      <div className="tk-quiet">
        {left.byName} continued it {ago(left.at)}. The agent stopped here; this worktree and every file in it are as they were.
      </div>
      {u && (
        <div className={`tk-left-unsent ${u.tone}`} title={n ? (left.unsent as { files: string[] }).files.slice(0, 40).join("\n") : undefined}>
          {u.text}
          {n > 0 && !left.now.self && (
            <button
              className="outline tk-small"
              disabled={left.sending || !left.now.online}
              title={left.now.online ? `Send them to ${left.now.ownerName}: they land on their session as a patch to review and apply` : `${left.now.ownerName} is offline`}
              onClick={async () => setError((await sendLeft(left)) ?? "")}
            >
              {left.sending ? "Sending…" : `Send to ${left.now.ownerName}`}
            </button>
          )}
        </div>
      )}
      {error && <div className="err">{error}</div>}
      <div className="row">
        {!left.now.self && (
          <button className="outline strong" onClick={onTakeBack} disabled={!left.takeBack} title={left.takeBack ? `Continue ${left.now.ownerName}'s copy here, from their newest backup` : `Offered once ${left.now.ownerName}'s copy has a backup`}>
            Take it back
          </button>
        )}
        <button className="outline" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** A left copy on its sidebar row: where it continues, and the changes this copy has that they lack (with Send). */
export function LeftCopyLine({ left, onTakeBack }: { left: LeftCopy; onTakeBack: () => void }) {
  const [error, setError] = useState("");
  const u = unsentText(left);
  const n = left.unsent && !("error" in left.unsent) ? left.unsent.files.length : 0;
  return (
    <>
      <span className="br tk-fresh muted tk-line-btn" title={`${leftCopyText(left)} — ${left.byName} continued it ${ago(left.at)}`}>
        <span className="tk-t">{left.now.self ? "taken back into another session" : `continued on ${left.now.ownerName}'s laptop`}</span>
        {left.takeBack && (
          <button
            className="tk-btn outline show tk-takeback"
            title={`Continue ${left.now.ownerName}'s copy here, from their newest backup`}
            onClick={(e) => {
              e.stopPropagation();
              onTakeBack();
            }}
          >
            Take it back
          </button>
        )}
      </span>
      {u && u.tone === "warn" && (
        <span className="br tk-fresh warn tk-line-btn" title={error || u.text}>
          <span className="tk-t">{n ? `${plural(n, "changed file")} ${left.now.self ? "only here" : `${left.now.ownerName} doesn't have`}` : u.text}</span>
          {n > 0 && !left.now.self && (
            <button
              className="tk-btn outline show"
              disabled={left.sending || !left.now.online}
              onClick={async (e) => {
                e.stopPropagation();
                setError((await sendLeft(left)) ?? "");
              }}
            >
              {left.sending ? "Sending…" : "Send"}
            </button>
          )}
        </span>
      )}
      {error && <span className="br tk-fresh warn">{error}</span>}
    </>
  );
}

/** Changes a teammate sent for one of this Mac's sessions, waiting to be reviewed: on its pane and row. */
export function ReceivedNotice({ received, onReview, compact }: { received: ReceivedChanges[]; onReview: (r: ReceivedChanges) => void; compact?: boolean }) {
  const open = received.filter((r) => !r.applied);
  if (!open.length) return null;
  return (
    <>
      {open.map((r) => (
        <div key={r.id} className={compact ? "br tk-fresh warn tk-line-btn" : "team-pane-note tk-received"} title={`${r.fromName}'s copy of “${r.title}” had these after you continued it`}>
          <span className="tk-t">
            {r.fromName} sent {plural(r.files.length, "changed file")}
            {compact ? "" : " from their copy, made after you continued it"}
          </span>
          <button
            className={compact ? "tk-btn outline show" : "outline tk-small"}
            onClick={(e) => {
              e.stopPropagation();
              onReview(r);
            }}
          >
            Review
          </button>
        </div>
      ))}
    </>
  );
}

/** Review a teammate's changes: the files and the patch; apply them to this session's worktree (only cleanly), or dismiss them. */
export function ReceivedDialog({ received, onClose }: { received: ReceivedChanges; onClose: () => void }) {
  const [patch, setPatch] = useState<{ patch: string; truncated: boolean; file: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(received.applied !== null);
  useEffect(() => {
    let live = true;
    settled(window.mb.teamTakeoverReceivedPatch(received.roomId, received.id), "Couldn't read the changes").then((p) => live && setPatch(p));
    return () => {
      live = false;
    };
  }, [received.roomId, received.id]);
  const run = async (what: "apply" | "dismiss") => {
    setBusy(true);
    setError("");
    const r =
      what === "apply"
        ? await settled(window.mb.teamTakeoverApplyReceived(received.roomId, received.id), "Couldn't apply the changes")
        : await settled(window.mb.teamTakeoverDismissReceived(received.roomId, received.id), "Couldn't dismiss the changes");
    setBusy(false);
    if (isErr(r)) return setError(r.error);
    if (what === "apply") setApplied(true);
    else onClose();
  };
  const mark = { added: "A", modified: "M", deleted: "D" } as const;
  return (
    <Modal className="modal tk-dlg tk-received-dlg" onClose={onClose} closeOnBackdrop={!busy}>
      <h3>Changes from {received.fromName}</h3>
      <div className="sub-h">
        {received.fromName}'s copy of “{received.title}” had these after you continued it ({ago(received.at)}). Applying puts them into this session's worktree only where they apply
        cleanly; nothing is overwritten, and Undo turn can take them out again.
      </div>
      <div className="tk-files">
        {received.files.map((f) => (
          <div key={f.path}>
            <span className={`tk-mark ${f.status}`}>{mark[f.status]}</span> <span className="tk-path">{f.path}</span>
          </div>
        ))}
      </div>
      {patch === null && <div className="fp-note">Reading the changes…</div>}
      {isErr(patch) && <div className="err">{patch.error}</div>}
      {patch && !isErr(patch) && (
        <>
          <pre className="tk-patch">{patch.patch}</pre>
          {patch.truncated && <div className="tk-quiet">The rest is in {patch.file}</div>}
        </>
      )}
      {error && <div className="err">{error}</div>}
      {applied && <div className="fp-note">Applied to this session's worktree.</div>}
      <div className="row">
        <button className="outline" onClick={() => run("dismiss")} disabled={busy} title="Forget these changes (the teammate's copy still has them)">
          {applied ? "Done" : "Dismiss"}
        </button>
        <span style={{ flex: 1 }} />
        <button className="outline" onClick={onClose} disabled={busy}>
          Close
        </button>
        {!applied && (
          <button className="primary" onClick={() => run("apply")} disabled={busy}>
            {busy ? "Applying…" : "Apply to my worktree"}
          </button>
        )}
      </div>
    </Modal>
  );
}

