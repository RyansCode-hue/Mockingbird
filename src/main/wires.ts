import { randomUUID } from "crypto";
import type { LandscapeStore } from "./landscape";
import type { Reply } from "./messaging";
import { canonical, companionRequest } from "./handlers";
import { LandscapeShapeError, isObj, own, put, stackKeyOf } from "../shared/landscape";
import { agentOf, LayOutLeftError, layOutPlan, parseTemplateBody, roomAsked, startsAtOrchestrator, TemplateError, ticketLine, wireSettingsOf, withTicket, type LayOutReply, type TemplateBody, type TemplateWire } from "../shared/pipelineTemplates";
import { oneLine } from "../shared/team/agentText";
import type { BridgedWire, NewSessionRequest, PlanRequest, PrRepo, SessionInfo, StepStarted } from "../shared/types";
import { WireUndo, type HeldWire } from "./wireUndo";
import {
  bridgesOver,
  createdAtAfter,
  isSending,
  repointedWire,
  settingsOf,
  emptyWireBook,
  gateOf,
  keptNaming,
  newWire,
  parseWireSettings,
  readableKept,
  rekeyedBook,
  rekeyRefusal,
  restoredWire,
  restoreRefusal,
  MESSAGE_ROOM_LINE,
  ROOM_LINE,
  ROOMS_STARTING,
  sameWire,
  settingsRefusal,
  stepRefusal,
  WIRE_TYPES,
  wireEndOf,
  wireRefusal,
  withoutSession,
  withSettings,
  wiresInOrder,
  type GateContext,
  type KeptEntries,
  type MergeView,
  type Wire,
  type WireBook,
  type WireEnd,
  type WireReply,
  type WireSettings,
  type WireState,
  type WireType,
} from "../shared/wires";

/** What laying a template out (WireService.layOut) needs of the sessions and the team rooms. */
export interface LayOutDeps {
  /** A not-started step's record (SessionManager.planStep). */
  planStep(req: Omit<PlanRequest, "after" | "sharesFolder"> & { sharesWith?: string }): SessionInfo;
  /**
   * Let a step made go again, with its wires (sessions:kill with forget): throws when it couldn't be, and answers why
   * its wires stayed when it went but they couldn't (sessionForgotten), else null.
   */
  forget(id: string): string | null;
  /**
   * Start a not-started step, placed and its ticket's coding started, as Start now does (index.ts' startStep):
   * `ticketTitle` names the ticket there, as the step's own record carries only its id. Throws when it didn't start.
   */
  start(id: string, ticketTitle: string | null): Promise<StepStarted>;
  /** A terminal on a started agent's tree, wired to it (addTerminal), running `command`. */
  addTerminal(agent: SessionInfo, as: { title: string; command: string }): Promise<SessionInfo>;
  /** The team room a top-level group is shared as, or null. */
  roomOfGroup(group: string): string | null;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Wires removed this run that their Undo can still restore; older ones have gone for good. */
const RESTORABLE = 50;

/** What delivery does as a wire is removed and restored (WireDelivery's methods of these names). */
export interface WireDeliveryHooks {
  /** Wire `id` was removed as `w`: its message still queued at the other end comes out of that queue unpasted. */
  withdraw(id: string, w: Wire): void;
  /** Wire `w` as Undo puts it back: nothing still on its way (restoredWire). */
  restoring(w: Wire): Wire;
  /** Wire `id` is back: what waited at its automatic gate behind what it had on its way is tried. */
  restored(id: string): void;
}

export interface WireServiceOptions {
  store: Pick<LandscapeStore, "get" | "wires" | "editWires" | "wiresWriteRefusal">;
  /** Every session this Mac has: running, closed, and not started (planned). */
  sessions: { list(): SessionInfo[]; resumable(): SessionInfo[]; planned?(): SessionInfo[] };
  /** The team room a session of this Mac's is in. */
  roomOf: (id: string) => string | null;
  /**
   * Whether roomOf can be believed yet: false until team rooms have started (or found they can't), when roomOf says no
   * room for every session. Until then every wire is refused (ROOMS_STARTING). Left out, it can.
   */
  roomsKnown?: () => boolean;
  /** Why a session can't be wired because a teammate took it over; null when none did. */
  takenOver: (id: string) => string | null;
  /** Whether a session of this Mac's is in a team room but outside its sandbox (outsideRoomSandbox). */
  outsideSandbox?: (id: string) => boolean;
  log: (context: string, err: unknown) => void;
  /** Delivery's part as a wire leaves and comes back (WireDelivery), the one writer of what's on its way. */
  delivery?: WireDeliveryHooks;
  /** Where what Undo puts back is kept across restarts (wireUndo.ts); left out, it's held in memory until the app quits. */
  undoFile?: string;
  /** A new wire id; random unless a test says otherwise. */
  newId?: () => string;
  /** A wire was made and saved (not restored: its ends heard of it when it was first made). Told after the change counts. */
  onAdded?: (id: string, wire: Wire) => void;
  /** The merge watch (prWatch.ts): what a pr-merged wire's pull requests say. */
  merges?: { view(w: Wire, source: WireEnd | null): MergeView | null };
  /** Wire `id` began waiting for its source's pull request to merge (made so, or set so): the merge watch records its source's repository. */
  onWaiting?: (id: string) => void;
}

/**
 * The wire book's changes and answers, in main (docs/landscape-wires.md). Each change is checked against the rules in
 * shared/wires.ts with the sessions as they are now, then saved by the store before it counts. A window can't reach the
 * book any other way: `landscape:update` refuses a patch naming it, and no MCP tool writes it.
 */
export class WireService {
  /**
   * What Undo puts back, kept across restarts: the records `remove` took (so a restore puts back what was there,
   * counters included, and a window can't supply its own), what `repoint` moved, and what a forgotten session's wires were.
   */
  private undo: WireUndo;

  constructor(private readonly o: WireServiceOptions) {
    this.undo = new WireUndo({ file: o.undoFile, max: RESTORABLE, log: o.log });
  }

  get(): WireState {
    return this.forWindows(this.o.store.wires());
  }

  /**
   * `s` as a window is told it (`wires:get`, `wires:changed`), with what only main can tell for its drawing: each
   * pr-merged wire's merge view, so one the merge watch blocks is drawn blocked, and each shared worktree wire's ends'
   * folders as the filesystem has them.
   */
  forWindows<S extends WireState>(s: S): S {
    if (!s.book) return s;
    const links = Object.entries(s.book.links).filter(([, w]) => w.when === "pr-merged" || w.type === "worktree");
    if (!links.length) return s;
    const ctx = this.context(s.book);
    const merges: Record<string, MergeView> = {};
    const folders: Record<string, string> = {};
    for (const [id, w] of links) {
      const view = w.when === "pr-merged" ? (ctx.mergeView?.(w) ?? null) : null;
      if (view) put(merges, id, view);
      if (w.type !== "worktree") continue;
      for (const e of [ctx.end(w.from), ctx.end(w.to)]) if (e) put(folders, e.id, e.folder);
    }
    return { ...s, ...(Object.keys(merges).length ? { merges } : {}), ...(Object.keys(folders).length ? { folders } : {}) };
  }

  /** A new wire, with `settings` on it if given. */
  add(fromRaw: unknown, toRaw: unknown, typeRaw: unknown, settingsRaw?: unknown): WireReply {
    const type = typeRaw as WireType;
    if (!WIRE_TYPES.includes(type)) return { refused: `There's no wire type ${JSON.stringify(typeRaw)}.` };
    const from = String(fromRaw ?? "");
    const to = String(toRaw ?? "");
    const settings = this.settingsFrom(settingsRaw ?? {});
    if ("refused" in settings) return settings;
    let id = "";
    let made: Wire | undefined;
    const reply = this.o.store.editWires((book, kept) => {
      const ctx = this.context(book, kept);
      const refused = wireRefusal(from, to, type, ctx) ?? settingsRefusal({ from, to, type }, settings.settings, ctx);
      if (refused) return { refused };
      id = this.unusedId(book, kept);
      const at = createdAtAfter(book.links, Date.now());
      made = withSettings(newWire(from, to, type, at), settings.settings, at);
      const links = { ...book.links };
      put(links, id, made);
      return { book: { ...book, links } };
    });
    if ("refused" in reply) return reply;
    try {
      this.o.onAdded?.(id, made!);
    } catch (err) {
      this.o.log(`wires: wire ${id} was made, and telling its ends failed`, err);
    }
    if (made!.when === "pr-merged") this.waiting(id);
    return { ...reply, id };
  }

  /** Change what a person can change on a wire: not its ends or type (remove it and make another), nor what it has counted, holds or delivered. */
  set(idRaw: unknown, settingsRaw: unknown): WireReply {
    const id = String(idRaw ?? "");
    const settings = this.settingsFrom(settingsRaw);
    if ("refused" in settings) return settings;
    let began = false;
    const reply = this.o.store.editWires((book) => {
      const w = own(book.links, id);
      if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
      const refused = settingsRefusal(w, settings.settings, this.context(book));
      if (refused) return { refused };
      const next = withSettings(w, settings.settings, Date.now());
      if (sameWire(next, w)) return { book };
      began = next.when === "pr-merged" && next.since !== w.since;
      const links = { ...book.links };
      put(links, id, next);
      return { book: { ...book, links } };
    });
    if (began && !("refused" in reply)) this.waiting(id);
    return reply;
  }

  private waiting(id: string): void {
    try {
      this.o.onWaiting?.(id);
    } catch (err) {
      this.o.log(`wires: wire ${id} began waiting for its pull request, and the merge watch couldn't be told`, err);
    }
  }

  /**
   * The merge watch's record of pr-merged wire `id`'s source's repository (`sourceRepo`), read from its origin once it
   * began waiting at `since`. Nothing changes for a wire that's gone, waits from another time or not at all, or has one
   * already: the repository is the one read for this wait, never a later one. Null when it's written or there was
   * nothing to write; why not when the book refused the write.
   */
  pinSourceRepo(id: string, since: number | undefined, repo: PrRepo): string | null {
    const reply = this.o.store.editWires((book) => {
      const w = own(book.links, id);
      if (!w || w.when !== "pr-merged" || w.since !== since || w.sourceRepo) return { book };
      const links = { ...book.links };
      put(links, id, { ...w, sourceRepo: { provider: repo.provider, repo: repo.repo } });
      return { book: { ...book, links } };
    });
    return "refused" in reply ? reply.refused : null;
  }

  /** Remove a wire, whatever state it's in. It can be restored for a while (restore). */
  remove(idRaw: unknown): WireReply {
    const id = String(idRaw ?? "");
    let taken: Wire | undefined;
    const reply = this.o.store.editWires((book) => {
      taken = own(book.links, id);
      if (!taken) return { refused: `There's no wire ${JSON.stringify(id)}.` };
      const links = { ...book.links };
      delete links[id];
      return { book: { ...book, links } };
    });
    if ("refused" in reply) return reply;
    // a newer removal under the same id goes to the back of the queue
    this.undo.set(`removed:${id}`, { kind: "removed", wire: taken!, at: Date.now() });
    try {
      this.o.delivery?.withdraw(id, taken!);
    } catch (err) {
      // it's removed and can be restored all the same; a message it left queued isn't pasted once its wire is gone
      this.o.log(`wires: ${id} was removed, but what it had queued couldn't be taken back out`, err);
    }
    return { ...reply, id };
  }

  /** Whether wire `id` was removed and is still held for `restore` (the most recent RESTORABLE removals are). */
  restorable(idRaw: unknown): boolean {
    return this.undo.has(`removed:${String(idRaw ?? "")}`);
  }

  /**
   * Put a removed wire back as it was, counters included, unless the rules on making one now refuse it. One removed
   * while its message was queued comes back failed, that message out of the other end's queue since the removal; one
   * removed while it was being pasted comes back unconfirmed (restoredWire).
   */
  restore(idRaw: unknown): WireReply {
    const id = String(idRaw ?? "");
    const held = this.undo.get(`removed:${id}`);
    if (held?.kind !== "removed") return { refused: "That wire can't be restored any more." };
    const w = held.wire;
    const reply = this.o.store.editWires((book, kept) => {
      const refused = restoreRefusal(book, id, w, this.context(book, kept));
      if (refused) return { refused };
      const links = { ...book.links };
      put(links, id, this.o.delivery ? this.o.delivery.restoring(w) : restoredWire(w));
      return { book: { ...book, links } };
    });
    if ("refused" in reply) return reply;
    this.undo.delete(`removed:${id}`);
    try {
      this.o.delivery?.restored(id);
    } catch (err) {
      this.o.log(`wires: ${id} was restored, but what waited at its gate couldn't be tried`, err);
    }
    return { ...reply, id };
  }

  /**
   * Move wire `id`'s ends (`ends.from`, `ends.to`, either or both) to other sessions, keeping its type and settings:
   * checked as making it there would be (wireRefusal: no wire to itself, none twice, no loop of handoffs, a room's line,
   * a terminal; then its settings from its new source, settingsRefusal). What it held for its old ends goes
   * (repointedWire). Refused while it's sending, or when nothing would change. Its Undo is `unrepoint`.
   */
  repoint(idRaw: unknown, endsRaw: unknown): WireReply {
    const id = String(idRaw ?? "");
    const ends = isObj(endsRaw) ? endsRaw : {};
    if (ends.from === undefined && ends.to === undefined) return { refused: "Say which end moves: its from, its to, or both." };
    for (const k of ["from", "to"] as const) if (ends[k] !== undefined && (typeof ends[k] !== "string" || !ends[k])) return { refused: `Its ${k} is a session's id.` };
    let before: Wire | undefined;
    let after: Wire | undefined;
    const reply = this.o.store.editWires((book, kept) => {
      const w = own(book.links, id);
      if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
      const from = (ends.from as string | undefined) ?? w.from;
      const to = (ends.to as string | undefined) ?? w.to;
      if (from === w.from && to === w.to) return { refused: "It runs between those two already." };
      if (isSending(w)) return { refused: "It's sending right now: move it once that's gone." };
      const ctx = { ...this.context(book, kept), self: id };
      const refused = wireRefusal(from, to, w.type, ctx) ?? settingsRefusal({ from, to, type: w.type }, settingsOf(w), ctx);
      if (refused) return { refused };
      before = w;
      after = repointedWire(w, from, to, Date.now());
      const links = { ...book.links };
      put(links, id, after);
      return { book: { ...book, links } };
    });
    if ("refused" in reply) return reply;
    this.undo.set(`repointed:${id}`, { kind: "repointed", before: before!, after: { from: after!.from, to: after!.to }, at: Date.now() });
    if (after!.when === "pr-merged" && after!.from !== before!.from) this.waiting(id);
    return { ...reply, id };
  }

  /** Whether wire `id`'s last repoint can still be undone (unrepoint). */
  repointUndoable(idRaw: unknown): boolean {
    return this.undo.has(`repointed:${String(idRaw ?? "")}`);
  }

  /**
   * Undo wire `id`'s last repoint: the record as it was before, counters included, while it still runs between the ends
   * that repoint gave it and the rules on making it where it was allow it now.
   */
  unrepoint(idRaw: unknown): WireReply {
    const id = String(idRaw ?? "");
    const held = this.undo.get(`repointed:${id}`);
    if (held?.kind !== "repointed") return { refused: "That wire's move can't be undone any more." };
    const reply = this.o.store.editWires((book, kept) => {
      const w = own(book.links, id);
      if (!w) return { refused: "That wire has been removed since." };
      if (w.from !== held.after.from || w.to !== held.after.to) return { refused: "That wire has been moved again since." };
      if (isSending(w)) return { refused: "It's sending right now: undo its move once that's gone." };
      const refused = wireRefusal(held.before.from, held.before.to, held.before.type, { ...this.context(book, kept), self: id });
      if (refused) return { refused };
      const links = { ...book.links };
      put(links, id, this.o.delivery ? this.o.delivery.restoring(held.before) : restoredWire(held.before));
      return { book: { ...book, links } };
    });
    if ("refused" in reply) return reply;
    this.undo.delete(`repointed:${id}`);
    return { ...reply, id };
  }

  /**
   * Move session `old`'s wires and note to `next` (Start fresh, before the ghost is forgotten), counters and what's
   * waiting included. All or none, by rekeyRefusal: a wire blocked where it is moves and stays blocked, and one that
   * moving would newly refuse keeps them all where they are.
   */
  rekey(oldRaw: unknown, nextRaw: unknown): WireReply {
    const old = String(oldRaw ?? "");
    const next = String(nextRaw ?? "");
    return this.o.store.editWires((book, kept) => {
      if (old === next || (!Object.hasOwn(book.notes, old) && !Object.values(book.links).some((w) => w.from === old || w.to === old))) return { book };
      const moved = rekeyedBook(book, old, next);
      const refused = rekeyRefusal(book, moved, old, next, this.context(moved, kept));
      return refused ? { refused } : { book: moved };
    });
  }

  /**
   * Session `old`'s work carries on in `next` (a brief's fresh session, Continue in Codex): its wires and note move
   * there as Start fresh moves them (rekey, all or none), so `next` takes its place in the pipeline. When they can't,
   * they stay on `old`, logged, and why is answered; null once they've moved, or when there were none.
   */
  carryOn(old: string, next: string): string | null {
    const r = this.rekey(old, next);
    if (!("refused" in r)) return null;
    this.o.log(`wires: ${old}'s wires stayed on it, as ${next}, which carries on its work, couldn't take them`, new Error(r.refused));
    return r.refused;
  }

  /**
   * "Add terminal on its tree": a terminal started (`create`) in agent `s`'s folder and group, as its companions are,
   * and wired to it by a shared worktree wire. Refused before it starts when such a wire couldn't be made now. One
   * started that the wire is still refused for (the book changed meanwhile) is stopped and forgotten (`forget`), and
   * the refusal is thrown.
   */
  async addTerminal(
    s: SessionInfo,
    d: { create(req: NewSessionRequest): Promise<SessionInfo>; forget(id: string): void },
    as: { title?: string; command?: string } = {}
  ): Promise<SessionInfo> {
    const refused = this.terminalRefusal(s);
    if (refused) throw new Error(refused);
    // a terminal's kickoff is typed in as a command (sessions.ts)
    const t = await d.create(companionRequest(s, { shell: true, title: as.title ?? `${s.ticketTitle ?? s.title} · terminal`, ...(as.command?.trim() ? { initialPrompt: as.command } : {}) }));
    const r = this.add(s.id, t.id, "worktree");
    if (!("refused" in r)) return t;
    try {
      d.forget(t.id);
    } catch (err) {
      this.o.log(`wires: terminal ${t.id} wasn't wired to ${s.id}, and couldn't be closed`, err);
    }
    throw new Error(r.refused);
  }

  /** Why a terminal on agent `s`'s tree couldn't be wired to it now, asked before one starts: wireRefusal with the terminal to be. */
  private terminalRefusal(s: SessionInfo): string | null {
    const unwritable = this.o.store.wiresWriteRefusal();
    if (unwritable) return unwritable;
    const state = this.o.store.wires();
    if (!state.book) return state.refused ?? "Wires can't be read right now.";
    const ctx = this.context(state.book);
    const agent = ctx.end(s.id);
    if (!agent) return `This Mac has no session "${s.id}".`;
    const next = "\0terminal";
    const terminal: WireEnd = { ...agent, id: next, title: "its terminal", kind: "terminal", debrief: false, tasks: false, takenOver: null, outsideSandbox: false, where: "running", placed: true, hooksSilent: false };
    return wireRefusal(s.id, next, "worktree", { ...ctx, end: (id) => (id === next ? terminal : ctx.end(id)) });
  }

  /**
   * Add next step (W8): a not-started step (`plan`) after session `req.after`, joined to it by a handoff wire. Refused
   * before it's made when no handoff could leave `req.after` now (stepRefusal); one made that the wire is then refused
   * for (its group across a room's line, the book changed meanwhile) is forgotten (`forget`), and the refusal thrown;
   * a step that then can't be forgotten is said with it, as it stays with no wire into it.
   */
  addStep(req: PlanRequest, d: { plan(req: PlanRequest): SessionInfo; forget(id: string): void }): { info: SessionInfo; wire: string } {
    const refused = this.stepRefusal(String(req?.after ?? ""));
    if (refused) throw new Error(refused);
    const info = d.plan(req);
    const made = this.add(req.after, info.id, "handoff");
    if (!("refused" in made)) return { info, wire: made.id! };
    try {
      d.forget(info.id);
    } catch (err) {
      this.o.log(`wires: not-started step ${info.id} wasn't wired from ${req.after}, and couldn't be forgotten`, err);
      throw new Error(`${made.refused} “${info.title}” was made, and couldn't be taken back, so it's there with no wire into it: forget it from its menu (${err instanceof Error ? err.message : err})`, { cause: err });
    }
    throw new Error(made.refused);
  }

  /** A template being laid out now: Lay out is one act, and a second while it runs is refused. */
  private layingOut = false;

  /**
   * Lay out (W9): template `raw.template` as not-started steps in area `raw.area`, joined by its wires, the first step
   * started when the template says so. Everything the rules can check is checked before a step is made: the template
   * whole (parseTemplateBody, layOutPlan), its worktrees' repo, the book, and each wire between the steps to be (their
   * room the area's). A team room's area makes every gate ask. Steps are made under the room's rules as Add next
   * step's are (SessionManager.planStep, stepPlace as they start), and a started one launches under the room's.
   *
   * Should a step or a wire then be refused, every step made is forgotten (`forget`, which takes its wires) and the
   * refusal is thrown, saying what couldn't be taken back if anything. Once they're all made, what doesn't go is said in
   * `notes` and the rest stays: the first step not starting (they all wait, to Start now), a wire that needs it started
   * (when its PR merges), or a terminal on its tree.
   */
  async layOut(raw: unknown, d: LayOutDeps): Promise<LayOutReply> {
    if (this.layingOut) throw new Error("A template is being laid out already: wait for that to finish.");
    this.layingOut = true;
    try {
      return await this.layOutNow(isObj(raw) ? raw : {}, d);
    } finally {
      this.layingOut = false;
    }
  }

  private async layOutNow(req: Record<string, unknown>, d: LayOutDeps): Promise<LayOutReply> {
    const name = oneLine(req.name, 60) || "The template";
    let body: TemplateBody;
    try {
      body = parseTemplateBody(req.template);
    } catch (err) {
      if (err instanceof TemplateError) throw new Error(`“${name}” can't be laid out: ${err.message}`, { cause: err });
      throw err;
    }
    // its Orchestrator is all that's laid out of it, and proposes the rest (Plans.startOrchestrator)
    if (startsAtOrchestrator(body)) throw new Error(`“${name}” starts at an Orchestrator, which is laid out alone: its plan makes the rest.`);
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const area = text(req.area);
    if (!area) throw new Error("Choose the area its steps go in.");
    if (area.includes("/")) throw new Error("A template's steps go in an area, not a stack.");
    const ticketId = text(req.ticketId);
    const ticketTitle = ticketId ? text(req.ticketTitle) : null;
    const repoPath = text(req.repoPath);
    const base = text(req.base);
    if (this.o.roomsKnown && !this.o.roomsKnown()) throw new Error(ROOMS_STARTING);
    const room = d.roomOfGroup(area);
    const plan = layOutPlan(body, { room: !!room, ticket: !!ticketId });
    if (plan.problems.length) throw new Error(`“${name}” can't be laid out as it is: ${plan.problems.join(" ")}`);
    const worktrees = body.steps.filter((s) => s.folder === "new");
    if (worktrees.length && !repoPath) throw new Error(`${worktrees.map((s) => `“${s.name}”`).join(", ")} ${worktrees.length === 1 ? "works" : "work"} in a worktree of ${worktrees.length === 1 ? "its" : "their"} own, which needs a repo: choose one.`);
    const unwritable = this.o.store.wiresWriteRefusal();
    if (unwritable) throw new Error(unwritable);
    const state = this.o.store.wires();
    if (!state.book) throw new Error(state.refused ?? "Wires can't be read right now.");

    const keyed = new Map(body.steps.map((s) => [s.key, s]));
    const label = (w: TemplateWire) => `${keyed.get(w.from)!.name} → ${keyed.get(w.to)!.name}`;
    // each wire made between the steps to be, as the rules see it with them in the area's room
    const ctx = this.context(state.book);
    const probe = (k: string): WireEnd => {
      const s = keyed.get(k)!;
      return { id: `\0${k}`, title: s.name, kind: s.agent === "terminal" ? "terminal" : "agent", debrief: false, tasks: false, room, takenOver: null, outsideSandbox: false, where: "planned", placed: true, folder: `\0${k}`, hooksSilent: false, ticket: ticketId, branch: null };
    };
    const probed: GateContext = { ...ctx, links: {}, kept: {}, end: (id) => (id.startsWith("\0") ? probe(id.slice(1)) : ctx.end(id)) };
    for (const p of plan.wires) {
      if (p.skipped || p.wire.type === "worktree") continue;
      const settings = wireSettingsOf(p.wire, p.gate);
      // when its PR merges is set once its source has started, on a ticket's branch
      if (p.afterStart) delete settings.when;
      const why = wireRefusal(`\0${p.wire.from}`, `\0${p.wire.to}`, p.wire.type, probed) ?? settingsRefusal({ from: `\0${p.wire.from}`, to: `\0${p.wire.to}`, type: p.wire.type }, settings, probed);
      if (why) throw new Error(`“${name}” can't be laid out: ${label(p.wire)}: ${why}`);
    }

    const made: LayOutReply["steps"] = [];
    const idOf = new Map<string, string>();
    const undo = (why: string): never => {
      const left: typeof made = [];
      let wiresLeft: string | null = null;
      for (const m of [...made].reverse()) {
        try {
          wiresLeft = d.forget(m.id) ?? wiresLeft;
        } catch (err) {
          this.o.log(`wires: laying out ${name}, step ${m.id} couldn't be taken back`, err);
          left.push(m);
        }
      }
      const titles = left.map((m) => `“${m.title}”`).join(", ");
      const said = [
        ...(left.length ? [`${titles} couldn't be taken back: forget ${left.length === 1 ? "it" : "them"} from ${left.length === 1 ? "its" : "their"} menu.`] : []),
        ...(wiresLeft ? [`Its wires couldn't be taken back (${wiresLeft}): remove them from their right-click.`] : []),
      ];
      const message = `Couldn't lay out “${name}”: ${why}. ${said.length ? said.join(" ") : "Nothing was left."}`;
      // the steps left stay in the area: one made for this lay-out is kept for them (TemplateLayOuts)
      throw left.length ? new LayOutLeftError(message, left.map((m) => m.id)) : new Error(message);
    };
    const line = ticketLine(ticketId, ticketTitle);
    for (const p of plan.steps) {
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
          repoPath: typeof s.folder === "object" ? null : repoPath,
          worktree: s.folder === "new",
          ...(s.folder === "new" && base ? { base } : {}),
          taskGroup: area,
          // the ticket's title only in its prompt: a session's ticketTitle would stand for every step's own name
          ...(ticketId ? { ticketId } : {}),
          ...(s.prompt.trim() ? { prompt: withTicket(s.prompt, line) } : {}),
          ...(typeof s.folder === "object" ? { sharesWith: idOf.get(s.folder.sameAs)! } : {}),
        });
      } catch (err) {
        return undo(`“${s.name}” was refused: ${errText(err)}`);
      }
      made.push({ key: s.key, id: info.id, title: s.name });
      idOf.set(s.key, info.id);
    }
    const wires: string[] = [];
    for (const p of plan.wires) {
      if (p.skipped || p.afterStart) continue;
      const r = this.add(idOf.get(p.wire.from), idOf.get(p.wire.to), p.wire.type, wireSettingsOf(p.wire, p.gate));
      if ("refused" in r) return undo(`${label(p.wire)} was refused: ${r.refused}`);
      wires.push(r.id!);
    }

    const notes: string[] = [];
    if (plan.forced) notes.push(roomAsked(plan.forced));
    for (const p of plan.steps) if (p.terminal && !p.terminal.laid) notes.push(`“${p.step.name}” ${p.terminal.why.replace(/^It /, "")}`);
    const first = plan.steps[0].step;
    const waiting = plan.wires.filter((p) => p.afterStart && !p.skipped);
    if (!body.startFirst) return { steps: made, wires, started: null, notes };
    // what goes wrong once the steps are made is said in the reply and logged here, under the session it's about
    const missed = (id: string, note: string, err: unknown) => {
      notes.push(note);
      this.o.log(`wires: laying out “${name}”, session ${id}: ${note}`, err);
    };
    const firstId = idOf.get(first.key)!;
    let started: SessionInfo;
    try {
      const r = await d.start(firstId, ticketTitle);
      started = r.info;
      if (r.stageWhy) notes.push(`“${first.name}” started, but ${r.stageWhy}.`);
    } catch (err) {
      missed(firstId, `“${first.name}” didn't start: ${errText(err)}. ${made.length === 1 ? "It's laid out and waits" : `Its ${made.length} steps are laid out and wait`}: start it with Start now in its menu.`, err);
      for (const p of waiting)
        notes.push(
          p.wire.type === "worktree"
            ? `“${keyed.get(p.wire.to)!.name}” wasn't made, as it runs on “${first.name}”'s tree: once that has started, Add terminal on its tree makes one.`
            : `${label(p.wire)} wasn't made, as it needs “${first.name}” started on its branch: make it from “${first.name}” once it has.`
        );
      return { steps: made, wires, started: null, notes };
    }
    for (const p of waiting) {
      const to = keyed.get(p.wire.to)!;
      if (p.wire.type === "worktree") {
        try {
          const t = await d.addTerminal(started, { title: to.name, command: to.prompt });
          made.push({ key: to.key, id: t.id, title: to.name });
          idOf.set(to.key, t.id);
        } catch (err) {
          missed(started.id, `“${to.name}” wasn't made on “${first.name}”'s tree: ${errText(err)}`, err);
        }
        continue;
      }
      const r = this.add(idOf.get(p.wire.from), idOf.get(p.wire.to), p.wire.type, wireSettingsOf(p.wire, p.gate));
      if ("refused" in r) missed(started.id, `${label(p.wire)} wasn't made: ${r.refused}`, new Error(r.refused));
      else wires.push(r.id!);
    }
    return { steps: made, wires, started: started.id, notes };
  }

  /**
   * Why not-started step `step` mustn't start from session `other`, the folder it shares or the commit it starts at
   * (SessionManager.startGuard): the rules on a handoff between the two as their ends stand now (the room line, a copy a
   * teammate continues, a room session outside its sandbox), whatever wires there are. A book that can't be read
   * doesn't stop it, as these rules aren't the book's.
   */
  startRefusal(step: string, other: string): string | null {
    const book = this.o.store.wires().book ?? emptyWireBook();
    return wireRefusal(other, step, "handoff", { ...this.context(book), links: {}, kept: {} });
  }

  /** Why no handoff could leave session `from` for a step after it now, asked before one is made (shared/wires.ts' stepRefusal). */
  stepRefusal(from: string): string | null {
    const unwritable = this.o.store.wiresWriteRefusal();
    if (unwritable) return unwritable;
    const state = this.o.store.wires();
    if (!state.book) return state.refused ?? "Wires can't be read right now.";
    return stepRefusal(from, this.context(state.book));
  }

  /**
   * Whether session `id` is the terminal of a shared worktree wire: on its agent's tree, so it closes with that worktree
   * rather than holding it (freeWorktree). False while the book can't be read: then it holds it, as any session does.
   */
  onTree(id: string): boolean {
    const book = this.o.store.wires().book;
    return !!book && Object.values(book.links).some((w) => w.type === "worktree" && w.to === id);
  }

  /**
   * Session `id` was forgotten: its wires and note go with it, and the windows are told which went, for the note saying
   * so. Kept entries that name it go too: their ends can be read though the rest of them can't. When the book can't be
   * changed now they stay, logged, and show as blocked with their end gone until they're removed by hand: the session
   * has gone whichever. Answers why they stayed, or null.
   */
  sessionForgotten(id: string): string | null {
    const r = this.o.store.editWires((book, kept) => ({ ...withoutSession(book, id), dropKept: { ...keptNaming(kept, id), why: `named session ${id}, which was forgotten, and went with it` } }));
    if (!("refused" in r)) return null;
    this.o.log(`wires: couldn't drop the wires of forgotten session ${id}`, new Error(r.refused));
    return r.refused;
  }

  /**
   * Session `id` was forgotten (Forget): its wires and note go with it as sessionForgotten takes them, and the gap it
   * leaves in its chain is closed in the same change: each handoff into it from A and out of it to B becomes A→B
   * (bridgesOver), with B's wire's settings. A bridge there already, or one to A itself, isn't made; one the rules
   * refuse is said in `unbridged`. What went and what was bridged is held for `unforget` under `undo`, with `record` (its
   * record as it was, for a not-started step to come back as it was), unless nothing went. When the book can't be
   * changed its wires stay (`wiresLeft` says why), as sessionForgotten leaves them.
   */
  forgetChain(id: string, record: SessionInfo | null, titleOf: (id: string) => string): { bridged: BridgedWire[]; unbridged: string[]; undo: string | null; wiresLeft: string | null } {
    let dropped: HeldWire[] = [];
    let bridged: BridgedWire[] = [];
    let unbridged: string[] = [];
    const r = this.o.store.editWires((book, kept) => {
      const gone = withoutSession(book, id);
      const ctx = this.context(gone.book, kept);
      const bridges = bridgesOver(id, gone.dropped, gone.book.links, ctx, createdAtAfter(gone.book.links, Date.now()));
      const links = { ...gone.book.links };
      const made: BridgedWire[] = [];
      for (const b of bridges) {
        if (!("wire" in b)) continue;
        const wid = this.unusedId({ ...gone.book, links }, kept);
        put(links, wid, b.wire);
        made.push({ id: wid, from: b.from, to: b.to });
      }
      dropped = gone.dropped;
      bridged = made;
      unbridged = bridges.flatMap((b) => ("refused" in b ? [`${titleOf(b.from)} → ${titleOf(b.to)}: ${b.refused}`] : []));
      return { book: { ...gone.book, links }, dropped: gone.dropped, dropKept: { ...keptNaming(kept, id), why: `named session ${id}, which was forgotten, and went with it` } };
    });
    if ("refused" in r) {
      this.o.log(`wires: couldn't drop the wires of forgotten session ${id}`, new Error(r.refused));
      return { bridged: [], unbridged: [], undo: null, wiresLeft: r.refused };
    }
    for (const b of bridged) {
      try {
        this.o.onAdded?.(b.id, own(r.state.book?.links ?? {}, b.id)!);
      } catch (err) {
        this.o.log(`wires: bridge ${b.id} was made over forgotten session ${id}, and telling its ends failed`, err);
      }
    }
    if (!record && !dropped.length) return { bridged, unbridged, undo: null, wiresLeft: null };
    const undo = `forgot:${id}:${randomUUID().slice(0, 8)}`;
    this.undo.set(undo, { kind: "forgot", session: record, wires: dropped, bridges: bridged.map((b) => b.id), at: Date.now() });
    return { bridged, unbridged, undo, wiresLeft: null };
  }

  /** Whether Forget `token` (forgetChain's) can still be undone (unforget). */
  forgetUndoable(tokenRaw: unknown): boolean {
    return this.undo.get(String(tokenRaw ?? ""))?.kind === "forgot";
  }

  /**
   * Undo a Forget (`token`, forgetChain's): its record put back first when one was kept (`restoreRecord`, which throws
   * saying why it can't be), then, in one change, the bridges made over it taken away (those still running as they were
   * made) and its wires put back as restore puts one back. A wire the rules refuse now stays out, said in `notes`.
   */
  unforget(tokenRaw: unknown, restoreRecord: (rec: SessionInfo) => void): { state: WireState; notes: string[] } | { refused: string } {
    const token = String(tokenRaw ?? "");
    const held = this.undo.get(token);
    if (held?.kind !== "forgot") return { refused: "That Forget can't be undone any more." };
    if (held.session) {
      try {
        restoreRecord(held.session);
      } catch (err) {
        return { refused: `It couldn't be put back: ${errText(err)}` };
      }
    }
    const notes: string[] = [];
    const back: string[] = [];
    const reply = this.o.store.editWires((book, kept) => {
      const links = { ...book.links };
      for (const b of held.bridges) {
        const w = own(links, b);
        if (w && !isSending(w)) delete links[b];
        else if (w) notes.push(`The handoff made over it, ${w.from} → ${w.to}, is sending, so it stays.`);
      }
      for (const { id, wire } of held.wires) {
        const refused = restoreRefusal({ ...book, links }, id, wire, this.context({ ...book, links }, kept));
        if (refused) {
          notes.push(`Its wire ${id} stays out: ${refused}`);
          continue;
        }
        put(links, id, this.o.delivery ? this.o.delivery.restoring(wire) : restoredWire(wire));
        back.push(id);
      }
      return { book: { ...book, links } };
    });
    if ("refused" in reply) return { refused: `${held.session ? "It's back, but its wires couldn't be put back" : "Its wires couldn't be put back"}: ${reply.refused}` };
    this.undo.delete(token);
    for (const id of back) {
      try {
        this.o.delivery?.restored(id);
      } catch (err) {
        this.o.log(`wires: ${id} was put back, but what waited at its gate couldn't be tried`, err);
      }
    }
    return { state: reply.state, notes };
  }

  /**
   * `list_links`: the caller's wires and nothing else's. Refused when the book can't be read, so "none" always means
   * none; `incomplete` says when some of the book couldn't be, as those may be this session's too.
   */
  linksFor(me: SessionInfo): Reply {
    const state = this.o.store.wires();
    if (!state.book) return { error: state.refused ?? "Wires can't be read right now." };
    const ctx = this.context(state.book);
    const mine = ctx.end(me.id);
    const links = wiresInOrder(state.book.links)
      .filter(([, w]) => w.from === me.id || w.to === me.id)
      .map(([id, w]) => {
        const gate = gateOf(id, w, ctx);
        const otherId = w.from === me.id ? w.to : w.from;
        const other = ctx.end(otherId);
        // across a room's line, nothing about the far end crosses it but its id; nor before the line can be seen
        const across = !!other && !!mine && (!!ctx.roomsUnknown || other.room !== mine.room);
        const outside = ctx.roomsUnknown ? "not known until team rooms have started" : mine?.room ? "outside this room" : "in a team room";
        return {
          wire: id,
          direction: w.from === me.id ? "out" : "in",
          type: w.type,
          other: !other ? { id: otherId, gone: true } : across ? { id: otherId, outside } : { id: otherId, title: other.title, where: other.where },
          state: gate.state,
          ...(across ? { why: ctx.roomsUnknown ?? ROOM_LINE } : gate.why ? { why: gate.why } : {}),
        };
      });
    const incomplete = state.problems.map((p) => p.message);
    return {
      result: {
        you: { id: me.id, title: me.ticketTitle ?? me.title },
        links,
        ...(incomplete.length ? { incomplete } : links.length ? {} : { note: "This workspace has no wires." }),
      },
    };
  }

  private settingsFrom(raw: unknown): { settings: WireSettings } | { refused: string } {
    try {
      return { settings: parseWireSettings(raw) };
    } catch (err) {
      if (err instanceof LandscapeShapeError) return { refused: err.message };
      throw err;
    }
  }

  /** A wire id nothing in the book has, a kept entry's included: a new one mustn't take the key of what's kept verbatim. */
  private unusedId(book: WireBook, kept: Readonly<KeptEntries>): string {
    for (;;) {
      const id = (this.o.newId ?? (() => randomUUID().slice(0, 8)))();
      if (!Object.hasOwn(book.links, id) && !Object.hasOwn(kept.links, id)) return id;
    }
  }

  /**
   * `send_message` between the two ends of a feedback wire, either way, is refused: what the reviewer found goes back
   * through finish_step, so the wire's rounds count it. A book that can't be read refuses nothing here: nothing runs
   * along a wire while it can't be, and agents' messages don't stop because landscape.json can't be read.
   */
  messageRefusal(from: SessionInfo, to: SessionInfo): string | null {
    const across = this.acrossRoomLine(from, to);
    if (across) return across;
    const book = this.o.store.wires().book;
    if (!book) return null;
    const loop = Object.values(book.links).some((w) => w.type === "feedback" && ((w.from === from.id && w.to === to.id) || (w.from === to.id && w.to === from.id)));
    if (!loop) return null;
    return `“${to.ticketTitle ?? to.title}” and this workspace are the two ends of a feedback wire, so send_message between them is off: finish your step with finish_step instead, which counts the wire's rounds.`;
  }

  /**
   * Why `from` can't reach `to` with send_message, or see it in list_sessions: they're on either side of a team room's
   * line, as a wire would be (ROOM_LINE), or the line can't be seen yet. Null when they're on the same side.
   */
  acrossRoomLine(from: SessionInfo, to: SessionInfo): string | null {
    if (this.o.roomsKnown && !this.o.roomsKnown()) return ROOMS_STARTING;
    return this.o.roomOf(from.id) === this.o.roomOf(to.id) ? null : MESSAGE_ROOM_LINE;
  }

  /**
   * The rules' view of the sessions now, which delivery's gates go by too (wireDelivery.ts). Each end is worked out once
   * per check: its folder takes a look at the disk. With `kept`, making or moving a wire counts the kept wires whose
   * ends and type can be read as already there.
   */
  context(book: WireBook, kept?: Readonly<KeptEntries>): GateContext {
    const running = new Map(this.o.sessions.list().map((s) => [s.id, s]));
    const closed = new Map([...(this.o.sessions.planned?.() ?? []), ...this.o.sessions.resumable()].map((s) => [s.id, s]));
    const l = this.o.store.get().landscape;
    const ends = new Map<string, WireEnd | null>();
    const end = (id: string): WireEnd | null => {
      const known = ends.get(id);
      if (known !== undefined) return known;
      const s = running.get(id) ?? closed.get(id);
      // on the landscape: running, or kept a place there (its own, its stack's, or an older file's ghost record), as the
      // window draws a ghost (resolveLayout)
      const stack = s ? stackKeyOf(s) : null;
      const made: WireEnd | null = s
        ? wireEndOf(s, {
            room: this.o.roomOf(id),
            takenOver: this.o.takenOver(id),
            outsideSandbox: !!this.o.outsideSandbox?.(id),
            running: running.has(id),
            placed: running.has(id) || Object.hasOwn(l.workspaces, id) || (!!stack && Object.hasOwn(l.stacks, stack)) || Object.hasOwn(l.ghosts, id),
            folder: canonical(s.cwd),
          })
        : null;
      ends.set(id, made);
      return made;
    };
    const merges = this.o.merges;
    return {
      end,
      links: book.links,
      notes: book.notes,
      ...(kept ? { kept: readableKept(kept) } : {}),
      fileRefusal: this.o.store.wiresWriteRefusal(),
      ...(this.o.roomsKnown && !this.o.roomsKnown() ? { roomsUnknown: ROOMS_STARTING } : {}),
      ...(merges ? { mergeView: (w: Wire) => merges.view(w, end(w.from)) } : {}),
    };
  }
}
