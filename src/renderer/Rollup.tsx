import React, { useEffect, useState } from "react";

/**
 * The weekly rollup: written into the WorkTracker folder from the conversation
 * index, sessions and ticket pipeline, and shown here to read or copy.
 */
export function RollupDialog({ onClose }: { onClose: () => void }) {
  const [weeksAgo, setWeeksAgo] = useState(0);
  const [r, setR] = useState<{ file: string; markdown: string } | { error: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // writing waits on a full index sync: a week picked meanwhile must not show the earlier one's reply
  useEffect(() => {
    let live = true;
    setR(null);
    window.mb.rollupWrite(weeksAgo).then(
      (res: { file: string; markdown: string } | { error: string }) => live && setR(res),
      (err: unknown) => live && setR({ error: `Couldn't write the rollup: ${err instanceof Error ? err.message : err}` })
    );
    return () => {
      live = false;
    };
  }, [weeksAgo]);
  const ok = r && !("error" in r) ? r : null;
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal rollup-dlg" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>Weekly rollup</h3>
        <div className="sub-h">
          Time per ticket and outcomes, from Mockingbird's conversation index, sessions and ticket pipeline — nothing is sent to any session or model.
        </div>
        <span className="seg" style={{ display: "inline-flex" }}>
          <button className={weeksAgo === 0 ? "on" : ""} onClick={() => setWeeksAgo(0)}>This week</button>
          <button className={weeksAgo === 1 ? "on" : ""} onClick={() => setWeeksAgo(1)}>Last week</button>
        </span>
        {r === null && <div className="fp-note">Writing it…</div>}
        {r && "error" in r && <div className="err">{r.error}</div>}
        {ok && (
          <>
            <pre className="rollup-md">{ok.markdown}</pre>
            <div className="pl-dim">Saved to {ok.file}</div>
          </>
        )}
        <div className="row">
          {ok && (
            <>
              <button className="outline" style={{ marginRight: "auto" }} onClick={() => window.mb.revealFile(ok.file)}>
                Show in Finder
              </button>
              <button
                className="outline"
                onClick={() =>
                  navigator.clipboard.writeText(ok.markdown).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    },
                    (err) => setR({ error: `Couldn't copy: ${err instanceof Error ? err.message : err}` })
                  )
                }
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </>
          )}
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
