import { own } from "../../../shared/landscape";
import { stageLabel, type StoredStage } from "../../../shared/types";
import { gateOf, WIRE_TYPES, wireRefusal, wiresInOrder, type GateContext, type SendReply, type WireBook, type WireReply, type WireType } from "../../../shared/wires";
import type { LandscapeStore } from "../../landscape";
import type { WireService } from "../../wires";
import type { AssistantDeps, AssistantWire } from "../deps";
import { defineTool, type AssistantTool, type JsonSchema } from "../registry";
import { SESSION_ARG, sessionById, sessionRef, titleOf } from "./lookup";

/**
 * Wires (docs/assistant.md → Ability groups; docs/landscape-wires.md): the wires between sessions and what waits at
 * their gates. Drawing and removing one is direct, with Undo; sending what waits at a gate and approving a ticket at
 * the pipeline's stakeholder gate are cards. Every change goes through the wire service's own checks (a room's line, a
 * take-over, a session outside its room's sandbox, a book that can't be saved). None is rule-able: a rule's wire would
 * outlive what it was drawn for, and a send or an approval is the user's word.
 */

type Deps = Pick<
  AssistantDeps,
  "sessions" | "guard" | "wireList" | "wireAddRefusal" | "addWire" | "removeWire" | "restoreWire" | "wireRestorable" | "sendWaiting" | "ticketStage" | "approveTicket"
>;

const WIRE_ARG: JsonSchema = { type: "string", minLength: 1, maxLength: 80, description: "The wire's id, from list_wires" };
const TICKET_ARG: JsonSchema = { type: "string", pattern: "^[0-9]{1,9}$", description: 'The ticket\'s number, digits only ("5101")' };

const TYPE_WORDS: Record<WireType, string> = { handoff: "handoff", context: "context link", feedback: "feedback wire", worktree: "shared worktree wire" };

/** What main's wire deps are made of (index.ts): read when called, as main makes them after the Assistant. */
export interface WireHands {
  store(): Pick<LandscapeStore, "wires" | "wiresWriteRefusal">;
  service(): Pick<WireService, "context" | "add" | "remove" | "restore" | "restorable">;
  /** A person's Send (WireDelivery.send). */
  send(id: string, pendingId: string, body: string): Promise<SendReply>;
}

/** The wire deps (AssistantDeps), through the wire service and its checks. */
export function wireDeps(h: WireHands): Pick<AssistantDeps, "wireList" | "wireAddRefusal" | "addWire" | "removeWire" | "restoreWire" | "wireRestorable" | "sendWaiting"> {
  const refused = (r: WireReply): void => {
    if ("refused" in r) throw new Error(r.refused);
  };
  return {
    wireList: () => {
      const st = h.store().wires();
      if (!st.book) throw new Error(st.refused ?? "The wire book can't be read");
      return wiresSeen(st.book, h.service().context(st.book));
    },
    wireAddRefusal: (from, to, type) => {
      const st = h.store().wires();
      if (!st.book) return st.refused ?? "The wire book can't be read";
      return h.store().wiresWriteRefusal() ?? wireRefusal(from, to, type, h.service().context(st.book));
    },
    addWire: (from, to, type) => {
      const r = h.service().add(from, to, type);
      refused(r);
      if (!("id" in r) || !r.id) throw new Error("The wire was made, but its id wasn't given back");
      return r.id;
    },
    removeWire: (id) => refused(h.service().remove(id)),
    restoreWire: (id) => refused(h.service().restore(id)),
    wireRestorable: (id) => h.service().restorable(id),
    sendWaiting: async (id, pendingId) => {
      const book = h.store().wires().book;
      const w = book ? own(book.links, id) : undefined;
      if (!w) throw new Error(`There's no wire ${JSON.stringify(id)}`);
      // sent as it was readied: its text never passes through the Assistant
      if (w.pending?.id !== pendingId) throw new Error("What waited at its gate was sent or replaced since");
      const r = await h.send(id, pendingId, w.pending.body);
      if ("refused" in r) throw new Error(r.start ? `${r.refused} Send it from the wire's popover, which asks before starting it.` : r.refused);
      return r.note ?? null;
    },
  };
}

/** The wire book as the Assistant reads it (AssistantWire): ends, types and gates, never what a wire carries. */
export function wiresSeen(book: WireBook, ctx: GateContext): AssistantWire[] {
  return wiresInOrder(book.links).map(([id, w]) => {
    const g = gateOf(id, w, ctx);
    return {
      id,
      from: w.from,
      to: w.to,
      type: w.type,
      when: w.when,
      state: g.state,
      why: g.why ?? null,
      gate: g.gate,
      waiting: w.pending ? { pendingId: w.pending.id, at: w.pending.at, chars: w.pending.body.length } : null,
      rounds: w.rounds ? { used: w.rounds.used, limit: w.rounds.limit } : null,
    };
  });
}

export function wireTools(d: Deps): AssistantTool[] {
  const name = (id: string) => titleOf(sessionById(d, id), id);
  /** A session as a card names it (lookup.ts sessionRef), from the landscape's sessions: these tools read no records. */
  const ref = (id: string) => sessionRef({ sessions: () => d.sessions() }, id);
  const wire =(id: string): AssistantWire | null => d.wireList().find((w) => w.id === id) ?? null;
  const noWire = (id: string) => `There's no wire ${JSON.stringify(id)}: the wires are in list_wires`;
  const between = (w: Pick<AssistantWire, "from" | "to" | "type">) => `${TYPE_WORDS[w.type]} from ${name(w.from)} to ${name(w.to)}`;
  const target = (id: string) => ({ session: id, title: sessionById(d, id)?.title ?? null });

  return [
    defineTool<Record<string, never>>({
      name: "list_wires",
      tier: "read",
      description:
        "The wires between sessions, earliest first: id, its ends (session ids and titles), type (handoff, context, feedback, worktree), " +
        "when it fires (finished, manual, pr-merged), and its gate: state (idle, ready, sending, sent, blocked) and why, whether it asks the user " +
        "or sends itself, what waits at it (its pending id, when it was readied, how long it is) and a feedback wire's rounds. Never what it carries.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Listed the wires",
      run: () => ({
        text: JSON.stringify({
          wires: d.wireList().map((w) => ({
            ...w,
            fromTitle: sessionById(d, w.from)?.title ?? null,
            toTitle: sessionById(d, w.to)?.title ?? null,
            waiting: w.waiting && { pending: w.waiting.pendingId, since: new Date(w.waiting.at).toISOString(), chars: w.waiting.chars },
          })),
        }),
      }),
    }),
    defineTool<{ from: string; to: string; type: WireType }>({
      name: "add_wire",
      tier: "direct",
      description:
        "Draw a wire from one of this Mac's sessions to another, as dragging from a workspace's port does: a handoff (its finished summary goes on " +
        "to the next), a context link (the other may read it), a feedback wire (its review goes back), or a shared worktree wire (an agent to a " +
        "terminal in its folder). Refused where the landscape refuses it. The user can Undo it.",
      inputSchema: {
        type: "object",
        properties: { from: SESSION_ARG, to: SESSION_ARG, type: { type: "string", enum: WIRE_TYPES, description: "handoff, context, feedback or worktree" } },
        required: ["from", "to", "type"],
        additionalProperties: false,
      },
      label: (a) => `Draw a ${between(a)}`,
      check: (a) => d.guard("focus", a.from) ?? d.guard("focus", a.to) ?? d.wireAddRefusal(a.from, a.to, a.type),
      target: (a) => target(a.from),
      run: (a) => {
        const id = d.addWire(a.from, a.to, a.type);
        // its Undo removes only the wire it drew, while it's still that wire
        const same = () => {
          const w = wire(id);
          return !!w && w.from === a.from && w.to === a.to && w.type === a.type;
        };
        return {
          text: `Drew a ${between(a)} (wire ${id}).`,
          stillUndoable: same,
          undo: () => {
            if (!same()) throw new Error("That wire was removed or changed since");
            d.removeWire(id);
            return `Removed the ${between(a)}`;
          },
        };
      },
    }),
    defineTool<{ wire: string }>({
      name: "remove_wire",
      tier: "direct",
      description: "Remove a wire, whatever state it's in, as its ✕ does: what waited at its gate goes with it. The user can Undo it while Mockingbird still holds it to put back.",
      inputSchema: { type: "object", properties: { wire: WIRE_ARG }, required: ["wire"], additionalProperties: false },
      label: (a) => {
        const w = wire(a.wire);
        return w ? `Remove the ${between(w)}` : `Remove wire ${a.wire}`;
      },
      check: (a) => (wire(a.wire) ? null : noWire(a.wire)),
      run: (a) => {
        const w = wire(a.wire)!;
        d.removeWire(a.wire);
        // put back only while the service still holds it, and no wire took its id since
        const back = () => d.wireRestorable(a.wire) && !wire(a.wire);
        return {
          text: `Removed the ${between(w)}${w.waiting ? ", and what waited at its gate" : ""}.`,
          stillUndoable: back,
          undo: () => {
            if (!back()) throw new Error("It can't be put back any more");
            d.restoreWire(a.wire);
            return `Put the ${between(w)} back`;
          },
        };
      },
    }),
    defineTool<{ wire: string; pending: string }>({
      name: "send_handoff",
      tier: "confirm",
      description:
        "Send what waits at a wire's gate (a handoff's summary, a feedback wire's review) to its other end, as Send in the wire's popover does, " +
        "with the text as it was readied. Name the wire and its waiting pending's id, from list_wires. A stopped other end isn't started. " +
        "This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: {
        type: "object",
        properties: { wire: WIRE_ARG, pending: { type: "string", minLength: 1, maxLength: 80, description: "The id of what waits at its gate (list_wires' waiting.pending)" } },
        required: ["wire", "pending"],
        additionalProperties: false,
      },
      label: (a) => {
        const w = wire(a.wire);
        return w ? `Send what waits on the ${between(w)}` : `Send what waits on wire ${a.wire}`;
      },
      check: (a) => {
        const w = wire(a.wire);
        if (!w) return noWire(a.wire);
        if (w.waiting?.pendingId !== a.pending) return "Nothing with that id waits at its gate now: list_wires says what does";
        if (w.state === "blocked") return w.why ?? "Its gate is blocked";
        if (w.state === "sending") return "It's being sent already";
        if (w.state !== "ready") return "Nothing at its gate is ready to send";
        return d.guard("write", w.to);
      },
      card: (a) => {
        const w = wire(a.wire);
        const warnings: string[] = [];
        const to = w && sessionById(d, w.to);
        if (to?.status === "working") warnings.push(`${ref(w!.to)} is working: it's queued until its turn ends.`);
        if (w?.rounds) warnings.push(`It's round ${w.rounds.used + 1} of ${w.rounds.limit}.`);
        return {
          title: w ? `Send what waits on the ${TYPE_WORDS[w.type]} from ${ref(w.from)} to ${ref(w.to)}` : `Send what waits on wire ${a.wire}`,
          detail: w
            ? `Pastes the message readied at its gate (${w.waiting?.chars ?? 0} characters) into ${ref(w.to)} and submits it, as Send in the wire's popover does.`
            : "Sends what waits at its gate.",
          warnings,
        };
      },
      // the card is about that one message: another readied since, or it gone, expires it
      stillValid: (a) => wire(a.wire)?.waiting?.pendingId === a.pending,
      target: (a) => {
        const w = wire(a.wire);
        return w ? target(w.to) : null;
      },
      run: async (a) => {
        const w = wire(a.wire);
        const note = await d.sendWaiting(a.wire, a.pending);
        return { text: `Sent what waited on the ${w ? between(w) : `wire ${a.wire}`}.${note ? ` ${note}` : ""}` };
      },
    }),
    defineTool<{ ticket: string }>({
      name: "approve_gate",
      tier: "confirm",
      description:
        "Approve a ticket at the pipeline's stakeholder-testing gate, as its Approve does: it moves to Approved, and the session that asked for its " +
        "pull request to dev is told to prepare the pull request to main. Nothing is pushed or opened. Only for a ticket in stakeholder testing. " +
        "This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { ticket: TICKET_ARG }, required: ["ticket"], additionalProperties: false },
      label: (a) => `Approve #${a.ticket} in stakeholder testing`,
      check: (a) => {
        const t = d.ticketStage(a.ticket);
        if (!t) return `#${a.ticket} isn't tracked in the ticket pipeline`;
        if (t.stage !== "stakeholder") return `#${a.ticket} is at ${stageLabel(t.stage as StoredStage)}: Approve is for a ticket in stakeholder testing`;
        return null;
      },
      card: (a) => {
        const t = d.ticketStage(a.ticket);
        return {
          title: `Approve #${a.ticket}${t?.title ? ` “${t.title}”` : ""} in stakeholder testing`,
          detail: "Moves it to Approved, and tells the session that asked for its pull request to dev to prepare the pull request to main. Nothing is pushed or opened.",
          warnings: [],
        };
      },
      stillValid: (a) => d.ticketStage(a.ticket)?.stage === "stakeholder",
      run: async (a) => ({ text: `Approved #${a.ticket}. ${await d.approveTicket(a.ticket)}` }),
    }),
  ];
}
