/**
 * What changed in each released version, as the top bar's What's new popover
 * shows it, and a short list of what's coming next. The one place release notes
 * live: every version bump adds its entry here in the same commit
 * (test/changelog.test.ts fails when package.json's version has none).
 *
 * Only what a user notices goes in — features, fixes, polish and visual
 * changes; never docs, tests or internal refactors. One plain line each, most
 * important first, at most about eight per version.
 *
 * Backfilled from the version bump commits ("1.4.10", …) and the commits
 * between them. 1.1.1–1.1.4 were never released: the version went from 1.1.0
 * straight to 1.1.5.
 */

export type ChangeKind = "new" | "fix" | "polish" | "ui";

export interface Change {
  kind: ChangeKind;
  text: string;
}

export interface Release {
  version: string;
  /** The day the version was bumped, YYYY-MM-DD. */
  date: string;
  items: Change[];
}

export interface ComingNext {
  title: string;
  text: string;
}

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = { new: "New", fix: "Fix", polish: "Polish", ui: "UI" };

const n = (text: string): Change => ({ kind: "new", text });
const f = (text: string): Change => ({ kind: "fix", text });
const p = (text: string): Change => ({ kind: "polish", text });
const u = (text: string): Change => ({ kind: "ui", text });

/** Newest first. */
export const CHANGELOG: Release[] = [
  {
    version: "1.8.3",
    date: "2026-11-23",
    items: [
      f("Kickoffs and messages typed into Claude no longer sit in its prompt unsent when Claude misses the Enter"),
    ],
  },
  {
    version: "1.8.2",
    date: "2026-11-23",
    items: [
      u("One Orchestrator can take several tickets (+ Another ticket, or ⌘K): one plan, each workspace on one ticket"),
      f("Sessions in one group can message each other again: agents use Mockingbird's send_message, not Claude Code's"),
      f("Needs you: in focus, Go there and N switch focus to the item's workspace and bring its tab to the front"),
      u("Stack tabs can be dragged along their strip to reorder them, on the landscape and in focus"),
    ],
  },
  {
    version: "1.8.1",
    date: "2026-11-19",
    items: [
      f("Agents message only the sessions in their own group; other groups' sessions are hidden and refused"),
      f("Claude panes no longer take Claude Code's built-in messages from other Claude sessions on your Mac"),
      f("Needs you: Go there takes the workspace's prompt or finished turn off the list"),
    ],
  },
  {
    version: "1.8.0",
    date: "2026-11-13",
    items: [
      n("Ask the Assistant in ⌘K: it restarts, starts, moves and checks sessions, with Undo or a card to confirm"),
      n("Standing rules: the Assistant can act when a session finishes, waits on you, exits, or at a set time"),
      n("Sessions can restart in plan, accept-edits, auto or bypass mode, and the workspace shows its mode"),
      n("Settings → Team can run a room's sessions without its sandbox on your Mac: push, gh, MCP and memory work"),
      n("Quitting Claude or Codex (/exit) leaves a terminal in its folder; Resume Claude brings the agent back"),
      n("A focused workspace has browser-style tabs, a shorter ⋯, and Files, Changes and Run docked on its left"),
      f("Switching tabs in a focused workspace no longer asks you to click the landscape before typing"),
      f("Room sandboxes: sessions follow the switch, and Codex outside it can't be messaged by teammates' agents"),
    ],
  },
  {
    version: "1.7.0",
    date: "2026-11-13",
    items: [
      n("The landscape replaces the old Sessions grid: workspaces and areas on one canvas, your groups carried over"),
      n("Wire workspaces together to hand work on, share context or loop for feedback; send when you say or by itself"),
      n("Needs you: approvals, wires ready to send, PRs to merge and plans to lay out, all in one place"),
      n("The Orchestrator reads a ticket or Council plan and proposes workspaces and wires; you choose to lay them out"),
      n("Pipeline templates and Finish step: Orchestrator → Coder → Verifier in one go, each step starting in turn"),
      n("Agents move a ticket's stage, ask you for PRs and draft patch notes; a merged PR can start the next step"),
      n("Helpdesk tasks: a standing Claude in your Chrome for coworkers' requests"),
      n("Room sessions are sandboxed away from your git settings and home folder; both teammates need 1.7 for it"),
    ],
  },
  {
    version: "1.6.0",
    date: "2026-10-27",
    items: [
      n("Start a session from a House ticket: it's claimed, gets its worktree and a briefed agent in one go"),
      n("Rooms have roles: owner, admins and members — right-click a teammate to change theirs"),
      n("Take over an offline teammate's session without a grant; an online one is still asked first"),
      n("Turn an approved Council plan into House tickets: review the drafts, then create them in one click"),
      n("Phone alerts: an iMessage when a session waits on you while you're away (off until you turn it on)"),
      n("A pane warns before its context fills up, with Compact or a fresh session from a brief"),
      n("Token usage per group and per ticket, and a cost check before resuming a big, cold conversation"),
      p("Smoother motion: usage bars, teammates coming online, chat arrivals, hand-overs; offline take-overs need 1.6.0"),
    ],
  },
  {
    version: "1.5.0",
    date: "2026-10-23",
    items: [
      n("Teammates see your room sessions view-only; they ask to type and you allow it per session or for 15 min"),
      n("A take-over needs your OK: hand over live, or allow take-overs while you're away"),
      n("The room's House board is now status columns: drag a ticket to claim, release or move it"),
      n("Drag Dashboard tickets up and down to reorder them; a line shows where they'll land"),
      n("Settings → Team shows recent remote activity on your Mac: typing, messages, take-overs, files"),
      f("Room sessions no longer leave blank space below the input box"),
      f("Quitting with no sessions running finishes at once instead of hanging for 30 seconds"),
      p("Rooms refuse oversized or backdated events; both teammates need 1.5.0 for take-overs and typing"),
    ],
  },
  {
    version: "1.4.12",
    date: "2026-10-20",
    items: [
      p("Sessions show their full colours: every pane runs with COLORTERM=truecolor"),
      f("Panes keep following the latest output and leave no blank space below the input box"),
      f("Status banners float over the terminal instead of resizing it, so Claude stops redrawing"),
      f("A Settings check that fails shows the error and a Retry instead of \"checking…\" forever"),
      f("Stopping or quitting a debug session ends the program it launched; attached ones keep running"),
      f("Grid changes no longer show doubled text in panes that keep their size"),
      p("Animations run about a third slower, and the genie into the folder takes 480 ms"),
      f("A room backup you drop is forgotten before your next turn backs up"),
    ],
  },
  {
    version: "1.4.11",
    date: "2026-10-16",
    items: [
      n("What's new: click the top bar's version for each release's changes, what's next, and to suggest something"),
      n("Dashboard cards show their Azure DevOps tags, and blocked work is marked in red with an \"N blocked\" filter"),
      n("Edit a work item's tags from its dialog, and Mark blocked / Unblock from a card's right-click menu"),
      u("Cards take your board's own card colours and tag colours where Mockingbird can match them"),
      u("After an update the top bar reads \"Updated to …\" until you've seen the notes"),
      f("The Dashboard's board picker no longer stretches its header onto three rows"),
    ],
  },
  {
    version: "1.4.10",
    date: "2026-10-14",
    items: [
      n("Agents in a team room can find and message every session a teammate is watching"),
      f("Repaint redraws a session without wiping its scrollback"),
      f("A relaunched session's terminal has the right size straight away"),
      f("Queued messages reach a session as soon as its agent is ready at its prompt"),
      f("A room file due for a retry mid-transfer is no longer dropped"),
      p("Migration number reservations are capped, and implausible numbers are ignored"),
      p("A take-over's saved conversation is deleted from the worktree once it's no longer needed"),
    ],
  },
  {
    version: "1.4.9",
    date: "2026-10-13",
    items: [
      n("Agents reserve a migration number before adding a migration, so teammates' numbers don't collide"),
      n("Reserved migration numbers show on the House board"),
      n("A heads-up when an agent edits a file a teammate's session is also changing"),
      n("Agents can list a teammate's changed files and read a file's diff"),
      f("Room worktrees get their .mockingbird files whether or not the room has a House project"),
    ],
  },
  {
    version: "1.4.8",
    date: "2026-10-13",
    items: [
      n("Motion: dialogs, menus, popovers and toasts ease in and out"),
      n("Minimizing a pane flies it into its folder in the side bar; restoring brings it back out"),
      n("Settings → Motion: follow macOS, reduce motion, or full"),
      u("Panes open, rearrange and go full screen in place, and session rows slide to their new places"),
      u("Neutral primary buttons and focus ring, higher-contrast text, and a ring around the focused pane"),
      p("Disabled buttons say why, and long dialogs keep their title and buttons in view"),
      f("Quitting always finishes"),
      f("A relaunch under way when a take-over arrives no longer starts a second copy"),
    ],
  },
  {
    version: "1.4.7",
    date: "2026-10-12",
    items: [
      u("Labelled icon buttons and right-click menus, and room sessions live in the Team view"),
      u("Collaborate is now Council, so \"room\" only ever means a team room"),
      n("The usage popover shows how full the focused session's context window is"),
      n("Take over starts a fresh conversation on your own account from a handover brief"),
      n("An agent's House board writes wait for your OK in its pane"),
      p("Private keys, credential-store files and secret notes are asked about and never read by agents"),
      f("Panes keep their scroll position when shown again"),
      f("The status bar's popovers open again"),
    ],
  },
  {
    version: "1.4.6",
    date: "2026-10-12",
    items: [
      n("Room artifacts: share files, screenshots, notes, repo references and links in a team room"),
      n("The Radley House board replaces the plan board: claim, comment on and create tickets from a room"),
      n("Agents can list and read a room's artifacts, and @assistant sees them"),
      n("Room sessions run inline, so teammates can scroll their whole history"),
      n("Scrolling a teammate's session moves only your copy"),
      f("Language servers stop along with everything they started"),
      f("Enter in a rename or add dialog no longer presses the button that opened it"),
    ],
  },
  {
    version: "1.4.5",
    date: "2026-10-08",
    items: [
      n("Joining a team room needs the room's admin to accept"),
      n("Room backups go peer to peer; backing up to GitHub is the admin's choice"),
      f("Leave room says backups on GitHub are deleted only if any were pushed"),
    ],
  },
  {
    version: "1.4.4",
    date: "2026-10-08",
    items: [
      n("Leave a team room, or remove a member as its admin"),
      f("Links never open inside the app; terminal links ask first and open https only"),
      f("Credentials in remote URLs stay out of the room log"),
      f("A staged secret never reaches a room backup"),
      f("A room refuses events whose clock leaps far ahead of it"),
    ],
  },
  {
    version: "1.4.3",
    date: "2026-10-08",
    items: [n("+ New room under Connected creates a team room and starts the session in it"), f("Stopping language servers waits until every one has stopped")],
  },
  {
    version: "1.4.2",
    date: "2026-10-07",
    items: [
      u("A cleaner New session dialog that can start connected sessions"),
      n("Import a conversation into a group or a team room"),
      u("Connected sessions sit below your own groups in the side bar, and + starts a session in a group"),
      f("Quitting no longer crashes the app"),
    ],
  },
  {
    version: "1.4.1",
    date: "2026-10-07",
    items: [
      n("Taking over a session ends the old copy: a connected owner is asked first"),
      n("Take it back: a session you take back backs up its own conversation"),
      f("Codex room sessions can't read secrets"),
      f("Codex room sessions commit and install packages, but never push"),
    ],
  },
  {
    version: "1.4.0",
    date: "2026-10-07",
    items: [
      n("Team rooms: share a group live with a teammate's Mockingbird, peer to peer"),
      n("Room chat with @mentions, agents' updates and @assistant"),
      n("Teammates' sessions show in your side bar and grid, and Follow mirrors their grid"),
      n("Take over a teammate's session from its latest backup"),
      n("Split layouts: drop a pane to split, with no empty tiles"),
      p("Failures that used to pass quietly now say what went wrong"),
      p("Esc closes only the newest dialog or menu"),
    ],
  },
  {
    version: "1.3.2",
    date: "2026-10-05",
    items: [p("Settings → About checks for updates when it opens"), f("Narrow panes stay readable")],
  },
  {
    version: "1.3.1",
    date: "2026-10-04",
    items: [f("Claude panes use Claude's own selection and copy, with Option-drag as a fallback"), f("Paste puts text first")],
  },
  {
    version: "1.3.0",
    date: "2026-10-04",
    items: [
      n("Ticket pipeline: each ticket's stage, its pull requests, and comments you approve"),
      n("Undo an agent's turn: every prompt snapshots the worktree first"),
      n("Language servers for TypeScript, Python and C# in the editor"),
      n("Second opinion: review a branch with the other agent from Source Control"),
      n("Continue in the other agent: hand a session's task over with a summary"),
      n("Scrollback survives restarts"),
      n("Session presets: recurring session setups in one click"),
      n("Conflict early warning when two worktrees change the same file"),
    ],
  },
  {
    version: "1.2.1",
    date: "2026-10-03",
    items: [n("Edit files in the editor, and Close all tabs"), p("Quicker tooltips"), f("Git errors go to the session they belong to")],
  },
  {
    version: "1.2.0",
    date: "2026-10-03",
    items: [
      n("Run and Debug: run a worktree's services, swapped in or side by side"),
      n("A built-in debugger for Python, Node, browser apps and .NET"),
      n("Workbench: an activity bar, an editor column, ⌘P quick open and file search"),
      n("Editor tabs, syntax highlighting and side-by-side diffs"),
      n("Source Control: a commit graph, Pull and Fetch, and generated commit messages"),
      n("Turn the Dashboard, WorkTracker and Collaborate tabs off in Settings"),
      u("A redesigned Explorer"),
      p("Panes show their uncommitted changes, and views refresh when folders change"),
    ],
  },
  {
    version: "1.1.9",
    date: "2026-10-03",
    items: [
      n("Source Control in the side bar"),
      n("Import searches every conversation, any age, Claude or Codex"),
      p("Model lists come from the CLIs themselves"),
      f("Dropdowns open where they should"),
      f("The drag label and outline no longer stick after moving a session"),
      u("Collaborate: access as toggle chips, and Delete room is a button"),
    ],
  },
  {
    version: "1.1.8",
    date: "2026-10-03",
    items: [
      n("The Dashboard shows your team's real Azure DevOps board"),
      n("Search every conversation on this Mac (⌘⇧F)"),
      n("Drag and drop shows where things will land"),
      p("The app stays responsive while git works"),
      u("Collaborate: a resizable room panel, real icons, and models edited in the side bar"),
    ],
  },
  {
    version: "1.1.7",
    date: "2026-10-02",
    items: [
      n("Model requests are harder to miss: the Dock badge, the menu bar and a second notification"),
      n("Each Collaborate room chooses how long requests wait"),
      f("The usage panel's 5-hour row no longer disappears"),
      u("Side bar: × closes everywhere, the ungrouped bucket has a name, and minimizing closes the folder"),
    ],
  },
  {
    version: "1.1.6",
    date: "2026-10-02",
    items: [n("Update Mockingbird from inside the app: it pulls, builds and restarts"), f("Check for updates works with the private repository")],
  },
  {
    version: "1.1.5",
    date: "2026-10-02",
    items: [
      n("Collaborate: approve models' tool calls from the room"),
      n("Models can run tests and builds in a disposable test copy"),
      n("Choose each seat's model, effort and code access"),
      n("An opt-in \"uses Docker\" permission per model"),
      u("A redesigned room: a thread and an inspector, with a Rounds grid"),
      f("Leaving a room no longer crashes"),
    ],
  },
  {
    version: "1.1.0",
    date: "2026-10-01",
    items: [n("Collaborate: rooms where models discuss an idea with you"), n("Each pane resumes its exact conversation after a restart")],
  },
  {
    version: "1.0.3",
    date: "2026-09-25",
    items: [n("Panes scroll their own history, and you can copy more than a screen"), f("Agents' messages wait while you have a draft")],
  },
  {
    version: "1.0.2",
    date: "2026-09-24",
    items: [n("A usage panel for Claude and Codex plan limits"), f("Claude and Codex are found the way the panes find them")],
  },
  {
    version: "1.0.1",
    date: "2026-09-24",
    items: [u("Settings has a category side bar")],
  },
  {
    version: "1.0.0",
    date: "2026-09-24",
    items: [
      n("Claude Code and Codex sessions side by side, each in its own worktree"),
      f("Fixes for nested worktrees, symbolic links and finding Codex"),
      f("Setup no longer hangs"),
    ],
  },
];

/** What's being built next, in the user's words (the README's roadmap has the detail). */
export const COMING_NEXT: ComingNext[] = [
  { title: "Tooling profiles", text: "Choose per project which room tools and guards your agents get" },
  { title: "Closing a room", text: "The room's owner closes it for everyone in one step" },
  { title: "House status follows the PR", text: "A ticket moves to review when its PR opens and onward when it merges" },
  { title: "Review requests", text: "Ask a teammate to review a session's changes; their comments go to your agent" },
  { title: "A prompt queue", text: "Line up instructions that send when a session goes idle" },
  { title: "Room tabs", text: "A team room gets tabs: Chat, Sessions, Artifacts and Board" },
];

/** The entry for `version`, or null when the changelog has none. */
export function releaseOf(version: string, log: Release[] = CHANGELOG): Release | null {
  return log.find((r) => r.version === version) ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-14" as "14 Oct", read as a calendar day (no time zone can move it). */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}
