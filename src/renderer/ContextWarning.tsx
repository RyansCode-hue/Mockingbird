import { useEffect, useRef, useState } from "react";
import { AGENT_NAME, isErr, type AgentKind, type ContextWindow, type SessionInfo } from "../shared/types";
import { baseName } from "../shared/paths";
import {
  compactBlocker,
  contextBudget,
  costSentence,
  costWhy,
  keepDismissal,
  roughTokens,
  shownLevel,
  type ContextBudget,
  type CostEstimate,
  type Dismissal,
} from "../shared/contextBudget";
import { readPref, writePref } from "./prefs";
import { contextTarget } from "./usageFormat";
import { Modal } from "./Modal";
import { Popover } from "./Popover";
import { useAction } from "./useAction";

/**
 * A pane's context warning: before its session reaches its context limit (and,
 * for Claude, compacts by itself), a chip in its pane header suggests compacting or
 * continuing in a fresh session from a brief. Nothing is typed into the
 * session unless Compact is clicked, and Compact goes only to a session idle
 * at its prompt (compactBlocker, checked again by the main process).
 */

const POLL_MS = 10_000;
const COMPACT_WAIT_MS = 3 * 60_000;
const DISMISS_KEY = "mb.ctxDismissed";
const DISMISS_KEEP = 200;

function readDismissals(): Record<string, Dismissal> {
  const v = readPref<Record<string, Dismissal>>(DISMISS_KEY, {});
  return v && typeof v === "object" ? v : {};
}
function writeDismissal(id: string, d: Dismissal | undefined): void {
  const all = readDismissals();
  if (d) all[id] = d;
  else delete all[id];
  const ids = Object.keys(all);
  for (const old of ids.slice(0, Math.max(0, ids.length - DISMISS_KEEP))) delete all[old];
  writePref(DISMISS_KEY, all);
}

/** A session's context window, re-read every few seconds while its pane is up; null when it has none to read. */
export function useContextReading(session: SessionInfo): ContextWindow | null {
  const target = contextTarget(session);
  const id = "id" in target && session.status !== "dead" ? target.id : null;
  const [cw, setCw] = useState<{ id: string; v: ContextWindow } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () =>
      window.mb.contextWindow(id).then(
        (r: ContextWindow | { error: string }) => {
          if (!live) return;
          if (isErr(r)) console.warn(`context window of ${id}: ${r.error}`);
          setCw({ id, v: isErr(r) ? { state: "error", why: r.error } : r });
        },
        (err: unknown) => console.warn(`context window of ${id}:`, err)
      );
    void read();
    const t = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  return id && cw?.id === id ? cw.v : null;
}

interface WarningState {
  budget: ContextBudget;
  level: 0 | 1 | 2;
  dismiss: () => void;
  compact: () => Promise<void>;
  /** Why Compact can't be sent now, as far as this window knows (the main process checks again). */
  blocked: string | null;
  compacting: boolean;
  error: string;
}

/** The warning's state for a session: its level after any dismissal, and its actions. */
function useWarning(session: SessionInfo, cw: ContextWindow | null): WarningState | null {
  const [dismissed, setDismissed] = useState<Dismissal | undefined>(() => readDismissals()[session.id]);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const budget = cw?.state === "reading" ? contextBudget(cw) : null;
  const level = budget?.level ?? 0;
  // a dismissal ends once the session drops below its level (compacted, or a fresh conversation)
  useEffect(() => {
    if (!budget) return;
    const kept = keepDismissal(dismissed, level);
    if (kept !== dismissed) {
      setDismissed(kept);
      writeDismissal(session.id, kept);
    }
  }, [level, !!budget]);
  // a compaction is over once the agent reports a context below where it was
  // (or after a few minutes without one: the warning then shows what the agent last reported)
  const compacting = sentAt !== null && Date.now() - sentAt < COMPACT_WAIT_MS && !(cw?.state === "reading" && cw.at > sentAt && level === 0);
  useEffect(() => {
    if (sentAt !== null && !compacting) setSentAt(null);
  }, [compacting]);
  if (!budget) return null;
  return {
    budget,
    level: shownLevel(level, dismissed),
    dismiss: () => {
      const d: Dismissal = { level: level === 2 ? 2 : 1 };
      setDismissed(d);
      writeDismissal(session.id, d);
    },
    compact: async () => {
      setError("");
      const r = await window.mb.contextCompact(session.id).catch((err: unknown) => ({ error: (err as Error)?.message ?? String(err) }));
      if (isErr(r)) {
        console.warn(`Compact ${session.id}: ${r.error}`);
        setError(r.error);
        return;
      }
      setSentAt(Date.now());
    },
    blocked: compactBlocker({ status: session.status, shell: !!session.shell, remote: !!session.room?.remote }),
    compacting,
    error,
  };
}

/** "152k of 167k used" (where Claude compacts by itself) / "250k of its 272k window". */
function amount(b: ContextBudget, agent: AgentKind): string {
  return b.autoCompacts ? `${roughTokens(b.tokens)} of ${roughTokens(b.usable)} used` : `${roughTokens(b.tokens)} of its ${roughTokens(b.usable)} window`;
}

/** The warning's words: what's happening, and what the two ways out do. */
function headline(b: ContextBudget, level: 1 | 2): string {
  const pct = Math.min(100, Math.round(b.pct));
  if (b.autoCompacts) return level === 2 ? `Context ${pct}% full: it compacts by itself soon` : `Context ${pct}% full`;
  return level === 2 ? `Context ${pct}% full: nearly out of room` : `Context ${pct}% full`;
}

const explain = (agent: AgentKind, b: ContextBudget) =>
  [
    amount(b, agent) + ".",
    "Compact sends /compact now, on your click: the agent summarizes the conversation and carries on from that.",
    "A fresh session starts beside this one, in the same worktree, from a brief of this conversation (its task, plan, changes and last turns), with the whole transcript there to read.",
    b.autoCompacts ? `Near the limit, ${AGENT_NAME[agent]} compacts by itself and keeps only its own summary.` : "",
  ]
    .filter(Boolean)
    .join("\n");

function Actions({ w, agent, onBrief }: { w: WarningState; agent: AgentKind; onBrief: () => void }) {
  return (
    <>
      <button
        className="outline"
        disabled={!!w.blocked || w.compacting}
        title={w.blocked ?? `Send /compact to this ${AGENT_NAME[agent]} session now`}
        onClick={(e) => {
          e.stopPropagation();
          void w.compact();
        }}
      >
        {w.compacting ? "Compacting…" : "Compact"}
      </button>
      <button
        className="outline"
        title="Start a new session in this worktree from a brief of this one"
        onClick={(e) => {
          e.stopPropagation();
          onBrief();
        }}
      >
        Fresh session with a brief
      </button>
    </>
  );
}

/**
 * The warning on a pane: a chip in its header ("ctx 79%"), amber from 75% of
 * where the agent compacts by itself, red from 90%. It opens a popover with
 * what that means and the actions: Compact, Fresh session with a brief, and
 * Dismiss (until the next threshold).
 */
export function ContextWarning({ session, onBrief }: { session: SessionInfo; onBrief: () => void }) {
  const cw = useContextReading(session);
  const w = useWarning(session, cw);
  const [open, setOpen] = useState(false);
  if (!w || cw?.state !== "reading") return null;
  const { budget: b } = w;
  const agent = cw.agent;
  // Compacting shows until it's done, even once dismissed
  if (!w.level && !w.compacting) return null;
  const level = (w.level || b.level || 1) as 1 | 2;
  const tone = level === 2 ? "firm" : "heads";
  return (
    <span className="ctx-chip-wrap">
      <button
        className={`chip ctx-chip ${tone}`}
        title={explain(agent, b)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {w.compacting ? "compacting…" : `ctx ${Math.min(100, Math.round(b.pct))}%`}
      </button>
      {open && (
        <Popover className={`ctx-pop ${tone}`} onClose={() => setOpen(false)} label="Context">
          <div className="ctx-pop-h">{headline(b, level)}</div>
          <div className="ctx-pop-sub">
            {amount(b, agent)}.{" "}
            {w.compacting
              ? "Compacting: this clears once the agent reports the smaller context."
              : b.autoCompacts
                ? `Near the limit, ${AGENT_NAME[agent]} compacts by itself and keeps only its own summary.`
                : "Compact, or carry on in a fresh session, before it runs out."}
          </div>
          <div className="ctx-acts">
            <Actions
              w={w}
              agent={agent}
              onBrief={() => {
                setOpen(false);
                onBrief();
              }}
            />
            <span style={{ flex: 1 }} />
            <button
              className="outline"
              title={level === 2 ? "Hide it until the context drops and fills again" : "Hide it until 90%"}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                w.dismiss();
              }}
            >
              Dismiss
            </button>
          </div>
          {w.blocked && !w.compacting && <div className="ctx-pop-note">Compact waits: {w.blocked.charAt(0).toLowerCase() + w.blocked.slice(1)}.</div>}
          {w.error && <div className="err">Couldn't compact: {w.error}</div>}
        </Popover>
      )}
    </span>
  );
}

/** The cost line of an estimate, amber when it's big enough to ask about. */
export function CostLine({ doing, e, agent, what }: { doing: string; e: CostEstimate; agent: AgentKind; what?: string }) {
  return (
    <div className={`cost-line ${e.ask ? "big" : ""}`}>
      <div className="cost-say">{costSentence(doing, e, what)}</div>
      <div className="cost-why">{costWhy(e, agent)}</div>
    </div>
  );
}

/**
 * Before an expensive action: the estimate in plain words, with Continue and
 * Cancel. The estimate comes from the conversation's size and the cache
 * multipliers (CostEstimate); a share of the limit only when the plan's
 * reading can give one.
 */
export function CostDialog({ title, doing, e, agent, onAnswer }: { title: string; doing: string; e: CostEstimate; agent: AgentKind; onAnswer: (go: boolean) => void }) {
  return (
    <Modal className="modal cost-dlg" onClose={() => onAnswer(false)}>
      <h3>{title}</h3>
      <CostLine doing={doing} e={e} agent={agent} />
      <div className="sub-h">An estimate from this Mac's sessions: use elsewhere (claude.ai, another computer) isn't counted, so shares can read high.</div>
      <div className="row">
        <button className="outline" onClick={() => onAnswer(false)}>
          Cancel
        </button>
        <button className="primary" autoFocus onClick={() => onAnswer(true)}>
          Continue
        </button>
      </div>
    </Modal>
  );
}

/**
 * Asks with a CostDialog before an action whose estimate says to; returns the
 * gate and the dialog to render. An estimate that can't be read lets the
 * action go ahead (logged): it's a courtesy, not a lock.
 */
export function useCostGate(): { resume: (s: SessionInfo) => Promise<boolean>; dialog: JSX.Element | null } {
  const [ask, setAsk] = useState<{ s: SessionInfo; e: CostEstimate; agent: AgentKind; answer: (go: boolean) => void } | null>(null);
  const resume = async (s: SessionInfo): Promise<boolean> => {
    if (s.shell || s.room?.remote) return true;
    const r: { agent: AgentKind; estimate: CostEstimate } | null | { error: string } = await window.mb.resumeCost(s.id).catch((err: unknown) => ({ error: (err as Error)?.message ?? String(err) }));
    if (isErr(r)) {
      console.warn(`couldn't estimate resuming ${s.id}, resuming anyway: ${r.error}`);
      return true;
    }
    if (!r?.estimate.ask) return true;
    return new Promise<boolean>((answer) => setAsk({ s, e: r.estimate, agent: r.agent, answer }));
  };
  const dialog = ask ? (
    <CostDialog
      title={`Resume ${ask.s.title}?`}
      doing="Resuming this"
      e={ask.e}
      agent={ask.agent}
      onAnswer={(go) => {
        setAsk(null);
        ask.answer(go);
      }}
    />
  ) : null;
  return { resume, dialog };
}

/**
 * Continue a session in a fresh one, from a brief of its conversation built
 * without a model call (the take-over brief, in its refresh mode). The brief
 * can be edited; what starting from it costs is shown before Start.
 */
export function BriefDialog({ session, onClose, onStarted }: { session: SessionInfo; onClose: () => void; onStarted: (next: SessionInfo, closeOld: boolean) => void }) {
  const agent: AgentKind = session.agent ?? "claude";
  const [plan, setPlan] = useState<{ brief: string; estimate: CostEstimate; replaces: number | null } | null>(null);
  const [text, setText] = useState("");
  const [closeOld, setCloseOld] = useState(false);
  const { doing, run, error } = useAction();
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void run("brief", () => window.mb.contextBrief(session.id)).then((r: { brief: string; estimate: CostEstimate; replaces: number | null } | { error: string }) => {
      if (isErr(r)) return;
      setPlan(r);
      setText(r.brief);
    });
  }, [session.id]);
  const start = async () => {
    const r = await run("start", () => window.mb.contextBriefStart(session.id, text));
    if (!isErr(r)) onStarted(r, closeOld);
  };
  return (
    <Modal className="modal brief-dlg" onClose={onClose}>
      <h3>Fresh session with a brief</h3>
      <div className="sub-h">
        A new {AGENT_NAME[agent]} session starts in the same folder ({baseName(session.cwd)}
        {session.branch ? ` · ${session.branch}` : ""}) and group, from this brief of {session.title}: its task, latest plan, changed files and last turns, and where the
        whole transcript is. Edit it if you like.
      </div>
      {plan && <CostLine doing="Starting it" what="sends" e={plan.estimate} agent={agent} />}
      {plan?.replaces ? <div className="sub-h">Instead of the {roughTokens(plan.replaces)} tokens of context this session carries now.</div> : null}
      <label>Brief</label>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder={doing("brief") ? "Reading the conversation…" : ""} style={{ minHeight: 260 }} />
      {error && <div className="err">{error}</div>}
      <label className="check-line" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11, display: "flex" }}>
        <input type="checkbox" checked={closeOld} onChange={(e) => setCloseOld(e.target.checked)} />
        Close this session (it stays under Previous, so it can be resumed)
      </label>
      <div className="row">
        <button className="outline" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={!text.trim() || doing("brief") || doing("start")} onClick={start}>
          {doing("start") ? "Starting…" : `Start ${AGENT_NAME[agent]}`}
        </button>
      </div>
    </Modal>
  );
}
