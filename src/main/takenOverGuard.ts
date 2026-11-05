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
} as const;

export type UntakenCall = keyof typeof UNTAKEN_CALLS;

/**
 * Throws why session `id` can't have `call` done to it when a teammate took it over (`refusal`: TakeoverService's
 * takenOverRefusal; null when team rooms didn't start, so nothing was taken over). A copy from a take-over its owner
 * refused isn't taken over: it's this install's own, and may.
 */
export function refuseTakenOver(id: string, call: UntakenCall, refusal: ((id: string, doing: string) => string | null) | null): void {
  const why = refusal?.(id, UNTAKEN_CALLS[call]);
  if (why) throw new Error(why);
}
