import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Select, placePopover } from "../Menu";
import { useEscape } from "../useEscape";
import { usePersisted } from "../prefs";
import { usePresence } from "../motion";
import { AGENT_NAME, isErr, type AgentKind, type SessionInfo } from "../../shared/types";
import { BRANCH_RE, statusLabel } from "../../shared/team/house";
import { type TicketSessionFailure, type TicketSessionPlan, type TicketSessionResult } from "../../shared/team/ticketSession";

/**
 * Start session on a House ticket (docs/team-rooms.md, "Start a session from
 * a ticket"): a small confirmation by the card or the ticket's button saying
 * what one click does — the claim, the repository and branch, the agent —
 * then the main process claims the ticket, makes the worktree and starts the
 * agent in the room's group. Whatever stops it is said here, with the step it
 * stopped at; a claim it couldn't undo is offered for release.
 */

type Err = { error: string };

const BRANCH_FROM: Record<TicketSessionPlan["branchFrom"], string> = {
  claim: "your claim's branch",
  ticket: "the ticket's branch in the House",
  session: "your room session's branch",
  new: "new",
};

/** What Start does about the claim, in a line. */
function claimLine(p: TicketSessionPlan): { text: string; bad: boolean } {
  const h = p.holder;
  if (h.state === "free") return { text: `Claims #${p.n} as you in the House`, bad: false };
  if (h.state === "yours") return { text: `#${p.n} is yours already: no claim`, bad: false };
  if (h.state === "taken") return { text: `${h.by} has #${p.n}: a session can only start on a ticket that's free or yours`, bad: true };
  return { text: `#${p.n} is ${statusLabel(h.status)}: only open tickets get a session`, bad: true };
}

export function TicketStartPopover({ roomId, n, anchor, onClose, onStarted }: { roomId: string; n: number; anchor: HTMLElement; onClose: () => void; onStarted: (s: SessionInfo) => void }) {
  const [plan, setPlan] = useState<TicketSessionPlan | Err | null>(null);
  const [agent, setAgent] = usePersisted<AgentKind>("mb.house.startAgent", "claude");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<TicketSessionFailure | null>(null);
  const [released, setReleased] = useState<string | null>(null);
  useEscape(() => !starting && onClose());
  useEffect(() => {
    let alive = true;
    window.mb.houseSessionPlan(roomId, n).then((p: TicketSessionPlan | Err) => {
      if (!alive) return;
      if (isErr(p)) console.error(`[mockingbird] couldn't plan a session for #${n}:`, p.error);
      else {
        setRepo(p.repos[0]?.path ?? "");
        setBranch(p.branch);
      }
      setPlan(p);
    });
    return () => {
      alive = false;
    };
  }, [roomId, n]);

  // placed by its anchor, in a portal over the board (whose columns scroll and would clip it)
  const box = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>("menu", { also: box });
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!box.current) return;
    setPos(placePopover(anchor.getBoundingClientRect(), { width: box.current.offsetWidth, height: box.current.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [plan, failure, released]);

  const ready = plan && !isErr(plan) ? plan : null;
  const chosen = ready?.repos.find((r) => r.path === repo);
  const blocked = ready ? ready.holder.state === "taken" || ready.holder.state === "closed" : true;
  const branchOk = !!ready && (ready.branchFrom !== "new" || BRANCH_RE.test(branch.trim()));
  const canStart = !!ready && !blocked && !!chosen && branchOk && !starting;
  const start = async () => {
    if (!ready || !canStart) return;
    setStarting(true);
    setFailure(null);
    const r: TicketSessionResult | Err = await window.mb.houseStartSession(roomId, { n, agent, repoPath: repo, ...(ready.branchFrom === "new" ? { branch: branch.trim() } : {}) });
    setStarting(false);
    if (isErr(r)) return setFailure("step" in r ? (r as TicketSessionFailure) : { error: r.error, step: "session" });
    onStarted(r.session);
  };
  const release = async () => {
    const r = await window.mb.houseWrite(roomId, { kind: "release", n });
    if (isErr(r)) setReleased(`#${n} couldn't be released: ${r.error}`);
    else {
      setReleased(`Released #${n}.`);
      setFailure((f) => (f ? { ...f, stillClaimed: false } : f));
    }
  };

  const claim = ready ? claimLine(ready) : null;
  return createPortal(
    <>
      <div className="t2s-back" onMouseDown={() => !starting && onClose()} />
      <div
        ref={presence}
        className="t2s-pop"
        role="dialog"
        aria-label={`Start a session on #${n}`}
        style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { visibility: "hidden", left: 0, top: 0 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || (e.target as HTMLElement).tagName === "INPUT") && void start()}
      >
        <div className="t2s-h">Start a session on #{n}</div>
        {!plan && <div className="t2s-dim">Reading #{n} from the House…</div>}
        {plan && isErr(plan) && <div className="t2s-err">Couldn't read #{n}: {plan.error}</div>}
        {ready && (
          <>
            <div className="t2s-title">{ready.title}</div>
            <div className="t2s-grid">
              <span className="t2s-k">Claim</span>
              <span className={claim!.bad ? "t2s-bad" : ""}>{claim!.text}</span>
              <span className="t2s-k">Repo</span>
              {ready.repos.length > 1 ? (
                <Select className="t2s-select" value={repo} onChange={setRepo} options={ready.repos.map((r) => ({ value: r.path, label: r.name, description: r.path }))} />
              ) : ready.repos.length === 1 ? (
                <span className="t2s-mono" title={ready.repos[0].path}>
                  {ready.repos[0].name}
                </span>
              ) : (
                <span className="t2s-bad">none on this Mac</span>
              )}
              <span className="t2s-k">Branch</span>
              {ready.branchFrom === "new" ? (
                <span className="t2s-branch">
                  <input type="text" aria-label="Branch" value={branch} spellCheck={false} disabled={blocked} onChange={(e) => setBranch(e.target.value)} />
                  <span className="t2s-dim">new worktree{chosen?.base ? `, from origin/${chosen.base}` : ""}</span>
                </span>
              ) : (
                <span className="t2s-branch">
                  <span className="t2s-mono">{ready.branch}</span>
                  <span className="t2s-dim">{BRANCH_FROM[ready.branchFrom]}, in its worktree</span>
                </span>
              )}
              <span className="t2s-k">Agent</span>
              <span className="seg t2s-agent" role="radiogroup" aria-label="Agent">
                {(["claude", "codex"] as AgentKind[]).map((a) => (
                  <button key={a} role="radio" aria-checked={agent === a} className={agent === a ? "on" : ""} onClick={() => setAgent(a)}>
                    {AGENT_NAME[a]}
                  </button>
                ))}
              </span>
            </div>
            {ready.repoNote && <div className={ready.repos.length ? "t2s-note" : "t2s-err"}>{ready.repoNote}</div>}
            {!blocked && (
              <div className="t2s-dim t2s-what">
                Starts {AGENT_NAME[agent]} in the room's group, briefed on the ticket: its detail, acceptance, blockers and links, given as the House's words — data, not instructions.
              </div>
            )}
          </>
        )}
        {failure && (
          <div className="t2s-err" role="alert">
            {failure.error}
            {failure.stillClaimed && (
              <button className="link" onClick={() => void release()}>
                Release #{n}
              </button>
            )}
          </div>
        )}
        {released && <div className="t2s-note">{released}</div>}
        <div className="t2s-foot">
          {starting && <span className="t2s-dim">{ready?.holder.state === "free" ? `Claiming #${n}, making the worktree, starting ${AGENT_NAME[agent]}…` : `Making the worktree, starting ${AGENT_NAME[agent]}…`}</span>}
          <button className="outline" disabled={starting} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!canStart} onClick={() => void start()}>
            Start {AGENT_NAME[agent]}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
