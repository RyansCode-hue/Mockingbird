import { useEffect, useState, useSyncExternalStore } from "react";
import type { DebugFrame, DebugSessionInfo } from "../shared/types";

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
let state: State = { sessions: [], output: [], paused: {}, selected: {} };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((s) => s());
};
let installed = false;
type Stopped = (sid: string, at: { threadId: number; frame: DebugFrame | null }) => void;
const stopListeners = new Set<Stopped>();

function install() {
  if (installed) return;
  installed = true;
  window.mb.debugSessions().then((s: DebugSessionInfo[]) => set({ sessions: s }));
  window.mb.onDebugChanged((s: DebugSessionInfo[]) => {
    // a session that's running again isn't paused anywhere
    const paused = { ...state.paused };
    const selected = { ...state.selected };
    for (const id of Object.keys(paused)) {
      if (s.find((x) => x.id === id)?.state !== "stopped") {
        delete paused[id];
        delete selected[id];
      }
    }
    set({ sessions: s, paused, selected });
  });
  window.mb.onDebugOutput((sid: string, category: string, text: string) => {
    const output = state.output.length >= MAX_OUTPUT ? state.output.slice(-MAX_OUTPUT + 1) : state.output.slice();
    output.push({ sid, category, text });
    set({ output });
  });
  window.mb.onDebugStopped((sid: string, at: { threadId: number; frame: DebugFrame | null }) => {
    set({ paused: { ...state.paused, [sid]: at }, selected: { ...state.selected, [sid]: at.frame } });
    stopListeners.forEach((l) => l(sid, at));
  });
}

function subscribe(cb: () => void) {
  install();
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useDebug(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export function selectFrame(sid: string, frame: DebugFrame | null): void {
  set({ selected: { ...state.selected, [sid]: frame } });
}

export function clearOutput(): void {
  set({ output: [] });
}

export function addOutput(line: OutputLine): void {
  set({ output: [...state.output, line] });
}

/** Be told when a session stops (to open its file). */
export function onStopped(l: Stopped): () => void {
  install();
  stopListeners.add(l);
  return () => stopListeners.delete(l);
}

/**
 * A pane session's repository breakpoints (relative path → lines), kept in
 * step with changes made from any view.
 */
export function useBreakpoints(paneSessionId: string | null): { map: Record<string, number[]>; toggle: (rel: string, line: number) => void; clear: (rel: string, line: number) => void } {
  const [map, setMap] = useState<Record<string, number[]>>({});
  useEffect(() => {
    if (!paneSessionId) return setMap({});
    let live = true;
    const load = () =>
      window.mb.debugBreakpoints(paneSessionId).then((r: { breakpoints: Record<string, number[]> } | { error: string }) => {
        if (live && !("error" in r)) setMap(r.breakpoints);
      });
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
      if (r && typeof r === "object" && "error" in r) addOutput({ sid: "", category: "stderr", text: `Breakpoint not saved: ${(r as { error: string }).error}\n` });
    });
  };
  return {
    map,
    toggle: (rel, line) => {
      const cur = map[rel] ?? [];
      write(rel, cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line]);
    },
    clear: (rel, line) => write(rel, (map[rel] ?? []).filter((l) => l !== line)),
  };
}
