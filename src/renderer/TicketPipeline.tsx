import { useEffect, useRef, useState } from "react";
import { openLink } from "./uiUtil";
import { GATES, TICKET_STAGES, stageLabel, isErr, isWorkItemId, type PrPreflight, type PrTarget, type SessionInfo, type TicketPipeline, type TicketStage, type IpcResult } from "../shared/types";
import { ago, plural } from "../shared/format";
import { createIpcStore, loadInto } from "./ipcStore";
import { useAction } from "./useAction";
import { baseName } from "../shared/paths";
import { Modal } from "./Modal";


const pipelines = createIpcStore<Record<string, TicketPipeline>>({}, ({ set }) => {
  loadInto("the ticket pipelines", window.mb.pipelineAll(), (r: Record<string, TicketPipeline>) => set(r ?? {}));
  window.mb.onPipelineChanged((r: Record<string, TicketPipeline>) => set(r ?? {}));
});

/** Every ticket's pipeline, kept current. */
export function usePipelines(): Record<string, TicketPipeline> {
  return pipelines.use();
}

/** A ticket's stage as a small chip (board cards, the group bar). */
export function StageChip({ p, onClick }: { p: TicketPipeline | undefined; onClick?: () => void }) {
  if (!p) return null;
  return (
    <button
      className={`chip stage st-${p.stage}`}
      data-tip={onClick ? "Ticket pipeline — where this ticket is, and its next step" : undefined}
      onClick={
        onClick &&
        ((e) => {
          e.stopPropagation();
          onClick();
        })
      }
    >
      {stageLabel(p.stage)}
    </button>
  );
}

/** The lifecycle across the top: done stages ticked, the current one marked; click one to move there. */
function StageRail({ stage, onSet }: { stage: TicketStage | null; onSet: (s: TicketStage) => void }) {
  const at = stage ? TICKET_STAGES.findIndex((s) => s.id === stage) : -1;
  return (
    <div className="pl-rail" role="list">
      {TICKET_STAGES.map((s, i) => (
        <button
          key={s.id}
          role="listitem"
          className={`pl-step ${i < at ? "done" : i === at ? "on" : ""}`}
          aria-current={i === at ? "step" : undefined}
          data-tip={i === at ? `Now: ${s.label}` : `Move the ticket to ${s.label}`}
          onClick={() => i !== at && onSet(s.id)}
        >
          <span className="pl-dot">{i < at ? "✓" : ""}</span>
          <span className="pl-lbl">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

/** One promotion gate's checklist; ticks are kept per ticket. */
function Gate({ p, gate }: { p: TicketPipeline; gate: (typeof GATES)[number] }) {
  const { run, error } = useAction();
  const done = gate.items.filter((it) => p.checks[`${gate.id}:${it.key}`]).length;
  return (
    <div className="pl-gate">
      <div className="pl-h">
        {gate.title}
        <span className="pl-count">
          {done}/{gate.items.length}
        </span>
      </div>
      {gate.items.map((it) => {
        const key = `${gate.id}:${it.key}`;
        return (
          <label key={key} className="check-line pl-check">
            <input type="checkbox" checked={!!p.checks[key]} onChange={(e) => run("check", () => window.mb.pipelineCheck(p.ticketId, key, e.target.checked))} />
            {it.label}
          </label>
        );
      })}
      {error && <div className="fp-note err">{error}</div>}
    </div>
  );
}

export interface PipelineProps {
  ticketId: string;
  title: string;
  /** The ticket's description, for the comms draft (when it's been read). */
  details?: string;
  /** Sessions working on this ticket: pull requests are opened from their worktrees. */
  sessions: SessionInfo[];
  /** Type a request into a session's pane (not sent: the user reviews it there). */
  onAskSession: (sessionId: string, text: string) => void;
  onOpenScm: (sessionId: string) => void;
  /** After a drafted comment posts, so a visible discussion can reload. */
  onPosted?: () => void;
}

/**
 * Pushing the branch and opening its pull request, after showing everything
 * that matters first: commits, uncommitted files, the ticket's docs, an open PR.
 */
function PrForm({ ticketId, title, target, sessions, onAskSession, onOpenScm, onClose }: Omit<PipelineProps, "details" | "onPosted"> & { target: PrTarget; onClose: () => void }) {
  const live = sessions.filter((s) => s.status !== "dead");
  const [sid, setSid] = useState(live[0]?.id ?? "");
  const [pre, setPre] = useState<IpcResult<PrPreflight & { lookupError: string | null }> | null>(null);
  const [base, setBase] = useState("");
  const [prTitle, setPrTitle] = useState(`#${ticketId} ${title}`.trim());
  const [desc, setDesc] = useState("");
  const { doing, run, error } = useAction();
  const [asked, setAsked] = useState("");
  const seq = useRef(0);
  const load = () => {
    if (!sid) return;
    const n = ++seq.current;
    setPre(null);
    window.mb.pipelinePrPreflight(sid, ticketId, target).then(
      (r: IpcResult<PrPreflight & { lookupError: string | null }>) => {
        if (n !== seq.current) return; // a newer check is on its way
        setPre(r);
        // Recheck keeps a base the user picked; a new branch starts from its own default
        if (!isErr(r)) setBase((b) => b || r.base || "");
      },
      (err: unknown) => n === seq.current && setPre({ error: `Couldn't check the branch: ${err instanceof Error ? err.message : err}` })
    );
  };
  useEffect(() => {
    setBase("");
    load();
  }, [sid, target]);
  const ask = (text: string, what: string) => {
    onAskSession(sid, text);
    setAsked(`${what} — typed into the session; press Return there to send it, then Recheck.`);
  };
  if (!live.length) return <div className="fp-note">Open a session on this ticket first: the pull request comes from its branch.</div>;
  const p = pre && !isErr(pre) ? pre : null;
  // a plain terminal has no agent to ask
  const canAsk = !live.find((s) => s.id === sid)?.shell;
  const blockers = p
    ? [
        !p.branch && "The worktree isn't on a branch.",
        !p.remote && "origin isn't on Azure DevOps or GitHub.",
        !base && `origin has no ${target === "dev" ? "dev, develop or uat" : "main or master"} branch to merge into.`,
        p.dirtyFiles > 0 && `${plural(p.dirtyFiles, "uncommitted file")} wouldn't be in the pull request.`,
        p.commits === 0 && base === p.base && `The branch has no commits that ${base} doesn't.`,
        p.existing && base === p.base && "A pull request is already open from this branch.",
      ].filter((x): x is string => !!x)
    : [];
  const write = async () => {
    const r = await run("write", () => window.mb.pipelinePrDescribe(sid, ticketId, title, base));
    if (!isErr(r)) setDesc(r.description);
  };
  const create = async () => {
    const r = await run("create", () => window.mb.pipelinePrCreate(sid, ticketId, { target, base, title: prTitle, description: desc, ticketTitle: title }));
    if (!isErr(r)) onClose();
  };
  const docsPrompt = `Write the ticket documentation for #${ticketId} "${title}" following the team's PR workflow: a folder named ${ticketId}-<branch name> in this repo's documentation home (doc/features/ or wherever the repo keeps feature docs — ask me if it's unclear), holding ${ticketId}-Description.md and ${ticketId}-Security_Considerations.md. Don't commit yet.`;
  return (
    <div className="pl-form">
      <div className="pl-h">
        Pull request to {target === "dev" ? "dev/UAT" : "main"}
        <button className="icon" style={{ marginLeft: "auto" }} onClick={onClose} title="Close">✕</button>
      </div>
      {live.length > 1 && (
        <label className="pl-field">
          From
          <select value={sid} onChange={(e) => setSid(e.target.value)}>
            {live.map((s) => (
              <option key={s.id} value={s.id}>
                {s.ticketTitle ?? s.title} · {s.branch ?? baseName(s.cwd)}
              </option>
            ))}
          </select>
        </label>
      )}
      {pre === null && <div className="fp-note">Checking the branch…</div>}
      {isErr(pre) && <div className="fp-note err">{pre.error}</div>}
      {p && (
        <>
          <div className="pl-facts">
            <div>
              <b>{p.branch ?? "no branch"}</b> →{" "}
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                {!base && <option value="">pick a branch</option>}
                {p.bases.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              {p.remote && <span className="pl-dim"> on {p.remote.provider === "ado" ? "Azure DevOps" : "GitHub"} · {p.remote.repo}</span>}
            </div>
            {base === p.base && <div className={p.commits ? "ok" : "warn"}>{plural(p.commits, "commit")} to merge</div>}
            {p.dirtyFiles > 0 && (
              <div className="warn">
                {plural(p.dirtyFiles, "uncommitted file")}
                <button className="mini" onClick={() => onOpenScm(sid)}>Source Control</button>
                {canAsk && <button className="mini" onClick={() => ask(`Commit the work for #${ticketId} with a clear message.`, "Asked to commit")}>Ask the session to commit</button>}
              </div>
            )}
            {p.docs ? (
              <div className="ok">Ticket docs: {p.docs}</div>
            ) : (
              <div className="warn">
                No {ticketId}-Description.md yet
                {canAsk && <button className="mini" onClick={() => ask(docsPrompt, "Asked for the ticket docs")}>Ask the session to write them</button>}
              </div>
            )}
            {p.existing && base === p.base && (
              <div className="warn">
                Already open: <a onClick={() => openLink(p.existing!.url)}>{p.existing.url}</a>
              </div>
            )}
            {p.lookupError && <div className="warn">Couldn't check for an open pull request: {p.lookupError}</div>}
            <button className="mini" onClick={load}>Recheck</button>
          </div>
          {asked && <div className="fp-note">{asked}</div>}
          <label className="pl-field">
            Title
            <input type="text" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
          </label>
          <label className="pl-field">
            <span>
              Description
              <button className="mini" disabled={doing("write") || !base || !p.commits} onClick={write}>
                {doing("write") ? "Writing…" : "Write it from the branch"}
              </button>
            </span>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} spellCheck={false} style={{ minHeight: 120 }} placeholder="## Summary…" />
          </label>
          {blockers.map((b) => (
            <div key={b} className="fp-note warn">{b}</div>
          ))}
          {error && <div className="fp-note err">{error}</div>}
          <div className="row">
            <span className="pl-dim">Pushes {p.branch ?? "the branch"} to origin, then opens the pull request{p.remote?.provider === "ado" ? ", linked to the work item" : ""}.</span>
            <button className="primary" disabled={doing("create") || blockers.length > 0 || !prTitle.trim()} onClick={create}>
              {doing("create") ? "Opening…" : "Push and open PR"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Drafted comments: edit, post to the ticket's discussion, or discard. Nothing posts without a click. */
function Drafts({ p, onPosted }: { p: TicketPipeline; onPosted?: () => void }) {
  const [text, setText] = useState<Record<string, string>>({});
  const { doing, run, error } = useAction();
  if (!p.drafts.length) return null;
  const canPost = isWorkItemId(p.ticketId);
  return (
    <div className="pl-drafts">
      <div className="pl-h">Drafted comments <span className="pl-count">{p.drafts.length}</span></div>
      {p.drafts.map((d) => {
        const cur = text[d.id] ?? d.text;
        const post = async () => {
          const r = await run(`post:${d.id}`, async () => {
            if (cur !== d.text) {
              const e = await window.mb.pipelineDraftEdit(p.ticketId, d.id, cur);
              if (isErr(e)) return e;
            }
            return window.mb.pipelineDraftPost(p.ticketId, d.id);
          });
          if (!isErr(r)) onPosted?.();
        };
        return (
          <div key={d.id} className="pl-draft">
            <div className="pl-dim">{stageLabel(d.stage)} · {ago(d.at)}</div>
            <textarea
              value={cur}
              onChange={(e) => setText((t) => ({ ...t, [d.id]: e.target.value }))}
              onBlur={() => cur !== d.text && run(`edit:${d.id}`, () => window.mb.pipelineDraftEdit(p.ticketId, d.id, cur))}
              style={{ minHeight: 56 }}
            />
            <div className="row">
              <button className="outline" disabled={doing(`drop:${d.id}`)} onClick={() => run(`drop:${d.id}`, () => window.mb.pipelineDraftDrop(p.ticketId, d.id))}>
                Discard
              </button>
              <button className="primary" disabled={!canPost || doing(`post:${d.id}`) || !cur.trim()} title={canPost ? "Post this comment to the ticket in Azure DevOps" : "Only Azure DevOps work items have a discussion"} onClick={post}>
                {doing(`post:${d.id}`) ? "Posting…" : "Post to ADO"}
              </button>
            </div>
          </div>
        );
      })}
      {error && <div className="fp-note err">{error}</div>}
    </div>
  );
}

/** The announcement for the people who use the system: drafted by an agent, copied or saved as a comment draft. */
function Comms({ p, title, details }: { p: TicketPipeline; title: string; details?: string }) {
  const [text, setText] = useState("");
  const { doing, run, error, setError } = useAction();
  const [copied, setCopied] = useState(false);
  const draft = async () => {
    const r = await run("draft", () => window.mb.pipelineComms(p.ticketId, title, details ?? ""));
    if (!isErr(r)) setText(r.text);
  };
  // the text is cleared only once it's safely saved as a draft
  const save = async () => {
    const r = await run("save", () => window.mb.pipelineDraftAdd(p.ticketId, "comms", text));
    if (!isErr(r)) setText("");
  };
  return (
    <div className="pl-form">
      <div className="pl-h">Comms to users</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What changed, who it affects, anything they need to do." style={{ minHeight: 90 }} />
      {error && <div className="fp-note err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={doing("draft")} onClick={draft}>{doing("draft") ? "Writing…" : "Draft it from the ticket"}</button>
        <button
          className="outline"
          disabled={!text.trim()}
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              (err) => setError(`Couldn't copy: ${err instanceof Error ? err.message : err}`)
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="outline" disabled={!text.trim() || doing("save")} onClick={save}>
          Save as a ticket comment draft
        </button>
      </div>
    </div>
  );
}

/**
 * Where a ticket is in delivery and what comes next: the stage rail, the
 * current stage's step, its promotion-gate checklist, pull requests, feedback
 * and the comments drafted along the way.
 */
export function PipelinePanel(props: PipelineProps) {
  const { ticketId, title, details, sessions, onAskSession, onPosted } = props;
  const p = usePipelines()[ticketId];
  const [prFor, setPrFor] = useState<PrTarget | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sendFeedback, setSendFeedback] = useState(true);
  const { run, error } = useAction();
  const go = (stage: TicketStage) => run("stage", () => window.mb.pipelineStage(ticketId, stage, title));
  const live = sessions.filter((s) => s.status !== "dead");
  const step = (label: string, stage: TicketStage, primary = true) => (
    <button className={primary ? "primary" : "outline"} onClick={() => go(stage)}>{label}</button>
  );
  const prs = p?.prs ?? [];
  return (
    <div className="pl">
      <StageRail stage={p?.stage ?? null} onSet={go} />
      <div className="pl-now">
        {!p ? (
          <>
            <span className="pl-dim">Not tracked yet.</span>
            {step("Start BA", "ba", false)}
            {step("Start coding", "coding")}
          </>
        ) : (
          <>
            <span>
              <b>{stageLabel(p.stage)}</b>
              {p.history.length > 0 && <span className="pl-dim"> · {ago(p.history[p.history.length - 1].at)}</span>}
            </span>
            {p.stage === "ba" && step("Start coding", "coding")}
            {p.stage === "coding" && step("Ready for local testing", "local-test")}
            {p.stage === "local-test" && <button className="primary" onClick={() => setPrFor("dev")}>Create PR to dev…</button>}
            {p.stage === "pr-dev" && step("Deployed — ready for stakeholder testing", "stakeholder")}
            {p.stage === "stakeholder" && (
              <>
                <button className="outline" onClick={() => setFeedback("")}>Record feedback…</button>
                {step("Approved", "approved")}
              </>
            )}
            {p.stage === "approved" && <button className="primary" onClick={() => setPrFor("main")}>Create PR to main…</button>}
            {p.stage === "pr-main" && step("Merged — in staging/prod testing", "prod-test")}
            {p.stage === "prod-test" && step("Write comms", "comms")}
            {p.stage === "comms" && step("Done", "done")}
            {p.stage === "done" && step("Reopen", "local-test", false)}
          </>
        )}
      </div>
      {error && <div className="fp-note err">{error}</div>}
      {feedback !== null && (
        <div className="pl-form">
          <div className="pl-h">Stakeholder feedback</div>
          <textarea autoFocus value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What needs to change" style={{ minHeight: 70 }} />
          {live.length > 0 && (
            <label className="check-line">
              <input type="checkbox" checked={sendFeedback} onChange={(e) => setSendFeedback(e.target.checked)} />
              Also type it into {live[0].ticketTitle ?? live[0].title} to work on
            </label>
          )}
          <div className="row">
            <button className="outline" onClick={() => setFeedback(null)}>Cancel</button>
            <button
              className="primary"
              disabled={!feedback.trim()}
              onClick={async () => {
                const text = feedback.trim();
                const r = await run("feedback", () => window.mb.pipelineFeedback(ticketId, text));
                if (isErr(r)) return;
                if (sendFeedback && live[0]) onAskSession(live[0].id, `Stakeholder feedback on #${ticketId}: ${text}`);
                setFeedback(null);
              }}
            >
              Save — back to local testing
            </button>
          </div>
        </div>
      )}
      {prFor && <PrForm key={prFor} {...props} target={prFor} onClose={() => setPrFor(null)} />}
      {p && GATES.filter((g) => g.at === p.stage).map((g) => <Gate key={g.id} p={p} gate={g} />)}
      {p?.stage === "comms" && <Comms p={p} title={title} details={details} />}
      {prs.length > 0 && (
        <div className="pl-list">
          <div className="pl-h">Pull requests</div>
          {prs.map((r) => (
            <div key={r.url} className="pl-item">
              <a onClick={() => openLink(r.url)}>{r.provider === "ado" ? `PR ${r.id}` : `#${r.id}`}</a>
              <span className="pl-dim">
                {r.branch} → {r.base} · {ago(r.at)}
              </span>
            </div>
          ))}
        </div>
      )}
      {p && p.feedback.length > 0 && (
        <div className="pl-list">
          <div className="pl-h">Feedback</div>
          {p.feedback.map((f) => (
            <div key={f.at} className="pl-item">
              <span className="pl-dim">{ago(f.at)}</span> {f.text}
            </div>
          ))}
        </div>
      )}
      {p && <Drafts p={p} onPosted={onPosted} />}
    </div>
  );
}

/** The pipeline on its own, for tickets reached from the grid rather than the board. */
export function PipelineDialog(props: PipelineProps & { onClose: () => void }) {
  return (
    <Modal className="modal pl-modal" onClose={props.onClose}>
      <h3>
        #{props.ticketId} {props.title}
      </h3>
      <PipelinePanel {...props} />
      <div className="row">
        <button className="outline" onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}
