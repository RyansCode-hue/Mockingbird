import React, { useEffect, useRef, useState } from "react";
import { UPDATE_STEPS, type UpdateProgress } from "../shared/types";

/**
 * Updating from the user's clone: the build runs while Mockingbird keeps
 * working, and only "Restart to update" closes it — for a few seconds.
 */
export function UpdatePanel({
  progress,
  current,
  latest,
  onClose,
  onOpenGitHub,
}: {
  progress: UpdateProgress;
  current: string;
  latest?: string;
  onClose: () => void;
  onOpenGitHub?: () => void;
}) {
  const [showLog, setShowLog] = useState(progress.state === "failed");
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  const { state } = progress;
  const target = progress.version ?? latest;

  useEffect(() => {
    if (state === "failed") setShowLog(true);
  }, [state]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [progress.log.length, showLog]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    const r: any = await fn();
    if (r?.error) setError(r.error);
  };

  const mark = (id: string) => {
    if (progress.done.includes(id as never)) return <span className="upd-mark ok">✓</span>;
    if (progress.step === id && state === "failed") return <span className="upd-mark bad">✕</span>;
    if (progress.step === id && state === "preparing") return <span className="upd-mark run">●</span>;
    return <span className="upd-mark">○</span>;
  };

  return (
    <div className="modal-back" onMouseDown={state === "preparing" || state === "installing" ? undefined : onClose}>
      <div className="modal upd-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Update Mockingbird</h3>
        <div className="sub-h">
          {target ? `${current} → ${target}` : `You're on ${current}.`} Mockingbird pulls and builds the new version in your clone while you keep
          working; it only closes when you restart into it.
        </div>

        {state !== "idle" && (
          <ol className="upd-steps">
            {UPDATE_STEPS.map((s) => (
              <li key={s.id} className={progress.step === s.id ? "on" : ""}>
                {mark(s.id)}
                {s.label}
              </li>
            ))}
          </ol>
        )}
        {progress.clone && <div className="upd-clone">Clone: {progress.clone}</div>}
        {state === "failed" && progress.error && <div className="err">{progress.error}</div>}
        {state === "ready" && (
          <div className="upd-ready">
            {progress.version} is built. Restarting closes Mockingbird for a few seconds; your sessions come back and resume their
            conversations. A Collaborate turn in progress is lost.
          </div>
        )}
        {state === "installing" && <div className="upd-ready">Restarting into {progress.version}…</div>}
        {error && <div className="err">{error}</div>}

        {progress.log.length > 0 && (
          <>
            <button className="link upd-log-toggle" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide the log" : "Show the log"}
            </button>
            {showLog && (
              <pre className="upd-log" ref={logRef}>
                {progress.log.slice(-200).join("\n")}
              </pre>
            )}
          </>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          {state === "idle" && (
            <>
              <button className="outline" onClick={onClose}>Close</button>
              {onOpenGitHub && <button className="outline" onClick={onOpenGitHub}>Open on GitHub</button>}
              <button className="primary" onClick={() => act(() => window.mb.updatePrepare())}>Update</button>
            </>
          )}
          {state === "preparing" && (
            <>
              <button className="outline" onClick={onClose} title="The build carries on; the status bar says when it's ready">Hide</button>
              <button className="outline" onClick={() => act(() => window.mb.updateCancel())}>Cancel</button>
            </>
          )}
          {state === "ready" && (
            <>
              <button className="outline" onClick={onClose}>Later</button>
              <button className="primary" onClick={() => act(() => window.mb.updateInstall())}>Restart to update</button>
            </>
          )}
          {state === "failed" && (
            <>
              <button className="outline" onClick={onClose}>Close</button>
              <button className="primary" onClick={() => act(() => window.mb.updatePrepare())}>Try again</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
