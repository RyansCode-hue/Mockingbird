import { AGENT_NAME, type AgentKind } from "../shared/types";
import { MCP_TOOL } from "./messaging";

/**
 * What the reviewing agent is told: what changed and how to see it, what to
 * look for, to change nothing, and to send its findings back to the session
 * that did the work over Mockingbird's agent messaging.
 */
export function reviewPrompt(o: { author: AgentKind; authorId: string; authorTitle: string; branch: string | null; base: string | null }): string {
  const committed = o.base ? `git diff ${o.base}...HEAD (committed on this branch since ${o.base})` : "git log -5 -p (the recent commits; no base branch was found)";
  return [
    `You're giving a second opinion on another agent's work before it goes to a pull request. It was done by a ${AGENT_NAME[o.author]} session called "${o.authorTitle}", in this folder${o.branch ? ` on branch ${o.branch}` : ""}.`,
    "",
    "See what changed:",
    `- ${committed}`,
    "- git diff HEAD and git status (not committed yet, including new files)",
    "Read the surrounding code wherever you need context.",
    "",
    "Review for, in this order:",
    "1. Bugs and edge cases: wrong logic, off-by-one, null or empty handling, races, error paths.",
    "2. Security: authentication and authorization checks, input validation, injection, secrets, data exposure.",
    "3. Silent failures: catches that swallow errors, fallbacks that hide a failure, results nobody checks.",
    "4. Tests: changed behaviour without a test, or tests that don't check what they claim.",
    "5. Clarity: duplicated logic that should be shared, names that mislead, comments that narrate history instead of explaining the code.",
    "",
    "This is a review only: don't change, stage or commit anything.",
    "",
    `When you're done, send your findings to that session with Mockingbird's ${MCP_TOOL.sendMessage} tool (to: "${o.authorId}"), as one message: the problems that matter, most severe first, each with file:line, what's wrong, and a concrete fix. Leave out style nits. If there's nothing worth changing, send one line saying so.`,
  ].join("\n");
}
