import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { openLink } from "./uiUtil";
import {
  ADO_DESC_MAX,
  BY_YOU,
  GATES,
  agentNamed,
  clearsGates,
  gateTicks,
  stageLabel,
  stageStep,
  tickOf,
  isErr,
  isWorkItemId,
  prBranchProblem,
  roomPushLine,
  unrecordedBranch,
  type AgentTold,
  type CommentDraft,
  type PipelineRequest,
  type PrPreflight,
  type PrTarget,
  type SessionInfo,
  type StoredStage,
  type TicketPipeline,
  type TicketStage,
  type IpcResult,
} from "../shared/types";
import { agentPatchNotes, askerProblem, gateOfPr, markMergedQuestion, nextSteps, notesStage, prMergeNote, railOf, toldLine } from "./ticketPipelineModel";
import { ago, plural } from "../shared/format";
import { createIpcStore } from "./ipcStore";
import { useAction } from "./useAction";
import { baseName } from "../shared/paths";
import { Modal } from "./Modal";
import { settled } from "./settled";
import { useArrivalGuard } from "./answerGuard";
import { oneLine } from "../shared/team/agentText";


/** Every ticket's pipeline, and why the first read failed (null once a read or a change has come). */
export interface PipelinesRead {
  all: Record<string, TicketPipeline>;
  error: string | null;
}
const pipelines = createIpcStore<PipelinesRead>({ all: {}, error: null }, ({ get, set }) => {
  const failed = (error: string) => {
    console.error(`Couldn't read the ticket pipelines: ${error}`);
    set({ ...get(), error });
  };
  // a refused call and an { error } reply are each said once, by `failed`
  Promise.resolve<IpcResult<Record<string, TicketPipeline>>>(window.mb.pipelineAll()).then(
    (r) => (isErr(r) ? failed(r.error) : set({ all: r ?? {}, error: null })),
    (err: unknown) => failed(err instanceof Error ? err.message : String(err))
  );
  window.mb.onPipelineChanged((r: Record<string, TicketPipeline>) => set({ all: r ?? {}, error: null }));
});
const allPipelines = () => pipelines.get().all;
/** Every ticket's pipeline as the store has it now, for an act checking what it was shown against what's there. */
export const pipelinesNow = (): Record<string, TicketPipeline> => allPipelines();

/** Every ticket's pipeline, kept current. */
export function usePipelines(): Record<string, TicketPipeline> {
  return useSyncExternalStore(pipelines.subscribe, allPipelines);
}

/** The pipelines with their read's failure, for what must tell "no PR" from "couldn't read" (a card's PR badge). */
export function usePipelinesRead(): PipelinesRead {
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

/**
 * The lifecycle across the top: done steps ticked, the current one marked; click one to move there (only a click
 * aimed at it: useArrivalGuard). `clearing` says what a move to a stage would clear, for its tip.
 */
function StageRail({ stage, onSet, clearing }: { stage: StoredStage | null; onSet: (s: TicketStage) => void; clearing: (to: TicketStage) => string | null }) {
  const guard = useArrivalGuard();
  return (
    <div className="pl-rail" role="list">
      {railOf(stage).map((s) => (
        <button
          key={s.stage}
          role="listitem"
          className={`pl-step ${s.state === "todo" ? "" : s.state}`}
          aria-current={s.state === "on" ? "step" : undefined}
          data-tip={[
            s.state === "on" ? `Now: ${s.label}${s.sub ? `, ${s.sub}` : ""}` : null,
            s.moves ? `${s.state === "on" ? "Back to" : "Move the ticket to"} ${s.label}` : null,
            s.moves ? clearing(s.stage) : null,
          ]
            .filter(Boolean)
            .join(". ")}
          onClick={guard(() => s.moves && onSet(s.stage))}
        >
          <span className="pl-dot">{s.state === "done" ? "✓" : ""}</span>
          <span className="pl-lbl">{s.label}</span>
          {s.sub && <span className="pl-sub">{s.sub}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * One promotion gate's checklist; ticks are kept per ticket. An agent's report on an item (gate_notes) shows under it
 * as plain text on one line, after whose it is, so no line of it can pass for the window's own ("Ticked by you"); an
 * agent's tick is said the same way, and the user can untick it.
 */
function Gate({ p, gate }: { p: TicketPipeline; gate: (typeof GATES)[number] }) {
  const { run, error } = useAction();
  // a checkbox changes on its click, or on its label's: a label's click not aimed at it is cancelled before it reaches
  // the box, and the box's own click says whether the change that follows it is the user's
  const guard = useArrivalGuard();
  const aimedNow = useRef(false);
  const done = gate.items.filter((it) => p.checks[`${gate.id}:${it.key}`]).length;
  return (
    <div className="pl-gate" data-gate={gate.id}>
      <div className="pl-h">
        {gate.title}
        <span className="pl-count">
          {done}/{gate.items.length}
        </span>
      </div>
      {gate.items.map((it) => {
        const key = `${gate.id}:${it.key}`;
        const tick = tickOf(p, key);
        const note = p.gateNotes?.[key];
        const agentTick = tick && tick.by !== BY_YOU ? tick.by : null;
        return (
          <Fragment key={key}>
            <label className="check-line pl-check" data-tip={tick ? `Ticked by ${tick.by}, ${ago(tick.at)}` : undefined} onClick={(e) => guard.letGo(e) && e.preventDefault()}>
              <input
                type="checkbox"
                checked={!!p.checks[key]}
                onClick={(e) => {
                  e.stopPropagation();
                  aimedNow.current = !guard.letGo(e);
                }}
                onChange={(e) => aimedNow.current && run("check", () => window.mb.pipelineCheck(p.ticketId, key, e.target.checked))}
              />
              {it.label}
            </label>
            {(note || agentTick) && (
              <div className="pl-gnote" data-note={key}>
                <span className="pl-by">{note ? `${note.by}${agentTick === note.by ? " ticked it" : ""}:` : `Ticked by ${agentTick}`}</span>
                {note && ` ${oneLine(note.note, Infinity)}`}
              </div>
            )}
          </Fragment>
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
  /** An agent's pull request request (Needs you's Open): the PR form opens on it, filled from it. */
  openRequest?: string;
  /** Any session the window knows of, by id: where the one that asked for a PR is now, which may be off this ticket. */
  sessionNamed?: (id: string) => SessionInfo | undefined;
}

/**
 * Pushing the branch and opening its pull request, after showing everything
 * that matters first: commits, uncommitted files, the ticket's docs, an open PR,
 * and the checklist it's opened against.
 *
 * `request`, an agent's request_pr for this target, fills it: its session is the one that asked (main's record), and
 * its title and description are the agent's, as plain text marked as the agent's until changed. Nothing else comes
 * from it: the branch, the repository and what's merged into are read by main from the session's folder, and the push
 * and the pull request are main's, at Push and open PR, never the asking pane's. Opening, filling or dismissing it
 * pushes, opens and posts nothing. When the one that asked can't be the PR's session now (askerProblem: gone, taken
 * over, on another ticket), no session is picked for the user.
 *
 * Its buttons take only a click aimed at them (useArrivalGuard), from its opening and from each branch check's answer.
 */
function PrForm({
  ticketId,
  title,
  target,
  sessions,
  sessionNamed,
  pipeline,
  request,
  onAskSession,
  onOpenScm,
  onDismissed,
  onClose,
}: Omit<PipelineProps, "details" | "onPosted" | "openRequest"> & { target: PrTarget; pipeline: TicketPipeline | undefined; request: PipelineRequest | undefined; onDismissed: (told: AgentTold) => void; onClose: () => void }) {
  // a copy a teammate took over continues on their laptop: nothing is pushed from it here (main refuses it too)
  const live = sessions.filter((s) => s.status !== "dead" && !s.room?.takenOver);
  // the request it opened on stays, so a dismissal or the PR answering it doesn't empty the form under the user
  const [req] = useState(request);
  const askerWhy = req ? askerProblem(req, ticketId, sessionNamed?.(req.from) ?? sessions.find((s) => s.id === req.from)) : null;
  const asker = req && !askerWhy ? live.find((s) => s.id === req.from) : undefined;
  const [sid, setSid] = useState(req ? (asker?.id ?? "") : (live[0]?.id ?? ""));
  const [pre, setPre] = useState<IpcResult<PrPreflight & { lookupError: string | null }> | null>(null);
  const [base, setBase] = useState("");
  const [prTitle, setPrTitle] = useState(req?.title ?? `#${ticketId} ${title}`.trim());
  const [desc, setDesc] = useState(req?.description ?? "");
  const [dismissing, setDismissing] = useState(false);
  const { doing, run, error } = useAction();
  const [asked, setAsked] = useState("");
  // the branch the user said to push though the session wasn't made on it: a say-so for that branch only
  const [sayBranch, setSayBranch] = useState("");
  const guard = useArrivalGuard(pre);
  const by = req ? agentNamed(req.fromTitle) : null;
  /** Whose words a field holds: the agent's while they're as it wrote them. */
  const mark = (now: string, was: string) => by && <span className="pl-by">{now === was ? `written by ${by}` : `changed since ${by} wrote it`}</span>;
  const gate = GATES.find((g) => g.id === gateOfPr(target));
  const seq = useRef(0);
  const load = () => {
    if (!sid) return;
    const n = ++seq.current;
    setPre(null);
    settled<IpcResult<PrPreflight & { lookupError: string | null }>>(window.mb.pipelinePrPreflight(sid, ticketId, target), "Couldn't check the branch").then((r) => {
      if (n !== seq.current) return; // a newer check is on its way
      setPre(r);
      // Recheck keeps a base the user picked; a new branch starts from its own default
      if (!isErr(r)) setBase((b) => b || r.base || "");
    });
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
        p.branch && base && prBranchProblem(p.branch, base),
        p.roomPush && typeof p.roomPush.lfs === "object" && `Nothing would be pushed: ${p.roomPush.lfs.refused}.`,
      ].filter((x): x is string => !!x)
    : [];
  // main says which branch the session was made on only when the worktree is on another (or it has none)
  const branchSay = p?.branch && "recordedBranch" in p ? unrecordedBranch(p.branch, p.recordedBranch ?? null) : null;
  const unsaid = !!branchSay && sayBranch !== p?.branch;
  const hooksLine = p?.roomPush ? roomPushLine(p.roomPush) : null;
  const write = async () => {
    const r = await run("write", () => window.mb.pipelinePrDescribe(sid, ticketId, title, base));
    if (!isErr(r)) setDesc(r.description);
  };
  const create = async () => {
    const r = await run("create", () => window.mb.pipelinePrCreate(sid, ticketId, { target, base, title: prTitle, description: desc, ticketTitle: title, ...(branchSay ? { confirmBranch: sayBranch } : {}) }));
    if (!isErr(r)) onClose();
  };
  const descLines = desc ? desc.split("\n").length : 0;
  const docsPrompt = `Write the ticket documentation for #${ticketId} "${title}" following the team's PR workflow: a folder named ${ticketId}-<branch name> in this repo's documentation home (doc/features/ or wherever the repo keeps feature docs — ask me if it's unclear), holding ${ticketId}-Description.md and ${ticketId}-Security_Considerations.md. Don't commit yet.`;
  return (
    <div className="pl-form pl-prform">
      <div className="pl-h">
        Pull request to {target === "dev" ? "dev/UAT" : "main"}
        <button className="icon" style={{ marginLeft: "auto" }} onClick={guard(onClose)} title="Close">✕</button>
      </div>
      {req && (
        <div className="pl-asked">
          <span className="pl-dim">
            Asked for by {by}, {ago(req.at)}. Nothing is pushed or opened until you press Push and open PR.
          </span>
          {!dismissing && (
            <button className="mini" onClick={guard(() => setDismissing(true))}>
              Dismiss the request…
            </button>
          )}
        </div>
      )}
      {req && dismissing && <RequestDismiss ticketId={ticketId} request={req} onDone={onDismissed} onCancel={() => setDismissing(false)} />}
      {askerWhy && <div className="fp-note warn" data-asker>{askerWhy}</div>}
      {(live.length > 1 || (req && !asker)) && (
        <label className="pl-field">
          From
          <select value={sid} onChange={(e) => setSid(e.target.value)}>
            {!sid && <option value="">pick a session</option>}
            {live.map((s) => (
              <option key={s.id} value={s.id}>
                {s.ticketTitle ?? s.title} · {s.branch ?? baseName(s.cwd)}
              </option>
            ))}
          </select>
        </label>
      )}
      {pre === null && <div className="fp-note">{sid ? "Checking the branch…" : "Pick the session the pull request comes from."}</div>}
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
                <button className="mini" onClick={guard(() => onOpenScm(sid))}>Source Control</button>
                {canAsk && <button className="mini" onClick={guard(() => ask(`Commit the work for #${ticketId} with a clear message.`, "Asked to commit"))}>Ask the session to commit</button>}
              </div>
            )}
            {p.docs ? (
              <div className="ok">Ticket docs: {p.docs}</div>
            ) : (
              <div className="warn">
                No {ticketId}-Description.md yet
                {canAsk && <button className="mini" onClick={guard(() => ask(docsPrompt, "Asked for the ticket docs"))}>Ask the session to write them</button>}
              </div>
            )}
            {p.existing && base === p.base && (
              <div className="warn">
                Already open: <a onClick={guard(() => openLink(p.existing!.url))}>{p.existing.url}</a>
              </div>
            )}
            {p.lookupError && <div className="warn">Couldn't check for an open pull request: {p.lookupError}</div>}
            {hooksLine && (
              <div className={p.roomPush?.skipped ? "warn" : undefined} data-hooks>
                {hooksLine}
              </div>
            )}
            <button className="mini" onClick={guard(load)}>Recheck</button>
          </div>
          {asked && <div className="fp-note">{asked}</div>}
          <label className="pl-field">
            <span>
              Title
              {mark(prTitle, req?.title ?? "")}
              <span className="pl-count" data-len="title">{plural(prTitle.length, "character")}</span>
            </span>
            <input type="text" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
          </label>
          <label className="pl-field">
            <span>
              Description
              <button className="mini" disabled={doing("write") || !base || !p.commits} onClick={guard(write)}>
                {doing("write") ? "Writing…" : "Write it from the branch"}
              </button>
              {mark(desc, req?.description ?? "")}
              <span className="pl-count" data-len="description">
                {plural(descLines, "line")} · {plural(desc.length, "character")}
              </span>
            </span>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} spellCheck={false} rows={Math.min(24, Math.max(6, descLines + 1))} placeholder="## Summary…" />
          </label>
          {p.remote?.provider === "ado" && desc.length > ADO_DESC_MAX && (
            <div className="fp-note warn" data-long>
              Azure DevOps keeps {ADO_DESC_MAX.toLocaleString("en-US")} characters of a description: this one is cut short, at about {(ADO_DESC_MAX - 20).toLocaleString("en-US")}, and ends "(shortened)".
            </div>
          )}
          {pipeline && gate && <Gate p={pipeline} gate={gate} />}
          {blockers.map((b) => (
            <div key={b} className="fp-note warn">{b}</div>
          ))}
          {branchSay && p.branch && (
            <label className="check-line fp-note warn" data-branch-say>
              <input type="checkbox" checked={sayBranch === p.branch} onChange={(e) => setSayBranch(e.target.checked ? p.branch! : "")} />
              {branchSay} Push {p.branch} anyway
            </label>
          )}
          {error && <div className="fp-note err">{error}</div>}
          <div className="row">
            <span className="pl-dim">Pushes {p.branch ?? "the branch"} to origin, then opens the pull request{p.remote?.provider === "ado" ? ", linked to the work item" : ""}.</span>
            <button className="primary" disabled={doing("create") || blockers.length > 0 || unsaid || !prTitle.trim()} onClick={guard(create)}>
              {doing("create") ? "Opening…" : "Push and open PR"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One drafted comment: edited in place (an edit makes it the user's, main drops who drafted it), posted to the ticket's
 * discussion, or discarded. Nothing posts without a click aimed at it (useArrivalGuard, from the row appearing and
 * from each new draft in it). `children` adds buttons before Discard, given the text as it stands; `meta` false leaves
 * out its stage-and-age line, for where a heading says it.
 *
 * Where a newer draft takes the row's place (an agent's rewrite in the Patch notes panel), an unsaved edit stays, not
 * saved over it: the row says the newer one arrived, and the user keeps theirs (saved onto it) or shows it.
 */
function DraftRow({ p, d, onPosted, meta = true, tall = false, children }: { p: TicketPipeline; d: CommentDraft; onPosted?: () => void; meta?: boolean; tall?: boolean; children?: (text: string) => ReactNode }) {
  const [edit, setEdit] = useState<{ on: string; text: string } | null>(null);
  const newer = !!edit && edit.on !== d.id;
  const cur = edit?.text ?? d.text;
  const guard = useArrivalGuard(d.id);
  const { doing, run, error } = useAction();
  const canPost = isWorkItemId(p.ticketId);
  /** Once main has the edit, the row shows the draft as main holds it: what's typed after this goes on as a new edit. */
  const saved = (text: string) => setEdit((e) => (e?.text === text ? null : e));
  const save = async (text: string) => {
    const r = await run("edit", () => window.mb.pipelineDraftEdit(p.ticketId, d.id, text));
    if (!isErr(r)) saved(text);
  };
  const post = async () => {
    const text = cur;
    const r = await run("post", async () => {
      if (text !== d.text) {
        const e = await window.mb.pipelineDraftEdit(p.ticketId, d.id, text);
        if (isErr(e)) return e;
      }
      return window.mb.pipelineDraftPost(p.ticketId, d.id);
    });
    if (isErr(r)) return;
    saved(text);
    onPosted?.();
  };
  return (
    <div className="pl-draft" data-draft={d.id}>
      {meta && (
        <div className="pl-dim">
          {stageLabel(d.stage)} · {ago(d.at)}
          {d.by && (
            <>
              {" "}· <span className="pl-by">drafted by {d.by}</span>
            </>
          )}
        </div>
      )}
      <textarea
        value={cur}
        onChange={(e) => {
          const text = e.target.value;
          setEdit((was) => ({ on: was?.on ?? d.id, text }));
        }}
        onBlur={() => !newer && cur !== d.text && void save(cur)}
        style={{ minHeight: tall ? 90 : 56 }}
      />
      {newer && (
        <div className="fp-note warn" data-newer>
          A newer draft{d.by ? ` by ${d.by}` : ""} arrived while you were editing. Your text is still here, not saved.
          <button className="mini" disabled={doing("edit")} onClick={guard(() => void save(cur))}>
            Keep mine
          </button>
          <button className="mini" onClick={guard(() => setEdit(null))}>
            Show the newer draft
          </button>
        </div>
      )}
      {error && <div className="fp-note err">{error}</div>}
      <div className="row">
        {children?.(cur)}
        <button className="outline" disabled={newer || doing("drop")} onClick={guard(() => void run("drop", () => window.mb.pipelineDraftDrop(p.ticketId, d.id)))}>
          Discard
        </button>
        <button className="primary" disabled={newer || !canPost || doing("post") || !cur.trim()} title={canPost ? "Post this comment to the ticket in Azure DevOps" : "Only Azure DevOps work items have a discussion"} onClick={guard(post)}>
          {doing("post") ? "Posting…" : "Post to ADO"}
        </button>
      </div>
    </div>
  );
}

/** Drafted comments: edit, post to the ticket's discussion, or discard. `exclude` is the one the Patch notes panel shows. */
function Drafts({ p, onPosted, exclude }: { p: TicketPipeline; onPosted?: () => void; exclude?: string }) {
  const list = p.drafts.filter((d) => d.id !== exclude);
  if (!list.length) return null;
  return (
    <div className="pl-drafts">
      <div className="pl-h">
        Drafted comments <span className="pl-count">{list.length}</span>
      </div>
      {list.map((d) => (
        <DraftRow key={d.id} p={p} d={d} onPosted={onPosted} />
      ))}
    </div>
  );
}

/** Copy `text` to the clipboard, saying so, or why it couldn't. */
function CopyButton({ text }: { text: string }) {
  const guard = useArrivalGuard();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setError("");
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      (err) => setError(`Couldn't copy: ${err instanceof Error ? err.message : err}`)
    );
  return (
    <>
      {error && <span className="fp-note err">{error}</span>}
      <button className="outline" disabled={!text.trim()} onClick={guard(copy)}>
        {copied ? "Copied" : "Copy"}
      </button>
    </>
  );
}

/**
 * The patch notes for the people who use the system. With `draft`, an agent's (write_patch_notes), it opens on it,
 * marked as drafted by that agent: copying it, posting it to ADO and Done are the user's. Without one: drafted from
 * the ticket here, copied, or saved as a comment draft.
 */
function PatchNotes({ p, title, details, draft, onPosted }: { p: TicketPipeline; title: string; details?: string; draft: CommentDraft | undefined; onPosted?: () => void }) {
  if (!draft) return <PatchNotesWrite p={p} title={title} details={details} />;
  return (
    <div className="pl-form pl-notes">
      <div className="pl-h">
        Patch notes
        {draft.by && <span className="pl-by">drafted by {draft.by}</span>}
        <span className="pl-dim">· {ago(draft.at)}</span>
      </div>
      {/* one row whichever draft it's on, so the user's unsaved edit outlasts an agent's rewrite */}
      <DraftRow key="notes" p={p} d={draft} onPosted={onPosted} meta={false} tall>
        {(text) => <CopyButton text={text} />}
      </DraftRow>
    </div>
  );
}

function PatchNotesWrite({ p, title, details }: { p: TicketPipeline; title: string; details?: string }) {
  const [text, setText] = useState("");
  const { doing, run, error } = useAction();
  const guard = useArrivalGuard();
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
    <div className="pl-form pl-notes">
      <div className="pl-h">Patch notes</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What changed, who it affects, anything they need to do." style={{ minHeight: 90 }} />
      {error && <div className="fp-note err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={doing("draft")} onClick={guard(draft)}>
          {doing("draft") ? "Writing…" : "Draft it from the ticket"}
        </button>
        <CopyButton text={text} />
        <button className="outline" disabled={!text.trim() || doing("save")} onClick={guard(save)}>
          Save as a ticket comment draft
        </button>
      </div>
    </div>
  );
}

/**
 * Turning an agent's pull request request down (pipeline:request:dismiss): main drops it and tells its agent, with the
 * note. Nothing is pushed or opened.
 */
function RequestDismiss({ ticketId, request, onDone, onCancel }: { ticketId: string; request: PipelineRequest; onDone: (told: AgentTold) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const { doing, run, error } = useAction();
  const who = request.fromTitle || "the workspace that asked";
  const guard = useArrivalGuard();
  const go = async () => {
    const r = await run("dismiss", () => window.mb.pipelineRequestDismiss(ticketId, request.id, note.trim()));
    if (!isErr(r)) onDone(r.told);
  };
  return (
    <div className="pl-form pl-dismiss">
      <div className="pl-h">Dismiss the request for a pull request to {request.target === "dev" ? "dev/UAT" : "main"}</div>
      <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={`A note for ${who}: why, or what to do first (optional)`} style={{ minHeight: 60 }} />
      {error && <div className="fp-note err">{error}</div>}
      <div className="row">
        <span className="pl-dim">Nothing is pushed or opened. {who} is told, with your note.</span>
        <button className="outline" onClick={guard(onCancel)}>
          Cancel
        </button>
        <button className="primary" disabled={doing("dismiss")} onClick={guard(go)}>
          {doing("dismiss") ? "Dismissing…" : "Dismiss the request"}
        </button>
      </div>
    </div>
  );
}

/** Needs you's Dismiss… on an agent's pull request request: the note asked for, then main's answer said by `onDone`. */
export function RequestDismissDialog({ ticketId, requestId, onDone, onClose }: { ticketId: string; requestId: string; onDone: (line: string) => void; onClose: () => void }) {
  const now = usePipelines()[ticketId]?.requests?.find((r) => r.id === requestId);
  // the request it opened on, kept while main drops it: the dialog isn't emptied under the user as it goes
  const seen = useRef(now);
  seen.current = now ?? seen.current;
  const request = seen.current;
  const guard = useArrivalGuard();
  return (
    <Modal className="modal pl-modal pl-dismiss-dlg" onClose={onClose}>
      <h3>#{ticketId}: a pull request asked for</h3>
      <div className="pl">
        {request ? (
          <RequestDismiss
            ticketId={ticketId}
            request={request}
            onDone={(told) => {
              onDone(`Request dismissed. ${toldLine(told)}`);
              onClose();
            }}
            onCancel={onClose}
          />
        ) : (
          <div className="fp-note">That request has gone: it was answered, replaced or dismissed.</div>
        )}
      </div>
      {!request && (
        <div className="row">
          <button className="outline" onClick={guard(onClose)}>
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}

/**
 * Where a ticket is in delivery and what comes next: the stage rail, the
 * current stage's step, its promotion-gate checklist, agents' pull request
 * requests, pull requests, feedback and the comments drafted along the way.
 * `openRequest` opens it on an agent's request, its PR form filled from it.
 */
export function PipelinePanel(props: PipelineProps) {
  const { ticketId, title, details, sessions, onAskSession, onPosted, openRequest } = props;
  const p = usePipelines()[ticketId];
  const [prFor, setPrFor] = useState<PrTarget | null>(() => p?.requests?.find((r) => r.id === openRequest)?.target ?? null);
  // what the user's last word did: whom an approval or a dismissal told, or that the request asked for has gone
  const [said, setSaid] = useState<string | null>(() => (openRequest && !p?.requests?.some((r) => r.id === openRequest) ? "That request has gone: it was answered, replaced or dismissed." : null));
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sendFeedback, setSendFeedback] = useState(true);
  const { run, doing, error } = useAction();
  // its buttons take only a click aimed at them, from its opening and from each stage the ticket moves to
  const guard = useArrivalGuard(p?.stage);
  const go = (stage: TicketStage) => run("stage", () => window.mb.pipelineStage(ticketId, stage, title));
  const approve = async () => {
    const r = await run("approve", () => window.mb.pipelineApprove(ticketId));
    if (!isErr(r)) setSaid(`Approved. ${toldLine(r.told)}`);
  };
  const live = sessions.filter((s) => s.status !== "dead");
  const prs = p?.prs ?? [];
  const requests = p?.requests ?? [];
  const last = p?.history?.at(-1);
  const ticks = p ? gateTicks(p) : 0;
  /** What going to `to` would clear: back at Coding, the gates' ticks. */
  const clearing = (to: TicketStage) => (p && ticks && clearsGates(p.stage, to) ? `Clears the gates' ${plural(ticks, "tick")}` : null);
  // the patch notes draft the panel is on: the agent's, and still that one once the user's edit makes it theirs
  const notesOn = useRef<string | null>(null);
  const notes = p && notesStage(p.stage) ? (p.drafts.find((d) => d.id === notesOn.current) ?? agentPatchNotes(p)) : undefined;
  notesOn.current = notes?.id ?? null;
  // the open PR form draws its target's checklist, which the stage's place then leaves out
  const formGate = prFor ? gateOfPr(prFor) : null;
  return (
    <div className="pl">
      <StageRail stage={p?.stage ?? null} onSet={go} clearing={clearing} />
      <div className="pl-now">
        {!p ? (
          <span className="pl-dim">Not tracked yet.</span>
        ) : (
          <span>
            <b>{stageLabel(p.stage)}</b>
            {last && (
              <span className="pl-dim" data-tip={[last.by && `Moved here by ${last.by}`, last.note].filter(Boolean).join(". ") || undefined}>
                {" "}· {ago(last.at)}
              </span>
            )}
            {stageStep(p.stage) === null && <span className="pl-dim"> · a stage this version of Mockingbird doesn't know</span>}
          </span>
        )}
        {nextSteps(p?.stage ?? null).map((n) =>
          n.kind === "stage" ? (
            <button key={n.label} className={n.primary ? "primary" : "outline"} data-tip={clearing(n.to) ?? undefined} onClick={guard(() => void go(n.to))}>{n.label}</button>
          ) : n.kind === "pr" ? (
            <button key={n.label} className="primary" onClick={guard(() => setPrFor(n.target))}>{n.label}</button>
          ) : n.kind === "approve" ? (
            <button key={n.label} className="primary" data-tip="Approved in stakeholder testing: the agent that asked for the PR to dev is told to prepare the one to main" disabled={doing("approve")} onClick={guard(approve)}>
              {n.label}
            </button>
          ) : (
            <button key={n.label} className="outline" onClick={guard(() => setFeedback(""))}>{n.label}</button>
          )
        )}
      </div>
      {error && <div className="fp-note err">{error}</div>}
      {said && <div className="fp-note pl-said">{said}</div>}
      {requests.length > 0 && (
        <div className="pl-list">
          <div className="pl-h">Pull requests asked for</div>
          {requests.map((r) => (
            <div key={r.id} className="pl-item" data-request={r.id}>
              <span className="pl-by">{agentNamed(r.fromTitle)}</span>
              <span className="pl-dim">
                to {r.target === "dev" ? "dev/UAT" : "main"} · {ago(r.at)}
              </span>
              {prFor !== r.target && <a onClick={guard(() => setPrFor(r.target))}>Open the form</a>}
            </div>
          ))}
        </div>
      )}
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
            {clearing("coding") && <span className="pl-dim">{clearing("coding")}, taken before the changes</span>}
            <button className="outline" onClick={guard(() => setFeedback(null))}>Cancel</button>
            <button
              className="primary"
              disabled={!feedback.trim()}
              onClick={guard(async () => {
                const text = feedback.trim();
                const r = await run("feedback", () => window.mb.pipelineFeedback(ticketId, text));
                if (isErr(r)) return;
                if (sendFeedback && live[0]) onAskSession(live[0].id, `Stakeholder feedback on #${ticketId}: ${text}`);
                setFeedback(null);
              })}
            >
              Save — back to coding
            </button>
          </div>
        </div>
      )}
      {prFor && (
        <PrForm
          key={prFor}
          {...props}
          target={prFor}
          pipeline={p}
          request={requests.find((r) => r.target === prFor)}
          onDismissed={(told) => {
            setPrFor(null);
            setSaid(`Request dismissed. ${toldLine(told)}`);
          }}
          onClose={() => setPrFor(null)}
        />
      )}
      {p && GATES.filter((g) => g.at === p.stage && g.id !== formGate).map((g) => <Gate key={g.id} p={p} gate={g} />)}
      {p && (p.stage === "comms" || notes) && <PatchNotes p={p} title={title} details={details} draft={notes} onPosted={onPosted} />}
      {prs.length > 0 && (
        <div className="pl-list">
          <div className="pl-h">Pull requests</div>
          {prs.map((r) => {
            const merge = prMergeNote(r);
            return (
              <div key={r.url} className="pl-item">
                <a onClick={guard(() => openLink(r.url))}>{r.provider === "ado" ? `PR ${r.id}` : `#${r.id}`}</a>
                <span className="pl-dim">
                  {r.branch} → {r.base} · {ago(r.at)}
                  {merge && !merge.problem && ` · ${merge.text}`}
                </span>
                {merge?.problem && <span className="pl-warn">{merge.text}</span>}
                {!r.mergedAt && (
                  <a data-tip="Ask its provider now whether it has merged" onClick={guard(() => void run("check", () => window.mb.pipelinePrCheck(ticketId, r.url)))}>
                    Check now
                  </a>
                )}
                {merge?.problem && (
                  <a
                    data-tip="Say it merged, when Mockingbird can't tell: the ticket and its wires go on as for a merge"
                    onClick={guard(() => {
                      if (window.confirm(markMergedQuestion(r))) void run("mark merged", () => window.mb.pipelinePrMarkMerged(ticketId, r.url));
                    })}
                  >
                    Mark merged…
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
      {p && p.feedback.length > 0 && (
        <div className="pl-list">
          <div className="pl-h">Feedback</div>
          {p.feedback.map((f) => (
            <div key={f.at} className="pl-item">
              <span className="pl-dim">
                {ago(f.at)}
                {f.by ? ` · by ${f.by}` : ""}
              </span>{" "}
              {f.text}
            </div>
          ))}
        </div>
      )}
      {p && <Drafts p={p} onPosted={onPosted} exclude={notes?.id} />}
    </div>
  );
}

/** The pipeline on its own, for tickets reached from an area's header or ⌘K rather than the board. */
export function PipelineDialog(props: PipelineProps & { onClose: () => void }) {
  const guard = useArrivalGuard();
  return (
    <Modal className="modal pl-modal" onClose={props.onClose}>
      <h3>
        #{props.ticketId} {props.title}
      </h3>
      <PipelinePanel {...props} />
      <div className="row">
        <button className="outline" onClick={guard(props.onClose)}>Close</button>
      </div>
    </Modal>
  );
}
