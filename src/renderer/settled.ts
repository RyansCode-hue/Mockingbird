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
