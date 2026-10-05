import React, { useEffect, useRef, useState } from "react";
import { isErr, type RunServiceState } from "../shared/types";
import { LogTerm, disposeLog } from "./LogTerm";
import { addOutput, clearOutput, currentSession, useDebug } from "./debugStore";
import { RUN_DOT } from "./runDisplay";
import { settled } from "./settled";
import { useAction } from "./useAction";

const DEBUG_CONSOLE = "__debug-console";

/** What debuggers print, and a prompt that evaluates in the paused frame. */
function DebugConsole() {
  const debug = useDebug();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [at, setAt] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  // braces matter: scrollIntoView returns a promise in newer Chromium, and an effect may only return a cleanup
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [debug.output.length]);
  const target = currentSession(debug.sessions);
  const names = new Map(debug.sessions.map((s) => [s.id, s.name]));
  const run = async () => {
    const expr = input.trim();
    if (!expr) return;
    setHistory((h) => [...h.filter((x) => x !== expr), expr]);
    setAt(-1);
    setInput("");
    addOutput({ sid: target?.id ?? "", category: "input", text: `› ${expr}\n` });
    if (!target) return addOutput({ sid: "", category: "stderr", text: "Nothing is being debugged.\n" });
    const frame = debug.selected[target.id] ?? debug.paused[target.id]?.frame ?? null;
    const r = await settled(window.mb.debugEvaluate(target.id, expr, frame?.id, "repl"), "Couldn't evaluate");
    addOutput({ sid: target.id, category: isErr(r) ? "stderr" : "result", text: `${isErr(r) ? r.error : r.result}\n` });
  };
  return (
    <div className="dc">
      <div className="dc-out">
        {debug.output.length === 0 && <div className="fp-note">Debugger output and evaluation results appear here.</div>}
        {debug.output.map((o, i) => (
          <span key={i} className={`dc-line ${o.category}`} title={names.get(o.sid)}>
            {o.text}
          </span>
        ))}
        <div ref={end} />
      </div>
      <div className="dc-in">
        <span className="dc-prompt">›</span>
        <input
          placeholder={target ? `Evaluate in ${target.name}${target.state === "stopped" ? " (paused frame)" : ""}` : "Start a service with Debug to evaluate here"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
            if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const i = at < 0 ? history.length - 1 : Math.max(0, at - 1);
              setAt(i);
              setInput(history[i]);
            }
            if (e.key === "ArrowDown" && at >= 0) {
              e.preventDefault();
              const i = at + 1;
              setAt(i >= history.length ? -1 : i);
              setInput(i >= history.length ? "" : history[i]);
            }
          }}
        />
        <button className="icon" title="Clear the console" onClick={clearOutput}>⌫</button>
      </div>
    </div>
  );
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * The panel under the grid (⌘J), as in VS Code: a tab per service log. Logs
 * of stopped services stay until their tab is closed.
 */
export function BottomPanel({
  states,
  active,
  height,
  onActive,
  onHide,
  onResize,
}: {
  states: RunServiceState[];
  active: string | null;
  height: number;
  onActive: (id: string) => void;
  onHide: () => void;
  onResize: (h: number) => void;
}) {
  const worktrees = new Set(states.map((s) => s.worktree));
  const debug = useDebug();
  const { run, error, setError } = useAction();
  const hasConsole = debug.sessions.length > 0 || debug.output.length > 0;
  const consoleOn = hasConsole && (active === DEBUG_CONSOLE || !states.length);
  const shown = consoleOn ? null : states.find((s) => s.id === active) ?? states[0] ?? null;
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = height;
    const move = (ev: PointerEvent) => onResize(Math.min(window.innerHeight - 160, Math.max(120, start + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("bp-resizing");
    };
    document.body.classList.add("bp-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="bp" style={{ height }}>
      <div className="bp-grip" onPointerDown={startResize} />
      <div className="bp-tabs" role="tablist">
        {hasConsole && (
          <div role="tab" aria-selected={consoleOn} className={`bp-tab ${consoleOn ? "on" : ""}`} onClick={() => onActive(DEBUG_CONSOLE)}>
            Debug Console
          </div>
        )}
        {states.map((s) => (
          <div
            key={s.id}
            role="tab"
            aria-selected={s.id === shown?.id}
            className={`bp-tab ${s.id === shown?.id ? "on" : ""}`}
            title={`${s.service} in ${s.worktree}${s.slot ? ` · slot ${s.slot}` : ""} — ${s.status}${s.error ? `: ${s.error}` : ""}`}
            onClick={() => onActive(s.id)}
          >
            <span className={`rv-dot ${RUN_DOT[s.status]}`} />
            {s.service}
            {worktrees.size > 1 && <span className="bp-wt">{baseName(s.worktree)}</span>}
            {(s.status === "stopped" || s.status === "failed") && (
              <button
                className="bp-x"
                title="Close this log"
                onClick={(e) => {
                  e.stopPropagation();
                  disposeLog(s.id);
                  run("close", () => window.mb.runClear(s.id));
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <span className="bp-spacer" />
        {shown && (shown.status === "running" || shown.status === "starting") && (
          <button className="icon" title={`Stop ${shown.service} (and what depends on it)`} onClick={() => run("stop", () => window.mb.runStopById(shown.id))}>
            ■
          </button>
        )}
        <button className="icon" title="Hide the panel (⌘J)" onClick={onHide}>
          ✕
        </button>
      </div>
      {error && (
        <div className="fp-note err bp-err">
          {error}
          <button className="bp-x" aria-label="Dismiss" title="Dismiss" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {consoleOn ? <DebugConsole /> : shown ? <LogTerm key={shown.id} id={shown.id} /> : <div className="fp-note">Nothing has run yet — start a service from Run and Debug.</div>}
    </div>
  );
}
