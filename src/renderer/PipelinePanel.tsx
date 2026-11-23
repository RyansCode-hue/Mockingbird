import { useEffect, useRef, useState, type ReactNode } from "react";
import { shownPipeline, type PipelineStage, type ResolvedLayout } from "./landscapeModel";
import { Select } from "./Menu";
import { StatusDot } from "./StatusDot";
import { WholeText } from "./TemplatePicker";
import { useWires } from "./WireLayer";
import { titleOf } from "./appModel";
import { WIRE_TYPE_NAME } from "./wiresModel";
import type { ModelWhere, WireEdits } from "./PipelineEdit";
import { wiresInOrder, type Wire } from "../shared/wires";
import type { SessionInfo } from "../shared/types";

/** Where a pipeline's step is, as its row shows it: running, not started, closed, or a teammate's (no model chip). */
export type StepWhere = ModelWhere | "theirs";

export interface PipelinePanelProps {
  layout: Pick<ResolvedLayout, "tiles" | "ghosts">;
  /** The area it's on; null when nothing is selected in one (a docked window). */
  area: string | null;
  /** What it shows first, by session id: its member (opened from a card), then the selected card. */
  prefer: readonly (string | null | undefined)[];
  /** The sessions selected on the landscape: their rows are marked. */
  selected: ReadonlySet<string>;
  /** The switcher: show the pipeline session `id` is in. */
  onMember: (id: string) => void;
  /** A session's title by id, for a wire's other end. */
  name: (id: string) => string;
  whereOf: (s: SessionInfo) => StepWhere;
  /** Its model chip (ModelChip: a popover that asks before restarting a working one). */
  chip: (s: SessionInfo, where: ModelWhere) => ReactNode;
  /** The landscape's wire edits, while it's up. */
  edits: () => WireEdits | null;
  /** Being started or forgotten now. */
  busy: (id: string) => boolean;
  /** A row clicked: its card selected and brought into view. */
  onReveal: (s: SessionInfo) => void;
  /** A not-started step's prompt saved (steps:edit); settles with why not, or null. */
  onPrompt: (s: SessionInfo, prompt: string) => Promise<string | null>;
  onStart: (s: SessionInfo) => void;
  /** Remove step: forgotten, the steps either side handed off to each other, with Undo. */
  onRemove: (s: SessionInfo) => void;
  /** + Add step, after `after`: the Edit dialog for the step it makes. */
  onAddStep: (after: SessionInfo) => void;
  onSaveTemplate: (stages: PipelineStage[]) => void;
}

const PROMPT_HINT = "What it's told as it starts, ahead of what its handoff carries";

/**
 * A pipeline's window (tool kind "pipeline"): its steps stage by stage, in the order and under the words Tidy and the
 * stage captions use (pipelineStages), each with its status, title and model chip. A row clicked (or Enter on it)
 * selects its card, brings it into view and opens: what it hands off to, each a picker that moves the wire, and a new
 * handoff; its prompt, editable while it hasn't started; Start now; Remove step. ↑ ↓ move along the rows. Its foot adds
 * a step after one of them, and saves the pipeline as a template. An area with several pipelines has a switcher. It
 * reads the wires itself, so it follows every change to them as the landscape does.
 */
export function PipelinePanel(p: PipelinePanelProps) {
  const book = useWires().state?.book ?? null;
  const links = book ? wiresInOrder(book.links) : [];
  const { all, shown } = p.area ? shownPipeline(p.layout, p.area, links.map(([, w]) => w), p.prefer) : { all: [], shown: null };
  const steps = shown?.stages.flatMap((st) => st.steps) ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const at = steps.find((s) => s.id === cursor) ?? steps[0];
  const go = (id: string) => {
    setCursor(id);
    list.current?.querySelector<HTMLElement>(`.pp-row-b[data-row="${CSS.escape(id)}"]`)?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!(e.target as Element).classList.contains("pp-row-b") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter" || e.key === " ") {
      // a row's own: opened or closed as its click does, the landscape seeing nothing of it
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) (e.target as HTMLButtonElement).click();
      return;
    }
    const i = steps.findIndex((s) => s.id === (e.target as HTMLElement).dataset.row);
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? steps.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    const s = steps[Math.max(0, Math.min(steps.length - 1, to))];
    if (s) go(s.id);
  };
  if (!p.area) return <div className="fp-note">Select a workspace in an area: its pipeline shows here.</div>;
  if (!shown) return <div className="fp-note">No wires join this area's workspaces into a pipeline yet.</div>;
  return (
    <div className="pp-panel">
      {all.length > 1 && (
        <div className="pp-switch">
          <Select
            className="pp-pick"
            title="Which of the area's pipelines it shows"
            value={shown.key}
            options={all.map((x) => ({ value: x.tiles[0].key, label: `${titleOf(x.tiles[0].front)} · ${x.tiles.length} cards` }))}
            onChange={(k) => {
              const t = all.find((x) => x.tiles[0].key === k)?.tiles[0];
              if (t) p.onMember(t.front.id);
            }}
          />
        </div>
      )}
      <div className="pp-list" ref={list} role="list" aria-label="Its steps, stage by stage" onKeyDown={onKey}>
        {shown.stages.map((st, i) => (
          <div key={`${i}:${st.word}`} className="pp-stage" role="listitem">
            <div className="pp-stage-h">
              <span className="pp-stage-w">{st.word}</span>
              {st.steps.length > 1 && <span className="pp-stage-n">{st.steps.length}</span>}
            </div>
            <div role="list" aria-label={st.word}>
              {st.steps.map((s) => (
                <StepRow
                  key={s.id}
                  s={s}
                  p={p}
                  outs={links.filter(([, w]) => w.from === s.id && w.type !== "worktree")}
                  open={open === s.id}
                  tab={at?.id === s.id}
                  onToggle={() => {
                    setCursor(s.id);
                    setOpen((o) => (o === s.id ? null : s.id));
                    p.onReveal(s);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <PanelFoot steps={steps} onAdd={p.onAddStep} onSave={() => p.onSaveTemplate(shown.stages)} />
    </div>
  );
}

function StepRow({ s, p, outs, open, tab, onToggle }: { s: SessionInfo; p: PipelinePanelProps; outs: [string, Wire][]; open: boolean; tab: boolean; onToggle: () => void }) {
  const where = p.whereOf(s);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const busy = p.busy(s.id);
  const edits = open ? p.edits() : null;
  const said = (why: string | null) => setErr(why);
  useEffect(() => {
    if (!open) setAsking(false);
  }, [open]);
  return (
    <div className={`pp-row${open ? " open" : ""}${p.selected.has(s.id) ? " sel" : ""}`} role="listitem" data-step={s.id}>
      <div className="pp-row-h">
        <button type="button" className="pp-row-b" data-row={s.id} tabIndex={tab ? 0 : -1} aria-expanded={open} title={where === "planned" ? "Not started" : undefined} onClick={onToggle}>
          {where === "running" || where === "theirs" ? <StatusDot status={s.status} /> : <span className={`dot ${where === "planned" ? "pp-planned" : "dead"}`} />}
          <span className="pp-title" title={titleOf(s)}>{titleOf(s)}</span>
          {where === "planned" && <span className="pp-tag">not started</span>}
          {where === "closed" && <span className="pp-tag">closed</span>}
        </button>
        {where !== "theirs" && p.chip(s, where)}
      </div>
      {open && (
        <div className="pp-more">
          <div className="pp-k">Hands off to</div>
          {outs.map(([id, w]) => (
            <div key={id} className="pp-out" data-wire={id}>
              <Select className="pp-end" title="Where it runs to: pick another to move the wire" value={w.to} options={edits?.endChoices(id, "to") ?? [{ value: w.to, label: p.name(w.to) }]} onChange={(v) => v !== w.to && edits && void edits.repoint(id, { to: v }).then(said)} />
              {w.type !== "handoff" && <span className="pp-type">{WIRE_TYPE_NAME[w.type].toLowerCase()}</span>}
            </div>
          ))}
          {where !== "theirs" && edits && (
            <Select className="pp-end pp-add" title="A new handoff from it" placeholder="+ hand off to…" value="" options={edits.handoffChoices(s.id)} onChange={(v) => v && void edits.addHandoff(s.id, v).then(said)} />
          )}
          {!outs.length && !edits && <div className="pp-dim">Nothing</div>}
          <div className="pp-k">Prompt</div>
          {where === "planned" ? (
            <PromptEdit s={s} onSave={(text) => p.onPrompt(s, text)} />
          ) : (
            <details className="pp-told">
              <summary>What it was started with</summary>
              <div className="pp-dim">{where === "theirs" ? "It's a teammate's: its prompt is on their Mac." : "Not kept once a step starts."}</div>
            </details>
          )}
          {where !== "theirs" && (
            <div className="pp-acts">
              {where === "planned" && (
                <button type="button" className="outline" data-act="start" disabled={busy} title={busy ? "It's being started or forgotten already" : "Start it now, without waiting for its handoff: it says where first"} onClick={() => p.onStart(s)}>
                  Start now
                </button>
              )}
              {asking ? (
                <>
                  <span className="pp-ask">Removing it stops it.</span>
                  <button type="button" className="outline" onClick={() => setAsking(false)}>
                    Cancel
                  </button>
                  <button type="button" className="danger" data-act="remove-sure" onClick={() => p.onRemove(s)}>
                    Stop and remove
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="outline danger"
                  data-act="remove"
                  disabled={busy}
                  title="Let it go, its place and wires too: the steps either side of it hand off to each other, and Undo brings it back"
                  onClick={() => (where === "running" ? setAsking(true) : p.onRemove(s))}
                >
                  {where === "running" ? "Remove step…" : "Remove step"}
                </button>
              )}
            </div>
          )}
          {err && (
            <div className="pp-err" role="alert">
              {err}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A not-started step's prompt, edited in place and saved with Save (or ⌘↵); what main refuses is said under it. */
function PromptEdit({ s, onSave }: { s: SessionInfo; onSave: (text: string) => Promise<string | null> }) {
  const saved = s.planned?.prompt ?? "";
  const [text, setText] = useState(saved);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = text !== saved;
  const was = useRef(saved);
  // what main says changes the field only while nothing typed there is waiting to be saved
  useEffect(() => {
    if (text === was.current) setText(saved);
    was.current = saved;
  }, [saved]);
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    const why = await onSave(text);
    setBusy(false);
    setErr(why);
  };
  return (
    <div
      className="pp-prompt"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <WholeText value={text} mono label="Its prompt" placeholder={PROMPT_HINT} onChange={setText} />
      {dirty && (
        <div className="pp-save">
          <button type="button" className="outline" onClick={() => (setText(saved), setErr(null))}>
            Revert
          </button>
          <button type="button" className="primary" data-act="save-prompt" disabled={busy} aria-busy={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save prompt"}
          </button>
        </div>
      )}
      {err && (
        <div className="pp-err" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}

/** + Add step, asking after which step (the last, to start with), and Save as template. */
function PanelFoot({ steps, onAdd, onSave }: { steps: SessionInfo[]; onAdd: (after: SessionInfo) => void; onSave: () => void }) {
  const [asking, setAsking] = useState(false);
  const [after, setAfter] = useState<string | null>(null);
  const last = steps.at(-1);
  const pick = steps.find((s) => s.id === after) ?? last;
  return (
    <div className="pp-foot">
      {asking && pick ? (
        <div className="pp-where">
          <span className="pp-k">After</span>
          <Select className="pp-after" title="The step it comes after" value={pick.id} options={steps.map((s) => ({ value: s.id, label: titleOf(s) }))} onChange={setAfter} />
          <button type="button" className="outline" onClick={() => setAsking(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            data-act="add-next"
            onClick={() => {
              setAsking(false);
              onAdd(pick);
            }}
          >
            Next…
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="pp-link" data-act="add" disabled={!last} onClick={() => (setAfter(null), setAsking(true))}>
            + Add step
          </button>
          <span className="pp-spacer" />
          <button type="button" className="outline" data-act="save-template" onClick={onSave}>
            Save as template
          </button>
        </>
      )}
    </div>
  );
}
