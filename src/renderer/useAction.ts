import { useRef, useState } from "react";
import { isErr } from "../shared/types";

/** Run one labelled action: its { error } reply, or its rejection as one, is shown and returned. */
export type RunAction = <R>(what: string, fn: () => PromiseLike<R> | R) => Promise<Awaited<R> | { error: string }>;

/**
 * Actions in flight, by label. Several can overlap: the tracker stays busy
 * until the last one ends, whichever order they end in. A rejected call ends
 * like an { error } reply, so nothing is left busy and the failure shows.
 */
export function createActions(onChange: (inflight: string[]) => void, onError: (message: string) => void) {
  let inflight: string[] = [];
  const update = (next: string[]) => {
    inflight = next;
    onChange(next);
  };
  const run: RunAction = async <R,>(what: string, fn: () => PromiseLike<R> | R): Promise<Awaited<R> | { error: string }> => {
    update([...inflight, what]);
    onError("");
    try {
      const r = await fn();
      if (isErr(r)) onError(r.error);
      return r;
    } catch (err) {
      console.error(`${what} failed:`, err);
      const error = err instanceof Error ? err.message : String(err);
      onError(error);
      return { error };
    } finally {
      const i = inflight.lastIndexOf(what);
      update(i < 0 ? inflight : [...inflight.slice(0, i), ...inflight.slice(i + 1)]);
    }
  };
  return { run, isBusy: () => inflight.length > 0 };
}

/**
 * A view's actions and their one error line. `busy` names the newest action
 * still running ("" when idle) and stays set while any is; `doing` asks about
 * one; `isBusy` answers synchronously, for a guard a keypress can hit twice
 * before the view re-renders.
 */
export function useAction() {
  const [inflight, setInflight] = useState<string[]>([]);
  const [error, setError] = useState("");
  const actions = useRef<ReturnType<typeof createActions>>();
  actions.current ??= createActions(setInflight, setError);
  return {
    busy: inflight[inflight.length - 1] ?? "",
    doing: (what: string) => inflight.includes(what),
    isBusy: actions.current.isBusy,
    run: actions.current.run,
    error,
    setError,
  };
}
