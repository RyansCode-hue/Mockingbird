import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Pick, Select, type SelectOption } from "./Menu";
import { RepoPick } from "./RepoPick";
import { ticketsByColumn, useAdoTickets, useRepoBranches } from "./tickets";
import { ANSWER_SETTLE_MS, useHeldOff, useOpenSettle } from "./answerGuard";
import { baseName } from "../shared/paths";
import { isErr, AGENT_NAME, type ModelCatalog } from "../shared/types";
import { carriesWork, templateOf, WIRE_WHENS, type WireGate, type WireWhen } from "../shared/wires";
import {
  asShown,
  flowOf,
  automaticGates,
  BUILT_IN_TEMPLATE,
  layOutPlan,
  startsAtOrchestrator,
  ticketLine,
  ROOM_ASKS,
  type LayOutPlan,
  type LayOutRequest,
  type TemplateBody,
  type TemplateDraft,
  type TemplateList,
  type TemplateStep,
  type TemplateWire,
} from "../shared/pipelineTemplates";
import { checkPlan, ME, PLAN_MAX, planFlags, provenanceOf, type Plan, type PlanLayOut, type PlanShownAt, type PlanStep, type PlanView, type PlanWire } from "../shared/plans";
import { agoShort } from "../shared/format";

/**
 * The template picker (docs/landscape-wires.md, W9; section 5's WireTemplates.dc.html A) and Save as template's dialog,
 * which shows a chain the same way. Everything a template does is on screen before Lay out, and what's laid out or
 * saved is exactly that (asShown): each step's agent, model, effort and prompt whole (editable), its folder, what each
 * wire into it carries (its What flows whole and editable, and its files), an automatic gate called out with Make it
 * ask, a terminal's command flagged as one, and where it all goes in the foot.
 *
 * Lay out is one deliberate act: it takes no click for ANSWER_SETTLE_MS after the dialog opens or after the template
 * shown changes, never a double click's second, no key of a burst begun before the dialog opened, and no held ⌘↵ (the
 * dialog guard, useOpenSettle); it runs once until main answers. As the dialog closes, the keyboard never goes to a
 * terminal: the landscape (`home`) gets it.
 */

/** Never back to a terminal: what had the keyboard as a dialog here opened may have been one, and it's out of sight now. */
const notToTerminal =
  (home: () => HTMLElement | null) =>
  (to: HTMLElement): boolean => {
    if (!to.closest(".xterm")) return true;
    home()?.focus({ preventScroll: true });
    return false;
  };

// ---- the chain drawn small ---------------------------------------------------------------------

const BOX_H = 38;
const TERM_H = 24;
const COL_GAP = 24;
const ROW_GAP = 16;

export interface SketchBox {
  key: string;
  name: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  terminal: boolean;
}
export interface SketchPath {
  d: string;
  kind: "handoff" | "feedback" | "context" | "worktree";
  chip: { x: number; y: number; text: string; tone: "amber" | "plain" } | null;
}
export interface Sketch {
  w: number;
  h: number;
  boxes: SketchBox[];
  paths: SketchPath[];
}

/**
 * Template `b` drawn small, `width` wide (WireTemplates.dc.html A): agents in columns by the longest path of handoffs
 * into each, a column's steps one under another, each terminal under its agent; handoffs across, a feedback loop under
 * the steps with its rounds, a context link dashed, a shared worktree the thick stub. An automatic gate (`plan`'s gate
 * in force) is the amber chip on its wire.
 */
export function chainSketch(b: TemplateBody, plan: LayOutPlan, width: number): Sketch {
  const agents = b.steps.filter((s) => s.agent !== "terminal");
  const col = new Map<string, number>();
  const colOf = (k: string, seen: Set<string> = new Set()): number => {
    if (col.has(k)) return col.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const ins = b.wires.filter((w) => w.type === "handoff" && w.to === k).map((w) => colOf(w.from, seen) + 1);
    const c = ins.length ? Math.max(...ins) : 0;
    col.set(k, c);
    return c;
  };
  for (const s of agents) colOf(s.key);
  const cols = Math.max(1, ...agents.map((s) => col.get(s.key)! + 1));
  const bw = Math.max(64, Math.min(108, Math.floor((width - (cols - 1) * COL_GAP) / cols)));
  const rowIn = new Map<number, number>();
  const boxes: SketchBox[] = [];
  const at = new Map<string, SketchBox>();
  for (const s of agents) {
    const c = col.get(s.key)!;
    const r = rowIn.get(c) ?? 0;
    rowIn.set(c, r + 1);
    const box: SketchBox = { key: s.key, name: s.name, sub: s.agent, x: c * (bw + COL_GAP), y: 2 + r * (BOX_H + ROW_GAP), w: bw, h: BOX_H, terminal: false };
    boxes.push(box);
    at.set(s.key, box);
  }
  const rows = Math.max(1, ...rowIn.values());
  const loops = b.wires.some((w) => w.type === "feedback");
  const agentsBottom = 2 + rows * BOX_H + (rows - 1) * ROW_GAP;
  const termTop = agentsBottom + (loops ? 36 : 22);
  for (const s of b.steps) {
    if (s.agent !== "terminal") continue;
    const agent = at.get((s.folder as { sameAs: string }).sameAs);
    const box: SketchBox = { key: s.key, name: s.name, sub: "terminal", x: agent?.x ?? 0, y: termTop, w: Math.round(bw * 0.86), h: TERM_H, terminal: true };
    boxes.push(box);
    at.set(s.key, box);
  }
  const paths: SketchPath[] = [];
  b.wires.forEach((w, i) => {
    const a = at.get(w.from);
    const z = at.get(w.to);
    if (!a || !z) return;
    const p = plan.wires[i];
    const automatic = p?.gate === "automatic";
    if (w.type === "worktree") {
      paths.push({ d: `M${a.x + 18} ${a.y + a.h} V ${z.y}`, kind: "worktree", chip: null });
      return;
    }
    if (w.type === "feedback" || (w.type !== "context" && z.x <= a.x)) {
      const y = Math.max(a.y + a.h, z.y + z.h);
      const ax = a.x + a.w / 2;
      const zx = z.x + z.w / 2;
      paths.push({
        d: `M${ax} ${a.y + a.h} C ${ax} ${y + 32}, ${zx} ${y + 32}, ${zx} ${z.y + z.h + 2}`,
        kind: w.type === "feedback" ? "feedback" : "handoff",
        chip: { x: (ax + zx) / 2 - 26, y: y + 16, text: automatic ? "automatic" : w.type === "feedback" ? `↺ ${w.rounds ?? 3} rounds` : "", tone: automatic ? "amber" : "plain" },
      });
      return;
    }
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = z.x - 2;
    const y2 = z.y + z.h / 2;
    const mid = (x1 + x2) / 2;
    paths.push({
      d: `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
      kind: w.type === "context" ? "context" : "handoff",
      chip: automatic ? { x: mid - 26, y: (y1 + y2) / 2 + 22, text: "automatic", tone: "amber" } : null,
    });
  });
  const right = Math.max(...boxes.map((x) => x.x + x.w));
  const bottom = Math.max(...boxes.map((x) => x.y + x.h), agentsBottom + (loops ? 34 : 0));
  return { w: Math.max(right, 1), h: bottom + 2, boxes, paths: paths.map((p) => (p.chip && !p.chip.text ? { ...p, chip: null } : p)) };
}

function ChainSketch({ body, plan, width }: { body: TemplateBody; plan: LayOutPlan; width: number }) {
  const s = useMemo(() => chainSketch(body, plan, width), [body, plan, width]);
  return (
    <div className="tp-sketch" style={{ height: s.h, width: s.w }} aria-label="The chain, drawn small" role="img">
      <svg width={s.w} height={s.h} aria-hidden="true">
        <defs>
          <marker id="tp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </marker>
        </defs>
        {s.paths.map((p, i) => (
          <path key={i} className={`tp-w tp-w-${p.kind}`} d={p.d} fill="none" markerEnd={p.kind === "worktree" || p.kind === "context" ? undefined : "url(#tp-arrow)"} />
        ))}
      </svg>
      {s.boxes.map((b) => (
        <div key={b.key} className={`tp-box${b.terminal ? " term" : ""}`} data-step={b.key} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
          <span className="t">{b.name}</span>
          {!b.terminal && <span className="s">{b.sub}</span>}
        </div>
      ))}
      {s.paths.map((p, i) => p.chip && <span key={i} className={`tp-chip ${p.chip.tone}`} style={{ left: p.chip.x, top: p.chip.y }}>{p.chip.text}</span>)}
    </div>
  );
}

// ---- each step, whole ---------------------------------------------------------------------------

/** A textarea as tall as what it holds: a step's prompt is shown whole, never cut or scrolled. */
function WholeText({ value, onChange, label, placeholder, mono }: { value: string; onChange: (v: string) => void; label: string; placeholder: string; mono?: boolean }) {
  const el = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const t = el.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={el} className={`tp-prompt${mono ? " mono" : ""}`} rows={1} aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** What a wire into a step does, said under it: "Sends without asking once Reviewer approves." */
function sendsLine(b: TemplateBody, w: TemplateWire): string {
  const from = b.steps.find((s) => s.key === w.from)!.name;
  if (w.type === "feedback") return `Sends ${from}'s changes back without asking.`;
  if (w.when === "pr-merged") return `Sends without asking once ${from}'s pull request merges.`;
  const verdict = b.wires.some((x) => x.type === "feedback" && x.from === w.from);
  return `Sends without asking once ${from} ${verdict ? "approves" : "finishes"}.`;
}

interface StepsProps {
  body: TemplateBody;
  /** Each step's name editable (Save as template: a name made from a ticket or a branch is the chain's, not a step's). */
  editNames?: boolean;
  plan: LayOutPlan;
  catalog: ModelCatalog | null;
  onStep: (key: string, patch: Partial<TemplateStep>) => void;
  onWire: (index: number, patch: Partial<TemplateWire>) => void;
  onStartFirst: (starts: boolean) => void;
}

function StepRows({ body, plan, catalog, editNames, onStep, onWire, onStartFirst }: StepsProps) {
  return (
    <>
      {body.steps.map((s, i) => {
        const terminal = s.agent === "terminal";
        const p = plan.steps[i];
        const into = body.wires.map((w, j) => ({ w, p: plan.wires[j], j })).filter((x) => x.w.to === s.key && x.w.type !== "worktree");
        const models = catalog && !terminal ? catalog[s.agent as "claude" | "codex"].models : [];
        const efforts = catalog && !terminal ? catalog[s.agent as "claude" | "codex"].efforts : [];
        const effortOptions: SelectOption[] = [
          { value: "", label: "Default effort" },
          ...(s.effort && !efforts.includes(s.effort) ? [{ value: s.effort, label: s.effort }] : []),
          ...efforts.map((e) => ({ value: e, label: e })),
        ];
        const nameOf = (k: string) => body.steps.find((x) => x.key === k)?.name ?? k;
        const modelOptions: SelectOption[] = [
          { value: "", label: "Default model" },
          ...(s.model && !models.some((m) => m.id === s.model) ? [{ value: s.model, label: s.model }] : []),
          ...models.map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group })),
        ];
        return (
          <div key={s.key} className="tp-step" data-step={s.key}>
            <div className="tp-step-head">
              <span className="tp-dot" />
              {editNames ? (
                <input type="text" className="tp-name tp-name-edit" aria-label={`Step ${i + 1}'s name`} value={s.name} maxLength={80} onChange={(e) => onStep(s.key, { name: e.target.value })} />
              ) : (
                <span className="tp-name">{s.name}</span>
              )}
              {terminal ? (
                <span className="tp-fixed" title="A terminal step stays a terminal">Terminal</span>
              ) : (
                <>
                  <Select
                    className="tp-agent"
                    value={s.agent}
                    title={`${s.name}'s agent`}
                    options={[
                      { value: "claude", label: AGENT_NAME.claude },
                      { value: "codex", label: AGENT_NAME.codex },
                    ]}
                    onChange={(v) => onStep(s.key, { agent: v as "claude" | "codex", model: undefined, effort: undefined })}
                  />
                  <Select className="tp-model" value={s.model ?? ""} placeholder="Default model" title={`${s.name}'s model`} options={modelOptions} onChange={(v) => onStep(s.key, { model: v || undefined })} />
                  <Select className="tp-effort" value={s.effort ?? ""} placeholder="Default effort" title={`${s.name}'s effort`} options={effortOptions} onChange={(v) => onStep(s.key, { effort: v || undefined })} />
                </>
              )}
            </div>
            <WholeText
              value={s.prompt}
              mono
              label={terminal ? `${s.name}'s command` : `${s.name}'s prompt`}
              placeholder={terminal ? "The command it runs, e.g. npm run dev" : "What it's told as it starts"}
              onChange={(v) => onStep(s.key, { prompt: v })}
            />
            {typeof s.folder === "object" && !terminal && (
              <div className="tp-line dim">Works in {body.steps.find((x) => x.key === (s.folder as { sameAs: string }).sameAs)?.name}'s folder.</div>
            )}
            {into
              .filter(({ w }) => carriesWork(w.type))
              .map(({ w, j }) => (
                <div key={`flow-${j}`} className="tp-flow" data-wire={j}>
                  <div className="tp-line dim">
                    What {nameOf(w.from)} sends {w.type === "feedback" ? "back" : "it"} ({w.type}):
                  </div>
                  <WholeText
                    value={templateOf({ template: w.template, when: w.when ?? "finished" })}
                    mono
                    label={`What ${nameOf(w.from)} → ${s.name} sends`}
                    placeholder="{summary}"
                    onChange={(v) => onWire(j, { template: v })}
                  />
                  {w.template !== undefined && !w.template.trim() && (
                    <div className="tp-line dim" data-flow-default>
                      Empty, so it sends the default: {flowOf(w).replace(/\s+/g, " ")}
                    </div>
                  )}
                  {w.files?.length ? (
                    <div className="tp-files">
                      <span className="dim">Its files:</span>
                      {w.files.map((f, x) => (
                        <span key={f} className="tp-file">
                          {f}
                          <button type="button" className="link" aria-label={`Leave out ${f}`} title="Leave it out" onClick={() => onWire(j, { files: w.files!.filter((_f, y) => y !== x) })}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            {terminal && (
              <div className="tp-line dim" data-flag="terminal">
                A terminal runs this as a command. {p.terminal!.why}
              </div>
            )}
            {i === 0 && s.role === "orchestrator" && (
              <div className="tp-line dim" data-flag="start">
                An Orchestrator: it starts as it's laid out, in a worktree on the ticket's branch, reads the ticket and proposes the rest as its plan. It creates nothing and writes no code.
              </div>
            )}
            {i === 0 && !s.role && (
              <div className="tp-line dim" data-flag="start">
                <span className="grow">{body.startFirst ? "Starts as it's laid out." : "Waits: nothing starts until you send or Start now."}</span>
                <button type="button" className="link" onClick={() => onStartFirst(!body.startFirst)}>
                  {body.startFirst ? "Let it wait" : "Start it as it's laid out"}
                </button>
              </div>
            )}
            {p.shape && (
              <div className="tp-line dim" data-flag="shape">
                {p.shape}
              </div>
            )}
            {!p.shape && into.map(({ w, p: pw, j }) =>
              pw.problem ? (
                <div key={j} className="tp-line red" data-flag="problem">
                  <span className="grow">{pw.problem}</span>
                  <button type="button" className="link" onClick={() => onWire(j, { when: "finished" })}>
                    Go when it finishes
                  </button>
                </div>
              ) : pw.forced ? (
                <div key={j} className="tp-line dim" data-flag="asks">
                  {body.steps.find((x) => x.key === w.from)?.name} → {s.name} asks, not automatic. {ROOM_ASKS}.
                </div>
              ) : w.gate === "automatic" ? (
                <div key={j} className="tp-line amber" data-flag="automatic">
                  <span className="grow">{sendsLine(body, w)}</span>
                  <button type="button" className="link" onClick={() => onWire(j, { gate: "ask" })}>
                    Make it ask
                  </button>
                </div>
              ) : null
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The model catalog as read (models offered on this Mac): `catalog` none while it's read or when it can't be, `error`
 * why not, `reading` while a read is under way.
 */
interface CatalogRead {
  catalog: ModelCatalog | null;
  error: string | null;
  reading: boolean;
  retry: () => void;
}

/**
 * The model catalog, read as the dialog opens and again on `retry`, one read at a time; a failure is logged and kept to
 * be said (CatalogNote).
 */
function useCatalog(): CatalogRead {
  const [c, setC] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [reading, setReading] = useState(true);
  const readingNow = useRef(true);
  useEffect(() => {
    let live = true;
    readingNow.current = true;
    setReading(true);
    const done = () => {
      readingNow.current = false;
      if (live) setReading(false);
    };
    const failed = (why: string) => {
      console.warn(`[mockingbird] the template picker's models: ${why}`);
      if (live) setError(why);
      done();
    };
    window.mb.modelCatalog().then(
      (r: ModelCatalog | { error: string }) => {
        if (isErr(r)) return failed(r.error);
        done();
        if (!live) return;
        setC(r);
        setError(null);
      },
      (err: unknown) => failed(err instanceof Error ? err.message : String(err))
    );
    return () => void (live = false);
  }, [n]);
  const retry = () => {
    // one read at a time: a second press while main answers asks nothing
    if (readingNow.current) return;
    readingNow.current = true;
    setN((x) => x + 1);
  };
  return { catalog: c, error, reading, retry };
}

/**
 * The models offered on this Mac couldn't be read: said beside the steps' model choices, which still offer the default
 * and each step's own model, so a template can be laid out or saved as it is.
 */
function CatalogNote({ read }: { read: CatalogRead }) {
  if (!read.error) return null;
  return (
    <div className="tp-line amber" data-flag="models" role="status">
      <span className="grow">The models offered on this Mac couldn't be read ({read.error}): each step can keep its own model or take the default.</span>
      <button type="button" className="link" disabled={read.reading} aria-busy={read.reading} onClick={read.retry}>
        {read.reading ? "Reading…" : "Try again"}
      </button>
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Why the picker's Lay out is off for want of a repo, or of an area to lay out in: on its button, and said under what's missing. */
const NEEDS_REPO = "Its steps work in worktrees of their own: choose a repo";
const NEEDS_AREA = "Choose a ticket, so its steps have an area";

/** A body with step `key` changed. */
const withStep = (b: TemplateBody, key: string, patch: Partial<TemplateStep>): TemplateBody => ({
  ...b,
  steps: b.steps.map((s) => {
    if (s.key !== key) return s;
    const next: TemplateStep = { ...s, ...patch };
    for (const k of ["model", "effort"] as const) if (next[k] === undefined) delete next[k];
    return next;
  }),
});
const withWire = (b: TemplateBody, i: number, patch: Partial<TemplateWire>): TemplateBody => ({ ...b, wires: b.wires.map((w, j) => (j === i ? { ...w, ...patch } : w)) });

// ---- Pipeline from a ticket… --------------------------------------------------------------------

/** Where the picker lays a template out, as the landscape knows it. */
export interface PickerWhere {
  /** The area it was opened in (a right-click there), or null: its ticket's area, else one named after the template. */
  area: string | null;
  /** That area's first repo and the base it keeps for it. */
  seed: { repo?: string; base?: string | null };
  /** Whether a group has an area on the landscape already, and its title. */
  areaTitle: (key: string) => string | null;
  /** Whether a group is a team room's area: its gates all ask. */
  inRoom: (key: string) => boolean;
}

export interface TemplatePickerProps {
  where: PickerWhere;
  /** A template offered first, ahead of the saved ones (W17's plan, laid out here as a template is). */
  offered?: { name: string; body: TemplateBody; provenance: string };
  /** Lay out: settles with why nothing was laid out, or null once it was (and the dialog closes). */
  onLayOut: (req: LayOutRequest) => Promise<string | null>;
  /** Where the keyboard goes as it closes, rather than back to a terminal. */
  home: () => HTMLElement | null;
  onClose: () => void;
}

export function TemplatePicker({ where, offered, onLayOut, home, onClose }: TemplatePickerProps) {
  const head = useRef<HTMLDivElement>(null);
  const { heldOff } = useOpenSettle(() => head.current?.closest<HTMLElement>(".modal"));
  const shownHold = useHeldOff();
  const modelRead = useCatalog();
  const catalog = modelRead.catalog;
  const [list, setList] = useState<TemplateList | { error: string } | null>(null);
  const read = () =>
    window.mb.templatesList().then(
      (r: TemplateList | { error: string }) => setList(r),
      (err: unknown) => setList({ error: err instanceof Error ? err.message : String(err) })
    );
  useEffect(() => void read(), []);
  const OFFERED = "offered";
  const [chosen, setChosen] = useState<string | null>(offered ? OFFERED : null);
  const [body, setBody] = useState<TemplateBody | null>(offered?.body ?? null);
  const templates = list && !isErr(list) ? list.templates : [];
  const choose = (id: string) => {
    const t = id === OFFERED ? offered : id === BUILT_IN_TEMPLATE.id ? BUILT_IN_TEMPLATE : templates.find((x) => x.template.id === id)?.template;
    if (!t) return;
    setChosen(id);
    setBody(structuredClone("body" in t ? t.body : { startFirst: t.startFirst, steps: t.steps, wires: t.wires }));
    setError("");
    // what Lay out lays out just changed under the pointer
    shownHold.holdOff("layout", ANSWER_SETTLE_MS);
  };
  // once the saved templates are read, when nothing's offered: the first of them, else the built-in
  useEffect(() => {
    if (chosen === null && list) choose(templates[0]?.template.id ?? BUILT_IN_TEMPLATE.id);
  }, [list]);
  const name = chosen === OFFERED ? offered!.name : chosen === BUILT_IN_TEMPLATE.id ? BUILT_IN_TEMPLATE.name : (templates.find((x) => x.template.id === chosen)?.template.name ?? "");

  // the ticket, as New session picks one: yours first, then anyone's
  const ado = useAdoTickets();
  const all = ado.items ?? [];
  const [whoPick, setWhoPick] = useState("");
  const who = whoPick || (ado.items ? ado.me || "*" : "");
  const people = useMemo(() => {
    const names = [...new Set(all.map((t) => t.assignedTo).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const mine = who && who !== "*" ? names.filter((n) => n === who) : [];
    return [...mine, ...names.filter((n) => !mine.includes(n))];
  }, [all, who]);
  const columns = useMemo(() => ticketsByColumn(who && who !== "*" ? all.filter((t) => t.assignedTo === who) : all, ado.stateOrder), [all, who, ado.stateOrder]);
  const [ticketSel, setTicketSel] = useState("");
  const ticket = all.find((t) => String(t.id) === ticketSel) ?? null;
  const tLine = ticket ? ticketLine(String(ticket.id), ticket.title) : "";

  const [repo, setRepo] = useState(where.seed.repo ?? "");
  const { branches, base, setBase, error: branchError } = useRepoBranches(repo || null);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !branches || repo !== where.seed.repo || !where.seed.base) return;
    seeded.current = true;
    if (branches.branches.includes(where.seed.base)) setBase(where.seed.base);
  }, [branches]);

  // an area is a top-level group: a "/" in the template's name would make it a stack's
  const area = where.area ?? (ticket ? String(ticket.id) : name.replace(/\//g, "-"));
  const room = !!area && where.inRoom(area);
  const plan = useMemo(() => (body ? layOutPlan(body, { room, ticket: !!ticket }) : null), [body, room, ticket]);
  const needsRepo = !!body && body.steps.some((s) => s.folder === "new") && !repo;
  const needsArea = !!body && !area;
  const blocked = !body ? "Choose a template" : plan!.problems[0] ?? (needsRepo ? NEEDS_REPO : needsArea ? NEEDS_AREA : null);

  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const [error, setError] = useState("");
  const layOut = async () => {
    if (busyNow.current || !body || blocked || heldOff("settle") || shownHold.heldOff("layout")) return;
    busyNow.current = true;
    setBusy(true);
    setError("");
    let why: string | null;
    try {
      why = await onLayOut({
        name: name || "The template",
        template: asShown(body),
        // an Orchestrator is told the ticket's description, fenced as text others wrote (main builds its kickoff)
        ...(ticket ? { ticketId: String(ticket.id), ticketTitle: ticket.title, ...(startsAtOrchestrator(body) ? { ticketDescription: ticket.description } : {}) } : {}),
        repoPath: repo || null,
        ...(repo && base ? { base } : {}),
        area,
      });
    } catch (err) {
      console.warn(`[mockingbird] laying out ${name}:`, err);
      why = `Couldn't lay it out: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
    if (why) setError(why);
  };
  // saved templates that aren't a list: a copy kept where main says, and the list started empty
  const [aside, setAsideNote] = useState("");
  const setAside = async () => {
    if (!window.confirm("Set the saved templates aside? A copy of them is kept as it is, and the list starts empty.")) return;
    let r: { file: string; list: TemplateList } | { error: string };
    try {
      r = await window.mb.templatesSetAside();
    } catch (err) {
      r = { error: err instanceof Error ? err.message : String(err) };
    }
    if (isErr(r)) return setError(`Couldn't set them aside: ${r.error}`);
    setList(r.list);
    setAsideNote(`Set aside: a copy is kept in ${r.file}, and the list starts empty.`);
  };
  const removeIt = async (id: string, label: string) => {
    if (!window.confirm(`Remove the template “${label}”? Laid-out steps made from it stay.`)) return;
    let r: TemplateList | { error: string };
    try {
      r = await window.mb.templatesRemove(id);
    } catch (err) {
      r = { error: err instanceof Error ? err.message : String(err) };
    }
    if (isErr(r)) return setError(`Couldn't remove “${label}”: ${r.error}`);
    setList(r);
    if (chosen === id) {
      setChosen(null);
      setBody(null);
    }
  };

  const existing = area ? where.areaTitle(area) : null;
  const usesWorktree = !!body?.steps.some((s) => s.folder === "new");
  const foot = [
    !area ? "no area yet" : existing ? `in ${existing}` : `new area ${ticket ? `#${ticket.id}` : area}`,
    !repo ? "no repo" : usesWorktree ? `worktree from ${base ? `origin/${base}` : `${baseName(repo)}'s HEAD`}` : `${baseName(repo)}'s checkout`,
    ...(room ? ["team room: gates ask"] : []),
  ].join(" · ");
  const held = heldOff("settle") || shownHold.heldOff("layout");

  return (
    <Modal
      className="modal tp"
      onClose={onClose}
      closeOnBackdrop={!heldOff("settle")}
      handsBack={notToTerminal(home)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (!e.repeat) void layOut();
        }
      }}
    >
      <div className="tp-head" ref={head}>
        <h3>Pipeline from a ticket</h3>
        {chosen === OFFERED && offered && <span className="tp-prov">{offered.provenance}</span>}
      </div>
      <div className="tp-sec">
        <div className="tp-k">Ticket</div>
        <div className="tp-line2">
          <Pick
            className="tp-who"
            value={who}
            onChange={(e) => {
              setWhoPick(e.target.value);
              setTicketSel("");
            }}
            disabled={!all.length}
            title="Whose tickets to choose from"
          >
            <option value="*">Anyone</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Pick>
          <Pick className="tp-ticket" value={ticketSel} onChange={(e) => setTicketSel(e.target.value)} title="The ticket its steps are on: {ticket} in a prompt names it">
            <option value="">{ado.items === null ? (ado.error ? "No ticket (the board can't be read)" : "No ticket (reading the board…)") : "No ticket"}</option>
            {columns.map((c) => (
              <optgroup key={c.state} label={c.state}>
                {c.items.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    #{t.id} · {t.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </Pick>
        </div>
      </div>
      {ado.error && <div className="tp-note dim">Azure DevOps: {ado.error}</div>}
      {needsArea && (
        <div className="tp-note amber" data-flag="area">
          {NEEDS_AREA}. Lay out is off until then.
        </div>
      )}
      {body?.steps.some((s) => s.agent !== "terminal" && s.prompt.includes("{ticket}")) && (
        <div className="tp-note dim" data-flag="ticket">
          {tLine ? `{ticket} in a prompt is “${tLine}”.` : "{ticket} in a prompt is empty: no ticket is chosen."}
        </div>
      )}
      <div className="tp-sec">
        <div className="tp-k">Repo</div>
        <div className="tp-line2">
          <RepoPick className="tp-repo" value={repo} onChange={setRepo} none="No repo" title="The repo its steps' worktrees are made in" />
          <Pick className="tp-base" value={base} onChange={(e) => setBase(e.target.value)} disabled={!branches} title="A new worktree with nothing before it to start from is cut from origin's branch of this name">
            <option value="">{repo ? "base: its HEAD" : "no base"}</option>
            {(branches?.branches ?? []).map((b) => (
              <option key={b} value={b}>
                base: origin/{b}
              </option>
            ))}
          </Pick>
        </div>
      </div>
      {branchError && <div className="tp-note red">{branchError}</div>}
      {needsRepo && (
        <div className="tp-note amber" data-flag="repo">
          {NEEDS_REPO}. Lay out is off until then.
        </div>
      )}
      <div className="tp-main">
        <div className="tp-list" role="listbox" aria-label="Templates">
          <div className="tp-k pad">Templates</div>
          {offered && (
            <button type="button" role="option" aria-selected={chosen === OFFERED} className={`tp-item${chosen === OFFERED ? " sel" : ""}`} onClick={() => choose(OFFERED)}>
              <span className="t">{offered.name}</span>
              <span className="s">{offered.provenance}</span>
            </button>
          )}
          <button
            type="button"
            role="option"
            aria-selected={chosen === BUILT_IN_TEMPLATE.id}
            className={`tp-item${chosen === BUILT_IN_TEMPLATE.id ? " sel" : ""}`}
            data-template={BUILT_IN_TEMPLATE.id}
            onClick={() => choose(BUILT_IN_TEMPLATE.id)}
          >
            <span className="t">{BUILT_IN_TEMPLATE.name}</span>
            <span className="s">Built in · {plural(BUILT_IN_TEMPLATE.steps.length, "step")}</span>
          </button>
          {list === null && <div className="tp-empty">Reading the saved templates…</div>}
          {list && isErr(list) && (
            <div className="tp-empty red">
              The saved templates couldn't be read: {list.error}{" "}
              <button type="button" className="link" onClick={() => void read()}>
                Try again
              </button>
            </div>
          )}
          {list && !isErr(list) && list.broken && (
            <div className="tp-empty red" data-broken>
              {list.broken}{" "}
              <button type="button" className="link" onClick={() => void setAside()}>
                Set them aside…
              </button>
            </div>
          )}
          {aside && (
            <div className="tp-empty" data-aside>
              {aside}
            </div>
          )}
          {templates.map(({ template: t, unknown }) => {
            const auto = automaticGates(t);
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={chosen === t.id}
                className={`tp-item${chosen === t.id ? " sel" : ""}`}
                data-template={t.id}
                title={unknown.length ? `Saved by another version of Mockingbird: this one doesn't read ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} kept as ${unknown.length === 1 ? "it is" : "they are"}` : undefined}
                onClick={() => choose(t.id)}
              >
                <span className="t">{t.name}</span>
                <span className="s">
                  {plural(t.steps.length, "step")}
                  {auto ? (
                    <>
                      {" · "}
                      <span className="amber">{auto} automatic</span>
                    </>
                  ) : null}
                  {unknown.length ? " · another version's" : ""}
                </span>
              </button>
            );
          })}
          {list && !isErr(list) &&
            list.refused.map((r) => (
              <div key={`refused-${r.index}`} className="tp-item off" data-refused={r.index} title={r.why}>
                <span className="t">{r.name ?? `Template ${r.index + 1}`}</span>
                <span className="s red">Can't be used here: {r.why}</span>
                {r.id && (
                  <button type="button" className="link" onClick={() => void removeIt(r.id!, r.name ?? `template ${r.index + 1}`)}>
                    Remove…
                  </button>
                )}
              </div>
            ))}
          {list && !isErr(list) && !templates.length && !offered && (
            <div className="tp-empty" data-empty="templates">
              No saved templates yet: Save as template… in a wired workspace's ⋯ saves its chain as one.
            </div>
          )}
          {chosen && chosen !== OFFERED && chosen !== BUILT_IN_TEMPLATE.id && (
            <button type="button" className="link tp-remove" onClick={() => void removeIt(chosen, name)}>
              Remove this template…
            </button>
          )}
        </div>
        <div className="tp-steps">
          {body && plan ? (
            <>
              <ChainSketch body={body} plan={plan} width={354} />
              <CatalogNote read={modelRead} />
              <StepRows
                body={body}
                plan={plan}
                catalog={catalog}
                onStep={(k, p) => setBody((b) => b && withStep(b, k, p))}
                onWire={(j, p) => setBody((b) => b && withWire(b, j, p))}
                onStartFirst={(starts) => setBody((b) => b && { ...b, startFirst: starts })}
              />
            </>
          ) : (
            <div className="tp-empty">Choose a template to see its steps.</div>
          )}
        </div>
      </div>
      {error && (
        <div className="tp-note red" role="alert">
          {error}
        </div>
      )}
      <div className="tp-foot">
        <span className="tp-where" title={foot}>
          {foot}
        </span>
        <button className="outline" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" data-act="layout" disabled={busy || !!blocked || held} title={blocked ?? undefined} onClick={() => void layOut()}>
          {busy ? "Laying out…" : "Lay out"}
          {!busy && <span className="kbd"> ⌘↵</span>}
        </button>
      </div>
    </Modal>
  );
}

// ---- Save as template ---------------------------------------------------------------------------

export interface SaveTemplateProps {
  draft: TemplateDraft;
  /** What the chain leaves out that main can't see: the other branches at its steps. */
  leftOut: string[];
  /** Save it: settles with why it wasn't saved, or null once it was (and the dialog closes). */
  onSave: (name: string, body: TemplateBody) => Promise<string | null>;
  home: () => HTMLElement | null;
  onClose: () => void;
}

/**
 * Save as template: the chain as it'll be kept, every step's prompt whole, what was redacted or left out said above
 * it. What's saved is what's shown: main refuses text holding a secret-looking value or a home folder's path rather
 * than changing it. Kept on this Mac only, never sent to teammates.
 */
export function SaveTemplateDialog({ draft, leftOut, onSave, home, onClose }: SaveTemplateProps) {
  const head = useRef<HTMLDivElement>(null);
  const { heldOff } = useOpenSettle(() => head.current?.closest<HTMLElement>(".modal"));
  const modelRead = useCatalog();
  const catalog = modelRead.catalog;
  const [name, setName] = useState(draft.name);
  const [body, setBody] = useState<TemplateBody>(() => structuredClone(draft.body));
  const plan = useMemo(() => layOutPlan(body, { room: false, ticket: true }), [body]);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (busyNow.current || heldOff("settle") || !name.trim()) return;
    busyNow.current = true;
    setBusy(true);
    setError("");
    let why: string | null;
    try {
      why = await onSave(name.trim(), asShown(body));
    } catch (err) {
      console.warn(`[mockingbird] saving the template ${name}:`, err);
      why = `Couldn't save it: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
    if (why) setError(why);
  };
  const notes = [...draft.notes, ...(leftOut.length ? [`Not in the chain, so not kept: ${leftOut.join(", ")} (other branches).`] : [])];
  return (
    <Modal
      className="modal tp tp-save"
      onClose={onClose}
      closeOnBackdrop={!heldOff("settle")}
      handsBack={notToTerminal(home)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (!e.repeat) void save();
        }
      }}
    >
      <div className="tp-head" ref={head}>
        <h3>Save as template</h3>
        <span className="tp-prov">kept on this Mac, never sent to teammates</span>
      </div>
      <div className="tp-sec">
        <div className="tp-k">Name</div>
        <input type="text" className="tp-name-in" aria-label="The template's name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      {notes.map((n) => (
        <div key={n} className="tp-note dim" data-note>
          {n}
        </div>
      ))}
      <div className="tp-steps solo">
        <ChainSketch body={body} plan={plan} width={540} />
        <CatalogNote read={modelRead} />
        <StepRows
          body={body}
          plan={plan}
          catalog={catalog}
          editNames
          onStep={(k, p) => setBody((b) => withStep(b, k, p))}
          onWire={(j, p) => setBody((b) => withWire(b, j, p))}
          onStartFirst={(starts) => setBody((b) => ({ ...b, startFirst: starts }))}
        />
      </div>
      {error && (
        <div className="tp-note red" role="alert">
          {error}
        </div>
      )}
      <div className="tp-foot">
        <span className="tp-where">{plural(body.steps.length, "step")} · {plural(body.wires.length, "wire")} · {automaticGates(body)} automatic</span>
        <button className="outline" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" data-act="save" disabled={busy || !name.trim() || heldOff("settle")} onClick={() => void save()}>
          {busy ? "Saving…" : "Save template"}
          {!busy && <span className="kbd"> ⌘↵</span>}
        </button>
      </div>
    </Modal>
  );
}

// ---- the Orchestrator's plan (W17) --------------------------------------------------------------

/** A plan's sketch key for an end that isn't one of its steps: its Orchestrator, or a workspace there already. */
const ME_KEY = "me";
const existingKey = (i: number) => `x${i}`;

/**
 * Plan `p` as the chain sketch draws a template: its Orchestrator and the workspaces it wires to as boxes of their own
 * beside its steps, each wire's gate as it's laid out (`layout`, or as written while the plan can't be checked).
 */
function planSketch(p: Plan, v: PlanView, layout: PlanLayOut | null): { body: TemplateBody; plan: LayOutPlan } {
  const named = [...new Set(p.wires.flatMap((w) => [w.from, w.to]).filter((e) => Object.hasOwn(v.existing, e)))];
  const keyOf = (e: string) => (e === ME ? ME_KEY : named.includes(e) ? existingKey(named.indexOf(e)) : e);
  const steps: TemplateStep[] = [
    { key: ME_KEY, name: v.me.title, agent: v.me.agent ?? "claude", folder: "new", prompt: "" },
    ...named.map((e, i): TemplateStep => ({ key: existingKey(i), name: v.existing[e].title, agent: v.existing[e].agent ?? "claude", folder: "new", prompt: "" })),
    ...p.steps.map((s): TemplateStep => ({ key: s.key, name: s.name, agent: s.agent, folder: s.folder === "orchestrator" ? { sameAs: ME_KEY } : s.folder, prompt: s.prompt })),
  ];
  const wires: TemplateWire[] = p.wires.map((w) => ({ ...w, from: keyOf(w.from), to: keyOf(w.to) }));
  return {
    body: { startFirst: true, steps, wires },
    plan: {
      steps: steps.map((s) => ({ step: s, starts: false, terminal: s.agent === "terminal" ? { laid: true, why: "" } : null })),
      wires: p.wires.map((w, i) => ({ wire: wires[i], gate: layout?.wires[i]?.gate ?? w.gate ?? "ask", forced: !!layout?.wires[i]?.forced, afterStart: false, skipped: false, problem: null })),
      forced: layout?.forced ?? 0,
      problems: [],
    },
  };
}

const withPlanStep = (p: Plan, key: string, patch: Partial<PlanStep>): Plan => ({
  ...p,
  steps: p.steps.map((s) => {
    if (s.key !== key) return s;
    const next: PlanStep = { ...s, ...patch };
    for (const k of ["model", "effort", "repo"] as const) if (next[k] === undefined) delete next[k];
    return next;
  }),
});
const withPlanWire = (p: Plan, j: number, patch: Partial<PlanWire>): Plan => ({
  ...p,
  wires: p.wires.map((w, i) => {
    if (i !== j) return w;
    const next: PlanWire = { ...w, ...patch };
    for (const k of ["when", "gate", "template", "rounds", "toolOutput"] as const) if (next[k] === undefined) delete next[k];
    return next;
  }),
});
/** Plan `p` as the dialog shows it: each gate as shown, a team room's forced ask sent as ask, so main makes what was read. */
const asShownPlan = (p: Plan, layout: PlanLayOut | null): Plan => ({ ...p, wires: p.wires.map((w, j) => (layout?.wires[j]?.forced ? { ...w, gate: "ask" as const } : w)) });

/** Plan `p` without step `key` and the wires that reach it: what's left is checked as any plan is. */
const withoutStep = (p: Plan, key: string): Plan => ({ ...p, steps: p.steps.filter((s) => s.key !== key), wires: p.wires.filter((w) => w.from !== key && w.to !== key) });

/** How long ago `at` was, as the dialog says it: "6m ago", or "just now". */
const ago = (at: number): string => {
  const a = agoShort(at);
  return a === "now" ? "just now" : `${a} ago`;
};

const WHEN_LABEL: Record<WireWhen, string> = { finished: "When it finishes", manual: "When you send it", "pr-merged": "When its PR merges" };

export interface PlanPickerProps {
  view: PlanView;
  /** The plan isn't held any more (replaced, laid out or dismissed): main would refuse its Lay out, and the dialog says so. */
  gone: boolean;
  /** Opened on the tray's Dismiss…: the note to its Orchestrator shown first. */
  dismissing?: boolean;
  /** A newer plan its Orchestrator proposed while this one is open, waiting for the dialog to close; null when none. */
  newer?: { at: number } | null;
  areaTitle: (key: string) => string | null;
  /**
   * Lay out: the plan as shown (each gate as shown, a team room's forced ask sent as ask) and the area and room it was
   * shown in; settles with why nothing was laid out, or null once it was (and the dialog closes).
   */
  onLayOut: (id: string, shown: Plan, at: PlanShownAt) => Promise<string | null>;
  /** Dismiss, with the note: settles with why it wasn't, or null once it was. */
  onDismiss: (id: string, note: string) => Promise<string | null>;
  home: () => HTMLElement | null;
  onClose: () => void;
}

/**
 * An Orchestrator's plan in the template picker (W17; section 4, "What the dialog shows"): who wrote it (its provenance
 * line: an agent that read a ticket others wrote), every step whole and editable (agent, model, effort, repo, where it
 * works, how it starts, its prompt never cut; a terminal's command flagged as one), every wire with its ends, type,
 * When, gate and rounds (an automatic gate in amber with Make it ask; a workspace there already marked so), what's
 * flagged (links, secret-looking values replaced, a team room's gates asking), and how old it is and whether it
 * replaced another. The same rules main holds it to run here on every edit, so Lay out is off saying why; main checks
 * it all again on what's sent, which is exactly what's shown. It takes Lay out as W9's picker does: no early click,
 * double click's second, burst's key or held ⌘↵, and the keyboard never handed to a terminal.
 */
export function PlanPicker({ view, gone, newer, dismissing, areaTitle, onLayOut, onDismiss, home, onClose }: PlanPickerProps) {
  const head = useRef<HTMLDivElement>(null);
  const { heldOff } = useOpenSettle(() => head.current?.closest<HTMLElement>(".modal"));
  const modelRead = useCatalog();
  const catalog = modelRead.catalog;
  // main holds a plan proposed while this one is open as waiting, so what the user is editing isn't replaced under them
  useEffect(() => {
    const say = (open: boolean) =>
      void window.mb.plansViewing(open ? view.id : null).then(
        (r) => isErr(r) && console.warn(`[mockingbird] the plan dialog ${open ? "opening on" : "closing on"} ${view.id}: ${r.error}`),
        (err: unknown) => console.warn(`[mockingbird] the plan dialog ${open ? "opening on" : "closing on"} ${view.id}:`, err)
      );
    say(true);
    return () => say(false);
  }, [view.id]);
  const [body, setBody] = useState<Plan>(() => structuredClone(view.held.plan));
  const ctx = useMemo(() => ({ me: view.me, existing: view.existing, installed: view.installed, catalog, repos: view.repos, room: !!view.room, ticket: view.held.ticket }), [view, catalog]);
  const checked = useMemo((): { layout: PlanLayOut } | { problem: string } => {
    try {
      return { layout: checkPlan(body, ctx) };
    } catch (err) {
      return { problem: err instanceof Error ? err.message : String(err) };
    }
  }, [body, ctx]);
  const layout = "layout" in checked ? checked.layout : null;
  const sketch = useMemo(() => planSketch(body, view, layout), [body, view, layout]);
  const flags = layout ? planFlags(body, layout, ctx, view.held.notes) : (view.held.notes ?? []);
  const nameOf = (e: string) => (e === ME ? view.me.title : (body.steps.find((s) => s.key === e)?.name ?? view.existing[e]?.title ?? e));
  const [busy, setBusy] = useState<"layout" | "dismiss" | null>(null);
  const busyNow = useRef(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState<string | null>(dismissing ? "" : null);
  const blocked = gone ? "This plan isn't held any more: it was replaced, laid out or dismissed." : "problem" in checked ? checked.problem : null;
  const act = async (which: "layout" | "dismiss") => {
    if (busyNow.current || heldOff("settle") || (which === "layout" && blocked)) return;
    busyNow.current = true;
    setBusy(which);
    setError("");
    let why: string | null;
    try {
      why = which === "layout" ? await onLayOut(view.id, asShownPlan(body, layout), { area: view.area, room: view.room }) : await onDismiss(view.id, note ?? "");
    } catch (err) {
      console.warn(`[mockingbird] ${which === "layout" ? "laying out" : "dismissing"} plan ${view.id}:`, err);
      why = `Couldn't ${which === "layout" ? "lay it out" : "dismiss it"}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busyNow.current = false;
      setBusy(null);
    }
    if (why) setError(why);
  };
  const ticket = view.held.ticket ? `#${view.held.ticket}${view.ticketTitle ? ` · ${view.ticketTitle}` : ""}` : null;
  // what main fills {ticket} in with (plans.ts' lay-out, as a template's)
  const tLine = ticketLine(view.held.ticket, view.ticketTitle);
  const where = [`in ${areaTitle(view.area) ?? view.area}`, plural(body.steps.length, "step"), plural(body.wires.length, "wire"), ...(view.room ? ["team room: gates ask"] : [])].join(" · ");
  const held = heldOff("settle");
  return (
    <Modal
      className="modal tp tp-plan"
      onClose={onClose}
      closeOnBackdrop={!held}
      handsBack={notToTerminal(home)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (!e.repeat && note === null) void act("layout");
        }
      }}
    >
      <div className="tp-head" ref={head}>
        <h3>{view.me.title}'s plan</h3>
        <span className="tp-prov" data-provenance>
          {provenanceOf(view)}
        </span>
      </div>
      {ticket ? (
        <div className="tp-sec">
          <div className="tp-k">Ticket</div>
          <div className="tp-line2">{ticket}</div>
        </div>
      ) : view.council ? (
        <div className="tp-sec" data-council>
          <div className="tp-k">Council</div>
          <div className="tp-line2">{view.council} · no ticket, so no stages, pull requests or PR-merged wires</div>
        </div>
      ) : null}
      <div className="tp-sec">
        <div className="tp-k">Summary</div>
        <div className="tp-summary" data-summary title="Its agent's words">
          {body.summary}
        </div>
      </div>
      <div className="tp-note dim" data-flag="age">
        Proposed {ago(view.held.at)}{view.held.replaces ? ", replacing its earlier plan" : ""}. Nothing of it exists until you lay it out, and any of it can be changed first.
      </div>
      {newer && (
        <div className="tp-note amber" data-flag="newer">
          {view.me.title} proposed a newer plan {ago(newer.at)}. It waits while this one is open, so your edits stay: closing this replaces it with that one; laying this one out or dismissing it keeps that one for later.
        </div>
      )}
      <div className="tp-note dim" data-flag="ticket">
        {tLine ? `{ticket} in a prompt is “${tLine}”.` : "{ticket} in a prompt is empty: its Orchestrator is on no ticket."}
      </div>
      {view.room && (
        <div className="tp-note dim" data-flag="room">
          {areaTitle(view.area) ?? view.area} is a team room's area: its steps start as room sessions, under the room's guardrails, and your teammates will see them. Every gate asks.
        </div>
      )}
      {flags.map((f) => (
        <div key={f} className="tp-note amber" data-flag="plan">
          {f}
        </div>
      ))}
      <div className="tp-steps solo">
        <ChainSketch body={sketch.body} plan={sketch.plan} width={560} />
        <CatalogNote read={modelRead} />
        {body.steps.map((s, i) => {
          const p = layout?.steps[i] ?? null;
          const terminal = s.agent === "terminal";
          const into = body.wires.map((w, j) => ({ w, j })).filter((x) => x.w.to === s.key && carriesWork(x.w.type));
          const agent = terminal ? null : (s.agent as "claude" | "codex");
          const models = catalog && agent ? catalog[agent].models : [];
          const efforts = catalog && agent ? catalog[agent].efforts : [];
          return (
            <div key={s.key} className="tp-step" data-step={s.key}>
              <div className="tp-step-head">
                <span className="tp-dot" />
                <input type="text" className="tp-name tp-name-edit" aria-label={`Step ${i + 1}'s name`} value={s.name} maxLength={PLAN_MAX.name} onChange={(e) => setBody((b) => withPlanStep(b, s.key, { name: e.target.value }))} />
                {terminal ? (
                  <span className="tp-fixed" title="A terminal step stays a terminal">
                    Terminal
                  </span>
                ) : (
                  <>
                    <Select
                      className="tp-agent"
                      value={s.agent}
                      title={`${s.name}'s agent`}
                      options={(["claude", "codex"] as const).map((a) => ({ value: a, label: `${AGENT_NAME[a]}${view.installed.includes(a) ? "" : " (not installed)"}` }))}
                      onChange={(v) => setBody((b) => withPlanStep(b, s.key, { agent: v as "claude" | "codex", model: undefined, effort: undefined }))}
                    />
                    <Select
                      className="tp-model"
                      value={s.model ?? ""}
                      placeholder="Default model"
                      title={`${s.name}'s model`}
                      options={[{ value: "", label: "Default model" }, ...(s.model && !models.some((m) => m.id === s.model) ? [{ value: s.model, label: `${s.model} (not offered)` }] : []), ...models.map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group }))]}
                      onChange={(v) => setBody((b) => withPlanStep(b, s.key, { model: v || undefined }))}
                    />
                    <Select
                      className="tp-effort"
                      value={s.effort ?? ""}
                      placeholder="Default effort"
                      title={`${s.name}'s effort`}
                      options={[{ value: "", label: "Default effort" }, ...(s.effort && !efforts.includes(s.effort) ? [{ value: s.effort, label: `${s.effort} (not offered)` }] : []), ...efforts.map((e) => ({ value: e, label: e }))]}
                      onChange={(v) => setBody((b) => withPlanStep(b, s.key, { effort: v || undefined }))}
                    />
                  </>
                )}
                <button type="button" className="link tp-leave" title="Leave this step out, with its wires" onClick={() => setBody((b) => withoutStep(b, s.key))}>
                  Leave out
                </button>
              </div>
              <div className="tp-line dim" data-flag="where">
                <span className="grow">{p?.where ?? (s.folder === "orchestrator" ? `In ${view.me.title}'s folder.` : s.folder === "new" ? "A new worktree." : `In ${nameOf(s.folder.sameAs)}'s folder.`)}</span>
                {s.folder === "new" && view.repos.length > 1 && (
                  <Select
                    className="tp-repo"
                    value={s.repo ?? view.me.repo ?? ""}
                    title={`The repo of ${areaTitle(view.area) ?? view.area} that ${s.name}'s worktree is made in`}
                    options={view.repos.map((r) => ({ value: r, label: baseName(r) }))}
                    onChange={(v) => setBody((b) => withPlanStep(b, s.key, { repo: v === view.me.repo ? undefined : v }))}
                  />
                )}
              </div>
              {p && !terminal && (
                <div className={`tp-line ${p.starts ? "" : "dim"}`} data-flag="start">
                  {p.says}
                </div>
              )}
              <WholeText
                value={s.prompt}
                mono
                label={terminal ? `${s.name}'s command` : `${s.name}'s prompt`}
                placeholder={terminal ? "The command it runs, e.g. npm run dev" : "What it's told as it starts"}
                onChange={(v) => setBody((b) => withPlanStep(b, s.key, { prompt: v }))}
              />
              {terminal && (
                <div className="tp-line amber" data-flag="terminal">
                  Runs this as a command. {p?.terminal?.why ?? ""}
                </div>
              )}
              {into.map(({ w, j }) => (
                <div key={`flow-${j}`} className="tp-flow" data-wire={j}>
                  <div className="tp-line dim">
                    What {nameOf(w.from)} sends {w.type === "feedback" ? "back" : "it"} ({w.type}):
                  </div>
                  <WholeText
                    value={templateOf({ template: w.template, when: w.when ?? "finished" })}
                    mono
                    label={`What ${nameOf(w.from)} → ${s.name} sends`}
                    placeholder="{summary}"
                    onChange={(v) => setBody((b) => withPlanWire(b, j, { template: v }))}
                  />
                  {w.template !== undefined && !w.template.trim() && (
                    <div className="tp-line dim" data-flow-default>
                      Empty, so it sends the default: {flowOf(w).replace(/\s+/g, " ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        <div className="tp-k pad">Wires</div>
        {body.wires.map((w, j) => {
          const lw = layout?.wires[j] ?? null;
          const gate: WireGate = lw?.gate ?? w.gate ?? "ask";
          const ends = [w.from, w.to].map((e) => (Object.hasOwn(view.existing, e) ? `${nameOf(e)} (there already)` : nameOf(e)));
          const carries = carriesWork(w.type);
          // a handoff Lay out sends still has its gate for whatever its source sends later
          const later = lw?.sentByLayOut ? "After that, it " : "";
          return (
            <div key={j} className="tp-wire" data-wire-row={j}>
              <div className="tp-step-head">
                <span className="tp-name">
                  {ends[0]} → {ends[1]}
                </span>
                <span className="tp-fixed">{w.type}</span>
                {carries && (
                  <Select
                    className="tp-when"
                    value={w.when ?? "finished"}
                    title="When it readies"
                    // a plan on no ticket has no pull request to wait for: offered only when it's set already, so its refusal shows
                    options={WIRE_WHENS.filter((x) => x !== "pr-merged" || view.held.ticket || w.when === x).map((x) => ({ value: x, label: WHEN_LABEL[x] }))}
                    onChange={(v) => setBody((b) => withPlanWire(b, j, { when: v === "finished" ? undefined : (v as WireWhen) }))}
                  />
                )}
                {w.type === "feedback" && (
                  <Select
                    className="tp-rounds"
                    value={String(w.rounds ?? 3)}
                    title="Its rounds: at the limit it stops and asks you"
                    options={Array.from({ length: PLAN_MAX.rounds }, (_x, i) => ({ value: String(i + 1), label: `↺ ${i + 1} ${i ? "rounds" : "round"}` }))}
                    onChange={(v) => setBody((b) => withPlanWire(b, j, { rounds: Number(v) }))}
                  />
                )}
                <button type="button" className="link tp-leave" title="Leave this wire out" onClick={() => setBody((b) => ({ ...b, wires: b.wires.filter((_x, i) => i !== j) }))}>
                  Leave out
                </button>
              </div>
              {lw?.sentByLayOut && (
                <div className="tp-line dim" data-flag="sent">
                  Lay out sends it: “{nameOf(w.to)}” starts with its prompt above, and this handoff counts as sent.
                </div>
              )}
              {carries && lw?.forced ? (
                <div className="tp-line dim" data-flag="asks">
                  {later ? `${later}asks` : "It asks"}, not automatic. {ROOM_ASKS}.
                </div>
              ) : carries && gate === "automatic" ? (
                <div className="tp-line amber" data-flag="automatic">
                  <span className="grow">{later ? `${later}sends` : "Sends"} without asking{w.when === "pr-merged" ? ` once ${nameOf(w.from)}'s pull request merges` : ` once ${nameOf(w.from)} finishes`}.</span>
                  <button type="button" className="link" onClick={() => setBody((b) => withPlanWire(b, j, { gate: "ask" }))}>
                    Make it ask
                  </button>
                </div>
              ) : carries ? (
                <div className="tp-line dim" data-flag="ask">
                  {later ? `${later}asks` : "Asks"}: you send it from its gate.
                </div>
              ) : null}
              {w.type === "context" && (
                <div className="tp-line dim" data-flag="context">
                  <span className="grow">
                    “{nameOf(w.to)}” can read “{nameOf(w.from)}”{w.toolOutput === false ? ", without its tool output" : ", its tool output included"}. Nothing is pushed.
                  </span>
                  <label className="tp-check">
                    <input type="checkbox" checked={w.toolOutput !== false} onChange={(e) => setBody((b) => withPlanWire(b, j, { toolOutput: e.target.checked ? undefined : false }))} />
                    Include tool output
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {blocked && (
        <div className="tp-note red" data-flag="blocked">
          {blocked}
        </div>
      )}
      {error && (
        <div className="tp-note red" role="alert">
          {error}
        </div>
      )}
      {note !== null && (
        <div className="tp-sec" data-dismiss>
          <div className="tp-k">Note to {view.me.title}</div>
          <textarea className="tp-prompt" rows={3} aria-label={`Your note to ${view.me.title}`} placeholder="Why, or what to propose instead (optional)" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      <div className="tp-foot">
        <span className="tp-where" title={where}>
          {where}
        </span>
        {note === null ? (
          <>
            <button className="outline" data-act="dismiss-open" disabled={!!busy || gone} onClick={() => setNote("")}>
              Dismiss…
            </button>
            <button className="outline" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" data-act="layout" disabled={!!busy || !!blocked || held} title={blocked ?? undefined} onClick={() => void act("layout")}>
              {busy === "layout" ? "Laying out…" : "Lay out"}
              {busy !== "layout" && <span className="kbd"> ⌘↵</span>}
            </button>
          </>
        ) : (
          <>
            <button className="outline" disabled={!!busy} onClick={() => setNote(null)}>
              Back
            </button>
            <button className="primary" data-act="dismiss" disabled={!!busy || gone || held} title={gone ? (blocked ?? undefined) : `Nothing is made; ${view.me.title} is told, with your note`} onClick={() => void act("dismiss")}>
              {busy === "dismiss" ? "Dismissing…" : "Dismiss plan"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
