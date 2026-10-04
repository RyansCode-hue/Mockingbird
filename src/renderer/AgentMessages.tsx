import React, { useState, useSyncExternalStore } from "react";
import type { AgentMessage } from "../shared/types";

// ---- one subscription to the message log, many readers ----
let log: AgentMessage[] = [];
const subs = new Set<() => void>();
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  window.mb.messagesList().then((r: AgentMessage[]) => {
    log = Array.isArray(r) ? r : [];
    subs.forEach((s) => s());
  });
  window.mb.onMessagesChanged((m: AgentMessage) => {
    log = [...log, m].slice(-300);
    subs.forEach((s) => s());
  });
}

/** Every agent-to-agent message (the last 300), oldest first. */
export function useAgentMessages(): AgentMessage[] {
  return useSyncExternalStore(
    (cb) => {
      install();
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => log
  );
}

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Who told whom what — all sessions, or the ones a session sent and received. */
export function MessageLogDialog({ sessionId, title, onJump, onClose }: { sessionId?: string; title?: string; onJump: (id: string) => void; onClose: () => void }) {
  const all = useAgentMessages();
  const [open, setOpen] = useState<number | null>(null);
  const list = (sessionId ? all.filter((m) => m.from === sessionId || m.to === sessionId) : all).slice().reverse();
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal msg-log" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>Agent messages{title ? ` — ${title}` : ""}</h3>
        <div className="sub-h">What sessions have told each other with Mockingbird's send_message tool, newest first.</div>
        {list.length === 0 && <div className="fp-note">No messages yet.</div>}
        <div className="msg-list">
          {list.map((m, i) => (
            <div key={`${m.at}-${i}`} className={`msg-row ${m.refused ? "refused" : ""}`} onClick={() => setOpen(open === i ? null : i)}>
              <div className="msg-hd">
                <span className="msg-when">{when(m.at)}</span>
                <a onClick={(e) => (e.stopPropagation(), onJump(m.from))}>{m.fromTitle}</a>
                <span className="msg-arrow">→</span>
                <a onClick={(e) => (e.stopPropagation(), onJump(m.to))}>{m.toTitle}</a>
                <span className="msg-how">{m.outcome}</span>
              </div>
              <div className={`msg-text ${open === i ? "open" : ""}`}>{m.text}</div>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="outline" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
