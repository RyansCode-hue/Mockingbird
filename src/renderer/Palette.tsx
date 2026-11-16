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
import { SparkleIcon } from "./Icons";
import { askPlace } from "./assistantModel";

/** The command palette (⌘K) and the how-to-use popup (⌘/). */

// ---- command palette (design 1c) ----
interface PaletteAction {
  label: string;
  kbd?: string;
  run: () => void;
  /** Why it can't be done now: listed, dimmed, with this beside it, and choosing it does nothing. */
  off?: string;
}

/** The app Assistant's row (docs/assistant.md): asks it what was typed. `off`: why it can't, dimmed as an action's is. */
export interface PaletteAsk {
  run: (text: string) => void;
  off?: string;
}

export function CommandPalette({
  sessions,
  steps = [],
  actions,
  onJump,
  onStep,
  onClose,
  ask,
}: {
  sessions: SessionInfo[];
  /** Steps not started yet (W8): listed apart, and picking one shows its card. It never starts one. */
  steps?: readonly SessionInfo[];
  actions: PaletteAction[];
  onJump: (id: string) => void;
  onStep?: (s: SessionInfo) => void;
  onClose: () => void;
  /** Ask Assistant, offered once something is typed. */
  ask?: PaletteAsk;
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
    const sess = rankMatches(q, sessions, (s) => [titleOf(s), s.branch]).map((s) => ({
      kind: "session" as const,
      label: titleOf(s),
      kbd: undefined,
      status: s.status,
      state: statusPhrase(s),
      run: () => onJump(s.id),
    }));
    const planned = rankMatches(q, [...steps], (s) => [titleOf(s)]).map((s) => ({
      kind: "step" as const,
      label: titleOf(s),
      kbd: undefined,
      status: "idle" as const,
      state: "not started",
      run: () => onStep?.(s),
    }));
    const found = [...acts, ...sess, ...planned];
    const text = q.trim();
    const place = ask ? askPlace(q, found.map((r) => r.label)) : "none";
    const askRow = { kind: "ask" as const, label: "Ask Assistant", kbd: "⌘⏎", text, off: ask?.off, run: () => ask?.run(text) };
    const flat = place === "first" ? [askRow, ...found] : place === "last" ? [...found, askRow] : found;
    return { acts, sess, planned, place, askRow, flat, anyFound: found.length > 0 };
  }, [q, sessions, steps, actions, ask]);

  const { sel, onArrow } = useListNav(rows.flat.length, [q]);

  const runRow = (i: number) => {
    const r = rows.flat[i];
    if (!r || ("off" in r && r.off)) return;
    onClose();
    r.run();
  };
  /** ⌘⏎ asks, whichever row is selected, while something is typed. */
  const askNow = () => {
    if (rows.place === "none" || rows.askRow.off) return;
    onClose();
    rows.askRow.run();
  };

  let flatIndex = -1;
  const askRowEl = () => {
    flatIndex++;
    const i = flatIndex;
    const r = rows.askRow;
    return (
      <div key="ask" className={`row ask ${i === sel ? "sel" : ""} ${r.off ? "off" : ""}`} title={r.off ?? "The Assistant works in a sheet at the landscape's right edge"} onMouseDown={() => runRow(i)}>
        <span className="ask-ico">
          <SparkleIcon />
        </span>
        <span className="lab">{r.label}</span>
        <span className="state">{r.off ?? r.text}</span>
        {!r.off && <span className="kbd">{r.kbd}</span>}
      </div>
    );
  };

  return (
    <>
      <div
        className="scrim"
        // closing gives the keyboard back to what had it; the press would otherwise take it to the page after that
        onMouseDown={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
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
                // a held Enter's repeats run nothing: only a fresh press picks a row
                if (e.repeat) return;
                if (e.metaKey) askNow();
                else runRow(sel);
              }
            }}
          />
          <span className="kbd">esc to close</span>
        </div>
        <div className="results">
          {rows.place === "first" && askRowEl()}
          {rows.place === "first" && rows.anyFound && <div className="grp-div" />}
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
          {(rows.acts.length > 0 || rows.sess.length > 0) && rows.planned.length > 0 && <div className="grp-div" />}
          {rows.planned.length > 0 && <div className="grp">Steps not started: show the card</div>}
          {rows.planned.map((r, j) => {
            flatIndex++;
            const i = flatIndex;
            return (
              <div key={`p${j}`} className={`row planned ${i === sel ? "sel" : ""}`} title="Shows its card on the landscape: start it, or forget it, from the card's menu" onMouseDown={() => runRow(i)}>
                <span className={`dot ${r.status}`} />
                <span className="lab">{r.label}</span>
                <span className="state">{r.state}</span>
              </div>
            );
          })}
          {rows.place === "last" && <div className="grp-div" />}
          {rows.place === "last" && askRowEl()}
        </div>
        <div className="pfoot">
          <span>↑↓ move</span>
          <span>⏎ run</span>
          {ask && <span>⌘⏎ ask Assistant</span>}
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
