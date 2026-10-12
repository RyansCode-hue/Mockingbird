import { loginShell, quote } from "./shell";

/**
 * Claude Code's background sessions (its agent view: `claude --bg`,
 * `/background`, ← at an empty prompt). A conversation moved there runs in a
 * worker of Claude's own daemon, not in the pane that started it. Quitting
 * Mockingbird ends the pane's process only; the worker ignores the hangup and
 * keeps the conversation. `claude --resume <id>` then won't resume it: it
 * says the session "is running in the background" and exits, or, with agent
 * view on, opens the worker in the pane instead.
 *
 * Mockingbird's panes start Claude with agent view off (agents.ts,
 * CLAUDE_NO_BACKGROUND_ENV), so their conversations no longer get there. This
 * frees one that did, or that was moved there from another terminal, so its
 * pane can resume it.
 */

/** A running session as `claude agents --json` lists it. */
export interface ClaudeAgentEntry {
  /** A background session's short id, which `claude stop` takes. */
  id?: string;
  /** Present while a process runs the session. */
  pid?: number;
  kind?: string;
  /** The conversation it runs. */
  sessionId?: string;
  status?: string;
}

/** Runs the Claude CLI with these arguments: its exit code, and its stdout (or what it said on stderr when it failed). Never rejects. */
export type RunClaude = (args: string[]) => Promise<{ code: number; out: string }>;

/** `claude agents` refuses while agent view is off (an env var or the user's `disableAgentView` setting). */
const AGENT_VIEW_OFF = /is disabled by (CLAUDE_CODE_DISABLE_AGENT_VIEW|the 'disableAgentView' setting)/;
/** What a background session's id looks like: `claude stop` gets it as an argument, never something an option parser could take. */
const JOB_ID = /^[A-Za-z0-9][\w-]{0,63}$/;

/** `claude agents --json`'s output, as entries; throws when it isn't a list. */
export function parseAgents(out: string): ClaudeAgentEntry[] {
  const v: unknown = JSON.parse(out);
  if (!Array.isArray(v)) throw new Error("claude agents --json didn't print a list");
  return v.filter((e): e is ClaudeAgentEntry => typeof e === "object" && e !== null);
}

/**
 * The background session running conversation `conversationId` now, or null
 * when none is. Throws when `claude agents --json` fails for any reason but
 * agent view being off (no background session can be listed then).
 */
export async function backgroundHolder(run: RunClaude, conversationId: string): Promise<ClaudeAgentEntry | null> {
  const r = await run(["agents", "--json"]);
  if (r.code !== 0) {
    if (AGENT_VIEW_OFF.test(r.out)) return null;
    throw new Error(`claude agents --json exited with code ${r.code}: ${r.out.trim().slice(0, 300) || "no output"}`);
  }
  const want = conversationId.toLowerCase();
  // a listed job without a process isn't running: `claude --resume` only defers to a live one
  return parseAgents(r.out).find((e) => e.kind === "background" && typeof e.pid === "number" && e.sessionId?.toLowerCase() === want) ?? null;
}

export interface FreeOptions {
  /** How long a stopped session gets to let go of the conversation. */
  settleMs?: number;
  pollMs?: number;
}

/**
 * Make Claude conversation `conversationId` free to resume in a pane. A
 * background session running it is stopped (`claude stop`; the conversation
 * is kept), unless it's in the middle of a turn. Returns what the pane should
 * say about that, or null when no background session had it. Throws, saying
 * what to do, when it can't be freed. When Claude can't be asked, it says so
 * in the log and returns null: `claude --resume` then refuses in the pane if
 * the conversation is held.
 */
export async function freeForResume(run: RunClaude, conversationId: string, opts: FreeOptions = {}): Promise<string | null> {
  const settleMs = opts.settleMs ?? 5000;
  const pollMs = opts.pollMs ?? 250;
  let holder: ClaudeAgentEntry | null;
  try {
    holder = await backgroundHolder(run, conversationId);
  } catch (err) {
    console.warn(`[claude] couldn't check whether conversation ${conversationId} runs in a Claude Code background session; resuming it as usual: ${(err as Error).message}`);
    return null;
  }
  if (!holder) return null;
  const job = holder.id && JOB_ID.test(holder.id) ? holder.id : null;
  const where = job ? `Claude Code background session ${job}` : `a Claude Code background session (pid ${holder.pid})`;
  if (holder.status === "busy") {
    throw new Error(
      `This conversation is in the middle of a turn in ${where}, outside its Mockingbird pane. Resume once that turn ends` +
        (job ? `, or stop it now with \`claude stop ${job}\` and resume.` : ".")
    );
  }
  if (!job) throw new Error(`This conversation is running in ${where}, outside its Mockingbird pane. Find it with \`claude agents\`, stop it there, then resume.`);
  const stopped = await run(["stop", job]);
  if (stopped.code !== 0) {
    throw new Error(`This conversation is running in ${where}, outside its Mockingbird pane, and stopping it failed: ${stopped.out.trim().slice(0, 300) || `exit code ${stopped.code}`}. Run \`claude stop ${job}\`, then resume.`);
  }
  for (const until = Date.now() + settleMs; ; ) {
    let still: ClaudeAgentEntry | null;
    try {
      still = await backgroundHolder(run, conversationId);
    } catch (err) {
      console.warn(`[claude] stopped ${where}, but couldn't check that it let go of conversation ${conversationId}; resuming it: ${(err as Error).message}`);
      break;
    }
    if (!still) break;
    if (Date.now() >= until) throw new Error(`Stopped ${where}, but it was still running this conversation ${Math.round(settleMs / 1000)}s later. Check \`claude agents\`, then resume.`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return `This conversation was running in ${where}, outside its Mockingbird pane. Mockingbird stopped it there to resume it here.`;
}

/**
 * Runs the Claude CLI at `bin` in the user's login shell, as the panes do (an
 * npm-installed `claude` needs their PATH's node), with nothing on stdin. Only
 * for its session-management subcommands, which never start a conversation.
 */
export function claudeRunner(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): RunClaude {
  return async (args) => {
    const { code, out } = await loginShell([bin, ...args].map(quote).join(" "), { env, timeoutMs });
    return { code, out };
  };
}
