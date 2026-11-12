import { randomUUID } from "crypto";
import type { LandscapeStore } from "./landscape";
import { MCP_SERVER, type Reply } from "./messaging";
import { readJsonOrSetAside, writeFileAtomic } from "./fileOps";
import { holdsPrivateKey } from "./team/artifactStore";
import { INVISIBLE_RE } from "./ticketTools";
import { TICKET_TOOL } from "./ticketToolSchemas";
import { REDACTED, redactSecrets } from "./wirePrompt";
import { WIRE_TOOL } from "./wireToolSchemas";
import type { LayOutDeps, WireService } from "./wires";
import { isObj } from "../shared/landscape";
import { agentOf, layOutPlan, parseTemplateBody, startsAtOrchestrator, TemplateError, ticketLine, withTicket, type LayOutReply, type TemplateBody } from "../shared/pipelineTemplates";
import {
  checkPlan,
  ME,
  orchestratorKickoff,
  PLAN_MAX,
  PlanError,
  readPlanArgs,
  readShownPlan,
  type HeldPlan,
  type Plan,
  type PlanContext,
  type PlanEnd,
  type PlanLaidOut,
  type PlanLayOut,
  type PlanView,
  type PlanWire,
} from "../shared/plans";
import { oneLine, plainLine } from "../shared/team/agentText";
import { slugBranch, suggestTicketName, ticketIdOf, ticketOfSession, topOfKey, type AgentKind, type AgentTold, type ModelCatalog, type NewSessionRequest, type SessionInfo } from "../shared/types";
import { carriesWork, ROOM_LINE, ROOMS_STARTING, settingsRefusal, wireRefusal, type GateContext, type WireEnd, type WireGate, type WireReply, type WireSettings } from "../shared/wires";

/**
 * The Orchestrator's plans (docs/landscape-wires.md, W17; section 4, "The Orchestrator and its plan"), in main: what
 * propose_plan holds, what the window shows, and the one IPC call that makes anything of one.
 *
 * The guard is one click. propose_plan writes a held plan to plans.json and nothing else: no session, worktree or wire.
 * Only plans:layOut, an IPC call from the window's Lay out, creates sessions and wires, from what the dialog sent back,
 * read and checked again here as the proposal was, under the held plan's id, once: a plan replaced by a newer one, laid
 * out or dismissed can't be laid out by a dialog still open on it. Plans live apart from the wire book, so a proposal
 * is never read as a wire, and a corrupt plans file loses proposals only.
 */

/** plans.json: one held plan per Orchestrator, by id; a newer one replaces it. */
interface PlansFile {
  v: 1;
  plans: Record<string, HeldPlan>;
}

/** What laying a plan out needs of the sessions and the wires (index.ts gives the same as a template's lay-out). */
export interface PlanLayOutDeps {
  planStep: LayOutDeps["planStep"];
  /** Let a step made go again, with its wires: throws when it couldn't be, and answers why its wires stayed, else null. */
  forget(id: string): string | null;
  /** Start a not-started step, from session `from`'s commit (null: the step's own base), placed, its ticket's coding started. */
  start(id: string, from: string | null, ticketTitle: string | null): Promise<SessionInfo>;
  /** A terminal on a started agent's tree, wired to it, running `command` (WireService.addTerminal). */
  addTerminal(agent: SessionInfo, as: { title: string; command: string }): Promise<SessionInfo>;
  /** A handoff Lay out sent as its step's own prompt, counted sent (WireDelivery.countSent). */
  countSent(wire: string, why: string): WireReply;
}

/** What an Orchestrator's start needs (templates:layOut with a template whose first step is one). */
export interface OrchestratorStartDeps {
  create(req: NewSessionRequest): Promise<SessionInfo>;
  /** It's open: its folder's overlaps checked, and its ticket tracked at BA rather than its coding started (index.ts). */
  opened(info: SessionInfo, ticketTitle: string): void;
}

export interface PlansOptions {
  file: string;
  sessions: {
    list(): SessionInfo[];
    resumable(): SessionInfo[];
    planned(): SessionInfo[];
    deliverAgentMessage(id: string, message: string, submit: boolean): string;
  };
  wires: Pick<WireService, "add" | "context">;
  store: Pick<LandscapeStore, "wires" | "wiresWriteRefusal">;
  submitOnDelivery(target: SessionInfo): boolean;
  /** Why session `id` can't have `doing` done to it, a teammate having taken it over; null otherwise. */
  takenOver(id: string, doing: string): string | null;
  roomOf(id: string): string | null;
  roomOfGroup(group: string): string | null;
  roomsKnown(): boolean;
  /** The agents installed on this Mac. */
  installed(): Promise<AgentKind[]>;
  /** The models and efforts they offer, or null when that can't be read. */
  catalog(): Promise<ModelCatalog | null>;
  ticketTitleOf(id: string): string | null;
  /** A plan was held, replaced, laid out or dismissed: the windows hear of it (plans:changed). */
  onChanged(): void;
  log: (context: string, err: unknown) => void;
  newId?: () => string;
  now?: () => number;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const nOf = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** How many plans laid out, dismissed or replaced are remembered as such, to say so to a dialog still open on one. */
const SPENT_KEPT = 200;
/** How long the user's note on a dismissal may be. */
const NOTE_MAX = 2000;

/** Each piece of a plan's text, and where it is, for redaction at propose_plan and the checks at Lay out. */
function textsOf(p: Plan): { where: string; get: () => string; set: (t: string) => void; max: number; line?: true }[] {
  return [
    { where: "Its summary", get: () => p.summary, set: (t) => void (p.summary = t), max: PLAN_MAX.summary },
    ...p.steps.flatMap((s) => [
      { where: `Step ${s.key}'s name`, get: () => s.name, set: (t: string) => void (s.name = t), max: PLAN_MAX.name, line: true as const },
      { where: `“${s.name}”'s ${s.agent === "terminal" ? "command" : "prompt"}`, get: () => s.prompt, set: (t: string) => void (s.prompt = t), max: PLAN_MAX.prompt },
    ]),
    ...p.wires.flatMap((w, j) => (w.template === undefined ? [] : [{ where: `Wire ${j + 1}'s template`, get: () => w.template!, set: (t: string) => void (w.template = t), max: PLAN_MAX.prompt }])),
  ];
}

/**
 * Plan `p` as an agent sent it, made safe to show: invisible characters taken out (they reorder or hide text where the
 * user reads it), and secret-looking values replaced (redactSecrets). Refused whole when any text holds a private key,
 * when a name would change, or when a redacted text no longer fits. Answers what was done, for the dialog to say.
 */
function cleaned(p: Plan): { plan: Plan; notes: string[] } {
  const plan = structuredClone(p);
  let redacted = 0;
  let invisible = 0;
  for (const t of textsOf(plan)) {
    const raw = t.get();
    if (holdsPrivateKey(raw)) throw new PlanError(`${t.where} holds a private key, so nothing was held: take it out and call again.`);
    const seen = raw.replace(INVISIBLE_RE, "");
    invisible += raw.length - seen.length;
    const r = redactSecrets(seen);
    if (t.line && r.count) throw new PlanError(`${t.where} holds a secret-looking value: name the step plainly.`);
    if (r.text.length > t.max) throw new PlanError(`${t.where} is ${nOf(r.text.length)} characters once its secret-looking values are replaced with ${REDACTED}; the limit is ${nOf(t.max)}: shorten it.`);
    redacted += r.count;
    t.set(r.text);
  }
  const notes = [
    ...(redacted ? [`${plural(redacted, "secret-looking value")} ${redacted === 1 ? "was" : "were"} replaced with ${REDACTED} as the plan was held. Redaction is a net, not a guarantee: read it before laying it out.`] : []),
    ...(invisible ? [`${plural(invisible, "invisible character")} ${invisible === 1 ? "was" : "were"} taken out as the plan was held: they can reorder or hide text where you read it.`] : []),
  ];
  return { plan, notes };
}

/** Why the plan a dialog sent back can't be laid out as it is: what's laid out is what was shown, so nothing here is changed, only refused. */
function shownRefusal(p: Plan): string | null {
  for (const t of textsOf(p)) {
    const raw = t.get();
    if (holdsPrivateKey(raw)) return `${t.where} holds a private key: take it out.`;
    if (INVISIBLE_RE.test(raw)) {
      INVISIBLE_RE.lastIndex = 0;
      return `${t.where} holds invisible characters, which can hide text where you read it: retype it.`;
    }
    if (redactSecrets(raw).count) return `${t.where} holds a secret-looking value: take it out, or the step would be told it.`;
  }
  return null;
}

/** A plan wire's settings as wires:add takes them, its gate `gate`. */
const settingsOf = (w: PlanWire, gate: WireGate): WireSettings => ({
  ...(w.template !== undefined ? { template: w.template } : {}),
  ...(w.when !== undefined ? { when: w.when } : {}),
  ...(carriesWork(w.type) ? { gate } : {}),
  ...(w.rounds !== undefined ? { limit: w.rounds } : {}),
  ...(w.toolOutput === false ? { toolOutput: false } : {}),
});

export class Plans {
  private data: Record<string, HeldPlan>;
  /** Plans gone this run, and why: a dialog still open on one is told which. */
  private spent = new Map<string, string>();
  /** A plan being laid out now: one at a time. */
  private layingOut = false;

  constructor(private readonly o: PlansOptions) {
    this.data = this.load();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  // ---- plans.json ----------------------------------------------------------------------------

  private load(): Record<string, HeldPlan> {
    const raw = readJsonOrSetAside(this.o.file, null, "plans.json");
    if (raw === null) return {};
    if (!isObj(raw) || raw.v !== 1 || !isObj(raw.plans)) {
      this.o.log("plans: plans.json isn't a version 1 plans file", new Error("its held plans are let go; the next plan writes over it"));
      return {};
    }
    const out: Record<string, HeldPlan> = {};
    for (const [id, v] of Object.entries(raw.plans as Record<string, unknown>)) {
      try {
        if (!isObj(v) || typeof v.from !== "string" || (v.ticket !== null && typeof v.ticket !== "string") || typeof v.at !== "number") throw new PlanError("its record isn't a held plan's");
        if (v.replaces !== undefined && typeof v.replaces !== "string") throw new PlanError("what it replaces isn't an id");
        const notes = v.notes === undefined ? [] : Array.isArray(v.notes) && v.notes.every((n) => typeof n === "string") ? (v.notes as string[]) : null;
        if (!notes) throw new PlanError("its notes aren't a list of text");
        out[id] = { from: v.from, ticket: v.ticket as string | null, at: v.at, ...(v.replaces ? { replaces: v.replaces as string } : {}), plan: readShownPlan(v.plan), ...(notes.length ? { notes } : {}) };
      } catch (err) {
        if (!(err instanceof PlanError)) throw err;
        this.o.log(`plans: plans.json's plan ${JSON.stringify(id)} can't be read, and is let go`, err);
      }
    }
    return out;
  }

  /** Saved, or else the change taken back and thrown: a plan is held only once it's written. */
  private change<T>(fn: () => T): T {
    const before = structuredClone(this.data);
    try {
      const r = fn();
      const file: PlansFile = { v: 1, plans: this.data };
      writeFileAtomic(this.o.file, JSON.stringify(file, null, 2), 0o600);
      return r;
    } catch (err) {
      this.data = before;
      throw err;
    }
  }

  private changed(): void {
    try {
      this.o.onChanged();
    } catch (err) {
      this.o.log("plans: telling the windows the plans changed", err);
    }
  }

  private spend(id: string, why: string): void {
    this.spent.delete(id);
    this.spent.set(id, why);
    for (const k of this.spent.keys()) {
      if (this.spent.size <= SPENT_KEPT) break;
      this.spent.delete(k);
    }
  }

  /** Held plan `id`, or why there's none to lay out or dismiss. */
  private heldOf(id: string): HeldPlan {
    const held = Object.hasOwn(this.data, id) ? this.data[id] : undefined;
    if (held) return held;
    throw new Error(this.spent.get(id) ?? "That plan isn't held any more: it was laid out, dismissed or replaced.");
  }

  /** Plan `id` taken out of plans.json, saved, so no other call can lay it out or dismiss it; `why` says it went. */
  private take(id: string, why: string): HeldPlan {
    const held = this.heldOf(id);
    this.change(() => void delete this.data[id]);
    this.spend(id, why);
    return held;
  }

  /** Plan `id` put back after a lay-out made nothing of it, unless its Orchestrator has held a newer one since. */
  private putBack(id: string, held: HeldPlan): void {
    if (Object.values(this.data).some((p) => p.from === held.from)) return;
    try {
      this.change(() => void (this.data[id] = held));
      this.spent.delete(id);
    } catch (err) {
      this.o.log(`plans: plan ${id} wasn't laid out, and couldn't be held again`, err);
    }
  }

  // ---- whose, and what it may name ------------------------------------------------------------

  private sessionOf(id: string): SessionInfo | undefined {
    return this.o.sessions.list().find((s) => s.id === id) ?? this.o.sessions.resumable().find((s) => s.id === id) ?? this.o.sessions.planned().find((s) => s.id === id);
  }

  /**
   * What Orchestrator `me`'s plan is checked against: its area (its top-level group) and that area's other workspaces
   * of this Mac's, each with why a plan can't name it; its repos; whether it's a team room's; this Mac's agents and models.
   * A workspace across a room's line from it (outside its sandbox, say) can't be named: a plan stays on its side.
   */
  private async contextFor(me: SessionInfo): Promise<{ ctx: PlanContext; area: string; room: string | null }> {
    const area = topOfKey(me.taskGroup ?? me.ticketId ?? "");
    if (!area) throw new Error("This Orchestrator is in no area, and its plan's steps go in its area: move it into one first.");
    if (!this.o.roomsKnown()) throw new Error(ROOMS_STARTING);
    const room = this.o.roomOfGroup(area) ?? this.o.roomOf(me.id);
    const all = new Map<string, SessionInfo>();
    for (const s of [...this.o.sessions.planned(), ...this.o.sessions.resumable(), ...this.o.sessions.list()]) all.set(s.id, s);
    const endOf = (s: SessionInfo, refusal: string | null): PlanEnd => ({
      id: s.id,
      title: plainLine(s.ticketTitle ?? s.title, 80),
      kind: s.shell ? "terminal" : "agent",
      agent: s.shell ? null : (s.agent ?? "claude"),
      repo: s.repoPath,
      branch: s.branch,
      ticket: ticketOfSession(s),
      refusal,
    });
    const existing: Record<string, PlanEnd> = {};
    for (const s of all.values()) {
      if (s.id === me.id || topOfKey(s.taskGroup ?? s.ticketId ?? "") !== area) continue;
      const refusal = s.debrief
        ? "it's a morning brief or wrap-up, which takes no wires."
        : s.role === "tasks"
          ? "it's the Helpdesk tasks workspace, which takes no wires."
          : (this.o.takenOver(s.id, "wiring it from a plan") ?? (this.o.roomOf(s.id) !== this.o.roomOf(me.id) ? ROOM_LINE : null));
      existing[s.id] = endOf(s, refusal);
    }
    const [installed, catalog] = await Promise.all([this.o.installed(), this.o.catalog()]);
    const repos = [...new Set([me, ...all.values()].filter((s) => s.id === me.id || topOfKey(s.taskGroup ?? s.ticketId ?? "") === area).flatMap((s) => (s.repoPath ? [s.repoPath] : [])))];
    return { ctx: { me: endOf(me, null), existing, installed, catalog, repos, room: !!room, ticket: ticketOfSession(me) }, area, room };
  }

  // ---- the tool ------------------------------------------------------------------------------

  /**
   * propose_plan for Orchestrator `me`: read strictly, made safe to show (cleaned), checked whole against its area, and
   * held, replacing its earlier plan. Nothing is made. It answers at once. Refused for a session that isn't an
   * Orchestrator, one a teammate took over, before rooms are known, and for anything the rules refuse, saying why.
   */
  async propose(me: SessionInfo, args: Record<string, unknown>): Promise<Reply> {
    if (me.role !== "orchestrator") return { error: `Only an Orchestrator workspace proposes a plan; this one isn't. Nothing was held.` };
    const taken = this.o.takenOver(me.id, "proposing a plan from this copy");
    if (taken) return { error: taken };
    try {
      const { plan, notes } = cleaned(readPlanArgs(args));
      const { ctx } = await this.contextFor(me);
      const layout = checkPlan(plan, ctx);
      const ticket = ticketOfSession(me);
      const old = Object.entries(this.data).filter(([, p]) => p.from === me.id);
      let id = "";
      this.change(() => {
        for (const [k] of old) delete this.data[k];
        do id = (this.o.newId ?? (() => randomUUID().slice(0, 8)))();
        while (Object.hasOwn(this.data, id) || this.spent.has(id));
        this.data[id] = { from: me.id, ticket, at: this.now(), ...(old.length ? { replaces: old[0][0] } : {}), plan, ...(notes.length ? { notes } : {}) };
      });
      for (const [k] of old) this.spend(k, `That plan was replaced by a newer one from “${plainLine(me.title, 80)}”: open that one instead.`);
      this.changed();
      const starts = layout.steps.filter((s) => s.starts).length;
      return {
        result:
          `Held for the user: ${plural(plan.steps.length, "step")} and ${plural(plan.wires.length, "wire")}${ticket ? ` for #${ticket}` : ""}. Nothing exists until they lay it out from Mockingbird, ` +
          `and they may change any of it first. Laid out as it is, ${starts ? `${plural(starts, "step")} ${starts === 1 ? "starts" : "start"} with ${starts === 1 ? "its" : "their"} prompt` : "no step starts"}` +
          `${plan.steps.length - starts ? ` and ${plan.steps.length - starts} ${plan.steps.length - starts === 1 ? "waits" : "wait"} for ${plan.steps.length - starts === 1 ? "its" : "their"} handoff` : ""}. ` +
          `You'll hear if they dismiss it.${old.length ? " It replaces your earlier plan." : ""}${notes.length ? ` ${notes.join(" ")}` : ""}`,
      };
    } catch (err) {
      if (err instanceof PlanError) return { error: `Nothing was held: ${err.message}` };
      if (err instanceof Error && (err.message === ROOMS_STARTING || err.message.startsWith("This Orchestrator is in no area"))) return { error: err.message };
      this.o.log(`plans: ${TICKET_TOOL.proposePlan} for ${me.id} failed`, err);
      return { error: `${TICKET_TOOL.proposePlan} failed: ${errText(err)}` };
    }
  }

  // ---- the window ----------------------------------------------------------------------------

  /** Every held plan as the window shows it, each checked again on the sessions now. A plan whose Orchestrator is forgotten is let go. */
  async list(): Promise<PlanView[]> {
    const out: PlanView[] = [];
    for (const [id, held] of Object.entries(this.data)) {
      const me = this.sessionOf(held.from);
      if (!me) {
        this.sessionForgotten(held.from);
        continue;
      }
      let problem: string | null = null;
      let view: Omit<PlanView, "problem"> | null = null;
      try {
        const { ctx, area, room } = await this.contextFor(me);
        view = { id, held, me: ctx.me, ticketTitle: held.ticket ? this.o.ticketTitleOf(held.ticket) : null, area, room, existing: { ...ctx.existing }, installed: [...ctx.installed], repos: [...ctx.repos] };
        checkPlan(held.plan, ctx);
      } catch (err) {
        if (!view) {
          // its area can't be worked out now (rooms starting): shown, and Lay out says why
          view = { id, held, me: { id: me.id, title: plainLine(me.title, 80), kind: "agent", agent: me.agent ?? "claude", repo: me.repoPath, branch: me.branch, ticket: ticketOfSession(me), refusal: null }, ticketTitle: null, area: topOfKey(me.taskGroup ?? me.ticketId ?? ""), room: null, existing: {}, installed: [], repos: [] };
        }
        problem = errText(err);
      }
      out.push({ ...view, problem });
    }
    return out.sort((a, b) => b.held.at - a.held.at);
  }

  /** Orchestrator `id` was forgotten: its held plans go with it. */
  sessionForgotten(id: string): void {
    const mine = Object.keys(this.data).filter((k) => this.data[k].from === id);
    if (!mine.length) return;
    try {
      this.change(() => mine.forEach((k) => delete this.data[k]));
      for (const k of mine) this.spend(k, "That plan's Orchestrator was forgotten, and its plan went with it.");
      this.changed();
    } catch (err) {
      this.o.log(`plans: Orchestrator ${id} was forgotten, and its plans couldn't be let go`, err);
    }
  }

  /**
   * Dismiss plan `id` (the dialog's Dismiss): it goes, and its Orchestrator is told, with the user's note. Nothing was made.
   */
  dismiss(idRaw: unknown, noteRaw: unknown): { told: AgentTold } {
    const id = String(idRaw ?? "");
    const note = typeof noteRaw === "string" ? noteRaw.trim() : "";
    if (note.length > NOTE_MAX) throw new Error(`The note is ${nOf(note.length)} characters; the limit is ${nOf(NOTE_MAX)}.`);
    const held = this.take(id, "That plan was dismissed.");
    this.changed();
    const line =
      `[Mockingbird: the user dismissed your plan${held.ticket ? ` for #${held.ticket}` : ""}. Nothing was made. ` +
      `${note ? "Their note follows." : "They left no note."} Propose another with ${TICKET_TOOL.proposePlan} if they ask for one.]${note ? `\n\n${note}` : ""}`;
    return { told: this.tell(held.from, line) };
  }

  /** `text` to Orchestrator `to` through its queue, or why it wasn't: not running, or taken over. Never throws. */
  private tell(to: string, text: string): AgentTold {
    try {
      const s = this.o.sessions.list().find((x) => x.id === to && !x.shell);
      const closed = s ?? this.sessionOf(to);
      const title = closed?.title ?? null;
      if (!s || s.status === "dead") return { to, title, notTold: `${title ? `“${plainLine(title, 80)}”` : "Its Orchestrator"} isn't running, so it wasn't told: once you reopen it, tell it yourself.`, ...(title ? { reopen: true as const } : {}) };
      const taken = this.o.takenOver(to, "telling this copy");
      if (taken) return { to, title: s.title, notTold: taken };
      return { to, title: s.title, told: this.o.sessions.deliverAgentMessage(to, text, this.o.submitOnDelivery(s)) };
    } catch (err) {
      this.o.log(`plans: telling ${to}`, err);
      return { to, title: null, notTold: `It couldn't be told: ${errText(err)}` };
    }
  }

  /**
   * Lay out plan `id` as the dialog showed it (`shown`): read and checked again here as at propose_plan, against its
   * Orchestrator's area as it is now, every wire probed in the area's room (every gate asking in a team room's), and
   * refused rather than changed when its text holds what propose_plan would have taken out. Then, under the held plan's
   * id, once (taken out of plans.json before anything is made): each step a not-started record (W8) under the room's
   * rules, its wires, and the steps nothing but the Orchestrator hands off to started with their prompts, those
   * handoffs counted sent. A refusal before all are made takes everything back and holds the plan again.
   */
  async layOut(idRaw: unknown, shownRaw: unknown, d: PlanLayOutDeps): Promise<PlanLaidOut> {
    if (this.layingOut) throw new Error("A plan is being laid out already: wait for that to finish.");
    this.layingOut = true;
    try {
      return await this.layOutNow(String(idRaw ?? ""), shownRaw, d);
    } finally {
      this.layingOut = false;
    }
  }

  private async layOutNow(id: string, shownRaw: unknown, d: PlanLayOutDeps): Promise<PlanLaidOut> {
    const held = this.heldOf(id);
    const me = this.sessionOf(held.from);
    if (!me) throw new Error("Its Orchestrator was forgotten, so its plan can't be laid out.");
    if (me.planned) throw new Error("Its Orchestrator hasn't started, so it has no folder for the plan's steps.");
    const taken = this.o.takenOver(me.id, "laying out its plan");
    if (taken) throw new Error(taken);
    const { ctx, area, room } = await this.contextFor(me);
    let plan: Plan;
    let layout: PlanLayOut;
    try {
      plan = readShownPlan(shownRaw);
      const why = shownRefusal(plan);
      if (why) throw new PlanError(why);
      layout = checkPlan(plan, ctx);
    } catch (err) {
      if (err instanceof PlanError) throw new Error(`The plan can't be laid out: ${err.message}`, { cause: err });
      throw err;
    }
    const unwritable = this.o.store.wiresWriteRefusal();
    if (unwritable) throw new Error(unwritable);
    const state = this.o.store.wires();
    if (!state.book) throw new Error(state.refused ?? "Wires can't be read right now.");

    // each wire as the rules see it with its steps in the area's room, before anything is made
    const keyed = new Map(plan.steps.map((s) => [s.key, s]));
    const nameOf = (k: string) => (k === ME ? me.title : (keyed.get(k)?.name ?? ctx.existing[k]?.title ?? k));
    const label = (w: PlanWire) => `${nameOf(w.from)} → ${nameOf(w.to)}`;
    const wctx = this.o.wires.context(state.book);
    const probe = (k: string): WireEnd => {
      const s = keyed.get(k)!;
      return { id: `\0${k}`, title: s.name, kind: s.agent === "terminal" ? "terminal" : "agent", debrief: false, tasks: false, room, takenOver: null, outsideSandbox: false, where: "planned", placed: true, folder: `\0${k}`, hooksSilent: false, ticket: ctx.ticket, branch: null };
    };
    const probed: GateContext = { ...wctx, links: {}, kept: {}, end: (e) => (e.startsWith("\0") ? probe(e.slice(1)) : wctx.end(e)) };
    const probeId = (k: string) => (k === ME ? me.id : keyed.has(k) ? `\0${k}` : k);
    for (const p of layout.wires) {
      if (p.skipped || p.wire.type === "worktree") continue;
      const settings = settingsOf(p.wire, p.gate);
      // when its PR merges is set once its source has started, on a ticket's branch
      if (p.afterStart) delete settings.when;
      const [f, t] = [probeId(p.wire.from), probeId(p.wire.to)];
      const why = wireRefusal(f, t, p.wire.type, probed) ?? settingsRefusal({ from: f, to: t, type: p.wire.type }, settings, probed);
      if (why) throw new Error(`The plan can't be laid out: ${label(p.wire)}: ${why}`);
    }

    this.take(id, "That plan was laid out already.");
    this.changed();
    const made: LayOutReply["steps"] = [];
    const idOf = new Map<string, string>();
    const endId = (k: string) => (k === ME ? me.id : (idOf.get(k) ?? k));
    const undo = (why: string): never => {
      const left: string[] = [];
      let wiresLeft: string | null = null;
      for (const m of [...made].reverse()) {
        try {
          wiresLeft = d.forget(m.id) ?? wiresLeft;
        } catch (err) {
          this.o.log(`plans: laying out ${id}, ${m.id} couldn't be taken back`, err);
          left.push(`“${m.title}”`);
        }
      }
      this.putBack(id, held);
      this.changed();
      const said = [
        ...(left.length ? [`${left.join(", ")} couldn't be taken back: forget ${left.length === 1 ? "it" : "them"} from ${left.length === 1 ? "its" : "their"} menu.`] : []),
        ...(wiresLeft ? [`Its wires couldn't be taken back (${wiresLeft}): remove them from their right-click.`] : []),
      ];
      throw new Error(`Couldn't lay out the plan: ${why}. ${said.length ? said.join(" ") : "Nothing was left, and the plan is held as it was."}`);
    };
    const line = ticketLine(ctx.ticket, ctx.ticket ? this.o.ticketTitleOf(ctx.ticket) : null);
    for (const p of layout.steps) {
      const s = p.step;
      const agent = agentOf(s);
      if (!agent) continue;
      let info: SessionInfo;
      try {
        info = d.planStep({
          title: s.name,
          agent,
          ...(s.model ? { model: s.model } : {}),
          ...(s.effort ? { effort: s.effort } : {}),
          repoPath: s.folder === "new" ? p.repo : null,
          worktree: s.folder === "new",
          taskGroup: area,
          // the ticket's title only in its prompt: a session's ticketTitle would stand for every step's own name
          ...(ctx.ticket ? { ticketId: ctx.ticket } : {}),
          prompt: withTicket(s.prompt, line),
          ...(s.folder === "orchestrator" ? { sharesWith: me.id } : typeof s.folder === "object" ? { sharesWith: idOf.get(s.folder.sameAs)! } : {}),
        });
      } catch (err) {
        return undo(`“${s.name}” was refused: ${errText(err)}`);
      }
      made.push({ key: s.key, id: info.id, title: s.name });
      idOf.set(s.key, info.id);
    }
    const wires: string[] = [];
    const wireIdOf = new Map<number, string>();
    for (const [j, p] of layout.wires.entries()) {
      if (p.skipped || p.afterStart) continue;
      if (p.wire.type === "worktree") {
        // a terminal on the Orchestrator's tree, made now: the Orchestrator has a tree already
        const to = keyed.get(p.wire.to)!;
        try {
          const t = await d.addTerminal(me, { title: to.name, command: to.prompt });
          made.push({ key: to.key, id: t.id, title: to.name });
          idOf.set(to.key, t.id);
        } catch (err) {
          return undo(`“${to.name}” wasn't made on ${me.title}'s tree: ${errText(err)}`);
        }
        continue;
      }
      const r = this.o.wires.add(endId(p.wire.from), endId(p.wire.to), p.wire.type, settingsOf(p.wire, p.gate));
      if ("refused" in r) return undo(`${label(p.wire)} was refused: ${r.refused}`);
      wires.push(r.id!);
      wireIdOf.set(j, r.id!);
    }

    // the steps that start, in the plan's order (a step sharing another's folder comes after it)
    const notes: string[] = [];
    if (layout.forced) notes.push(`In a team room's area every gate asks, so ${layout.forced === 1 ? "its automatic gate was" : `its ${layout.forced} automatic gates were`} laid out asking.`);
    for (const p of layout.steps) if (p.terminal && !p.terminal.laid) notes.push(`“${p.step.name}” ${p.terminal.why.replace(/^It /, "")}`);
    const started: string[] = [];
    for (const p of layout.steps) {
      if (!p.starts) continue;
      const s = p.step;
      const sentIn = layout.wires.map((w, j) => ({ w, j })).filter((x) => x.w.sentByLayOut && x.w.wire.to === s.key);
      let info: SessionInfo;
      try {
        info = await d.start(idOf.get(s.key)!, sentIn.length ? me.id : null, ctx.ticket ? this.o.ticketTitleOf(ctx.ticket) : null);
      } catch (err) {
        notes.push(`“${s.name}” didn't start: ${errText(err)}. It's laid out and waits: start it with Start now in its menu.`);
        for (const w of layout.wires.filter((x) => x.afterStart && !x.skipped && x.wire.from === s.key))
          notes.push(w.wire.type === "worktree" ? `“${keyed.get(w.wire.to)!.name}” wasn't made, as it runs on “${s.name}”'s tree: once that has started, Add terminal on its tree makes one.` : `${label(w.wire)} wasn't made, as it needs “${s.name}” started on its branch: make it from “${s.name}” once it has.`);
        continue;
      }
      started.push(info.id);
      for (const { j } of sentIn) {
        const wid = wireIdOf.get(j);
        const r = wid ? d.countSent(wid, `Lay out sent it: “${s.name}” started with its prompt from the plan.`) : null;
        if (r && "refused" in r) notes.push(`${label(layout.wires[j].wire)} wasn't counted sent (${r.refused}): its gate may offer it again when ${me.title} finishes.`);
      }
      for (const w of layout.wires.filter((x) => x.afterStart && !x.skipped && x.wire.from === s.key)) {
        if (w.wire.type === "worktree") {
          const to = keyed.get(w.wire.to)!;
          try {
            const t = await d.addTerminal(info, { title: to.name, command: to.prompt });
            made.push({ key: to.key, id: t.id, title: to.name });
          } catch (err) {
            notes.push(`“${to.name}” wasn't made on “${s.name}”'s tree: ${errText(err)}`);
          }
          continue;
        }
        const r = this.o.wires.add(info.id, endId(w.wire.to), w.wire.type, settingsOf(w.wire, w.gate));
        if ("refused" in r) notes.push(`${label(w.wire)} wasn't made: ${r.refused}`);
        else wires.push(r.id!);
      }
    }
    const waiting = layout.steps.filter((p) => !p.starts && !p.terminal).map((p) => `“${p.step.name}”`);
    const startedNames = layout.steps.filter((p) => p.starts && started.includes(idOf.get(p.step.key)!)).map((p) => `“${p.step.name}”`);
    this.tell(
      me.id,
      `[Mockingbird: the user laid out your plan${held.ticket ? ` for #${held.ticket}` : ""}, as they read and edited it. ` +
        `${startedNames.length ? `${startedNames.join(", ")} started with ${startedNames.length === 1 ? "its" : "their"} prompt${startedNames.length === 1 ? "" : "s"}` : "No step started"}` +
        `${waiting.length ? `; ${waiting.join(", ")} ${waiting.length === 1 ? "waits" : "wait"} for ${waiting.length === 1 ? "its" : "their"} handoff` : ""}. ` +
        `What you handed them went as their prompts, so don't call ${MCP_SERVER} ${WIRE_TOOL.finishStep} for it. Create nothing yourself; propose another plan only if the user asks.]`
    );
    return { steps: made, wires, started: started[0] ?? null, notes, area };
  }

  // ---- an Orchestrator's start -------------------------------------------------------------------

  /**
   * Lay out a template whose first step is an Orchestrator (W17): that step only, as From a ticket… starts a session, in
   * a worktree of the ticket's repo on the ticket's branch, in the area chosen, told its Tell it, the ticket fenced as
   * text others wrote, and the rest of the template as its plan's starting shape. Its ticket is tracked at BA, not
   * moved to Coding: the Coder starting does that.
   */
  async startOrchestrator(raw: unknown, d: OrchestratorStartDeps): Promise<LayOutReply> {
    const req = isObj(raw) ? raw : {};
    const name = oneLine(req.name, 60) || "The template";
    let body: TemplateBody;
    try {
      body = parseTemplateBody(req.template);
    } catch (err) {
      if (err instanceof TemplateError) throw new Error(`“${name}” can't be laid out: ${err.message}`, { cause: err });
      throw err;
    }
    if (!startsAtOrchestrator(body)) throw new Error(`“${name}” doesn't start at an Orchestrator.`);
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const area = text(req.area);
    if (!area) throw new Error("Choose the area its Orchestrator goes in.");
    if (area.includes("/")) throw new Error("A template's steps go in an area, not a stack.");
    const ticketId = text(req.ticketId);
    const first = body.steps[0];
    if (!this.o.roomsKnown()) throw new Error(ROOMS_STARTING);
    const plan = layOutPlan(body, { room: !!this.o.roomOfGroup(area), ticket: !!ticketId });
    if (plan.problems.length || !ticketId) throw new Error(`“${name}” can't be laid out as it is: ${plan.problems.join(" ") || "choose a ticket."}`);
    const repoPath = text(req.repoPath);
    if (!repoPath) throw new Error(`“${first.name}” works in a worktree of the ticket's repo on its branch: choose a repo.`);
    const ticketTitle = text(req.ticketTitle) ?? "";
    const description = typeof req.ticketDescription === "string" ? req.ticketDescription : "";
    const base = text(req.base);
    const id = ticketIdOf(ticketId);
    const info = await d.create({
      repoPath,
      ticketId: id,
      branchName: slugBranch(id, suggestTicketName(ticketTitle) || "orchestrator"),
      useWorktree: true,
      ...(base ? { baseBranch: base } : {}),
      taskGroup: area,
      title: first.name,
      agent: agentOf(first) ?? "claude",
      ...(first.model ? { model: first.model } : {}),
      ...(first.effort ? { effort: first.effort } : {}),
      role: "orchestrator",
      initialPrompt: orchestratorKickoff({ ticketId: id, title: ticketTitle, description, told: withTicket(first.prompt, ticketLine(id, ticketTitle)), template: body }),
    });
    d.opened(info, ticketTitle);
    return {
      steps: [{ key: first.key, id: info.id, title: first.name }],
      wires: [],
      started: info.id,
      notes: [`It reads #${id} and proposes the rest as its plan, which comes to Needs you: nothing more is made until you lay it out.`],
    };
  }
}
