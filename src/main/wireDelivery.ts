import { randomBytes } from "crypto";
import type { LandscapeStore } from "./landscape";
import type { QueueOutcome, QueueReceipt, SessionManager } from "./sessions";
import { refuseTakenOver, type UntakenWireCall } from "./takenOverGuard";
import { redactedFlag } from "./wirePrompt";
import { filledFrom, titleAcross, usesSummary, type FinishFill } from "./wireTools";
import { isObj, own, put } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";
import {
  carriesWork,
  countedFor,
  finishPlan,
  gateOf,
  isSending,
  queuedRefusal,
  WIRE_BODY_MAX,
  type DeliveryState,
  type FinishedStep,
  type FinishOutcome,
  type Gate,
  type GateContext,
  type SendReply,
  type SourceNote,
  type Wire,
  type WireBook,
  type WireDelivery as Delivery,
  type WirePending,
  type WireReply,
} from "../shared/wires";

/**
 * How a pending at a wire's gate reaches the session at its other end (docs/landscape-wires.md, section 3): the
 * ledger in the wire book, a person's Send and the automatic gate's guards, the round limit, starting the other end, and
 * settling what a run left mid-send. Everything goes through the other end's own queue (deliverAgentMessage), whose
 * receipt (QueueReceipt) is what the wire goes by.
 *
 * Nothing sends twice: the pending's id is the key, and each step is written to landscape.json before it's taken. A
 * Send is checked and written ahead (queued, its round and hops counted) before anything is awaited, so a second Send of
 * that pending finds it on its way; its paste is written down (pasting) just before it's made, and one that can't be
 * isn't made. Each send has an attempt of its own, which its receipt answers to, so a message from an earlier send of
 * the same pending is never pasted for a later one. What a run leaves queued never reached its end; what it leaves
 * pasting may have, and a person settles it. Nothing is sent as a run starts.
 */

/** Automatic sends in a row along a chain, or reaching one session, before the next waits for a person (decision 4). */
export const AUTOMATIC_HOPS = 3;

/** How long a Send waits for its stopped other end to start before it gives up, sending nothing. */
export const START_WAIT_MS = 60_000;

/**
 * The prompt the other end receives for `body`: Mockingbird's label, naming the source and saying whether a person sent
 * it, then the body fenced so it can't pass for anything else (W2's wirePrompt.ts; docs/landscape-wires.md, section 4).
 */
export type FrameWire = (o: { wireId: string; wire: Wire; from: SessionInfo; to: SessionInfo; body: string; automatic: boolean }) => string;

/**
 * Who finished a step: the source's agent (finish_step), a person (Finish step), or a PR merging (W16). An automatic
 * gate sends an agent's once per prompt the source took; a person's and a merge's as they come.
 */
export type OfferOrigin = "agent" | "person" | "merge";
export interface OfferHow {
  origin: OfferOrigin;
  /** Why an automatic gate mustn't send this one, and it waits for a person (a merge found as the app started). */
  hold?: string;
}

export interface WireDeliveryOptions {
  store: Pick<LandscapeStore, "wires" | "editWires" | "wiresWriteRefusal">;
  /** The rules' view of the sessions now (WireService.context). */
  context: (book: WireBook) => GateContext;
  sessions: Pick<SessionManager, "list" | "resumable" | "resume" | "deliverAgentMessage" | "promptCount" | "withdraw" | "holds">;
  /** Reopen closed session `id`, as the window's Reopen does (index.ts's reopenSession); null when it has no record. */
  reopen: (id: string) => Promise<SessionInfo | null>;
  /** Whether a message to this session is submitted or left in its prompt: its area's message mode. A person's Send always submits. */
  submits: (target: SessionInfo) => boolean;
  /** What the other end is sent (WireTools.messageFor, in index.ts); a throw fails the send with its message. */
  frame: FrameWire;
  /** The take-over check (TakeoverService.takenOverRefusal); null when team rooms didn't start. */
  takenOver: () => ((id: string, doing: string) => string | null) | null;
  log: (context: string, err: unknown) => void;
  /** Tell the user about session `sessionId`'s wire, under the notification settings. */
  notify: (sessionId: string, title: string, body: string) => void;
  newId?: () => string;
}

/** A send checked and written ahead, ready to go to its other end. */
interface Go {
  wireId: string;
  /** The pending's id, which its delivery is under. */
  id: string;
  /** This send's own, which its delivery carries and its receipt answers to. */
  attempt: string;
  from: string;
  to: string;
  body: string;
  automatic: boolean;
  /** A person agreed to start the other end if it's stopped. */
  start: boolean;
  /** Its receipt has been heard from: the message reached the other end's queue. */
  heard?: boolean;
}

/** The send on its way on a wire, this run: from just before its write-ahead until its end is settled. */
interface Flight {
  id: string;
  attempt: string;
  to: string;
  /** Once it's in the other end's queue. */
  receipt?: QueueReceipt;
}

const withWire = (book: WireBook, id: string, w: Wire): WireBook => {
  const links = { ...book.links };
  put(links, id, w);
  return { ...book, links };
};
/** Whether `w`'s delivery is send `go`'s: its pending, and this attempt at it. */
const ours = (w: Wire | undefined, go: Go): w is Wire & { delivery: Delivery } => !!w && w.delivery?.id === go.id && w.delivery.attempt === go.attempt;
const deliveryOf = (go: Pick<Go, "id" | "attempt" | "automatic">, state: DeliveryState, why?: string): Delivery => ({
  id: go.id,
  state,
  at: Date.now(),
  attempt: go.attempt,
  ...(go.automatic ? { automatic: true as const } : {}),
  ...(why ? { why } : {}),
});
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Why a body can't be sent, or null. */
function bodyRefusal(body: unknown): string | null {
  if (typeof body !== "string") return "What's to be sent isn't text.";
  if (!body.trim()) return "There's nothing to send.";
  if (body.length > WIRE_BODY_MAX) return `It's ${body.length} characters; the limit is ${WIRE_BODY_MAX}.`;
  return null;
}

/**
 * Why pending `pendingId` on wire `id` can't be sent now, by a person (`again`: Send again, after it may have arrived),
 * or null. It has to be the one waiting, not on its way, not sent, and its gate has to be ready.
 */
function sendRefusal(id: string, w: Wire, pendingId: string, ctx: GateContext, again: boolean): string | null {
  const b = ctx.end(w.to);
  const to = b ? `“${b.title}”` : "the other end";
  if (ctx.fileRefusal) return ctx.fileRefusal;
  if (isSending(w)) return w.delivery!.id === pendingId ? `It's on its way to ${to} already.` : `Another message on this wire is still on its way to ${to}: send this once it has gone.`;
  if (!w.pending || w.pending.id !== pendingId) {
    if (w.delivery?.id === pendingId && (w.delivery.state === "sent" || w.delivery.state === "placed")) return `That was sent to ${to} already.`;
    return w.pending ? "What was waiting there has been replaced by something newer: send that instead." : "There's nothing waiting on this wire to send.";
  }
  const unconfirmed = w.delivery?.id === pendingId && w.delivery.state === "unconfirmed";
  if (!again && unconfirmed) return `It may have reached ${to} already: send it again, or mark it sent.`;
  if (again && !unconfirmed) return "Send again is for what may have reached the other end already: this one can simply be sent.";
  // sending again: the gate as it is with that settled, its round counted anew
  const gate: Gate = gateOf(id, again ? { ...w, delivery: undefined } : w, ctx);
  if (gate.state === "blocked") return gate.why ?? "This wire is blocked.";
  if (gate.state !== "ready") return "It isn't ready to send.";
  return null;
}

export class WireDelivery {
  /** The send on its way on each wire. The book saying queued or pasting with no flight here for that attempt is what a run that ended, or a write that failed, left behind. */
  private flights = new Map<string, Flight>();
  /** Attempts made this run. */
  private attempts = new Set<string>();
  /** The source's prompt (epoch:seq) each automatic wire last sent for, this run. */
  private fired = new Map<string, string>();
  /** Automatic pendings that came while an earlier one was on its way: tried once that's settled. */
  private waiting = new Map<string, { pendingId: string; how: OfferHow; prompt: string | null }>();
  /** Pendings made this run: the rest in the book are from before it, which an automatic gate never sends. */
  private mine = new Set<string>();
  /** What last stopped `reconcile`, so it's logged once while it lasts. */
  private reconcileProblem = "";

  constructor(private readonly o: WireDeliveryOptions) {}

  private newId(): string {
    const id = (this.o.newId ?? (() => randomBytes(6).toString("hex")))();
    this.mine.add(id);
    return id;
  }

  private newAttempt(): string {
    const a = randomBytes(6).toString("hex");
    this.attempts.add(a);
    return a;
  }

  /**
   * A step's finish (WireTools.planFinish's fill), written in one change: the source's note, the pendings its verdict
   * takes back (one on its way stays), and a new pending on each wire that readies, the plan worked out again inside
   * the write from the book as it is then. Each wire is answered alone: one the rules refuse now, one changed since it
   * was filled in, or one whose body is over the limit is refused, and the rest go on. Only the caller's own wires are
   * in the plan, and only those set to go when it finishes ready. Then each new pending's gate runs: an automatic one
   * sends it, or holds it saying why. `prompt` is the source's prompt as its finish began, for once per prompt.
   * Answers at once: a finish never waits on a gate.
   */
  offer(me: SessionInfo, f: FinishFill, how: OfferHow, prompt: string | null): FinishOutcome {
    const noted = (book: WireBook): WireBook => {
      const note: SourceNote = { ...(own(book.notes, me.id) ?? { hops: 0 }), summary: f.note.summary };
      if (f.note.verdict) note.verdict = f.note.verdict;
      else delete note.verdict;
      const notes = { ...book.notes };
      put(notes, me.id, note);
      return { ...book, notes };
    };
    if (f.noWireOut) {
      const r = this.o.store.editWires((book) => ({ book: noted(book) }));
      if ("refused" in r) return { refused: `This workspace has no handoff or feedback wire out, so finishing its step readies nothing, and its summary couldn't be kept either: ${r.refused}${f.noWireOut.unread}` };
      return { refused: `This workspace has no handoff or feedback wire out, so finishing its step readies nothing. Its summary is kept for any workspace that reads its context.${f.noWireOut.unread}`, kept: true };
    }
    const v = f.note.verdict;
    const filled = new Map(f.fills.map((x) => [x.wire, x]));
    let steps: FinishedStep[] = [];
    const r = this.o.store.editWires((book) => {
      // the book as it is now: a wire changed while its template was being filled in isn't readied with what was read
      const now = this.o.context(book);
      const links = { ...book.links };
      steps = finishPlan(me.id, v, now).map((step): FinishedStep => {
        const w = book.links[step.wire];
        const done: FinishedStep = { ...step, toTitle: titleAcross(now, me.id, step.to) };
        if (step.withdraws) {
          const { pending: _taken, ...rest } = w;
          put(links, step.wire, rest);
        }
        if (step.does !== "readies") return done;
        const x = filled.get(step.wire);
        if (!x || x.from !== filledFrom(w)) return { ...done, does: "refused", why: "It was changed while this step was being finished: finish again to ready it." };
        const tooLong = bodyRefusal(x.body.text);
        if (tooLong) return { ...done, does: "refused", why: tooLong };
        const count = (usesSummary(w) ? f.redacted : 0) + x.body.redacted;
        const flags = [...(count ? [redactedFlag(count)] : []), ...x.body.flags];
        const pending: WirePending = { id: this.newId(), body: x.body.text, at: f.note.summary.at, ...(v ? { verdict: v } : {}), flags };
        const next: Wire = { ...w, pending };
        put(links, step.wire, next);
        return { ...done, pending: { id: pending.id, flags }, gate: gateOf(step.wire, next, { ...now, links }).gate };
      });
      return { book: noted({ ...book, links }) };
    });
    if ("refused" in r) return { refused: `Nothing was finished: ${r.refused}` };
    for (const step of steps) if (step.pending) this.automatic(step.wire, step.pending.id, how, how.origin === "agent" ? prompt : null);
    return { steps, redacted: f.redacted };
  }

  /**
   * A person's Send of pending `pendingId` (the one their window shows), with `body` as they left it. Always submitted.
   * A stopped other end is started only with `{ start: true }`, once the window has asked about its cost.
   */
  async send(wireRaw: unknown, pendingRaw: unknown, body: unknown, opts?: unknown): Promise<SendReply> {
    const go = this.prepare(String(wireRaw ?? ""), String(pendingRaw ?? ""), body, { automatic: false, start: isObj(opts) && opts.start === true, call: "wires:send" });
    return "refused" in go ? go : this.deliver(go);
  }

  /** A person's Send again, after a message may have reached its end: a new pending, so a new round, sent as Send is. */
  async sendAgain(wireRaw: unknown, pendingRaw: unknown, body: unknown, opts?: unknown): Promise<SendReply> {
    const go = this.prepare(String(wireRaw ?? ""), String(pendingRaw ?? ""), body, { automatic: false, again: true, start: isObj(opts) && opts.start === true, call: "wires:sendAgain" });
    return "refused" in go ? go : this.deliver(go);
  }

  /** A person says what may have reached its end did: it's sent. */
  markSent(wireRaw: unknown, pendingRaw: unknown): WireReply {
    const wireId = String(wireRaw ?? "");
    const pendingId = String(pendingRaw ?? "");
    return this.o.store.editWires((book) => {
      const w = own(book.links, wireId);
      if (!w) return { refused: `There's no wire ${JSON.stringify(wireId)}.` };
      if (w.delivery?.id !== pendingId || w.delivery.state !== "unconfirmed") return { refused: "Only what may have reached the other end can be marked sent." };
      const next: Wire = { ...w, delivery: { ...w.delivery, state: "sent", at: Date.now(), why: "Marked sent by you." } };
      if (next.pending?.id === pendingId) delete next.pending;
      return { book: withWire(book, wireId, next) };
    });
  }

  /** Allow one more round, at the limit: a person's, from the window. No tool reaches it. */
  moreRounds(wireRaw: unknown): WireReply {
    return this.rounds(wireRaw, (r) => (r.used < r.limit ? "It has rounds left." : { limit: r.used + 1, used: r.used }));
  }

  /** Reset rounds: a person's, from the window. No tool reaches it, and nothing else resets them. */
  resetRounds(wireRaw: unknown): WireReply {
    return this.rounds(wireRaw, (r) => ({ limit: r.limit, used: 0 }));
  }

  private rounds(wireRaw: unknown, change: (r: NonNullable<Wire["rounds"]>) => NonNullable<Wire["rounds"]> | string): WireReply {
    const wireId = String(wireRaw ?? "");
    return this.o.store.editWires((book) => {
      const w = own(book.links, wireId);
      if (!w) return { refused: `There's no wire ${JSON.stringify(wireId)}.` };
      if (!w.rounds) return { refused: "Only a feedback wire counts rounds." };
      const next = change(w.rounds);
      if (typeof next === "string") return { refused: next };
      if (next.limit === w.rounds.limit && next.used === w.rounds.used) return { book };
      return { book: withWire(book, wireId, { ...w, rounds: next }) };
    });
  }

  /**
   * Wire `wireId` was removed as `w` (WireService.remove): its message still queued at the other end comes out of that
   * queue unpasted, so an Undo puts back nothing on its way. One being pasted is past taking back: its receipt settles it.
   */
  withdraw(wireId: string, w: Wire): void {
    const f = this.flights.get(wireId);
    if (!f || w.delivery?.state !== "queued") return;
    this.flights.delete(wireId);
    const out = !!f.receipt && this.o.sessions.withdraw(f.to, f.receipt);
    this.o.log("wires", `${wireId} was removed with ${f.id} queued for ${f.to}: ${out ? "it was taken out of that queue unpasted" : "it hadn't reached that queue, and won't"}`);
  }

  /**
   * Settle what's marked on its way with nothing taking it there: what a run that ended left, or one whose step
   * couldn't be written. Queued never reached its end (it's failed, and can be sent again without counting another
   * round); pasting may have (unconfirmed, for a person). A pending from before this run at an automatic gate waits for
   * a person, saying why. Nothing is sent. Run as the app starts, and every so often after (one that couldn't be written
   * is tried again then).
   */
  reconcile(): void {
    const state = this.o.store.wires();
    if (!state.book) return void this.reconcileFailed(state.refused ?? "the wires can't be read");
    const ctx = this.o.context(state.book);
    const plan = Object.entries(state.book.links).flatMap(([id, w]) => {
      const next = this.reconciled(id, w, ctx);
      return next === w ? [] : [{ id, w, next }];
    });
    if (!plan.length) return void (this.reconcileProblem = "");
    const r = this.o.store.editWires((book) => {
      const links = { ...book.links };
      for (const { id, w, next } of plan) if (own(book.links, id) === w) put(links, id, next);
      return { book: { ...book, links } };
    });
    if ("refused" in r) return void this.reconcileFailed(r.refused);
    this.reconcileProblem = "";
    for (const { id, w, next } of plan) {
      const d = next.delivery!;
      this.o.log("wires", `${id}'s delivery ${d.id} is ${d.state}: ${d.why}`);
      const b = ctx.end(next.to);
      if (b && (d.state === "unconfirmed" || d.state === "failed")) this.o.notify(next.to, d.state === "failed" ? `Not sent to “${b.title}”` : `May have reached “${b.title}”`, d.why!);
      // what came to its automatic gate behind the one settled now
      if (isSending(w)) this.next(id);
    }
  }

  private reconcileFailed(why: string): void {
    if (why === this.reconcileProblem) return;
    this.reconcileProblem = why;
    this.o.log("wires: what was on its way couldn't be settled; it's tried again in a while", new Error(why));
  }

  /** Wire `id` as reconcile leaves it: the same object when there's nothing to do. */
  private reconciled(id: string, w: Wire, ctx: GateContext): Wire {
    const to = ctx.end(w.to);
    const b = to ? `“${to.title}”` : "the other end";
    let next = w;
    const d = w.delivery;
    const flight = this.flights.get(id);
    if (d && isSending(w) && (!flight || flight.attempt !== d.attempt)) {
      // an attempt of this run's was left by a write that failed; any other, by a run that ended
      const thisRun = !!d.attempt && this.attempts.has(d.attempt);
      next =
        d.state === "queued"
          ? { ...w, delivery: { ...d, state: "failed", why: thisRun ? `This couldn't be written down before its paste, so it was never pasted into ${b}.` : `Mockingbird stopped before this was pasted into ${b}, so it never reached it.` } }
          : { ...w, delivery: { ...d, state: "unconfirmed", why: thisRun ? `What became of this couldn't be written down after it was pasted into ${b}: it may have reached it. Send it again, or mark it sent.` : `Mockingbird stopped while this was being pasted into ${b}: it may have reached it. Send it again, or mark it sent.` } };
    }
    const p = next.pending;
    if (p && !this.mine.has(p.id) && !isSending(next) && next.delivery?.id !== p.id && gateOf(id, w, ctx).gate === "automatic") {
      next = { ...next, delivery: { id: p.id, state: "held", at: Date.now(), why: "It was waiting from before Mockingbird started: an automatic gate never sends what was waiting then, so it waits for you." } };
    }
    return next;
  }

  /** Which prompt session `id` is on, for once per prompt: null when it isn't running. Read as a finish begins. */
  promptOf(id: string): string | null {
    const p = this.o.sessions.promptCount(id);
    return p ? `${p.epoch}:${p.seq}` : null;
  }

  /** Pending `pendingId` has come to wire `wireId`: sent now if its gate is automatic and every guard holds, else held saying why. */
  private automatic(wireId: string, pendingId: string, how: OfferHow, prompt: string | null): void {
    const state = this.o.store.wires();
    if (!state.book) return; // the gate shows the book can't be read; a person sends it once it can
    const w = own(state.book.links, wireId);
    if (!w?.pending || w.pending.id !== pendingId) return;
    const ctx = this.o.context(state.book);
    const gate = gateOf(wireId, w, ctx);
    if (gate.gate !== "automatic") return;
    // one at a time: an earlier one's record isn't written over while it's on its way, whatever its gate shows
    if (isSending(w)) return void this.waiting.set(wireId, { pendingId, how, prompt });
    const why = this.heldWhy(wireId, w, gate, ctx, how, prompt);
    if (why) return this.hold(wireId, pendingId, why);
    const go = this.prepare(wireId, pendingId, w.pending.body, { automatic: true });
    if ("refused" in go) return this.hold(wireId, pendingId, go.refused);
    if (prompt) this.fired.set(wireId, prompt);
    void this.deliver(go);
  }

  /** Why an automatic gate doesn't send what's waiting (docs/landscape-wires.md, section 4), or null when it may. */
  private heldWhy(wireId: string, w: Wire, gate: Gate, ctx: GateContext, how: OfferHow, prompt: string | null): string | null {
    const a = ctx.end(w.from);
    const b = ctx.end(w.to);
    if (how.hold) return how.hold;
    if (gate.state === "blocked") return `It came while this wire was blocked (${gate.why ?? "blocked"}), so it waits for you.`;
    if (gate.state !== "ready" || !a || !b) return "It isn't ready to send, so it waits for you.";
    if (w.pending!.flags.length) return `It was flagged (${w.pending!.flags.join("; ")}): an automatic gate sends only what isn't, so it waits for you.`;
    if (b.where !== "running") return `“${b.title}” isn't running: an automatic gate never reopens a workspace, so this waits for you to send it.`;
    if ((own(ctx.notes, w.from)?.hops ?? 0) >= AUTOMATIC_HOPS) return `${AUTOMATIC_HOPS} automatic sends in a row led to “${a.title}”: the next one waits for you.`;
    // counted where they arrive, so no source's prompts, real or not, keep one wire sending by itself
    if ((own(ctx.notes, w.to)?.hops ?? 0) >= AUTOMATIC_HOPS) return `${AUTOMATIC_HOPS} automatic sends in a row reached “${b.title}”: the next one waits for you.`;
    if (how.origin === "agent" && !prompt) return `“${a.title}” isn't running, so which prompt this answers can't be told: it waits for you.`;
    if (how.origin === "agent" && this.fired.get(wireId) === prompt) return `“${a.title}” finished again without a new prompt since this wire last sent by itself: an automatic gate sends once per prompt, so this waits for you.`;
    return null;
  }

  /** An automatic gate didn't send pending `pendingId`: it waits for a person, and says why. */
  private hold(wireId: string, pendingId: string, why: string): void {
    const r = this.o.store.editWires((book) => {
      const w = own(book.links, wireId);
      if (!w || w.pending?.id !== pendingId || isSending(w)) return { book };
      return { book: withWire(book, wireId, { ...w, delivery: { id: pendingId, state: "held", at: Date.now(), why } }) };
    });
    if ("refused" in r) this.o.log(`wires: ${wireId}'s automatic gate didn't send ${pendingId} (${why}), and that couldn't be written down`, new Error(r.refused));
  }

  /** How stopped session `id` would be started: an exited pane resumed in place, a closed one reopened. Null when it's running. */
  private howToStart(id: string): "resume" | "reopen" | null {
    if (this.running(id)) return null;
    return this.o.sessions.list().some((s) => s.id === id) ? "resume" : "reopen";
  }

  /**
   * Check a send and write it ahead, nothing awaited, so whatever comes next finds it on its way: the delivery queued
   * under the pending's id (a new one for Send again) with an attempt of its own, its round counted unless this
   * pending's already was, and the other end's hops (an automatic arrival counts one more than the most of either end's,
   * a person's sets none). Nothing is sent when that can't be written.
   */
  private prepare(
    wireId: string,
    pendingId: string,
    body: unknown,
    how: { automatic: boolean; again?: boolean; start?: boolean; call?: UntakenWireCall },
  ): Go | { refused: string; start?: "resume" | "reopen" } {
    const fileRefused = this.o.store.wiresWriteRefusal();
    if (fileRefused) return { refused: fileRefused };
    const state = this.o.store.wires();
    if (!state.book) return { refused: state.refused ?? "Wires can't be read right now." };
    const w = own(state.book.links, wireId);
    if (!w) return { refused: `There's no wire ${JSON.stringify(wireId)}.` };
    if (!carriesWork(w.type)) return { refused: `A ${w.type} wire carries nothing to send.` };
    if (how.call) {
      try {
        for (const end of [w.from, w.to]) refuseTakenOver(end, how.call, this.o.takenOver());
      } catch (err) {
        return { refused: (err as Error).message };
      }
    }
    const ctx = this.o.context(state.book);
    const refused = sendRefusal(wireId, w, pendingId, ctx, !!how.again) ?? bodyRefusal(body);
    if (refused) return { refused };
    const start = how.automatic ? null : this.howToStart(w.to);
    if (start && !how.start) {
      const b = ctx.end(w.to);
      return { refused: `${b ? `“${b.title}”` : "The other end"} isn't running: sending this ${start === "resume" ? "resumes" : "reopens"} it, which rereads its conversation.`, start };
    }
    const text = body as string;
    const id = how.again ? this.newId() : pendingId;
    const go: Go = { wireId, id, attempt: this.newAttempt(), from: w.from, to: w.to, body: text, automatic: how.automatic, start: !!how.start };
    const at = Date.now();
    this.flights.set(wireId, { id, attempt: go.attempt, to: w.to });
    const r = this.o.store.editWires((book) => {
      const cur = own(book.links, wireId);
      if (!cur?.pending || cur.pending.id !== pendingId) return { refused: "What was waiting changed meanwhile." };
      const counted = !how.again && countedFor(cur, pendingId);
      const rounds = cur.rounds && !counted ? { ...cur.rounds, used: cur.rounds.used + 1 } : cur.rounds;
      const notes = { ...book.notes };
      const hops = how.automatic ? Math.max(own(book.notes, cur.to)?.hops ?? 0, own(book.notes, cur.from)?.hops ?? 0) + 1 : 0;
      put(notes, cur.to, { ...own(book.notes, cur.to), hops });
      const pending: WirePending = { ...cur.pending, id, body: text, ...(how.again ? { at } : {}) };
      return { book: { ...withWire(book, wireId, { ...cur, pending, delivery: deliveryOf(go, "queued"), ...(rounds ? { rounds } : {}) }), notes } };
    });
    if ("refused" in r) {
      this.landed(go);
      this.o.log(`wires: ${wireId} wasn't sent, as it couldn't be written ahead`, new Error(r.refused));
      return { refused: `Nothing was sent: ${r.refused}` };
    }
    return go;
  }

  /** Take a send written ahead to its other end: started first if it's stopped (a person's, agreed to), then into its queue. */
  private async deliver(go: Go): Promise<SendReply> {
    let target = this.running(go.to);
    if (!target) {
      if (!go.start) return this.fail(go, "It isn't running, and starting it wasn't agreed to, so nothing was sent.");
      try {
        target = await this.startWithin(go);
      } catch (err) {
        return this.fail(go, message(err));
      }
    }
    let text: string;
    let submit: boolean;
    try {
      // what may have changed while it started: the wire, what's on its way, a take-over, a room
      const state = this.o.store.wires();
      if (!state.book) return this.fail(go, `Wires can't be read right now, so nothing was sent: ${state.refused}`);
      const w = own(state.book.links, go.wireId);
      if (!w) return this.fail(go, "Its wire was removed meanwhile, so nothing was sent.");
      if (!ours(w, go) || w.delivery.state !== "queued") return this.fail(go, "It was settled meanwhile, so nothing was sent.");
      const refused = queuedRefusal(go.wireId, w, this.o.context(state.book));
      if (refused) return this.fail(go, refused);
      const to = this.running(go.to);
      if (!to) return this.fail(go, `“${target.ticketTitle ?? target.title}” stopped running before this reached it.`);
      const from = [...this.o.sessions.list(), ...this.o.sessions.resumable()].find((s) => s.id === go.from);
      if (!from) return this.fail(go, "Its source isn't one of this Mac's sessions any more.");
      text = this.o.frame({ wireId: go.wireId, wire: w, from, to, body: go.body, automatic: go.automatic });
      submit = go.automatic ? this.o.submits(to) : true;
    } catch (err) {
      return this.fail(go, message(err));
    }
    const receipt = this.receipt(go);
    const flight = this.flights.get(go.wireId);
    if (flight?.attempt === go.attempt) flight.receipt = receipt;
    try {
      this.o.sessions.deliverAgentMessage(go.to, text, submit, undefined, receipt);
    } catch (err) {
      if (!go.heard && !this.o.sessions.holds(go.to, receipt)) return this.fail(go, message(err));
      // it's in the other end's queue, or was pasted: its receipt tells what became of it
      this.o.log(`wires: ${go.wireId}'s ${go.id} reached ${go.to}'s queue, which failed after; its receipt says what became of it`, err);
    }
    return { state: this.o.store.wires() };
  }

  private running(id: string): SessionInfo | undefined {
    return this.o.sessions.list().find((s) => s.id === id && s.status !== "dead");
  }

  /** The other end started (startEnd), or a refusal once START_WAIT_MS has gone by; a start that ends after that is logged. */
  private startWithin(go: Go): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      let over = false;
      const timer = setTimeout(() => {
        over = true;
        reject(new Error(`It didn't start within ${START_WAIT_MS / 1000} s, so nothing was sent: send it again once it's running.`));
      }, START_WAIT_MS);
      this.startEnd(go.to).then(
        (s) => {
          if (over) return this.o.log("wires", `${go.to} started after ${go.wireId}'s send of ${go.id} gave up waiting for it`);
          clearTimeout(timer);
          resolve(s);
        },
        (err) => {
          if (over) return this.o.log(`wires: ${go.to} didn't start, after ${go.wireId}'s send of ${go.id} gave up waiting for it`, err);
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Start the other end, stopped: an exited pane is resumed in place, a closed one reopened, as the window does. */
  private async startEnd(id: string): Promise<SessionInfo> {
    const pane = this.o.sessions.list().find((s) => s.id === id);
    if (pane) {
      const r = await this.o.sessions.resume(id).catch((err: Error) => {
        throw new Error(`Couldn't resume “${pane.ticketTitle ?? pane.title}”: ${err.message}`);
      });
      if ("refused" in r) throw new Error(`Couldn't resume “${pane.ticketTitle ?? pane.title}”: ${r.refused}`);
      return r;
    }
    const r = await this.o.reopen(id).catch((err: Error) => {
      throw new Error(`Couldn't reopen it: ${err.message}`);
    });
    if (!r) throw new Error("Couldn't reopen it: its saved record is gone.");
    return r;
  }

  /**
   * What the other end's queue tells this send: its paste written down first, unless the rules on the wire refuse it by
   * now (it's failed then, in the same write, and nothing is pasted); then how it ended.
   */
  private receipt(go: Go): QueueReceipt {
    return {
      pasting: () => {
        go.heard = true;
        let why = "";
        let ruled = "";
        const r = this.o.store.editWires((book) => {
          const w = own(book.links, go.wireId);
          if (!w) return { refused: (why = "its wire was removed") };
          if (!ours(w, go) || w.delivery.state !== "queued") return { refused: (why = "it was settled meanwhile") };
          ruled = queuedRefusal(go.wireId, w, this.o.context(book)) ?? "";
          const delivery = ruled ? deliveryOf(go, "failed", `It wasn't pasted, as the rules changed while it waited: ${ruled}`) : { ...w.delivery, state: "pasting" as const, at: Date.now() };
          return { book: withWire(book, go.wireId, { ...w, delivery }) };
        });
        if (!("refused" in r)) {
          if (!ruled) return true;
          this.o.log("wires", `${go.wireId}'s ${go.id} wasn't pasted into ${go.to}: ${ruled}`);
          this.o.notify(go.to, "Not sent along a wire", `It wasn't pasted, as the rules changed while it waited: ${ruled}`);
        } else if (why) this.o.log("wires", `${go.wireId}'s ${go.id} wasn't pasted into ${go.to}: ${why}`);
        else {
          // the book still says queued: reconcile settles it as never pasted once it can be written
          this.o.log(`wires: ${go.wireId}'s ${go.id} wasn't pasted into ${go.to}, as that couldn't be written down first`, new Error(r.refused));
          this.o.notify(go.to, "Not sent along a wire", `It couldn't be written down before its paste, so nothing was pasted: ${r.refused}`);
        }
        this.landed(go);
        this.next(go.wireId);
        return false;
      },
      settled: (outcome, why) => this.settled(go, outcome, why),
    };
  }

  /** Its end said how it went: written down, the pending gone once it's sent or placed, the user told when it needs them. */
  private settled(go: Go, outcome: QueueOutcome, why?: string): void {
    go.heard = true;
    this.landed(go);
    let gone = false;
    const r = this.o.store.editWires((book) => {
      const w = own(book.links, go.wireId);
      if (!ours(w, go)) {
        gone = true;
        return { book };
      }
      const next: Wire = { ...w, delivery: deliveryOf(go, outcome, why) };
      if (outcome !== "failed" && next.pending?.id === go.id) delete next.pending;
      return { book: withWire(book, go.wireId, next) };
    });
    if (gone) this.o.log("wires", `${go.wireId}'s ${go.id} was ${outcome} after its wire was removed or settled`);
    else if ("refused" in r) this.o.log(`wires: ${go.wireId}'s ${go.id} was ${outcome}, and that couldn't be written down`, new Error(r.refused));
    if (outcome !== "sent") {
      const b = this.o.sessions.list().find((s) => s.id === go.to);
      const name = b ? `“${b.ticketTitle ?? b.title}”` : "the other end";
      this.o.notify(go.to, outcome === "placed" ? `Waiting in ${name}'s prompt` : `Not sent to ${name}`, why ?? "");
    }
    this.next(go.wireId);
  }

  /** Send `go` left its wire's queue: nothing more of it is on its way there. */
  private landed(go: Go): void {
    if (this.flights.get(go.wireId)?.attempt === go.attempt) this.flights.delete(go.wireId);
  }

  /** What came to an automatic gate while an earlier one was on its way, tried now; never from inside the queue. */
  private next(wireId: string): void {
    const w = this.waiting.get(wireId);
    if (!w) return;
    this.waiting.delete(wireId);
    queueMicrotask(() => this.automatic(wireId, w.pendingId, w.how, w.prompt));
  }

  /** A send written ahead that never reached its end's queue: failed, saying why, so it's ready to send again. */
  private fail(go: Go, why: string): SendReply {
    this.landed(go);
    const r = this.o.store.editWires((book) => {
      const w = own(book.links, go.wireId);
      if (!ours(w, go) || w.delivery.state !== "queued") return { book };
      return { book: withWire(book, go.wireId, { ...w, delivery: deliveryOf(go, "failed", why) }) };
    });
    if ("refused" in r) this.o.log(`wires: ${go.wireId}'s ${go.id} failed (${why}), and that couldn't be written down`, new Error(r.refused));
    else this.o.log("wires", `${go.wireId}'s ${go.id} wasn't sent: ${why}`);
    this.o.notify(go.to, "Not sent along a wire", why);
    this.next(go.wireId);
    return { refused: why };
  }
}
