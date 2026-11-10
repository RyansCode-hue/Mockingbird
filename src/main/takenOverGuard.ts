/**
 * The IPC calls that start something from a session, or put its files back, which a copy a teammate took over must
 * refuse (it continues on their laptop, or in another session here once taken back): what each would do to it, as
 * the refusal says. The window offers none of these for such a copy (workspaceActions.tsx); main holds the take-over
 * state too, and refuses them for a window that hasn't heard yet.
 */
export const UNTAKEN_CALLS = {
  "handoff:start": "handing this copy on",
  "review:start": "having this copy's branch reviewed",
  "turns:restore": "putting this copy's files back",
  "usage:briefStart": "starting a fresh session from this copy",
  "wires:finish": "finishing this copy's step",
} as const;

export type UntakenCall = keyof typeof UNTAKEN_CALLS;

/** What the guarded handlers need: a session by id (throwing once it's gone), and the take-over check (null when team rooms didn't start). */
export interface UntakenDeps<S extends { id: string }> {
  sessionOf: (id: string) => S;
  refusal: () => ((id: string, doing: string) => string | null) | null;
}

/**
 * The IPC handler for `call`: it looks its session up by its first argument and refuses a copy a teammate took over
 * (refuseTakenOver) before `body` runs with it and the call's other arguments.
 */
export function untakenHandler<S extends { id: string }, A extends unknown[], R>(call: UntakenCall, deps: UntakenDeps<S>, body: (s: S, ...args: A) => R): (id: unknown, ...args: A) => R {
  return (id, ...args) => {
    const s = deps.sessionOf(String(id));
    refuseTakenOver(s.id, call, deps.refusal());
    return body(s, ...args);
  };
}

/**
 * Throws why session `id` can't have `call` done to it when a teammate took it over (`refusal`: TakeoverService's
 * takenOverRefusal; null when team rooms didn't start, so nothing was taken over). A copy from a take-over its owner
 * refused isn't taken over: it's this install's own, and may.
 */
export function refuseTakenOver(id: string, call: UntakenCall, refusal: ((id: string, doing: string) => string | null) | null): void {
  const why = refusal?.(id, UNTAKEN_CALLS[call]);
  if (why) throw new Error(why);
}
