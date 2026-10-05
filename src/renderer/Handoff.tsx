import React, { useEffect, useState } from "react";
import { isErr, AGENT_NAME, otherAgent, type AgentKind, type SessionInfo } from "../shared/types";
import { baseName } from "../shared/paths";

/**
 * Hand a session's task to the other agent: it reads the conversation and
 * writes a handoff (what's done, what's next), which can be edited before a
 * new session starts from it in the same folder and group.
 */
export function HandoffDialog({
  session,
  onClose,
  onStarted,
}: {
  session: SessionInfo;
  onClose: () => void;
  onStarted: (next: SessionInfo, closeOld: boolean) => void;
}) {
  const from: AgentKind = session.agent ?? "claude";
  const to = otherAgent(from);
  const [text, setText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [closeOld, setCloseOld] = useState(false);
  const draft = async () => {
    setDrafting(true);
    setError("");
    const r = await window.mb.handoffDraft(session.id);
    setDrafting(false);
    if (isErr(r)) return setError(r.error);
    setText(r.handoff);
  };
  useEffect(() => {
    draft();
  }, [session.id]);
  const start = async () => {
    setStarting(true);
    setError("");
    const r = await window.mb.handoffStart(session.id, text);
    setStarting(false);
    if (isErr(r)) return setError(r.error);
    onStarted(r, closeOld);
  };
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>Continue in {AGENT_NAME[to]}</h3>
        <div className="sub-h">
          {AGENT_NAME[to]} reads this session's conversation and writes a handoff: what's done, what's in progress and what's next.
          Edit it if you like; a new {AGENT_NAME[to]} session then starts from it in the same folder ({baseName(session.cwd)}
          {session.branch ? ` · ${session.branch}` : ""}) and group.
        </div>
        <label>Handoff</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder={drafting ? `${AGENT_NAME[to]} is reading the conversation…` : "## Goal\n## Done\n## In progress\n## Next steps\n## Watch out for"}
          style={{ minHeight: 300 }}
        />
        {error && <div className="err">{error}</div>}
        <label className="check-line" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11, display: "flex" }}>
          <input type="checkbox" checked={closeOld} onChange={(e) => setCloseOld(e.target.checked)} />
          Close the {AGENT_NAME[from]} session (it stays under Previous, so it can be resumed)
        </label>
        <div className="row">
          <button className="outline" style={{ marginRight: "auto" }} disabled={drafting} onClick={draft}>
            {drafting ? "Writing…" : text ? "Write it again" : "Try again"}
          </button>
          <button className="outline" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!text.trim() || drafting || starting} onClick={start}>
            {starting ? "Starting…" : `Start ${AGENT_NAME[to]}`}
          </button>
        </div>
      </div>
    </div>
  );
}
