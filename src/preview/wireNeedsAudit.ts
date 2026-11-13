/**
 * W5 in the UI preview (docs/landscape-wires.md): Needs you's wire and pull request items, and Finish step.
 *
 * `?landscapeNeedsAudit=w` (with ?lsWires&lsGates, on 5120 at 100%: lsCamera=0,3040,1, at 1600×1000) works them as a
 * person would, the mouse and keys pressed for real by the test's driver (needsYouAudit.ts' `drive`), and reports into
 * needsYouAudit's <script> for test/uiLandscapeNeeds.test.ts:
 * - CostDialog asked from a send popover opened as Builder's terminal was typed in, the popover gone (its wire removed)
 *   before Esc: the keyboard on the landscape, nothing sent;
 * - the tray: the wires waiting on you (Fixtures → Spike ready, its other end closed; Reviewer → Builder's changes ready,
 *   round 2 of 3; Builder → Reviewer may have arrived) and 5120's pull request that can't be read, with their acts;
 * - Reviewer finished and idle, no summary since its last prompt, its Finished item's Finish step…: the popover from
 *   its latest message, keys of a burst begun before it opened pressing nothing, Finish step off till a verdict is
 *   picked, held as the verdict changes what it does (Builder's waiting changes replaced, said); a turn ending as it's
 *   open read in again, a click 12 ms after taking nothing; changes typed, kept through a press outside and back as it
 *   opens again; another turn ending, the newer message offered beside them; then the one wires:finish with the words
 *   and verdict shown, and the Finished item offering Finish step… no more;
 * - the same pending blocked (Builder's hooks silent), then ready: a click where Show was as Send comes there let go;
 * - Send on Reviewer → Builder's changes: Enter on it pressing nothing, a click as a newer finish lands under it let
 *   go, one in the same task as a newer finish (before the tray draws it) sending nothing and showing the gate, then the
 *   one wires:send of the pending shown; a double click's Send on Fixtures → Spike sending once, its closed end's cost
 *   asked;
 * - Show on what may have arrived: its send popover, the tray away, Esc giving the keyboard back to the Needs you button;
 * - the pull request: Check now's one call and its error said, Mark merged… off while it reads; Mark merged…'s
 *   question naming it, its button taking no
 *   early click, nor a burst's keys, nor one in the same task as a re-read (said), nor one just after it changes the
 *   question, then the one call;
 * - in focus, Reviewer's header's Finish step and its right-click menu's Finish step….
 *
 * `?lsFinish=<session>` (with ?lsWires; &lsVerdict=changes|approve) opens that workspace's Finish step from its
 * right-click menu, synthetic events, for a screenshot.
 */
import type { PipelinePr, SessionInfo, TicketPipeline } from "../shared/types";
import type { Wire } from "../shared/wires";
import { drive, type Asked } from "./needsYouAudit";

/** What the stub lets this part change, as main would and then tell the window. */
export interface WireNeedsEnv {
  calls: { fn: string; args: unknown[] }[];
  setSession: (id: string, over: Partial<SessionInfo>) => void;
  pipelines: () => Record<string, TicketPipeline>;
  pipelinesChanged: () => void;
  /** Wire `id` as main has it, and changed (a finish arriving, as finish_step's would). */
  wire: (id: string) => Wire | undefined;
  setWire: (id: string, w: Wire) => void;
  /** Resuming session `id` costs a lot (as ?lsBigResume has it), so a send that reopens it asks first. */
  costly: (id: string, on: boolean) => void;
  /** Session `id`'s latest message, as wires:lastMessage reads it from now on (a new turn's). */
  latest: (id: string, text: string) => void;
  /** How long a Check now takes to answer, from now on. */
  checkTakes: (ms: number) => void;
}

/** Reviewer's messages from the turns that end as its Finish step is open. */
const NEWER = "One change left:\n1. The email column needs the DonorPII grant.";
const NEWEST = "Both changes are in; the export streams and checks the grant.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel);
const qs = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const middle = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};
async function act(these: Asked[]): Promise<void> {
  if (!(await drive(these))) throw new Error("no driver: this audit presses keys and the mouse for real");
}
const click = (el: Element, clickCount = 1): Asked => ({ mouse: { ...middle(el), clickCount } });
const keyboard = () => {
  const a = document.activeElement;
  if (!a || a === document.body) return "body";
  if (a.classList.contains("mb-keys-nowhere")) return "nowhere";
  if (a.classList.contains("ls-viewport")) return "landscape";
  if (a.closest(".xterm")) return "terminal";
  if (a.classList.contains("ny-btn")) return "button";
  if (a.closest(".ny-tray")) return "tray";
  if (a.closest(".fs-pop")) return "finish";
  if (a.closest(".wg-pop")) return "popover";
  if (a.closest(".modal")) return "dialog";
  if (a.closest(".ls-focus")) return "focus";
  return a.tagName.toLowerCase();
};
const callsOf = (env: WireNeedsEnv, fns: string[], from = 0) => env.calls.slice(from).filter((c) => fns.includes(c.fn)).map((c) => ({ fn: c.fn, args: c.args }));
const WRITES = ["wiresSend", "wiresSendAgain", "wiresFinish", "wiresMarkSent", "wiresMoreRounds", "pipelinePrCheck", "pipelinePrMarkMerged", "resumeCost"];
const item = (id: string) => q(`.ny-tray .ny-item[data-item="${CSS.escape(id)}"]`);
const actBtn = (id: string, key: string) => q<HTMLButtonElement>(`.ny-tray .ny-item[data-item="${CSS.escape(id)}"] button[data-action="${key}"]`);
const tray = () =>
  qs(".ny-tray .ny-item").map((el) => ({
    id: el.dataset.item ?? null,
    kind: [...el.classList].find((c) => c.startsWith("k-"))?.slice(2) ?? null,
    meta: el.querySelector(".ny-kind")?.textContent ?? null,
    text: el.querySelector(".ny-text")?.textContent ?? null,
    acts: [...el.querySelectorAll<HTMLButtonElement>(".ny-acts button")].map((b) => ({ key: b.dataset.action ?? null, label: b.textContent, filled: b.classList.contains("fill"), tab: b.tabIndex })),
  }));
const note = () => q(".ls-note")?.textContent ?? null;
const openTray = async () => {
  if (!q(".ny-tray")) await act([click(q(".ny-btn")!)]);
  await sleep(250);
};
const until = async (test: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !test(); t += 50) await sleep(50);
  return test();
};
const finishPop = () => {
  const p = q(".fs-pop");
  if (!p) return null;
  const btn = p.querySelector<HTMLButtonElement>('button[data-act="finish"]');
  return {
    title: p.querySelector(".fs-title")?.textContent ?? null,
    // its words, without the button beside them
    mark: p.querySelector(".fs-mark")?.firstChild?.textContent ?? null,
    body: p.querySelector<HTMLTextAreaElement>(".fs-body")?.value ?? null,
    verdicts: [...p.querySelectorAll<HTMLButtonElement>("[data-verdict]")].map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`),
    // where it goes, what finishing does, its dot, and what that does to what's there now when it does something
    lines: [...p.querySelectorAll<HTMLElement>(".fs-line")].map((l) => {
      const over = l.querySelector(".fs-over")?.textContent;
      return [l.querySelector(".fs-to")?.textContent ?? "", l.querySelector(".fs-what")?.textContent ?? "", [...(l.querySelector(".fs-dot")?.classList ?? [])].find((c) => c.startsWith("t-")) ?? "", ...(over ? [over] : [])];
    }),
    use: p.querySelector(".fs-use")?.textContent ?? null,
    finish: btn ? { disabled: btn.disabled, title: btn.title } : null,
    hint: !!p.querySelector(".wg-hint"),
    err: p.querySelector(".wr-err")?.textContent ?? null,
  };
};

export async function wireNeedsPart(env: WireNeedsEnv, out: Record<string, unknown>): Promise<void> {
  const GATE_PR = env.pipelines()["5120"]?.prs[0]?.url ?? "";
  // ---- the cost question asked from a send popover opened as Builder's terminal was typed in, the popover gone ----
  // before Esc: the keyboard goes to the landscape, not to the terminal
  {
    const ghostWas = env.wire("wb-ghost")!;
    const from = env.calls.length;
    await act([click(q('.ls-world .ls-node[data-front="wb-builder"] .ls-term')!)]);
    await sleep(1300);
    const typedIn = keyboard();
    await act([click(q('.ls-wire-dots circle.dot[data-wire="wb-ghost"]')!)]);
    await until(() => !!q(".wg-pop:not(.mb-ghost)"));
    await sleep(700);
    const send = qs(".wg-pop:not(.mb-ghost) button").find((b) => b.textContent === "Send");
    env.costly("wb-spike", true);
    if (send) await act([click(send)]);
    const asked = await until(() => !!q(".cost-dlg"), 5000);
    await window.mb.wiresRemove("wb-ghost");
    const popGone = await until(() => !q(".wg-pop:not(.mb-ghost)"));
    await sleep(700);
    await act([{ key: "Escape" }]);
    await sleep(400);
    out.costEsc = { typedIn, asked, popGone, dialog: !!q(".cost-dlg"), keyboard: keyboard(), calls: callsOf(env, ["wiresSend", "wiresSendAgain", "resumeCost"], from) };
    env.costly("wb-spike", false);
    env.setWire("wb-ghost", ghostWas);
    await sleep(400);
  }

  // ---- the tray ----
  await openTray();
  out.tray = tray();

  // ---- Finish step from Reviewer's Finished item: it went idle with no summary since its last prompt ----
  env.setSession("wb-reviewer", { status: "idle", finishedAt: Date.now() - 60_000, promptAt: Date.now() - 1 });
  await sleep(400);
  out.finishedItem = tray().find((i) => i.id === "s:wb-reviewer") ?? null;
  // a key typed in the tray, then Finish step… clicked and Tab Tab Enter straight after: a burst begun before it opened
  let mark = env.calls.length;
  await act([{ key: "x" }, click(actBtn("s:wb-reviewer", "finish")!), { key: "Tab" }, { key: "Tab" }, { key: "Enter" }]);
  await until(() => !!finishPop()?.body);
  out.finishOpened = { tray: !!q(".ny-tray"), keyboard: keyboard(), pop: finishPop(), calls: callsOf(env, [...WRITES, "wiresLastMessage"], mark) };
  // Changes picked: what it does, shown; Finish step clicked straight after takes nothing, the lines having changed
  await sleep(1100);
  mark = env.calls.length;
  const changes = q('.fs-pop [data-verdict="changes"]')!;
  const finishBtn = () => q('.fs-pop button[data-act="finish"]')!;
  await act([click(changes)]);
  await sleep(80);
  await act([click(finishBtn())]);
  out.finishEarly = { pop: finishPop(), calls: callsOf(env, WRITES, mark) };
  // a new turn ends as it's open: its latest message read again into the agent's text, and Finish step held again, a
  // click 12 ms after taking nothing
  await sleep(700);
  env.latest("wb-reviewer", NEWER);
  env.setSession("wb-reviewer", { finishedAt: Date.now() });
  await sleep(12);
  await act([click(finishBtn())]);
  await until(() => finishPop()?.body === NEWER);
  out.turnLanded = { pop: finishPop(), calls: callsOf(env, WRITES, mark) };
  // changed by you, then a press outside (the Needs you button): your changes are kept, and come back with it
  await sleep(700);
  await act([click(q(".fs-pop .fs-body")!)]);
  // the caret at its end, so what's typed is added there (the keys after a pause, as a person's are)
  const area = q<HTMLTextAreaElement>(".fs-pop .fs-body")!;
  area.setSelectionRange(area.value.length, area.value.length);
  await sleep(700);
  await act([{ key: "x" }, { key: "y" }]);
  await sleep(150);
  const edited = finishPop()?.body ?? null;
  out.changed = { body: edited, mark: finishPop()?.mark ?? null };
  await act([click(q(".ny-btn")!)]);
  await until(() => !q(".fs-pop"));
  await openTray();
  await sleep(600);
  await act([click(actBtn("s:wb-reviewer", "finish")!)]);
  // its latest message read in beside the changes kept: the latest a click away
  await until(() => !!finishPop()?.use);
  out.kept = { pop: finishPop(), same: finishPop()?.body === edited, calls: callsOf(env, WRITES, mark) };
  // another turn ends: your changes stay, the newer message offered beside them
  await sleep(700);
  env.latest("wb-reviewer", NEWEST);
  env.setSession("wb-reviewer", { finishedAt: Date.now() });
  await until(() => !!finishPop()?.mark?.includes("newer message"));
  out.newerSince = { pop: finishPop(), same: finishPop()?.body === edited };
  // Changes picked again, then the one finish: your words, as shown
  await sleep(700);
  await act([click(q('.fs-pop [data-verdict="changes"]')!)]);
  await sleep(700);
  await act([click(finishBtn())]);
  await until(() => !q(".fs-pop"));
  await sleep(200);
  out.finished = { open: !!q(".fs-pop"), keyboard: keyboard(), note: note(), edited, calls: callsOf(env, WRITES, mark), loop: env.wire("wb-loop")?.pending?.body ?? null, held: env.wire("wb-held")?.pending ?? null };
  // its step finished since its last prompt: its Finished item no longer offers Finish step…
  await openTray();
  out.finishedAfter = tray().find((i) => i.id === "s:wb-reviewer")?.acts.map((a) => a.key) ?? null;

  // ---- the same pending blocked (Builder's hooks silent), then ready: Send comes where Show was ----
  // a click there as soon as it does is let go: the row is new, though what waits isn't
  await openTray();
  env.setSession("wb-builder", { hooksSilent: true });
  await until(() => !actBtn("wire:wb-loop", "send") && !!actBtn("wire:wb-loop", "show"));
  await sleep(900);
  const blockedRow = tray().find((i) => i.id === "wire:wb-loop") ?? null;
  const showAt = middle(actBtn("wire:wb-loop", "show")!);
  mark = env.calls.length;
  env.setSession("wb-builder", { hooksSilent: false });
  await until(() => !!actBtn("wire:wb-loop", "send"), 1000);
  const under = document.elementFromPoint(showAt.x, showAt.y)?.closest<HTMLElement>("button")?.dataset.action ?? null;
  await act([{ mouse: { ...showAt, clickCount: 1 } }]);
  await sleep(100);
  out.faceFlip = { blocked: blockedRow, under, calls: callsOf(env, WRITES, mark), pop: !!q(".wg-pop") };
  await sleep(700);

  // ---- Send on Reviewer → Builder's changes ----
  await openTray();
  const loopSend = () => actBtn("wire:wb-loop", "send");
  // Enter on it, focused by code (it's no Tab stop), presses nothing
  mark = env.calls.length;
  loopSend()?.focus();
  await act([{ key: "Enter" }]);
  await sleep(300);
  out.keySend = { tab: loopSend()?.tabIndex ?? null, calls: callsOf(env, WRITES, mark) };
  // a newer finish lands as the click does: let go, and shown off
  const was = env.wire("wb-loop")!;
  env.setWire("wb-loop", { ...was, pending: { ...was.pending!, id: `${was.pending!.id}-newer`, body: "1. Dispose the stream after the response.\n2. Gate the email column on DonorPII.", at: Date.now() } });
  await sleep(30);
  mark = env.calls.length;
  await act([click(loopSend()!)]);
  out.changedUnder = { off: !!loopSend()?.disabled, text: item("wire:wb-loop")?.querySelector(".ny-text")?.textContent ?? null, calls: callsOf(env, WRITES, mark) };
  await sleep(700);
  // a newer finish lands and the click comes in the same task, before the tray has drawn it: the row's guard can't see
  // it, so the send's own check of the pending named refuses, says so and shows the gate with what's there now
  const shown = env.wire("wb-loop")!;
  mark = env.calls.length;
  env.setWire("wb-loop", { ...shown, pending: { ...shown.pending!, id: `${shown.pending!.id}-raced`, at: Date.now() } });
  loopSend()!.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  await until(() => !!q(".wg-pop"));
  await sleep(100);
  out.raced = { calls: callsOf(env, WRITES, mark), pop: !!q(".wg-pop"), ends: q(".wg-pop .wr-ends")?.textContent ?? null, note: note() };
  await sleep(500);
  await act([{ key: "Escape" }]);
  await sleep(250);
  await openTray();
  await sleep(700);
  mark = env.calls.length;
  await act([click(loopSend()!)]);
  await until(() => !item("wire:wb-loop"), 5000);
  out.sentLoop = { calls: callsOf(env, WRITES, mark), item: !!item("wire:wb-loop"), delivery: env.wire("wb-loop")?.delivery?.state ?? null };

  // a double click on Fixtures → Spike's Send: one send, its closed end reopened once its cost is agreed. Its row moved
  // up as Reviewer → Builder's went: a click there now would be let go, so this one comes once it has stayed put
  await openTray();
  mark = env.calls.length;
  await act([click(actBtn("wire:wb-ghost", "send")!)]);
  out.movedUnder = { off: !!actBtn("wire:wb-ghost", "send")?.disabled, calls: callsOf(env, WRITES, mark) };
  await sleep(700);
  await act([click(actBtn("wire:wb-ghost", "send")!, 1), click(actBtn("wire:wb-ghost", "send")!, 2)]);
  await until(() => !item("wire:wb-ghost"), 6000);
  out.sentGhost = { calls: callsOf(env, WRITES, mark), item: !!item("wire:wb-ghost") };

  // ---- Show on what may have arrived ----
  await openTray();
  mark = env.calls.length;
  await act([click(actBtn("wire:wb-sending", "show")!)]);
  await until(() => !!q(".wg-pop"));
  out.shown = { tray: !!q(".ny-tray"), face: [...(q(".wg-pop")?.classList ?? [])].find((c) => c.startsWith("f-")) ?? null, ends: q(".wg-pop .wr-ends")?.textContent ?? null, keyboard: keyboard(), calls: callsOf(env, WRITES, mark) };
  await sleep(600);
  await act([{ key: "Escape" }]);
  await sleep(250);
  out.shownClosed = { open: !!q(".wg-pop"), keyboard: keyboard(), calls: callsOf(env, WRITES, mark) };

  // ---- the pull request ----
  const pr = `merge:5120:${GATE_PR}`;
  await openTray();
  mark = env.calls.length;
  // its read taking a moment, as a provider's does: Mark merged… waits for its answer
  env.checkTakes(600);
  await act([click(actBtn(pr, "check")!)]);
  await sleep(150);
  const markWhile = actBtn(pr, "markMerged");
  const checking = { off: !!markWhile?.disabled, title: markWhile?.title ?? null };
  await until(() => /Couldn't check/.test(note() ?? ""));
  env.checkTakes(0);
  await sleep(100);
  out.checked = { calls: callsOf(env, WRITES, mark), note: note(), checking, after: !actBtn(pr, "markMerged")?.disabled };
  // Mark merged…: its question, the tray away; an early click and a burst's keys press nothing
  await sleep(500);
  mark = env.calls.length;
  await act([{ key: "x" }, click(actBtn(pr, "markMerged")!), { key: "Tab" }, { key: "Enter" }]);
  await until(() => !!q(".mm-dlg"));
  const confirm = () => q<HTMLButtonElement>('.mm-dlg button[data-act="mark"]');
  out.markAsked = { tray: !!q(".ny-tray"), question: q(".mm-dlg .mm-q")?.textContent ?? null, keyboard: keyboard(), hint: !!q(".mm-dlg .cost-hint"), calls: callsOf(env, WRITES, mark) };
  // a read finds it closed: a click in the same task, before it's drawn, marks nothing and says so; the question
  // changes, and a click just after is let go
  await sleep(1100);
  const p = env.pipelines()["5120"];
  p.prs = p.prs.map((x: PipelinePr) => (x.url === GATE_PR ? { ...x, closedAt: Date.now(), watch: undefined } : x));
  env.pipelinesChanged();
  confirm()!.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  await sleep(40);
  await act([click(confirm()!)]);
  out.markReread = { question: q(".mm-dlg .mm-q")?.textContent ?? null, open: !!q(".mm-dlg"), err: q(".mm-dlg .fp-note.err")?.textContent ?? null, calls: callsOf(env, WRITES, mark) };
  await sleep(700);
  await act([click(confirm()!)]);
  await until(() => !q(".mm-dlg"));
  await sleep(200);
  out.marked = { open: !!q(".mm-dlg"), keyboard: keyboard(), note: note(), calls: callsOf(env, WRITES, mark) };

  // ---- in focus: the header's Finish step and the right-click menu's ----
  const head = q('.ls-world .ls-node[data-front="wb-reviewer"] .ls-head .ls-title')!;
  await act([click(head)]);
  await sleep(200);
  await act([{ key: "Enter" }]);
  await until(() => !!q(".ls-focus .ls-finish"));
  await sleep(300);
  const headBtn = q<HTMLButtonElement>(".ls-focus .ls-finish");
  out.header = { focus: !!q(".ls-focus"), button: headBtn ? { label: headBtn.textContent, disabled: headBtn.disabled } : null };
  mark = env.calls.length;
  if (headBtn) await act([click(headBtn)]);
  await until(() => !!finishPop()?.body);
  const hb = headBtn?.getBoundingClientRect();
  const pb = q(".fs-pop")?.getBoundingClientRect();
  out.headerPop = { open: !!q(".fs-pop"), under: !!hb && !!pb && pb.top >= hb.bottom - 1 && pb.top - hb.bottom < 12 && Math.abs(pb.right - hb.right) < 4, keyboard: keyboard(), calls: callsOf(env, [...WRITES, "wiresLastMessage"], mark) };
  await sleep(600);
  await act([{ key: "Escape" }]);
  await sleep(250);
  out.headerClosed = { open: !!q(".fs-pop"), keyboard: keyboard() };
  // its right-click menu has the same
  const r = middle(q(".ls-focus .ls-head")!);
  await act([{ mouse: { x: r.x - 40, y: r.y, clickCount: 1, button: "right" } }]);
  await sleep(300);
  out.menu = qs(".mb-ctx:not(.mb-ghost) button").map((b) => b.querySelector(".mb-ctx-t")?.textContent ?? b.textContent ?? "").filter((t) => /Finish|Connect/.test(t));
  await act([{ key: "Escape" }]);
}

/** ?lsFinish=<session>: its Finish step opened from its right-click menu, synthetic events, for a screenshot. */
export function openFinishShot(id: string, verdict: string | null, waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void): void {
  waitFor(`.ls-world .ls-node[data-front="${CSS.escape(id)}"] .ls-head`, (head) =>
    setTimeout(() => {
      const r = head.getBoundingClientRect();
      head.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + r.height / 2, button: 2 }));
      setTimeout(() => {
        const row = qs(".mb-ctx:not(.mb-ghost) button").find((b) => /Finish step/.test(b.textContent ?? ""));
        row?.click();
        if (verdict) setTimeout(() => q(`.fs-pop [data-verdict="${verdict}"]`)?.click(), 900);
      }, 300);
    }, 1200)
  );
}
