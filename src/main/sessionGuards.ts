import type { SessionInfo, WorktreeStateInfo } from "../shared/types";
import { ownWorktree, worktreeGone, type CloseWarnings } from "../shared/closing";
import { alertKind } from "../shared/phoneAlerts";
import { HELPDESK_CONVERSATION_WHY } from "./helpdesk";
import type { SessionManager } from "./sessions";
import { takenOverWhy, UNTAKEN_CALLS } from "./takenOverGuard";

/**
 * The one place main decides what may be done to a session on someone's behalf: the app Assistant's tools ask here
 * (docs/assistant.md → Never), and phone replies answer a prompt with answerSamePrompt. Every check is the existing
 * one, asked here: a teammate's session (SessionManager.ownRefusal), a copy a teammate took over (takenOverGuard.ts), one that
 * mayn't run again (relaunchGuard, in restartRefusal and whyNotResume), and the Helpdesk tasks workspace's role, whose
 * conversation is never typed into, sent to or read from.
 */

/** What can be done to a session, as whyNot is asked about it. */
export const GUARD_OPS = ["relaunch", "kill", "resume", "write", "broadcast", "readOutput", "rename", "group", "mute", "focus"] as const;
export type GuardOp = (typeof GUARD_OPS)[number];

/** What a teammate's session's refusal says only its owner can do (SessionManager.ownRefusal). */
const OWN_WHAT: Record<GuardOp, string> = {
  relaunch: "restart it",
  kill: "close it",
  resume: "resume it",
  write: "type into it",
  broadcast: "send it a broadcast",
  readOutput: "read its output",
  rename: "rename it",
  group: "move it to another group",
  mute: "mute it",
  focus: "point the Assistant at it",
};

/** The ops that reach the Helpdesk tasks workspace's conversation: refused for it, whoever asks. */
const HELPDESK_OPS: ReadonlySet<GuardOp> = new Set<GuardOp>(["write", "broadcast", "readOutput"]);

/** What a copy a teammate took over is refused, by op: what the take-over check's refusal says it was. */
const TAKEN_DOING: Partial<Record<GuardOp, string>> = {
  relaunch: UNTAKEN_CALLS["sessions:relaunchWith"],
  write: "typing into this copy",
  broadcast: "sending this copy a broadcast",
};

/** The keys that answer a permission prompt once, by agent. Never Claude's 2 or Codex's a: those allow for good. */
export const ANSWER_KEYS = {
  allow: { claude: "1", codex: "y" },
  // Esc declines in both, whatever the options are numbered
  deny: { claude: "\x1b", codex: "\x1b" },
} as const;

export type PromptAnswer = keyof typeof ANSWER_KEYS;

/**
 * A prompt as it was when an answer to it was offered (a phone alert, a confirm card): when its waiting began, what it
 * said, and, when known, when its latest prompt came (SessionInfo.waitingAt: a second prompt moves it, worded alike
 * or not).
 */
export interface PromptSeen {
  waitingSince: number | null;
  reason: string | null;
  waitingAt?: number | null;
}

/** The prompt session `s` shows now, as an answer offered now is to be held to. */
export const promptSeen = (s: Pick<SessionInfo, "waitingSince" | "waitingReason" | "waitingAt">): PromptSeen => ({ waitingSince: s.waitingSince, reason: s.waitingReason, waitingAt: s.waitingAt ?? null });

/** Whether session `s` still waits on exactly prompt `seen`. */
export function samePrompt(s: Pick<SessionInfo, "status" | "waitingSince" | "waitingReason" | "waitingAt">, seen: PromptSeen): boolean {
  if (s.status !== "waiting" || s.waitingSince !== seen.waitingSince || s.waitingReason !== seen.reason) return false;
  return seen.waitingAt === undefined || (s.waitingAt ?? null) === seen.waitingAt;
}

/**
 * Answer session `s`'s permission prompt once (ANSWER_KEYS), only while it's still prompt `seen`: false, with nothing
 * typed, once it was answered or changed since.
 */
export function answerSamePrompt(s: SessionInfo, action: PromptAnswer, seen: PromptSeen, write: (id: string, keys: string) => void): boolean {
  if (!samePrompt(s, seen)) return false;
  write(s.id, ANSWER_KEYS[action][s.agent === "codex" ? "codex" : "claude"]);
  return true;
}

/** Why an answer is refused: the prompt it was offered for isn't the one showing. */
export const PROMPT_CHANGED = "That prompt was answered or changed since, so nothing was typed";

export interface SessionGuardDeps {
  sessions: Pick<SessionManager, "list" | "resumable" | "planned" | "ownRefusal" | "restartRefusal" | "whyNotResume" | "write">;
  /** The take-over check (TakeoverService.takenOverRefusal); null when team rooms didn't start. */
  takenOver: () => ((id: string, doing: string) => string | null) | null;
  /** A worktree's state (worktrees.ts); throws, saying why, when it can't be read. */
  worktreeState: (folder: string) => Promise<WorktreeStateInfo>;
}

export class SessionGuards {
  constructor(private readonly d: SessionGuardDeps) {}

  private find(id: string): { live: SessionInfo | undefined; rec: SessionInfo | undefined; planned: boolean } {
    const live = this.d.sessions.list().find((s) => s.id === id);
    if (live) return { live, rec: live, planned: false };
    const closed = this.d.sessions.resumable().find((s) => s.id === id);
    if (closed) return { live: undefined, rec: closed, planned: false };
    const step = this.d.sessions.planned().find((s) => s.id === id);
    return { live: undefined, rec: step, planned: !!step };
  }

  /** Why `op` can't be done to session `id` now, or null when it can. Checks only: nothing is changed. */
  whyNot(op: GuardOp, id: string): string | null {
    if (!(GUARD_OPS as readonly string[]).includes(op)) return `“${String(op)}” isn't something done to a session`;
    const own = this.d.sessions.ownRefusal(id, OWN_WHAT[op]);
    if (own) return own;
    const { live, rec, planned } = this.find(id);
    if (!rec) return "There's no such session on this Mac";
    if (rec.role === "tasks" && HELPDESK_OPS.has(op)) return HELPDESK_CONVERSATION_WHY;
    const taken = () => (TAKEN_DOING[op] ? takenOverWhy(id, TAKEN_DOING[op]!, this.d.takenOver()) : null);
    switch (op) {
      case "relaunch":
        return this.d.sessions.restartRefusal(id) ?? taken();
      case "resume":
        return this.d.sessions.whyNotResume(id);
      case "write":
      case "broadcast":
        if (!live || live.status === "dead") return "It isn't running";
        if (live.shell) return "It's a terminal: what's typed into it runs as commands";
        if (op === "broadcast" && live.debrief) return "It's a debrief, mid-interview: broadcasts skip it";
        return taken();
      case "readOutput":
        return planned ? "It hasn't started, so it has no output" : null;
      case "mute":
        return live ? null : "It isn't open here";
      case "kill":
      case "rename":
      case "group":
      case "focus":
        return null;
    }
  }

  /**
   * What closing session `id` now can lose or interrupt (CloseWarnings), as Close session asks it (shared/closing.ts):
   * its own worktree's uncommitted files and unpushed commits, and whether it's mid-turn. A worktree that's gone holds
   * nothing; one whose state can't be read otherwise says why (`unread`). Throws for a session this Mac doesn't have.
   */
  async closeWarnings(id: string): Promise<CloseWarnings> {
    const { live, rec } = this.find(id);
    if (!rec) throw new Error("There's no such session on this Mac");
    const none: CloseWarnings = { uncommitted: 0, unpushed: 0, busy: live?.status === "working" || live?.status === "waiting", unread: null };
    if (!ownWorktree(rec)) return none;
    let st: WorktreeStateInfo;
    try {
      st = await this.d.worktreeState(rec.cwd);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (worktreeGone(why)) return none;
      console.warn(`[sessionGuards] ${id}: its worktree's state couldn't be read for closing it: ${why}`);
      return { ...none, unread: why };
    }
    // a dirty tree whose files couldn't be counted still has something to lose
    return { ...none, uncommitted: st.dirty ? Math.max(1, st.dirtyFiles) : 0, unpushed: st.ahead };
  }

  /**
   * Answer session `id`'s permission prompt once (`allow` or `deny`), only while it's still prompt `seen` (the one the
   * answer was offered for: answerSamePrompt, as phone replies answer). Refused, nothing typed, where whyNot refuses
   * typing into it (a teammate's, the Helpdesk tasks workspace, a copy a teammate took over, one not running), when
   * the prompt changed, and when it's a question rather than a permission prompt.
   */
  answerPrompt(id: string, action: PromptAnswer, seen: PromptSeen): { answered: "allow once" | "deny" } | { refused: string } {
    if (action !== "allow" && action !== "deny") return { refused: `“${String(action)}” isn't an answer: allow or deny` };
    if (!seen || typeof seen !== "object" || !(seen.waitingSince === null || typeof seen.waitingSince === "number") || !(seen.reason === null || typeof seen.reason === "string")) {
      return { refused: "No prompt was named to answer" };
    }
    const why = this.whyNot("write", id);
    if (why) return { refused: why };
    const s = this.find(id).live!;
    if (!samePrompt(s, seen)) return { refused: PROMPT_CHANGED };
    if (alertKind("waiting", s.waitingReason) !== "permission") return { refused: "It's asking a question, not for permission: answer it in its pane" };
    if (!answerSamePrompt(s, action, seen, (sid, keys) => this.d.sessions.write(sid, keys))) return { refused: PROMPT_CHANGED };
    return { answered: action === "allow" ? "allow once" : "deny" };
  }
}
