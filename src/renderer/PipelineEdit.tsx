import { useRef, useState, type ReactNode } from "react";
import type { StageGap } from "./landscapeModel";
import { Modal } from "./Modal";
import { Select, type SelectOption } from "./Menu";
import { AnchoredPopover } from "./Popover";
import { CatalogNote, WholeText, effortOptionsFor, modelOptionsFor, useCatalog } from "./TemplatePicker";
import { modelChipText } from "../shared/pipelineEdit";
import { AGENT_NAME, isErr, type AgentKind, type IpcResult, type ModelChange, type ModelSet, type SessionInfo } from "../shared/types";

/** A step's spec as the Edit dialog holds it: "" for an agent's default model or effort, and no prompt. */
export interface StepSpec {
  title: string;
  agent: AgentKind;
  model: string;
  effort: string;
  prompt: string;
}

/** A session's spec as its Edit dialog opens on it. */
export const specOf = (s: Pick<SessionInfo, "title" | "agent" | "model" | "effort" | "planned">): StepSpec => ({
  title: s.title,
  agent: s.agent ?? "claude",
  model: s.model ?? "",
  effort: s.effort ?? "",
  prompt: s.planned?.prompt ?? "",
});

/**
 * Edit… on a not-started step, and the step an insert makes (its `heading` and `saveLabel` say which): its name, agent,
 * model and effort (the models and efforts its agent offers on this Mac, TemplatePicker's choices), and its prompt,
 * shown whole. Another agent drops the model and effort, as a template's step does. Save waits for main, which checks
 * it all again: what it refuses is said here and the dialog stays.
 */
export function StepEditDialog({ heading, saveLabel, initial, note, onSave, onClose }: { heading: string; saveLabel: string; initial: StepSpec; note?: string | null; onSave: (spec: StepSpec) => Promise<string | null>; onClose: () => void }) {
  const read = useCatalog();
  const [spec, setSpec] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const ok = !!spec.title.trim();
  const save = async () => {
    if (!ok || busy.current) return;
    busy.current = true;
    setSaving(true);
    let why: string | null;
    try {
      why = await onSave({ ...spec, title: spec.title.trim() });
    } catch (err) {
      console.error(`[mockingbird] ${heading}:`, err);
      why = err instanceof Error ? err.message : String(err);
    }
    busy.current = false;
    setSaving(false);
    setErr(why);
  };
  const set = (patch: Partial<StepSpec>) => setSpec((s) => ({ ...s, ...patch }));
  return (
    <Modal
      className="modal se-dlg"
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <h3>{heading}</h3>
      {note && <p className="se-note">{note}</p>}
      <label htmlFor="se-name">Name</label>
      <input id="se-name" type="text" autoFocus aria-label="Its name" value={spec.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void save())} />
      <label>Runs</label>
      <div className="se-runs">
        <Select
          className="tp-agent"
          value={spec.agent}
          title="Its agent"
          options={[
            { value: "claude", label: AGENT_NAME.claude },
            { value: "codex", label: AGENT_NAME.codex },
          ]}
          onChange={(v) => set(v === spec.agent ? {} : { agent: v as AgentKind, model: "", effort: "" })}
        />
        <Select className="tp-model" value={spec.model} placeholder="Default model" title="Its model" options={modelOptionsFor(read.catalog, spec.agent, spec.model)} onChange={(v) => set({ model: v })} />
        <Select className="tp-effort" value={spec.effort} placeholder="Default effort" title="Its effort" options={effortOptionsFor(read.catalog, spec.agent, spec.effort)} onChange={(v) => set({ effort: v })} />
      </div>
      <CatalogNote read={read} />
      <label>Prompt</label>
      <WholeText value={spec.prompt} mono label="Its prompt" placeholder="What it's told as it starts, ahead of what its handoff carries" onChange={(v) => set({ prompt: v })} />
      {err && (
        <div className="se-err" role="alert">
          {err}
        </div>
      )}
      <div className="row">
        <button type="button" className="outline" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" data-act="save" disabled={!ok || saving} aria-busy={saving} onClick={() => void save()}>
          {saving ? "Saving…" : saveLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Where a card's session is, for its model chip: what a change to its model does. */
export type ModelWhere = "running" | "planned" | "closed";

/** What the landscape draws of a pipeline's edits (Landscape's `pipeline`), its owner's (main.tsx). */
export interface PipelineUi {
  /** Session `s`'s model chip, as `where` it is. */
  chip: (s: SessionInfo, where: ModelWhere) => ReactNode;
  /** The + between two stage columns, over handoff `gap.wire`: a step to insert between its ends. */
  insert: (gap: StageGap) => void;
}

/**
 * What the landscape does to wires for what's drawn outside it (Landscape's `wireEditRef`; the Pipeline window's
 * pickers), by its own rules and with its own notes and Undo.
 */
export interface WireEdits {
  /** Wire `id`'s `end` as its From or To picker offers it: the sessions on the landscape, each off saying why the rules wouldn't have it there. */
  endChoices: (id: string, end: "from" | "to") => SelectOption[];
  /** Where a new handoff from session `from` can go, each off saying why not. */
  handoffChoices: (from: string) => SelectOption[];
  /** Wire `id`'s ends moved (wires:repoint), said with Undo; settles with why it didn't move, or null. */
  repoint: (id: string, ends: { from?: string; to?: string }) => Promise<string | null>;
  /** A handoff from `from` to `to` made (wires:add), said with Undo; settles with why it wasn't, or null. */
  addHandoff: (from: string, to: string) => Promise<string | null>;
}

/** A card's model chip ("Sonnet ▾"): its model at a glance, a click opening ModelPopover. */
export function ModelChip({ session, onOpen }: { session: SessionInfo; onOpen: (from: HTMLElement) => void }) {
  const text = modelChipText(session.model);
  return (
    <button
      type="button"
      className="chip ls-model"
      data-model={session.id}
      aria-haspopup="dialog"
      aria-label={`${AGENT_NAME[session.agent ?? "claude"]} ${session.model ? text : "default model"}: change its model`}
      data-tip={session.model ? `${session.model}${session.effort ? ` · ${session.effort} effort` : ""} — change it` : `Its agent's default model${session.effort ? ` · ${session.effort} effort` : ""} — change it`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {text} ▾
    </button>
  );
}

/**
 * A card's model and effort (W-edit), from its model chip: the models its agent offers where sessions start, and its
 * efforts. A not-started step's spec and a closed session's record take a pick at once; an open one restarts in place
 * with it, which keeps its wires, so it asks first with Restart, saying when it's mid-turn.
 */
export function ModelPopover({ session, where, anchor, onApply, onClose }: { session: SessionInfo; where: ModelWhere; anchor: HTMLElement; onApply: (change: ModelChange) => Promise<string | null>; onClose: () => void }) {
  const read = useCatalog();
  const agent = session.agent ?? "claude";
  const [model, setModel] = useState(session.model ?? "");
  const [effort, setEffort] = useState(session.effort ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const going = useRef(false);
  const changed = model !== (session.model ?? "") || effort !== (session.effort ?? "");
  const apply = async (m: string, e: string) => {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    const change: ModelChange = {};
    if (m !== (session.model ?? "")) change.model = m || null;
    if (e !== (session.effort ?? "")) change.effort = e || null;
    const why = await onApply(change);
    going.current = false;
    setBusy(false);
    if (why) setErr(why);
    else onClose();
  };
  const pick = (m: string, e: string) => {
    setModel(m);
    setEffort(e);
    setErr(null);
    if (where !== "running" && (m !== (session.model ?? "") || e !== (session.effort ?? ""))) void apply(m, e);
  };
  const options = modelOptionsFor(read.catalog, agent, session.model);
  return (
    <AnchoredPopover anchor={anchor} className="mp-pop" label={`${session.title}'s model`} onClose={onClose}>
      <div className="mp-head">{AGENT_NAME[agent]} model</div>
      <div className="mp-list" role="radiogroup" aria-label="Its model">
        {options.map((o) => (
          <button key={o.value || "default"} type="button" role="radio" aria-checked={model === o.value} className={`mp-row${model === o.value ? " on" : ""}`} disabled={busy} data-pick={o.value || "default"} title={o.description} onClick={() => pick(o.value, effort)}>
            <span className="mp-name">{o.label}</span>
            {o.group && <span className="mp-group">{o.group}</span>}
          </button>
        ))}
      </div>
      <label className="mp-effort">
        <span>Effort</span>
        <Select value={effort} placeholder="Default effort" title="Its effort" options={effortOptionsFor(read.catalog, agent, session.effort)} onChange={(v) => pick(model, v)} />
      </label>
      <CatalogNote read={read} />
      {where === "running" && (
        <>
          <div className="mp-note">Restarts in place, keeps its wires</div>
          {session.status === "working" && <div className="mp-warn">It's mid-turn: restarting stops the turn it's on</div>}
          {session.status === "waiting" && <div className="mp-warn">It's waiting on you: restarting drops the prompt it's showing</div>}
          <div className="mp-acts">
            <button type="button" className="primary" data-act="restart" disabled={!changed || busy} aria-busy={busy} onClick={() => void apply(model, effort)}>
              {busy ? "Restarting…" : "Restart with it"}
            </button>
          </div>
        </>
      )}
      {where === "closed" && <div className="mp-note">Its Reopen runs it</div>}
      {err && (
        <div className="mp-err" role="alert">
          {err}
        </div>
      )}
    </AnchoredPopover>
  );
}

/** sessions:setModel, said: why it didn't go, or null. */
export async function setModelCall(id: string, change: ModelChange): Promise<{ set: ModelSet } | { error: string }> {
  try {
    const r: IpcResult<ModelSet> = await window.mb.setModel(id, change);
    return isErr(r) ? { error: r.error } : { set: r };
  } catch (err) {
    console.error(`[mockingbird] changing ${id}'s model:`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
