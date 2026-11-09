import { randomUUID } from "crypto";
import type { LandscapeStore } from "./landscape";
import type { Reply } from "./messaging";
import { canonical } from "./handlers";
import { LandscapeShapeError, own, put } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";
import { gateOf, linkRefusal, newWire, parseWireSettings, rekeyedBook, settingsRefusal, WIRE_TYPES, wireRefusal, withoutSession, withSettings, type GateContext, type Wire, type WireBook, type WireEnd, type WireReply, type WireSettings, type WireState, type WireType } from "../shared/wires";

/** Wires removed this run that their Undo can still restore; older ones have gone for good. */
const RESTORABLE = 50;

export interface WireServiceOptions {
  store: Pick<LandscapeStore, "get" | "wires" | "editWires" | "wiresWriteRefusal">;
  /** Every session this Mac has: running, and closed. */
  sessions: { list(): SessionInfo[]; resumable(): SessionInfo[] };
  /** The team room a session of this Mac's is in. */
  roomOf: (id: string) => string | null;
  /** Why a session can't be wired because a teammate took it over; null when none did. */
  takenOver: (id: string) => string | null;
  log: (context: string, err: unknown) => void;
}

/**
 * The wire book's changes and answers, in main (docs/landscape-wires.md). Each change is checked against the rules in
 * shared/wires.ts with the sessions as they are now, then saved by the store before it counts. A window can't reach the
 * book any other way: `landscape:update` refuses a patch naming it, and no MCP tool writes it.
 */
export class WireService {
  /** The records `remove` took, so a restore puts back what was there, counters included, and a window can't supply its own. */
  private removed = new Map<string, Wire>();

  constructor(private readonly o: WireServiceOptions) {}

  get(): WireState {
    return this.o.store.wires();
  }

  /** A new wire, with `settings` on it if given. */
  add(fromRaw: unknown, toRaw: unknown, typeRaw: unknown, settingsRaw?: unknown): WireReply {
    const type = typeRaw as WireType;
    if (!WIRE_TYPES.includes(type)) return { refused: `There's no wire type ${JSON.stringify(typeRaw)}.` };
    const from = String(fromRaw ?? "");
    const to = String(toRaw ?? "");
    const settings = this.settingsFrom(settingsRaw ?? {});
    if ("refused" in settings) return settings;
    const id = this.unusedId();
    const reply = this.o.store.editWires((book) => {
      const ctx = this.context(book);
      const refused = wireRefusal(from, to, type, ctx) ?? settingsRefusal({ from, to, type }, settings.settings, ctx);
      if (refused) return { refused };
      const links = { ...book.links };
      put(links, id, withSettings(newWire(from, to, type, Date.now()), settings.settings));
      return { book: { ...book, links } };
    });
    return "refused" in reply ? reply : { ...reply, id };
  }

  /** Change what a person can change on a wire: not its ends or type (remove it and make another), nor what it has counted, holds or delivered. */
  set(idRaw: unknown, settingsRaw: unknown): WireReply {
    const id = String(idRaw ?? "");
    const settings = this.settingsFrom(settingsRaw);
    if ("refused" in settings) return settings;
    return this.o.store.editWires((book) => {
      const w = own(book.links, id);
      if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
      const refused = settingsRefusal(w, settings.settings, this.context(book));
      if (refused) return { refused };
      const next = withSettings(w, settings.settings);
      if (JSON.stringify(next) === JSON.stringify(w)) return { book };
      const links = { ...book.links };
      put(links, id, next);
      return { book: { ...book, links } };
    });
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
    this.removed.set(id, taken!);
    for (const k of this.removed.keys()) {
      if (this.removed.size <= RESTORABLE) break;
      this.removed.delete(k);
    }
    return { ...reply, id };
  }

  /** Put a removed wire back as it was, counters included, unless the rules on making one now refuse it. */
  restore(idRaw: unknown): WireReply {
    const id = String(idRaw ?? "");
    const w = this.removed.get(id);
    if (!w) return { refused: "That wire can't be restored any more." };
    const reply = this.o.store.editWires((book) => {
      if (Object.hasOwn(book.links, id)) return { refused: "That wire is there already." };
      const refused = wireRefusal(w.from, w.to, w.type, this.context(book));
      if (refused) return { refused };
      const links = { ...book.links };
      put(links, id, w);
      return { book: { ...book, links } };
    });
    if ("refused" in reply) return reply;
    this.removed.delete(id);
    return { ...reply, id };
  }

  /**
   * Move session `old`'s wires and note to `next` (Start fresh, before the ghost is forgotten), counters and what's
   * waiting included. All or none. What the rules say about the wires as they are isn't asked: one that's blocked moves
   * and stays blocked, as moving it changes nothing about why.
   */
  rekey(oldRaw: unknown, nextRaw: unknown): WireReply {
    const old = String(oldRaw ?? "");
    const next = String(nextRaw ?? "");
    return this.o.store.editWires((book) => {
      if (old === next || (!Object.hasOwn(book.notes, old) && !Object.values(book.links).some((w) => w.from === old || w.to === old))) return { book };
      const moved = rekeyedBook(book, old, next);
      const refused = this.rekeyRefusal(book, moved, old, next);
      return refused ? { refused } : { book: moved };
    });
  }

  /**
   * Session `id` was forgotten: its wires and note go with it, and the windows are told which went, for the note saying
   * so. When the book can't be changed now they stay, logged, and show as blocked with their end gone until they're
   * removed by hand: the session has gone whichever.
   */
  sessionForgotten(id: string): void {
    const r = this.o.store.editWires((book) => withoutSession(book, id));
    if ("refused" in r) this.o.log(`wires: couldn't drop the wires of forgotten session ${id}`, new Error(r.refused));
  }

  /**
   * `list_links`: the caller's wires and nothing else's. Refused when the book can't be read, so "none" always means
   * none; `incomplete` says when some of the book couldn't be, as those may be this session's too.
   */
  linksFor(me: SessionInfo): Reply {
    const state = this.o.store.wires();
    if (!state.book) return { error: state.refused ?? "Wires can't be read right now." };
    const ctx = this.context(state.book);
    const links = Object.entries(state.book.links)
      .filter(([, w]) => w.from === me.id || w.to === me.id)
      .map(([id, w]) => {
        const gate = gateOf(id, w, ctx);
        const otherId = w.from === me.id ? w.to : w.from;
        const other = ctx.end(otherId);
        return {
          wire: id,
          direction: w.from === me.id ? "out" : "in",
          type: w.type,
          other: other ? { id: otherId, title: other.title, where: other.where } : { id: otherId, gone: true },
          state: gate.state,
          ...(gate.why ? { why: gate.why } : {}),
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

  /** A wire id nothing in the book has, a kept entry's included: a new one must never land on what's kept verbatim. */
  private unusedId(): string {
    const { book, problems } = this.o.store.wires();
    for (;;) {
      const id = randomUUID().slice(0, 8);
      if (!(book && Object.hasOwn(book.links, id)) && !problems.some((p) => p.id === id)) return id;
    }
  }

  /** Why `moved`, the book with `old`'s wires on `next`, can't stand. */
  private rekeyRefusal(book: WireBook, moved: WireBook, old: string, next: string): string | null {
    const ctx = this.context(moved);
    const to = ctx.end(next);
    if (!to) return `This Mac has no session "${next}".`;
    const from = ctx.end(old);
    if (from?.takenOver) return from.takenOver;
    if (to.takenOver) return to.takenOver;
    for (const [id, w] of Object.entries(book.links)) {
      if (w.from !== old && w.to !== old) continue;
      if (from && from.kind !== to.kind) return `“${to.title}” isn't the same kind of workspace as “${from.title}”, so its wires can't move there.`;
      if (w.delivery?.state === "queued" || w.delivery?.state === "pasting") return "One of these wires is sending right now: try again once it's gone.";
      const now = moved.links[id];
      const refused = linkRefusal(now.from, now.to, now.type, { ...ctx, self: id });
      if (refused) return refused;
    }
    return null;
  }

  /** The rules' view of the sessions now. Each end is worked out once per check: its folder takes a look at the disk. */
  private context(book: WireBook): GateContext {
    const running = new Map(this.o.sessions.list().map((s) => [s.id, s]));
    const closed = new Map(this.o.sessions.resumable().map((s) => [s.id, s]));
    const ghosts = this.o.store.get().landscape.ghosts;
    const ends = new Map<string, WireEnd | null>();
    const end = (id: string): WireEnd | null => {
      const known = ends.get(id);
      if (known !== undefined) return known;
      const s = running.get(id) ?? closed.get(id);
      const made: WireEnd | null = s
        ? {
            id,
            title: s.ticketTitle ?? s.title,
            kind: s.shell ? "terminal" : "agent",
            debrief: !!s.debrief,
            room: this.o.roomOf(id),
            takenOver: this.o.takenOver(id),
            where: !running.has(id) ? "closed" : s.status === "dead" ? "dead" : "running",
            placed: running.has(id) || Object.hasOwn(ghosts, id),
            folder: canonical(s.cwd),
            hooksSilent: !!s.hooksSilent,
          }
        : null;
      ends.set(id, made);
      return made;
    };
    return { end, links: book.links, notes: book.notes, fileRefusal: this.o.store.wiresWriteRefusal() };
  }
}
