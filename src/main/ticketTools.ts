import { MCP_SERVER, type Reply } from "./messaging";
import { goesBack, PAST_APPROVAL, patchNotesRefusal, requestRefusal, stageRefusal, untickRefusal, type GateReport, type PipelineStore } from "./pipeline";
import { holdsPrivateKey } from "./team/artifactStore";
import {
  GATE_ITEM_KEYS,
  GATE_NOTE_MAX,
  PATCH_NOTES_MAX,
  PR_DESCRIPTION_MAX,
  PR_TITLE_MAX,
  STAGE_NOTE_MAX,
  TICKET_TOOL,
} from "./ticketToolSchemas";
import { REDACTED, redactSecrets } from "./wirePrompt";
import { onlyArgs } from "./wireTools";
import { oneLine, plainLine, quoted } from "../shared/team/agentText";
import { BY_YOU, GATES, personTicks, stageLabel, ticketOfSession, type AgentTold, type PrTarget, type SessionInfo, type StoredStage, type TicketPipeline, type TicketStage } from "../shared/types";
import { ROOMS_STARTING } from "../shared/wires";

export interface TicketToolsOptions {
  pipeline: Pick<PipelineStore, "get" | "setStage" | "agentMove" | "holdRequest" | "dropRequest" | "agentPatchNotes">;
  sessions: {
    list(): SessionInfo[];
    resumable(): SessionInfo[];
    deliverAgentMessage(id: string, message: string, submit: boolean): string;
  };
  /** Whether a message to this session is submitted, or left in its prompt (its group's message mode). */
  submitOnDelivery(target: SessionInfo): boolean;
  /** Why session `id` can't have `doing` done to it, a teammate having taken it over; null otherwise. */
  takenOver(id: string, doing: string): string | null;
  /** The team room session `id` is in, or null; and whether rooms have started, before which no session looks to be in one. */
  roomOf(id: string): string | null;
  roomsKnown(): boolean;
  /** An agent sent the ticket back to Coding from past the user's approval of stage 6: the user is told, once. Whether a notice showed. */
  onApprovalUndone?(e: ApprovalUndone): boolean;
  /** An agent changed a ticket's record: the windows hear of it. */
  onChanged(): void;
  log: (context: string, err: unknown) => void;
}

/** An agent's move back that undid the user's approval: who, from where, and why it said. */
export interface ApprovalUndone {
  ticket: string;
  title: string | null;
  session: SessionInfo;
  by: string;
  from: StoredStage;
  note: string;
  /** The person items still ticked (personTicks), which the rework may need done again. */
  kept: string[];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const nOf = (n: number) => n.toLocaleString("en-US");
const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Who an agent's change is marked as: its workspace's title, as an agent's, so it never reads as the user's. */
export const agentBy = (me: Pick<SessionInfo, "title">): string => `${plainLine(me.title, 80) || "an unnamed workspace"}'s agent`;

type Text = { text: string; count: number } | { refused: string };

/** Bidi controls and marks, and zero-width characters: they reorder or hide text where the user reads it and where it's posted. */
const INVISIBLE_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * An agent's text for the ticket's record, which others read once the user posts or opens it: invisible characters
 * taken out, trimmed (on one line when `line`), refused empty or holding a private key, and redacted, `count` saying how
 * many values went. Refused past `max`, before redaction and after it, since a redacted value can be longer.
 */
function agentText(name: string, v: unknown, max: number, line = false): Text {
  const raw = typeof v === "string" ? v.replace(INVISIBLE_RE, "") : "";
  const t = line ? oneLine(raw, Infinity) : raw.trim();
  if (!t) return { refused: `${name} is empty.` };
  if (t.length > max) return { refused: `${name} is ${nOf(t.length)} characters; the limit is ${nOf(max)}.` };
  if (holdsPrivateKey(t)) return { refused: `${name} holds a private key, so nothing was kept: take it out and call again.` };
  const r = redactSecrets(t);
  if (r.text.length > max)
    return { refused: `${name} is ${nOf(r.text.length)} characters once its ${r.count} secret-looking value${r.count === 1 ? " is" : "s are"} replaced with ${REDACTED}; the limit is ${nOf(max)}: shorten it.` };
  return r;
}

/**
 * gate_notes checked against the checklists of `gates` (by id): each item known, on one of those, named once, with a
 * note, and ticked only if a person's act isn't what it records. `count`: values redaction took out of the notes.
 */
export function gateReport(raw: unknown, gates: readonly string[], against: string): { report: GateReport[]; count: number } | { refused: string } {
  if (raw === undefined || raw === null) return { report: [], count: 0 };
  if (!Array.isArray(raw)) return { refused: "gate_notes is a list of { item, note, done? }." };
  if (!raw.length) return { report: [], count: 0 };
  if (!gates.length) return { refused: `There's no checklist ${against}, so gate_notes have nothing to report against.` };
  const titles = gates.map((id) => `"${GATES.find((g) => g.id === id)!.title}"`).join(" or ");
  const report: GateReport[] = [];
  let count = 0;
  for (const e of raw) {
    if (!isMap(e)) return { refused: "Each of gate_notes is { item, note, done? }." };
    const extra = onlyArgs("Each of gate_notes", e, ["item", "note", "done"]);
    if (extra) return { refused: extra };
    const key = typeof e.item === "string" ? e.item : "";
    const [gateId, itemKey] = key.split(":");
    const gate = GATES.find((g) => g.id === gateId);
    const item = gate?.items.find((i) => i.key === itemKey);
    if (!gate || !item || !GATE_ITEM_KEYS.includes(key)) return { refused: `gate_notes names ${quoted(key, 60)}, which isn't a checklist item: they're ${GATE_ITEM_KEYS.join(", ")}.` };
    if (!gates.includes(gate.id)) return { refused: `${key} is on the "${gate.title}" checklist; this call reports against ${titles}.` };
    if (report.some((r) => r.key === key)) return { refused: `gate_notes names ${key} twice.` };
    if (e.done !== undefined && typeof e.done !== "boolean") return { refused: `done, for ${key}, is true or false.` };
    if (e.done === true && item.person)
      return { refused: `${key} ("${item.label}") records a person's act, so an agent can't tick it: leave done out, and say in its note what's ready for them.` };
    const note = agentText(`The note for ${key}`, e.note, GATE_NOTE_MAX);
    if ("refused" in note) return note;
    report.push({ key, note: note.text, done: e.done === true });
    count += note.count;
  }
  return { report, count };
}

const redactedLine = (n: number): string => (n ? ` ${n} secret-looking value${n === 1 ? " was" : "s were"} replaced with ${REDACTED}; redaction is a net, not a guarantee.` : "");

/** What became of an agent's gate notes: `ticked` of them ticked an item, one the user had ticked staying theirs. */
const notesLine = (r: readonly GateReport[], ticked: number): string =>
  r.length ? ` Your notes are kept beside ${r.length} checklist item${r.length === 1 ? "" : "s"}${ticked ? `, ${ticked} of them ticked as yours (the user can untick them)` : ""}.` : "";

/**
 * The agents' ticket tools (set_stage, request_pr, write_patch_notes) and the window's approval and dismissal that
 * answer them (docs/landscape-wires.md, W14). The ticket is always the caller's own (ticketOfSession of the session its
 * token names): no argument names one, and every tool refuses a workspace on no ticket, a ticket not tracked yet, and a
 * copy a teammate took over. Each answers at once, as Codex's tool timeout needs.
 *
 * Nothing here pushes, opens a pull request or posts to Azure DevOps: a request and a draft are records the user's
 * click acts on (pipeline:pr:create, pipeline:draft:post), and a stage move fires no wire, gate or message.
 */
export class TicketTools {
  constructor(private readonly o: TicketToolsOptions) {}

  /** One of the ticket tools, for the session the caller's token names. */
  async call(me: SessionInfo, op: string, args: Record<string, unknown>): Promise<Reply> {
    try {
      if (op === TICKET_TOOL.setStage) return this.setStage(me, args);
      if (op === TICKET_TOOL.requestPr) return this.requestPr(me, args);
      if (op === TICKET_TOOL.writePatchNotes) return this.writePatchNotes(me, args);
    } catch (err) {
      this.o.log(`tickets: ${op} for ${me.id} failed`, err);
      return { error: `${op} failed: ${errorText(err)}` };
    }
    return { error: `Unknown tool: ${op}` };
  }

  /** The caller's ticket and its record, or why it has none it can change. */
  private ticketOf(me: SessionInfo, doing: string): { id: string; p: TicketPipeline } | { refused: string } {
    const id = ticketOfSession(me);
    if (!id) return { refused: "This workspace isn't on a ticket, so it has no ticket stage, pull request or patch notes to write." };
    const taken = this.o.takenOver(me.id, doing);
    if (taken) return { refused: taken };
    const p = this.o.pipeline.get(id);
    if (!p) return { refused: `#${id} isn't tracked in Mockingbird's ticket pipeline yet: the user starts that from the ticket.` };
    return { id, p };
  }

  private changed(): void {
    try {
      this.o.onChanged();
    } catch (err) {
      this.o.log("tickets: telling the windows a ticket changed", err);
    }
  }

  private setStage(me: SessionInfo, args: Record<string, unknown>): Reply {
    const extra = onlyArgs(TICKET_TOOL.setStage, args, ["stage", "note", "gate_notes"]);
    if (extra) return { error: extra };
    const t = this.ticketOf(me, "moving this copy's ticket");
    if ("refused" in t) return { error: t.refused };
    const note = args.note === undefined || args.note === null ? null : agentText("note", args.note, STAGE_NOTE_MAX);
    if (note && "refused" in note) return { error: note.refused };
    const why = stageRefusal(t.p.stage, args.stage, note?.text);
    if (why) return { error: `#${t.id} wasn't moved: ${why}` };
    const to = args.stage as TicketStage;
    const back = goesBack(t.p.stage, to);
    if (back && Array.isArray(args.gate_notes) && args.gate_notes.length)
      return { error: "A move back to Coding clears agents' ticks on the checklists, so it takes no gate_notes:report against a checklist with a move forward or request_pr." };
    const gates = GATES.filter((g) => g.at === t.p.stage || g.at === to).map((g) => g.id);
    const r = gateReport(args.gate_notes, back ? [] : gates, `at ${stageLabel(t.p.stage)} or ${stageLabel(to)}`);
    if ("refused" in r) return { error: r.refused };
    const unticked = untickRefusal(t.p, r.report);
    if (unticked) return { error: unticked };
    const from = t.p.stage;
    const by = agentBy(me);
    const { pipeline, drafted, ticked } = this.o.pipeline.agentMove(t.id, to, { note: note?.text, by, report: r.report });
    this.changed();
    const redacted = redactedLine((note?.count ?? 0) + r.count);
    if (back) {
      const undid = PAST_APPROVAL.includes(from);
      let shown = false;
      if (undid) {
        try {
          shown = this.o.onApprovalUndone?.({ ticket: t.id, title: pipeline.title ?? null, session: me, by, from, note: note!.text, kept: personTicks(pipeline) }) ?? false;
        } catch (err) {
          this.o.log(`tickets: telling the user ${me.id} sent #${t.id} back from ${from}`, err);
        }
      }
      const approval = !undid
        ? ""
        : shown
          ? " That undoes the user's approval of stakeholder testing, so Mockingbird showed them a notice."
          : " That undoes the user's approval of stakeholder testing, and Mockingbird showed them no notice (their notification settings, or it failed): say so in your reply.";
      return {
        result:
          `#${t.id} is back at Coding from ${stageLabel(from)}, with your note kept as its feedback, marked as yours. Agents' ticks on its checklists were cleared, as the work changes; the user's stay.` +
          `${approval}${redacted}`,
      };
    }
    const comment = drafted ? " Mockingbird drafted the stage's comment for the ticket; only the user posts it." : "";
    return { result: `#${t.id} moved from ${stageLabel(from)} to ${stageLabel(to)}, marked as yours.${comment}${notesLine(r.report, ticked)}${redacted}` };
  }

  private requestPr(me: SessionInfo, args: Record<string, unknown>): Reply {
    const extra = onlyArgs(TICKET_TOOL.requestPr, args, ["target", "title", "description", "gate_notes"]);
    if (extra) return { error: extra };
    const t = this.ticketOf(me, "asking for a pull request from this copy");
    if ("refused" in t) return { error: t.refused };
    const why = requestRefusal(t.p.stage, args.target);
    if (why) return { error: `Nothing was asked: ${why}` };
    const target = args.target as PrTarget;
    const title = agentText("title", args.title, PR_TITLE_MAX, true);
    if ("refused" in title) return { error: title.refused };
    const description = agentText("description", args.description, PR_DESCRIPTION_MAX);
    if ("refused" in description) return { error: description.refused };
    const r = gateReport(args.gate_notes, [target === "dev" ? "dev" : "staging"], "");
    if ("refused" in r) return { error: r.refused };
    const unticked = untickRefusal(t.p, r.report);
    if (unticked) return { error: unticked };
    const held = t.p.requests?.find((x) => x.target === target);
    const across = held ? this.acrossLine(me.id, held.from) : null;
    if (across) return { error: `Nothing was asked: a request for a pull request to ${target} is held from another workspace, and ${across}` };
    const by = agentBy(me);
    const { replaced, ticked } = this.o.pipeline.holdRequest(t.id, { target, from: me.id, fromTitle: plainLine(me.title, 80), title: title.text, description: description.text }, r.report, by);
    this.changed();
    const was = replaced ? ` It replaces the request ${replaced.from === me.id ? "you" : quoted(replaced.fromTitle)} made earlier for this target.` : "";
    return {
      result:
        `Asked: the user is shown your request for a pull request to ${target} on #${t.id}, ${quoted(title.text)}, with your description, marked as yours. ` +
        `Nothing is pushed or opened until they open it from Mockingbird; you'll hear if they dismiss it.${was}${notesLine(r.report, ticked)}${redactedLine(title.count + description.count + r.count)}`,
    };
  }

  private writePatchNotes(me: SessionInfo, args: Record<string, unknown>): Reply {
    const extra = onlyArgs(TICKET_TOOL.writePatchNotes, args, ["text"]);
    if (extra) return { error: extra };
    const t = this.ticketOf(me, "writing this copy's patch notes");
    if ("refused" in t) return { error: t.refused };
    const why = patchNotesRefusal(t.p.stage);
    if (why) return { error: `Nothing was kept: ${why}` };
    const text = agentText("text", args.text, PATCH_NOTES_MAX);
    if ("refused" in text) return { error: text.refused };
    for (const d of t.p.drafts.filter((x) => x.stage === "comms" && x.by)) {
      const across = this.acrossLine(me.id, d.from ?? "");
      if (across) return { error: `Nothing was kept: the patch notes draft there is another workspace's, and ${across}` };
    }
    const { replaced } = this.o.pipeline.agentPatchNotes(t.id, text.text, agentBy(me), me.id);
    this.changed();
    const was = replaced ? ` It replaces the earlier agent's draft.` : "";
    return { result: `Kept as #${t.id}'s patch notes draft (${nOf(text.text.length)} characters), marked as yours. The user reads it and posts it; nothing is posted by this.${was}${redactedLine(text.count)}` };
  }

  // ---- the window ----------------------------------------------------------------------------

  /**
   * The user approved ticket `id` in stakeholder testing (pipeline:approve): it moves to Approved, and the session that
   * asked for its PR to dev (PipelinePr.by) is told, in Mockingbird's words, to prepare the PR to main. A session that
   * isn't running isn't reopened: the answer says so, for the panel to offer Reopen.
   */
  approve(id: string): { pipeline: TicketPipeline; told: AgentTold } {
    const p = this.o.pipeline.get(id);
    if (!p) throw new Error(`#${id} isn't tracked in the ticket pipeline`);
    if (p.stage !== "stakeholder") throw new Error(`#${id} is at ${stageLabel(p.stage)}: Approve is for a ticket in stakeholder testing`);
    const pipeline = this.o.pipeline.setStage(id, "approved", { by: BY_YOU });
    const asked = pipeline.prs.filter((x) => x.target === "dev").at(-1)?.by ?? null;
    const ticket = `#${id}${pipeline.title ? ` ${quoted(pipeline.title)}` : ""}`;
    const line =
      `[Mockingbird: the user approved ${ticket} in stakeholder testing. Prepare the pull request to main: when the branch is ready, ` +
      `call the ${MCP_SERVER} ${TICKET_TOOL.requestPr} tool with target "main". The user opens it; nothing is pushed until they do.]`;
    return { pipeline, told: this.tell(id, asked, line, `No pull request to dev on #${id} says which workspace asked for it, so no agent was told.`) };
  }

  /** The user dismissed an agent's pull request request (pipeline:request:dismiss): it goes, and its agent is told, with the user's note. */
  dismissRequest(id: string, requestId: string, note: string): { pipeline: TicketPipeline; told: AgentTold } {
    const { pipeline, request } = this.o.pipeline.dropRequest(id, requestId);
    const said = note.trim();
    const line =
      `[Mockingbird: the user dismissed your request for a pull request to ${request.target} on #${id} (${quoted(request.title)}). ` +
      `Nothing was pushed or opened.${said ? " Their note follows." : ""}]${said ? `\n\n${said}` : ""}`;
    return { pipeline, told: this.tell(id, request.from, line, "") };
  }

  /**
   * Held PR requests a change dropped (PipelineStore's onRequestsDropped): each asker is told why, as a dismissal tells
   * it, if it's still on the ticket and running.
   */
  requestsDropped(id: string, dropped: { request: { target: PrTarget; from: string; title: string }; why: string }[]): AgentTold[] {
    return dropped.map(({ request, why }) =>
      this.tell(id, request.from, `[Mockingbird: your request for a pull request to ${request.target} on #${id} (${quoted(request.title)}) was dropped: ${why} Nothing was pushed or opened.]`, "")
    );
  }

  /**
   * `text` to session `to` about ticket `ticket`, through its queue, or why it wasn't: none to tell, on another ticket
   * now, not running (reopen it), taken over, or a failure, which is logged. It never throws, so the window's change
   * before it is answered and heard of whatever happens here.
   */
  private tell(ticket: string, to: string | null, text: string, none: string): AgentTold {
    if (!to) return { to: null, title: null, notTold: none };
    try {
      const s = this.o.sessions.list().find((x) => x.id === to && !x.shell);
      const found = s ?? this.o.sessions.resumable().find((x) => x.id === to && !x.shell);
      const title = found?.title ?? null;
      const name = title ? quoted(title) : `Workspace ${to}`;
      const now = found ? ticketOfSession(found) : ticket;
      if (now !== ticket) return { to, title, notTold: now ? `${name} is on #${now} now, so it wasn't told.` : `${name} isn't on a ticket now, so it wasn't told.` };
      if (!s || s.status === "dead") return { to, title, notTold: `${name} isn't running, so it wasn't told: reopen it to tell it.`, ...(title ? { reopen: true as const } : {}) };
      const taken = this.o.takenOver(to, "telling this copy");
      if (taken) return { to, title: s.title, notTold: taken };
      return { to, title: s.title, told: this.o.sessions.deliverAgentMessage(to, text, this.o.submitOnDelivery(s)) };
    } catch (err) {
      this.o.log(`tickets: telling ${to} about #${ticket}`, err);
      return { to, title: null, notTold: `It couldn't be told: ${errorText(err)}` };
    }
  }

  /**
   * Why session `me` can't replace session `other`'s record (a held request, a patch notes draft), or null: they're on
   * either side of a team room's line, or rooms haven't started, so that can't be told yet. Neither is named.
   */
  private acrossLine(me: string, other: string): string | null {
    if (me === other) return null;
    if (!this.o.roomsKnown()) return ROOMS_STARTING;
    return this.o.roomOf(me) !== this.o.roomOf(other) ? "it's on the other side of a team room's line, so this can't replace it: the user opens or dismisses it first." : null;
  }
}
