import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { currentTermTheme, termThemeListeners } from "./TerminalPane";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  /** Live output is written only after the saved log has been replayed, so nothing shows twice or out of order. */
  ready: boolean;
  pending: string[];
}

// one terminal per service log, kept while the app runs so switching tabs keeps scrollback
const logs = new Map<string, Entry>();
let pumping = false;

function pump() {
  if (pumping) return;
  pumping = true;
  window.mb.onRunData((id: string, data: string) => {
    const e = logs.get(id);
    if (!e) return; // not opened yet: the replay will include it
    if (e.ready) e.term.write(data);
    else e.pending.push(data);
  });
  termThemeListeners.add((theme) => {
    for (const e of logs.values()) e.term.options.theme = theme;
  });
}

function entryFor(id: string): Entry {
  let e = logs.get(id);
  if (e) return e;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 11,
    lineHeight: 1.35,
    theme: currentTermTheme(),
    scrollback: 10000,
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  e = { term, fit, ready: false, pending: [] };
  logs.set(id, e);
  const entry = e;
  window.mb.runBuffer(id).then((buf: string) => {
    entry.term.write(buf);
    // anything that arrived while the replay was in flight is already in it, except what came after
    entry.pending = [];
    entry.ready = true;
  });
  // keys go to the process: Vite's shortcuts, a prompt, Ctrl-C
  term.onData((d) => window.mb.runWrite(id, d));
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
    pump();
    const e = entryFor(id);
    const el = host.current!;
    if (e.term.element) el.appendChild(e.term.element);
    else e.term.open(el);
    const fit = () => {
      try {
        e.fit.fit();
        window.mb.runResize(id, e.term.cols, e.term.rows);
      } catch {
        /* hidden: nothing to measure */
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id]);
  return <div className="log-term" ref={host} />;
}
