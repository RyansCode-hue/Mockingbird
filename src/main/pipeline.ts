import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { type CommentDraft, type PipelinePr, type TicketPipeline, type TicketStage, TICKET_STAGES } from "../shared/types";

/**
 * The comment a stage drafts for the ticket's discussion, or null for a stage
 * worth no comment. Drafts are suggestions: nothing posts until the user does.
 */
export function stageComment(stage: TicketStage, ctx: { pr?: PipelinePr; summary?: string; note?: string }): string | null {
  const pr = ctx.pr ? `${ctx.pr.url}\n${ctx.pr.branch} → ${ctx.pr.base}` : "";
  const parts = (...xs: (string | undefined)[]) => xs.filter((x) => x && x.trim()).join("\n\n");
  switch (stage) {
    case "coding":
      return "Development has started.";
    case "local-test":
      return ctx.note ? parts("Stakeholder feedback received; back in local testing to address it:", ctx.note) : "Development is done; testing locally.";
    case "pr-dev":
      return parts("Pull request to dev opened:", pr, ctx.summary);
    case "stakeholder":
      return "Deployed to dev/UAT and ready for stakeholder testing.";
    case "approved":
      return "Approved in stakeholder testing.";
    case "pr-main":
      return parts("Pull request to main opened:", pr, ctx.summary);
    case "prod-test":
      return "Merged and in staging/production testing.";
    case "done":
      return "Done.";
    default:
      return null;
  }
}

const isStage = (s: unknown): s is TicketStage => TICKET_STAGES.some((x) => x.id === s);

/**
 * Each ticket's place in the delivery lifecycle, its pull requests, stakeholder
 * feedback, gate checklist and drafted comments. One JSON file, written whole
 * (write-then-rename) on every change.
 */
export class PipelineStore {
  private data: Record<string, TicketPipeline>;

  constructor(private file: string) {
    this.data = this.load();
  }

  private load(): Record<string, TicketPipeline> {
    if (!fs.existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch (err) {
      // keep an unreadable file aside rather than overwrite it with the next save
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`[mockingbird] ${this.file} was unreadable (${(err as Error).message}); moved to ${backup}.`);
      return {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
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

  /** Move a ticket to a stage, drafting that stage's comment. */
  setStage(id: string, stage: TicketStage, o: { title?: string; note?: string; summary?: string; pr?: PipelinePr } = {}): TicketPipeline {
    if (!isStage(stage)) throw new Error(`Unknown stage "${stage}"`);
    const p = this.record(id, o.title);
    p.stage = stage;
    p.history.push({ at: Date.now(), stage, ...(o.note ? { note: o.note } : {}) });
    this.draft(p, stage, stageComment(stage, o));
    this.save();
    return p;
  }

  /** A ticket starts at Coding when a session is opened on it, unless it's already further along. */
  startCoding(id: string, title?: string): TicketPipeline | null {
    const p = this.data[id];
    if (p && p.stage !== "ba") return null;
    return this.setStage(id, "coding", { title });
  }

  /** Stakeholder feedback loops the ticket back to local testing. */
  addFeedback(id: string, text: string): TicketPipeline {
    const t = text.trim();
    if (!t) throw new Error("The feedback is empty");
    const p = this.record(id);
    p.feedback.push({ at: Date.now(), text: t });
    return this.setStage(id, "local-test", { note: t });
  }

  /** A pull request was opened: record it and move to its stage. */
  addPr(id: string, pr: PipelinePr, title?: string): TicketPipeline {
    const p = this.record(id, title);
    p.prs.push(pr);
    return this.setStage(id, pr.target === "dev" ? "pr-dev" : "pr-main", { pr, summary: pr.summary });
  }

  setCheck(id: string, key: string, value: boolean): TicketPipeline {
    const p = this.record(id);
    if (value) p.checks[key] = true;
    else delete p.checks[key];
    this.save();
    return p;
  }

  /** Save a draft for later (comms text, or an edited stage comment). */
  addDraft(id: string, stage: TicketStage, text: string): TicketPipeline {
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

