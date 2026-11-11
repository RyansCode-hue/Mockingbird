import * as crypto from "crypto";
import {
  type CommentDraft,
  type PipelinePr,
  type PipelineRequest,
  type StoredStage,
  type TicketPipeline,
  type TicketStage,
  TICKET_STAGES,
  clearGateTicks,
  clearsGates,
  isTicketStage,
  stageLabel,
  stageStep,
} from "../shared/types";
import { readJsonOrSetAside, writeFileAtomic } from "./fileOps";

/**
 * The comment a stage drafts for the ticket's discussion, or null for a stage
 * worth no comment. Drafts are suggestions: nothing posts until the user does.
 * `back`: the ticket has been in development before, so reaching Coding again
 * doesn't say it has started. A PR stage reached with no PR (by hand on the
 * rail) has nothing to say.
 */
export function stageComment(stage: TicketStage, ctx: { pr?: PipelinePr; summary?: string; note?: string; back?: boolean }): string | null {
  const parts = (...xs: (string | undefined)[]) => xs.filter((x) => x && x.trim()).join("\n\n");
  const pr = ctx.pr && `${ctx.pr.url}\n${ctx.pr.branch} → ${ctx.pr.base}`;
  switch (stage) {
    case "coding":
      if (ctx.note) return parts("Stakeholder feedback received; back in development to address it:", ctx.note);
      return ctx.back ? "Back in development." : "Development has started.";
    case "local-test":
      return "Development is done; testing locally.";
    case "pr-dev":
      return pr ? parts("Pull request to dev opened:", pr, ctx.summary) : null;
    case "stakeholder":
      return "Deployed to dev/UAT and tested; ready for stakeholder testing.";
    case "approved":
      return "Approved in stakeholder testing.";
    case "pr-main":
      return pr ? parts("Pull request to main opened:", pr, ctx.summary) : null;
    case "prod-test":
      return "Merged to main; testing in staging/production.";
    case "done":
      return "Done.";
    // BA and AI testing in dev/UAT say nothing; Patch notes' comment is the notes themselves, saved from the panel
    default:
      return null;
  }
}

// ---- what an agent may do to its ticket (docs/landscape-wires.md, section 4: "Agents moving stages") ----

/** Whether a move from `from` to `to` goes back: to an earlier rail step, or another stage within the same one. */
export const goesBack = (from: StoredStage, to: TicketStage): boolean => {
  const a = stageStep(from);
  const b = stageStep(to)!;
  return a !== null && from !== to && b <= a;
};

/**
 * Why an agent's set_stage can't move a ticket from `from` to `to`, or null. Done and stage 6's approval are the user's;
 * the PR stages are set only by a PR opening, and AI testing's by that PR merging (W16) or the user, so the stage never
 * claims a PR or a merge that isn't there; BA is never gone back to. Forward is one rail step, stage 6's three counting
 * as one, and from stage 6 an agent can only send it back. Back is to Coding only, with `note`, the feedback that
 * caused it. A stage this build doesn't know, and Done, are the user's to move from.
 */
export function stageRefusal(from: StoredStage, to: unknown, note?: string): string | null {
  if (!isTicketStage(to)) return `${JSON.stringify(String(to).slice(0, 40))} isn't a stage an agent can move a ticket to.`;
  const at = `It's at ${stageLabel(from)}.`;
  if (to === "done") return "Done is the user's to mark, never an agent's.";
  if (to === "approved") return "Approving stakeholder testing is the user's, never an agent's.";
  if (to === "pr-dev" || to === "pr-main")
    return `Only a pull request opening moves a ticket to ${stageLabel(to)}, so the stage never claims a PR that isn't there: ask for one with request_pr, and the user opens it.`;
  if (to === "ba") return "A ticket never goes back to BA.";
  const a = stageStep(from);
  if (a === null) return `It's at ${JSON.stringify(String(from).slice(0, 40))}, a stage this version of Mockingbird doesn't know: the user moves it.`;
  if (from === "done") return "It's Done: only the user reopens it.";
  if (from === to) return `It's at ${stageLabel(to)} already.`;
  if (goesBack(from, to)) {
    if (to !== "coding") return `An agent sends a ticket back only to Coding, with the feedback that sends it there. ${at}`;
    if (!note?.trim()) return "Sending it back to Coding needs note: the feedback that sends it back.";
    return null;
  }
  if (a === 6) return `From stakeholder testing an agent can only send it back to Coding, with the feedback: moving it on is the user's. ${at}`;
  if (to === "dev-test" || to === "prod-test")
    return `Only its pull request merging, or the user, moves a ticket to ${stageLabel(to)}, so the stage never claims a merge that hasn't happened.`;
  const next = TICKET_STAGES.find((x) => x.step === a + 1);
  if (stageStep(to) !== a + 1) return `Forward is one step on the rail: from ${stageLabel(from)} the next is ${next?.label ?? "nothing"}.`;
  return null;
}

/** Why an agent can't ask for a pull request to `target` with its ticket at `stage`, or null: dev from Coding or Local testing, main only once approved. */
export function requestRefusal(stage: StoredStage, target: unknown): string | null {
  if (target !== "dev" && target !== "main") return `target is "dev" or "main", not ${JSON.stringify(String(target).slice(0, 40))}.`;
  if (target === "dev" && stage !== "coding" && stage !== "local-test") return `A pull request to dev is asked for from Coding or Local testing; it's at ${stageLabel(stage)}.`;
  if (target === "main" && stage !== "approved") return `A pull request to main is asked for once the user has approved stakeholder testing; it's at ${stageLabel(stage)}.`;
  return null;
}

/** Why an agent can't write patch notes with its ticket at `stage`, or null: at AI testing in staging/prod or Patch notes. */
export function patchNotesRefusal(stage: StoredStage): string | null {
  return stage === "prod-test" || stage === "comms" ? null : `Patch notes are written at ${stageLabel("prod-test")} or ${stageLabel("comms")}; it's at ${stageLabel(stage)}.`;
}

/** An agent's report on one gate item (gate_notes): what it did and its evidence, and whether it ticks the item. */
export interface GateReport {
  key: string;
  note: string;
  done: boolean;
}

const LISTS = ["history", "prs", "feedback", "drafts"] as const;
const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Why a record can't be changed safely, or null. Checked before any change, so a refusal leaves it as it was. */
function shapeProblem(p: TicketPipeline): string | null {
  if (!isMap(p)) return "it isn't an object";
  for (const k of LISTS) if (!Array.isArray(p[k])) return `its ${k} isn't a list`;
  if (!isMap(p.checks)) return "its checks aren't a map";
  if (p.checkedBy != null && !isMap(p.checkedBy)) return "its checkedBy isn't a map";
  if (p.gateNotes != null && !isMap(p.gateNotes)) return "its gateNotes aren't a map";
  if (p.requests != null && !Array.isArray(p.requests)) return "its requests aren't a list";
  return null;
}

/**
 * Each ticket's place in the delivery lifecycle, its pull requests, stakeholder
 * feedback, gate checklist and drafted comments. One JSON file, written whole
 * (write-then-rename) on every change.
 *
 * Records are kept as parsed and changed in place, never rebuilt, so what a
 * newer build wrote (a stage id or a field this one doesn't know) is written
 * back as it was. 1.6.0 does the same, which is why pipeline.json needs no
 * version or migration. A record missing one of its lists or its checks has it
 * started empty on reading; one holding something else there is refused.
 */
export class PipelineStore {
  private data: Record<string, TicketPipeline>;

  constructor(private file: string) {
    this.data = this.load();
  }

  private load(): Record<string, TicketPipeline> {
    const raw = readJsonOrSetAside(this.file, {});
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, TicketPipeline>) : {};
    for (const [id, p] of Object.entries(data)) {
      if (!isMap(p)) continue;
      const started = [...LISTS.filter((k) => p[k] === undefined), ...(p.checks === undefined ? ["checks"] : [])];
      if (!started.length) continue;
      for (const k of LISTS) p[k] ??= [];
      p.checks ??= {};
      console.error(`[mockingbird] pipeline.json: #${id} had no ${started.join(", ")}; started empty.`);
    }
    return data;
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  /**
   * Make a change to ticket `id` and save it. When anything throws, the save
   * included, the record goes back to how it was, so a change that failed is
   * never written later by another ticket's save.
   */
  private change<T>(id: string, fn: () => T): T {
    const had = Object.prototype.hasOwnProperty.call(this.data, id);
    const before = had ? structuredClone(this.data[id]) : undefined;
    try {
      const r = fn();
      this.save();
      return r;
    } catch (err) {
      if (had) this.data[id] = before!;
      else delete this.data[id];
      throw err;
    }
  }

  all(): Record<string, TicketPipeline> {
    return this.data;
  }

  get(id: string): TicketPipeline | null {
    return this.data[id] ?? null;
  }

  /** Ticket `id`'s record, made at BA when there's none; refused, unchanged, when it can't be changed safely. */
  private record(id: string, title?: string): TicketPipeline {
    const cur = this.data[id];
    if (cur) {
      const why = shapeProblem(cur);
      if (why) throw new Error(`#${id}'s record in pipeline.json can't be changed: ${why}`);
      if (title) cur.title = title;
      return cur;
    }
    const fresh: TicketPipeline = { ticketId: id, title, stage: "ba", history: [], prs: [], feedback: [], drafts: [], checks: {} };
    this.data[id] = fresh;
    return fresh;
  }

  /** Ticket `id`'s record for an agent's change: refused when there's none, as an agent never starts one. */
  private tracked(id: string): TicketPipeline {
    if (!this.data[id]) throw new Error(`#${id} isn't tracked in the ticket pipeline`);
    return this.record(id);
  }

  private draft(p: TicketPipeline, stage: TicketStage, text: string | null, by?: string): void {
    if (!text) return;
    const d: CommentDraft = { id: crypto.randomUUID(), stage, text, at: Date.now(), ...(by ? { by } : {}) };
    p.drafts.push(d);
  }

  /**
   * An agent's gate notes, each kept beside its item; one it says it did is ticked as its tick, unless it's ticked
   * already (the user's tick stays theirs). Returns how many it ticked.
   */
  private report(p: TicketPipeline, notes: readonly GateReport[], by: string): number {
    const at = Date.now();
    let ticked = 0;
    for (const n of notes) {
      (p.gateNotes ??= {})[n.key] = { by, note: n.note, at };
      if (n.done && !p.checks[n.key]) {
        p.checks[n.key] = true;
        (p.checkedBy ??= {})[n.key] = { by, at };
        ticked++;
      }
    }
    return ticked;
  }

  /**
   * Move a record to `stage`: its history entry and drafted comment, and, back
   * at Coding, the gates' ticks cleared, which the entry's note says. `draft`:
   * "plain" drafts the stage's comment without quoting `note`, "none" drafts nothing.
   */
  private move(p: TicketPipeline, stage: TicketStage, o: { note?: string; summary?: string; pr?: PipelinePr; by?: string; draft?: "plain" | "none" }): TicketPipeline {
    const back = p.history.some((h) => (stageStep(h.stage) ?? 0) >= 2);
    const cleared = clearsGates(p.stage, stage) ? clearGateTicks(p) : null;
    const note = [o.note, cleared].filter(Boolean).join("\n\n");
    p.stage = stage;
    p.history.push({ at: Date.now(), stage, ...(note ? { note } : {}), ...(o.by ? { by: o.by } : {}) });
    if (o.draft !== "none") this.draft(p, stage, stageComment(stage, { ...o, ...(o.draft === "plain" ? { note: undefined } : {}), back }));
    return p;
  }

  /** Move a ticket to a stage, drafting that stage's comment. `by` is who moved it. Refuses an id this build doesn't know. */
  setStage(id: string, stage: TicketStage, o: { title?: string; note?: string; summary?: string; pr?: PipelinePr; by?: string } = {}): TicketPipeline {
    if (!isTicketStage(stage)) throw new Error(`Unknown stage "${stage}"`);
    return this.change(id, () => this.move(this.record(id, o.title), stage, o));
  }

  /** A ticket starts at Coding when a session is opened on it, unless it's already further along. */
  startCoding(id: string, title?: string, by?: string): TicketPipeline | null {
    const p = this.data[id];
    if (p && p.stage !== "ba") return null;
    return this.setStage(id, "coding", { title, by });
  }

  /** Stakeholder feedback sends the ticket back to Coding, quoted in the comment it drafts. */
  addFeedback(id: string, text: string, by?: string): TicketPipeline {
    const t = text.trim();
    if (!t) throw new Error("The feedback is empty");
    return this.change(id, () => {
      const p = this.record(id);
      p.feedback.push({ at: Date.now(), text: t });
      return this.move(p, "coding", { note: t, by });
    });
  }

  /**
   * A pull request was opened: record it and move to its stage. An agent's request for it is answered, so it goes, and
   * the PR is that agent's (`by`), whichever session it was opened from.
   */
  addPr(id: string, pr: PipelinePr, title?: string, by?: string): TicketPipeline {
    return this.change(id, () => {
      const p = this.record(id, title);
      const asked = p.requests?.find((r) => r.target === pr.target);
      if (p.requests) p.requests = p.requests.filter((r) => r.target !== pr.target);
      p.prs.push(asked ? { ...pr, by: asked.from } : pr);
      return this.move(p, pr.target === "dev" ? "pr-dev" : "pr-main", { pr, summary: pr.summary, by });
    });
  }

  /** Tick or untick a gate item; a tick keeps who made it, an untick forgets it. */
  setCheck(id: string, key: string, value: boolean, by: string): TicketPipeline {
    return this.change(id, () => {
      const p = this.record(id);
      if (value) {
        p.checks[key] = true;
        (p.checkedBy ??= {})[key] = { by, at: Date.now() };
      } else {
        delete p.checks[key];
        if (p.checkedBy) delete p.checkedBy[key];
      }
      return p;
    });
  }

  // ---- an agent's changes (ticketTools.ts): each checked again here, as its one writer, and refused on a record not tracked ----

  /**
   * An agent's set_stage: the move with its `by`, and its gate notes. A move back to Coding keeps `note` as feedback
   * with who wrote it and drafts no comment, since the agent's words would be quoted to the ticket; one forward drafts
   * the stage's. `drafted`: whether it did; `ticked`: how many items its notes ticked.
   */
  agentMove(id: string, stage: TicketStage, o: { note?: string; by: string; report: readonly GateReport[] }): { pipeline: TicketPipeline; drafted: boolean; ticked: number } {
    return this.change(id, () => {
      const p = this.tracked(id);
      const why = stageRefusal(p.stage, stage, o.note);
      if (why) throw new Error(why);
      const back = goesBack(p.stage, stage);
      if (back && o.report.length) throw new Error("A move back clears the gates' ticks, so it takes no gate notes");
      if (back) p.feedback.push({ at: Date.now(), text: o.note!.trim(), by: o.by });
      const ticked = this.report(p, o.report, o.by);
      const drafts = p.drafts.length;
      this.move(p, stage, { note: o.note?.trim() || undefined, by: o.by, draft: back ? "none" : "plain" });
      return { pipeline: p, drafted: p.drafts.length > drafts, ticked };
    });
  }

  /** An agent's request_pr: held, replacing the request for the same target (`replaced`), with its gate notes (`ticked` of them ticking). */
  holdRequest(
    id: string,
    r: Omit<PipelineRequest, "id" | "at">,
    report: readonly GateReport[],
    by: string
  ): { pipeline: TicketPipeline; request: PipelineRequest; replaced: PipelineRequest | null; ticked: number } {
    return this.change(id, () => {
      const p = this.tracked(id);
      const why = requestRefusal(p.stage, r.target);
      if (why) throw new Error(why);
      const held = p.requests ?? [];
      const replaced = held.find((x) => x.target === r.target) ?? null;
      const request: PipelineRequest = { id: crypto.randomUUID(), ...r, at: Date.now() };
      p.requests = [...held.filter((x) => x.target !== r.target), request];
      const ticked = this.report(p, report, by);
      return { pipeline: p, request, replaced, ticked };
    });
  }

  /** The user dismissed request `requestId`: it goes, and what it was is returned so its agent can be told. */
  dropRequest(id: string, requestId: string): { pipeline: TicketPipeline; request: PipelineRequest } {
    return this.change(id, () => {
      const p = this.tracked(id);
      const request = p.requests?.find((x) => x.id === requestId);
      if (!request) throw new Error(`#${id} has no pull request request ${requestId} (it may have been answered or replaced)`);
      p.requests = p.requests!.filter((x) => x.id !== requestId);
      return { pipeline: p, request };
    });
  }

  /** An agent's write_patch_notes: the ticket's patch notes draft, marked as `by`'s, replacing every earlier agent's (`replaced` of them); the user's own stay. */
  agentPatchNotes(id: string, text: string, by: string): { pipeline: TicketPipeline; replaced: number } {
    return this.change(id, () => {
      const p = this.tracked(id);
      const why = patchNotesRefusal(p.stage);
      if (why) throw new Error(why);
      const before = p.drafts.length;
      p.drafts = p.drafts.filter((d) => !(d.stage === "comms" && d.by));
      const replaced = before - p.drafts.length;
      this.draft(p, "comms", text.trim() || null, by);
      return { pipeline: p, replaced };
    });
  }

  /** Save a draft for later (patch notes, or an edited stage comment). */
  addDraft(id: string, stage: TicketStage, text: string): TicketPipeline {
    if (!isTicketStage(stage)) throw new Error(`Unknown stage "${stage}"`);
    return this.change(id, () => {
      const p = this.record(id);
      this.draft(p, stage, text.trim() || null);
      return p;
    });
  }

  editDraft(id: string, draftId: string, text: string): TicketPipeline {
    return this.change(id, () => {
      this.findDraft(id, draftId).text = text;
      return this.data[id];
    });
  }

  dropDraft(id: string, draftId: string): TicketPipeline {
    return this.change(id, () => {
      this.findDraft(id, draftId);
      this.data[id].drafts = this.data[id].drafts.filter((d) => d.id !== draftId);
      return this.data[id];
    });
  }

  findDraft(id: string, draftId: string): CommentDraft {
    const d = this.data[id] ? this.record(id).drafts.find((x) => x.id === draftId) : undefined;
    if (!d) throw new Error(`No draft ${draftId} on #${id}`);
    return d;
  }
}
