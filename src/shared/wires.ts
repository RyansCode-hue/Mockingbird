import { LandscapeShapeError, fail, fields, isObj, list, name, num, own, put, str, type Check, type Part } from "./landscape";
import { isRemotePaneId, parseRemoteId } from "./team/livePanes";
import { TICKET_STAGES, ticketOfSession, type SessionInfo, type TicketStage } from "./types";

/**
 * Typed links between workspaces (docs/landscape.md, Connections; docs/landscape-wires.md). The wire book is stored in
 * landscape.json beside the layout, and read apart from it: `wv` versions its inside, so a later wire type or field
 * never needs LANDSCAPE_VERSION raised. An older build keeps what it can't parse verbatim and acts on none of it.
 */

/** The book's own format. A change an older build must not misread raises this; an older build leaves a newer book as it is. */
export const WIRE_VERSION = 1;

export const WIRE_TYPES = ["handoff", "context", "feedback", "worktree"] as const;
export type WireType = (typeof WIRE_TYPES)[number];
/** When a wire's pending comes: its source says it's finished, a person sends it, or its source's pull request merges (W16). */
export const WIRE_WHENS = ["finished", "manual", "pr-merged"] as const;
export type WireWhen = (typeof WIRE_WHENS)[number];
export const WIRE_GATES = ["ask", "automatic"] as const;
export type WireGate = (typeof WIRE_GATES)[number];
export const WIRE_VERDICTS = ["approve", "changes"] as const;
export type WireVerdict = (typeof WIRE_VERDICTS)[number];
/**
 * What became of a pending (src/main/wireDelivery.ts). queued: written ahead, waiting in the other end's queue; pasting:
 * written just before its paste; sent, placed (in the prompt, unsent); unconfirmed: it may have reached the other end;
 * failed: it never did; held: an automatic gate didn't send it, and it waits for a person, `why` saying why.
 */
export const DELIVERY_STATES = ["queued", "pasting", "sent", "placed", "unconfirmed", "failed", "held"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** A feedback wire's rounds until a person says otherwise. */
export const DEFAULT_ROUNDS = 3;

export interface WireRounds {
  limit: number;
  used: number;
}
/** What's waiting at a gate. */
export interface WirePending {
  id: string;
  body: string;
  at: number;
  verdict?: WireVerdict;
  flags: string[];
}
/** What became of the pending with the same id. */
export interface WireDelivery {
  id: string;
  state: DeliveryState;
  at: number;
  why?: string;
  /**
   * This send of it, of all sends of the same pending: what's in the other end's queue answers to this, so a message
   * from an earlier send (its wire removed and put back meanwhile) never passes for a later one.
   */
  attempt?: string;
  /** Sent by an automatic gate, not a person: it isn't pasted once that gate asks. */
  automatic?: true;
}

export interface Wire {
  /** Session ids, never a teammate's. A worktree wire runs from an agent to a terminal. */
  from: string;
  to: string;
  type: WireType;
  /** All of What flows: "{summary}", "{diff}", or a prompt. */
  template?: string;
  /** What {files} reads, set by a person, relative to `from`'s folder. */
  files?: string[];
  when: WireWhen;
  /**
   * when: pr-merged. The pull requests it has had a pending for, by their pages (an id is only one repository's): each
   * merge readies it once (prWatch.ts).
   */
  fired?: string[];
  /** when: pr-merged. When it began waiting for a merge: one from before then isn't one it waited for. */
  since?: number;
  gate: WireGate;
  /** A context link set to leave tool output out of what its reader gets (read_context); absent, it's included. */
  toolOutput?: false;
  /** Feedback wires only, and every feedback wire. */
  rounds?: WireRounds;
  pending?: WirePending;
  delivery?: WireDelivery;
  createdAt: number;
}
export interface SourceNote {
  summary?: { text: string; at: number; conversation?: string };
  verdict?: WireVerdict;
  /** Automatic sends in a row reaching this session. */
  hops: number;
  stage?: TicketStage;
}
export interface WireBook {
  wv: typeof WIRE_VERSION;
  /** By wire id. */
  links: Record<string, Wire>;
  /** By session id. */
  notes: Record<string, SourceNote>;
}

export const emptyWireBook = (): WireBook => ({ wv: WIRE_VERSION, links: {}, notes: {} });

// ---- reading the stored book ------------------------------------------------------------

const oneOf =
  <T extends string>(allowed: readonly T[]): Check<T> =>
  (v, where) =>
    allowed.includes(v as T) ? (v as T) : fail(where, `is not one of ${allowed.join(", ")}`);
const whole =
  (min: number): Check<number> =>
  (v, where) => {
    const n = num(v, where);
    return Number.isInteger(n) && n >= min ? n : fail(where, `is not a whole number of at least ${min}`);
  };

const ROUNDS: Part = { checks: { limit: whole(1), used: whole(0) } satisfies Record<keyof WireRounds, Check<unknown>>, required: ["limit", "used"] };
const PENDING: Part = {
  checks: { id: name, body: str, at: num, verdict: oneOf(WIRE_VERDICTS), flags: list(str) } satisfies Record<keyof WirePending, Check<unknown>>,
  required: ["id", "body", "at", "flags"],
};
const yes: Check<true> = (v, where) => (v === true ? true : fail(where, "is not true"));
const DELIVERY: Part = {
  checks: { id: name, state: oneOf(DELIVERY_STATES), at: num, why: str, attempt: name, automatic: yes } satisfies Record<keyof WireDelivery, Check<unknown>>,
  required: ["id", "state", "at"],
};
const WIRE: Part = {
  checks: {
    from: name,
    to: name,
    type: oneOf(WIRE_TYPES),
    template: str,
    files: list(name),
    when: oneOf(WIRE_WHENS),
    fired: list(name),
    since: num,
    gate: oneOf(WIRE_GATES),
    toolOutput: (v, where) => (v === false ? false : fail(where, "is only ever false")),
    rounds: (v, where) => fields(v, where, ROUNDS),
    pending: (v, where) => fields(v, where, PENDING),
    delivery: (v, where) => fields(v, where, DELIVERY),
    createdAt: num,
  } satisfies Record<keyof Wire, Check<unknown>>,
  required: ["from", "to", "type", "when", "gate", "createdAt"],
};
const SUMMARY: Part = {
  checks: { text: str, at: num, conversation: name } satisfies Record<keyof NonNullable<SourceNote["summary"]>, Check<unknown>>,
  required: ["text", "at"],
};
const NOTE: Part = {
  checks: {
    summary: (v, where) => fields(v, where, SUMMARY),
    verdict: oneOf(WIRE_VERDICTS),
    hops: whole(0),
    stage: oneOf(TICKET_STAGES.map((s) => s.id)),
  } satisfies Record<keyof SourceNote, Check<unknown>>,
  required: ["hops"],
};
/** The book's own fields, for the pin. Its links and notes are read entry by entry, so one bad entry costs only itself. */
const BOOK: Part = { checks: { wv: whole(1), links: (v) => v, notes: (v) => v } satisfies Record<keyof WireBook, Check<unknown>>, required: ["wv", "links", "notes"] };

/**
 * The stored book as this version checks it. A test pins it under WIRE_VERSION, so the format can't change without
 * the version being raised, or the change being one an older build keeps as an entry it can't parse.
 */
export const WIRE_FORMAT: Record<string, { fields: string[]; required: string[] }> = Object.fromEntries(
  Object.entries({ book: BOOK, wire: WIRE, rounds: ROUNDS, pending: PENDING, delivery: DELIVERY, note: NOTE, summary: SUMMARY }).map(([k, p]) => [
    k,
    { fields: Object.keys(p.checks).sort(), required: [...p.required].sort() },
  ])
);

const wire: Check<Wire> = (v, where) => {
  const w = fields<Wire>(v, where, WIRE);
  if (w.from === w.to) fail(where, "runs from a session to itself");
  if (w.type === "feedback" && !w.rounds) fail(`${where}.rounds`, "is missing");
  if (w.type !== "feedback" && w.rounds) fail(where, "has rounds, which only a feedback wire counts");
  if (w.type !== "context" && w.toolOutput !== undefined) fail(where, "has toolOutput, which only a context link reads");
  return w;
};
const note: Check<SourceNote> = (v, where) => fields(v, where, NOTE);

/**
 * What's wrong with the wire book, for a banner:
 * - entry, note, field: one part of it can't be parsed here; that part is kept verbatim and does nothing;
 * - book, newer: none of it can be used; all of it is kept verbatim;
 * - missing: a file of this version with no book at all, read as an empty one;
 * - aside: the file wasn't a landscape and was moved aside, wires with it.
 */
export interface WireProblem {
  kind: "entry" | "note" | "field" | "book" | "newer" | "missing" | "aside";
  message: string;
  /** The wire, session or field an entry problem is about. */
  id?: string;
}

/** What's kept verbatim from a book this version can otherwise read. */
export interface KeptEntries {
  links: Record<string, unknown>;
  notes: Record<string, unknown>;
  fields: Record<string, unknown>;
}
export type WireBookRead =
  | { status: "ok"; book: WireBook; kept: KeptEntries; problems: WireProblem[] }
  | { status: "newer" | "bad"; raw: unknown; problems: WireProblem[] };

export const freshWireRead = (book: WireBook = emptyWireBook()): WireBookRead => ({ status: "ok", book, kept: { links: {}, notes: {}, fields: {} }, problems: [] });

/**
 * A stored book, tolerantly. An entry that can't be parsed is kept verbatim, does nothing and is reported, and what
 * else the book holds still works. A book that isn't one, or a newer one, is kept whole and can't be used: the
 * refusal says why, so it's never read as "no wires". Nothing here can throw for what the file holds, so nothing in the
 * book can get the layout beside it moved aside. Absent (a file from before wires) is an empty book.
 */
export function parseWireBook(raw: unknown): WireBookRead {
  if (raw === undefined) return freshWireRead();
  const bad = (why: string): WireBookRead => ({
    status: "bad",
    raw,
    problems: [{ kind: "book", message: `The wires in landscape.json can't be read by this Mockingbird (${why}). They're left as they are, and do nothing.` }],
  });
  if (!isObj(raw)) return bad("they aren't an object");
  const wv = raw.wv;
  if (typeof wv !== "number" || !Number.isInteger(wv) || wv < 1) return bad(`their wv is ${JSON.stringify(wv)}`);
  if (wv > WIRE_VERSION) {
    return {
      status: "newer",
      raw,
      problems: [{ kind: "newer", message: `The wires in landscape.json were written by a newer Mockingbird (wire format ${wv}). They're left as they are, and do nothing until this Mockingbird is updated.` }],
    };
  }
  if (!isObj(raw.links)) return bad("links isn't an object");
  if (!isObj(raw.notes)) return bad("notes isn't an object");
  const read = freshWireRead() as Extract<WireBookRead, { status: "ok" }>;
  const each = <T,>(from: Record<string, unknown>, check: Check<T>, where: string, into: Record<string, T>, kept: Record<string, unknown>, problem: (id: string, why: string) => WireProblem) => {
    for (const [id, entry] of Object.entries(from)) {
      try {
        if (!id) fail(where, "has an empty key");
        put(into, id, check(entry, `${where}[${JSON.stringify(id)}]`));
      } catch (err) {
        if (!(err instanceof LandscapeShapeError)) throw err;
        put(kept, id, entry);
        read.problems.push(problem(id, err.message));
      }
    }
  };
  each(raw.links, wire, "links", read.book.links, read.kept.links, (id, why) => ({ kind: "entry", id, message: `Wire ${JSON.stringify(id)} in landscape.json can't be read by this Mockingbird (${why}). It's kept as it is, and does nothing.` }));
  each(raw.notes, note, "notes", read.book.notes, read.kept.notes, (id, why) => ({ kind: "note", id, message: `A wire note in landscape.json can't be read by this Mockingbird (${why}). It's kept as it is, and does nothing.` }));
  for (const [k, v] of Object.entries(raw)) {
    if (Object.hasOwn(BOOK.checks, k)) continue;
    put(read.kept.fields, k, v);
    read.problems.push({ kind: "field", id: k, message: `The wires in landscape.json have a field this Mockingbird doesn't know (${k}). It's kept as it is, and does nothing.` });
  }
  return read;
}

/**
 * The book as it goes back in the file: what couldn't be parsed exactly as it was read. A live entry under a key that's
 * also kept is the one written (the store drops the kept copy when that happens, and says so).
 */
export function storedWireBook(r: WireBookRead): unknown {
  if (r.status !== "ok") return r.raw;
  return { ...r.kept.fields, wv: r.book.wv, links: { ...r.kept.links, ...r.book.links }, notes: { ...r.kept.notes, ...r.book.notes } };
}

/** The ends and type of a kept wire, where they can be read though the entry as a whole can't. */
export type KeptWire = Pick<Wire, "from" | "to" | "type">;

/** The kept wires whose ends and type can be read: what the rules count as already there. */
export function readableKept(kept: Pick<KeptEntries, "links">): Record<string, KeptWire> {
  const out: Record<string, KeptWire> = {};
  for (const [id, raw] of Object.entries(kept.links)) {
    if (!isObj(raw) || typeof raw.from !== "string" || typeof raw.to !== "string" || !WIRE_TYPES.includes(raw.type as WireType)) continue;
    put(out, id, { from: raw.from, to: raw.to, type: raw.type as WireType });
  }
  return out;
}

/** The kept entries that name session `id`: a wire with it at either end, and its note. They go with it when it's forgotten. */
export function keptNaming(kept: Pick<KeptEntries, "links" | "notes">, id: string): { links: string[]; notes: string[] } {
  const links = Object.entries(kept.links).flatMap(([k, raw]) => (isObj(raw) && (raw.from === id || raw.to === id) ? [k] : []));
  return { links, notes: Object.hasOwn(kept.notes, id) ? [id] : [] };
}

// ---- what a window and the tools are told ------------------------------------------------

/**
 * `wires:get`'s answer. `book` is what can be used, without what couldn't be parsed. When none of it can be used it's
 * null and `refused` says why: there's no way to read that as "no wires". `wiresRev` counts the book's changes since
 * the app started, apart from the layout's `rev`, so a wire changing leaves a layout Undo in place.
 */
export interface WireState {
  book: WireBook | null;
  refused: string | null;
  wiresRev: number;
  problems: WireProblem[];
  /**
   * What only main can tell, for the windows' drawing (WireService.forWindows): each pr-merged wire's merge view (the
   * merge watch's), and each shared worktree wire's ends' folders with symlinks resolved. Sent again, under the same
   * `wiresRev`, when either changes.
   */
  merges?: Record<string, MergeView>;
  folders?: Record<string, string>;
}

/** A wire that went with its session, with what was waiting at its gate, for the note saying so. */
export interface DroppedWire {
  id: string;
  wire: Wire;
}

/** `wires:changed`, sent to every window: the state whole, and the wires a forgotten session took with it. */
export interface WireChange extends WireState {
  dropped?: DroppedWire[];
}

/** A `wires:*` change's answer: it's done and saved, or it isn't and nothing changed. */
export type WireReply = { state: WireState; id?: string } | { refused: string };
/**
 * A person's Send: refused with `start` when its other end is stopped and starting it wasn't agreed to. The window
 * asks about its cost, then sends again with `{ start: true }` (renderer/wireSend.ts).
 */
export type SendReply = { state: WireState; id?: string } | { refused: string; start?: "resume" | "reopen" };

// ---- the rules on making and using a wire -------------------------------------------------

/**
 * Session `s` as one end of a wire, for main's rules and a window's drawing alike: what's read off the session is read
 * here, and where it is (`at`: its room, a take-over, its sandbox, whether it's running or placed, its folder) is the
 * caller's, as only main knows the rooms and the disk.
 */
export function wireEndOf(s: SessionInfo, at: Pick<WireEnd, "room" | "takenOver" | "outsideSandbox" | "placed" | "folder"> & { running: boolean }): WireEnd {
  return {
    id: s.id,
    title: s.ticketTitle ?? s.title,
    kind: s.shell ? "terminal" : "agent",
    debrief: !!s.debrief,
    tasks: s.role === "tasks",
    room: at.room,
    takenOver: at.takenOver,
    outsideSandbox: at.outsideSandbox,
    where: !at.running ? "closed" : s.status === "dead" ? "dead" : "running",
    placed: at.placed,
    folder: at.folder,
    // a closed or exited session's record may still say so from its last run; its next launch starts afresh
    hooksSilent: at.running && s.status !== "dead" && !!s.hooksSilent,
    ticket: ticketOfSession(s),
    branch: s.branch,
  };
}

/** One end of a wire as the rules see it: a session of this Mac's, running or closed. */
export interface WireEnd {
  id: string;
  title: string;
  kind: "agent" | "terminal";
  debrief: boolean;
  /** The Helpdesk tasks workspace (SessionRole "tasks"): it takes no wires. */
  tasks?: boolean;
  /** The team room it's in. */
  room: string | null;
  /** Why it can't be wired: a teammate took it over. */
  takenOver: string | null;
  /** It's in a team room but runs outside the room's sandbox (outsideRoomSandbox): no wires there until it restarts. */
  outsideSandbox?: boolean;
  where: "running" | "dead" | "closed";
  /** Whether it's on the landscape: running, or closed with a ghost. Closed with no place, it's only in the Closed sessions list. */
  placed: boolean;
  /** Its folder as the filesystem knows it (symlinks resolved). */
  folder: string;
  /** Its agent's hooks never reported, so its status can't be trusted. */
  hooksSilent: boolean;
  /** The ticket it's on (ticketOfSession) and its branch: a pr-merged wire watches that ticket's pull requests from that branch. */
  ticket?: string | null;
  branch?: string | null;
}

export interface WireContext {
  /** A session of this Mac's, or null. */
  end(id: string): WireEnd | null;
  links: Readonly<Record<string, Wire>>;
  /** Kept wires whose ends and type can be read (readableKept): making or moving a wire counts them as there. */
  kept?: Readonly<Record<string, KeptWire>>;
  /** The wire being checked, when it's one that exists: rules across wires leave it out. */
  self?: string;
  /**
   * Why it isn't known yet which sessions are in a team room (ROOMS_STARTING), or null once it is. Until then every
   * wire is refused with it: any of them could cross a room's line.
   */
  roomsUnknown?: string | null;
}

const others = (ctx: WireContext): Wire[] => Object.entries(ctx.links).flatMap(([id, w]) => (id === ctx.self ? [] : [w]));
/** Every other wire a new or moved one mustn't duplicate or loop with, the kept ones included. */
const rivals = (ctx: WireContext): KeptWire[] => [...others(ctx), ...Object.entries(ctx.kept ?? {}).flatMap(([id, w]) => (id === ctx.self ? [] : [w]))];

/** Why a wire is refused when its ends are on either side of a team room's line. It names neither end. */
export const ROOM_LINE =
  "Both ends have to be in the same team room, or neither in one: a wire across the line would carry a room's text out of its guardrails, or private output onto teammates' screens.";

/** Why send_message is refused, and list_sessions leaves a session out, across a team room's line. It names neither end. */
export const MESSAGE_ROOM_LINE =
  "Sessions reach each other only on the same side of a team room's line, both in the same room or neither in one: a message across it would carry a room's text out of its guardrails, or private output onto teammates' screens.";

/** Why a wire is refused while Mockingbird hasn't started its team rooms: a room's line can't be seen yet. */
export const ROOMS_STARTING = "Mockingbird is still starting its team rooms, so it can't tell yet which sessions are in one: try again in a moment.";

export const isSending = (w: Pick<Wire, "delivery">): boolean => w.delivery?.state === "queued" || w.delivery?.state === "pasting";

/**
 * Whether pending `pendingId`'s round has been counted: it went from ready to queued, which counts it, and has a delivery
 * of its own since (any but held, which never went). Sending it again after it failed doesn't count it twice.
 */
export const countedFor = (w: Pick<Wire, "delivery">, pendingId: string): boolean => w.delivery?.id === pendingId && w.delivery.state !== "held";

/** Whether handoffs lead from `start` to `goal`. */
function handoffsLead(links: readonly KeptWire[], start: string, goal: string): boolean {
  const seen = new Set<string>();
  const walk = (at: string): boolean => {
    if (at === goal) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    return links.some((w) => w.type === "handoff" && w.from === at && walk(w.to));
  };
  return walk(start);
}

/** Why this wire can't sit beside the others (ctx.links but ctx.self): what's about the book, not its two ends. */
export function linkRefusal(from: string, to: string, type: WireType, ctx: WireContext): string | null {
  if (from === to) return "A workspace can't be wired to itself.";
  const rest = rivals(ctx);
  if (type === "feedback" && rest.some((w) => w.type === "feedback" && ((w.from === from && w.to === to) || (w.from === to && w.to === from)))) {
    return "These two have a feedback wire already: a second would start a fresh count of rounds.";
  }
  if (rest.some((w) => w.type === type && w.from === from && w.to === to)) return `There's a ${type} wire between these two already.`;
  if (type === "handoff" && handoffsLead(rest, to, from)) return "That would make a cycle of handoffs: a loop needs a feedback wire, so its rounds can stop it.";
  return null;
}

/**
 * Why a wire of `type` from `from` to `to` can't be made or used now, or null. Checked in main at every use as well as
 * when it's made, since a session moves in and out of a room, is taken over and is taken back: a wire that's refused
 * now goes blocked with this as its reason, and comes back when it no longer holds.
 */
export function wireRefusal(from: string, to: string, type: WireType, ctx: WireContext): string | null {
  if (from === to) return linkRefusal(from, to, type, ctx);
  for (const id of [from, to]) if (isRemotePaneId(id) || parseRemoteId(id)) return "That's a teammate's session: wires across Macs come later.";
  const a = ctx.end(from);
  if (!a) return `This Mac has no session "${from}".`;
  const b = ctx.end(to);
  if (!b) return `This Mac has no session "${to}".`;
  // first, so no refusal across the line names what's on the other side; a line not known yet is refused as one
  if (ctx.roomsUnknown) return ctx.roomsUnknown;
  if (a.room !== b.room) return ROOM_LINE;
  for (const e of [a, b]) if (e.debrief) return `“${e.title}” is a debrief interview with you, and takes no wires.`;
  for (const e of [a, b]) if (e.tasks) return `“${e.title}” is the Helpdesk tasks workspace: it works in your Chrome on what you paste in, and takes no wires.`;
  for (const e of [a, b]) if (e.takenOver) return e.takenOver;
  for (const e of [a, b]) if (e.outsideSandbox) return `“${e.title}” isn't in its team room's sandbox (it joined the room while it was running, or its sandbox didn't start): restart it in the room to wire it there.`;

  if (type === "worktree") {
    if (a.kind !== "agent" || b.kind !== "terminal") return "A shared worktree wire runs from an agent to a terminal.";
    if (a.folder !== b.folder) return `“${b.title}” runs in another folder: a shared worktree wire needs the agent's own.`;
  } else {
    // a message typed into a terminal would run as a command, and a terminal has no conversation to read
    for (const e of [a, b]) if (e.kind === "terminal") return `“${e.title}” is a terminal: only a shared worktree wire can reach one.`;
  }
  return linkRefusal(from, to, type, ctx);
}

/** Whether a wire of `type` carries its source's work to the other end (has What flows, When and a gate): a handoff or feedback wire. */
export const carriesWork = (type: WireType): type is "handoff" | "feedback" => type === "handoff" || type === "feedback";

/** A new wire of `type`, its gate asking and, for one that carries a result, set to go when its source says it's finished. */
export function newWire(from: string, to: string, type: WireType, at: number): Wire {
  return { from, to, type, when: carriesWork(type) ? "finished" : "manual", gate: "ask", ...(type === "feedback" ? { rounds: { limit: DEFAULT_ROUNDS, used: 0 } } : {}), createdAt: at };
}

/** When a wire made at `now` is stamped: after every wire in `links`, so wires made within one millisecond keep their order. */
export function createdAtAfter(links: Readonly<Record<string, Wire>>, now: number): number {
  let at = now;
  for (const w of Object.values(links)) if (w.createdAt >= at) at = w.createdAt + 1;
  return at;
}

/**
 * A book's wires in the order they were made (createdAt, then id), for whatever an order reaches: a reply, a prompt, a
 * notice, the gates a finish runs. Never by the object's own key order, which puts an id that reads as an integer
 * ("12345678") ahead of the rest.
 */
export function wiresInOrder(links: Readonly<Record<string, Wire>>): [string, Wire][] {
  return Object.entries(links).sort(([a, x], [b, y]) => x.createdAt - y.createdAt || (a < b ? -1 : a > b ? 1 : 0));
}

// ---- finishing a step -------------------------------------------------------------------

/** What finishing a step does along one of the workspace's handoff and feedback wires out (finishPlan). */
export interface FinishStep {
  wire: string;
  to: string;
  type: "handoff" | "feedback";
  /**
   * - readies: it gets a pending from this finish, in place of any that hadn't gone;
   * - keeps: it goes when a person sends it (when: manual): the summary is kept for that, and nothing lights;
   * - holds: a handoff on "changes", blocked till an approve;
   * - passes: a feedback wire on "approve": there's nothing to send back;
   * - refused: the rules refuse the wire now (a room's line, a take-over), so nothing is put on it.
   */
  does: "readies" | "keeps" | "holds" | "passes" | "refused";
  why?: string;
  /** The pending this finish takes back: one the other verdict left that hasn't gone. One on its way can't be. */
  withdraws?: string;
}

/** A FinishStep as it went: the other end's name, and the pending made where it readied. */
export interface FinishedStep extends FinishStep {
  /** The other end's title; its id when it's across a room's line, where nothing else about it crosses. */
  toTitle: string;
  pending?: { id: string; flags: string[] };
  /** The gate in force where it readied: automatic sends by itself unless something holds it, ask waits for a person. */
  gate?: WireGate;
  /** What its gate shows once it has run (gateOf): sent, on its way, waiting for a person (held saying why), or blocked. */
  went?: Pick<Gate, "state" | "why" | "placed">;
}

/**
 * What finishing a step answers (finish_step, wires:finish). Refused, nothing changed but, with `kept`, the summary:
 * a workspace with no wire out keeps it for the workspaces that read its context.
 */
export type FinishOutcome = { steps: FinishedStep[]; redacted: number } | { refused: string; kept?: boolean };

/** A session's latest message, whole, for a person's Finish step to start from (wires:lastMessage). */
export interface LatestMessage {
  text: string | null;
  at: number | null;
  /** Why there's none to show: no conversation seen yet, its transcript read only in part, a hook's path refused. */
  why?: string;
  /** It was longer than a step's summary may be, and was cut to that. */
  cut?: boolean;
}

/**
 * The most a wire's body holds, waiting or sent (delivery refuses a longer one): a pending is filled in to fit, its
 * template's own words and the summary first, then {diff} and {files} sharing what's left, each cut saying so.
 */
export const WIRE_BODY_MAX = 40_000;

/**
 * Whether finishing session `id`'s step needs a verdict: it has a feedback wire out. The one answer finish_step, the
 * launch instructions, a new wire's notice and what a wire sends all go by, so none asks for what another refuses.
 */
export const verdictDue = (id: string, links: Readonly<Record<string, Wire>>): boolean => Object.values(links).some((w) => w.from === id && w.type === "feedback");

/**
 * Why finishing session `id`'s step with `verdict` is refused, by the verdict rules alone, or null. A feedback wire
 * out needs one ("changes" sends the work back along it, "approve" lets the handoffs go); without one, "changes"
 * has nowhere to go.
 */
export function verdictRefusal(id: string, verdict: unknown, links: Readonly<Record<string, Wire>>): string | null {
  if (verdict !== undefined && !WIRE_VERDICTS.includes(verdict as WireVerdict)) return `verdict is "approve" or "changes", not ${JSON.stringify(verdict)}.`;
  const feedback = verdictDue(id, links);
  if (feedback && verdict === undefined) return 'This workspace has a feedback wire out, so finishing its step needs a verdict: "approve" when the work is ready to go on, "changes" to send it back.';
  if (!feedback && verdict === "changes") return 'verdict "changes" sends work back along a feedback wire, and this workspace has none out: leave verdict out, or use "approve".';
  return null;
}

/**
 * What finishing session `id`'s step with `verdict` does along each of its handoff and feedback wires out (FinishStep),
 * by the rules as they are now: each wire that readies gets its own pending, so a fan-out readies each branch apart.
 * Context links and shared worktrees carry nothing, so they're not in it.
 */
export function finishPlan(id: string, verdict: WireVerdict | undefined, ctx: WireContext): FinishStep[] {
  return wiresInOrder(ctx.links).flatMap(([k, w]): FinishStep[] => {
    if (w.from !== id || !carriesWork(w.type)) return [];
    const step = { wire: k, to: w.to, type: w.type };
    const refused = wireRefusal(w.from, w.to, w.type, { ...ctx, self: k });
    if (refused) return [{ ...step, does: "refused", why: refused }];
    const unsent = w.pending && !(isSending(w) && w.delivery!.id === w.pending.id) ? { withdraws: w.pending.id } : {};
    if (w.type === "handoff" && verdict === "changes") return [{ ...step, does: "holds", why: "needs approve", ...unsent }];
    if (w.type === "feedback" && verdict !== "changes") return [{ ...step, does: "passes", ...unsent }];
    if (w.when === "pr-merged") return [{ ...step, does: "keeps", why: "it goes when its pull request merges" }];
    return [{ ...step, does: w.when === "finished" ? "readies" : "keeps" }];
  });
}

/**
 * What pull request `pr` (its page) merging does along session `id`'s wires out: each handoff set to go when its PR
 * merges that hasn't had a pending for that PR readies, in place of one that hasn't gone, unless the rules refuse it
 * now. A merge has no verdict and leaves the source's note alone.
 */
export function mergePlan(id: string, pr: string, ctx: WireContext): FinishStep[] {
  return wiresInOrder(ctx.links).flatMap(([k, w]): FinishStep[] => {
    if (w.from !== id || w.when !== "pr-merged" || !carriesWork(w.type) || w.fired?.includes(pr)) return [];
    const step = { wire: k, to: w.to, type: w.type };
    const refused = wireRefusal(w.from, w.to, w.type, { ...ctx, self: k });
    if (refused) return [{ ...step, does: "refused", why: refused }];
    const unsent = w.pending && !(isSending(w) && w.delivery!.id === w.pending.id) ? { withdraws: w.pending.id } : {};
    return [{ ...step, does: "readies", ...unsent }];
  });
}

// ---- a wire's settings ------------------------------------------------------------------

/**
 * What a person can set on a wire. Null clears a field. Nothing else on a wire is settable from a window: the counter,
 * what's waiting and what's been delivered change only through what those are for.
 */
export interface WireSettings {
  template?: string | null;
  files?: string[] | null;
  when?: WireWhen;
  gate?: WireGate;
  limit?: number;
  /** A context link's "include tool output": false leaves it out of read_context, true puts it back. */
  toolOutput?: boolean;
}

const orCleared =
  <T,>(each: Check<T>): Check<T | null> =>
  (v, where) =>
    v === null ? null : each(v, where);
/** A path inside the source's folder as far as its spelling goes; reading it checks the rest. */
const insideFile: Check<string> = (v, where) => {
  const f = name(v, where);
  return f.startsWith("/") || f.startsWith("~") || f.split("/").includes("..") ? fail(where, `(${JSON.stringify(f)}) isn't a path inside the source's folder`) : f;
};
const SETTINGS: Part = {
  checks: {
    template: orCleared(str),
    files: orCleared(list(insideFile)),
    when: oneOf(WIRE_WHENS),
    gate: oneOf(WIRE_GATES),
    limit: whole(1),
    toolOutput: (v, where) => (typeof v === "boolean" ? v : fail(where, "is not true or false")),
  } satisfies Record<keyof WireSettings, Check<unknown>>,
  required: [],
};

/** Settings from another process, checked: throws LandscapeShapeError naming what's wrong, so a field that isn't settable can't be set. */
export function parseWireSettings(v: unknown): WireSettings {
  return fields(v, "", SETTINGS, true, "the settings");
}

/** Why these settings can't go on this wire, or null. A team room's area never has automatic gates. */
export function settingsRefusal(w: Pick<Wire, "from" | "to" | "type">, s: WireSettings, ctx: Pick<WireContext, "end">): string | null {
  const carries = carriesWork(w.type);
  if (s.limit !== undefined && w.type !== "feedback") return "Only a feedback wire counts rounds.";
  if (s.toolOutput !== undefined && w.type !== "context") return "Only a context link reads tool output.";
  if (!carries) {
    if (s.template !== undefined || s.files !== undefined) return `A ${w.type} wire doesn't carry anything to set: only a handoff or feedback wire has What flows.`;
    if (s.when !== undefined) return `A ${w.type} wire doesn't go when anything finishes: only a handoff or feedback wire has When.`;
    if (s.gate === "automatic") return `A ${w.type} wire has no gate to make automatic.`;
  }
  if (s.when === "pr-merged") {
    if (w.type !== "handoff") return 'Only a handoff goes when its pull request merges: a feedback wire goes back on a "changes" verdict.';
    const a = ctx.end(w.from);
    if (!a?.ticket || !a.branch) return `${a ? `“${a.title}”` : "Its source"} isn't on ${a?.ticket ? "a branch" : "a ticket"}, so it has no pull request to wait for: "When its PR merges" needs its source on a ticket and a branch.`;
  }
  if (s.gate === "automatic") {
    const a = ctx.end(w.from);
    const b = ctx.end(w.to);
    if (!a || !b) return "Automatic needs both ends to be sessions of this Mac's.";
    if (a.room || b.room) return "Automatic is off in a team room's area: its gates always ask.";
  }
  return null;
}

/** Whether two wires are the same, field for field: a change that makes no difference isn't one. */
export const sameWire = (a: Wire, b: Wire): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `w` with settings on it: the limit moves, what's been counted stays. */
export function withSettings(w: Wire, s: WireSettings, now = Date.now()): Wire {
  const next: Wire = { ...w };
  // when it begins waiting for a merge: one from before then isn't one it waited for
  if (s.when === "pr-merged" && w.when !== "pr-merged") next.since = now;
  else if (s.when !== undefined && s.when !== "pr-merged") delete next.since;
  if (s.template !== undefined) {
    if (s.template === null) delete next.template;
    else next.template = s.template;
  }
  if (s.files !== undefined) {
    if (s.files === null) delete next.files;
    else next.files = s.files;
  }
  if (s.when !== undefined) next.when = s.when;
  if (s.gate !== undefined) next.gate = s.gate;
  if (s.limit !== undefined && w.rounds) next.rounds = { ...w.rounds, limit: s.limit };
  if (s.toolOutput === false) next.toolOutput = false;
  else if (s.toolOutput === true) delete next.toolOutput;
  return next;
}

// ---- changes to the book ----------------------------------------------------------------

/** The book without session `id`: its wires, both directions, and its note. Nothing changes when it has neither. */
export function withoutSession(book: WireBook, id: string): { book: WireBook; dropped: DroppedWire[] } {
  const dropped = wiresInOrder(book.links).flatMap(([k, w]) => (w.from === id || w.to === id ? [{ id: k, wire: w }] : []));
  if (!dropped.length && !Object.hasOwn(book.notes, id)) return { book, dropped };
  const links: Record<string, Wire> = {};
  for (const [k, w] of Object.entries(book.links)) if (w.from !== id && w.to !== id) put(links, k, w);
  const notes: Record<string, SourceNote> = {};
  for (const [k, n] of Object.entries(book.notes)) if (k !== id) put(notes, k, n);
  return { book: { ...book, links, notes }, dropped };
}

/**
 * Why session `old`'s wires can't move to `next` (Start fresh) as `moved` (rekeyedBook) has them: all move or none.
 * A wire refused only for where it is now (a room, a take-over) moves and stays blocked, since moving it changes
 * nothing about why. One that moving would newly refuse doesn't: a handoff can't be moved onto a debrief, or across a
 * room's line, any more than it can be made there.
 */
export function rekeyRefusal(book: WireBook, moved: WireBook, old: string, next: string, ctx: Pick<WireContext, "end" | "kept">): string | null {
  const to = ctx.end(next);
  if (!to) return `This Mac has no session "${next}".`;
  const from = ctx.end(old);
  if (from?.takenOver) return from.takenOver;
  if (to.takenOver) return to.takenOver;
  for (const [id, w] of wiresInOrder(book.links)) {
    if (w.from !== old && w.to !== old) continue;
    if (from && from.kind !== to.kind) return `“${to.title}” isn't the same kind of workspace as “${from.title}”, so its wires can't move there.`;
    if (isSending(w)) return "One of these wires is sending right now: try again once it's gone.";
    const now = moved.links[id];
    const dup = linkRefusal(now.from, now.to, now.type, { ...ctx, links: moved.links, self: id });
    if (dup) return dup;
    const after = wireRefusal(now.from, now.to, now.type, { ...ctx, links: moved.links, self: id });
    if (after && after !== wireRefusal(w.from, w.to, w.type, { ...ctx, links: book.links, self: id })) return after;
  }
  return null;
}

/** Why removed wire `w` can't go back under `id` now: it's there already, or the rules on making it refuse it now. */
export function restoreRefusal(book: WireBook, id: string, w: Wire, ctx: Pick<WireContext, "end" | "kept">): string | null {
  if (Object.hasOwn(book.links, id)) return "That wire is there already.";
  return wireRefusal(w.from, w.to, w.type, { ...ctx, links: book.links });
}

/**
 * A removed wire as Undo puts it back, never as still sending and never sent again by itself. A message still queued
 * when its wire went is never pasted (delivery checks its wire just before the paste), so it comes back failed and
 * ready to send; one being pasted may or may not have reached the other end, so it comes back unconfirmed for a person
 * to settle (Send again, or Mark sent).
 */
export function restoredWire(w: Wire): Wire {
  if (!isSending(w)) return w;
  if (w.delivery!.state === "queued") return { ...w, delivery: { ...w.delivery!, state: "failed", why: "Its wire was removed before it was pasted, so it never reached the other end." } };
  return { ...w, delivery: { ...w.delivery!, state: "unconfirmed", why: "It was being sent when its wire was removed, so it may have reached the other end." } };
}

/** The book with session `old`'s wires and note moved to `next`, counters and what's waiting included. A note `next` has of its own stays. */
export function rekeyedBook(book: WireBook, old: string, next: string): WireBook {
  const links: Record<string, Wire> = {};
  for (const [k, w] of Object.entries(book.links)) put(links, k, w.from === old ? { ...w, from: next } : w.to === old ? { ...w, to: next } : w);
  const notes: Record<string, SourceNote> = {};
  for (const [k, n] of Object.entries(book.notes)) if (k !== old) put(notes, k, n);
  const moved = own(book.notes, old);
  if (moved && !own(notes, next)) put(notes, next, moved);
  return { ...book, links, notes };
}

// ---- what a wire shows ------------------------------------------------------------------

export type GateState = "idle" | "ready" | "sending" | "sent" | "blocked";

export interface Gate {
  state: GateState;
  /** Why it's blocked, what went wrong last time when it's ready again, or, idle on a pr-merged wire, what it waits for. */
  why?: string;
  /** The gate in force: a wire set automatic asks once either end is in a team room. */
  gate: WireGate;
  /** What's waiting, when something is. */
  pendingId?: string;
  /** Sent, but left in the other end's prompt for a person to submit. */
  placed?: boolean;
  /** It may have reached the other end: a person says, by sending again or marking it sent. */
  unconfirmed?: boolean;
  /** A feedback wire with no rounds left. */
  atLimit?: boolean;
  /** Still queued at the other end, whose hooks aren't reporting: marking it idle lets the queue go. */
  stalled?: boolean;
}

/**
 * What a pr-merged wire's source's pull requests say while nothing waits at its gate (prWatch.ts' mergeViewOf): blocked
 * saying why (one can't be read, or was closed without merging), or idle saying what it waits for.
 */
export type MergeView = { blocked: string } | { waits: string };

export interface GateContext extends WireContext {
  notes: Readonly<Record<string, SourceNote>>;
  /** Why the book can't be saved now: nothing is sent on a change that couldn't be written first. */
  fileRefusal: string | null;
  /** A pr-merged wire's pull requests as the merge watch has them; left out, such a wire shows idle and says nothing. */
  mergeView?: (w: Wire) => MergeView | null;
}

/** The gate in force on `w`: one set automatic asks once either end is in a team room. */
export function gateInForce(w: Pick<Wire, "from" | "to" | "gate">, ctx: Pick<WireContext, "end">): WireGate {
  return w.gate === "automatic" && !ctx.end(w.from)?.room && !ctx.end(w.to)?.room ? "automatic" : "ask";
}

/**
 * Why the source's verdict now stops what wire `w` carries, or null: a handoff waits for "approve" while its source's
 * last finish said "changes" with a feedback wire out, and a feedback wire's changes stop once it said "approve".
 */
export function verdictStops(w: Pick<Wire, "from" | "type">, ctx: Pick<GateContext, "notes" | "links">): string | null {
  const verdict = own(ctx.notes, w.from)?.verdict;
  if (w.type === "handoff" && verdict === "changes" && verdictDue(w.from, ctx.links)) return "Its source's step finished again with \"changes\": a handoff waits for \"approve\".";
  if (w.type === "feedback" && verdict === "approve") return "Its source's step finished again with \"approve\": there's nothing to send back.";
  return null;
}

/**
 * Why a message queued on wire `id` mustn't be pasted now, or null: the rules on using the wire refuse it (a room's
 * line, a take-over), the source's verdict changed since (verdictStops), or an automatic gate sent it and that gate
 * asks now. Checked again just before the paste.
 */
export function queuedRefusal(id: string, w: Wire, ctx: GateContext): string | null {
  const refused = wireRefusal(w.from, w.to, w.type, { ...ctx, self: id }) ?? verdictStops(w, ctx);
  if (refused) return refused;
  if (!w.delivery?.automatic || gateInForce(w, ctx) === "automatic") return null;
  return ctx.end(w.from)?.room || ctx.end(w.to)?.room
    ? "Automatic is off in a team room's area, so what its automatic gate sent waits for you."
    : "This wire's gate was set to ask, so what its automatic gate sent waits for you.";
}

/**
 * What wire `id` shows now. Blocked isn't stored: it's worked out here, from the rules, the wire's counters and how
 * its ends are, so it clears by itself when its reason does. In flight is a fact whatever else has changed, but for a
 * book that can't be written: a delivery goes no further then. A failed or held delivery shows ready, saying why.
 */
export function gateOf(id: string, w: Wire, ctx: GateContext): Gate {
  const here: GateContext = { ...ctx, self: id };
  const a = ctx.end(w.from);
  const b = ctx.end(w.to);
  const gate = gateInForce(w, ctx);
  const atLimit = !!w.rounds && w.rounds.used >= w.rounds.limit;
  const base: Pick<Gate, "gate" | "atLimit"> = { gate, ...(atLimit ? { atLimit } : {}) };
  const blocked = (why: string, more: Partial<Gate> = {}): Gate => ({ ...base, state: "blocked", why, ...more });

  // a delivery's every step is written down before it's taken (wireDelivery.ts): while the book can't be, none is
  if (ctx.fileRefusal) return blocked(ctx.fileRefusal);
  // in flight, a newer pending beside it or not. Queued, it isn't pasted once the rules refuse it, and may never go
  // at an end whose hooks are silent.
  if (isSending(w)) {
    const pendingId = w.pending ? { pendingId: w.pending.id } : {};
    if (w.delivery!.state === "queued") {
      const refused = queuedRefusal(id, w, ctx);
      if (refused) return blocked(refused, pendingId);
      if (b?.hooksSilent) return blocked(`“${b.title}”: its hooks aren't reporting, so what's queued for it may never go. Mark it idle once it's at its prompt.`, { stalled: true, ...pendingId });
    }
    return { ...base, state: "sending", ...pendingId };
  }
  const delivery = w.delivery && (!w.pending || w.delivery.id === w.pending.id) ? w.delivery : null;

  const refused = wireRefusal(w.from, w.to, w.type, here);
  if (refused) return blocked(refused);
  for (const e of [a!, b!]) if (e.where === "closed" && !e.placed) return blocked(`“${e.title}” is closed and not on the landscape: reopen it from Closed sessions.`);
  if (w.type === "context" || w.type === "worktree") return { ...base, state: "idle" };

  if (delivery?.state === "unconfirmed") return blocked(delivery.why ?? `It may have reached “${b!.title}”.`, { unconfirmed: true, ...(w.pending ? { pendingId: w.pending.id } : {}) });
  if (w.type === "handoff" && own(ctx.notes, w.from)?.verdict === "changes" && others(here).some((x) => x.type === "feedback" && x.from === w.from)) return blocked("needs approve");
  if (w.pending) {
    // a round already counted for this pending (it went, then failed) isn't counted again
    if (atLimit && !countedFor(w, w.pending.id)) return blocked(`At the limit: ${w.rounds!.used} of ${w.rounds!.limit} rounds.`, { pendingId: w.pending.id });
    if (b!.hooksSilent) return blocked(`“${b!.title}”: its hooks aren't reporting, so a message might never go.`, { pendingId: w.pending.id });
    const again = (delivery?.state === "failed" || delivery?.state === "held") && delivery.why ? { why: delivery.why } : {};
    return { ...base, state: "ready", pendingId: w.pending.id, ...again };
  }
  // waiting on a merge: a pull request that can't be read, or was closed, blocks it; otherwise it says what it waits for
  const merge = w.when === "pr-merged" ? (ctx.mergeView?.(w) ?? null) : null;
  if (merge && "blocked" in merge) return blocked(merge.blocked);
  if (delivery?.state === "sent") return { ...base, state: "sent" };
  if (delivery?.state === "placed") return { ...base, state: "sent", placed: true };
  return { ...base, state: "idle", ...(merge ? { why: merge.waits } : {}) };
}
