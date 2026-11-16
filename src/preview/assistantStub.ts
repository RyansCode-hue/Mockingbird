/**
 * The UI preview's stand-in for main's app Assistant (docs/assistant.md): the view, asking, cards, Undo and rules,
 * answered from fixtures. Nothing runs: no claude turn, no tool, no rule. stub.ts spreads `assistantApi` into
 * `window.mb`, which records every call in window.__mbCalls as it does for the rest.
 *
 * The query picks what it shows:
 * - ?assistant=open: the sheet open on a thread with a done direct step and a live Undo, an undone and a failed step, a
 *   running step, a proposed card, a danger card, a blocked card and a settled one, two rules (one on, one paused) and
 *   a rule run. Without ?assistant the same fixtures stand behind a closed sheet.
 * - ?assistant=empty: the sheet open on nothing yet. ?assistant=unavailable: the sheet open, and asking can't work on
 *   this Mac (the Ask row dimmed with the reason).
 * - ?assistantUndoMs=<ms>: the live Undo's window closes that long after load (else 4 minutes).
 * - ?assistantMs=<ms>: each simulated step takes this long (else 300): an ask goes queued → thinking → answered, Do it
 *   and Cancel answer after one step, and a card Do it ran is done one step later.
 * - ?assistantAsk=error: asking answers { error }, as main does when it refuses one.
 * - ?assistantRulesProblem: the rules file couldn't be read, and was kept aside: the Rules section says so.
 */
import { ASSISTANT_LIMITS, type AssistantCard, type AssistantRule, type AssistantStep, type AssistantTurn, type AssistantView, type RuleRun } from "../shared/assistant";

type Emit = (name: string, ...args: unknown[]) => void;

const min = 60_000;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const err = (error: string) => ({ error });

/** The fixture view the query asks for, `now` its clock. */
export function assistantFixtures(mode: string | null, now: number, undoMs: number): AssistantView {
  if (mode === "empty" || mode === "unavailable") {
    return { turns: [], cards: [], rules: [], runs: [], busy: false, ...(mode === "unavailable" ? { unavailable: "Claude Code isn't installed: the Assistant runs its turns on it" } : {}) };
  }
  const t1: AssistantTurn = {
    id: "t1",
    at: now - 6 * min,
    text: "put the atticus workspaces together, rename api to api-fix and make codex-review large",
    state: "done",
    reply: "Moved **3** workspaces to `atticus` and renamed *api*. I couldn't size codex-review: it's in a stack.",
    steps: [
      { id: "st1", tool: "move_to_group", tier: "direct", label: "Moved 3 to atticus", state: "done", undoUntil: now + undoMs },
      { id: "st2", tool: "rename", tier: "direct", label: "Renamed api to api-fix", state: "undone" },
      { id: "st3", tool: "size", tier: "direct", label: "Size codex-review large", state: "failed", error: "It's in a stack: size the stack instead" },
    ],
  };
  const t2: AssistantTurn = {
    id: "t2",
    at: now - 2 * min,
    text: "restart api-fix in plan mode, allow codex-review's Bash once, and tidy up after old-spike",
    state: "done",
    reply: "Restarting api-fix now. The rest need your OK below.",
    steps: [
      { id: "st4", tool: "restart", tier: "confirm", label: "Restarting api-fix in plan mode…", state: "running", cardId: "c1" },
      { id: "st5", tool: "answer_prompt", tier: "confirm", label: "Allow codex-review's Bash once", state: "proposed", cardId: "c2" },
      { id: "st6", tool: "worktree_cleanup", tier: "confirm", label: "Delete old-spike's worktree", state: "proposed", cardId: "c3" },
      { id: "st7", tool: "push", tier: "confirm", label: "Push 5101-orgDropdowns", state: "proposed", cardId: "c4" },
      { id: "st8", tool: "close", tier: "confirm", label: "Close test runner", state: "done", cardId: "c5" },
    ],
  };
  const expires = now + ASSISTANT_LIMITS.cardMs;
  const cards: AssistantCard[] = [
    { id: "c1", turnId: "t2", tool: "restart", title: "Restart api-fix in plan mode", detail: "Stops its current turn and resumes the same conversation in plan mode.", warnings: [], state: "running", expiresAt: expires },
    { id: "c2", turnId: "t2", tool: "answer_prompt", title: "Allow codex-review's Bash once?", detail: "Answers the prompt showing now: Bash runs npm test in 5101-orgDropdowns, this once.", warnings: [], state: "open", blocked: null, expiresAt: expires },
    {
      id: "c3",
      turnId: "t2",
      tool: "worktree_cleanup",
      title: "Delete old-spike's worktree",
      detail: "Removes the worktree folder and its branch spike-org-cache.",
      warnings: ["2 uncommitted changes would be lost", "1 commit isn't pushed"],
      danger: true,
      state: "open",
      blocked: null,
      expiresAt: expires,
    },
    { id: "c4", turnId: "t2", tool: "push", title: "Push 5101-orgDropdowns", detail: "Pushes the branch to origin.", warnings: [], state: "open", blocked: "Nothing to push: it's up to date with origin", expiresAt: expires },
    { id: "c5", turnId: "t2", tool: "close", title: "Close test runner", detail: "Ends the terminal.", warnings: [], state: "done", result: "Done: its terminal ended", expiresAt: expires },
  ];
  const rules: AssistantRule[] = [
    {
      id: "rule1",
      label: "When tests finishes, start the review",
      trigger: { kind: "finished", target: { session: "s4" } },
      actions: [{ tool: "start_review", args: { branch: "5101-orgDropdowns" }, label: "Start the review session" }],
      on: true,
      createdAt: now - 3 * 60 * min,
      paused: null,
      lastRun: { at: now - 20 * min, ok: true, text: "Started codex-review" },
    },
    {
      id: "rule2",
      label: "At 9:00 on weekdays, text me what's waiting",
      trigger: { kind: "daily", at: "09:00", days: [1, 2, 3, 4, 5] },
      actions: [{ tool: "text_me", args: { text: "Check what's waiting" }, label: "Text me: “Check what's waiting”" }],
      on: true,
      createdAt: now - 2 * 24 * 60 * min,
      paused: "3 runs failed in a row: Messages isn't allowed to send",
      lastRun: { at: now - 7 * 60 * min, ok: false, text: "Messages isn't allowed to send" },
    },
  ];
  const runs: RuleRun[] = [{ id: "run1", ruleId: "rule1", at: now - 20 * min, ok: true, text: "Started review · tests finished", steps: [{ id: "rs1", tool: "start_review", tier: "confirm", label: "Started codex-review on 5101-orgDropdowns", state: "done" }] }];
  return { turns: [t1, t2], cards, rules, runs, busy: false };
}

/** The assistant's window.mb methods over the fixtures; `emit` tells the window as main's events would. */
export function assistantApi(emit: Emit, params: URLSearchParams): Record<string, (...a: any[]) => any> {
  const mode = params.get("assistant");
  const stepMs = Number(params.get("assistantMs")) || 300;
  const view = assistantFixtures(mode, Date.now(), Number(params.get("assistantUndoMs")) || 4 * min);
  if (params.has("assistantRulesProblem")) {
    view.rulesProblem = "Your rules file couldn't be read: it isn't valid JSON (Unexpected end of JSON input). It's kept as ~/.mockingbird/assistant-rules.json.corrupt-1763300000000. The 2 rules that could be read are kept.";
  }
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), Math.min(stepMs, 120)));
  const wait = () => new Promise<void>((r) => setTimeout(r, stepMs));
  const changed = () => emit("onAssistantChanged");
  const allSteps = (): AssistantStep[] => [...view.turns.flatMap((t) => t.steps), ...view.runs.flatMap((r) => r.steps)];
  /** Turns waiting to run, oldest first: one at a time, as main runs them. */
  const queue: AssistantTurn[] = [];
  let turnN = 0;
  const runNext = () => {
    const turn = queue[0];
    if (!turn) return;
    setTimeout(() => {
      turn.state = "thinking";
      changed();
      setTimeout(() => {
        turn.state = "done";
        turn.reply = `Here's what I'd do for "${turn.text}" — in the preview nothing runs, so this is all.`;
        turn.steps = [{ id: `${turn.id}-s1`, tool: "list_sessions", tier: "read", label: "Read the sessions", state: "done" }];
        queue.shift();
        view.busy = queue.length > 0;
        changed();
        runNext();
      }, stepMs);
    }, stepMs);
  };
  return {
    assistantView: async () => later(clone(view)),
    assistantAsk: async (text: unknown) => {
      if (typeof text !== "string" || !text.trim()) return err("Ask something: the question was empty");
      if (text.length > ASSISTANT_LIMITS.maxQuestion) return err(`That's longer than the Assistant takes (${ASSISTANT_LIMITS.maxQuestion} characters)`);
      if (view.unavailable) return err(view.unavailable);
      if (params.get("assistantAsk") === "error") return later(err("The Assistant couldn't start a turn: claude exited with code 1"));
      const turn: AssistantTurn = { id: `ask${++turnN}`, at: Date.now(), text, state: "queued", steps: [] };
      view.turns = [...view.turns, turn].slice(-ASSISTANT_LIMITS.turnsKept);
      queue.push(turn);
      view.busy = true;
      changed();
      if (queue.length === 1) runNext();
      return later({ turnId: turn.id });
    },
    // main checks the card's guards again before it answers: the call takes a step, the card still open meanwhile
    assistantConfirm: async (cardId: unknown) => {
      await wait();
      const card = view.cards.find((c) => c.id === cardId);
      if (!card) return err("That card is gone");
      if (card.state !== "open") return err(`That card was ${card.state} already`);
      if (card.blocked) return err(card.blocked);
      card.state = "running";
      const step = allSteps().find((s) => s.cardId === card.id);
      if (step) step.state = "running";
      changed();
      setTimeout(() => {
        card.state = "done";
        card.result = "Done (in the preview nothing ran)";
        if (step) step.state = "done";
        changed();
      }, stepMs);
      return clone(card);
    },
    assistantCancel: async (cardId: unknown) => {
      await wait();
      const card = view.cards.find((c) => c.id === cardId);
      if (!card) return err("That card is gone");
      if (card.state !== "open") return err(`That card was ${card.state} already`);
      card.state = "cancelled";
      card.result = "Cancelled: nothing was changed";
      changed();
      return clone(card);
    },
    assistantUndo: async (stepId: unknown) => {
      const step = allSteps().find((s) => s.id === stepId);
      if (!step) return err("That step is gone");
      if (step.tier !== "direct" || step.state !== "done" || !step.undoUntil) return err("There's nothing to undo on that step");
      if (step.undoUntil <= Date.now()) return err("Its Undo has run out: it was 10 minutes");
      step.state = "undone";
      delete step.undoUntil;
      changed();
      return later(clone(step));
    },
    assistantRuleOn: async (ruleId: unknown, on: unknown) => {
      const rule = view.rules.find((r) => r.id === ruleId);
      if (!rule) return err("That rule is gone");
      rule.on = on === true;
      if (rule.on) rule.paused = null;
      changed();
      return later(clone(rule));
    },
    assistantRuleRemove: async (ruleId: unknown) => {
      if (!view.rules.some((r) => r.id === ruleId)) return err("That rule is gone");
      view.rules = view.rules.filter((r) => r.id !== ruleId);
      changed();
      return later({ ok: true as const });
    },
    assistantClear: async () => {
      // a fresh thread: open cards stay, as main keeps them
      view.turns = view.turns.filter((t) => queue.includes(t));
      view.cards = view.cards.filter((c) => c.state === "open");
      changed();
      return later({ ok: true as const });
    },
  };
}

/**
 * ?assistant=…: the sheet opened once the landscape is there, as main's openSheet does; ?assistantRules: its Rules
 * unfolded. ?assistantPalette=<text>: ⌘K opened with that typed, for a look at the Ask row.
 */
export function openAssistantSheet(emit: Emit, params: URLSearchParams): void {
  if (params.has("assistantRules")) localStorage.setItem("mb.assistant.rulesOpen", "true");
  const typed = params.get("assistantPalette");
  if (!params.get("assistant") && typed === null) return;
  const go = () => {
    if (params.get("assistant")) emit("onAssistantWindow", { kind: "openSheet" });
    if (typed === null) return;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(".palette input");
      if (!input) return console.warn("[ui-preview] ⌘K opened no palette to type the Ask into");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, typed);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 200);
  };
  // the window listens once the landscape has mounted: said any earlier, nothing would hear it
  let tries = 600;
  const t = setInterval(() => {
    if (document.querySelector(".ls-viewport")) {
      clearInterval(t);
      return go();
    }
    if (--tries > 0) return;
    clearInterval(t);
    console.warn("[ui-preview] the landscape never mounted: the Assistant's sheet wasn't opened");
  }, 100);
}
