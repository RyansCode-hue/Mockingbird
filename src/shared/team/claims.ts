/**
 * Team rooms: the claims check (docs/team-rooms.md, "Radley House board").
 * A ticket a teammate claimed in the House, on a branch their room sessions
 * work on, owns the files those sessions have changed there. Mockingbird
 * writes them, per worktree, to `.mockingbird/claims.json`; an agent's edit
 * of one is held back once and warned about by its PreToolUse hook.
 *
 * Plain code with no Node or Electron APIs: the window, the main process and
 * the generated hook script (which embeds claimConflicts, editedPaths and
 * claimHookResponse by their source) all use it.
 */
import type { MemberId, RoomId } from "./types";

/** Where each worktree of a room's repository gets Mockingbird's read-only files (git-ignored through .git/info/exclude). */
export const PLAN_DIR = ".mockingbird";
export const CLAIMS_FILE = `${PLAN_DIR}/claims.json`;
export const AGENT_CONTEXT_FILE = `${PLAN_DIR}/agent-context.md`;
/** The work-package board's rendering, which worktrees may still hold: removed when their copy is rewritten. */
export const LEGACY_PLAN_FILE = `${PLAN_DIR}/plan.md`;
/**
 * Set in a session's environment when its launch already carries the room's
 * agent context: the SessionStart hook then adds nothing. The value is shared
 * with hook.sh scripts and sessions started by earlier versions.
 */
export const ROOM_CONTEXT_ENV = "MOCKINGBIRD_PLAN_CONTEXT";

/** A teammate's claimed ticket that an edit ran into. */
export interface ClaimHit {
  roomId: RoomId;
  room: string;
  n: number;
  title: string;
  /** The House's status. */
  status: string;
  owner: { id: MemberId; name: string };
  branch: string;
}

/** The claims block in each worktree: every room's teammates' claimed tickets and the files their sessions changed. */
export interface ClaimsFile {
  mockingbird: "house-claims/1";
  /** Whose checkout this copy is in: that member's own claims never warn. */
  self?: MemberId;
  rooms: {
    roomId: RoomId;
    room: string;
    tickets: { n: number; title: string; status: string; owner: { id: MemberId; name: string }; branch: string; files: string[] }[];
  }[];
}

export const claimsFile = (rooms: ClaimsFile["rooms"], self?: MemberId): ClaimsFile => ({ mockingbird: "house-claims/1", ...(self ? { self } : {}), rooms });

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

/** A claim warning (or the claims check's failure), as the window shows it. */
export interface ClaimWarningNotice {
  at: number;
  sessionId: string | null;
  sessionTitle: string;
  decision: ClaimWarning["decision"] | "failed";
  tool: string;
  conflicts: ClaimWarning["conflicts"];
  error?: string;
}

/**
 * Teammates' claimed tickets whose sessions changed `rel` (a path relative to
 * the checkout the claims file is in).
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
  const target = norm(rel);
  if (!target || target === ".." || target.startsWith("../")) return [];
  const hits: ClaimHit[] = [];
  for (const room of file?.rooms ?? []) {
    for (const t of room.tickets ?? []) {
      if (!t.owner || t.owner.id === file.self) continue;
      if ((t.files ?? []).some((f) => norm(f) === target)) hits.push({ roomId: room.roomId, room: room.room, n: t.n, title: t.title, status: t.status, owner: t.owner, branch: t.branch });
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
 * for both). The first edit of a file a teammate's claimed ticket has been
 * changing is held back (deny) in a conversation, with the reason for the
 * agent and a warning line for the user; repeating it goes through the normal
 * permission flow with a reminder (additionalContext). See src/main/hooks.ts
 * for why. Ticket titles and statuses come from the House, owners' names and
 * branches from teammates: each is on one line, titles quoted, the rest
 * quoted unless they're plain words (agentText.ts quoted and named, repeated
 * here).
 *
 * Self-contained: the hook script embeds its source.
 */
export function claimHookResponse(conflicts: { file: string; hits: ClaimHit[] }[], first: boolean): object {
  const line = (s: string) =>
    String(s)
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ")
      .trim()
      .slice(0, 120)
      .trim();
  const quote = (s: string) => JSON.stringify(line(s)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const named = (s: string) => (/^[\p{L}\p{N}][\p{L}\p{N} ._'@/-]*$/u.test(line(s)) ? line(s) : quote(s));
  const lines = conflicts.map((c) => {
    const who = c.hits.map((h) => `${named(h.owner.name)}'s ticket #${Number(h.n)} ${quote(h.title)} (branch ${named(h.branch)}, ${named(String(h.status).replace(/_/g, " "))})`).join(" and ");
    return `${c.file} has been changing on ${who}`;
  });
  const owners = [...new Set(conflicts.flatMap((c) => c.hits.map((h) => named(h.owner.name))))].join(" and ");
  if (first) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Mockingbird held this edit back once: ${lines.join("; ")}. Editing it may collide with ${owners}'s work — ` +
          "read the ticket (the mockingbird read_house_ticket tool) and check with your user before changing it. " +
          "If the edit is still needed, make the same edit again: Mockingbird won't stop edits to this file again in this conversation.",
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
