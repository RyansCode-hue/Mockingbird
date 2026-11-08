import { useEffect, useRef } from "react";

// one IPC subscription for the whole window, fanned out to every view that cares
const listeners = new Set<(root: string) => void>();
let subscribed = false;
/** Hear every watched folder that changes (the main process's folder watch). */
export function onFolderChanged(cb: (root: string) => void): () => void {
  if (!subscribed) {
    subscribed = true;
    window.mb.onFolderChanged((root: string) => listeners.forEach((l) => l(root)));
  }
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Refresh a view of a session's folder when its files change. The main process
 * watches the folders of live sessions and says when one changes; a slow poll
 * stays as the safety net — for changes a watch can't see (a worktree's index
 * lives in the main repository's .git) and for folders that aren't watched.
 * Nothing runs while the window is hidden; showing it refreshes.
 */
export function useFolderRefresh(root: string | null, refresh: () => void, fallbackMs = 15_000): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    if (!root) return;
    const run = () => !document.hidden && ref.current();
    const off = onFolderChanged((changed) => changed === root && run());
    const t = setInterval(run, fallbackMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      off();
      clearInterval(t);
      document.removeEventListener("visibilitychange", run);
    };
  }, [root, fallbackMs]);
}
