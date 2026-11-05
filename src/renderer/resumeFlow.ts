import { isErr, type SessionInfo } from "../shared/types";

/** What resuming an exited session goes through, step by step (main.tsx's resumeDead gives the real calls). */
export interface ResumeSteps {
  /** Why the window's own state refuses it (a teammate took it over: takenOverWhy), or null. */
  refusal: string | null;
  /** Why main would refuse running it again (its relaunch guard), or null: asked before anything is undone. */
  mainRefusal: () => Promise<string | null | { error: string }>;
  /** Whether resuming its conversation is worth its cost (it may ask first). */
  costOk: () => Promise<boolean>;
  /** Drop its dead pty, keeping its store entry; `{ error }` when that failed. */
  kill: () => Promise<unknown>;
  /** Let go of its terminal in the window. */
  dispose: () => void;
  relaunch: () => Promise<SessionInfo | null | { error: string }>;
  say: (text: string) => void;
}

/**
 * Resume exited session `title`: refused, and said, before its pty is dropped or its terminal let go, whether the
 * window or main refuses it, so a refused copy keeps its pane and scrollback. The session as relaunched (null when
 * main had nothing to relaunch); undefined when it stopped short, each stop said (or the cost asked about and declined).
 */
export async function resumeExited(title: string, d: ResumeSteps): Promise<SessionInfo | null | undefined> {
  if (d.refusal) return void d.say(d.refusal);
  const main = await d.mainRefusal();
  if (isErr(main)) return void d.say(`Couldn't resume ${title}: ${main.error}`);
  if (main) return void d.say(main);
  if (!(await d.costOk())) return undefined;
  const killed = await d.kill();
  if (isErr(killed)) return void d.say(`Couldn't resume ${title}: ${killed.error}`);
  d.dispose();
  const info = await d.relaunch();
  if (isErr(info)) return void d.say(`Couldn't resume: ${info.error}`);
  return info;
}
