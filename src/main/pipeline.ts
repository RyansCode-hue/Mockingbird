import * as crypto from "crypto";
import { type CommentDraft, type PipelinePr, type TicketPipeline, type TicketStage, isTicketStage, stageStep } from "../shared/types";
import { readJsonOrSetAside, writeFileAtomic } from "./fileOps";

/**
 * The comment a stage drafts for the ticket's discussion, or null for a stage
 * worth no comment. Drafts are suggestions: nothing posts until the user does.
 * `back`: the ticket has been in development before, so reaching Coding again
 * doesn't say it has started.
 */
export function stageComment(stage: TicketStage, ctx: { pr?: PipelinePr; summary?: string; note?: string; back?: boolean }): string | null {
  const pr = ctx.pr ? `${ctx.pr.url}\n${ctx.pr.branch} → ${ctx.pr.base}` : "";
  const parts = (...xs: (string | undefined)[]) => xs.filter((x) => x && x.trim()).join("\n\n");
  switch (stage) {
    case "coding":
      if (ctx.note) return parts("Stakeholder feedback received; back in development to address it:", ctx.note);
      return ctx.back ? "Back in development." : "Development has started.";
    case "local-test":
      return "Development is done; testing locally.";
    case "pr-dev":
      return parts("Pull request to dev opened:", pr, ctx.summary);
    case "stakeholder":
      return "Deployed to dev/UAT and tested; ready for stakeholder testing.";
    case "approved":
      return "Approved in stakeholder testing.";
    case "pr-main":
      return parts("Pull request to main opened:", pr, ctx.summary);
    case "prod-test":
      return "Merged to main; testing in staging/production.";
    case "done":
      return "Done.";
    // BA and AI testing in dev/UAT say nothing; Patch notes' comment is the notes themselves, saved from the panel
    default:
      return null;
  }
}

/**
 * Each ticket's place in the delivery lifecycle, its pull requests, stakeholder
 * feedback, gate checklist and drafted comments. One JSON file, written whole
 * (write-then-rename) on every change.
 *
 * Records are kept as parsed and changed in place, never rebuilt, so what a
 * newer build wrote (a stage id or a field this one doesn't know) is written
 * back as it was. 1.6.0 does the same, which is why pipeline.json needs no
 * version or migration.
 */
export class PipelineStore {
  private data: Record<string, TicketPipeline>;

  constructor(private file: string) {
    this.data = this.load();
  }

  private load(): Record<string, TicketPipeline> {
    const raw = readJsonOrSetAside(this.file, {});
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, TicketPipeline>) : {};
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  all(): Record<string, TicketPipeline> {
    return this.data;
  }

  get(id: string): TicketPipeline | null {
    return this.data[id] ?? null;
  }

  private record(id: string, title?: string): TicketPipeline {
    const cur = this.data[id];
    if (cur) {
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

  /** Move a ticket to a stage, drafting that stage's comment. `by` is who moved it. Refuses an id this build doesn't know. */
  setStage(id: string, stage: TicketStage, o: { title?: string; note?: string; summary?: string; pr?: PipelinePr; by?: string } = {}): TicketPipeline {
    if (!isTicketStage(stage)) throw new Error(`Unknown stage "${stage}"`);
    const p = this.record(id, o.title);
    const back = p.history.some((h) => (stageStep(h.stage) ?? 0) >= 2);
    p.stage = stage;
    p.history.push({ at: Date.now(), stage, ...(o.note ? { note: o.note } : {}), ...(o.by ? { by: o.by } : {}) });
    this.draft(p, stage, stageComment(stage, { ...o, back }));
    this.save();
    return p;
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
    const p = this.record(id);
    p.feedback.push({ at: Date.now(), text: t });
    return this.setStage(id, "coding", { note: t, by });
  }

  /** A pull request was opened: record it and move to its stage. */
  addPr(id: string, pr: PipelinePr, title?: string, by?: string): TicketPipeline {
    const p = this.record(id, title);
    p.prs.push(pr);
    return this.setStage(id, pr.target === "dev" ? "pr-dev" : "pr-main", { pr, summary: pr.summary, by });
  }

  /** Tick or untick a gate item; a tick keeps who made it, an untick forgets it. */
  setCheck(id: string, key: string, value: boolean, by: string): TicketPipeline {
    const p = this.record(id);
    if (value) {
      p.checks[key] = true;
      (p.checkedBy ??= {})[key] = { by, at: Date.now() };
    } else {
      delete p.checks[key];
      if (p.checkedBy) delete p.checkedBy[key];
    }
    this.save();
    return p;
  }

  /** Save a draft for later (patch notes, or an edited stage comment). */
  addDraft(id: string, stage: TicketStage, text: string): TicketPipeline {
    if (!isTicketStage(stage)) throw new Error(`Unknown stage "${stage}"`);
    const p = this.record(id);
    this.draft(p, stage, text.trim() || null);
    this.save();
    return p;
  }

  editDraft(id: string, draftId: string, text: string): TicketPipeline {
    const d = this.findDraft(id, draftId);
    d.text = text;
    this.save();
    return this.data[id];
  }

  dropDraft(id: string, draftId: string): TicketPipeline {
    this.findDraft(id, draftId);
    this.data[id].drafts = this.data[id].drafts.filter((d) => d.id !== draftId);
    this.save();
    return this.data[id];
  }

  findDraft(id: string, draftId: string): CommentDraft {
    const d = this.data[id]?.drafts.find((x) => x.id === draftId);
    if (!d) throw new Error(`No draft ${draftId} on #${id}`);
    return d;
  }
}
