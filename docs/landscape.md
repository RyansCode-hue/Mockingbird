# The landscape

Status: phase 1 in progress behind Settings → Labs → Landscape; see
[landscape-phase1.md](landscape-phase1.md) for what's built.

The Sessions tab's grid becomes a **landscape**: an infinite surface you pan
and zoom, like a Figma canvas. Sessions are **workspaces** placed on it,
**areas** mark parts of it as a group, and **connections** wire workspaces
together so work and context flow between them.

## Decided

- The landscape replaces the grid. Focusing a workspace fills the window
  (today's ⌘E maximize), so nothing the grid does is lost.
- The first connection types: handoff, context link, feedback loop and shared
  worktree.
- Pipelines ask at each hop by default. A wire can be flipped to automatic once
  it's trusted.
- A team room is a shared area: the same workspaces and layout on both Macs.
  Positions sync; no live cursors in the first version.
- **Placement.** Workspaces go anywhere inside an area and snap to an 8 px grid
  and to their neighbours' edges.
- **Tabs.** The landscape replaces the Sessions tab. Dashboard, WorkTracker and
  Settings stay as tabs; the Collaborate tab goes away, because collabs live on
  the landscape.
- **Closing.** Closing a workspace leaves a ghost card, so a pipeline keeps its
  shape.
- **Collab participants** are headless, each with its own capabilities.
- **Name:** the landscape.
- **Look.** It takes something from each of the three design options:
  - B's chrome at 100% zoom: card workspaces with a header bar, and the group
    bar along each area's top edge;
  - A's wires: thin curves;
  - C's view when zoomed out: solid area patches and compact status cards.
- **Needs you** is a tray that drops down from the top bar. It lists open
  wire gates, permission prompts, proposals and finished workspaces. `N` jumps
  to the next one.
- **Wire states:** idle, ready (waiting on you) and blocked.
- **The pipeline strip** appears in focus only for workspaces that have wires,
  and can be collapsed.
- **Repos.** An area can hold several repos that work together (Backoffice +
  Attune + Client Portal). Each workspace in it picks one of them.
- **Collabs end in either a document or a branch**, whichever fits the work:
  - a collab that only reasoned hands over a document;
  - one that wrote code hands over its branch, with a summary.
- **Room controls are unchanged.** A room's shared area keeps today's
  controls: roles, approvals, take-over and guardrails. A collab in a room is a
  room session like any other.
- **Event triggers** (a PR opens, tests pass) wait for a later phase.
- **Browser workspaces.** A workspace can be a browser, and an agent wired to
  it can see it (below). All browser workspaces share one Mockingbird browser
  profile, kept separate from your Chrome. By default a wire lets the agent
  see and navigate; clicking and typing ask first.
- **Agents can build the landscape.** An agent can propose a new workspace and
  its wire when it sees the need (below).
- **Tools are windows** (design O). Files, Changes, Search, Run & debug,
  Artifacts and room chat open as windows on the landscape, beside the
  workspace they serve, and can be docked to the window's edge (below).
- **Artifacts are a tool window, in every area.** Not a menu in the area
  header, and not only in rooms: a room's area shares its artifacts with the
  room, any other area keeps them on this Mac.
- **Nothing from the sidebar or the room panels is lost.** Every control has a
  home on the landscape (the table under Tools).
- **Actions at any zoom: the selection bar** (design Q). Selecting an area, a
  workspace or several shows a bar of their actions at normal size, however
  far out the view is, so acting never needs zooming in (below).
- **Room tools only in rooms.** Chat, Board, Members and Follow show only for
  an area that is a room, created as one or shared as one later.

## Vocabulary

| Word | Figma's | What it is |
| --- | --- | --- |
| Landscape | Canvas | The surface. One per Mac. |
| Workspace | Frame | One session: Claude, Codex or a terminal. |
| Area | Section | A named rectangle holding workspaces. It is a group. |
| Connection (wire) | Prototype link | A typed, directed link between two workspaces. |

## Workspaces

- **Create.** Right-click empty landscape → New workspace: **Claude**,
  **Codex**, **Terminal**, **Collab**, **Browser**, **From a ticket…** (today's ticket
  popover), **Import…**. It's created where you clicked. Inside an area, it joins that
  area's group and defaults to the area's repo.
- **Size is the terminal's size.** A workspace's width and height at 100% zoom
  set its pty's columns and rows. Zooming only scales it, as a teammate's pane
  is scaled today (`followFixedSize`), so zooming never makes the agent
  redraw. Resizing the workspace does.
- **Semantic zoom.**
  - At 75% and up, workspaces are live terminals you can type into.
  - Between 35% and 75%, they are live but read-only; a click focuses one.
  - Below 35%, each is a card showing the title, a status dot, the last line,
    tokens and the ticket.
  - Cards read the existing cached terminal buffer, so no second xterm is
    needed.
- **Focus.** Double-click a workspace, or select it and press ⌘E or Enter, and
  it fills the window. Esc returns to where you were.
- **Move and arrange.**
  - Drag the title bar to move a workspace, and its edges to resize it.
  - Workspaces snap to an 8 px grid and to their neighbours' edges.
  - Dragging a workspace into or out of an area changes its group.
- **Keyboard.**
  - ⌥ plus the arrow keys moves focus to the nearest workspace in that
    direction.
  - ⌘0 fits everything on screen, ⌘1 goes to 100%, and ⌘K → "Go to…" jumps to
    a workspace or an area.
- **Minimap** in a corner, showing areas as outlines and workspaces as status
  dots.
- **Ghost cards.** Closing a workspace leaves a faded card on the landscape:
  - it shows the title, the last summary, the ticket and its branch;
  - its wires stay in place;
  - **Reopen** resumes its conversation in the same spot;
  - an area's menu has **Clear ghosts**, and a ghost whose worktree has been
    removed offers to start fresh.

## Finding what needs you

- **Needs you tray.** A **Needs you (n)** button in the top bar drops down a
  tray, newest first, listing:
  - open wire gates;
  - permission prompts;
  - agent proposals;
  - workspaces that finished and are now idle.

  Each item has its own action (Send, Allow once / Deny, Create / Dismiss, Go
  there). `N` and ⇧N move the view to the next or previous item.
- **Area badges.** The sidebar and area switcher show a count of waiting items
  per area. A collapsed area keeps its count.
- **Card badges.** A card's footer shows:
  - diff size;
  - tests passing or failing;
  - PR state;
  - cost;
  - a "what it did" line under the header.

  The area header sums these up ("2 working · 1 waiting · 1 blocked · PR #88
  draft") and shows the area's budget.
- **Hover peek.** Below 75% zoom, hovering a card shows a large read-only live
  preview. Space keeps it open, and a click focuses the workspace.

## Arranging

- **Tidy** (T, or the area's hover toolbar) lays an area out left to right
  along its wires; loose workspaces go below. Undo puts them back.
- **Stacks** (⌘G on a selection) pile workspaces into one card with tabs. A
  stack moves, wires and focuses as one. A wire to a stacked workspace attaches
  to the stack and names its tab.
- **Collapse** shrinks an area to a pill showing its name, its number of
  workspaces and its waiting count. **Lock** freezes an area's layout.

## Focus

- **Pipeline strip.** Focusing a workspace that has wires shows a strip of the
  chain's steps: upstream, this one, downstream. Each step shows its status;
  click one, or press ⌥← / ⌥→, to move along the chain. Attached workspaces
  (shared tree terminals, context links) sit at its right end.
  - The strip can be collapsed, and stays collapsed until it's opened again.
  - Workspaces without wires don't show it.
- **Finish step** is in the focused workspace's header.

## First run and empty landscape

- **Migration tour.** Four steps, shown once after the landscape replaces the
  grid:
  1. your groups are now areas;
  2. zoom and focus;
  3. wires;
  4. Needs you.

  Each step spotlights the real thing on your landscape. Skip ends it.
- **Shortcuts sheet** on `?`, with three sections: Move around, Work, Build.
- **Empty landscape** offers Start from a ticket, Pipeline template, New
  workspace and Import, and says right-click works anywhere.

## Collab workspaces

A collab workspace is a conversation in which several agents talk to each
other, and you join in. It's mainly for ideas and business analysis (shaping a
feature before anyone builds it), but it isn't limited to that. It's today's
Council moved onto the landscape.

- **Who's in it.** A cast of participants, each with:
  - an agent and model (Claude or Codex);
  - a role, from a preset or your own: Business analyst, Architect, Skeptic,
    User advocate, Security, QA.
- **What each participant may do.** Participants are headless (they're
  speakers inside the collab, not workspaces), but each has its own
  capabilities, set when you add them and changeable later:

  | Capability | What it allows | Claude | Codex |
  | --- | --- | --- | --- |
  | **Reason** (always on) | Read the conversation and linked context, answer, ask questions. No tools. | no tools allowed | `read-only` sandbox, no shell |
  | **Read code** | Read the area's repo, search it, run read-only git. | `Read`/`Grep`/`Glob`, `Bash(git log/diff/show…)` | `read-only` sandbox |
  | **Write code** | Edit files and commit in the collab's own worktree; pull and push its branch. | `Edit`/`Write`, `Bash(git …)` | `workspace-write`, network for git |
  | **Docker** | Run `docker` and `docker compose` (start services, run tests in containers). | `Bash(docker …)` | `workspace-write` with network, `docker` allowed |

  - **Default capabilities.** Reason only, or Reason and Read code, depending
    on the role preset; for example, the Architect reads code and the Business
    analyst only reasons.
  - **Worktree.** Write code gives the collab one worktree of its own, shared
    by every participant allowed to write.
  - **Permission prompts.** When a participant asks permission for something
    outside its capabilities, an approval card appears in the collab's
    transcript, naming the participant and the command. You allow it once or
    always for that participant, or deny it.
  - **Docker is close to full access to this Mac**: containers can mount any
    folder. It's off by default, shown with a warning on the participant, and
    never turned on for a participant in a teammate's collab from a room.
  - **Shared rules.** The same capability sets back the README's Tooling
    profiles. A workspace can use them too, so a "Reviewer" builder can be
    read-only. The room guardrails (`secrets.ts` deny rules,
    `codexRoomPermissions`) apply on top, always.
- **How it runs.** Each participant gets a short brief. You set the turn order:
  round-robin, or a moderator agent picking who speaks next. A round limit
  stops it, and you can interject at any point; your message is seen by
  everyone.
- **What it reads.** Context links *into* a collab give every participant
  read access, for example to a builder's transcript, a ticket or a repo.
- **What it makes.** The result is a document that gets edited as the
  conversation goes: a plan, a spec, a list of options or acceptance criteria.
  When you approve it:
  - it can become House tickets, as Council does today;
  - it can flow out a handoff wire as the next workspace's prompt;
  - or it simply stays on the landscape as a card.
- **Other uses:**
  - *Review panel:* several reviewers argue over a diff and agree on a
    verdict. It can sit in a feedback loop instead of a single reviewer.
  - *Judge:* the fan-in at the end of a fan-out. N builders tried, and the
    panel picks one.
  - *Tie-breaker:* two workspaces that disagree are both linked into a collab.
  - *Retro:* after a pipeline finishes, the panel reads every step and writes
    up what to change.
- **Display.**
  - At 75% zoom and up, it's a chat transcript with a speaker per line and the
    document beside it.
  - Zoomed out, it's a card showing the topic, its participants, the round
    count and the document's status.
- **Under the hood** it uses Council's engine (`collab.ts`), with participants
  as headless sessions rather than panes.

## Browser workspaces

A browser workspace is a real web page on the landscape: an embedded Chromium
view with its own address bar. The motivating case is turning a design into an
app:

- one browser shows the Figma frame;
- another shows the app's dev server (e.g. `localhost:5173`);
- a builder is wired to both, so it can look at them instead of being told
  what's off.

**Profile.** Every browser workspace shares one Mockingbird browser profile,
so you sign in to Figma once.

- It's separate from Chrome and from your other browsers.
- You sign in yourself, and agents never see cookies or passwords.
- Settings has **Sign out everywhere** for the profile.

**The "sees" wire** (agent → browser) gives the agent tools on the messaging
MCP server, at three levels:

| Level | Tools | Default |
| --- | --- | --- |
| **See** | `browser_screenshot` (at a chosen viewport), `browser_read` (page text and accessibility tree), `browser_console` (errors and logs) | on |
| **Navigate** | `browser_open(url)`, scroll, resize the viewport, reload | on |
| **Drive** | click, type, fill forms, press keys | asks once per wire; localhost only unless a site is allowed on that wire |

- **Signed-in pages.** An agent driving a signed-in page acts as you, which is
  why Drive is off by default and limited to localhost.
- **Downloads, uploads and pop-ups** always ask.
- **Rooms.** A browser in a room's shared area shows its page to the room, but
  only its owner's agents can be wired to it.

**Compare.** An agent wired to two browsers can call
`compare({ design, app, viewport })`.

- Both pages are screenshotted at the same viewport.
- The agent gets the pair plus a diff image and the share of pixels that
  differ.
- That gives a loop to work in: fix, let the dev server hot-reload, compare
  again.
- The browser workspace shows the latest comparison as a small thumbnail.

**Look** (design option J, with pieces of I and K):

- **Header and toolbar.** A browser workspace is a viewport frame with an
  address bar, **Desktop 1440 · Tablet 768 · Phone 390** viewport buttons, and
  a "Builder looking" badge while an agent reads it.
- **A browser can be paired with its design** (a Figma browser): a dashed
  link between the two. The app browser then gets four views:
  - **Live**: the page itself;
  - **Design**: the paired frame;
  - **Diff**: the page, with the regions that differ washed red;
  - **Slider**: design and app on one page, with a handle you drag across.
- **What the agent last looked at** is outlined in dashed amber, with when.
- **Compare history** runs along the bottom: the share that differs now, a
  line of every compare so far, and the regions that still differ, crossed off
  as they're fixed. Clicking a region points the slider at it.
- **More views of the same page** (e.g. Phone 390 beside Desktop) are small
  second views of the same browser, not separate workspaces.

**Later, not in the first version:**

- an onion-skin overlay of the design on the app, for you;
- exact spacing, colours and type from the Figma MCP server when it's
  connected;
- a "Design check" pipeline step that won't pass until the app matches.

**Built on:**

- Electron's `WebContentsView`, with one persistent session partition for the
  profile;
- the page's DevTools protocol (`webContents.debugger`) for screenshots, the
  accessibility tree, console and input.

No external Chrome is involved.

## Agents that build the landscape

An agent can tell when the work needs another workspace and set it up itself,
for example:

- a builder asking for a test runner terminal on its tree;
- a Business analyst in a collab asking for a reviewer;
- a builder splitting off a second builder for the Client Portal half of a
  change.

**How it works.** Two tools on the messaging MCP server:

- `propose_workspace({ kind, agent, role, repo, prompt, capabilities })`;
- `propose_wire({ to, type })`.

**Proposals come first.** A proposal appears next to the agent as a dashed
outline with its reason, the wire it would add and the capabilities it asks
for. **Create** starts it, and **Dismiss** tells the agent no.

- An area can be set to **create without asking** for proposals no more
  capable than the agent making them. The setting belongs to the area, not to
  a pipeline template. Anything more capable always asks.
- **Docker** is never granted without asking.

**Limits.** These are always enforced:

- An agent can't propose a workspace with more capabilities than its own.
- Each area has a cap on the number of workspaces its agents can propose
  (6 by default); a proposal past the cap asks.
- An agent can't propose on a teammate's Mac. In a room, the proposal shows on
  the proposing agent's owner's landscape.
- Each proposed workspace records who proposed it, which shows in its header
  and on its ghost card.

## Areas

- **Make one.** Drag a marquee over empty landscape around some workspaces →
  "Make area…" → name it (e.g. Backoffice). The area is a group: its
  workspaces' `taskGroup` becomes its name, so group usage, status checks,
  agent messaging mode, Follow and the room binding all keep working.
- **Go to one.** The sidebar lists areas, and ⌘K → "Go to…" lists them too.
  Clicking one pans and zooms the view to fit it, with a short motion
  (immediate under reduced motion).
- **Area header.** Today's group bar moves onto the area's top edge:
  - the name, repo chips, the stage chip (or Pipeline for a ticket with no
    stage yet) and usage;
  - Ask for status and Follow;
  - only in a room's area: Chat (opens the chat window), Board, and **Members ▾**
    (design P's menu: presence, Make or remove admin, Hand over ownership,
    Remove, claiming ownership, join requests, backup state, Invite, Follow a
    member, Leave room);
  - **⋯**: Rename, Collapse, Lock, Clear ghosts, Reopen all, the agent-message
    mode, the message log, and Share as a room (Invite for a room).
- **No nested areas.** Today's sub-groups (`top/sub`, the tabbed workspace
  cell) become stacks. A group within a group is a second area beside the
  first.
- **Repos.** An area holds one or more repos, each with its base branch, shown
  as chips in the area header. A new workspace in the area defaults to the
  repo of the workspace you started from, and picks among the others in one
  click. Context links and collabs can read across all of the area's repos.
- A workspace belongs to at most one area. Workspaces outside every area are
  loose (today's "ungrouped").
- **The area tree** replaces the Sessions view in the side bar (designs L and
  M): areas with their waiting counts, their stacks and workspaces, room areas
  marked as shared with who's online. Clicking an area flies there; clicking a
  workspace focuses it. ⌘\ collapses it to the rail.

## Tools

The rail keeps today's views and badges. On the landscape each opens as a
**tool window** (design O) instead of a side bar view:

- **Where it opens.** Beside the selected workspace, scoped to it: Changes and
  Run work on its worktree, Files on its folder. A window opened from an area
  is scoped to the area.
- **Placed or docked.** A placed window sits in its area and moves with it. ⊟
  docks a window to the window's edge, where it stays put while you pan and
  follows the selected workspace; ⧉ places a docked one back on the landscape.
- **The windows:**
  - **Files** (today's Explorer), **Changes** (Source Control, with Second
    opinion, Branch vs base and the graph), **Search** (conversations or the
    workspace's files) and **Run & debug** (services, the debugger, run setup);
  - **Artifacts**: the area's artifacts. Add a file, note, repo file or link;
    per item Open, Mention, Rename, Download, Remove, and **Place**, which puts
    an artifact card in the area. A card opens or mentions it; phase 2 wires it
    to a workspace as a context link;
  - **Chat**: the room's chat, for a room's area;
  - **Editor**: today's editor column, docked right by default.
- **Global stays global.** The log panel (⌘J), the agent message log and
  Broadcast stay where they are.

**The selection bar** (designs Q and Q2) carries the actions of whatever is
selected, at every zoom:

- **Selecting.** Click an area's patch, name or tree row, a workspace or its
  tree row, or drag a marquee over several. Esc clears the selection.
- **What it shows.**
  - An area: its name and status, the room tools if it's a room (Chat,
    Board, Members ▾, Follow), Ask for status, Tools ▾ and ⋯.
  - A workspace: Focus, Changes, Run, Files, Artifacts and ⋯.
  - Several workspaces: Make area…, Stack, Move to area ▾ and Close….
- **Size.** Its width comes from its buttons, never from the selection's width
  on screen. It sits just above the selection at normal size and slides to
  stay inside the window, so far out it overhangs a small area.
- **When it doesn't fit.** In a narrow window, buttons fold behind **» n more**
  in priority order (an area's room tools stay; Follow, Ask for status and
  Tools fold first; a workspace's Focus, Changes and Run stay; ⋯ never folds).
  » extends the bar onto a second row until « Less, and the choice is
  remembered.
- **Right-click** gives the same actions as a menu, at every zoom.
- The bar, the headers, the ⋯ menus and right-click all draw from one list of
  actions per area and per workspace.

**The workspace** carries what the pane header and its rail carry today
(design N):

- **Header chips:** branch, ▶ runs (opens Run), Δ changes (opens Changes),
  model and effort, ticket, the context warning (opens Brief), overlap chips
  (open the Board), the guard chip, muted, backup freshness, the owner,
  lookers and typists, and Take over on a teammate's workspace.
- **Footer cells:** elapsed, git, PR, messages, repo, folder (opens Files),
  queued and tokens.
- **⋯ menu, also on right-click:** Rename, Mute, Move to area, Size S/M/L,
  Repaint, Hide the agent's diff panel, Undo the last turn, Continue in the
  other agent, Fresh session from a brief, Second opinion, Take over / Take it
  back / Send the changes / Review, Close.
- **Notes stay on the workspace:** the stall and waiting banners, typing asks,
  the phone note, and dropping files to type their paths.
- **A dead workspace** stays where it was as a card with Resume and Close &
  clean up.

**Where the rest goes:**

| Today | On the landscape |
| --- | --- |
| Sessions view (groups, sub-groups, rows, filter) | The area tree |
| Connected line, the Team view's room list | Room areas in the area tree, marked shared, with who's online |
| Room header: Show, Invite, New session, Join, Leave | The area header and its ⋯ and Members menus; right-click create |
| A room's artifact shelf | The Artifacts window, in every area |
| Members and roles (chat header, Settings → Team) | Members ▾ in the area header; Settings → Team unchanged |
| Join requests | The Needs you tray and Members ▾; the admin prompt unchanged |
| Backups: freshness, failures, consent | Freshness on the workspace header, failures on the area header, consent unchanged |
| Take-over, Take it back, Send, Review | The workspace's header and ⋯ menu; a ghost continued on a teammate's Mac shows Take it back |
| Previous: relaunch, forget, restore all | Ghost cards (Reopen, Clear ghosts) and Reopen all in the area ⋯ |
| Group bar: message mode, message log | The area ⋯ |
| Council: Open the implementing session | Focuses that workspace on the landscape |

## Connections

Drag from a workspace's edge handle to another workspace, then pick a type.
Right-click a wire to change its settings or remove it. Each wire has:

- **Direction**: from → to.
- **What flows**: a summary, the diff, named files, or a prompt template with
  `{summary}`, `{diff}`, `{ticket}` and `{files}`.
- **When**: manual, or when the source says it's finished.
- **State**, drawn on the wire:
  - **idle**: gray;
  - **ready**: glowing amber, with a gate dot that opens the send popover;
  - **blocked**: dashed red, with the reason on the wire (e.g. "needs
    approve").
- **Gate**: ask (the default) or automatic.

### Handoff

A's result becomes B's next prompt. When A says it's finished:

1. The wire lights up and a popover shows the prompt it will send, which you
   can edit.
2. **Send** delivers it to B and starts B if it isn't running. **Not yet**
   leaves it waiting on the wire.

B's tree depends on how it was created:

- **New workspace from the wire** ("Add next step" on A's handle): B gets a new
  worktree from A's branch.
- **Wiring two existing workspaces**: B keeps its own tree.

### Context link

B can read A without anything being pushed. B's agent gets two tools from the
existing messaging MCP server:

- `read_context(from)`: A's latest summary, and its transcript tail if asked.
- `list_links()`: the workspaces B is linked to.

Only linked workspaces can be read, unlike `list_sessions` today.

### Feedback loop

A reviewer → builder wire with a round limit (3 by default). The reviewer
finishes with a verdict:

- **approve** moves on along the reviewer's handoff wires, if any.
- **changes** sends the reviewer's notes back to the builder, through the gate
  like any handoff.

The round counter shows on the wire. At the limit, it stops and asks you.

### Shared worktree

A terminal attached to an agent workspace, e.g. a dev server or a test
watcher.

- It runs in the agent's worktree and moves with it; it closes when the
  worktree is removed.
- The agent can read its output with `read_terminal(linked)` (the last N
  lines) through the same MCP server.

### What "finished" means

Agents stop many times a turn, so stopping can't be the signal. Instead:

- **The agent says so.** A workspace with outgoing wires is told so in its
  kickoff, and calls `finish_step({ summary, verdict? })` on the messaging MCP
  server.
- **You say so.** Right-click → **Finish step**, or the wire's **Send now** at
  any time, sends the latest summary or a summary you write.

### Pipelines

A chain of workspaces and wires can be saved as a **pipeline template**, for
example Ticket builder (Claude) → Builder (Codex) → Reviewer (Claude, feedback
loop to Builder).

- **Use one.** Right-click → New → **Pipeline from a ticket…** lays the chain
  out inside the ticket's area, with each step's agent, model and kickoff
  prompt.
- **Stages.** Today's per-ticket stages follow it: the stage chip is the
  furthest step that has finished. This is the README's "Pipeline stages that
  update themselves".

## Team rooms

A room is a shared area. Both Macs show it with the same workspaces in the same
layout; where the area itself sits is each Mac's own.

- **Positions.** A workspace's position and size inside the area are a signed
  room event (`layout.set`, last write wins per workspace), relative to the
  area's corner.
- **Wires inside the area** are room events too. A handoff from Nick's
  workspace to Ryan's travels over the room's messaging. The gate is the
  receiving workspace's owner's.
- **Follow** becomes following a teammate's view inside the shared area.

## Migration

The first run lays out each group as an area. Areas sit in rows, in today's
group order.

- A group's split tree becomes the workspaces' positions: `toGrid` fractions
  times a default area size.
- Pinned panes go in their own area like any other workspace: everything is
  on the landscape at once, so pinning has no meaning there.
- Layout moves from localStorage (`mb.trees`, `mb.shown`…) to
  `~/.mockingbird/landscape.json`, because wires and room layout are data, not
  view preferences.
- The old keys are left in place, so an older version still opens with its
  grid.

## Performance

- **Cards at low zoom.** Live xterms are created only for workspaces at 35%
  zoom and up and on screen. Cards render from the cached buffer that's
  already kept (`terms` in `TerminalPane.tsx`).
- **WebGL for live terminals.** Load `@xterm/addon-webgl` for live workspaces;
  it's already a dependency and never loaded today.
- **Gestures don't redraw terminals.** Pan and zoom are a CSS transform on one
  layer, so the terminals aren't re-rendered.

## Phases

1. **Landscape:**
   - workspaces, pan and zoom, semantic zoom, focus, minimap;
   - areas (marquee, go-to, area header, badges, collapse, lock), the area
     tree, right-click create;
   - tool windows, the Artifacts window in every area, the workspace header
     and ⋯ menu;
   - stacks, Tidy, hover peek, card badges;
   - the Needs you tray (permission prompts and finished workspaces for now);
   - migration with its tour, the shortcuts sheet, the empty landscape.

   Ships with no wires.
2. **Context and collabs:**
   - shared worktree terminals and context links, through the messaging MCP
     server;
   - collab workspaces built on Council's engine;
   - agent proposals for workspaces and wires;
   - browser workspaces, the "sees" wire and `compare`.
3. **Pipelines:**
   - handoff, feedback loop, gates and wire states, `finish_step`;
   - pipeline templates and the pipeline strip in focus;
   - wire gates and proposals in the Needs you tray.
4. **Rooms:** shared areas, layout events, wires across Macs.

Phases 1–3 are minors. Phase 4 adds room events an older Mockingbird can't
apply, so it needs both teammates to update and says so in its notes.

## Designs

The design options and idea mocks are on the canvas "Mockingbird Landscape
options":

- the first row holds the three directions: A Frames, B Cards, C Map;
- the second row holds the chosen ideas (D–H);
- the third, browser workspaces (I–K);
- the fourth, the area tree sidebar open and collapsed (L, M);
- the fifth, where the tools go (N–P);
- the sixth, actions at any zoom (Q–S, and Q2 for how the bar sizes).

The look described above, combining all three directions, is the one
chosen. For the tools, O is chosen with two changes: Artifacts is a tool
window rather than a header menu, and the area header takes P's Members menu.
N's workspace header, footer and ⋯ menu are kept. For actions at any zoom, Q
(the selection bar) is chosen.
