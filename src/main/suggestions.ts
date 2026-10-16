import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  SUGGESTION_LABEL,
  SUGGESTION_LABELS,
  draftProblem,
  suggestionStatus,
  type IssueState,
  type SuggestPosted,
  type SuggestProblem,
  type SuggestTarget,
  type Suggestion,
  type SuggestionDraft,
  type SuggestionList,
} from "../shared/suggestions";

/**
 * Suggestions as GitHub issues on Mockingbird's repository, through the
 * user's own `gh` and its sign-in: nothing here holds a token. Expected states
 * (gh missing, signed out, no access) come back as a SuggestProblem the
 * popover explains; anything else throws and reaches the window as { error }.
 */

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SuggestDeps {
  /** The gh binary, or null when it isn't installed. */
  findGh: () => Promise<string | null>;
  /** The repository suggestions go to. */
  repo: () => { owner: string; repo: string } | null;
  /** False in a development build: it lists, but never files an issue or creates a label. */
  canPost: boolean;
  run?: (bin: string, args: string[], input?: string) => Promise<GhResult>;
  now?: () => number;
}

/** How long a read list is reused before gh is asked again. */
export const LIST_TTL_MS = 60_000;

const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

/** Run gh with arguments (no shell, so nothing in a title is interpreted); never rejects. */
export function runGh(bin: string, args: string[], input?: string): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...GH_ENV } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && !stdout ? err.message : "") });
    });
    child.stdin?.on("error", () => {}); // gh may exit before reading its input; the result says why
    child.stdin?.end(input ?? "");
  });
}

/** gh in one of `pathVar`'s folders, or null. */
export function findGhOnPath(pathVar: string | undefined): string | null {
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const bin = path.join(dir, "gh");
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      if (fs.statSync(bin).isFile()) return bin;
    } catch {
      /* not in this folder */
    }
  }
  return null;
}

const outOf = (r: GhResult) => `${r.stderr}\n${r.stdout}`.trim();

/** What a failed gh run means for the user. */
export function ghProblem(r: GhResult, repo: string): SuggestProblem {
  const out = outOf(r);
  if (/not logged in|gh auth login|authentication required|HTTP 401|bad credentials/i.test(out)) return signedOut();
  if (/could not resolve to a repository|HTTP 404|HTTP 403(?![\s\S]*rate limit)|resource not accessible/i.test(out)) {
    return { problem: "no-access", message: `Your GitHub account can't see ${repo}. Ask the repository's owner for access, or copy the suggestion and send it another way.` };
  }
  return { problem: "failed", message: `gh: ${out.slice(0, 300) || `exited with code ${r.code}`}` };
}

const signedOut = (): SuggestProblem => ({
  problem: "signed-out",
  message: "The GitHub CLI isn't signed in to GitHub, so Mockingbird can't file or list suggestions.",
  fix: "gh auth login",
});

const ghMissing = (): SuggestProblem => ({
  problem: "gh-missing",
  message: "The GitHub CLI (gh) isn't installed, so Mockingbird can't file or list suggestions.",
  fix: "brew install gh && gh auth login",
});

/** Who gh is signed in as, and where suggestions go; or why that can't be known. */
type Session = { gh: string; repo: string; login: string };

export class Suggestions {
  private cache: SuggestionList | null = null;
  private readonly run: NonNullable<SuggestDeps["run"]>;
  private readonly now: () => number;

  constructor(private readonly deps: SuggestDeps) {
    this.run = deps.run ?? runGh;
    this.now = deps.now ?? Date.now;
  }

  private async session(): Promise<Session | SuggestProblem> {
    const r = this.deps.repo();
    if (!r) throw new Error("This build doesn't name its GitHub repository, so it has nowhere to file suggestions.");
    const repo = `${r.owner}/${r.repo}`;
    const gh = await this.deps.findGh();
    if (!gh) return ghMissing();
    const auth = await this.run(gh, ["auth", "status", "--hostname", "github.com"]);
    if (auth.code !== 0) return /not logged in|gh auth login/i.test(outOf(auth)) || !outOf(auth) ? signedOut() : ghProblem(auth, repo);
    const user = await this.run(gh, ["api", "user", "--jq", ".login"]);
    if (user.code !== 0) return ghProblem(user, repo);
    const login = user.stdout.trim();
    if (!login) throw new Error("gh answered without the signed-in account's name");
    return { gh, repo, login };
  }

  /** Where a suggestion would go and how it would be labelled, for the confirm step. */
  async prepare(): Promise<SuggestTarget | SuggestProblem> {
    const t = await this.target();
    if ("problem" in t) return t;
    const { gh: _gh, ...target } = t;
    return target;
  }

  private async target(): Promise<(SuggestTarget & { gh: string }) | SuggestProblem> {
    const s = await this.session();
    if ("problem" in s) return s;
    const view = await this.run(s.gh, ["repo", "view", s.repo, "--json", "viewerPermission,hasIssuesEnabled"]);
    if (view.code !== 0) return ghProblem(view, s.repo);
    let info: { viewerPermission?: string; hasIssuesEnabled?: boolean };
    try {
      info = JSON.parse(view.stdout);
    } catch {
      throw new Error(`gh repo view answered something other than JSON: ${view.stdout.slice(0, 200)}`);
    }
    if (info.hasIssuesEnabled === false) return { problem: "failed", message: `Issues are turned off on ${s.repo}, so suggestions can't be filed there.` };
    const permission = String(info.viewerPermission ?? "").toUpperCase();
    const base = { gh: s.gh, repo: s.repo, login: s.login };
    if (!["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"].includes(permission)) {
      return { ...base, labels: "none", labelNote: `Your access to ${s.repo} can't set labels, so it's filed without the ${SUGGESTION_LABEL} label.` };
    }
    const list = await this.run(s.gh, ["label", "list", "--repo", s.repo, "--json", "name", "--limit", "200"]);
    if (list.code !== 0) return ghProblem(list, s.repo);
    let names: string[];
    try {
      names = (JSON.parse(list.stdout) as { name: string }[]).map((l) => l.name.toLowerCase());
    } catch {
      throw new Error(`gh label list answered something other than JSON: ${list.stdout.slice(0, 200)}`);
    }
    if (names.includes(SUGGESTION_LABEL)) return { ...base, labels: "existing" };
    if (permission === "ADMIN") return { ...base, labels: "create" };
    return { ...base, labels: "none", labelNote: `${s.repo} has no ${SUGGESTION_LABEL} label yet, so it's filed without one.` };
  }

  /** Files the draft exactly as given. */
  async post(draft: SuggestionDraft): Promise<SuggestPosted | SuggestProblem> {
    const bad = draftProblem(draft);
    if (bad) throw new Error(bad);
    if (!this.deps.canPost) {
      return { problem: "dev-build", message: "This is a development build of Mockingbird, so it doesn't file suggestions on GitHub. Use the installed app, or copy the suggestion." };
    }
    const target = await this.target();
    if ("problem" in target) return target;
    const { gh } = target;
    let label = target.labels !== "none";
    let note = target.labelNote;
    if (target.labels === "create") {
      for (const l of SUGGESTION_LABELS) {
        const r = await this.run(gh, ["label", "create", l.name, "--repo", target.repo, "--color", l.color, "--description", l.description]);
        if (r.code !== 0 && !/already exists/i.test(outOf(r))) {
          console.warn(`[suggestions] couldn't create the ${l.name} label on ${target.repo}: ${outOf(r)}`);
          if (l.name === SUGGESTION_LABEL) {
            label = false;
            note = `The ${SUGGESTION_LABEL} label couldn't be created (${outOf(r).slice(0, 160)}), so it was filed without one.`;
          }
        }
      }
    }
    const args = ["issue", "create", "--repo", target.repo, "--title", draft.title, "--body-file", "-"];
    let r = await this.run(gh, label ? [...args, "--label", SUGGESTION_LABEL] : args, draft.body);
    if (r.code !== 0 && label && /label/i.test(outOf(r))) {
      console.warn(`[suggestions] filing with the ${SUGGESTION_LABEL} label failed, filing without it: ${outOf(r)}`);
      label = false;
      note = `GitHub refused the ${SUGGESTION_LABEL} label, so it was filed without one.`;
      r = await this.run(gh, args, draft.body);
    }
    if (r.code !== 0) return ghProblem(r, target.repo);
    const url = r.stdout.trim().split("\n").pop()?.trim() ?? "";
    const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
    if (!number) throw new Error(`gh filed the issue but didn't say where (${url.slice(0, 200) || "no output"})`);
    this.cache = null;
    return { number, url, labelled: label, ...(note ? { note } : {}) };
  }

  /** Every suggestion on the repository, the signed-in account's marked; cached for a minute unless `fresh`. */
  async list(fresh = false): Promise<SuggestionList | SuggestProblem> {
    if (!fresh && this.cache && this.now() - this.cache.at < LIST_TTL_MS) return this.cache;
    const s = await this.session();
    if ("problem" in s) return s;
    const r = await this.run(s.gh, [
      "issue",
      "list",
      "--repo",
      s.repo,
      "--label",
      SUGGESTION_LABEL,
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,title,url,state,stateReason,labels,author,createdAt",
    ]);
    if (r.code !== 0) return ghProblem(r, s.repo);
    let issues: (IssueState & { number: number; title: string; url: string; author?: { login?: string }; createdAt: string })[];
    try {
      issues = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh issue list answered something other than JSON: ${r.stdout.slice(0, 200)}`);
    }
    const items: Suggestion[] = issues.map((i) => ({
      number: i.number,
      title: i.title,
      url: i.url,
      status: suggestionStatus(i),
      author: i.author?.login ?? "",
      mine: !!i.author?.login && i.author.login.toLowerCase() === s.login.toLowerCase(),
      createdAt: i.createdAt,
    }));
    this.cache = { repo: s.repo, login: s.login, items, at: this.now() };
    return this.cache;
  }
}
