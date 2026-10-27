import React, { useEffect, useMemo, useRef, useState } from "react";
import { isErr, type CollabRoom, type IpcResult } from "../shared/types";
import {
  blankDraft,
  createLabel,
  draftProblems,
  mergeDrafts,
  moveDraft,
  parseTags,
  removeDrafts,
  targetKey,
  targetRef,
  updateDraft,
  type CouncilCreateResult,
  type CouncilHouseTarget,
  type CouncilHouseTargets,
  type TicketDraft,
} from "../shared/collabTickets";
import { HOUSE_PRIORITIES, HOUSE_TOKEN_HOW } from "../shared/team/house";
import { Modal } from "./Modal";
import { MenuButton, Pick } from "./Menu";
import { useAction } from "./useAction";

const SPLIT_NOTE: Record<string, string> = {
  checklist: "Split by the plan's checklist — no model was used.",
  steps: "Split by the plan's numbered steps — no model was used.",
  sections: "Split by the plan's step sections — no model was used.",
  manual: "Written by hand.",
};

const targetLabel = (t: CouncilHouseTarget) => (t.kind === "room" ? `${t.project ?? "no project yet"} · room ${t.room}` : t.project);

/**
 * "Create House tickets…" on an approved plan: the drafts as a list (select
 * two or more to merge them) beside the chosen draft's fields, then where
 * they go and one button that says exactly what it creates. Nothing reaches
 * the House before that click; the drafts are kept with the council as they
 * are edited, so closing loses nothing.
 */
export function CouncilTicketsDialog({ room, onClose }: { room: CollabRoom; onClose: () => void }) {
  const { busy, doing, run, error } = useAction();
  const [drafts, setDrafts] = useState<TicketDraft[] | null>(room.ticketDrafts?.drafts ?? null);
  const [how, setHow] = useState<string | null>(room.ticketDrafts ? (room.ticketDrafts.how === "model" ? `Split by ${room.ticketDrafts.by ?? "a model"}.` : SPLIT_NOTE[room.ticketDrafts.how]) : null);
  const [nothing, setNothing] = useState(false); // the plan has nothing to split by
  const [current, setCurrent] = useState<string | null>(drafts?.[0]?.id ?? null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [targets, setTargets] = useState<CouncilHouseTargets | null>(null);
  const [targetErr, setTargetErr] = useState("");
  const [target, setTarget] = useState<string>("");
  const [track, setTrack] = useState(true);
  const [askModel, setAskModel] = useState<{ key: string; label: string } | null>(null);
  const [result, setResult] = useState<CouncilCreateResult | null>(null);
  const [tagText, setTagText] = useState<Record<string, string>>({});
  const seated = room.participants.filter((p) => !p.removed);

  const adopt = (r: CollabRoom) => {
    const d = r.ticketDrafts;
    setDrafts(d?.drafts ?? null);
    setHow(d ? (d.how === "model" ? `Split by ${d.by ?? "a model"}.` : SPLIT_NOTE[d.how]) : null);
    setCurrent(d?.drafts[0]?.id ?? null);
    setPicked(new Set());
    setTagText({});
  };

  useEffect(() => {
    if (!drafts)
      void run("split", (): Promise<IpcResult<{ room: CollabRoom; found: boolean }>> => window.mb.collabTicketDrafts(room.id)).then((r) => {
        if (isErr(r)) return;
        setNothing(!r.found);
        if (r.found) adopt(r.room);
      });
    loadTargets();
    // the room's id is all that picks what to load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  const loadTargets = () =>
    window.mb.collabTicketTargets(room.id).then((r: IpcResult<CouncilHouseTargets>) => {
      if (isErr(r)) return setTargetErr(r.error);
      setTargetErr("");
      setTargets(r);
      setTarget((t) => (r.targets.some((x) => targetKey(x) === t) ? t : r.targets[0] ? targetKey(r.targets[0]) : ""));
    });

  // the drafts are kept with the council a moment after each edit, and when the dialog closes
  const pending = useRef<TicketDraft[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const flush = () => {
    clearTimeout(timer.current);
    const d = pending.current;
    pending.current = null;
    if (d) void run("save", () => window.mb.collabSaveTicketDrafts(room.id, d));
  };
  const edit = (next: TicketDraft[]) => {
    setDrafts(next);
    setResult(null);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    flush();
    onClose();
  };

  const problems = useMemo(() => draftProblems(drafts ?? []), [drafts]);
  const chosen = targets?.targets.find((t) => targetKey(t) === target) ?? null;
  const project = chosen?.kind === "room" ? chosen.project : chosen?.project ?? null;
  const d = drafts?.find((x) => x.id === current) ?? null;
  const set = (patch: Partial<TicketDraft>) => d && drafts && edit(updateDraft(drafts, d.id, patch));
  const togglePick = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const splitWith = (key: string) => {
    setAskModel(null);
    void run("model", (): Promise<IpcResult<CollabRoom>> => window.mb.collabSplitWithModel(room.id, key)).then((r) => {
      if (isErr(r)) return;
      setNothing(false);
      adopt(r);
    });
  };
  const startOver = () =>
    void run("split", async (): Promise<IpcResult<{ room: CollabRoom; found: boolean }>> => {
      clearTimeout(timer.current);
      pending.current = null;
      const cleared = await window.mb.collabSaveTicketDrafts(room.id, null);
      return isErr(cleared) ? cleared : window.mb.collabTicketDrafts(room.id);
    }).then((r) => {
      if (isErr(r)) return;
      setNothing(!r.found);
      adopt(r.room);
    });
  const whole = () =>
    void run("whole", (): Promise<IpcResult<CollabRoom>> => window.mb.collabWholePlanTicket(room.id)).then((r) => {
      if (isErr(r)) return;
      setNothing(false);
      adopt(r);
    });
  const consent = (allow: boolean) =>
    chosen &&
    void run("consent", (): Promise<IpcResult<CouncilHouseTargets>> => window.mb.collabTicketConsent(room.id, targetRef(chosen), allow)).then((r) => {
      if (!isErr(r)) setTargets(r);
    });
  const create = () => {
    if (!chosen || !drafts) return;
    clearTimeout(timer.current);
    pending.current = null;
    void run("create", (): Promise<IpcResult<{ room: CollabRoom; result: CouncilCreateResult }>> => window.mb.collabCreateTickets(room.id, targetRef(chosen), drafts, track)).then((r) => {
      if (isErr(r)) return;
      setResult(r.result);
      const left = r.room.ticketDrafts?.drafts ?? [];
      setDrafts(left);
      setCurrent(left[0]?.id ?? null);
      setPicked(new Set());
    });
  };

  const ready = !!drafts?.length && problems.size === 0 && chosen?.connection === "connected" && !!project && !busy;
  const why = !drafts?.length
    ? "There are no tickets to create"
    : problems.size
      ? `Ticket ${drafts.findIndex((x) => problems.has(x.id)) + 1} ${problems.values().next().value}`
      : !chosen
        ? "Choose where the tickets go"
        : !project
          ? "The room has no House project yet"
          : chosen.connection !== "connected"
            ? `Allow your ${project} builder token first`
            : undefined;

  return (
    <Modal className="modal council-tix" onClose={close} closeOnBackdrop={false}>
      <h3>Create House tickets from the plan</h3>
      <div className="sub-h">
        {how ? `${how} ` : ""}
        {drafts ? "Pick a ticket to edit it; select two or more to merge them. Nothing is sent until you create them." : nothing ? "" : "Splitting the plan…"}
      </div>

      {nothing && !drafts?.length && (
        <div className="council-tix-empty">
          <p>The plan has no checklist, numbered steps or step sections to split it by.</p>
          {askModel ? (
            <ModelAsk label={askModel.label} onYes={() => splitWith(askModel.key)} onNo={() => setAskModel(null)} />
          ) : (
            <div className="ins-actions">
              <MenuButton label={doing("model") ? "Splitting…" : "Split it with a model ▾"} disabled={!!busy} items={seated.map((p) => ({ key: p.key, label: p.label, onPick: () => setAskModel({ key: p.key, label: p.label }) }))} />
              <button className="outline" disabled={!!busy} onClick={whole}>One ticket for the whole plan</button>
            </div>
          )}
        </div>
      )}

      {drafts && (drafts.length > 0 || !result) && (
        <div className="council-tix-split">
          <div className="council-tix-list">
            <div className="council-tix-tools">
              <button className="outline" disabled={picked.size < 2} onClick={() => drafts && (edit(mergeDrafts(drafts, picked, room.title)), setPicked(new Set()))} title="Merge the selected tickets into the first of them">
                {picked.size >= 2 ? `Merge ${picked.size} selected` : "Merge selected"}
              </button>
              <button
                className="outline"
                disabled={!picked.size && !d}
                onClick={() => {
                  const gone = picked.size ? picked : new Set(d ? [d.id] : []);
                  const next = removeDrafts(drafts, gone);
                  edit(next);
                  setPicked(new Set());
                  if (current && gone.has(current)) setCurrent(next[0]?.id ?? null);
                }}
              >
                {picked.size > 1 ? `Remove ${picked.size}` : "Remove"}
              </button>
              <span className="spacer" />
              <button className="icon" disabled={!d || drafts[0]?.id === d.id} title="Earlier" aria-label="Move up" onClick={() => d && edit(moveDraft(drafts, d.id, -1))}>↑</button>
              <button className="icon" disabled={!d || drafts.at(-1)?.id === d.id} title="Later" aria-label="Move down" onClick={() => d && edit(moveDraft(drafts, d.id, 1))}>↓</button>
              <MenuButton
                label="⋯"
                className="icon"
                title="Split the plan again"
                disabled={!!busy}
                items={[
                  { key: "plan", label: "Split again from the plan (no model)", onPick: startOver },
                  ...seated.map((p) => ({ key: p.key, label: `Split it with ${p.label}…`, onPick: () => setAskModel({ key: p.key, label: p.label }) })),
                ]}
              />
            </div>
            {askModel && <ModelAsk label={askModel.label} onYes={() => splitWith(askModel.key)} onNo={() => setAskModel(null)} replaces />}
            {drafts.map((x, i) => (
              <div key={x.id} className={`council-tix-row ${x.id === current ? "on" : ""}`} data-id={x.id} onClick={() => setCurrent(x.id)}>
                <input type="checkbox" aria-label={`Select ${x.title || `ticket ${i + 1}`}`} checked={picked.has(x.id)} onClick={(e) => e.stopPropagation()} onChange={() => togglePick(x.id)} />
                <span className="n">{i + 1}</span>
                <span className="body">
                  <span className="t">{x.title || <em>untitled</em>}</span>
                  <span className="meta">
                    <span className={`council-tix-pri ${x.priority}`}>{x.priority}</span>
                    {x.tags.map((t) => (
                      <span key={t} className="chip tag">{t}</span>
                    ))}
                    {problems.has(x.id) ? <span className="council-tix-warn bad">{problems.get(x.id)}</span> : !x.acceptance.trim() && <span className="council-tix-warn">no acceptance criteria</span>}
                  </span>
                </span>
              </div>
            ))}
            <button
              className="link council-tix-add"
              onClick={() => {
                const b = blankDraft(room.title);
                edit([...drafts, b]);
                setCurrent(b.id);
              }}
            >
              + Add a ticket
            </button>
          </div>
          <div className="council-tix-edit">
            {d ? (
              <>
                <label htmlFor="ctx-title">Title</label>
                <input id="ctx-title" type="text" value={d.title} maxLength={240} onChange={(e) => set({ title: e.target.value })} />
                <div className="council-tix-two">
                  <div>
                    <label>Priority</label>
                    <Pick value={d.priority} onChange={(e) => set({ priority: e.target.value as TicketDraft["priority"] })}>
                      {HOUSE_PRIORITIES.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </Pick>
                  </div>
                  <div>
                    <label htmlFor="ctx-tags">Tags</label>
                    <input
                      id="ctx-tags"
                      type="text"
                      placeholder="needs-agent, frontend"
                      value={tagText[d.id] ?? d.tags.join(", ")}
                      onChange={(e) => {
                        setTagText((t) => ({ ...t, [d.id]: e.target.value }));
                        set({ tags: parseTags(e.target.value) });
                      }}
                    />
                  </div>
                </div>
                <label htmlFor="ctx-detail">Detail</label>
                <textarea id="ctx-detail" className="council-tix-detail" value={d.detail} onChange={(e) => set({ detail: e.target.value })} />
                <label htmlFor="ctx-acc">Acceptance criteria</label>
                <textarea id="ctx-acc" className="council-tix-acc" placeholder="- What a reviewer checks" value={d.acceptance} onChange={(e) => set({ acceptance: e.target.value })} />
              </>
            ) : (
              <div className="ins-note">{drafts.length ? "Pick a ticket to edit it." : "No tickets left."}</div>
            )}
          </div>
        </div>
      )}

      {result && <ResultNote room={room} result={result} />}

      <div className="council-tix-target">
        <span className="council-tix-l">Project</span>
        {targets && targets.targets.length > 0 ? (
          <Pick value={target} onChange={(e) => setTarget(e.target.value)} title={targets.inRoom ? "The council's repository is in a team room: its tickets go in the room's project" : "A project you have a builder token for"}>
            {targets.targets.map((t) => (
              <option key={targetKey(t)} value={targetKey(t)}>{targetLabel(t)}</option>
            ))}
          </Pick>
        ) : (
          <span className="ins-note">{targetErr ? "" : targets ? `No House project on this Mac. ${HOUSE_TOKEN_HOW} Save it as ~/.config/radley-house/<project>.env.` : "Reading…"}</span>
        )}
        {chosen?.kind === "room" && (
          <label className="council-tix-check">
            <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} /> Add them to the room's board
          </label>
        )}
      </div>
      {targetErr && <div className="fp-note err">Where the tickets can go couldn't be read: {targetErr}</div>}
      {chosen && chosen.kind === "room" && !chosen.project && (
        <div className="fp-note warn">The room's admin{chosen.admin ? ` (${chosen.admin})` : ""} hasn't chosen its House project yet — on the room's board.</div>
      )}
      {chosen && project && chosen.connection !== "connected" && (
        <div className="council-tix-consent" role="group" aria-label="Allow your builder token">
          <span>
            Use your {project} builder token {chosen.kind === "room" ? `for room ${chosen.room}` : "from the Council"}?{chosen.connection === "declined" ? " (You chose Not now.)" : ""}
          </span>
          <button className="outline strong" disabled={!!busy} onClick={() => consent(true)}>Allow</button>
          {chosen.connection === "consent" && <button className="outline" disabled={!!busy} onClick={() => consent(false)}>Not now</button>}
        </div>
      )}
      {error && <div className="fp-note err" role="alert">{error}</div>}
      <div className="row">
        <span className="foot-hint ins-note">Created with your own builder token. Nothing is sent until you click.</span>
        <button className="outline" onClick={close}>{result && !drafts?.length ? "Done" : "Cancel"}</button>
        <button className="primary council-tix-create" disabled={!ready} data-tip={why} onClick={create}>
          {doing("create") ? "Creating…" : drafts?.length ? createLabel(drafts.length, project) : "Create tickets"}
        </button>
      </div>
    </Modal>
  );
}

/** Splitting with a model sends it the plan: asked first, every time. */
function ModelAsk({ label, onYes, onNo, replaces }: { label: string; onYes: () => void; onNo: () => void; replaces?: boolean }) {
  return (
    <div className="council-tix-ask" role="group" aria-label="Send the plan to a model">
      <span>
        Send the approved plan to {label} to split it into tickets? It's one turn on your plan's limits, with no access to the code; nothing goes to the House.
        {replaces ? " Its tickets replace these drafts." : ""}
      </span>
      <button className="outline strong" onClick={onYes}>Send the plan</button>
      <button className="outline" onClick={onNo}>Cancel</button>
    </div>
  );
}

/** What the click created, and what it didn't. */
function ResultNote({ room, result }: { room: CollabRoom; result: CouncilCreateResult }) {
  const { run, error } = useAction();
  return (
    <div className="council-tix-result" role="status">
      {result.created.length > 0 && (
        <div>
          Created in {result.project}
          {result.room ? ` (room ${result.room})` : ""}:{" "}
          {result.created.map((c, i) => (
            <React.Fragment key={c.n}>
              {i > 0 && " · "}
              <button className="link" title={`Open #${c.n} in the House`} onClick={() => void run("open", () => window.mb.collabOpenTicket(room.id, c.n))}>
                #{c.n} {c.title}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      {result.created.filter((c) => c.tagsProblem).map((c) => (
        <div key={c.n} className="fp-note warn">#{c.n}'s tags couldn't be set: {c.tagsProblem}</div>
      ))}
      {result.failed && (
        <div className="fp-note err">
          "{result.failed.title}" wasn't created: {result.failed.error}
          {result.notSent.length ? ` — and ${result.notSent.length} after it weren't sent. They're still here to try again.` : " It's still here to try again."}
        </div>
      )}
      {error && <div className="fp-note err">{error}</div>}
    </div>
  );
}
