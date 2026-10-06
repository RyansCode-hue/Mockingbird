import { useEffect, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import { dataPump, followSize, makeTerm, replay, termThemeListeners, trackUserInput, type CachedTerm } from "./cachedTerm";
import { classifyTermInput } from "./inputGuard";

interface Entry extends CachedTerm {
  fit: FitAddon;
  lastInput: number;
  inputWired?: boolean;
}

// one terminal per service log, kept while the app runs so switching tabs keeps scrollback
const logs = new Map<string, Entry>();
const ensurePump = dataPump((cb) => window.mb.onRunData(cb), logs, (e, data) => e.term.write(data));
termThemeListeners.add((theme) => {
  for (const e of logs.values()) e.term.options.theme = theme;
});

function entryFor(id: string): Entry {
  const open = logs.get(id);
  if (open) return open;
  const { term, fit } = makeTerm({ fontSize: 11, lineHeight: 1.35, scrollback: 10000, convertEol: false });
  const e: Entry = { term, fit, replayed: false, ready: false, lastInput: 0 };
  logs.set(id, e);
  void replay(e, window.mb.runBuffer(id), () => logs.get(id) === e);
  // keys go to the process: Vite's shortcuts, a prompt, Ctrl-C. What xterm
  // sends on its own answers queries; those in the replayed log are history.
  term.onData((d) => {
    if (!e.ready) return;
    if (classifyTermInput(d, Date.now() - e.lastInput, term.modes.mouseTrackingMode) === "unattributed") {
      window.mb.auditWrite(`run:${id}`, "dropped-unattributed", d);
      return;
    }
    window.mb.runWrite(id, d);
  });
  return e;
}

/** Forget a log's terminal (its service row was cleared). */
export function disposeLog(id: string): void {
  logs.get(id)?.term.dispose();
  logs.delete(id);
}

/** A service's live log: its terminal output, replayed from the start and followed. */
export function LogTerm({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ensurePump();
    const e = entryFor(id);
    const el = host.current!;
    if (e.term.element) el.appendChild(e.term.element);
    else e.term.open(el);
    trackUserInput(e);
    return followSize(e, el, (cols, rows) => window.mb.runResize(id, cols, rows));
  }, [id]);
  return <div className="log-term" ref={host} />;
}
