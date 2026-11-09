import { useMemo, useState } from "react";
import { shortReason } from "./TerminalPane";
import { titleOf } from "./appModel";
import type { SessionInfo } from "../shared/types";
import { fmtElapsed } from "../shared/format";
import { Modal, useDialogFocus } from "./Modal";
import { useEscape } from "./useEscape";
import { rankMatches } from "./fuzzy";
import { useListNav } from "./listNav";
import { HelpGuide } from "./HelpGuide";

/** The command palette (⌘K) and the how-to-use popup (⌘/). */

// ---- command palette (design 1c) ----
interface PaletteAction {
  label: string;
  kbd?: string;
  run: () => void;
  /** Why it can't be done now: listed, dimmed, with this beside it, and choosing it does nothing. */
  off?: string;
}

export function CommandPalette({
  sessions,
  shortcuts,
  actions,
  onJump,
  onClose,
}: {
  sessions: SessionInfo[];
  /** ⌘1–9 per session id, as the panes are numbered. */
  shortcuts: Map<string, number>;
  actions: PaletteAction[];
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  useEscape(onClose);
  useDialogFocus();

  const statusPhrase = (s: SessionInfo): string => {
    if (s.status === "waiting")
      return `${shortReason(s.waitingReason)}${s.waitingSince ? ` ${fmtElapsed(s.waitingSince)}` : ""}`;
    return s.status;
  };

  const rows = useMemo(() => {
    const acts = rankMatches(q, actions, (a) => [a.label]).map((a) => ({ kind: "action" as const, label: a.label, kbd: a.kbd, run: a.run, off: a.off }));
    const sess = rankMatches(q, sessions, (s) => [titleOf(s), s.branch]).map((s) => {
      const n = shortcuts.get(s.id);
      return {
        kind: "session" as const,
        label: titleOf(s),
        kbd: n ? `⌘${n}` : undefined,
        status: s.status,
        state: statusPhrase(s),
        run: () => onJump(s.id),
      };
    });
    return { acts, sess, flat: [...acts, ...sess] };
  }, [q, sessions, shortcuts, actions]);

  const { sel, onArrow } = useListNav(rows.flat.length, [q]);

  const runRow = (i: number) => {
    const r = rows.flat[i];
    if (!r || ("off" in r && r.off)) return;
    onClose();
    r.run();
  };

  let flatIndex = -1;

  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div className="palette">
        <div className="inrow">
          <span className="prompt">›</span>
          <input
            autoFocus
            value={q}
            placeholder="Type a command or session"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (onArrow(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                runRow(sel);
              }
            }}
          />
          <span className="kbd">esc to close</span>
        </div>
        <div className="results">
          {rows.acts.length > 0 && <div className="grp">Actions</div>}
          {rows.acts.map((r) => {
            flatIndex++;
            const i = flatIndex;
            return (
              <div key={`a${r.label}`} className={`row ${i === sel ? "sel" : ""} ${r.off ? "off" : ""}`} title={r.off} onMouseDown={() => runRow(i)}>
                <span className="lab">{r.label}</span>
                {r.off && <span className="state">{r.off}</span>}
                {r.kbd && <span className="kbd">{r.kbd}</span>}
              </div>
            );
          })}
          {rows.acts.length > 0 && rows.sess.length > 0 && <div className="grp-div" />}
          {rows.sess.length > 0 && <div className="grp">Jump to session</div>}
          {rows.sess.map((r, j) => {
            flatIndex++;
            const i = flatIndex;
            return (
              <div key={`s${j}`} className={`row ${i === sel ? "sel" : ""}`} onMouseDown={() => runRow(i)}>
                <span className={`dot ${r.status}`} />
                <span className="lab">{r.label}</span>
                <span className={`state ${r.status === "waiting" ? "amber" : ""}`}>{r.state}</span>
                {r.kbd && <span className="kbd">{r.kbd}</span>}
              </div>
            );
          })}
        </div>
        <div className="pfoot">
          <span>↑↓ move</span>
          <span>⏎ run</span>
          <span className="right">⌘K close</span>
        </div>
      </div>
    </>
  );
}

// ---- how-to-use popup (shown once on first launch, then ⌘/ · palette · status bar) ----
export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal className="modal help" onClose={onClose}>
      <HelpGuide />
      <div className="row">
        <span className="kbd foot-hint">reopen anytime with ⌘/</span>
        <button className="primary" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}
