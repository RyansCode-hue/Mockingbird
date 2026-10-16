/**
 * Suggestions: GitHub issues on Mockingbird's repository labelled
 * `suggestion`, filed and listed through the user's own `gh` (src/main/suggestions.ts).
 * What the popover shows, what it posts, and how an issue's state reads.
 */

export type SuggestionStatus = "open" | "roadmap" | "shipped" | "declined";

export const SUGGESTION_STATUS_LABEL: Record<SuggestionStatus, string> = {
  open: "Open",
  roadmap: "On the roadmap",
  shipped: "Shipped",
  declined: "Declined",
};

/** The labels suggestions use. Created on the repository only by its admin's install, with the first suggestion. */
export const SUGGESTION_LABELS = [
  { name: "suggestion", color: "c5def5", description: "Suggested from Mockingbird's What's new" },
  { name: "roadmap", color: "0e8a16", description: "A suggestion that's on the roadmap" },
  { name: "shipped", color: "5319e7", description: "A suggestion that shipped" },
] as const;

export const SUGGESTION_LABEL = SUGGESTION_LABELS[0].name;

export const TITLE_MAX = 120;
export const BODY_MAX = 4000;

/** Exactly what gets posted: the issue's title and body. */
export interface SuggestionDraft {
  title: string;
  body: string;
}

/** Where a suggestion would go, checked before the confirm step. */
export interface SuggestTarget {
  repo: string;
  /** The GitHub account gh is signed in as: the issue's author. */
  login: string;
  /**
   * The `suggestion` label: on the repository already ("existing"), created with this suggestion ("create", only
   * the repository admin's install), or left off ("none": `labelNote` says why).
   */
  labels: "existing" | "create" | "none";
  labelNote?: string;
}

export interface SuggestPosted {
  number: number;
  url: string;
  labelled: boolean;
  /** Something the user should know about how it was filed (left without a label, and why). */
  note?: string;
}

/** Why a suggestion can't be filed or listed — expected states, each with what to do about it. */
export interface SuggestProblem {
  problem: "gh-missing" | "signed-out" | "no-access" | "dev-build" | "failed";
  message: string;
  /** A command that fixes it, shown to copy. */
  fix?: string;
}

export interface Suggestion {
  number: number;
  title: string;
  url: string;
  status: SuggestionStatus;
  author: string;
  /** Filed by the account gh is signed in as. */
  mine: boolean;
  createdAt: string;
}

export interface SuggestionList {
  repo: string;
  login: string;
  items: Suggestion[];
  /** When it was read (ms): the list is cached briefly. */
  at: number;
}

export const isSuggestProblem = (r: unknown): r is SuggestProblem =>
  !!r && typeof r === "object" && typeof (r as SuggestProblem).problem === "string" && typeof (r as SuggestProblem).message === "string";

/** The title and body that will be posted, from the form; the body says which version it came from. */
export function composeSuggestion(title: string, description: string, version: string): SuggestionDraft {
  const t = title.replace(/\s+/g, " ").trim();
  const d = description.replace(/\r\n/g, "\n").trim();
  const footer = `Suggested from Mockingbird ${version || "(unknown version)"}.`;
  return { title: t, body: d ? `${d}\n\n---\n${footer}` : footer };
}

/** Why a draft can't be posted, or null when it can. */
export function draftProblem(d: SuggestionDraft): string | null {
  if (!d.title.trim()) return "Give the suggestion a title.";
  if (d.title.length > TITLE_MAX) return `Keep the title under ${TITLE_MAX} characters.`;
  if (d.body.length > BODY_MAX) return `Keep the description under ${BODY_MAX} characters.`;
  return null;
}

/** The suggestion as plain text, for "Copy suggestion" when it can't be filed. */
export function suggestionText(d: SuggestionDraft): string {
  return `${d.title}\n\n${d.body}`;
}

/** An issue as `gh issue list --json state,stateReason,labels` gives it. */
export interface IssueState {
  state: string;
  stateReason?: string | null;
  labels?: { name: string }[];
}

/**
 * Open; On the roadmap (open, labelled `roadmap`); Shipped (labelled `shipped`, or closed as completed — a
 * close with no reason is GitHub's default, completed); Declined (closed as not planned, or as a duplicate).
 */
export function suggestionStatus(issue: IssueState): SuggestionStatus {
  const labels = new Set((issue.labels ?? []).map((l) => l.name.toLowerCase()));
  if (labels.has("shipped")) return "shipped";
  if (issue.state.toUpperCase() === "CLOSED") {
    const reason = (issue.stateReason ?? "").toUpperCase();
    return reason === "NOT_PLANNED" || reason === "DUPLICATE" ? "declined" : "shipped";
  }
  return labels.has("roadmap") ? "roadmap" : "open";
}
