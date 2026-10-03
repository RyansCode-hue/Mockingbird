import React from "react";
import type { RunServiceState } from "../shared/types";
import { LogTerm, disposeLog } from "./LogTerm";

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
  const shown = states.find((s) => s.id === active) ?? states[0] ?? null;
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
        {states.map((s) => (
          <div
            key={s.id}
            role="tab"
            aria-selected={s.id === shown?.id}
            className={`bp-tab ${s.id === shown?.id ? "on" : ""}`}
            title={`${s.service} in ${s.worktree}${s.slot ? ` · slot ${s.slot}` : ""} — ${s.status}${s.error ? `: ${s.error}` : ""}`}
            onClick={() => onActive(s.id)}
          >
            <span className={`rv-dot ${{ starting: "amber", running: "teal", stopping: "amber", stopped: "grey", failed: "red" }[s.status]}`} />
            {s.service}
            {worktrees.size > 1 && <span className="bp-wt">{baseName(s.worktree)}</span>}
            {(s.status === "stopped" || s.status === "failed") && (
              <button
                className="bp-x"
                title="Close this log"
                onClick={(e) => {
                  e.stopPropagation();
                  disposeLog(s.id);
                  window.mb.runClear(s.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <span className="bp-spacer" />
        {shown && (shown.status === "running" || shown.status === "starting") && (
          <button className="icon" title={`Stop ${shown.service} (and what depends on it)`} onClick={() => window.mb.runStopById(shown.id)}>
            ■
          </button>
        )}
        <button className="icon" title="Hide the panel (⌘J)" onClick={onHide}>
          ✕
        </button>
      </div>
      {shown ? <LogTerm key={shown.id} id={shown.id} /> : <div className="fp-note">Nothing has run yet — start a service from Run and Debug.</div>}
    </div>
  );
}
