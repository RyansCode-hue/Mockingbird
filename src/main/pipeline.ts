import * as crypto from "crypto";
import { type CommentDraft, type PipelinePr, type TicketPipeline, type TicketStage, clearGateTicks, clearsGates, isTicketStage, stageStep } from "../shared/types";
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

const LISTS = ["history", "prs", "feedback", "drafts"] as const;
const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Why a record can't be changed safely, or null. Checked before any change, so a refusal leaves it as it was. */
function shapeProblem(p: TicketPipeline): string | null {
  if (!isMap(p)) return "it isn't an object";
  for (const k of LISTS) if (!Array.isArray(p[k])) return `its ${k} isn't a list`;
  if (!isMap(p.checks)) return "its checks aren't a map";
  if (p.checkedBy != null && !isMap(p.checkedBy)) return "its checkedBy isn't a map";
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

  private draft(p: TicketPipeline, stage: TicketStage, text: string | null): void {
    if (!text) return;
    const d: CommentDraft = { id: crypto.randomUUID(), stage, text, at: Date.now() };
    p.drafts.push(d);
  }

  /**
   * Move a record to `stage`: its history entry and drafted comment, and, back
   * at Coding, the gates' ticks cleared, which the entry's note says.
   */
  private move(p: TicketPipeline, stage: TicketStage, o: { note?: string; summary?: string; pr?: PipelinePr; by?: string }): TicketPipeline {
    const back = p.history.some((h) => (stageStep(h.stage) ?? 0) >= 2);
    const cleared = clearsGates(p.stage, stage) ? clearGateTicks(p) : null;
    const note = [o.note, cleared].filter(Boolean).join("\n\n");
    p.stage = stage;
    p.history.push({ at: Date.now(), stage, ...(note ? { note } : {}), ...(o.by ? { by: o.by } : {}) });
    this.draft(p, stage, stageComment(stage, { ...o, back }));
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

  /** A pull request was opened: record it and move to its stage. */
  addPr(id: string, pr: PipelinePr, title?: string, by?: string): TicketPipeline {
    return this.change(id, () => {
      const p = this.record(id, title);
      p.prs.push(pr);
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
