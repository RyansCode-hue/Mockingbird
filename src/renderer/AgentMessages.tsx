import React, { useState } from "react";
import type { AgentMessage } from "../shared/types";
import { createIpcStore, loadInto } from "./ipcStore";
import { Modal } from "./Modal";

const messages = createIpcStore<AgentMessage[]>([], ({ get, set }) => {
  loadInto("the agent message log", window.mb.messagesList(), (r: AgentMessage[]) => set(Array.isArray(r) ? r : []));
  window.mb.onMessagesChanged((m: AgentMessage) => set([...get(), m].slice(-300)));
});

/** Every agent-to-agent message (the last 300), oldest first. */
export function useAgentMessages(): AgentMessage[] {
  return messages.use();
}

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/**
 * A key per message, oldest first, that stays with it as newer ones arrive:
 * when it was sent and between whom, numbered when several share those.
 */
export function messageKeys(list: AgentMessage[]): string[] {
  const seen = new Map<string, number>();
  return list.map((m) => {
    const base = `${m.at}:${m.from}:${m.to}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

/** Who told whom what — all sessions, or the ones a session sent and received. */
export function MessageLogDialog({ sessionId, title, onJump, onClose }: { sessionId?: string; title?: string; onJump: (id: string) => void; onClose: () => void }) {
  const all = useAgentMessages();
  const [open, setOpen] = useState<string | null>(null);
  const mine = sessionId ? all.filter((m) => m.from === sessionId || m.to === sessionId) : all;
  const keys = messageKeys(mine);
  const list = mine.map((m, i) => ({ m, key: keys[i] })).reverse();
  return (
    <Modal className="modal msg-log" onClose={onClose}>
      <h3>Agent messages{title ? ` — ${title}` : ""}</h3>
      <div className="sub-h">What sessions have told each other with Mockingbird's send_message tool, newest first.</div>
      {list.length === 0 && <div className="fp-note">No messages yet.</div>}
      <div className="msg-list">
        {list.map(({ m, key }) => (
          <div key={key} className={`msg-row ${m.refused ? "refused" : ""}`} onClick={() => setOpen(open === key ? null : key)}>
            <div className="msg-hd">
              <span className="msg-when">{when(m.at)}</span>
              <a onClick={(e) => (e.stopPropagation(), onJump(m.from))}>{m.fromTitle}</a>
              <span className="msg-arrow">→</span>
              <a onClick={(e) => (e.stopPropagation(), onJump(m.to))}>{m.toTitle}</a>
              <span className="msg-how">{m.outcome}</span>
            </div>
            <div className={`msg-text ${open === key ? "open" : ""}`}>{m.text}</div>
          </div>
        ))}
      </div>
      <div className="row">
        <button className="outline" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
