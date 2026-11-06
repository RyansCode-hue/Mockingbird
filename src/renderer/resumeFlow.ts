import { isErr, type SessionInfo } from "../shared/types";

/** What resuming an exited session goes through, step by step (main.tsx's resumeDead gives the real calls). */
export interface ResumeSteps {
  /** Why the window's own state refuses it (a teammate took it over: takenOverWhy), or null. */
  refusal: string | null;
  /** Whether resuming its conversation is worth its cost (it may ask first). */
  costOk: () => Promise<boolean>;
  /**
   * Main's resume (sessions:resume): its check, then its dead pty let go and the session relaunched, nothing waited on
   * between the check and letting go. `{ refused }` before anything is undone; `{ error }` after (it's in Previous).
   */
  resume: () => Promise<SessionInfo | { refused: string } | { error: string }>;
  /** Let go of its terminal in the window. */
  dispose: () => void;
  say: (text: string) => void;
}

/**
 * Resume exited session `title`. The window's refusal is said before anything; main is asked only once the cost is
 * agreed, so a take-over heard during that question still refuses it, and a refused copy keeps its pane and
 * scrollback. The session as relaunched; undefined when it stopped short, each stop said (or the cost asked about and
 * declined).
 */
export async function resumeExited(title: string, d: ResumeSteps): Promise<SessionInfo | undefined> {
  if (d.refusal) return void d.say(d.refusal);
  if (!(await d.costOk())) return undefined;
  let r: SessionInfo | { refused: string } | { error: string };
  try {
    r = await d.resume();
  } catch (err) {
    // the call never got an answer (no handler, the window's IPC gone): whether main got to it is unknown
    console.error(`[mockingbird] resuming ${title}:`, err);
    return void d.say(`Couldn't resume ${title}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ("refused" in r) return void d.say(r.refused);
  // past main's check its pty was let go, so its terminal goes too, whether or not the relaunch then worked
  d.dispose();
  if (isErr(r)) return void d.say(`Couldn't resume ${title}: ${r.error}`);
  return r;
}
