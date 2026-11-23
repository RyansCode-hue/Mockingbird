import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { assistantModelLabel, type ActionDetail, type AssistantCard, type AssistantRule, type AssistantStep, type AssistantTurn, type AssistantView, type RuleRun } from "../shared/assistant";
import { isErr, type IpcResult } from "../shared/types";
import { ago } from "../shared/format";
import { chatSegments } from "./team/chatText";
import { renderSegment } from "./team/markdownView";
import { ChevronIcon, CloseIcon } from "./Icons";
import { Toggle } from "./Toggle";
import { armFocus, isArmed, keyboardNowhere } from "./keyArm";
import { OVERLAYS, ownsKeys } from "./keys";
import { usePersisted } from "./prefs";
import { ASK_EXAMPLES, askable, askCounter, cardState, lastQuestion, nextChange, undoLive } from "./assistantModel";

/**
 * The app Assistant's window side (docs/assistant.md → The tab and ⌘K): a tab of the side bar's rail, in the area
 * tree's place, where you keep asking. It shows what main says it's doing: the thread (your words, its reply, its steps
 * with Undo on direct changes), the cards waiting on Do it, recent rule runs and the standing rules, with the message
 * box at its foot.
 *
 * Only the message box takes the keyboard: clicked into, or opened for (focusBox). A press anywhere else on the tab
 * leaves the keyboard where it was (a session's terminal, the message box, the landscape), as a press on one of the
 * landscape's own buttons does (Landscape.tsx's onButtonDown, keyArm.ts).
 */

/** The tab's shortcut (main.tsx's keyboard layer), as the rail and Help show it. */
export const ASSISTANT_KEYS = "⇧⌘A";

/** An ask main refused ({ error }, or a rejected call): kept in the thread until Clear, never dropped. */
export interface AskFailure {
  id: number;
  at: number;
  text: string;
  error: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A main-process call, its rejection answered as an { error } the way a handler's own failure is. */
async function settle<T>(what: string, call: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    const r = await call();
    if (isErr(r)) console.error(`[mockingbird] the Assistant's ${what} failed: ${r.error}`);
    return r;
  } catch (err) {
    console.error(`[mockingbird] the Assistant's ${what} failed:`, err);
    return { error: errorText(err) };
  }
}

/**
 * The Assistant's view, read again whenever main says it changed, and asking it. What's typed in the message box lives
 * here too, so a question half-written survives the tab being closed and opened again.
 */
export function useAssistant() {
  const [view, setView] = useState<AssistantView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [failures, setFailures] = useState<AskFailure[]>([]);
  const [draft, setDraft] = useState("");
  /** Asks for the message box to take the keyboard, counted: the tab answers each once (focusSeen), mounted or not yet. */
  const [focusAsk, setFocusAsk] = useState(0);
  const focusSeen = useRef(0);
  const reads = useRef(0);
  const failId = useRef(0);
  /** The view last shown, as main sent it: a read that brings nothing new renders nothing (App, the landscape in it). */
  const shown = useRef("");
  const reload = useCallback(async () => {
    const n = ++reads.current;
    const r = await settle("view read", () => window.mb.assistantView());
    // an older read answering late never replaces a newer one
    if (n !== reads.current) return;
    if (isErr(r)) return setReadError(r.error);
    setReadError(null);
    const json = JSON.stringify(r);
    if (json === shown.current) return;
    shown.current = json;
    setView(r);
  }, []);
  useEffect(() => {
    void reload();
    return window.mb.onAssistantChanged(() => void reload());
  }, [reload]);
  const ask = useCallback(
    async (text: string) => {
      const r = await settle("ask", () => window.mb.assistantAsk(text));
      if (isErr(r)) setFailures((f) => [...f, { id: ++failId.current, at: Date.now(), text, error: r.error }]);
      void reload();
    },
    [reload]
  );
  const clearFailures = useCallback(() => setFailures([]), []);
  const focusBox = useCallback(() => setFocusAsk((n) => n + 1), []);
  return { view, readError, failures, ask, reload, clearFailures, draft, setDraft, focusAsk, focusSeen, focusBox };
}
export type AssistantState = ReturnType<typeof useAssistant>;

/** What a press may land on in the tab and act: its buttons, switches and links. */
const CONTROLS = "button, [role=button], [role=switch], a[href]";
/** Text a press may start selecting (the thread's words, and what a card or a rule types). */
const SELECTABLE = ".as-text, .as-payload";

/** Light markdown, as team chat shows it: parsed into elements, never HTML. */
function Words({ text, className }: { text: string; className: string }) {
  const segs = useMemo(() => chatSegments(text, [], ""), [text]);
  return <div className={`as-text ${className}`}>{segs.map((s, i) => renderSegment(s, i))}</div>;
}

/** The text a card or a rule's action types, sends or publishes, whole: plain text in a scrolling block, never HTML. */
function Payload({ text }: { text: string }) {
  return <pre className="as-payload">{text}</pre>;
}

/** A rule's actions as main spells them out: each line, what it types whole, and what to know about it. */
function Actions({ actions }: { actions: ActionDetail[] }) {
  return (
    <ol className="as-acts">
      {actions.map((a, i) => (
        <li key={i} className={`as-act${a.danger ? " danger" : ""}`}>
          <div className="as-act-l">{a.line}</div>
          {a.body !== undefined && <Payload text={a.body} />}
          {a.warnings.length > 0 && (
            <ul className="as-card-warn">
              {a.warnings.map((w, j) => (
                <li key={j}>{w}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

type ThreadItem = { kind: "turn"; at: number; turn: AssistantTurn } | { kind: "failure"; at: number; failure: AskFailure };
type Busy = (key: string) => boolean;
type Act = (key: string, errKey: string, call: () => Promise<IpcResult<unknown>>) => void;

/**
 * The tab. `home`: what a press on it arms when the keyboard was nowhere or on the tab itself (the landscape, or the
 * workspace in focus); `onEscape`: Esc in it that nothing inside took, which hands the keyboard back there.
 */
export function AssistantTab({ assistant, home, onClose, onEscape }: { assistant: AssistantState; home: () => HTMLElement | null; onClose: () => void; onEscape: () => void }) {
  const { view, readError, failures, reload, clearFailures, draft, setDraft, ask } = assistant;
  const tab = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingNow = useRef(pending);
  pendingNow.current = pending;
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [rulesOpen, setRulesOpen] = usePersisted("mb.assistant.rulesOpen", false);
  // re-rendered as an Undo's window closes or a card lapses
  const [, setTick] = useState(0);
  const now = Date.now();
  useEffect(() => {
    if (!view) return;
    const at = nextChange(view, Date.now());
    if (at === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, at - Date.now()) + 25);
    return () => clearTimeout(t);
  });
  // the box takes the keyboard when asked: before a closing palette or dialog hands it back elsewhere (useDialogFocus)
  useLayoutEffect(() => {
    if (assistant.focusAsk === assistant.focusSeen.current) return;
    assistant.focusSeen.current = assistant.focusAsk;
    box.current?.focus({ preventScroll: true });
  }, [assistant.focusAsk, assistant.focusSeen]);

  const act: Act = (key, errKey, call) => {
    if (pendingNow.current.has(key)) return;
    pendingNow.current = new Set([...pendingNow.current, key]);
    setPending(pendingNow.current);
    setErrors((e) => {
      const rest = { ...e };
      delete rest[errKey];
      return rest;
    });
    void settle(key, call).then((r) => {
      const left = new Set(pendingNow.current);
      left.delete(key);
      pendingNow.current = left;
      setPending(left);
      if (isErr(r)) setErrors((e) => ({ ...e, [errKey]: r.error }));
      void reload();
    });
  };
  const busy: Busy = (key) => pending.has(key);

  /**
   * A press on the tab never takes the keyboard, the message box aside: a terminal or a field being typed in keeps it,
   * as does anything else outside the tab that has it; from the tab itself, or from nowhere, the landscape (or focus's
   * frame) takes it armed, as a press on one of the landscape's own buttons gives it. A press on the thread's words may
   * start a selection: the keyboard goes back where it was unless one was made.
   */
  const onPress = (e: ReactMouseEvent) => {
    if (e.button !== 0 || !tab.current) return;
    const t = e.target as Element;
    if (t === box.current) return;
    if (!t.closest(CONTROLS) && t.closest(SELECTABLE)) {
      const had = document.activeElement;
      const wasArmed = isArmed(had);
      // the press itself put the keyboard on the tab (it's focusable, for Tab), or nowhere
      const back = () =>
        setTimeout(() => {
          const lost = keyboardNowhere() || document.activeElement === tab.current;
          if (!lost || !window.getSelection()?.isCollapsed || !(had instanceof HTMLElement) || !had.isConnected || had === tab.current) return;
          if (wasArmed) armFocus(had);
          else had.focus({ preventScroll: true });
        }, 0);
      window.addEventListener("mouseup", back, { once: true, capture: true });
      return;
    }
    e.preventDefault();
    const a = document.activeElement;
    if (ownsKeys(a) || (!keyboardNowhere() && !tab.current.contains(a))) return;
    armFocus(home());
  };
  /** A control of its own that went (a card settled), hid or went off from under the keyboard leaves it on the tab, not the page. */
  const onBlur = (e: ReactFocusEvent) => {
    const t = e.target as HTMLElement;
    if (e.relatedTarget || !document.hasFocus() || t === tab.current) return;
    setTimeout(() => {
      if (!keyboardNowhere() || (t.isConnected && t.getClientRects().length > 0 && !(t as HTMLButtonElement).disabled)) return;
      tab.current?.focus({ preventScroll: true });
    }, 0);
  };
  /** Esc that nothing inside took hands the keyboard back; the tab stays open. */
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(OVERLAYS)) return;
    e.preventDefault();
    e.stopPropagation();
    onEscape();
  };

  const cards = useMemo(() => new Map((view?.cards ?? []).map((c) => [c.id, c])), [view]);
  const placed = useMemo(() => new Set((view?.turns ?? []).flatMap((t) => t.steps.map((s) => s.cardId)).filter((id): id is string => !!id && cards.has(id))), [view, cards]);
  const loose = (view?.cards ?? []).filter((c) => !placed.has(c.id));
  const thread = useMemo(
    (): ThreadItem[] => [...(view?.turns ?? []).map((turn) => ({ kind: "turn" as const, at: turn.at, turn })), ...failures.map((failure) => ({ kind: "failure" as const, at: failure.at, failure }))].sort((a, b) => a.at - b.at),
    [view, failures]
  );

  // the newest turn kept in view as it grows, unless the user has scrolled up to read; opening, or asking, shows the newest
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = thread[thread.length - 1];
  const lastKey = !last ? "" : last.kind === "turn" ? `${last.turn.id}:${last.turn.state}:${last.turn.steps.length}:${last.turn.reply?.length ?? 0}` : `f${last.failure.id}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, thread.length]);

  const rules = view?.rules ?? [];
  const onCount = rules.filter((r) => r.on && !r.paused).length;
  const pausedCount = rules.filter((r) => !!r.paused).length;
  const runs = (view?.runs ?? []).slice(-5).reverse();
  const empty = !thread.length && !loose.length && !runs.length;

  const clear = () =>
    act("clear", "clear", async () => {
      const r = await window.mb.assistantClear();
      if (!isErr(r)) clearFailures();
      return r;
    });

  // ---- the message box: ⏎ asks (queued behind a turn that's running, as main runs them), ⇧⏎ is a new line ----
  const unavailable = view?.unavailable;
  const check = askable(draft);
  const tooLong = !check.ok && check.why !== null;
  const send = () => {
    if (unavailable || !check.ok) return;
    setDraft("");
    pinned.current = true;
    void ask(check.text);
    box.current?.focus({ preventScroll: true });
  };
  const onBoxKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      // an IME's Enter picks its candidate; a held Enter's repeats ask nothing more
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      if (!e.repeat) send();
      return;
    }
    if (e.key === "ArrowUp" && !draft && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const q = lastQuestion(view?.turns ?? [], failures);
      if (!q) return;
      e.preventDefault();
      setDraft(q);
    }
  };
  const fill = (text: string) => {
    setDraft(text);
    box.current?.focus({ preventScroll: true });
  };

  return (
    <section ref={tab} className="as-tab" data-tool="assistant" aria-label="Assistant" tabIndex={-1} onMouseDown={onPress} onBlur={onBlur} onKeyDown={onKey}>
      <div className="side-head as-head">
        <span className="side-title">Assistant</span>
        {view && (
          <span className="as-model" data-tip="The model it runs: Settings → Assistant">
            {assistantModelLabel(view.model)}
          </span>
        )}
        {view?.busy && <span className="dot working sm" title="Working on a question" aria-label="Working" />}
        <span className="as-spacer" />
        <button type="button" className="as-hbtn" aria-disabled={busy("clear") || undefined} data-tip="Start a fresh thread: open cards stay" onClick={() => !busy("clear") && clear()}>
          Clear
        </button>
        <button type="button" className="ls-win-btn as-close" aria-label="Close the Assistant" data-tip={`Close (${ASSISTANT_KEYS})`} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {errors.clear && (
        <div className="as-err" role="alert">
          Couldn't clear: {errors.clear}
        </div>
      )}
      {readError && (
        <div className="as-err" role="alert">
          Couldn't read the Assistant: {readError}{" "}
          <button type="button" className="as-link" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}
      {view?.threadProblem && (
        <div className="as-err as-thread-problem" role="alert">
          {view.threadProblem}
        </div>
      )}
      {unavailable && <div className="as-unavail">Can't ask on this Mac: {unavailable}</div>}
      <div
        className="as-body"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!view && !readError && <div className="as-quiet">Reading…</div>}
        {view && empty && (
          <div className="as-empty">
            <div className="as-quiet">Ask about your sessions, or for a change to them. Anything bigger than a small change waits for your OK.</div>
            {!unavailable && (
              <div className="as-examples" role="group" aria-label="Try">
                {ASK_EXAMPLES.map((x) => (
                  <button key={x} type="button" className="as-example" data-tip="Put it in the box" onClick={() => fill(x)}>
                    {x}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {thread.map((item) =>
          item.kind === "turn" ? (
            <Turn key={item.turn.id} turn={item.turn} cards={cards} now={now} busy={busy} act={act} errors={errors} />
          ) : (
            <div key={`f${item.failure.id}`} className="as-turn" data-state="error" data-failure={item.failure.id}>
              <Words className="as-you" text={item.failure.text} />
              <div className="as-reply error" role="alert">
                Couldn't ask: {item.failure.error}
              </div>
            </div>
          )
        )}
        {loose.length > 0 && (
          <section className="as-sec" aria-label="Cards">
            <div className="as-sec-h">Cards</div>
            {loose.map((c) => (
              <Card key={c.id} card={c} now={now} busy={busy} act={act} error={errors[c.id]} />
            ))}
          </section>
        )}
        {runs.length > 0 && (
          <section className="as-sec" aria-label="Rule runs">
            <div className="as-sec-h">Rule runs</div>
            {runs.map((r) => (
              <Run key={r.id} run={r} rule={rules.find((x) => x.id === r.ruleId)} now={now} busy={busy} act={act} errors={errors} />
            ))}
          </section>
        )}
      </div>
      <section className={`as-rules ${rulesOpen ? "open" : ""}`} aria-label="Rules">
        <button type="button" className="as-rules-h" aria-expanded={rulesOpen} onClick={() => setRulesOpen((o) => !o)}>
          <ChevronIcon open={rulesOpen} />
          <span>Rules</span>
          <span className="as-rules-n">· {rules.length ? `${onCount} on${pausedCount ? ` · ${pausedCount} paused` : ""}` : "none"}</span>
        </button>
        {view?.rulesProblem && (
          <div className="as-err as-rules-problem" role="alert">
            {view.rulesProblem}
          </div>
        )}
        {rulesOpen && (
          <div className="as-rules-list">
            {!rules.length && <div className="as-quiet">None yet. Ask for one: "when tests finishes, start the review".</div>}
            {rules.map((r) => (
              <Rule key={r.id} rule={r} now={now} busy={busy} act={act} error={errors[r.id]} />
            ))}
          </div>
        )}
      </section>
      <div className="as-ask">
        <textarea
          ref={box}
          className="as-input"
          rows={1}
          value={draft}
          disabled={!!unavailable}
          placeholder={unavailable ? "Can't ask on this Mac" : "Ask the Assistant…"}
          aria-label="Ask the Assistant"
          aria-invalid={tooLong || undefined}
          title="⏎ asks · ⇧⏎ new line · ↑ in an empty box brings back your last question"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onBoxKey}
        />
        <div className="as-ask-foot">
          {tooLong ? (
            <span className="as-over" aria-live="polite">
              {check.why}
            </span>
          ) : (
            <span className="as-ask-hint">{askCounter(draft) ?? "⏎ ask · ⇧⏎ new line"}</span>
          )}
          <button type="button" className="as-send primary" aria-disabled={!!unavailable || !check.ok || undefined} onClick={send}>
            Ask
          </button>
        </div>
      </div>
    </section>
  );
}


function Turn({ turn, cards, now, busy, act, errors }: { turn: AssistantTurn; cards: Map<string, AssistantCard>; now: number; busy: Busy; act: Act; errors: Readonly<Record<string, string>> }) {
  return (
    <div className="as-turn" data-turn={turn.id} data-state={turn.state}>
      <Words className="as-you" text={turn.text} />
      {turn.state === "queued" && <div className="as-wait">Waiting for the question before it to finish…</div>}
      {turn.state === "thinking" && (
        <div className="as-wait thinking">
          <span className="dot working sm" aria-hidden="true" />
          Thinking…
        </div>
      )}
      {turn.steps.map((s) => {
        const card = s.cardId ? cards.get(s.cardId) : undefined;
        // a card is shown whole while it waits on the user; once answered it's its step's line, with how it went
        if (card && cardState(card, now) === "open") return <Card key={s.id} card={card} now={now} busy={busy} act={act} error={errors[card.id]} />;
        return <Step key={s.id} step={s} card={card} now={now} busy={busy} act={act} error={errors[card?.id ?? s.id]} />;
      })}
      {turn.reply ? (
        <Words className={`as-reply ${turn.state === "error" ? "error" : ""}`} text={turn.reply} />
      ) : (
        turn.state === "error" && <div className="as-reply error">This question failed without saying why</div>
      )}
    </div>
  );
}

const STEP_STATE: Record<AssistantStep["state"], string> = { running: "Running", done: "Done", failed: "Failed", proposed: "Waiting on your OK", undone: "Undone" };
const SETTLED: Record<Exclude<AssistantCard["state"], "open">, string> = { running: "Running…", done: "Done", failed: "Failed", cancelled: "Cancelled", expired: "Expired" };

/** A step's line. `card`: the answered card it put up, whose state and outcome it shows. */
function Step({ step, card, now, busy, act, error }: { step: AssistantStep; card?: AssistantCard; now: number; busy: Busy; act: Act; error?: string }) {
  const undoable = undoLive(step, now);
  const key = `undo:${step.id}`;
  const settled = card ? (cardState(card, now) as Exclude<AssistantCard["state"], "open">) : null;
  const state = settled ?? step.state;
  const said = settled ? SETTLED[settled] : STEP_STATE[step.state];
  return (
    <div className={`as-step st-${state}`} data-step={step.id} data-card={card?.id}>
      <span className="as-mark" role="img" aria-label={said} title={said} />
      <span className="as-step-l">
        {step.label}
        {step.state === "undone" && <span className="as-step-note"> · undone</span>}
        {settled && settled !== "running" && <span className={`as-step-res ${settled === "failed" ? "failed" : ""}`}>{card?.result ?? said}</span>}
        {undoable && (
          <>
            {" · "}
            <button type="button" className="as-link as-undo" aria-disabled={busy(key) || undefined} data-tip="Put it back as it was" onClick={() => !busy(key) && act(key, step.id, () => window.mb.assistantUndo(step.id))}>
              Undo
            </button>
          </>
        )}
        {step.error && <span className="as-step-err">{step.error}</span>}
        {error && (
          <span className="as-step-err" role="alert">
            {card ? error : `Couldn't undo: ${error}`}
          </span>
        )}
      </span>
    </div>
  );
}

/** A card: whole while it waits on Do it or Cancel; once answered, a line with how it went (one no turn holds). */
function Card({ card, now, busy, act, error }: { card: AssistantCard; now: number; busy: Busy; act: Act; error?: string }) {
  const state = cardState(card, now);
  const confirmKey = `confirm:${card.id}`;
  const cancelKey = `cancel:${card.id}`;
  const either = busy(confirmKey) || busy(cancelKey);
  if (state !== "open") {
    return (
      <div className={`as-card settled st-${state}`} data-card={card.id} data-state={state}>
        <span className="as-mark" aria-hidden="true" />
        <div className="as-card-main">
          <div className="as-card-t">{card.title}</div>
          <div className="as-card-res">{card.result ?? SETTLED[state]}</div>
          {error && (
            <div className="as-card-err" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={`as-card${card.danger ? " danger" : ""}${card.blocked ? " blocked" : ""}`} data-card={card.id} data-state="open">
      <div className="as-card-t">{card.title}</div>
      {card.detail && <div className="as-card-d">{card.detail}</div>}
      {card.body !== undefined && <Payload text={card.body} />}
      {card.actions && card.actions.length > 0 && <Actions actions={card.actions} />}
      {card.warnings.length > 0 && (
        <ul className="as-card-warn">
          {card.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {card.blocked && <div className="as-card-blocked">Can't be done now: {card.blocked}</div>}
      <div className="as-card-acts">
        <button
          type="button"
          className={`as-do ${card.danger ? "danger" : "primary"}`}
          aria-disabled={either || undefined}
          onClick={() => !either && act(confirmKey, card.id, () => window.mb.assistantConfirm(card.id))}
        >
          {busy(confirmKey) ? "Doing it…" : "Do it"}
        </button>
        <button type="button" className="as-cancel outline" aria-disabled={either || undefined} onClick={() => !either && act(cancelKey, card.id, () => window.mb.assistantCancel(card.id))}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="as-card-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function Run({ run, rule, now, busy, act, errors }: { run: RuleRun; rule?: AssistantRule; now: number; busy: Busy; act: Act; errors: Readonly<Record<string, string>> }) {
  return (
    <div className={`as-run ${run.ok ? "ok" : "failed"}`} data-run={run.id}>
      <div className="as-run-h">
        <span className="as-mark" role="img" aria-label={run.ok ? "Ran" : "Failed"} />
        <span className="as-run-t">{run.text}</span>
        <span className="as-run-at">{ago(run.at, now)}</span>
      </div>
      {rule && <div className="as-run-rule">{rule.label}</div>}
      {run.steps.map((s) => (
        <Step key={s.id} step={s} now={now} busy={busy} act={act} error={errors[s.id]} />
      ))}
    </div>
  );
}

function Rule({ rule, now, busy, act, error }: { rule: AssistantRule; now: number; busy: Busy; act: Act; error?: string }) {
  // a rule Mockingbird paused runs no more: its switch is off until it's turned on again, which clears the pause
  const running = rule.on && !rule.paused;
  const onKey = `rule:${rule.id}`;
  const removeKey = `remove:${rule.id}`;
  let lastRun: ReactNode = null;
  if (rule.lastRun) lastRun = <div className={`as-rule-last ${rule.lastRun.ok ? "" : "failed"}`}>{`${rule.lastRun.ok ? "Ran" : "Failed"} ${ago(rule.lastRun.at, now)}: ${rule.lastRun.text}`}</div>;
  return (
    <div className={`as-rule ${running ? "on" : ""}`} data-rule={rule.id}>
      <Toggle on={running} label={`${rule.label}: ${running ? "on" : "off"}`} disabled={busy(onKey)} onChange={(v) => act(onKey, rule.id, () => window.mb.assistantRuleOn(rule.id, v))} />
      <div className="as-rule-main">
        <div className="as-rule-l">{rule.label}</div>
        {rule.paused && <div className="as-rule-paused">Paused: {rule.paused}</div>}
        {rule.unsaved && <div className="as-rule-unsaved">{rule.unsaved}</div>}
        {/* the label is the model's words: what the rule does is main's account of each action */}
        <Actions actions={rule.actions.map((a) => a.detail ?? { line: a.label, warnings: [] })} />
        {lastRun}
        {error && (
          <div className="as-card-err" role="alert">
            {error}
          </div>
        )}
      </div>
      <button type="button" className="as-link as-remove" aria-disabled={busy(removeKey) || undefined} aria-label={`Remove ${rule.label}`} onClick={() => !busy(removeKey) && act(removeKey, rule.id, () => window.mb.assistantRuleRemove(rule.id))}>
        Remove
      </button>
    </div>
  );
}
