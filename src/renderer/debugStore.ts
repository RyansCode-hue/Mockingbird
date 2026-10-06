import { useEffect, useState } from "react";
import { isErr, type DebugFrame, type DebugSessionInfo } from "../shared/types";
import { createIpcStore, loadInto } from "./ipcStore";

/**
 * The renderer's view of the debugger, shared by the editor (breakpoints, the
 * paused line), the Run and Debug view and the Debug Console: one IPC
 * subscription, many readers.
 */
export interface OutputLine {
  sid: string;
  category: string;
  text: string;
}

interface State {
  sessions: DebugSessionInfo[];
  output: OutputLine[];
  /** Where each stopped session is paused: the thread and its top frame. */
  paused: Record<string, { threadId: number; frame: DebugFrame | null }>;
  /** The frame the user picked in the call stack (else the top one). */
  selected: Record<string, DebugFrame | null>;
}

const MAX_OUTPUT = 3000;
type Stopped = (sid: string, at: { threadId: number; frame: DebugFrame | null }) => void;
const stopListeners = new Set<Stopped>();

const store = createIpcStore<State>({ sessions: [], output: [], paused: {}, selected: {} }, ({ get }) => {
  loadInto("the debug sessions", window.mb.debugSessions(), (s: DebugSessionInfo[]) => set({ sessions: s }));
  window.mb.onDebugChanged((s: DebugSessionInfo[]) => {
    // a session that's running again isn't paused anywhere
    const paused = { ...get().paused };
    const selected = { ...get().selected };
    for (const id of Object.keys(paused)) {
      if (s.find((x) => x.id === id)?.state !== "stopped") {
        delete paused[id];
        delete selected[id];
      }
    }
    set({ sessions: s, paused, selected });
  });
  window.mb.onDebugOutput((sid: string, category: string, text: string) => {
    const { output: was } = get();
    const output = was.length >= MAX_OUTPUT ? was.slice(-MAX_OUTPUT + 1) : was.slice();
    output.push({ sid, category, text });
    set({ output });
  });
  window.mb.onDebugStopped((sid: string, at: { threadId: number; frame: DebugFrame | null }) => {
    set({ paused: { ...get().paused, [sid]: at }, selected: { ...get().selected, [sid]: at.frame } });
    stopListeners.forEach((l) => l(sid, at));
  });
});
const set = (patch: Partial<State>) => store.set({ ...store.get(), ...patch });

export function useDebug(): State {
  return store.use();
}

/** The session the debugger acts on: a paused one first, else the newest that hasn't ended. */
export function currentSession(sessions: DebugSessionInfo[]): DebugSessionInfo | undefined {
  return sessions.find((s) => s.state === "stopped") ?? sessions.filter((s) => s.state !== "ended").pop();
}

export function selectFrame(sid: string, frame: DebugFrame | null): void {
  set({ selected: { ...store.get().selected, [sid]: frame } });
}

export function clearOutput(): void {
  set({ output: [] });
}

export function addOutput(line: OutputLine): void {
  set({ output: [...store.get().output, line] });
}

/** Be told when a session stops (to open its file). */
export function onStopped(l: Stopped): () => void {
  store.connect();
  stopListeners.add(l);
  return () => stopListeners.delete(l);
}

/**
 * A pane session's repository breakpoints (relative path → lines), kept in
 * step with changes made from any view; `error` says why they couldn't be read
 * (a folder that isn't a repository has none to read).
 */
export function useBreakpoints(paneSessionId: string | null): {
  map: Record<string, number[]>;
  error: string;
  toggle: (rel: string, line: number) => void;
  clear: (rel: string, line: number) => void;
} {
  const [map, setMap] = useState<Record<string, number[]>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    if (!paneSessionId) return setMap({});
    let live = true;
    const load = () =>
      window.mb.debugBreakpoints(paneSessionId).then(
        (r: { breakpoints: Record<string, number[]> } | { error: string }) => {
          if (!live) return;
          if (isErr(r)) return setError(r.error);
          setError("");
          setMap(r.breakpoints);
        },
        (err: unknown) => live && setError(err instanceof Error ? err.message : String(err))
      );
    load();
    const off = window.mb.onBreakpointsChanged(() => load());
    return () => {
      live = false;
      off();
    };
  }, [paneSessionId]);
  const write = (rel: string, lines: number[]) => {
    if (!paneSessionId) return;
    setMap((m) => ({ ...m, [rel]: lines }));
    window.mb.debugSetBreakpoints(paneSessionId, rel, lines).then((r: unknown) => {
      if (isErr(r)) addOutput({ sid: "", category: "stderr", text: `Breakpoint not saved: ${r.error}\n` });
    });
  };
  return {
    map,
    error,
    toggle: (rel, line) => {
      const cur = map[rel] ?? [];
      write(rel, cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line]);
    },
    clear: (rel, line) => write(rel, (map[rel] ?? []).filter((l) => l !== line)),
  };
}
