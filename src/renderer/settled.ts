import { isErr } from "../shared/types";

/**
 * An IPC reply with a rejected call turned into the { error } a failing
 * handler sends, so a view shows it like any other failure instead of
 * waiting on a reply that never comes. `what` leads the message; without it
 * the caller words the failure itself.
 */
export function settled<T>(reply: PromiseLike<T> | T, what?: string): Promise<Awaited<T> | { error: string }> {
  return Promise.resolve(reply).catch((err: unknown) => {
    console.error(`${what ?? "IPC call failed"}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { error: what ? `${what}: ${message}` : message };
  });
}

/** A check a view shows: null while it's out, its answer, or why it couldn't be made. */
export type Check<T> = T | { error: string } | null;

/** A check's reply, settled; a failure, rejected or answered as { error }, is logged with what was being checked. */
export async function runCheck<T>(what: string, reply: PromiseLike<T> | T): Promise<Awaited<T> | { error: string }> {
  const r = await settled(reply);
  if (isErr(r)) console.error(`[mockingbird] couldn't check ${what}:`, r.error);
  return r;
}

/** What a row says about a check: still checking, why it failed, or its answer in words. */
export function checkNote<T>(c: Check<T>, done: (v: T) => string): string {
  return c === null ? "checking…" : isErr(c) ? `Couldn't check: ${c.error}` : done(c as T);
}
