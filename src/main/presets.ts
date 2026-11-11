import type { NewSessionRequest, SessionPreset } from "../shared/types";

const pad = (n: number) => String(n).padStart(2, "0");

/** A branch name from a preset's pattern: {date} → YYYYMMDD, {time} → HHMM, anything else kept. */
export function expandBranchPattern(pattern: string, now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return pattern
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[~^:?*\[\\]+/g, "-");
}

/** `name`, or `name-2`, `name-3`… when a branch by that name exists locally or on origin. */
export function uniqueBranch(name: string, existing: string[]): string {
  const taken = new Set(existing.map((b) => b.replace(/^origin\//, "")));
  if (!taken.has(name)) return name;
  let i = 2;
  while (taken.has(`${name}-${i}`)) i++;
  return `${name}-${i}`;
}

/** Why a preset can't start, or null when it's complete. */
export function presetProblem(p: SessionPreset): string | null {
  if (!p.name?.trim()) return "The preset needs a name";
  if (!["claude", "codex", "shell"].includes(p.launch)) return `Unknown launch "${p.launch}"`;
  if (p.role === "tasks" && p.launch !== "claude") return "The Helpdesk tasks workspace runs Claude only";
  if (p.branch.mode !== "checkout" && !p.repoPath) return "A branch needs a repo";
  if (p.branch.mode === "existing" && !p.branch.name.trim()) return "Name the branch to open";
  if (p.branch.mode === "new" && !expandBranchPattern(p.branch.pattern, new Date())) return "Give the new branch a name pattern";
  return null;
}

/** The session a preset starts. `branches` are the repo's local and origin branches, for a unique new name. */
export function presetRequest(p: SessionPreset, branches: string[], now: Date): NewSessionRequest {
  const problem = presetProblem(p);
  if (problem) throw new Error(problem);
  const agent = p.launch !== "shell";
  const req: NewSessionRequest = {
    repoPath: p.repoPath,
    // the checkout as it is never gets a worktree: there'd be no branch to put in it
    useWorktree: !!p.repoPath && p.branch.mode !== "checkout" && p.useWorktree,
    title: p.name.trim(),
    ...(p.group?.trim() ? { taskGroup: p.group.trim() } : {}),
    ...(agent ? { agent: p.launch as "claude" | "codex" } : { shell: true }),
    ...(agent && p.model?.trim() ? { model: p.model.trim() } : {}),
    ...(agent && p.effort?.trim() ? { effort: p.effort.trim() } : {}),
    ...(p.kickoff?.trim() ? { initialPrompt: p.kickoff.trim() } : {}),
    ...(p.role ? { role: p.role } : {}),
  };
  if (p.branch.mode === "existing") req.branchName = p.branch.name.trim();
  if (p.branch.mode === "new") {
    req.branchName = uniqueBranch(expandBranchPattern(p.branch.pattern, now), branches);
    if (p.branch.base?.trim()) req.baseBranch = p.branch.base.trim();
  }
  return req;
}
