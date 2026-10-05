import { useEffect, useMemo, useState } from "react";
import { fmtElapsed, shortReason } from "./TerminalPane";
import { titleOf } from "./appModel";
import type { SessionInfo } from "../shared/types";

/** The command palette (⌘K) and the how-to-use popup (⌘/). */

// ---- command palette (design 1c) ----
interface PaletteAction {
  label: string;
  kbd?: string;
  run: () => void;
}

/** Case-insensitive subsequence match for the palette. */
function fuzzy(q: string, s: string): boolean {
  const qq = q.toLowerCase();
  const ss = s.toLowerCase();
  let i = 0;
  for (const ch of ss) if (i < qq.length && ch === qq[i]) i++;
  return i === qq.length;
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
  const [sel, setSel] = useState(0);

  const statusPhrase = (s: SessionInfo): string => {
    if (s.status === "waiting")
      return `${shortReason(s.waitingReason)}${s.waitingSince ? ` ${fmtElapsed(s.waitingSince)}` : ""}`;
    return s.status;
  };

  const rows = useMemo(() => {
    const acts = actions
      .filter((a) => !q || fuzzy(q, a.label))
      .map((a) => ({ kind: "action" as const, label: a.label, kbd: a.kbd, run: a.run }));
    const sess = sessions
      .filter((s) => !q || fuzzy(q, titleOf(s)) || fuzzy(q, s.branch ?? ""))
      .map((s) => {
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

  useEffect(() => setSel(0), [q]);
  const clamp = Math.min(sel, Math.max(0, rows.flat.length - 1));

  const runRow = (i: number) => {
    const r = rows.flat[i];
    if (!r) return;
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
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, rows.flat.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              }
              if (e.key === "Enter") {
                e.preventDefault();
                runRow(clamp);
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
              <div key={`a${r.label}`} className={`row ${i === clamp ? "sel" : ""}`} onMouseDown={() => runRow(i)}>
                <span className="lab">{r.label}</span>
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
              <div key={`s${j}`} className={`row ${i === clamp ? "sel" : ""}`} onMouseDown={() => runRow(i)}>
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
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const keys: [string, string][] = [
    ["⌘K", "command palette — every action, jump to any session"],
    ["⌘N", "new session"],
    ["⌘1–9", "jump to pane 1–9"],
    ["⌥⇥", "next waiting session (oldest first)"],
    ["⌘E", "fullscreen the focused pane; ⌘E again restores (so does esc, outside the terminal and editor)"],
    ["⌘⌃1–4", "grid columns (also switches pane detail level)"],
    ["⌘P", "go to a file in the focused session's folder (name:42 jumps to a line)"],
    ["⌘B", "show or hide the side bar"],
    ["⌘⇧E", "Explorer — the focused session's folder"],
    ["⌃⇧G", "Source Control — stage, commit, push"],
    ["⌘⇧D", "Run and Debug — the focused worktree's services; swap or side by side"],
    ["⌘J", "the log panel under the grid"],
    ["⌘⇧B", "control room — broadcast + CLAUDE.md"],
    ["⌘⇧F", "search every conversation on this Mac, or the focused session's files"],
    ["⇧⏎", "newline in a Claude prompt (won't submit)"],
    ["⇧click", "select more than a screen: click where it starts, scroll, shift-click where it ends — it's copied"],
    ["⌥drag", "Option-drag for a plain terminal selection — in a full-screen Claude pane a plain drag is Claude's own selection, which Claude copies"],
    ["⌘V", "paste — images land in the prompt as [Image #1]; files can also be dropped onto a pane"],
    ["⌘/", "this popup"],
  ];

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal help" onMouseDown={(e) => e.stopPropagation()}>
        <h3>How to use Mockingbird</h3>
        <div className="sub-h">
          A grid of parallel Claude CLI sessions. Watch them all at once; the app tells you when one needs you.
        </div>
        <div className="help-cols">
          <div>
            <div className="help-sec">The one rule</div>
            <p>
              <span className="dot waiting" style={{ marginRight: 6 }} />
              <b>Amber means a session is blocked on you</b> — a permission prompt or a question.
              The pane gets an amber border and a banner saying exactly why. Everything else is
              just status: <span className="dot working" /> working · <span className="dot idle" /> idle ·{" "}
              <span className="dot dead" /> dead. Press <span className="kbd">⌥⇥</span> to jump to
              whoever has waited longest.
            </p>
            <div className="help-sec">Sessions &amp; the grid</div>
            <p>
              <b>New session</b> picks a repo, optionally a ticket # — Mockingbird creates a git
              worktree and branch, and launches <span className="kbd">claude</span> in it. The grid
              sizes itself to however many sessions you have open. Click sidebar rows to show/hide
              panes; drag pane headers to rearrange; <span className="kbd">⛶</span> fullscreens a
              pane. <b>Resize a pane from its own right edge, bottom edge, or corner grip</b> —
              like a window; neighbors absorb the change (double-click a handle to even out).{" "}
              <b>Double-click any name</b> — pane title or sidebar row — <b>to rename it</b>.
              Closing a session with unsaved work always asks first — the safe choice is preselected.
            </p>
            <div className="help-sec">Groups &amp; sub-groups</div>
            <p>
              Sessions sharing a ticket # group automatically, and <b>the grid shows one group at a
              time</b> — the bar above the grid names it. Click a group header to fill the grid with
              it (other groups collapse — ▸ toggles them individually); click rows to hide/re-show
              panes. <b>Workspaces (sub-groups)</b> put several sessions in <b>one pane with tabs</b>,
              cmux-style. <b>Create</b>: drag one session row onto another in the same group (or use
              a row's <span className="kbd">⤷</span> dialog's sub-group field). <b>Rename</b>:
              double-click the workspace name — in the sidebar or on the pane's tab strip.{" "}
              <b>Dissolve</b>: hover the sidebar workspace label and click ✕ — its sessions stay,
              they just move back up into the group. Drag rows onto any group or workspace header
              to move them between.
            </p>
          </div>
          <div>
            <div className="help-sec">Keyboard</div>
            {keys.map(([k, d]) => (
              <div key={k} className="help-key">
                <span className="kbd">{k}</span>
                <span>{d}</span>
              </div>
            ))}
            <div className="help-sec">Broadcast &amp; CLAUDE.md</div>
            <p>
              Both live in the <b>Settings</b> tab. <b>Broadcast</b> queues a message to every
              session and delivers it when each one is idle (the delivery list shows who got it).
              Editing <b>CLAUDE.md</b> there ends with "Save &amp; re-read in N": every session in
              that repo re-reads it, no restarts. The <b>Dashboard</b> tab is your ADO board —
              drag cards between columns, comment, and start sessions from tickets.
            </p>
            <div className="help-sec">After a restart</div>
            <p>
              Sessions from the last run appear under <b>Previous</b> — <span className="kbd">↺ restore all</span>{" "}
              relaunches them with their history (<span className="kbd">claude --continue</span>) back
              into their old grid slots and groups.
            </p>
          </div>
        </div>
        <div className="row">
          <span className="kbd foot-hint">reopen anytime with ⌘/</span>
          <button className="primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
