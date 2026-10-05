import React, { useEffect, useState } from "react";
import { isErr, type DebugFrame, type DebugScope, type DebugSessionInfo, type DebugVariable, type IpcResult } from "../shared/types";
import { currentSession, selectFrame, useBreakpoints, useDebug } from "./debugStore";
import { settled } from "./settled";
import { useAction } from "./useAction";
import { baseName } from "../shared/paths";
import { usePersisted } from "./prefs";


/** One variable, expandable when it has children (fetched on first open). */
function VarRow({ sid, v, depth }: { sid: string; v: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<IpcResult<DebugVariable[]> | null>(null);
  const toggle = () => {
    if (!v.ref) return;
    setOpen((o) => !o);
    if (!kids) settled(window.mb.debugVariables(sid, v.ref), "Couldn't read the variables").then(setKids);
  };
  return (
    <>
      <div className="dv-var" style={{ paddingLeft: 10 + depth * 12 }} onClick={toggle} title={v.type ? `${v.name}: ${v.type}` : v.name}>
        <span className="dv-tw">{v.ref ? (open ? "▾" : "▸") : ""}</span>
        <span className="dv-name">{v.name}</span>
        <span className="dv-val">{v.value}</span>
      </div>
      {open &&
        (kids === null ? (
          <div className="fp-note" style={{ paddingLeft: 22 + depth * 12 }}>…</div>
        ) : isErr(kids) ? (
          <div className="fp-note err" style={{ paddingLeft: 22 + depth * 12 }}>{kids.error}</div>
        ) : (
          kids.map((k) => <VarRow key={k.name} sid={sid} v={k} depth={depth + 1} />)
        ))}
    </>
  );
}

function Scope({ sid, scope }: { sid: string; scope: DebugScope }) {
  // the first, cheap scope (locals) opens by itself
  const [open, setOpen] = useState(!scope.expensive);
  const [vars, setVars] = useState<IpcResult<DebugVariable[]> | null>(null);
  useEffect(() => {
    if (open && !vars) settled(window.mb.debugVariables(sid, scope.ref), "Couldn't read the variables").then(setVars);
  }, [open]);
  return (
    <>
      <div className="dv-scope" onClick={() => setOpen((o) => !o)}>
        <span className="dv-tw">{open ? "▾" : "▸"}</span>
        {scope.name}
      </div>
      {open && (vars === null ? <div className="fp-note">…</div> : isErr(vars) ? <div className="fp-note err">{vars.error}</div> : vars.map((v) => <VarRow key={v.name} sid={sid} v={v} depth={1} />))}
    </>
  );
}

/**
 * The debugger for one worktree: controls, call stack, variables, watch and
 * breakpoints. Opening a frame shows its file in the editor.
 */
export function DebugPanel({
  sessions,
  paneSessionId,
  onOpenFrame,
}: {
  sessions: DebugSessionInfo[];
  /** A pane in this worktree: breakpoints are read through it. */
  paneSessionId: string;
  onOpenFrame: (frame: DebugFrame) => void;
}) {
  const debug = useDebug();
  const bp = useBreakpoints(paneSessionId);
  // the session to show: the one the debugger acts on, else the last to end (with how it ended)
  const cur = currentSession(sessions) ?? sessions[sessions.length - 1];
  const [frames, setFrames] = useState<IpcResult<DebugFrame[]> | null>(null);
  const [scopes, setScopes] = useState<IpcResult<DebugScope[]> | null>(null);
  const [watches, setWatches] = usePersisted<string[]>("mb.debug.watch", []);
  const [watchVals, setWatchVals] = useState<Record<string, string>>({});
  const [newWatch, setNewWatch] = useState("");
  // Continue, the steps and Stop: what the debugger refused
  const { run, error, setError } = useAction();
  useEffect(() => setError(""), [cur?.id]);

  const paused = cur ? debug.paused[cur.id] : undefined;
  const selected = cur ? debug.selected[cur.id] ?? paused?.frame ?? null : null;

  // frames of the stopped thread, each time it stops
  useEffect(() => {
    setFrames(null);
    if (!cur || cur.state !== "stopped" || !paused) return;
    settled(window.mb.debugStack(cur.id, paused.threadId), "Couldn't read the call stack").then(setFrames);
  }, [cur?.id, cur?.state, paused]);

  // scopes and watches of the selected frame
  useEffect(() => {
    setScopes(null);
    if (!cur || cur.state !== "stopped" || !selected) return;
    settled(window.mb.debugScopes(cur.id, selected.id), "Couldn't read the scopes").then(setScopes);
    for (const w of watches) {
      settled<IpcResult<{ result: string }>>(window.mb.debugEvaluate(cur.id, w, selected.id, "watch"), "Couldn't evaluate").then((r) =>
        setWatchVals((v) => ({ ...v, [w]: isErr(r) ? `⚠ ${r.error}` : r.result }))
      );
    }
  }, [cur?.id, cur?.state, selected?.id, watches]);

  if (!cur) return null;
  const stopped = cur.state === "stopped";
  const control = (op: string) => run(op, () => window.mb.debugControl(cur.id, op, paused?.threadId));
  const bpList = Object.entries(bp.map).flatMap(([rel, lines]) => lines.map((line) => ({ rel, line })));

  return (
    <div className="dv">
      <div className="dv-bar">
        <span className={`rv-dot ${stopped ? "amber" : cur.state === "running" ? "teal" : cur.state === "ended" ? "grey" : "amber"}`} />
        <span className="dv-title" title={cur.error}>
          {cur.name}
          <span className="dv-state">{stopped ? `paused · ${cur.stopped?.reason ?? ""}` : cur.state}</span>
        </span>
        {cur.state !== "ended" && (
          <span className="dv-ctl">
            {stopped ? (
              <button className="icon" title="Continue (F5)" onClick={() => control("continue")}>▶</button>
            ) : (
              <button className="icon" title="Pause" onClick={() => control("pause")}>⏸</button>
            )}
            <button className="icon" title="Step over (F10)" disabled={!stopped} onClick={() => control("next")}>⤼</button>
            <button className="icon" title="Step into (F11)" disabled={!stopped} onClick={() => control("stepIn")}>↓</button>
            <button className="icon" title="Step out (⇧F11)" disabled={!stopped} onClick={() => control("stepOut")}>↑</button>
            <button className="icon dv-stop" title="Stop debugging (and the service)" onClick={() => run("stop", () => window.mb.debugStop(cur.id))}>■</button>
          </span>
        )}
      </div>
      {cur.error && <div className="fp-note err">{cur.error}</div>}
      {error && <div className="fp-note err">{error}</div>}
      {stopped && cur.stopped?.text && <div className="fp-note warn">{cur.stopped.text}</div>}

      {stopped && (
        <>
          <div className="ex-sec">Call stack</div>
          {frames === null ? (
            <div className="fp-note">…</div>
          ) : isErr(frames) ? (
            <div className="fp-note err">{frames.error}</div>
          ) : (
            frames.map((f) => (
              <div
                key={f.id}
                className={`dv-frame ${selected?.id === f.id ? "on" : ""} ${f.path?.startsWith(cur.worktree + "/") ? "" : "lib"}`}
                title={f.path ? `${f.path}:${f.line}` : "No source"}
                onClick={() => {
                  selectFrame(cur.id, f);
                  if (f.path) onOpenFrame(f);
                }}
              >
                <span className="dv-fn">{f.name}</span>
                <span className="dv-loc">{f.path ? `${baseName(f.path)}:${f.line}` : ""}</span>
              </div>
            ))
          )}

          <div className="ex-sec">Variables</div>
          {scopes === null ? <div className="fp-note">…</div> : isErr(scopes) ? <div className="fp-note err">{scopes.error}</div> : scopes.map((sc) => <Scope key={`${selected?.id}:${sc.ref}`} sid={cur.id} scope={sc} />)}
        </>
      )}

      <div className="ex-sec">Watch</div>
      {watches.map((w) => (
        <div key={w} className="dv-var" style={{ paddingLeft: 10 }}>
          <span className="dv-name">{w}</span>
          <span className="dv-val">{stopped ? watchVals[w] ?? "…" : "—"}</span>
          <button className="icon dv-x" title="Remove" onClick={() => setWatches((ws) => ws.filter((x) => x !== w))}>×</button>
        </div>
      ))}
      <input
        className="dv-add"
        placeholder="Add an expression to watch"
        value={newWatch}
        onChange={(e) => setNewWatch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && newWatch.trim()) {
            setWatches((ws) => [...new Set([...ws, newWatch.trim()])]);
            setNewWatch("");
          }
        }}
      />

      <div className="ex-sec">Breakpoints</div>
      {bp.error ? (
        <div className="fp-note err">Couldn't read the breakpoints: {bp.error}</div>
      ) : bpList.length === 0 ? (
        <div className="fp-note">Click a line number in the editor to add one.</div>
      ) : (
        bpList.map(({ rel, line }) => (
          <div key={`${rel}:${line}`} className="dv-frame" onClick={() => onOpenFrame({ id: -1, name: "", path: `${cur.worktree}/${rel}`, line, column: 0 })}>
            <span className="fp-bp inline" />
            <span className="dv-fn">{baseName(rel)}</span>
            <span className="dv-loc">{line}</span>
            <button className="icon dv-x" title="Remove" onClick={(e) => (e.stopPropagation(), bp.clear(rel, line))}>×</button>
          </div>
        ))
      )}
    </div>
  );
}
