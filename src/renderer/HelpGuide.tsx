/** The how-to-use guide's words (⌘/, in HelpModal): what the app is, its one rule, its views and its keys. */
export function HelpGuide() {
  const keys: [string, string][] = [
    ["⌘K", "command palette — every action; Go to a workspace or an area"],
    ["⌘N", "new session"],
    ["⌥⇥", "next waiting session (oldest first)"],
    ["N ⇧N", "the next or previous thing in Needs you"],
    ["⌘E", "focus the selected workspace: it fills the window (Enter does too; esc goes back)"],
    ["⌥ arrows", "select the nearest workspace that way"],
    ["⌘0 ⌘1", "fit everything on screen · 100%, where terminals take typing"],
    ["scroll", "pan (or Space-drag); ⌘-scroll or a pinch zooms about the cursor"],
    ["⌘G", "stack the selected workspaces into one card with tabs"],
    ["⌥↑ ⌥↓", "move the focused Dashboard card up or down its column, as dragging it does (esc cancels a drag)"],
    ["⌘P", "go to a file in the focused session's folder (name:42 jumps to a line)"],
    ["⌘\\", "the area tree to the rail and back"],
    ["⌘B ⌘⇧E", "Files — the selected session's folder"],
    ["⌃⇧G", "Changes — stage, commit, push"],
    ["⌘⇧D", "Run and debug — the selected worktree's services"],
    ["⌘⇧F", "Search — every conversation on this Mac, or the selected session's files"],
    ["⌘J", "the log panel under the landscape"],
    ["⌘⇧B", "control room — broadcast + CLAUDE.md"],
    ["⇧⏎", "newline in a Claude prompt (won't submit)"],
    ["⇧click", "select more than a screen: click where it starts, scroll, shift-click where it ends — it's copied"],
    ["⌥drag", "Option-drag for a plain terminal selection — in a full-screen Claude session a plain drag is Claude's own selection, which Claude copies"],
    ["⌘V", "paste — images land in the prompt as [Image #1]; files can also be dropped onto a terminal"],
    ["⌘/", "this popup"],
  ];

  return (
    <>
      <h3>How to use Mockingbird</h3>
      <div className="sub-h">
        Parallel Claude and Codex sessions on one landscape. Watch them all at once; the app tells you when one needs you.
      </div>
      <div className="help-cols">
        <div>
          <div className="help-sec">The one rule</div>
          <p>
            <span className="dot waiting" style={{ marginRight: 6 }} />
            <b>Amber means a session is blocked on you</b> — a permission prompt or a question.
            Its workspace gets an amber border and a banner saying exactly why, and it's listed in{" "}
            <b>Needs you</b>. Everything else is just status: <span className="dot working" /> working ·{" "}
            <span className="dot idle" /> idle · <span className="dot dead" /> dead. Press{" "}
            <span className="kbd">⌥⇥</span> to jump to whoever has waited longest.
          </p>
          <div className="help-sec">Sessions on the landscape</div>
          <p>
            <b>New session</b> picks a repo, optionally a ticket # — Mockingbird creates a git
            worktree and branch, and launches the agent in it. Each session is a <b>workspace</b>{" "}
            on the landscape, a surface you pan and zoom: at 75% and up its terminal takes typing,
            down to 35% it's live but read-only, and below that it's a card with its title, status
            and last line. Drag a workspace's header to move it, its edges or corners to resize it;
            what it lands on moves aside. Its <b>⋯</b> (or a right-click) has everything else,{" "}
            <b>Rename…</b> among them; <b>double-click its header to focus it</b>. Closing a session
            with unsaved work always asks first — the safe choice is preselected — and leaves a{" "}
            <b>ghost</b> where it was, to reopen.
          </p>
          <div className="help-sec">Areas &amp; stacks</div>
          <p>
            Sessions sharing a ticket # are one group, and each group is an <b>area</b>: a coloured
            region with its name, its ticket's stage, its usage and its room along the top. Drag a
            workspace into or out of an area to change its group, or pick <b>Move to area…</b> on
            its ⋯. The <b>area tree</b> in the side
            bar lists them with their waiting counts: click an area to fly there, a workspace to
            bring it into view. <b>Stacks</b> (sub-groups) put several sessions in one card with
            tabs: <span className="kbd">⌘G</span> on a selection, or <b>New tab…</b> on a
            workspace's ⋯. A stack's ⋯ renames it or unstacks its tabs; drag a tab out to unstack
            that one.
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
            An area's ⋯ shares it as a room; a teammate joins with the invite code. A room's area
            shows who's online, and its <b>Chat</b> window its messages and artifacts; the{" "}
            <b>Connected</b> line under the area tree lists every room. <b>Take over</b> continues
            a teammate's session on your Mac. A room linked to a Radley House project has a{" "}
            <b>Board</b>: its backlog and who has claimed what, read with your own builder token
            once you allow it. <b>Start</b> on a ticket claims it, makes its worktree and starts an
            agent there, briefed on the ticket.
          </p>
          <div className="help-sec">After a restart</div>
          <p>
            Sessions from the last run are <b>ghosts</b> where they were: <b>Reopen</b> on one, or{" "}
            <b>Reopen all</b> in an area's ⋯, relaunches them with their history ({" "}
            <span className="kbd">claude --continue</span>). Closed sessions with no place on the
            landscape are in the <b>Closed sessions</b> list under the area tree.
          </p>
        </div>
      </div>
    </>
  );
}
