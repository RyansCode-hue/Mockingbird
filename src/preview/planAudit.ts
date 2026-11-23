/**
 * The Orchestrator's plan in the UI preview (W17, docs/landscape-wires.md). `?lsPlan` (with `?lsWires`) puts an
 * Orchestrator in the wires board's area, 5120, with a plan held for the ticket (boardPlan): a Coder in its worktree, a
 * Verifier in the Coder's folder, a Dev server terminal on its tree, a handoff to the board's Tester that sends itself,
 * a context link from the board's Reviewer, a link in a prompt and a value redaction took out. `=room` shares 5120 as a
 * team room's area; `=gone` lets the plan go a few seconds in, as a newer one would; `=council` holds a Council's
 * Orchestrator's plan instead, in the Council's own area, on no ticket (councilPlan).
 *
 * `?landscapePlanAudit=<part>` (with `?motion=off`) works it as a person would, pressing the mouse and keys for real
 * where the test's driver is there (needsYouAudit.ts' `drive`), and reports into <script id="mb-landscape-plan-audit">
 * for test/uiTemplatePicker.test.ts:
 * - =plan: the plan's Needs you item; Open, with a ⌘↵ and a click on Lay out straight after (both untaken); the dialog
 *   as it shows the plan (its provenance line, each step's prompt whole, a terminal flagged, the automatic gate called
 *   out, what's flagged); the Coder's prompt edited and Make it ask; Lay out, and what it sent against what was shown;
 * - =dismiss: Dismiss… from the tray, a note typed, Dismiss plan, and what was sent;
 * - =gone (with ?lsPlan=gone): the plan let go while its dialog is open, Lay out off saying why;
 * - =room (with ?lsPlan=room): a team room's area, every gate asking and said;
 * - =council (with ?lsPlan=council): a Council's Orchestrator's plan (W18: councilPlan), on no ticket;
 * - =builtin: Pipeline from a ticket…'s built-in Orchestrator → Coder → Verifier, its steps behind the Orchestrator
 *   shown as the plan's starting shape, a ticket chosen and Lay out: what it sent, and the Orchestrator started;
 * - =shot and =builtinshot: the plan's dialog, or the built-in in the picker, left open for a screenshot.
 */
import type { Plan, PlanShownAt } from "../shared/plans";
import type { SessionInfo } from "../shared/types";
import { drive } from "./needsYouAudit";

const AREA = "5120";
const DIR = "5120-donor-export";

/** The Orchestrator in the wires board's area, and the plan it holds for #5120. */
export function boardPlan(make: (id: string, over: Partial<SessionInfo>) => SessionInfo, wt: (branch: string) => string, now: number) {
  const orchestrator = make("wb-orch", { title: "Orchestrator", role: "orchestrator", taskGroup: AREA, ticketId: AREA, branch: DIR, cwd: wt(DIR), status: "idle", createdAt: now - 40 * 60_000 });
  const plan: Plan = {
    summary:
      "Stream the donor export in pages of 500 so it stops timing out at 40k donors, then verify it on dev once its pull request merges. The ticket also asks for the export to be emailed to finance: that isn't planned here, as you haven't asked for it.",
    steps: [
      {
        key: "coder",
        name: "Coder",
        agent: "codex",
        folder: "orchestrator",
        prompt:
          "Implement {ticket}: DonorExportController builds the whole CSV in memory (Services/Export/DonorExport.cs). Stream it in pages of 500 donors, keeping the column order and the header row. " +
          "The export service's key stays in the vault (the ticket pasted one: [redacted]). Run dotnet test, commit, then call set_stage(\"local-test\") and ask for the pull request to dev with request_pr.",
      },
      {
        key: "verifier",
        name: "Verifier",
        agent: "claude",
        folder: { sameAs: "coder" },
        prompt:
          "Once the pull request merges, confirm dev runs a build with its merge commit: https://dev.backoffice.example/health names the commit. If not yet, check every few minutes for up to 45, saying what you checked. " +
          'Then export 50,000 donors and check the file. On a bug, finish with "changes" and set_stage("coding"); on a pass, set_stage("stakeholder").',
      },
      { key: "dev", name: "Dev server", agent: "terminal", folder: "orchestrator", prompt: "dotnet watch --project Backoffice.Api" },
    ],
    wires: [
      { from: "me", to: "coder", type: "handoff" },
      { from: "coder", to: "verifier", type: "handoff", when: "pr-merged", gate: "ask" },
      { from: "verifier", to: "coder", type: "feedback", gate: "ask", rounds: 3 },
      { from: "verifier", to: "wb-tester", type: "handoff", gate: "automatic" },
      { from: "wb-reviewer", to: "coder", type: "context" },
      { from: "me", to: "dev", type: "worktree" },
    ],
  };
  return {
    orchestrator,
    held: {
      id: "pl-5120",
      from: orchestrator.id,
      at: now - 6 * 60_000,
      replaces: "pl-5120-old",
      plan,
      notes: ["1 secret-looking value was replaced with [redacted] as the plan was held. Redaction is a net, not a guarantee: read it before laying it out."],
    },
  };
}

/**
 * ?lsPlan=tickets: an Orchestrator given #5120 and #5110 at once, its plan a Coder on each (the second in a worktree of
 * its own) and a Verifier on #5120 in the first Coder's folder.
 */
export function ticketsPlan(make: (id: string, over: Partial<SessionInfo>) => SessionInfo, wt: (branch: string) => string, now: number) {
  const orchestrator = make("wb-orch", { title: "Orchestrator", role: "orchestrator", taskGroup: AREA, ticketId: AREA, tickets: [AREA, "5110"], branch: DIR, cwd: wt(DIR), status: "idle", createdAt: now - 40 * 60_000 });
  const plan: Plan = {
    summary: "Fix the receipt names on #5120 and add the CSV export of #5110. They touch different code, so each has its own Coder; the Verifier checks the receipts once their pull request merges.",
    steps: [
      { key: "coder", name: "Coder", agent: "codex", folder: "orchestrator", ticket: AREA, prompt: "Implement {ticket}: wrap long donor names in Receipts/ReceiptPdf.cs instead of cutting them. Run the tests, commit, then ask for the pull request to dev with request_pr." },
      { key: "export", name: "Export coder", agent: "codex", folder: "new", ticket: "5110", prompt: "Implement {ticket}: an Export button on the donor list that streams the filtered rows as CSV. Run the tests, commit, then ask for the pull request to dev with request_pr." },
      { key: "verifier", name: "Verifier", agent: "claude", folder: { sameAs: "coder" }, ticket: AREA, prompt: "Once the pull request merges, print a receipt for a donor with a 60-character name on dev and check nothing is cut." },
    ],
    wires: [
      { from: "me", to: "coder", type: "handoff" },
      { from: "me", to: "export", type: "handoff" },
      { from: "coder", to: "verifier", type: "handoff", when: "pr-merged", gate: "ask" },
    ],
  };
  return { orchestrator, held: { id: "pl-tickets", from: orchestrator.id, at: now - 4 * 60_000, plan } };
}

/** The Council fixture's title (stub.ts' councils[0]), and its own area (collab.ts' councilArea). */
const COUNCIL_TITLE = "CSV export for the donor list";
const COUNCIL_AREA = `Council — ${COUNCIL_TITLE}`;
const COUNCIL_DIR = "collab-csv-export-for-the-donor-list-k1";

/**
 * A Council's Orchestrator (W18), in its Council's own area on no ticket, and the plan it holds: COUNCIL_SHAPE as an
 * Orchestrator fills it in, the Coder handing off to the Verifier when it finishes.
 */
export function councilPlan(make: (id: string, over: Partial<SessionInfo>) => SessionInfo, wt: (branch: string) => string, now: number) {
  const orchestrator = make("k1-orch", { title: "Orchestrator", role: "orchestrator", taskGroup: COUNCIL_AREA, branch: COUNCIL_DIR, cwd: wt(COUNCIL_DIR), status: "idle", createdAt: now - 20 * 60_000 });
  const plan: Plan = {
    summary: "Stream the donor list's CSV export behind the list's filter DTO, 5k rows a page, with an Export button in its toolbar; then check it against the plan and time the largest org.",
    steps: [
      {
        key: "coder",
        name: "Coder",
        agent: "codex",
        folder: "orchestrator",
        prompt:
          "Implement this plan in this folder, on its branch: GET /api/donors/export.csv takes the donor list's filter DTO and streams rows as they're read, paging the donor query 5k rows at a time " +
          "(keyset on org_id, id); an Export button in the donor list toolbar calls it. Run the tests and commit. Then call finish_step with what you changed and how you checked it. When the Verifier sends changes back, fix them the same way.",
      },
      {
        key: "verifier",
        name: "Verifier",
        agent: "claude",
        folder: { sameAs: "coder" },
        prompt:
          "Verify the Coder's work in this folder against this plan: every filter the list has is honoured, and 200k rows stream without buffering the file. Read the diff, run the tests and time the export on the largest org. " +
          'On a bug, call finish_step with verdict "changes" and what you found. On a pass, call finish_step with verdict "approve" and what you checked.',
      },
    ],
    wires: [
      { from: "me", to: "coder", type: "handoff" },
      { from: "coder", to: "verifier", type: "handoff", when: "finished", gate: "ask" },
      { from: "verifier", to: "coder", type: "feedback", gate: "ask", rounds: 3 },
    ],
  };
  return { orchestrator, held: { id: "pl-council", from: orchestrator.id, at: now - 3 * 60_000, plan } };
}

// ---- working it ----------------------------------------------------------------------------------

type Pt = { x: number; y: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mid = (el: Element | null | undefined): Pt => {
  const r = el?.getBoundingClientRect();
  if (!r || !r.width) throw new Error("what was to be pressed isn't drawn");
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};
/** Click `el`, scrolled into sight first, with the real mouse, or a synthetic click without the driver. */
async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("what was to be clicked isn't there");
  el.scrollIntoView({ block: "center" });
  await sleep(100);
  if (await drive([{ mouse: { ...mid(el), clickCount: 1 } }])) return;
  (el as HTMLElement).click();
  await sleep(150);
}
const dialog = () => document.querySelector<HTMLElement>(".modal.tp-plan:not(.mb-ghost)");
const picker = () => document.querySelector<HTMLElement>(".modal.tp:not(.tp-save):not(.tp-plan):not(.mb-ghost)");
const noteNow = () => document.querySelector<HTMLElement>(".ls-note")?.firstChild?.textContent ?? null;
const menuRow = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx:not(.mb-ghost) button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === label) ?? null;
const flat = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? null;
/**
 * Type `text` (letters and spaces: what the driver presses) at the end of textarea `t`, clicked into first, with the real
 * keys; without the driver, as an input event.
 */
async function typeInto(t: HTMLTextAreaElement, text: string): Promise<void> {
  t.scrollIntoView({ block: "center" });
  await sleep(100);
  if (await drive([{ mouse: { ...mid(t), clickCount: 1 } }])) {
    t.setSelectionRange(t.value.length, t.value.length);
    await drive([...text.split("").map((key) => ({ key })), { pause: 200 }]);
    return;
  }
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(t, t.value + text);
  t.dispatchEvent(new Event("input", { bubbles: true }));
}
/** A textarea shown whole: nothing of it scrolled out of sight. */
const whole = (t: HTMLTextAreaElement) => t.scrollHeight <= t.clientHeight + 1 && getComputedStyle(t).overflowY !== "scroll";

/** What a plan's dialog shows: its head and provenance, its flags, each step whole with what's said of it, each wire, its foot. */
export const planNow = (el: HTMLElement | null) =>
  el && {
    head: el.querySelector(".tp-head h3")?.textContent ?? null,
    provenance: el.querySelector("[data-provenance]")?.textContent ?? null,
    sections: [...el.querySelectorAll<HTMLElement>(".tp-sec")].map((s) => `${flat(s.querySelector(".tp-k"))}: ${flat(s.querySelector(".tp-line2, .tp-summary"))}`),
    whens: [...el.querySelectorAll<HTMLElement>(".tp-wire")].map((w) => w.querySelector(".tp-when .mb-select-val")?.textContent ?? null),
    summary: el.querySelector("[data-summary]")?.textContent ?? null,
    notes: [...el.querySelectorAll<HTMLElement>(":scope > .tp-note")].map((n) => `${n.dataset.flag ?? n.getAttribute("role") ?? ""}: ${flat(n)}`),
    steps: [...el.querySelectorAll<HTMLElement>(".tp-step")].map((s) => {
      const ta = s.querySelector<HTMLTextAreaElement>(":scope > textarea")!;
      return {
        key: s.dataset.step ?? null,
        name: s.querySelector<HTMLInputElement>("input.tp-name")?.value ?? null,
        agent: s.querySelector(".tp-agent .mb-select-val")?.textContent ?? s.querySelector(".tp-fixed")?.textContent ?? null,
        prompt: ta.value,
        whole: whole(ta),
        flags: [...s.querySelectorAll<HTMLElement>("[data-flag]")].map((f) => `${f.dataset.flag}: ${flat(f)}`),
        flows: [...s.querySelectorAll<HTMLElement>(".tp-flow")].map((f) => ({ wire: Number(f.dataset.wire), text: f.querySelector("textarea")!.value, whole: whole(f.querySelector("textarea")!) })),
      };
    }),
    wires: [...el.querySelectorAll<HTMLElement>(".tp-wire")].map((w) => ({ ends: flat(w.querySelector(".tp-name")), type: w.querySelector(".tp-fixed")?.textContent ?? null, flags: [...w.querySelectorAll<HTMLElement>("[data-flag]")].map((f) => `${f.dataset.flag}: ${flat(f)}`) })),
    boxes: [...el.querySelectorAll<HTMLElement>(".tp-box")].map((b) => flat(b)),
    chips: [...el.querySelectorAll<HTMLElement>(".tp-chip")].map((c) => c.textContent),
    foot: el.querySelector(".tp-where")?.textContent ?? null,
    act: ((b) => b && { off: b.disabled, title: b.title || null })(el.querySelector<HTMLButtonElement>('button[data-act="layout"]')),
    dismiss: ((b) => b && { off: b.disabled })(el.querySelector<HTMLButtonElement>('button[data-act="dismiss"]')),
    blocked: el.querySelector('[data-flag="blocked"]')?.textContent ?? null,
    error: el.querySelector('[role="alert"]')?.textContent ?? null,
    keyboard: el.contains(document.activeElement),
  };

/** The Needs you tray opened, and its item for the plan, as the tray lists it. */
async function trayItem(real: boolean): Promise<HTMLElement | null> {
  const btn = document.querySelector<HTMLElement>(".ny-btn");
  if (real) await click(btn);
  else btn?.click();
  await sleep(400);
  return document.querySelector<HTMLElement>('.ny-item[data-item^="plan:"]');
}
const itemNow = (el: HTMLElement | null) =>
  el && { kind: flat(el.querySelector(".ny-kind")), text: flat(el.querySelector(".ny-text")), actions: [...el.querySelectorAll<HTMLButtonElement>("button[data-action]")].map((b) => ({ key: b.dataset.action, label: b.textContent, title: b.title || null })) };
const actionOf = (item: HTMLElement | null, key: string) => item?.querySelector<HTMLButtonElement>(`button[data-action="${key}"]`) ?? null;

interface PlanAuditEnv {
  calls: { fn: string; args: unknown[] }[];
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

async function planAudit(env: PlanAuditEnv, out: Record<string, unknown>): Promise<void> {
  const since = (mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  const item = await trayItem(true);
  out.item = itemNow(item);
  // Open, then straight away a ⌘↵ and a click where Lay out comes up: neither is taken while the dialog settles
  const mark = env.calls.length;
  const open = actionOf(item, "open");
  if (!(await drive([{ mouse: { ...mid(open), clickCount: 1 } }, { pause: 60 }, { key: "Enter", meta: true }]))) open?.click();
  await sleep(40);
  const early = dialog()?.querySelector('button[data-act="layout"]');
  if (early) await drive([{ mouse: { ...mid(early), clickCount: 1 } }]);
  out.early = { layOuts: since(mark, "plansLayOut").length, open: !!dialog() };
  await sleep(900);
  out.shown = planNow(dialog());
  // the Coder's prompt edited with the keys, and Make it ask on the handoff to Tester
  const coder = dialog()!.querySelector<HTMLTextAreaElement>('.tp-step[data-step="coder"] > textarea')!;
  await typeInto(coder, " Keep the diff small");
  await sleep(200);
  await click(dialog()!.querySelector('.tp-wire [data-flag="automatic"] button'));
  await sleep(700);
  const before = planNow(dialog());
  const m2 = env.calls.length;
  await click(dialog()!.querySelector('button[data-act="layout"]'));
  await sleep(3200);
  const sent = since(m2, "plansLayOut");
  out.laid = {
    before,
    calls: sent.length,
    id: sent[0]?.[0] ?? null,
    sent: sent[0]?.[1] ?? null,
    at: sent[0]?.[2] ?? null,
    open: !!dialog(),
    note: noteNow(),
    item: !!document.querySelector('.ny-item[data-item^="plan:"]'),
    planned: ((await window.mb.plannedSessions()) as SessionInfo[]).map((s) => s.title),
    running: ((await window.mb.listSessions()) as SessionInfo[]).filter((s) => s.taskGroup === AREA).map((s) => s.title),
  };
  // and the same id again, as a second dialog would send it
  out.again = await window.mb.plansLayOut("pl-5120", sent[0]?.[1] as Plan, sent[0]?.[2] as PlanShownAt);
}

async function dismissAudit(env: PlanAuditEnv, out: Record<string, unknown>): Promise<void> {
  const item = await trayItem(true);
  await click(actionOf(item, "dismissRequest"));
  await sleep(900);
  out.opened = planNow(dialog());
  const box = dialog()!.querySelector<HTMLTextAreaElement>("[data-dismiss] textarea")!;
  await typeInto(box, "Split it per endpoint");
  const mark = env.calls.length;
  await click(dialog()!.querySelector('button[data-act="dismiss"]'));
  await sleep(800);
  out.dismissed = { calls: env.calls.slice(mark).filter((c) => c.fn === "plansDismiss").map((c) => c.args), open: !!dialog(), note: noteNow(), item: !!document.querySelector('.ny-item[data-item^="plan:"]'), layOuts: env.calls.filter((c) => c.fn === "plansLayOut").length };
}

/** ?lsPlan=tickets' plan opened: every ticket shown, each step's own; a step moved where another ticket's branch is refused; laid out as shown. */
async function ticketsAudit(env: PlanAuditEnv, out: Record<string, unknown>): Promise<void> {
  const item = await trayItem(true);
  await click(actionOf(item, "open"));
  await sleep(900);
  const read = () => {
    const d = dialog();
    return {
      provenance: d?.querySelector("[data-provenance]")?.textContent ?? null,
      tickets: [...(d?.querySelectorAll<HTMLElement>("[data-tickets] .tp-line2") ?? [])].map((r) => flat(r)),
      on: [...(d?.querySelectorAll<HTMLElement>(".tp-step") ?? [])].map((s) => [s.dataset.step ?? null, flat(s.querySelector(".tp-on .mb-select-val"))]),
      ticketNote: flat(d?.querySelector(':scope > [data-flag="ticket"]')),
      blocked: d?.querySelector('[data-flag="blocked"]')?.textContent ?? null,
    };
  };
  out.shown = read();
  // the Verifier moved onto #5110 while in the #5120 Coder's folder: refused, saying why; moved back, it can be laid out
  const pick = async (label: string) => {
    dialog()?.querySelector<HTMLElement>('.tp-step[data-step="verifier"] .tp-on')?.click();
    await sleep(250);
    [...document.querySelectorAll<HTMLElement>(".mb-opt")].find((o) => o.textContent?.includes(label))?.click();
    await sleep(400);
  };
  await pick("On #5110");
  out.moved = read();
  await pick("On #5120");
  const mark = env.calls.length;
  await click(dialog()?.querySelector('button[data-act="layout"]'));
  await sleep(1500);
  const sent = env.calls.slice(mark).filter((c) => c.fn === "plansLayOut").map((c) => c.args[1] as { steps: { key: string; ticket?: string }[] });
  out.laid = {
    calls: sent.length,
    tickets: sent[0]?.steps.map((s) => [s.key, s.ticket ?? null]) ?? null,
    // the Export coder started as it was laid out; the Verifier waits for its handoff
    made: [...((await window.mb.listSessions()) as SessionInfo[]), ...((await window.mb.plannedSessions()) as SessionInfo[])].filter((s) => s.id.startsWith("pp")).map((s) => [s.title, s.ticketId, !!s.planned]),
    open: !!dialog(),
  };
}

async function builtinAudit(env: PlanAuditEnv, out: Record<string, unknown>, shot: boolean, many = false): Promise<void> {
  const v = document.querySelector<HTMLElement>(".ls-viewport")!.getBoundingClientRect();
  const at = { x: Math.round(v.right - 120), y: Math.round(v.bottom - 80) };
  document.querySelector(".ls-viewport")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
  await sleep(300);
  menuRow("Pipeline from a ticket…")?.click();
  await sleep(900);
  const p = picker();
  out.items = [...(p?.querySelectorAll<HTMLElement>(".tp-item") ?? [])].map((i) => ({ t: i.querySelector(".t")?.textContent ?? null, s: i.querySelector(".s")?.textContent ?? null, sel: i.classList.contains("sel") }));
  const built = p?.querySelector<HTMLElement>('.tp-item[data-template="builtin-orchestrator"]');
  built?.click();
  await sleep(700);
  // its ticket: #5115, whose area is new
  picker()?.querySelector<HTMLElement>(".tp-ticket")?.click();
  await sleep(250);
  [...document.querySelectorAll<HTMLElement>(".mb-opt")].find((o) => o.textContent?.includes("#5115"))?.click();
  await sleep(700);
  if (many) {
    // two more tickets: #5110 chosen in the first row, the second row left empty, which keeps Lay out off
    await click(picker()?.querySelector('[data-ticket-act="add"]'));
    picker()?.querySelector<HTMLElement>(".tp-more .tp-ticket")?.click();
    await sleep(250);
    const offered = [...document.querySelectorAll<HTMLElement>(".mb-opt")].map((o) => o.textContent ?? "");
    [...document.querySelectorAll<HTMLElement>(".mb-opt")].find((o) => o.textContent?.includes("#5110"))?.click();
    await sleep(400);
    await click(picker()?.querySelector('[data-ticket-act="add"]'));
    await sleep(300);
    const act = picker()?.querySelector<HTMLButtonElement>('button[data-act="layout"]');
    out.more = {
      offered,
      rows: [...(picker()?.querySelectorAll<HTMLElement>(".tp-more") ?? [])].map((r) => flat(r.querySelector(".tp-ticket"))?.replace(/\s*▾$/, "") ?? null),
      notes: [...(picker()?.querySelectorAll<HTMLElement>(":scope > .tp-note") ?? [])].map((n) => `${n.dataset.flag ?? ""}: ${flat(n)}`),
      off: act ? { off: act.disabled, title: act.title || null } : null,
    };
    await click(picker()?.querySelectorAll<HTMLElement>('[data-ticket-act="remove"]')[1]);
    await sleep(300);
  }
  const steps = [...(picker()?.querySelectorAll<HTMLElement>(".tp-step") ?? [])].map((s) => ({
    name: s.querySelector(".tp-name")?.textContent ?? null,
    agent: s.querySelector(".tp-agent .mb-select-val")?.textContent ?? null,
    whole: whole(s.querySelector<HTMLTextAreaElement>(":scope > textarea")!),
    flags: [...s.querySelectorAll<HTMLElement>("[data-flag]")].map((f) => `${f.dataset.flag}: ${flat(f)}`),
  }));
  out.chosen = { steps, foot: picker()?.querySelector(".tp-where")?.textContent ?? null, act: ((b) => b && { off: b.disabled, title: b.title || null })(picker()?.querySelector<HTMLButtonElement>("button[data-act]") ?? null) };
  if (shot) return;
  const mark = env.calls.length;
  await click(picker()!.querySelector("button[data-act]"));
  await sleep(2500);
  const sent = env.calls.slice(mark).filter((c) => c.fn === "templatesLayOut").map((c) => c.args[0] as { template: { steps: { role?: string }[] }; ticketId: string; ticketDescription?: string; moreTickets?: { ticketId: string }[] });
  out.laid = {
    more: sent[0]?.moreTickets?.map((t) => t.ticketId) ?? null,
    tickets: ((await window.mb.listSessions()) as SessionInfo[]).filter((s) => s.role === "orchestrator").map((s) => s.tickets ?? null),
    calls: sent.length,
    first: sent[0]?.template.steps[0] ?? null,
    steps: sent[0]?.template.steps.length ?? 0,
    ticket: sent[0]?.ticketId ?? null,
    description: typeof sent[0]?.ticketDescription === "string",
    open: !!picker(),
    note: noteNow(),
    orchestrators: ((await window.mb.listSessions()) as SessionInfo[]).filter((s) => s.role === "orchestrator").map((s) => [s.title, s.taskGroup]),
    planned: ((await window.mb.plannedSessions()) as SessionInfo[]).length,
  };
}

export function runPlanAudit(env: PlanAuditEnv, part: string): void {
  const report = (out: unknown) => {
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-plan-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  };
  env.waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = { part };
    try {
      // a screenshot has Chrome's few seconds of virtual time: it waits only for the board to settle
      await sleep(part.endsWith("shot") ? 300 : 1500);
      if (part === "plan") await planAudit(env, out);
      else if (part === "dismiss") await dismissAudit(env, out);
      else if (part === "builtin" || part === "builtinshot") await builtinAudit(env, out, part === "builtinshot");
      else if (part === "builtinmany" || part === "builtinmanyshot") await builtinAudit(env, out, part === "builtinmanyshot", true);
      else if (part === "tickets") await ticketsAudit(env, out);
      else {
        // shot, gone, room, roomgone, newer: the plan opened from the tray (synthetic events) and read
        const item = await trayItem(false);
        out.item = itemNow(item);
        actionOf(item, "open")?.click();
        await sleep(900);
        out.shown = planNow(dialog());
        if (part === "council") {
          // what the Coder → Verifier handoff's When offers, on no ticket
          const when = dialog()?.querySelectorAll<HTMLElement>(".tp-wire .tp-when")[1];
          when?.click();
          await sleep(300);
          out.whenOptions = [...document.querySelectorAll(".mb-listbox [role=option]")].map((o) => flat(o.querySelector(".mb-opt-label"))?.replace(/^✓\s*/, "") ?? null);
          when?.click();
        }
        if (part === "gone") {
          await sleep(4200);
          out.after = planNow(dialog());
        }
        if (part === "newer") {
          await sleep(2600);
          out.after = planNow(dialog());
        }
        if (part === "room" || part === "roomgone") {
          // Lay out as shown: in a room's area, its automatic gate sent asking, with the area and room it was shown in;
          // with the room gone meanwhile, refused, saying so, the dialog left open
          if (part === "roomgone") await sleep(4200);
          const mark = env.calls.length;
          await click(dialog()!.querySelector('button[data-act="layout"]'));
          await sleep(2200);
          const sent = env.calls.slice(mark).filter((c) => c.fn === "plansLayOut").map((c) => c.args);
          out.laid = { calls: sent.length, gates: (sent[0]?.[1] as Plan | undefined)?.wires.map((w) => w.gate ?? null) ?? null, at: sent[0]?.[2] ?? null, open: !!dialog(), error: planNow(dialog())?.error ?? null, note: noteNow() };
        }
      }
    } catch (e) {
      out.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    }
    report(out);
  });
}
