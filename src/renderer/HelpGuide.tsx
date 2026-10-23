/** The how-to-use guide's words (⌘/, in HelpModal): what the app is, its one rule, its views and its keys. */
export function HelpGuide() {
  const keys: [string, string][] = [
    ["⌘K", "command palette — every action, jump to any session"],
    ["⌘N", "new session"],
    ["⌘1–9", "jump to pane 1–9"],
    ["⌥⇥", "next waiting session (oldest first)"],
    ["⌘E", "fullscreen the focused pane; ⌘E again restores (so does esc, outside the terminal and editor)"],
    ["⌘⌃1–4", "arrange the panes in 1–4 even columns"],
    ["drag", "a session onto a pane's edge puts it beside that pane (a preview shows where); onto its middle swaps the two, or opens it as a tab; onto its header opens it as a tab"],
    ["⌥↑ ⌥↓", "move the focused Dashboard card up or down its column, as dragging it does (esc cancels a drag)"],
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
    <>
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
            panes; drag pane headers to rearrange; <b>Full</b> in a pane's header fullscreens it.
            Hover a row or a pane header for its buttons; <b>right-click</b> either (or{" "}
            <b>More</b>) for everything else. <b>Resize a pane from its own right edge, bottom edge, or corner grip</b> —
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
            cmux-style. <b>Create</b>: drag one session row onto another in the same group (or
            right-click a row → <b>Move to group…</b> and name a workspace). <b>Rename</b>:
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
            Both live in <b>Settings → Control room</b> (<span className="kbd">⌘⇧B</span>).{" "}
            <b>Broadcast</b> queues a message to every session and delivers it when each one is
            idle. Editing <b>CLAUDE.md</b> there ends with "Save &amp; re-read in N": every session
            in that repo re-reads it, no restarts.
          </p>
          <div className="help-sec">The other tabs</div>
          <p>
            <b>Dashboard</b> — your ADO board: drag cards up or down a column to reorder them, or to another column; comment, start a session
            from a ticket. <b>WorkTracker</b> — the morning brief, 4pm wrap-up and weekly rollup,
            each in its own pane. <b>Council</b> — several models discuss one idea in rounds until
            they agree; you steer, approve, and have one write up the plan.
          </p>
          <div className="help-sec">Team rooms</div>
          <p>
            <span className="kbd">⇪</span> on a group header shares it as a room; a teammate joins
            with the invite code. The <b>Team</b> view (left bar) shows each room's sessions —
            yours and theirs, live — its artifacts and its chat. <b>Take over</b> continues a
            teammate's session on your Mac. A room linked to a Radley House project has a{" "}
            <b>Board</b>: its backlog and who has claimed what, read with your own builder token
            once you allow it.
          </p>
          <div className="help-sec">After a restart</div>
          <p>
            Sessions from the last run appear under <b>Previous</b> — <span className="kbd">↺ restore all</span>{" "}
            relaunches them with their history (<span className="kbd">claude --continue</span>) back
            into their old grid slots and groups.
          </p>
        </div>
      </div>
    </>
  );
}
