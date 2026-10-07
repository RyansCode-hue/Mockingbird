/**
 * Team rooms: the plan and claims board (docs/team-rooms.md, "Plan and claims
 * board"). The room log is the truth: each change is a room event, reduced
 * into `room.ext.plan`; Mockingbird renders that state to plan.md and
 * claims.json on the branch mockingbird/plan and into every worktree of the
 * room's repo (read-only, git-ignored).
 *
 * Plain code with no Node or Electron APIs: the window, the main process and
 * the generated hook script (which embeds claimConflicts, editedPaths and
 * claimHookResponse by their source) all use it.
 */
import type { MemberId, RoomId } from "./types";

export type PackageStatus = "open" | "claimed" | "in-progress" | "blocked" | "done";
export const PACKAGE_STATUSES: PackageStatus[] = ["open", "claimed", "in-progress", "blocked", "done"];
export const STATUS_LABEL: Record<PackageStatus, string> = { open: "open", claimed: "claimed", "in-progress": "in progress", blocked: "blocked", done: "done" };
/** Statuses whose owned paths are claimed: a teammate's edit there is warned. */
export const ACTIVE_STATUSES: PackageStatus[] = ["claimed", "in-progress", "blocked"];

/** A work package: what it owns, the contracts it provides and uses, how it's tested, and who has it. */
export interface WorkPackage {
  /** "p-" and 4–24 lowercase letters or digits, chosen by its creator. */
  id: string;
  title: string;
  description: string;
  /** The member who claimed it. */
  owner: MemberId | null;
  status: PackageStatus;
  /** Why it's blocked, or a note with the last status change. */
  statusNote: string;
  /** Repo-relative folders, files or globs (`**` any depth, `*` within a folder): a folder owns everything under it. */
  paths: string[];
  /** Contracts this package provides to others (free text, file references). */
  provides: string;
  /** Contracts it relies on. */
  uses: string;
  /** How it's tested. */
  tests: string;
  createdBy: MemberId;
  createdAt: number;
  updatedBy: MemberId;
  updatedAt: number;
}

/** One change to the board, for "who changed what". */
export interface PlanChange {
  at: number;
  by: MemberId;
  /** The agent session that made it for its member, when one did. */
  via?: string;
  kind: "created" | "edited" | "claimed" | "released" | "status" | "removed" | "repo";
  pkg?: string;
  title?: string;
  fields?: string[];
  status?: PackageStatus;
  note?: string;
  /** For a claim: who it was claimed for (when not the author). */
  owner?: MemberId;
  repo?: string;
}

export interface PlanRepo {
  /** origin's URL as the member who chose it has it; members match their clones by it (not by path). */
  origin: string;
  name: string;
}

/** The board, as every member reduces it from the room log. */
export interface PlanState {
  repo: PlanRepo | null;
  packages: WorkPackage[];
  /** Newest last, the last MAX_CHANGES. */
  changes: PlanChange[];
  /** Ids of removed packages: an edit ordered after the removal doesn't bring one back. */
  removed: string[];
  /** The newest board event's author time: what the rendered files are dated by (so every member renders the same bytes). */
  updatedAt: number;
}

/** The branches each member works on in the room's repo (announced by each member's Mockingbird). */
export interface MemberBranches {
  origin: string;
  branches: string[];
  at: number;
}

export const MAX_CHANGES = 60;
export const PLAN_BRANCH = "mockingbird/plan";
/** Where each worktree of the room's repo gets its read-only copy (git-ignored through .git/info/exclude). */
export const PLAN_DIR = ".mockingbird";
export const PLAN_FILE = `${PLAN_DIR}/plan.md`;
export const CLAIMS_FILE = `${PLAN_DIR}/claims.json`;
export const AGENT_CONTEXT_FILE = `${PLAN_DIR}/agent-context.md`;
/** The Mockingbird MCP tool agents change the board with. Codex has its own update_plan, so not that. */
export const PLAN_TOOL = "update_team_plan";
/** Set in a session's environment when its launch already carries roomAgentContext: the SessionStart hook then adds nothing. */
export const PLAN_CONTEXT_ENV = "MOCKINGBIRD_PLAN_CONTEXT";

export const PACKAGE_ID_RE = /^p-[a-z0-9]{4,24}$/;
export const LIMITS = { title: 200, description: 8000, contract: 4000, note: 500, path: 300, paths: 100, via: 200, branch: 250, branches: 50, origin: 1000 };

export const emptyPlan = (): PlanState => ({ repo: null, packages: [], changes: [], removed: [], updatedAt: 0 });

/** An owned path as stored: forward slashes, no leading "./" or "/", no trailing "/". */
export const normalizeOwnedPath = (p: string): string =>
  p
    .trim()
    .split("\\")
    .join("/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");

// ---- event bodies --------------------------------------------------------------------

/** Fields a package is created or edited with; on an edit, only those present change. */
export interface PackageFields {
  title?: string;
  description?: string;
  paths?: string[];
  provides?: string;
  uses?: string;
  tests?: string;
}

declare module "./types" {
  interface RoomEventBodies {
    /** Create a package (an unknown id; title required) or edit one (only the fields given change). */
    "plan.package": PackageFields & { id: string; via?: string };
    /** Claim a package for a member, or release it (owner null). */
    "plan.claim": { id: string; owner: MemberId | null; via?: string };
    "plan.status": { id: string; status: PackageStatus; note?: string; via?: string };
    "plan.remove": { id: string; via?: string };
    /** The repo whose mockingbird/plan branch holds the board. */
    "plan.repo": PlanRepo;
    /** The author's branches in the room's repo, replacing what it announced before. */
    "plan.branches": { origin: string; branches: string[] };
  }
  interface RoomExtensions {
    plan: PlanState;
    memberBranches: Record<MemberId, MemberBranches>;
  }
}

// ---- operations: what the window and the agents' tool ask for -----------------------------

export type PlanOp =
  | ({ kind: "create" } & PackageFields & { title: string })
  | ({ kind: "edit"; id: string } & PackageFields)
  | { kind: "claim"; id: string; owner?: MemberId }
  | { kind: "release"; id: string }
  | { kind: "status"; id: string; status: PackageStatus; note?: string }
  | { kind: "remove"; id: string }
  | { kind: "repo"; origin: string; name: string };

/** A teammate's claim that an edit ran into. */
export interface ClaimHit {
  roomId: RoomId;
  room: string;
  pkg: string;
  title: string;
  status: PackageStatus;
  owner: { id: MemberId; name: string };
  /** The owned path the file matched. */
  pattern: string;
}

/** The machine-readable claims block: claims.json on the branch (one room) and in each worktree (every room bound to the repo). */
export interface ClaimsFile {
  mockingbird: "plan-claims/1";
  /** Whose checkout this copy is in (worktree copies only): that member's own claims never warn. */
  self?: MemberId;
  rooms: {
    roomId: RoomId;
    room: string;
    updatedAt: string;
    packages: { id: string; title: string; status: PackageStatus; owner: { id: MemberId; name: string } | null; paths: string[] }[];
  }[];
}

/** A claim warning, as the hook script leaves it for the app (event "ClaimWarning"). */
export interface ClaimWarning {
  /** The pane the agent runs in (MOCKINGBIRD_SESSION), when Mockingbird started it. */
  pane: string;
  cwd: string;
  conversation: string;
  tool: string;
  /** deny: the first edit of these files in this conversation was held back · context: a repeat, let through with a reminder. */
  decision: "deny" | "context";
  conflicts: { file: string; root: string; hits: ClaimHit[] }[];
}

// ---- claims ------------------------------------------------------------------------------

/**
 * Teammates' active claims on `rel` (a path relative to the checkout the
 * claims file is in). A pattern without wildcards owns that path and
 * everything under it; `*` matches within one folder, `**` across folders.
 *
 * Self-contained (no outside references): the hook script embeds its source.
 */
export function claimConflicts(file: ClaimsFile, rel: string): ClaimHit[] {
  const norm = (p: string) =>
    String(p)
      .split("\\")
      .join("/")
      .replace(/^(\.\/)+/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  const toRe = (glob: string) => {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*" && glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}(?:/.*)?$`);
  };
  const target = norm(rel);
  if (!target || target === ".." || target.startsWith("../")) return [];
  const hits: ClaimHit[] = [];
  for (const room of file?.rooms ?? []) {
    for (const p of room.packages ?? []) {
      if (!p.owner || p.owner.id === file.self || !["claimed", "in-progress", "blocked"].includes(p.status)) continue;
      const pattern = (p.paths ?? []).find((pat) => {
        const n = norm(pat);
        return !!n && toRe(n).test(target);
      });
      if (pattern) hits.push({ roomId: room.roomId, room: room.room, pkg: p.id, title: p.title, status: p.status, owner: p.owner, pattern });
    }
  }
  return hits;
}

/**
 * The files an agent's edit tool call writes, absolute. Claude Code's Edit,
 * Write and MultiEdit name `file_path`, NotebookEdit `notebook_path`; Codex's
 * apply_patch carries the patch in `command`, naming each file it adds,
 * updates, deletes or moves to. Relative paths are taken from `cwd`.
 *
 * Self-contained: the hook script embeds its source.
 */
export function editedPaths(tool: string, input: any, cwd: string): string[] {
  const abs = (p: string) => (p.startsWith("/") ? p : `${cwd.replace(/\/+$/, "")}/${p.replace(/^(\.\/)+/, "")}`);
  const out: string[] = [];
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    if (typeof input?.file_path === "string" && input.file_path) out.push(abs(input.file_path));
  } else if (tool === "NotebookEdit") {
    if (typeof input?.notebook_path === "string" && input.notebook_path) out.push(abs(input.notebook_path));
  } else if (tool === "apply_patch") {
    const text = typeof input?.command === "string" ? input.command : typeof input?.patch === "string" ? input.patch : typeof input?.input === "string" ? input.input : "";
    const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(abs(m[1]));
  }
  return out.filter((p, i) => out.indexOf(p) === i);
}

/**
 * What the PreToolUse hook answers Claude Code or Codex (the same shape works
 * for both). The first edit of a teammate's claimed file in a conversation is
 * held back (deny), with the reason for the agent and a warning line for the
 * user; repeating it goes through the normal permission flow with a reminder
 * (additionalContext). See src/main/hooks.ts for why.
 *
 * Self-contained: the hook script embeds its source.
 */
export function claimHookResponse(conflicts: { file: string; hits: ClaimHit[] }[], first: boolean): object {
  const STATUS: Record<string, string> = { claimed: "claimed", "in-progress": "in progress", blocked: "blocked", done: "done", open: "open" };
  const lines = conflicts.map((c) => {
    const who = c.hits.map((h) => `${h.owner.name}'s package "${h.title}" (${h.pkg}, ${STATUS[h.status] ?? h.status})`).join(" and ");
    return `${c.file} is owned by ${who} on the team plan`;
  });
  const owners = [...new Set(conflicts.flatMap((c) => c.hits.map((h) => h.owner.name)))].join(" and ");
  if (first) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Mockingbird held this edit back once: ${lines.join("; ")}. Editing it may collide with ${owners}'s work — ` +
          "check the plan (.mockingbird/plan.md: owned paths, provides/uses) and with your user before changing it. " +
          "If the edit is still needed, make the same edit again: Mockingbird won't stop edits to this file again in this conversation. " +
          "Don't edit the plan files; change the board with the mockingbird update_team_plan tool.",
      },
      systemMessage: `Mockingbird: ${lines.join("; ")}. The agent was warned and held back once; it can repeat the edit to go ahead.`,
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `Reminder from Mockingbird: ${lines.join("; ")}. Tell your user you changed it, so ${owners} hears about it.`,
    },
  };
}

// ---- rendering ---------------------------------------------------------------------------

const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "—");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** "Nick claimed Donor API", for the history and the plan file. */
export function describeChange(c: PlanChange, nameOf: (id: MemberId) => string): string {
  const who = nameOf(c.by) + (c.via ? ` (agent: ${c.via})` : "");
  const what = c.title ? `"${c.title}"` : c.pkg ?? "a package";
  switch (c.kind) {
    case "created":
      return `${who} created ${what}`;
    case "edited":
      return `${who} edited ${what}${c.fields?.length ? ` (${c.fields.join(", ")})` : ""}`;
    case "claimed":
      return c.owner && c.owner !== c.by ? `${who} assigned ${what} to ${nameOf(c.owner)}` : `${who} claimed ${what}`;
    case "released":
      return `${who} released ${what}`;
    case "status":
      return `${who} marked ${what} ${STATUS_LABEL[c.status ?? "open"]}${c.note ? `: ${c.note}` : ""}`;
    case "removed":
      return `${who} removed ${what}`;
    case "repo":
      return `${who} chose ${c.repo ?? "a repo"} to keep the plan in`;
  }
}

/** The member's name in the room, or a short id. */
export const memberName = (members: { id: MemberId; name: string }[], id: MemberId | null | undefined): string => (id ? members.find((m) => m.id === id)?.name ?? id.slice(0, 8) : "nobody");

/**
 * plan.md: the board for people and agents. A function of the room state
 * alone (dated by its newest event, never the clock), so every member renders
 * the same bytes from the same log.
 */
export function renderPlanMarkdown(room: { id: RoomId; name: string; members: { id: MemberId; name: string }[] }, plan: PlanState): string {
  const name = (id: MemberId | null) => memberName(room.members, id);
  const out: string[] = [];
  out.push(`# Plan — ${room.name}`, "");
  out.push(
    "This board belongs to a Mockingbird team room. Mockingbird writes this file from the room's log on every change and commits it to the `mockingbird/plan` branch; edits made here are overwritten. Change the board in Mockingbird — agents use the `update_team_plan` tool of the mockingbird MCP server.",
    ""
  );
  out.push(`Updated ${iso(plan.updatedAt)} · ${plan.packages.length} package${plan.packages.length === 1 ? "" : "s"}${plan.repo ? ` · repo ${plan.repo.name}` : ""}`, "");
  if (!plan.packages.length) {
    out.push("No work packages yet.", "");
  } else {
    out.push("| Package | Status | Owner | Owns |", "| --- | --- | --- | --- |");
    for (const p of plan.packages) {
      out.push(`| ${cell(p.title)} (${p.id}) | ${STATUS_LABEL[p.status]} | ${cell(p.owner ? name(p.owner) : "—")} | ${p.paths.length ? p.paths.map((x) => cell(code(x))).join(", ") : "—"} |`);
    }
    out.push("");
    for (const p of plan.packages) {
      out.push(`## ${p.title}`, "");
      out.push(`- **Id:** ${p.id}`);
      out.push(`- **Status:** ${STATUS_LABEL[p.status]}${p.statusNote ? ` — ${p.statusNote}` : ""}`);
      out.push(`- **Owner:** ${p.owner ? name(p.owner) : "unclaimed"}`);
      out.push(`- **Owns:** ${p.paths.length ? p.paths.map(code).join(", ") : "—"}`);
      if (p.provides.trim()) out.push(`- **Provides:** ${p.provides.trim().replace(/\n/g, "\n  ")}`);
      if (p.uses.trim()) out.push(`- **Uses:** ${p.uses.trim().replace(/\n/g, "\n  ")}`);
      if (p.tests.trim()) out.push(`- **Tested by:** ${p.tests.trim().replace(/\n/g, "\n  ")}`);
      out.push("");
      if (p.description.trim()) out.push(p.description.trim(), "");
    }
  }
  if (plan.changes.length) {
    out.push("## Recent changes", "");
    for (const c of [...plan.changes].reverse().slice(0, 20)) out.push(`- ${iso(c.at)} — ${describeChange(c, name)}`);
    out.push("");
  }
  return out.join("\n");
}

/** One room's part of a claims file. */
export function claimsRoom(room: { id: RoomId; name: string; members: { id: MemberId; name: string }[] }, plan: PlanState): ClaimsFile["rooms"][number] {
  return {
    roomId: room.id,
    room: room.name,
    updatedAt: iso(plan.updatedAt),
    packages: plan.packages.map((p) => ({ id: p.id, title: p.title, status: p.status, owner: p.owner ? { id: p.owner, name: memberName(room.members, p.owner) } : null, paths: p.paths })),
  };
}

export const claimsFile = (rooms: ClaimsFile["rooms"], self?: MemberId): ClaimsFile => ({ mockingbird: "plan-claims/1", ...(self ? { self } : {}), rooms });

/** A new package id. */
export function newPackageId(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)];
  return `p-${s}`;
}

// ---- what the window shows ----------------------------------------------------------------

export interface PlanGitStatus {
  repo: PlanRepo | null;
  /** This install's clones of the plan's repo (main checkouts). */
  clones: string[];
  /** unbound: no repo chosen · no-clone: none here · pending: a commit is waiting · synced · error: see problem */
  state: "unbound" | "no-clone" | "pending" | "syncing" | "synced" | "error";
  /** The newest commit of mockingbird/plan this install made or found current, and when. */
  commit?: { sha: string; at: number; pushed: boolean };
  problem?: string;
  /** Worktrees holding a current read-only copy. */
  copies: number;
}

/** A teammate's pushed branch and the files it changes against its base. */
export interface TeammateBranch {
  member: MemberId;
  name: string;
  branch: string;
  /** The local clone it was fetched into. */
  repo: string;
  files: string[];
  /** Why its files couldn't be read (not pushed yet, no base…). */
  problem?: string;
}

export interface PlanView {
  roomId: RoomId;
  room: string;
  self: MemberId;
  members: { id: MemberId; name: string; self: boolean; online: boolean }[];
  plan: PlanState;
  git: PlanGitStatus;
  teammates: TeammateBranch[];
  /** When teammates' branches were last fetched (0: never), and why it failed. */
  fetchedAt: number;
  fetchProblem?: string;
}

/** A claim warning (or the claims check's failure), as the window shows it. */
export interface PlanWarningNotice {
  at: number;
  sessionId: string | null;
  sessionTitle: string;
  decision: ClaimWarning["decision"] | "failed";
  tool: string;
  conflicts: ClaimWarning["conflicts"];
  error?: string;
}

/** A repo the plan can be kept in: a local clone and its origin. */
export interface PlanRepoChoice {
  path: string;
  name: string;
  origin: string;
  /** A session of the room's group works in it. */
  inRoom: boolean;
}
