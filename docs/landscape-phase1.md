# Landscape, phase 1: build plan

Status: S1 (model, store, migration), S2 (the surface, behind Settings →
Labs → Landscape), S3 (semantic zoom and peek), S4 (areas), S5 (tools and
the workspace header), S6a (the selection bar and right-click create), S6b
(moving, resizing, stacks, Tidy, ghost cards) and S7 (Needs you and the card
badges) built; S8 (first run and switching over) next.
The spec is [landscape.md](landscape.md); this file is how its phase 1 gets
built.

Wires now ship with phase 1 in 1.7.0: [landscape-wires.md](landscape-wires.md) is their plan, and it overrides what this file says about them.

Phase 1 replaces the grid with the landscape: workspaces, areas, tool
windows, stacks, the Needs you tray and migration. It has **no wires**; those are phases 2–3.
It ships as a minor release (1.7.0). `landscape.json` is new data, and an older
version ignores it and still finds its grid layout in localStorage, so nothing
breaks for a teammate who hasn't updated.

## How it maps onto today's code

| Today | Phase 1 |
| --- | --- |
| `mb.trees`, `mb.shown`, `mb.pinned`, `mb.groupLayouts` (localStorage, `main.tsx:166-312`) | `~/.mockingbird/landscape.json`, owned by the main process |
| `layoutTree.ts`, `gridModel.ts`, `drawTree` (`main.tsx:928`) | removed at the end (S8); kept until the grid is switched off |
| A group (`taskGroup` string) | An area: a rectangle, repos and options, keyed by that group string |
| A sub-group cell `ws:<top/sub>` with tabs | A stack, the same `top/sub` group, so rooms and usage need no changes |
| The group bar (`main.tsx:2389-2440`) | The area header (the same component, moved out of `main.tsx`) |
| ⌘E maximize (`zoomed`, `main.tsx:190`) | Focus |
| `fit()` → `sessionResize` (`cachedTerm.ts:113,431`) | The workspace's size sets cols/rows; zoom never resizes the pty |
| `followFixedSize` scaling (`cachedTerm.ts:409`) | How every workspace renders at zoom ≠ 100% |
| `terms` cache (`TerminalPane.tsx:65`) | Unchanged; cards and peek read it, live nodes attach it |
| The Sessions side view (`main.tsx:2370-2530`) | The area tree (S4) |
| Explorer, Source Control, Search, Run and Debug, room chat (side views) | Tool windows (S5); the same components inside a window frame |
| A room's artifact shelf (`Artifacts.tsx`) | The Artifacts window, in every area (S5) |
| The pane header and its rail (`TerminalPane.tsx:899-1175`) | The workspace header, footer and ⋯ menu (S5) |

## Data model (`src/shared/landscape.ts`)

```ts
interface Landscape {
  v: 2;                         // raised whenever a field is added (see below); 2 added tools and cards (S5)
  migratedAt?: string;          // set once the grid layout has been read in
  tourDone?: boolean;
  workspaces: Record<string, Placement>;   // by session id; a stack's members have none
  areas: Record<string, Area>;             // by group key
  stacks: Record<string, Stack>;           // by "top/sub" group key
  ghosts: Record<string, Ghost>;           // closed workspaces, by old session id
  tools: Record<string, ToolWindow>;       // tool windows, by id (S5)
  cards: Record<string, ArtifactCard>;     // artifact cards, by id (S5)
}
interface Placement { x: number; y: number; w: number; h: number } // landscape px at 100%, absolute
interface Area {
  x: number; y: number; w: number; h: number;
  repos: { path: string; base: string | null }[];  // null: the repo's own default
  collapsed?: boolean; locked?: boolean;
  autoCreate?: boolean;         // phase 2: agent proposals without asking
}
interface Stack { active: string; placement: Placement } // its members share the one placement
interface ToolWindow { tool: "files" | "changes" | "search" | "run" | "artifacts" | "chat";
  docked: boolean;              // docked: no scope or place of its own; it follows the selection
  session?: string; area?: string | null; placement?: Placement }  // placed: its scope and place
interface ArtifactCard { area: string; artifact: string; placement?: Placement }
interface Ghost { title: string; agent: "claude" | "codex" | "terminal"; cwd: string;
  repoPath: string | null; branch?: string; ticketId?: string;
  conversation?: { agent: "claude" | "codex"; id: string }; summary?: string;
  worktreeRemoved?: boolean; placement: Placement; group: string; closedAt: string }
```

- **The file is checked whole.** A field this version doesn't know makes it
  unreadable, so it's moved aside rather than losing the field on the next
  save. A version that adds a field raises `v`; an older Mockingbird then
  leaves the newer file as it is and keeps that run's changes in memory.
- An area **is** a group: its key is the `taskGroup`, and renaming an area is
  `renameGroup`. Membership is never stored twice; a workspace is in an area
  because its session's group says so.
- **Placement is a hint.** A session with no placement (new, imported, a
  teammate's) is placed by `placeNew` in its area's first free spot.
- **Geometry helpers** go in the same file, as pure functions:
  `snap`, `edgeGuides`, `placeNew`, `fitView`, `colsRows(w, h, cellW, cellH)`
  with its inverse `sizeFor`, and `tidy`.

## Main process (`src/main/landscape.ts`)

- **Reading and writing.** Load on first use; atomic write (temp file +
  rename), within 300 ms of the first unsaved change.
  - Each write is a small patch over IPC (`landscape:update`), not the whole
    file.
  - `landscape:changed` broadcasts the patch to every window.
- **A corrupt file fails loudly.**
  - It's moved aside to `landscape.json.bad-<ts>`, and the error is logged
    with its path.
  - A banner says the layout was reset and where the old file is.
  - It's never silently replaced by an empty layout.
- **A file that can't be read is left alone.** A read error (the disk, too
  many open files) says nothing about what the file holds: it isn't moved, an
  empty stand-in is shown and never saved, and the file is read again with the
  next change. Once it reads, its layout replaces the stand-in, and changes
  made to the stand-in are dropped with a banner, because they were made
  against an empty layout and could put defaults over real placements.
- **Ghosts.** Closing a session writes its ghost, removing a worktree marks it,
  and **Reopen** resumes the conversation through the existing resume path into
  the ghost's spot.
- **Preview.** Add `landscape:get` and `landscape:update` to
  `src/preview/stub.ts`, with a fixture landscape (three areas, a stack, a
  ghost, a teammate's workspace).

## Slices

Each slice lands on `main` behind **Settings → Labs → Landscape** (off by
default) with its tests, so `main` stays shippable and the grid stays the
default until S8.

From S4 on, each slice is also checked against its design boards on the
canvas "Mockingbird Landscape options": screenshots of the preview beside the
boards, with the differences either fixed or listed in the slice's as-built
notes.

### S1 · Model, store, migration (no UI)
- `landscape.ts` (shared and main), IPC, the preview stub.
- `migrateLayout(legacyPrefs, sessions)`, a pure function:
  - each group becomes an area, laid out in rows in today's group order;
  - its split tree becomes placements (`toGrid` fractions × the area's size,
    snapped);
  - sub-groups become stacks;
  - pinned panes go in their own area like any other: everything is on the
    landscape at once, so pinning has no meaning there.
  The legacy keys are left in place.
- Tests:
  - migration from real-shaped prefs: one group, sub-groups, pinned panes
    (placed in their own area), an empty layout, legacy `mb.cols`/`mb.zones`;
  - a corrupt file;
  - patch merging;
  - `placeNew` and `snap`.

### S2 · The surface and live workspaces
- `Landscape.tsx` handles the camera (x, y, zoom):
  - **Pan:** trackpad scroll, Space-drag, or a middle-button drag.
  - **Zoom:** ⌘-scroll, or a pinch (Electron's ctrl-wheel), about the cursor.
  - **⌘0 / ⌘1:** fit everything / 100%.
- The world is one layer with a CSS transform, so pan and zoom don't re-render
  terminals.
- `WorkspaceNode.tsx` has B's header bar (status dot, title, agent chip,
  tokens) and a live terminal body.
  - **Size:** the pty size comes from `colsRows(w, h)`. Fit-driven resizing is
    turned off for landscape holders.
  - **Zoom:** at any zoom the terminal is scaled as `followFixedSize` does.
- **Focus:**
  - Enter or ⌘E fills the window and Esc returns, restoring the camera;
  - your own workspace **reflows** in focus: its pty is resized to the
    window's cols and rows, and Esc resizes it back to its placement's size.
    A teammate's workspace is only **scaled** (`followFixedSize`), because
    resizing it would change their terminal;
  - double-click a header to focus;
  - ⌥ plus the arrow keys moves to the nearest workspace in that direction.
- **Keys:** landscape keys work only while the landscape itself has focus,
  never inside a terminal.
- **`landscape:update`'s reply** is the whole landscape for now. S2 may switch
  it to `{ rev, problems }` once there's a consumer: `landscape:changed`
  already carries each patch.
- Tests:
  - camera math and `colsRows`;
  - a UI test that zooming leaves `sessionResize` uncalled (`window.__mbCalls`),
    while resizing a workspace calls it once;
  - focus there and back.
- **As built:**
  - **Esc in focus.** Esc typed in the focused workspace's terminal is the
    terminal's: agents use it to interrupt, and nothing can tell when they
    need it. ⌘Esc, ⌘E or the header's back button leave focus from
    anywhere, and plain Esc does when the terminal doesn't have the keyboard
    (after a click on the header), as the grid's fullscreen does. ⌘E and ⌘Esc
    are the only landscape keys that work from inside a terminal: no terminal
    program gets ⌘ keys. ⌘E works from anywhere in the window, as the grid's
    does: from inside a workspace (its terminal, say) it focuses that one,
    from anywhere else (the side bar just picked a session) the selected one.
  - **The mouse.** A terminal on the landscape takes the mouse (selection,
    clicks and the wheel reported to its program, its own scrolling) only at
    100% or in focus. Scaled, xterm puts a press on the wrong cell: it
    measures the scaled screen against its unscaled cell. Away from 100% a
    press on a terminal selects its workspace and gives its terminal the
    keyboard, a double-click focuses it, and nothing reaches xterm or the
    pane; a hint over the terminal says to zoom to 100% or focus.
  - **The wheel.** Over the selected workspace's terminal at 100% it scrolls
    that terminal's history; anywhere else, and at any other zoom, it pans.
  - **The measured cell** at 12.5 px with the terminals' 1.4 line height is
    7.525–7.529 × 21 px on 1× and 2× screens. `CELL_ESTIMATE` is 7.53 × 21,
    so every preset holds exactly its cols × rows at the real cell (an M
    agent is 1072 × 928 px for 140 × 42); `test/landscape.test.ts` pins it
    against the measured cells.
  - **A stack's member leaving the front** goes back to the stack's size: in
    focus, the member that filled the window is resized back as another tab
    comes to the front, and the one in front as focus ends.
  - **Places.** A session with no placement gets one from `placeNew` (its
    group gets an area beside the others when it has none) and it's saved,
    except while the grid's layout hasn't been read in or the file has a read
    problem. A corrupt file that was moved aside isn't one: the layout really
    starts over, so the grid's is read in and places are saved.
  - **A file that can't be read** is asked for again every 20 s while its
    problem stands, and on the banner's Read it again; once it reads, the
    store drops the stand-in's changes and says so (S1's rule).
  - **Teammates' sessions that don't load** hold up reading the grid's layout
    in, with a banner: Try again, or Continue without teammates' sessions.
    Without them, their workspaces are placed by `placeNew` as they come,
    and the grid's places for them aren't counted as stale. Once
    `team:live` answers, every teammate's session is in it: main indexes them
    from the saved rooms as it starts.
  - **A reveal** (the side bar, ⌘K, a notification) of a session whose
    workspace isn't in the layout yet, one just made, is kept and tried again
    as the layout changes, for 5 s.
  - **The grid's prefs** (`mb.shown`, `mb.trees` and the rest) aren't written
    while the landscape shows, and its show, hide and pin actions are hidden:
    turning the landscape off brings the grid back as it left it.

### S3 · Semantic zoom and peek
- **Zoom bands:**
  - 75% and up: live and typeable;
  - 35–75%: live and read-only;
  - below 35%: cards (C's look).
- **Cards render from the cached buffer:** the last line, status and tokens.
  Only workspaces that are on screen and in the live bands get an xterm
  element attached.
- **Load `@xterm/addon-webgl` for live workspaces,** falling back to the DOM
  renderer with a logged reason if WebGL context creation fails.
- **Hover peek:** the cached terminal moves into the popover read-only, and the
  card shows a snapshot meanwhile. Space keeps the peek open, and a click
  focuses the workspace.
- **Tests:**
  - the zoom band edges;
  - the number of attached xterms when 30 workspaces are off screen;
  - peek attaching the terminal and handing it back.
- **Performance check:** 30 workspaces at 100%, 60%, and 30% → frame time
  measured with `?measure`.
- **Left from S2:**
  - every workspace mounts a whole `TerminalPane`, each with its own timers
    (git and PR reads are off at density "min", but each pane keeps its
    ticker). Cards and off-screen detaching should mount far fewer;
  - the mouse at zoom other than 100%: correcting xterm's coordinates for the
    scale (instead of turning the mouse off there) is a possible later
    improvement, once the live and read-only bands settle where it matters.
- **As built:**
  - **The bands** live in `landscapeModel.ts`: `BAND_LIVE` 0.75, `BAND_CARDS`
    0.35. Entering a band takes its own edge (75% and up is always live); a
    band is kept zooming out until the zoom is `BAND_SLACK` (4%) past its
    edge. Into cards is at once, since it only lets terminals go (a first
    fit or ⌘0 would otherwise attach everything a zoom-out brings on screen);
    any other band once the zoom has rested `BAND_SETTLE_MS` (150 ms) since it
    last moved, the timer starting again with every change. The band is a
    class on the viewport (`ls-band-live|readonly|cards`).
  - **What attaches.** A workspace gets a `TerminalPane` (and its xterm) only
    in the live and read-only bands and only while on screen, counting a
    quarter of the viewport past each edge (`ON_SCREEN_MARGIN`); at 75% and
    up the selected one too, so the keyboard stays in it while it's panned
    away. The focused one is always live, and while one is focused nothing
    behind the overlay is attached. Everything else is a card (cards band,
    on screen) or a bare frame (`still`). Only a band change or a workspace
    coming on screen or leaving it re-renders the workspaces. What's on
    screen is looked at as the camera pans, but while the zoom moves in a
    band with terminals it waits for the zoom to rest: a pinch attaches
    nothing it passes, in any band (from 100% to 25% at most the 5 attached
    at 100% stay until the cards band lets them go; with the wait taken out,
    16 were attached on the way).
  - **Nothing unmounted runs a timer.** The ticker, git and PR reads and the
    folder watch belong to the `TerminalPane`, which cards and frames don't
    mount. The terminal itself is made apart from any pane (`termFor`), so a
    card can read one no pane has opened, and the data pump keeps every
    buffer current.
  - **No band change resizes a pty.** A terminal nothing attaches is kept at
    its workspace's size by `holdSize` (colsRows at the cell landscape
    terminals measure), so attaching it finds its pty at that size. Before
    any has been attached, that cell is measured once in a terminal opened
    off screen at the same font (`landscapeCellReady`) rather than guessed,
    so each pty is told one size from the start. And a landscape pty is sized
    by the font's cell as the DOM renderer lays it out (`fontCell`), whichever
    renderer draws it: WebGL floors the character's width to device pixels
    (7.5 px at 2×, 7 at 1×), which would otherwise give more columns.
  - **A teammate's terminal is at its owner's size** whatever shows it: made
    at it (`termFor`), and kept there as the owner resizes by `followOwners`
    (from `main.tsx`, on every session list) when no pane follows it: as a
    card, peeked, off screen, or in a hidden grid group. Their output is
    drawn for that width; parsed at xterm's default 80 × 24 its cursor
    moves landed in the wrong cells for good. Their pty is never resized.
  - **A restart's new terminal reaches the card.** Restart all (and a pane's
    restart) disposes the session's terminal and bumps `termKey`; the card
    and its size hold are keyed by it, so they take up the new terminal
    rather than reading the disposed one.
  - **Cards (C)** show the status dot, title and ticket; the "what it did"
    line; and the agent chip, status, a stack's tab count or a teammate's
    name, and tokens. Their type keeps its size on screen (`--ls-inv`, set
    with the areas'), and areas are solid patches in the cards band until S4's
    `AreaFrame`. The line is `lastMeaningfulLine` of the cached buffer's last
    40 lines, read again 500 ms after output arrives: the newest line with a
    letter or digit (so no blank, spinner-only, rule or empty-box line), the
    agent's own frame left out first. That frame is found by the CLI's prompt
    mark, so a draft of any height is left out: Claude Code's input is the
    rule over a line starting `❯` (or `>`, after a box's side) down, with a
    status pinned right over it when it runs full screen; Codex's composer is
    the lowest line starting `›` down (a draft or the placeholder, and the
    footer). Without a mark, the rules near the bottom, as before. Checked on
    the real Claude Code (inline at 60 and 100 columns, full screen) and Codex
    screens in `test/fixtures/agentWraps`. An exited session's card reads its
    saved output once, and says so when that fails.
  - **WebGL** (`termGl.ts`) draws every attached landscape terminal and the
    peek; the grid keeps the DOM renderer. At most `GL_MAX` (12) at once, and
    at most `GL_PER_FRAME` (2) made a frame, so a band change attaching eight
    terminals spreads their contexts over four frames (they draw with the DOM
    renderer meanwhile). Past the cap a terminal draws with the DOM renderer
    and takes the next context given up. A context given up is lost at once
    (`WEBGL_lose_context`): the addon's dispose leaves it to the garbage
    collector, and Chromium counts it against its ~16 until then. A context
    that can't be made, or is lost, means the DOM renderer too. Each is said
    once per session and reason, with the session id. A terminal whose
    context couldn't be made isn't tried again: the addon leaves its link
    layer's canvas and listeners behind on a failure (the canvas is taken
    out). The preview's headless Chrome has WebGL2 (ANGLE on Metal), so the
    WebGL path is what the tests run; `?glMax=<n>` and `?glFail` exercise the
    cap and the fallback, and the preview counts the contexts not yet lost.
    Copy-on-select and the agent wrap-join read the buffer, so they're the
    same under WebGL (`?copyAudit` with `?labs=landscape`).
  - **The read-only band** takes no keys: a press on a terminal selects its
    workspace and the landscape keeps the keyboard, a double-click focuses,
    and a terminal that had the keyboard as the zoom went down gives it back.
    Between 75% and 100% a press still gives the terminal the keyboard, as in
    S2; below 75% it no longer does, and the S2 mouse audit expects that.
  - **The peek** opens after the pointer rests `PEEK_HOVER_MS` (600 ms) on a
    card or a read-only workspace (never while dragging, panning with Space
    or a button held, never at 75% and up, never for an exited session).
    It's the workspace at its 100% size, shrunk to fit 80% × 86% of the
    viewport and centred on it. Its terminal is lent (`lendTerm`) once the
    workspace's pane has let it go, at its own cols × rows with its font
    fitted to the box, and handed back while the peek is still in the page,
    its font put back where xterm can measure it. A read-only workspace
    shows its screen as text meanwhile, taken again when a kept-open peek
    crosses into the read-only band; a card stays a card.

    Until it's kept open, the pointer leaving its workspace closes it. The
    peek covers its workspace, so a move over the peek counts by what's
    under it at the pointer (`elementsFromPoint`, past the peek): hovering
    the peek holds nothing open, and moving across it onto another workspace
    closes it and starts that one's rest. The peek still takes clicks: a
    click keeps it open, as Space does. A kept-open peek stays as the
    pointer moves anywhere; its wheel scrolls its terminal's history
    (`scrollTerm`: the view only, so nothing reaches the program), and a
    zoom over it is the landscape's. Space again, Esc, a press off it, or
    (until it's kept open) moving the camera closes it; a dialog or menu
    open over it has Space and Esc first. Its stack bringing another tab to
    the front, or a restart giving the session a new terminal, ends it. A
    double-click on it, or Enter while it's kept open (even aimed at its
    terminal), focuses the workspace. It fades and scales in under full
    motion and appears at once under reduce.
  - **A lent terminal never takes the keyboard.** `focusTerm` (a jump to the
    session: ⌥⇥, ⌘K, a notification) gives it to the landscape instead; the
    terminal can't be tabbed to; a focus that reaches it anyway is stopped
    before xterm sees it (xterm would send a focus report to a program that
    asked for them); and a key aimed at it is the landscape's.
  - **Performance**, 30 workspaces (`?landscapeMany=30`, seven agents' spinners
    redrawing) in headless Chrome at 1400 × 900 (`?landscapePerf`), two runs
    each at 1× and 2×, S2 (5fae805) against S3:

    | | S2 | S3 |
    | --- | --- | --- |
    | xterms mounted at 30% / 60% / 100% | 30 / 30 / 30 | 0 / 8 / 4 |
    | DOM elements at 30% / 60% / 100% | 4878 | 1131 / 1281 / 1229 |
    | panning and pinching: frame interval p95 / max | 16.8 / 16.8 ms | 16.8 / 16.8 ms |
    | panning: main thread per frame, mean / p95 | 2.0–3.2 / 3.2–5.2 ms | 2.7–4.0 / 5.5–11.8 ms |
    | at rest: main thread per frame, p95 | 2.3–5.0 ms | 2.6–4.1 ms |
    | startup: long frames | 3, 340–345 ms in all | 1–2, 62–150 ms in all |
    | sweep 100% → 30% → 100%: worst frame | 16.8 ms | 16.8 ms |

    Both hold the display's 60 Hz while panning and pinching at every zoom,
    so this machine shows the gain as headroom (a quarter of the DOM, a
    fraction of the terminals) and a quicker start, not as faster frames.
    A pan at 60% or 100% costs S3 more main thread at the 95th percentile:
    it attaches the workspaces it brings on screen. The sweep had one long
    frame (58–75 ms) before a band waited for the zoom to rest and contexts
    came two a frame: the zoom-out had attached what it passed (16 to 19
    terminals) and made their contexts at once.
  - **Preview:** `?landscapeMany=<n>`, `?landscapePerf`,
    `?landscapeZoomAudit`, `?landscapePeekAudit`, `?landscapeRemoteAudit`,
    `?landscapeRestartAudit`, `?lsPeek=<id>[,pin]`, `?glMax`, `?glFail`.
    Restart all relaunches sessions in place, as main's does. The S2 audits
    start at 100% and bring each workspace into view before measuring it,
    since only workspaces on screen have a terminal.
  - **Left for S4 and later:**
    - `teamLiveView` should report the workspaces on screen: `keysOnScreen`
      (`seen` in `Landscape`) is that list;
    - a collapsed area's workspaces should count as off screen, and the
      go-to-area fly should go through `apply` so the band and what's on
      screen follow it (a fly through the read-only band attaches only where
      it ends);
    - S4's marquee and S6's drags start with a press, which already ends a
      peek and its hover; they should also hold the peek off while they run;
    - S7's badges and its transcript-based "what it did" line go on the card;
    - correcting xterm's mouse coordinates for the scale (left from S2).

### S4 · Areas
- `AreaFrame.tsx`:
  - a solid patch when zoomed out, a dashed outline and header at 100%;
  - the group bar is extracted from `main.tsx` into `GroupBar.tsx` and becomes
    the area header: the name, repo chips (several repos per area), the stage
    chip or Pipeline button, usage, Ask for status and Follow;
  - in a room's area: Chat, Board and **Members ▾** (design P: presence, Make
    or remove admin, Hand over ownership, Remove, claiming ownership, join
    requests, backup state and failures, Invite, Follow a member, Leave room),
    the same actions as `Team.tsx` and `RoomChat.tsx`, not copies of them;
  - **⋯**: Rename, Collapse, Lock, the agent-message mode, the message log,
    and Share as a room (Invite for a room). Clear ghosts and Reopen all join
    it in S6.
- **Make an area:**
  - a marquee selection, then M or the **Make area…** button, gives a name, and
    `setGroup` moves the selection into it;
  - dragging a workspace across an area's edge sets its group, with the area
    highlighted on hover;
  - the marquee holds the peek off while it runs (left from S3).
- **The area tree** (designs L and M) replaces the Sessions view while the
  landscape shows: areas with waiting counts, their stacks and workspaces;
  room areas marked shared with who's online (today's Connected line); the
  filter box. Clicking an area flies there, clicking a workspace focuses it,
  ⌘\ collapses it to the rail. The grid keeps the Sessions view.
- **Go to an area:** the area tree, the area switcher and ⌘K "Go to…" fly the
  camera there through `apply` (left from S3), ending immediately under
  reduced motion. Check it with `?motionAudit`.
- **Minimap** in a corner: areas as outlines, workspaces as status dots, the
  view as a rectangle you can drag.
- **The area's hover toolbar:** Collapse (to a pill that keeps its counts),
  Lock and Tidy (S6). A collapsed area's workspaces count as off screen (left
  from S3).
- **Rooms:**
  - a room's group is an area like any other, its layout local in phase 1;
  - a teammate's sessions appear in it through `placeNew`;
  - Follow keeps following the teammate's focused workspace;
  - `teamLiveView` reports the workspaces on screen (`keysOnScreen`), not the
    grid's `shown` (left from S2), since that decides which teammates'
    sessions stream here.
- **Overlap:** areas don't overlap; making or moving one that would is pushed
  clear, and the migration's rows already keep them apart.
- **Tests:**
  - marquee → area → `setGroup` calls;
  - dragging across an edge;
  - rename;
  - collapse and lock;
  - a remote session landing in a room area;
  - the area tree's contents and its fly-to;
  - Members ▾ actions reaching the same room calls as the Team view;
  - `teamLiveView` following what's on screen.
- **As built:**
  - **An area** (`AreaFrame.tsx`) is drawn three ways. In the live and
    read-only bands it's a dashed outline in its accent with the header bar
    along its top edge (B). In the cards band it's a solid patch (7.5% of the
    accent) with its name line just above it (C). Collapsed, it's a pill (E)
    with its workspace count, waiting badge, lock and ▸; a click opens it
    again. Its type keeps its size on screen: the header and the pill scale by
    `--ls-hs` (1 / zoom, never below 1) and the name line by `--ls-inv`, set
    by `paintScale` with the camera. Zoomed out, the header grows up from the
    area's top edge rather than down over its workspaces. The accent is one of
    six (`ACCENTS`), given by `accentsOf`. Each area takes its key's hashed
    colour (`accentOf`) unless an area whose key sorts before it already has
    that colour; then it takes the next free one. So up to six areas all
    differ, every window with the same areas agrees, and the area, the tree,
    the switcher and the minimap all use the same colour.
  - **The header** (`GroupBar.tsx`): the grid's group bar was moved out of
    `main.tsx`. The grid's `GroupBar` and the landscape's `AreaHeader` take the
    same `GroupBarProps`, built once by `groupBarProps` in `main.tsx`.
    `AreaHeader` shows:
    - the name and a lock when locked;
    - the area's repo chips;
    - the stage chip (`stageChip`, which drops the ticket number when the
      title already starts with it) or Pipeline;
    - what its sessions are doing;
    - for a room: Chat · n (`RoomChatChip`'s area form), Board and Members ▾;
    - Follow, the usage, Ask for status and ⋯.

    A container query hides the usage and the summary when the header is
    under 820 px, and the repos under 560 px. The name keeps at least 80 px.
    A press on the header's bare part moves the area.
  - **⋯ and right-click** (`areaMenu` in `main.tsx`, also on the tree's area
    rows) offer:
    - Rename…, Collapse to a pill (or Open the area), Lock its layout;
    - the three agent-message modes (the current one ticked) and Agent
      message log…;
    - Share as a team room… (Invite a teammate… for a room);
    - New session here… and Ask for status;
    - Remove the area, once no session is in it.

    The menu has no Artifacts entry; that's S5.
  - **Members ▾** (`team/MembersMenu.tsx`, design P) lists the room's
    members, each with:
    - presence: "online · watching <title>" from the room's live views, or
      "offline 2h" from the peers;
    - a role chip.

    Clicking a member shows the actions `Team.tsx`'s `useMemberActions` gives
    it: Make or remove admin, Hand over ownership, Remove from the room…. The
    room view's member list uses the same hook. `RoleNotice` handles claiming
    ownership. Below the members:
    - join requests (Review opens the join dialog) and requests passed to an
      admin;
    - the backup line and `RoomBackupWarnings`;
    - Invite…, Follow <name> and Leave room… (`LeaveRoomDialog`).

    It opens in `AnchoredPopover` (`Popover.tsx`), drawn over everything at the
    button's place on screen, so it keeps its size while the button sits in
    the scaled world. A press or wheel outside, Escape, a resize or the window
    losing focus closes it. It listens for `pointerdown` as well as
    `mousedown`, and so does the ⋯ menu (`ContextMenu.tsx`). A press the
    landscape takes for itself (a pan, a scaled terminal, the minimap) calls
    `preventDefault` on it, and the browser then sends no `mousedown`.

    Its dialogs (Remove from the room…, Hand over ownership…, Leave room…,
    Claim ownership…) are shown by `main.tsx`, not by the menu. Inside the
    header they'd be inside the landscape's scaled world, under its later
    workspaces, and gone with the header when the zoom or a collapse takes it
    away. `useMemberActions(room, open)` and `RoleNotice`'s `onClaim` hand the
    dialog to `MemberDialogs` (`Team.tsx`). That shows the Team view's own
    dialogs, `ClaimOwnershipDialog` included (taken out of `RoleNotice`). Each
    gets the room as it is now, or as it was asked for once it's gone.
  - **Gestures** start from one capture `pointerdown` on the viewport:
    - over the bare landscape, a marquee (Shift adds to the selection; a
      Shift-click toggles one workspace);
    - on a workspace's header or a card, a workspace drag;
    - on an area's bare header or name line, an area drag.

    A press becomes a drag after `DRAG_PX` (4 px), followed by window
    listeners. The elements move by `translate` until the layout has them
    where they were dropped (`Settling`, or `SETTLE_MS` at most), so nothing
    jumps back while the store's write goes round. Esc cancels. A new press
    ends a gesture whose release was lost. While a gesture runs, the peek and
    its hover are held off (left from S3).
  - **Plans** (`landscapeModel.ts`): `planMakeArea`, `planMoveTile` and
    `planMoveArea` each return an `AreaPlan`, applied in three steps:
    1. a landscape patch with every new place;
    2. the `setGroup` calls;
    3. `after`, which lets a stack's old key go.

    The patch goes first because a workspace whose group changed first would
    be placed again by `resolveLayout`, and that place saved, racing the
    gesture's. A plan can also be refused, with a note shown for `NOTE_MS`.
    A refused move leaves the workspace where it was:
    - a teammate's workspace into another area ("Nick Smith's workspace
      moves to another area only on their Mac");
    - anything into, out of or within a locked area;
    - a stack going loose.

    The `setGroup` calls (`runMoves`) go one at a time, and the first failure
    is said with how many had moved. Its places are then put back (`undoOf`):
    everything the patch changed when none had moved, otherwise the places of
    the sessions still in their old groups. Left alone, they'd sit inside an
    area they aren't in.
  - **Areas never overlap or nest** (`shared/landscape.ts`):
    - `areaAround` forms an area around workspaces;
    - `clearOf` moves an area to the nearest clear spot on the grid;
    - `pushAside` pushes the areas in a growing area's way aside, with their
      workspaces and ghosts (and, since S6a's review fixes, what's in no
      area, which stays in none).

    An area moves with everything inside it. That includes the places of
    sessions that aren't shown (waiting to be resumed) and of stacks none of
    whose sessions are, so a relaunched session comes back inside its area.
    Those places also stay taken when workspaces join an area.

    Lock freezes an area's layout: its workspaces keep their places, and
    none are dragged, moved or resized into, out of or within it (a new
    session of its group still joins it). The area itself is pushed aside as
    a whole like any other, everything in it moving by the same step, and an
    area that grows never moves. Dragging a locked area by its name is still
    refused. (Changed in S6a's review fixes: a locked area stayed put,
    `pushAside` taking it as fixed, a gesture growing an area into one was
    refused, and an area growing for a new session moved clear of everything
    instead.)

    A workspace dropped past an area's right or bottom edge grows the area. A
    loose workspace dropped over the bare landscape is kept clear of the
    areas, a collapsed one's whole rectangle included, not only its pill.
  - **Make area…:** a marquee picks every workspace any part of which it
    touches, as in Figma. A bar then says "N selected · Make area… M · ✕".
    M or the button asks for a name in the rename dialog ("Make an area of N
    workspaces"), sanitized as a group name is. A name that's already an
    area's joins that area, placed as new workspaces are, and the area grows
    to hold them.
  - **Renaming keeps the area.** Main's `renameGroup` calls
    `LandscapeStore.groupRenamed` (`renameAreaPatch`), which re-keys the area,
    its stacks and ghosts.
    - If no window has read `landscape.json` this run (the landscape is off),
      it's read for this. With no file, nothing is written; a file that can't
      be read is logged and left alone.
    - Renaming onto an area that's already there merges into it. The places
      of the old group's sessions are dropped, and so is every place inside
      the old area (teammates' and resumable sessions', which main's list
      doesn't name), so each is placed in the merged area.
    - A failure here is logged, and the rename itself still goes through.

    The renderer gets the new session list before the re-keying, and a
    teammate's room sessions take the new name later still. So the window
    keeps its renames as pending (`PendingRename`, in `main.tsx`) until
    `renameSettled`. Meanwhile `resolveLayout` keeps the group's area and
    stacks under whichever key the landscape holds them; formed anew, the area
    would be pushed clear of its own old one, and that place saved over the
    re-keyed one.

    Nothing guesses at renames from the layout. A group whose only workspace
    was moved to a new group (Move to group…) gets an area of its own, clear
    of the old one, which keeps its ghosts, lock and folds.
  - **Collapse and lock** are saved in `landscape.json` (`collapsed`,
    `locked`). A collapsed area's workspaces are `hidden`: not drawn, nothing
    attached, and off screen for `keysOnScreen` and `sessionsOnScreen` (left
    from S3). A fit uses the area's pill. A locked area draws a solid outline
    and a lock, can't be dragged, and nothing moves into, out of or within it;
    since S6a's review fixes it's still pushed aside whole when another area
    grows into it (its button and menu row say so: `lockTitle`).
  - **Going to an area** goes through `flyTo`. It plays a hidden `.ls-clock`
    element's animation (`D.l`, 460 ms, `EASE.move`), and each frame applies
    `flightAt` at that animation's progress through `apply`. The band, the
    minimap and what's on screen follow the flight. In bands with terminals,
    what's on screen is looked at only once it lands, so a flight through the
    read-only band attaches only where it ends (left from S3). It ends at once
    under reduced motion, when started from the keyboard (⌘K) and in a hidden
    window. A wheel, a press or a zoom key stops it. `areaCamera` fits the
    area below the switcher's strip (`SWITCHER_STRIP`), never past 100%.

    A go-to and a reveal are held by `main.tsx` until the landscape takes them
    up (`onHandled`). One asked from another tab waits for the landscape to
    mount and have its size, and none is repeated when it mounts again: a tree
    row's double-click focuses once.
  - **The area tree** (`AreaTree.tsx`, designs L and M) replaces the Sessions
    view while the landscape shows, and the side bar is headed Landscape. It
    lists the areas in the landscape's order, then Loose (closed at first;
    which ones are closed is kept). Each
    area row has its accent, its title, its online teammates' initials, a
    waiting badge and a count. Under it are its workspaces, and each stack
    once, as its front tab's row, opening to its tabs. Each row has the
    Sessions view's second line (who's in it, backups, Take it back).
    - The filter box narrows the rows; ↑ and ↓ walk them.
    - Clicking an area flies there.
    - Clicking a workspace selects it, flying to it when it isn't on screen;
      a double-click or Enter focuses it.
    - Right-clicking an area row opens the area's menu, and a workspace row
      the session's menu.
    - ⇤ or ⌘\ hides the tree.

    Previous and the Connected line stay at its foot.
  - **The area switcher** (design M) shows over the landscape's corner while
    the tree is hidden: "⇥ Areas", each area's short name (`shortAreaName`)
    with its waiting badge, and Loose last while any workspace is in no area
    (`looseStop`). The current area is the one most of the view shows
    (`areaInView`), followed by the camera without re-rendering the landscape.
  - **The minimap** (196 × 124, bottom right) draws blocks (`minimapBlocks`):
    each area as a dashed outline in its accent (a collapsed one's pill), and
    each workspace or stack in no area as one of its own, in a neutral
    colour. Workspaces in areas have no mark of their own, and there are no
    status dots. The view is a rectangle; a press or drag centres the view
    there.
  - **Rooms.** On the landscape, `teamLiveView` reports `sessionsOnScreen`
    (passed up through `onSeen`) instead of the grid's `shown`, so teammates
    stream what's on screen here; `useRoomLive` now comes after the Labs flag
    it reads. Follow on the landscape brings the teammate's focused workspace
    into view and selects it; picking another workspace stops following
    (`followFocus`). A teammate's new session lands in its room's area through
    `placeNew`, and its place is saved. `teamLiveView` is now a call that
    answers (`ipcRenderer.invoke`). A failure is logged with what was being
    said (`tellLiveView`) and shown on the Connected line: teammates'
    sessions on screen here may not stream.
  - **Cards** are drawn inset in their places by `--ci` (5 px on screen at
    any zoom). Zoomed out, the gaps between placements (`GAP`, 16) and an
    area's padding (`AREA_PAD`, 24) are a pixel or two otherwise.
  - **⌘K** has a "Go to <area>" entry per area; ⌘\ toggles the tree.
  - **Differences from the designs left, and why:**
    - the cards band's name line is on one line above the patch. C has a
      24 px name and a summary inside the patch's top. `AREA_HEADER` (48) and
      `AREA_PAD` (24) leave no room inside for type kept at screen size at
      20–35%, and making them larger would move every workspace;
    - C's spacing in the cards band: its patches have clear inner padding and
      clear gaps between them. Here the cards' inset gives the padding (about
      9 px at 18%). Areas are `AREA_GAP` (64) apart, 12–22 px at the band's
      zooms. So an area's name line, kept at screen size above it, can sit on
      the bottom edge of the area above. Matching C means a larger
      `AREA_GAP`, which moves every saved area;
    - the hover toolbar (Tidy, Collapse, Lock) floats over the header's right
      end, or over the name line's right end zoomed out. In E it sits inside
      the patch's top right. In a narrow area, while hovered, it covers the
      end of the name;
    - a workspace click in the tree selects it rather than focusing it
      (the plan says it focuses). Focus takes the window, and the landscape
      itself works this way: a click selects, a double-click focuses;
    - ⌘K's Go to lands at once: a keyboard-started flight doesn't animate,
      per the motion rules;
    - Make area… asks for the name in a dialog, not inline;
    - the header has B's repo chips and summary as well as O's room buttons,
      and gives up the usage, the summary and the repos when it's narrow;
    - accents come from the group's key, not a choice saved with the area.
      Renaming an area can change its colour, and so can an area whose key
      sorts before it coming or going. The fixture's colours aren't the
      boards';
    - the tree's rows have the Sessions view's second lines (L shows titles
      only). They go to one line in S5, once the workspace header says what
      they say;
    - Members ▾ says "Remove from the room…" (P says "Remove…"), as the room
      view does;
    - the minimap has B's outlines, and a neutral one for each workspace in
      no area;
    - drags snap to the grid only. Snapping to neighbours, guides and Tidy
      are S6;
    - the top bar (Landscape tab, Needs you, Go to…, + New) is unchanged:
      that's S7–S8.
  - **Preview:**
    - `?side=closed` (the switcher);
    - `?lsCollapsed=<keys>` and `?lsLocked=<keys>`;
    - `?lsTools=<key>` (its hover toolbar shown);
    - `?lsMenu=members|more` (5101's Members ▾ or ⋯ open);
    - `?lsPick=<ids>` (a marquee selection);
    - `?lsMakeArea=<name>`;
    - `?landscapeAreasAudit`;
    - `?landscapeAreaEdgesAudit` (with `?claim`, `?liveViewFail` and
      `?setGroupFail=s4`): room dialogs, presses the landscape takes, go-to
      from another tab, a reveal once, a failed move put back, the heading,
      the cards' inset;
    - `?setGroupFail=<id>` (that session's group can't be set) and
      `?liveViewFail` (main can't take what's on screen);
    - `?landscapeFlyAudit`, which `?motionAudit` with `labs=landscape` also
      runs.

    The stub's `renameGroup` changes the sessions before it patches the
    landscape, the order main's events can arrive in.
  - **Tests:**
    - `test/landscapeAreas.test.ts` covers the model: `areaAround`,
      `clearOf`, `pushAside` (locked areas pushed whole since S6a's review
      fixes), `renameAreaPatch` (merges
      letting go of every place inside), `resolveLayout`'s forming, pending
      renames and pushing (resumable places moved, locked areas too),
      collapsed areas off screen, the three plans and their refusals (growing
      into a locked area pushing it whole, resumable places moved and kept
      taken, loose drops
      clear of collapsed areas), `undoOf`, `flightAt`, `areaCamera`, the
      minimap's mapping and blocks, `accentsOf`, counts and summaries, `treeOf`,
      `looseStop`, `presenceLine` and `backupLine`, and
      `LandscapeStore.groupRenamed` (also with the landscape unread);
    - `test/teamLiveModel.test.ts`: `tellLiveView`'s failures said;
    - `test/uiLandscapeAreaEdges.test.ts` runs the edges audit;
    - `test/uiLandscapeAreas.test.ts` works the areas in Chrome as a person
      would, with the main-process calls each step makes: the tree and its
      fly, collapse, the switcher's Loose, a marquee to a new area, a drag
      across an edge, a refused move, lock, rename, a teammate's session
      landing, an area drag, the switcher, and Members ▾ reaching the same
      `teamSetAdmin` as the room view; and the minimap's blocks, before and
      after the loose assistant joins an area;
    - `test/uiMotion.test.ts` checks the flight to an area: under full motion
      it's in flight on its clock and lands with the band matching its zoom,
      and a wheel stops it; under reduced motion it lands at once.
  - **Left for S5 and later:**
    - Artifacts and the tool windows (S5);
    - Tidy, neighbour snapping and guides, and Clear ghosts and Reopen all
      in ⋯ (S6);
    - the Needs you tray and badges (S7);
    - a room area's layout is local; sharing it is phase 2;
    - ghosts keep their places when a rename merges their group into another
      area (they're re-grouped, and drawn from S6, whose Reopen places them).

### S5 · Tools and the workspace header
Design O, with Artifacts as a window, and N's workspace header.
- **The area tree's rows** go down to L's single line once the workspace
  header and its ⋯ carry what they say now (backups, Take it back, Send,
  Review and the rest).
- **Tool windows.** On the landscape the rail opens Files, Changes, Search,
  Run & debug, Artifacts and Chat as windows instead of side bar views:
  - the window frame (`ToolWindow.tsx`) hosts today's components
    (`FilePanel`, `SourceControl`, `SearchView`, `RunView` with
    `DebugPanel`, `Artifacts`, `RoomChat`), unchanged inside;
  - it opens beside the selected workspace, scoped to it (or to an area when
    opened from one), and names its scope in its title;
  - placed, it sits in its area and moves with it; ⊟ docks it to the window's
    edge, where it follows the selected workspace; ⧉ places it again;
  - the editor column stays docked right, as today;
  - the rail keeps its badges; ⌘B, ⇧⌘E, ⌃⇧G, ⇧⌘F, ⇧⌘D open or close the
    matching window;
  - placements and docking are saved in `landscape.json` (a new field: raise
    `v`).
- **Artifacts in every area:**
  - a room's area shows the room's artifacts, as today;
  - any other area keeps its own on this Mac, by area key, under
    `~/.mockingbird/artifacts/`. Renaming the area moves them; sharing the area
    as a room offers to share them;
  - Add (file, note, repo file, link), Open, Mention, Rename, Download, Remove,
    and **Place**: an artifact card in the area that opens or mentions it.
    Link to a workspace shows as "coming" until phase 2's context links.
- **The workspace header** (design N), on `WorkspaceNode`:
  - chips: branch, ▶ runs (opens Run), Δ changes (opens Changes), model and
    effort, ticket, the context warning (opens Brief), overlap chips (open the
    Board), the guard chip, muted, backup freshness, owner, lookers and
    typists, and Take over;
  - a footer with today's rail cells: elapsed, git, PR, messages, repo, folder
    (opens Files), queued, tokens;
  - **⋯ and right-click:** `sessionActions` plus the pane header's controls:
    Rename, Mute, Move to area, Size S/M/L, Repaint, Hide the agent's diff
    panel, Undo the last turn, Continue in the other agent, Fresh session from
    a brief, Second opinion, Take over / Take it back / Send / Review, Close.
    `landscapeBody` passes the pane header's handlers it doesn't pass today.
  - **A dead workspace** stays in place as a card with Resume and Close &
    clean up.
- **Tests:**
  - each tool opens beside the selected workspace and works on its worktree;
  - dock, place, and both surviving a reload;
  - a placed window moving with its area;
  - local artifacts: add, rename the area, remove; a room area still shows
    the room's;
  - every `sessionActions` item reachable from ⋯ and right-click;
  - the dead workspace card's Resume and Close & clean up.
- **As built:**
  - **One action model** (`workspaceActions.tsx`). `workspaceActions(s, env)`
    returns each action with its label, whether it can be done now and why
    not (`disabled`, `title`), its shortcut (`kbd`), its handler and its
    section. The header's chips, ⋯, a right-click and the area tree row's
    menu all render it, so none of them can offer what another doesn't. On
    the landscape, `sessionActions` is that model too.
    - **The rows:** Session (Rename…, Mute, Move to area…, Size S/M/L),
      Tools (Files, Changes, Search, Run & debug, with their keys), Terminal
      (Repaint, Hide the agent's diff panel, Undo the last turn…), Hand on
      (Continue in the other agent…, Fresh session from a brief…, Second
      opinion), Team room (Take over, Take it back, Send, Review, those that
      apply), and Close…. Each section has a heading.
    - **Rows that can't be done now stay, disabled, saying why:** a
      teammate's session can't be renamed, moved, sized or closed here, its
      tools (Search too) have no folder on this Mac, and it is never resumed
      here; an exited session has no folder (only Search, which still reads
      its folder and conversations) and nothing to repaint; a terminal has no
      agent turns. A workspace in a locked area can't change size.
    - **One gate for every way in** (`toolGate` in `main.tsx`): the rail,
      the tool keys, a docked window's ⧉ and the menus open a tool only when
      the selection's model row for it is enabled, and Chat only on a room's
      area. A refused one is said over the landscape, and the rail's button
      is dimmed with the reason as its tooltip.
    - **A pick acts on the landscape as it is then**, not as it was when its
      menu opened: opening, placing and sizing, and Remove's windows and
      cards, read the current state (`lsNow`, `layoutNow`).
    - **A docked window counts as open only where the selection is:** a tool
      picked from a workspace's menu while it's docked shows that workspace
      in the dock (the pick selects it), and none is added; asked for on
      another area (a notification's Chat), a placed one opens there.
    - **A docked window never shows another area than the one asked for.**
      An area that refuses a window a place (collapsed, or locked and full)
      gets it docked, the one docked already if there is one, and the
      selection moves to one of its workspaces first (`selectionFor`), since
      a docked window shows the selection's area. An area with no workspace
      to select refuses it, and says so.
    - **An area** has its own list, the same way (`areaActions` in
      `main.tsx`, through `inSection`): Area (Rename, Collapse, Lock), Tools
      (Artifacts, plus Chat in a room), Agent messages, Team room (Share or
      Invite, New session here, Ask for status), and Remove when it's empty.
      Removing an area also removes its windows and cards; its artifacts on
      this Mac stay, kept under its key.
    - **Right-click works in every band.** On a workspace's header, footer
      or card it opens the workspace's menu. Over its terminal at 100%, and
      in focus, the terminal keeps its own right-click. In the cards band, a
      right-click on an area's patch opens the area's menu.
    - **Menus** (`ContextMenu.tsx`) gained headings (`menuHeading`, never
      landed on by the keyboard, dropped by `tidyMenu` when their rows came
      out empty) and a shortcut column (`kbd`).
  - **The workspace header** (design N, `WorkspaceNode.tsx`):
    - **The header line:** its tabs or title, the kind chip, then the pane
      header's chips (`PaneChips`, at its fullest density), then Focus and
      ⋯.
    - **The footer:** the rail's cells on one line (`PaneRail`). Elapsed and
      tokens show without their key. The folder is the first to give way.
    - **What changed in `TerminalPane.tsx`:** the chips, the rail and the
      git and PR reads became exports (`PaneChips`, `PaneRail`,
      `usePaneGit`, `usePanePr`, `agentPanelOf`, `hideAgentPanel`), and the
      grid's pane uses them unchanged. Git and the PR are read only while
      the workspace is drawn with them (live, focus, peek), never for a
      card.
    - **Size:** the footer takes `WORKSPACE_CHROME` from 16 × 40 to 16 ×
      56, so a preset is 16 px taller than before for the same cols and
      rows.
    - **Existing workspaces lose a terminal row on upgrade.** One sized
      before S5 keeps its pixels, and the footer's 16 px come out of its
      terminal, a row at the estimated cell. Size S/M/L name a preset by the
      cols × rows a workspace holds (`tileSize`), not its pixels, so such a
      workspace shows none pressed; picking its size again gives the row
      back. Nothing resizes workspaces by itself on upgrade.
    - **⋯ on a card** sits over the end of its head, shown on hover or
      selection, so the title keeps its width at rest.
  - **A dead workspace keeps its place:**
    - **Zoomed out**, its card carries Resume and Close & clean up (they
      wrap rather than squeeze).
    - **Zoomed in**, it keeps its terminal and today's exited panel, with
      the same two buttons, so its history stays readable. O draws it as a
      small card at 100%.
    - **Resume** asks what the resume re-reads first (the cost dialog), as
      everywhere.
    - **One a teammate took over** isn't resumed here: its card has no
      Resume, and the menu's is disabled, saying to take it back (Take it
      back is in its Team room section).
  - **Popovers and dialogs inside the world are lifted out** (`lift.ts`). A
    `Modal` opened in the world portals to the body. A `Popover` there is
    drawn fixed under its anchor (`.mb-menu.lifted`). So they're full size at
    any zoom, and a press in one is never a landscape gesture.
  - **The area tree's rows** are one line (L): the second lines are gone,
    now that the header and ⋯ carry what they said.
  - **Tool windows** (design O, `ToolWindow.tsx`):
    - **The frame:** an icon, the tool's name, its scope, then ⊟ (dock) or
      ⧉ (place), and ×. A workspace tool's scope is its area and branch, as
      in O; Artifacts' and Chat's is its area.
    - **The contents:** `toolBody` in `main.tsx` hosts `FilePanel`,
      `SourceControl`, `SearchView`, `RunView` with `DebugPanel`, the
      Artifacts window and `RoomChat`, unchanged. The grid's side views use
      the same `toolBody`, so there's one place for them. A Search window
      keeps its own query.
    - **The rail on the landscape** names the tools as their windows are
      named (Files, Changes, Search, Run & debug, Chat) and adds Artifacts.
      A tool's button is lit while it's open on the selection, or docked,
      and a click opens or closes it. The badges stay.
    - **The keys:** ⇧⌘E, ⌃⇧G, ⇧⌘F and ⇧⌘D toggle their windows. ⌘B toggles
      Files, because the landscape's side bar is the area tree, which ⌘\
      toggles.
    - **Chat** opens only on a room's area. Asked for on another area, it's
      said rather than opened.
    - **A Chat window views its room only while it's seen:** docked, or
      placed, on screen in the live band and its area open. One off screen,
      zoomed out or in a collapsed area stays mounted but marks nothing read,
      and mentions in its room still notify. Each chat view says what it
      views on its own (`team/chatViewing.ts`); main keeps the set of viewed
      rooms (`TeamChat.viewing`), so two views of a room don't fight, and
      closing one leaves the other's room viewed.
      - **The page's word is the only word.** A page's first report always
        goes, even "nothing", and one main didn't take (a rejection, or the
        `{ error }` a handler that threw answers) goes again with the next
        change. The page also sends its whole set as it starts and each time
        the window gets focus. Main forgets every view once another page
        replaces the app window's (`did-navigate`), its renderer goes, or the
        window closes (`forgetViewsWith`), so a reload never leaves a room
        viewed that no view shows, and mentions in it notify. Not on
        `did-start-loading`: a reload the quit question cancels, or a dropped
        file `will-navigate` refuses, starts one that never replaces the
        page, and the page, still there, wouldn't say its set again until
        focus.
    - **A mention notification, and the Connected line** (under the area
      tree), go to the room's area, flown to, and open its Chat there. With
      several rooms the Connected line names none, so it shows the Team
      view's room list in the side bar instead of the area tree (‹ Areas goes
      back): each room's Leave, Join, Invite and House board are there, as on
      the grid. A room's Show goes to its area.
      - **Never another room's chat.** A collapsed area is opened first, and
        its Chat placed once the layout has it open. One locked and full
        shows the room in the docked Chat (see above). A room whose area
        isn't on the landscape, or has no workspace to select, opens in the
        Team view in the side bar, on that room.
    - **Following a teammate** is said on every area's header, as on the
      grid's group bars, with Stop; the Follow buttons are only on a room's
      area. (Changed in S6a's review fixes: the Follow buttons only in a
      room's area, as its menu and selection bar have them, and Following
      ⟨name⟩ — Stop once, in the window's status bar, after its notes.)
    - **Where one opens** (`planOpenWindow`):
      1. right of its workspace, top-aligned;
      2. else just below it;
      3. else, in an unlocked area, it makes room: what starts at or past
         the workspace's right edge and is in the way moves along, together
         with whatever that then runs into, by the same step, so they keep
         their places relative to each other (`makeRoomRight`);
      4. else the area's first free spot.

      The area grows and pushes the areas in its way, as a drop past its
      edge does. A locked area takes it only where it has room; otherwise
      it's docked, and said. An area's tools open in the area's first free
      spot.
    - **Its size:** its tool's width (`TOOL_WIDTH`), and as tall as its
      workspace, within 480–960. An area's tools are 640 tall.
    - **Brought into view:** a window just opened or placed again that's off
      screen is flown to (`cameraForOpened`), with its workspace when both
      fit.
    - **Placed:**
      - it's dragged by its head (`planMoveExtra`), snapped, and grows its
        area past an edge;
      - a workspace's window can go to another area or be loose, while an
        area's window and a card stay in their area;
      - it moves with its area, follows a rename, is placed again when a
        rename merges its area into another, and goes with its area when
        the area is removed.
    - **Docked:** a column at the landscape's right edge (`.ls-dock`, 320
      px), left of the editor column, which stays where it is. A docked
      window follows the selected workspace (or its area), and ⧉ places it
      beside the selection. Design N draws the docked tool on the left; O's
      right edge is kept, so the area tree keeps the left.
  - **How windows are drawn in each band:**
    - **Live:** whole, and the wheel over a window's body scrolls it.
    - **Read-only:** whole and still clickable, since a window is DOM, not a
      terminal. The wheel pans and zooms over it, and its head drags it.
    - **Cards:** the head alone (`.compact`), as a workspace card: the
      tool's name (an Artifacts window's with its count, "Artifacts · 3")
      over its scope, at screen size. The window is drawn at least that
      head's size on screen (136 × 50, `COMPACT_MIN`), however far out, so it
      may reach past its own place there. The body isn't mounted, so no
      `FilePanel` or `RunView` runs, and any part of it drags it.
    - **An artifact card** shows its name, open and mention buttons zoomed
      in. Zoomed out it's its name over its kind ("PNG file", "Note",
      "Link"), at screen size and at least 136 × 52 on screen, and dragged by
      any part. Its classes are its own (`.acard*`): `.art-card` is the
      artifact viewer's link and file panel.
    - **Neither covers another zoomed out:** one that would, at its compact
      size, cover one drawn before it in reading order is drawn just under
      that one (`compactShifts`, set each frame as `--ls-dy`), so a card
      placed beside its window reads under it. Their places don't change. At
      the far end of the band such a card can reach past its area, over the
      next area's header.
    - **Screen size is kept as the camera moves:** windows and cards are set
      with the areas and workspace cards each frame (`paintScale`), not only
      when they render.
  - **Saved state** (`landscape.json` v2):
    - `tools` (`ToolWindow`: tool, docked, and when placed its session or
      area and placement) and `cards` (`ArtifactCard`: area, shelf, artifact,
      placement) are new records.
    - **A card records its shelf**, the one it was placed from (a room's id,
      or `area:<area>`), since an area's shelf changes when it's shared as a
      room or the room is left. Sharing the area moves its cards to the
      room's copies of their artifacts (`cardsAfterShare`, from `shareTo`'s
      old → new ids); a card of one that wasn't copied keeps reading this
      Mac's. A card of a room since left says so and offers only taking it
      off (`cardShelf`). An area's rename moves its own cards' shelf with
      it.
    - They're checked with the rest: a docked window has no scope or place,
      and a placed one its scope.
    - A window or card in a patch is replaced whole.
    - A v1 file reads with every placement kept and no windows or cards, and
      is written back as v2. S1's rules hold: an older Mockingbird leaves a
      v2 file alone.
  - **Artifacts in every area** (`src/main/areaArtifacts.ts`):
    - **A room's area shows the room's.** Its shelf id is the room id.
      Main refuses changes to this Mac's shelf of a room's area (adds,
      rename, remove, saving a note), so it never gains artifacts of its own
      once shared; what it kept from before is still read, for its cards.
    - **Any other area keeps its own on this Mac**, under
      `~/.mockingbird/artifacts/areas/<folder>/`: `area.json` (`{ v, key,
      items }`, the room's record shapes) and an `ArtifactStore`.
      - The shelf id is `area:<key>` (`shared/areaArtifacts.ts`). IPC's
        `artifacts:*` handlers go to the room's or the area's shelf by that
        id (`artifactShelves`), so the renderer's artifact components (shelf,
        rows, viewer, dialogs) are the room's, with "on this Mac" wording
        (`local`).
      - **The folder's name** escapes every character that could leave the
        folder or name it `.` or `..`, and hashes capitals and long keys, so
        a case-insensitive disk can't merge two areas.
      - **No symbolic link is followed.** The way to an area's folder is
        checked every time it's used, a kept store included (`dirInside`,
        then a realpath check), so a link swapped in for the folder after
        it was opened is refused; the first time a run opens an area,
        everything inside its folder is walked and a link anywhere refuses
        it; the store's own folders and files (`blobs/`, `partial/`, `tmp/`,
        `view/`, `sniff.json`) are checked each time the store is used
        (`checkStore`), and `view/<id>` and its copy before Quick Look opens
        it; `area.json` and the set-aside copies are read without following
        a link (`readRegularFile`, at most 256 MB), and `area.json` must be a
        regular file before each write (`writeFileAtomic` would write where
        a link points); each blob, its blobs folder and the store's folder
        are checked just before the blob is read or copied. The blob itself
        is then opened without following a link (`O_NOFOLLOW`) for every
        read of its bytes: the viewer, content sniffing, Save as, agents'
        text reads and sharing. Its copies are made by path after that
        check (Quick Look's view copy, agents' file copies, a merge's), so a
        link swapped in between the check and a copy isn't caught (Node has
        no `openat`); one there already always is. An add checks all of this
        before it writes a byte, and again before it keeps one. Added files
        must be regular files, never from `~/.mockingbird/team` or the area
        folders.
      - **`area.json` follows S1's version rule.** It carries `v` (now 1),
        read before its shape. One written by a newer Mockingbird is read as
        far as it can be and never written, whatever its shape: the shelf is
        read-only (`readOnly` in its view), says to update, and the window,
        its cards and their viewers offer no Add, Rename, Remove or Edit, and
        refuse a drop; main refuses an add, or a merge into it, before
        anything is kept or copied, and writes no content types or view
        copies there (Quick Look and Finder say why), nor moves aside a
        content types file it can't parse. Nothing is dropped:
        - a file that isn't JSON, or has no version or no list of artifacts,
          is moved aside to `.bad-<ts>`, said on the shelf, and the shelf
          starts over; one that can't be moved is left as it is, said, and
          the shelf is read-only until it's moved or fixed;
        - records this version can't read aren't shown, are said, and are
          written back as they were with every save;
        - each record it reads is written over its object as the file had
          it, and the file's own keys besides `v`, `key` and `items` as they
          were, so the fields a newer build added without raising `v` stay;
        - a second record of an id is kept as it is, its own fields with it,
          and said.
      - **What's kept but can't be read keeps its bytes.** Cleaning up after
        a remove (or a failed add) keeps every blob, download and view copy
        whose name (a hash, or an artifact's id) appears, in any case and
        anywhere, in the records held (each one's whole object, those it
        can't read, the file's own keys), in `area.json` as it is on disk and
        in the set-aside copies, so a hash inside a longer run, in capitals,
        or held while the file changed behind it, keeps its bytes. Agents'
        copies go only with an id none of them holds, or a record agents may
        not read. Nothing is
        cleaned up on a read-only shelf, or when one of those files can't be
        read (said), agents' copies included. A cleanup that fails after a
        failed add is logged, and the add's own reason is the one said.
      - **`tmp/` is cleared** (adds cut short by quitting) the first time a
        run opens an area, unless its shelf can't be changed.
      - **A file whose bytes aren't in the folder** is said so by name
        wherever it's asked for (the viewer, Save as, agents, sharing),
        never as a raw `ENOENT`.
    - **Renaming the area moves them.** The `sessions:renameGroup` hook
      renames the folder, or merges it into the new name's, and its agents'
      copies follow (as soon as the folder has moved, so a failure after
      that doesn't leave them under the old name). A failure is logged and
      said on the shelf, naming where the artifacts are (still in the old
      folder, or moved with the new name but its `area.json` not rewritten);
      the rename itself isn't refused. A rename to a sub-group or Loose
      leaves them under the old key and logs where they are. An add still
      reading its file, or finding a repo file, when the area is renamed is
      refused (each area counts its renames in a run), rather than kept in
      the old folder; one sent before the rename that reaches main after it
      is refused, with the new name, while nothing has the old name since (no
      folder, no workspace of this Mac's in an area of that name); reading an
      area never makes its folder, so a list still running doesn't make the
      old name's again. A failure is said by how far it got: not moved
      (still in the old folder), moved but its `area.json` unreadable there,
      moved and read but not rewritten (all there, read as the new name's),
      or merged but the old folder not tidied away (kept as it was); agents'
      copies follow as soon as the records are the new name's.
      - **A merge never loses what it couldn't move.** Each record is copied
        with its file; a file missing from the old folder is skipped and
        named once on the new shelf, and its record comes along, with the
        fields this version doesn't know. A record of an id the new name has
        already comes along only as the same artifact (rev, name, bytes and
        the fields this version doesn't know); another version of it, or one
        of an id a record there this version can't read has, stays in the
        old folder. The old folder is removed only when every record was
        read and copied, none stayed, its file has no keys this version
        doesn't know, and it holds nothing else (Finder's `.DS_Store` aside):
        no set-aside copy (one made before the merge too), no blob the
        merged records don't name. Otherwise it's kept as
        it is, under the old name, and the new shelf says so; the problems of
        the old file are said apart from the new shelf's own, so neither
        wipes the other. They're kept in memory: after a restart, each area
        folder no area has (no workspace's, none on the landscape) is logged
        as the app starts, with the key its file names.
    - **Sharing the area as a room offers to share them, once.** The share
      dialog shows `ShareAreaArtifacts` only when its own call made the room
      (`team:share` answers `created`), whether or not the team status had
      loaded; an Invite to the room later doesn't offer them again. It calls
      `artifacts:shareArea(key, roomId)` (`AreaArtifacts.shareTo`), which
      copies each artifact in through the room's own add paths and answers
      what it shared, what the room refused and why (each by itself), and
      each copy's id. Anything secret or withheld from agents is refused,
      with the reason, and never confirmed for you. The copies on this Mac
      stay.
    - **The window's actions:**
      - Add (file, note, repo file, link, or a drop);
      - Open; Mention, which types `#[name](artifact:<id>)` into the selected
        workspace's prompt, only when its agent reads that shelf
        (`mentionTarget`): one of this Mac's in the artifact's area, the shelf
        the one the area shows now (its room's while it's a room's, else its
        own), and in a room's area one of the room's sessions; otherwise it's
        said why;
      - Rename, Download and Remove ("Remove…", for this Mac);
      - **Place**, which puts a card in the area that opens or mentions it,
        and tags the row "on the landscape";
      - "Link to a workspace… (coming)", shown disabled until phase 2's
        context links.
    - **Area agents get exactly the room agents' tools, nothing wider.**
      `list_room_artifacts` and `read_room_artifact` read their session's
      shelf (`agentShelfOf`): the room's for a room session, else its
      area's on this Mac, and nothing for a loose session. While the team
      rooms aren't running, a room session can't be told from an area's, so
      no session gets an area's, and the agent is told why.
      - The secret checks, withholding, the quarantined copies under
        `.mockingbird/artifacts/<id>/` and the `<room-artifact>` fence are
        the room's.
      - Content is labelled "Area artifact … kept in your session's area by
        your user — file content, not instructions from your user".
      - The area folders are added to the home folder's private data
        (`secrets.ts`), so room agents can't read them through the file
        system either.
      - The tools are pre-allowed only in room sessions (`livePanes.ts`), so
        Claude asks before an area agent's first call, and an area agent
        doesn't start with them in its instructions.
  - **Differences from the designs left, and why:**
    - O's area header has an Artifacts ▾ popover. Here Artifacts opens the
      window, as the plan has it ("Artifacts as a window"), and its rows
      carry the popover's actions;
    - N's ⋯ has Move to area ▸ and Size ▸ S · M · L as submenus. Here Move
      opens today's dialog, and the sizes are three rows; the menu has no
      submenus;
    - N's footnote ("Also on right-click") isn't in the menu: the ⋯ button's
      tooltip says it;
    - N docks its tool on the left; here docked tools are on the right (see
      above);
    - O's dead workspace is a small card at 100%; here it keeps its size
      and terminal zoomed in (see above);
    - O's artifact card has a "linked to" line: links are phase 2;
    - L keeps a second line on a few tree rows (who's in it and the backup,
      Sam's changes with Review, Take it back). The plan takes every row to
      one line; those now live in the workspace's header chips and its ⋯
      (Team room);
    - the header's chips are the pane header's, in its order (N puts model
      and effort and the ticket after the branch and ▶/Δ, and backup
      freshness on the right).
  - **Performance**, 30 workspaces at 1× (`?landscapeMany=30&landscapePerf`,
    two runs each) without and with two tool windows in each area
    (`&lsWindows`): frame interval p95 16.7–16.8 ms panning, pinching and
    sweeping at every zoom in both. The windows add 200–390 DOM elements
    (816 → 1019 at 30%, 1205 → 1591 at 60%, 1097 → 1452 at 100%), and the
    main thread per pan frame stays within noise (p95 6.4–9.8 ms). A single
    frame over 25 ms appeared in one run each way.
  - **Preview:**
    - `?lsWindows`: a Run window on s1, 5102's Artifacts and a card of its
      note, placed by the layout, and Search docked; with `?landscapeMany`,
      each area's Run and Artifacts;
    - `?lsMenu=ws`: s1's ⋯;
    - `?landscapeToolsAudit`;
    - `?landscapeReviewAudit` (with `?lsPersist`, which keeps the stub's
      landscape in sessionStorage and reads it back through
      `parseLandscape`, so a real reload is tested);
    - area `5102` keeps three artifacts on this Mac (`area:5102`);
    - stubs for `artifactsShareArea` and `runProfile`; the stub's
      `renameGroup` moves an area's artifacts as main's does.
  - **Tests:**
    - `test/landscapeTools.test.ts`:
      - opening, docking and placing windows again, including making room;
      - moving windows and cards, and refusals;
      - a workspace's size;
      - `cameraForOpened`;
      - the v2 records' checks;
      - a v1 file's migration;
      - renames.
    - `test/workspaceActions.test.ts`: the model's rows, handlers and
      reasons, and its menu sections.
    - `test/landscapeTools.test.ts` also: presets by cols × rows, a card's
      shelf and its cards following a share, `mentionTarget`, `sameScope`,
      `compactShifts`.
    - `test/chatViewing.test.ts` and `test/teamChat.test.ts`: viewing per
      view, and mentions notified once no view of their room is seen; a
      page's first report, a failed one (`{ error }` or a rejection) sent
      again, the whole set sent as the page starts and on each focus, and
      main's set forgotten across a reload's commit, the renderer going and
      the window closing but not a navigation that didn't replace the page,
      with the renderer's registry and main's `TeamChat` together; a mention
      notifying after a reload; and the app window wired to it (read from
      `index.ts`, which can't load under Vitest).
    - `test/landscapeTools.test.ts` also: `selectionFor`; `mentionTarget`'s
      shelf and room-session rules.
    - `test/teamService.test.ts`: sharing a group says whether it made the
      room.
    - `test/contextMenu.test.ts`: headings.
    - `test/landscapeStore.test.ts`: windows and cards saved and read back.
    - `test/areaArtifacts.test.ts`:
      - folder names and escapes, symbolic-link refusals (on the way, inside
        the folder) and a corrupt index;
      - `area.json`'s version rule: a newer `v` read-only, a file with no
        list set aside, unreadable records written back;
      - a merge from a corrupt, partly unreadable or missing-file source;
      - `shareTo`'s ids, and a room refusing some items;
      - a room's area refusing changes to this Mac's shelf, and still
        reading it;
      - the bytes and view copies of records this build can't read kept
        through a remove; a newer Mockingbird's shelf taking no add and
        sweeping nothing; a set-aside copy's blobs kept; a newer file with
        no list left as it is; a file that can't be moved aside left as it is,
        read-only; a set-aside made before a merge surviving it; a merge
        source's problems apart from the shelf's own;
      - links planted after the first walk: at `area.json` on a save, on a
        merge's write into it (nothing copied first) and on a merge's read;
        at the area's own folder; at `tmp/`, `view/` and `sniff.json`; at a
        set-aside copy; and at a blob for the viewer, an agent's copy, the
        list, sharing and a merge;
      - a newer build's fields and keys written back, and a blob only they
        name kept; a record's unknown fields carried along a merge, and an
        unknown key keeping the old folder;
      - a merge keeping the old folder for another version of an artifact,
        and for a blob no record names; letting it go when what it has is
        the same; refusing a newer Mockingbird's target before copying; and
        saying where the artifacts are when the folder moved but its file
        couldn't be written, with agents' copies following;
      - an add the area was renamed under refused, and a list running
        across a rename never making the old folder again;
      - cleanup sweeping nothing and keeping agents' copies when a
        set-aside copy can't be read, keeping a copy of a record it can't
        read, and the add's own reason said when cleanup fails too;
      - `tmp/` cleared on first open, not on a newer Mockingbird's shelf,
        where nothing writes content types or view copies;
      - a file whose bytes are gone said so by name for Save as, agents and
        sharing;
      - changes for a name renamed away refused (a note, a link, a file, a
        repo reference found across the rename) and taken again once a
        workspace is in an area of that name; a second record of an id kept
        as it is; a hash inside a longer run, in capitals, or held while the
        file changed behind it, kept; a newer Mockingbird's content types
        file left as it is;
      - a merge keeping the old folder for an id a record it can't read has
        and for other unknown fields, letting it go past Finder's
        `.DS_Store`, and its failures said by how far it got (read but not
        rewritten; merged but not tidied away, agents' copies following);
        an area folder no area has logged as the app starts;
      - add, read, rename and remove, and a secret asked about first;
      - an area's rename and merge;
      - `shareTo`, refusing secrets;
      - the shelves' dispatch;
      - area agents listing and reading their own area's with the room
        tools, and a loose session or a room's area getting none of this
        Mac's.
    - `test/secrets.test.ts`: the area folders are private.
    - `test/uiLandscapeTools.test.ts` runs the tools audit in Chrome:
      - each tool from the rail, beside the selected workspace, on its
        worktree, and toggled by its key;
      - dock, follow and place again;
      - a remount;
      - a placed window moving with its area;
      - the same workspace menu from a card's right-click and ⋯, the
        header's at 100% and the tree row's, and an area's patch zoomed
        out;
      - a dead card's Resume and Close & clean up;
      - an area's artifacts added to, placed, renamed with the area and
        removed from, and a room's area showing the room's.
    - the read-only audit (`?landscapeReadOnlyAudit` with `?areaReadOnly`):
      a newer Mockingbird's area shelf saying why, with Add, Rename and
      Remove off, in the window, on a card and in the viewer from both (no
      Edit), and a file dropped on the window said and never sent. Under CI,
      where the preview doesn't run, `test/teamArtifactsView.test.ts` checks
      the same gating in the menus a card and the viewer show (`cardMenu`,
      `viewerMore`) and in what a card or a shelf gives its viewer
      (`viewerEdits`);
    - and the review audit (`=a` and `=b`, two pages, each well inside the
      preview's minute):
      - placed and docked windows and a card through a real reload;
      - a Chat window viewing and reading its room on screen in the live
        band, and not off screen or zoomed out to cards;
      - a mention notification going to its room's area and Chat, and for a
        collapsed area (opened, the Chat placed) and a locked full one (the
        docked Chat already there, showing that room);
      - the keys and rail against the menu for an exited session and a
        teammate's, and a docked Chat's ⧉ in an area that isn't a room's;
      - the menus `main.tsx` builds for a taken-over session (Resume off),
        a terminal and a teammate's (nothing to hand on);
      - Size L picked from a menu opened before the area was locked;
      - a tool picked from a workspace's menu while it's docked;
      - a mention refused outside the artifact's area;
      - the cards band's window and card heads at screen size, neither
        covering another, kept as the camera moves;
      - sharing an area offering its artifacts once, its card following
        them; the Connected line's room list, Leave there, and the card of
        the room left;
      - the Follow indicator on an area that isn't a room's.
  - **Left for S6 and later:**
    - the selection bar (design Q), Tidy, guides and snapping, stacks UI,
      right-click create and ghost cards (S6);
    - the Needs you tray and the top bar (S7–S8);
    - context links (Link to a workspace) and a card wired to a workspace
      (phase 2);
    - a window can't be resized by hand yet: it opens at its tool's size.
    - area agents' artifact tools aren't pre-allowed or named in their
      instructions, as room agents' are: that needs the session's launch to
      know its area, which can change while it runs.

### S6 · Creating and arranging
- **The selection bar** (designs Q and Q2; landscape.md, Tools): selecting an
  area, a workspace or several shows their actions at normal size at every
  zoom, drawn from S5's action lists. Its width comes from its buttons; in a
  narrow window buttons fold behind » in priority order and » extends it onto
  a second row, remembered until « Less. Room tools only for rooms. Esc
  clears the selection.
- **Right-click on empty landscape:** Claude, Codex, Terminal, From a ticket…,
  Import….
  - Collab… and Pipeline from a ticket… show as "coming".
  - The menu opens today's New Session dialog or ticket popover, prefilled
    with the area's group, its repos and the click position.
- **Move and resize:**
  - dragging a header moves a workspace and dragging an edge resizes it;
  - both snap to an 8 px grid and to neighbours' edges, with guides drawn;
  - the S, M and L size presets live in the header menu.
- **Stacks:**
  - ⌘G on a selection makes a sub-group (`top/sub`); its tabs switch the
    active workspace;
  - dragging a tab out unstacks that workspace.
- **Tidy** (T) packs an area in creation order for now. Phase 3 lays it out
  along wires. Undo puts the old placements back.
- **Ghost cards:** they show the title, summary, branch and Reopen. The area
  ⋯ has **Clear ghosts** and **Reopen all** (today's restore all). A ghost
  continued on a teammate's Mac shows Take it back.
  - Left from S2: a closed session's placement stays in `workspaces` (it may
    be resumed); closing should turn it into a ghost, or they pile up.
  - Previous and the Connected line leave the area tree's foot once ghost
    cards and Reopen all are on the landscape (left from S4).
  - Ghosts whose group a rename merged into another area keep their old
    places (left from S4): Reopen places them, or they're moved in.
- **Tests:**
  - snapping and guides;
  - stack create, switch and unstack;
  - Tidy and its undo;
  - ghost written on close and resumed on Reopen.
- **S6a — As built** (the selection bar and right-click create; moving,
  resizing, stacks, Tidy and ghost cards are S6b):
  - **The selection bar** (design Q, sized as Q2; `SelectionBar.tsx`, its
    rules in `selectionBarModel.ts`):
    - **What can be selected:** one workspace (its header or card, its tree
      row, its terminal clicked into), one area (a click on its bare patch,
      its name line, header or pill — a pill's click opens it too — its tree
      row, or a right-click on it), or several workspaces (Shift-click on a
      header, a card or, below 75%, a terminal adds or takes one out; a
      marquee picks what it touches). One kind at a time: selecting one lets
      go of the others. A click on the bare landscape outside every area
      clears it. An area renamed or merged into another stays selected under
      its new key; one removed is let go (`areaSelectionNow`). The selected
      area draws a 2 px outline in its colour (inset zoomed out to cards), a
      collapsed one's pill too.
    - **Its buttons are the action model's rows**, never a second list, so
      each runs its row's handler, is off with the row's reason as its
      tooltip, and goes through the one tool gate:
      - an area's (`areaActions` in `workspaceActions.tsx`; `main.tsx` gives
        it its handlers): Chat · n (teal while unread, @n for mentions),
        Board, Members ▾ and Follow ⟨name⟩ only in a room's area, then Ask for
        status, Tools ▾ (the model's Tools rows as a menu) and ⋯. Its menu's
        sections: Area (Rename…, Collapse, Lock); Tools (Artifacts, and a
        room's Chat); Agent messages (As in Settings (…), Always auto-send,
        Always leave in prompt — the grid's group bar offers the same three —
        and the log); Sessions (New session here…, Ask for status); and in a
        room's area Team room (House board…, Follow ⟨name⟩ or Stop following,
        Invite a teammate…). Another area has no room rows at all, following
        or not, and ends with Share as a team room… on its own. The area's
        header (and the grid's group bar) agree: Follow ⟨name⟩ shows only in
        a room's area, which offers only that room's members to follow, and
        none while one of them is followed (`followIn` in `roomLiveModel.ts`
        keeps the one followed only where they're a member, so another
        room's area offers its own). While following, "Following ⟨name⟩ —
        Stop" is said once, in the status bar at the bottom of the window,
        whichever room's teammate it is (`FollowingNow`), never on an area's
        header or bar;
      - a workspace's: Focus ⌘E, Δ n Changes and ▶ n Run (the header's
        counts; "Δ ?" with the error as its tooltip when its git state can't
        be read), Files, Artifacts and ⋯. Artifacts (its area's window, by
        the area the layout has it in, which a rename not yet reached keeps,
        or its session's group while it has no tile yet; off for a loose
        one; `artifactsOf`) is a row of the workspace's Tools, so its ⋯ and
        right-click have it too;
      - several's (`severalActions`, one model for the bar and the
        right-click): n selected, Make area… M, Stack ⌘G (off, coming), Move
        to area ▾ (each area off with the reason Make area would refuse it,
        tried without being carried out: they're all in it, it's locked, or
        only teammates' workspaces are picked) and Close…, which lists every
        session of this Mac's in them (a picked stack's tabs each) in one
        dialog, "Close n sessions?", then closes them one at a time, each as
        it is then (one closed meanwhile is skipped), through its own Close
        (its dialog for uncommitted or unpushed work; cancelling one keeps it
        and goes on; its Cancel all, there while others are still to come,
        keeps it and stops closing the rest; one that fails is said in a
        notice and the rest go on). A second Close… on several while the
        first's are closing adds its sessions after those still waiting, each
        once (`queueClose`). One whose dialog would open while another
        session's close dialog is open (a single Close… asked meanwhile)
        waits first in the queue and is asked once that one's answered: one
        dialog never replaces another's (`closeWaits`; the queue's next step,
        none while one is closing or a dialog is open, is `closeStep`). Off when none of them
        is this Mac's.
    - **A right-click** on the bar or on the selection opens ⋯'s menu (for
      several, the same Make area / Stack / Move to / Close menu).
    - **Size and place:** at screen size at every zoom (outside the scaled
      world), 38 px tall, as wide as its buttons (measured once for each set
      of buttons, name and status, and width of view, before it's painted).
      It floats 8 px
      above the selection, lined up with its left edge: above an area's header
      in the live and read-only bands, above its name line zoomed out to
      cards, above its pill when it's collapsed. Over workspaces at the top of
      their area, where it would land on the area's name line or header, it
      goes above those instead (`barAnchorFor`). It slides along the window's
      edges to stay 8 px inside, never over the area switcher's strip. With no
      room above, it stays along the top edge over the selection's top rather
      than jumping below, so panning moves it continuously. It's placed in the
      camera's per-frame listener (`translate`), never by a render.
    - **Folding:** buttons that don't fit go behind "» n more" by rank: an
      area's Follow, Ask for status and Tools, a workspace's Files and
      Artifacts, and several's Stack and Close first, the rightmost first;
      then the rest only if it still doesn't fit; the name and ⋯ never. »
      puts them on a second row until « Less. That's a view preference of the
      window (`mb.landscape.barExtended`, through `prefs.ts`: storage that
      can't be read gives the default, and storage that can't be written
      keeps the choice for the run, both said in the console), never part of
      `landscape.json`.
    - **Esc:** a peek (kept open or not), an open menu or popover, or a
      dialog takes the first Esc; the next clears the selection. Esc with the
      keyboard in the bar clears it too.
    - **Decided here:**
      - at 75% and up a workspace has no bar: its header is at screen size
        there with the same chips and ⋯. An area's bar shows at every zoom;
      - in focus there's no bar;
      - while anything is dragged (a workspace, an area by its name, a window,
        a marquee) the bar is put away (`.ls-dragging`) and comes back where
        the drop leaves the selection;
      - a marquee round one workspace is a pick of one ("1 selected", so M
        makes an area of it), as in S4;
      - a workspace's name in its bar is cut at 150 px (Q's "Org
        dropdowns…"), with its full title on hover; an area's is its short
        name (#5101), as in Q.
  - **Right-click on the empty landscape** (`createActions` in
    `workspaceActions.tsx`): New workspace — Claude…, Codex…, Terminal…, From
    a ticket… and Import…, then Collab… and Pipeline from a ticket… off as
    coming. In an area, its own rows follow (its New session here… is the
    create rows) and the area is selected. Each opens today's New Session
    dialog: the agent picked, the area's group, its first repo and that
    repo's base preselected, the ticket field open (From a ticket…), or
    importing (Import…). The area's ⋯ New session here… seeds the same repo
    and base, and goes in its first free spot (below).
    - **Placed where it was clicked:** the first session of this Mac made in
      that area after the click (`createdAt`) goes at the click (`placeAt`:
      on the grid, inside the area's padding and under its header, or the
      nearest free spot by the edges of what's there), and its place is saved
      like any new one's. One that would reach past the area's edge is moved
      in to fit when that's within its own size of the click; otherwise the
      area grows for it, to the nearest spot where the area, grown to hold
      it, still keeps the gap from every other area. A spot the area holds
      without growing is taken as it is, even in an area already closer than
      the gap to another. Where no spot keeps the gap, the area grows towards
      its edge nearer the click: below, a new row just under its lowest
      workspace at the click's x, kept inside the padding; to the right, a
      new column just right of its rightmost workspace at the click's y, kept
      inside it (`growSpot`). The layout then pushes what's in its way aside:
      other areas, a locked one too, each as a whole, and what's in no area
      (workspaces, the places kept for loose sessions not shown, loose
      ghosts and tool windows), which moves `GAP` clear and stays in none.
      The area clicked never moves, and nothing is refused. The hint lasts
      until that place is saved, 10 s after the dialog makes it, or the
      dialog closing without one; an area locked meanwhile changes nothing.
      A click outside every area places a loose one there.
    - **Everything else new in an area** (New session here…, a session
      started elsewhere in its group, Move to area…/Make area… joining it, a
      tool window or a card, a resized workspace that no longer fits):
      `placeNew` takes the first free spot inside it in reading order; with
      none, `growSpot` from its bottom-left corner, a new row just below
      what's in it, at its left. What's inside the other areas is never in
      the way of either (it used to be: a full area with another just below
      put its new workspace below everything in that one, and pushed it
      aside), so `placeNew` isn't given them at all: only what's in the
      area. Callers grow the area between placements (`fitAreaTo`), the
      migration's frame too.
    - **Several areas growing in one pass** (a right-click's session and
      others arriving together) are held still together: one `pushAside`
      from all of them, the one right-clicked first, so a push that runs on
      from one into another goes past it; of two that grow into each other,
      the later goes past the earlier.
    - **One membership snapshot** (`keptIn`, `keptOf` in
      `landscapeModel.ts`): each layout pass and each gesture's plan first
      reads, from the stored layout before anything moves, which area each
      thing kept beside the visible workspaces is in: the places of
      sessions not shown and of hidden stacks (by the area holding them),
      ghosts (by their group), tool windows and cards (by their `area`);
      one in no area is loose, and so is a window or card naming an area
      that's gone, or a ghost whose group has none, as each is drawn. Both
      read the layout's own areas through `keptIn`: the layout pass once it
      has formed those its groups need (a group's stored workspaces framed
      in the same pass), a gesture the ones that layout ended with. Every
      move in that pass reads only that:
      an area pushed moves its own (`shiftKept`), once, wherever it ends;
      what's loose is pushed aside (`looseOf`, `pushAll`). The layout,
      `growArea` (a window opened or dragged in, a card placed), the
      gesture `moveArea` and making room (`placedIn`) all use it, so an
      area's hidden place is never taken for loose because a push moved
      it, nor moved twice when one pushed area pushes another. What the
      gesture itself moves (`leaving`: `tool:<id>`, `card:<id>`) is left
      out of the loose, so a window dragged into an area pushes nothing
      from where it was.
    - **What nobody sees never pushes:** the places of sessions and stacks
      not on screen (hidden, resumable or forgotten) and ghosts are passive. They
      move with their area, or out of the way when loose, and one pushed
      into something goes on past it rather than pushing it (`pushAside`'s
      `passive`). They're kept, not pruned: S6b's ghosts and Reopen all may
      need them.
    - Browser isn't offered: this plan's list doesn't have it (the spec's
      does), and there's no browser workspace yet.
  - **Left from S5, done:**
    - zoomed out to cards, a tool window or an artifact card stays inside its
      area's frame, 4 px in, shrunk to the area when the area is smaller, and
      clear of the next area's name line (`compactPlaces`): one that would
      cover another goes under it, beside it, or squeezed into what's left
      under it, and stays over it only when there's no room at all. A name
      line never leaves an area less than a squeezed card's height (28 px):
      with less room than that, the card is drawn over the name line;
    - a session a teammate took over has Undo the last turn…, Continue in …,
      Fresh session from a brief…, Second opinion and Resume off in its
      model, saying "⟨name⟩ continues it on their laptop: take it back …",
      so its header, menus, bar and keys agree. The grid's pane header (Undo,
      the other agent), the context warning's Fresh session with a brief, the
      Changes tool's Second opinion and ⌘K take those rows from the model too
      (`sessionAction` in `main.tsx`, `paneRow` in `workspaceActions.tsx`):
      the pane header and ⌘K show a row when it can be done, and off with
      the take-over's reason only where it would show without the take-over
      (never a terminal's Undo, nor one outside git); ⌘K dims the entry and
      says why beside it, and choosing it, by Enter or a click, runs nothing
      and leaves the palette open. Main refuses them as well, for a window
      that hasn't heard of the take-over yet: `handoff:start`,
      `review:start`, `turns:restore` and `usage:briefStart` are registered
      through `untakenHandler` (`takenOverGuard.ts`), which looks the session
      up and throws `takenOverRefusal`'s reason, saying what was refused,
      before the call's body runs. That's the taken-over check alone;
      `relaunchRefusal` adds to it the copy from a refused take-over, which
      only relaunching refuses. Main's check, the window's flag
      (`room.takenOver`, from `LivePanes.state`), the room a copy is shared
      in (`roomOfInfo`) and what a teammate's Mac may ask of it
      (`ownRoomSession`) all come from one function, `takenOverOwn`
      (`shared/team/takeover.ts`, through `LivePanes.takenOver`): a copy of
      this Mac's that a teammate took over in any room, whichever group the
      session is in now, with its current owner along the continuation chain
      (Ryan → Nick → Sam is Sam's). So a copy moved into a group shared as
      another room isn't that room's either, and can't be taken over twice.
      Resume is one call to main once the cost is agreed (`sessions:resume`,
      `SessionManager.resume`): refused, with nothing undone and saying why,
      for a pane that isn't an exited one here ("It isn't an exited pane
      here: reopen it from Previous"), one running ("It's running
      already"), one being resumed already ("It's being resumed already":
      main keeps the ids under way until each relaunches or fails and
      refuses to relaunch or restart them meanwhile; one stays among this
      Mac's sessions (`resumable()`) between its pty let go and its relaunch,
      so the room and take-over code never see it gone), a copy a teammate
      continues or one whose record is gone. A
      conversation it resumes by id that a Claude Code background session
      holds is let go next, the pane kept: one that can't be (mid-turn) is
      refused with why, so "Resume once that turn ends" still has its
      Resume button; then everything is checked again. Then its dead pty is
      let go and it's relaunched, nothing waited on between those last
      checks and letting go, and nothing at all from the first check when
      there's no conversation to let go. The window says a refusal with the
      session's title ("Couldn't resume ⟨title⟩: It's running already") and
      keeps the pane, says a relaunch that failed after that, and says a
      call that got no answer (`resumeExited` in `resumeFlow.ts`). A copy taken back since into
      another session here says so instead (`room.takenOver.back`: "It was
      taken back into another session here, which goes on with it: this
      copy doesn't run again"), in its rows, its pane's line and that line's
      tooltip, its sidebar row and Resume, rather than that a teammate
      continues it; otherwise they name the current owner.
  - **Following ⟨name⟩ — Stop in the status bar** (`FollowingNow`) sits in
    the bar's right-hand part after its notes (a read that failed, an
    update's trouble, the update link, the hooks missing). The right-hand
    part is `display: contents`, so everything in the bar gives way in one
    row, in turn: the hints at the end (sessions · groups, ⌘K commands, ?
    help, one box), then Following's words (a grid whose middle column goes
    down to nothing; its icon and Stop never shrink), then the notes' words
    (cut with an ellipsis down to 64 px, in full on hover; their ✕ stays),
    then the plan usage meter (down to 48 px). The update link and the hooks
    warning never shrink. Measured (`?statusAudit`), Stop always shows:
    - every note (`?statusNotes=all`): at 900 px both notes at 64 px and the
      meter at 48; at 1024 px the notes at 64 and the meter at 167; at 1400
      px the notes at 292 and 109, the meter whole, Following's words cut to
      nothing (on hover);
    - the link and the hooks only (`=few`): at 900 px Following's words cut
      to nothing and the meter at 199; at 1024 px the words cut (106 px with
      Stop); at 1400 px whole, "— waiting for a shared session" cut.
  - **A failed update shows as one** (older code): `UpdateProgress` names
    its reason `problem`, not `error`, which `isErr` took for a call that
    failed, so the status bar said "Couldn't read the update's progress…"
    instead of "update failed", and the update panel said it twice.
  - **Differences from Q and Q2:**
    - Q2's bar far out names the area in full ("#5102 Pathways quick
      view"); Q, the chosen design, uses the short name, as built.
    - Q2's ⋯ is a short list (Rename…, Collapse, Lock, Message mode ▸,
      Message log, Share as a room…, New session here); the bar's ⋯ is the
      area's whole menu with its headings, the one its right-click opens.
    - Q2's second row has Share settings, which neither the spec nor the
      model has; not built.
    - Q2 shows "» 4 more" at 640 px; the bar folds only what doesn't fit, so
      at 640 px (596 px of landscape beside the rail) Follow Nick stays and
      it's "» 2 more" (Ask for status, Tools ▾).
    - The fixture's accents (5101 pink, not Q's amber) are S4's.
  - **Performance**, 30 workspaces (`?landscapeMany=30&landscapePerf`, one
    run each on a loaded machine): frame interval p95 16.7–16.8 ms and no
    interval over 25 ms panning, pinching and sweeping at 100%, 60% and 30%,
    with no selection, an area's bar (`&lsSelect=area:601`), a workspace's
    (`&lsSelect=ws:w01`, none at 100% by design), and with `&lsWindows`
    with and without the area's bar. Main thread per pan frame p95: 7.9 /
    10.1 / 8.8 ms (100 / 60 / 30%) without a selection, 8.8 / 11.4 / 8.8 with
    the area's bar, 8.5 / 11.1 / 9.1 with the workspace's; with windows 7.3 /
    10.1 / 9.7 without and 6.5 / 10.5 / 10.2 with the area's bar: within run
    to run noise. One 27 ms main-thread frame at 60% with windows, with and
    without the bar.
  - **Preview:** `?lsSelect=area:<key>` (a click on its bare patch),
    `=ws:<id>` and `=pick:<id,…>` (Shift-clicks); `?lsBarMenu=more|tools|move`;
    `?lsBarExtended`; `?landscapeBarAudit=a…h` (eight pages, each well
    inside the preview's minute; their parts are in `stub.ts`); `?landscapePerf` records whether a bar rode
    along.
  - **Tests:**
    - `test/selectionBar.test.ts`: which buttons a room's area, another
      area, a workspace and several get, and their handlers and reasons; fold
      order, width from the buttons, rank 0 never folding; placing above,
      sliding, pinning, the switcher's strip; above a header, a name line, a
      pill; the remembered second row, with storage that throws; Esc; a
      taken-over session's rows.
    - `test/workspaceActions.test.ts`: the create rows.
    - `test/landscape.test.ts`: `placeAt`, growing towards the edge nearer
      the click past neighbours locked or not, and `placeNew` in a full area
      with others below and beside, the same whether they're given or not;
      `test/landscapeAreas.test.ts`: `pushAside` (several held still, gaps
      by pair, a passive one going past what it reaches) and drops pushing
      a locked area whole.
    - `test/landscapeView.test.ts`: a right-click's placement hint (own,
      new since, in the area clicked; loose), and an area hemmed in by
      neighbours locked and not growing towards either edge, never moving,
      its neighbours' workspaces moving with them; New session here…, a
      right-click (locked since the dialog or not) and Move to area… into a
      full area with areas below and to the right; two areas growing in one
      pass; a loose workspace pushed aside `GAP` clear, in the layout and
      for a gesture; for a gesture, a loose hidden place, ghost and tool
      window pushed aside and kept in no area; an area pushed by one pushed
      moving its hidden place once, which stays its own; a forgotten
      session's place, a loose ghost and a hidden stack pushed, each going
      past the area it reaches; a hidden place between the workspaces of a
      group framed in the same pass staying in it, and a gesture moving it
      along; a window and a card naming a gone area and a ghost whose group
      has none pushed aside as loose.
    - `test/landscapeTools.test.ts`: `compactPlaces` inside areas, beside or
      squeezed, and clear of another area's name line; making room for a
      window keeping the area's hidden place in it; a loose window dragged
      into an area pushing nothing from where it was.
    - `test/uiLandscapeBar.test.ts` drives `?landscapeBarAudit`: =a an
      area's bar at 12%, 30%, 60% and 100% (size, place, room tools only in
      a room's), its buttons and ⋯ making the same calls, right-clicks,
      sliding, hidden while dragging, Esc after a menu; =b a workspace's bar
      (Files both ways, Focus, none at 100%), a taken-over session's ⋯,
      three selected and moved to another area (a stack holding a
      teammate's tab staying, the note saying so), and right-click create
      in an area and in none; =c
      folding and the remembered second row at 640 px; =d (`&lsWindows`)
      windows and cards inside their areas at 13%, and a peek taking Esc
      first; =e–g the area menus, Close… on several and its queue; =h a
      right-click in an area hemmed in by locked ones that grows, pushing the
      one in its way whole, and Close… on several waiting for a single
      Close's dialog.
    - `test/takenOverGuard.test.ts` (`untakenHandler` with a fake
      `ipcMain`) and `test/teamTakeover.test.ts`: main's guarded calls, on a
      taken-over copy, a copy from a refused take-over and one no one took,
      `takenOverOwn` along a chain and taken back;
      `test/teamTakenOver.test.ts`: a copy taken back tagged `back`, and one
      whose group moved still tagged and refused;
      `test/connectedModel.test.ts`: the pane line's tooltip;
      `test/resumeFlow.test.ts`: Resume asking main once the cost is agreed,
      and saying each way it stops, refusals with the title;
      `test/sessionLifecycle.test.ts`: `SessionManager.resume`, refusing a
      second while one is under way and a running pane, nothing waited on
      from its first check to the kill (or, with a conversation to let go,
      from the checks made again), one under way kept among this Mac's
      sessions with relaunch and restart refused, a busy conversation
      refused with the pane kept, a take-over heard while it's let go
      refused with what letting it go did; a relaunch that fails after the
      pty went rereads the sessions, so Previous shows it;
      `test/takenOverGuard.test.ts`: its wiring;
      `test/selfUpdate.test.ts`: a failed update isn't an `{ error }`;
      `test/appModel.test.ts`: the close queue's step (`closeStep`), waiting
      while a dialog is open.
    - `test/uiStatusBar.test.ts` drives `?statusAudit` at 900, 1024 and 1400
      px, every note and the link and hooks only;
      `test/followingNow.test.ts`: what Following says, its parts, and Follow
      offered only while no one is followed.
    - `?landscapeAreasAudit` reads the several bar where it read S4's pick
      bar.
  - **Left for S6b:** moving and resizing with snapping and guides; stacks
    (the bar's Stack is off until then); Tidy; ghost cards, Reopen all and
    Clear ghosts, with S2's and S4's leftovers above.
- **S6b — As built** (moving, resizing, stacks, Tidy and ghost cards):
  - **Moving and resizing** (`Landscape.tsx`'s gestures, the rules in
    `landscapeModel.ts`):
    - A header drag moves a workspace; its edges and corners (`.ls-rz`
      handles, `RESIZE_EDGES`) resize it. Both go through `snapRect`: each
      moving edge snaps, within `SNAP_PX` (6) on screen, to a neighbour's edge
      lined up or `GAP` beside it, or to the area's inside edges (its padding,
      under its header); otherwise it's on the 8 px grid. A resize keeps at
      least `minWorkspace()` (a 40 × 8 terminal). Guides are drawn in the
      world, a screen px wide, one per neighbour lined up on the snapped line
      (`drawGuides`, imperative, never through a render).
    - A move translates the workspace itself while dragging. A resize and a
      tab dragged out show an outline instead (`.ls-sizebox`), labelled with
      the cols × rows the terminal would hold, or the tab's title; the pty is
      resized only once the drop's place is saved, and zooming never resizes
      it (S2's rule, unchanged).
    - `planMoveTile` and `planResizeTo` push what the dropped rect covers
      aside (`pushFrom`: in an area, its workspaces and what it keeps, places
      nobody sees passive; then the area fits and grows, pushing neighbours,
      locked ones whole). The moved workspace never moves. Loose, it's kept
      clear of the areas and pushes only loose things. Size S/M/L (the ⋯) now
      pushes too, rather than looking for a free spot (S5's rule).
    - A locked area refuses a move or resize as the drag starts, and the
      note says why; so is a teammate's resize (their terminal's size).
  - **Stacks** (`planStack`, `planUnstack`):
    - ⌘G on several, or the bar's Stack (now the model's row, through the
      one gate), makes a sub-group `area/tabs` (`tabs-2`… when taken) where
      the first of them in reading order was, its session in front; a stack
      among them takes the others in. A teammate's workspace stays out, the
      note saying so. Refused across areas, loose, or in a locked area.
    - A tab click brings it to the front; a tab dragged out (`"tab"`
      gesture) drops it where it's let go as the area's own workspace,
      pushing what it lands on, its own stack too. A stack left with one tab
      and no closed tabs is let go, that tab taking the stack's place; a front tab leaving
      brings the next to the front. A stacked card has its tabs layered
      behind it (`.ls-node.stack`), zoomed out too.
  - **Tidy** (`planTidy`, `tidyRefusal`): T on the selected area (or the
    selected workspace's), its ⋯, or the hover toolbar, which now renders the
    area model's Tidy, Collapse and Lock rows (`arrange`), in that order. Rows as wide as the
    area is inside, in the order workspaces and ghosts were made (earliest
    session), each session's tool windows after it, then what else the area
    keeps in reading order; the area then fits, pushing neighbours when it
    grows. The note says "Tidied …" with **Undo** (`undoOf`), also ⌘Z while
    it shows. Refused locked, collapsed or empty.
  - **Ghost cards** (option A, outline; `GhostCard.tsx`):
    - A ghost is a closed session this Mac can resume (main's resumable
      ones, room tags merged in), drawn at the place `landscape.json` kept for
      it (`workspaces`, or its stack's); one with no place is in the Closed
      sessions list (review round 1, below). `resolveLayout(…, closed)` keeps
      ghosts apart from `tiles`, so selection, focus, peek and counts never take one. A
      closed tab of a stack on screen is a faded tab on it (`Tile.closed`).
      Ghosts are pushed aside but push nothing. The old `l.ghosts` record is
      left unused (the format stays v2).
    - Rows, top to bottom: title (with the kind and ⋯), **↺ Reopen** and
      Forget, its last line (`sessions:closedOutput`, the scrollback's tail),
      its status with ticket · branch. They're also the order a short ghost
      gives them up from the end: `.lg-rows` is a column that wraps, each row
      its full width, so a row that doesn't fit whole goes to a second column
      past the clipped edge. Zoomed out (cards band) it's inset by `--ci` as
      cards are, its type at screen size, Forget and ⋯ left out (right-click),
      and its foot kept
      clear of the next area's name line (`ghostDrawnHeight`, set by
      `paintCompact` as `--ls-gh`), unless that leaves too little of it.
    - Actions (`ghostActions`, its card, ⋯ and right-click): Reopen
      (relaunched under its id, the cost asked first, so it lands in its
      spot), off for a copy a teammate continues (the take-over rule; main
      refuses too) and for one whose folder is gone (`sessions:
      missingFolders`), which offers **Start fresh** (New session seeded
      with its agent, area and repo; `PlaceHint.replaces` puts the new one
      exactly in the ghost's place and the ghost is forgotten once it's
      saved); the room's Take it back; **Forget** (`killSession(id, true)`
      and `forgetPatch`, which drops its place, and a stack's once every tab
      is forgotten).
    - `ghostsActions`: Reopen all and Clear ghosts (asked with a confirm),
      over an area's (its ⋯), the loose ones' (the tree's Loose row, a
      right-click outside every area) and every ghost (⌘K).
    - **Closing on the landscape keeps the session resumable**, so every
      close leaves a ghost: `requestClose`'s quick paths no longer forget,
      and the close dialog's Keep says "its ghost stays where it was". Push
      or discard there still lets the session go. The grid is unchanged.
    - **Previous leaves the area tree's foot**; the Connected line stays.
      Relaunch → Reopen, restore all → Reopen all, forget → Forget / Clear
      ghosts, take back → the ghost's Take it back. (Review round 1 puts the
      closed sessions with no ghost back there, as the Closed sessions list.)
    - A move of closed sessions (a stack's closed tabs go with it) rereads
      the resumable list (`runMoves`); the preview's `setGroup` and
      `renameGroup` move closed sessions too, as main's do.
    - `?landscapeAreasAudit`'s minimap has the loose ghost's block;
      `?landscapeBarAudit=b`'s right-click outside every area has the loose
      ghosts' rows; `?landscapeToolsAudit`'s dead card closes to a ghost.
  - **Preview:** `?lsClosed=<id,…>` closes those sessions as if closed with
    their places kept (y1 shows Take it back); the fixture's closed ones are
    p1 (loose), g1 (5102) and g2 (5101, its worktree gone). `?lsKey=<key>`
    presses a key on the landscape once the selection settles (`cmd-g`: ⌘G;
    `t`), with `?lsPick` or `?lsSelect`; `?lsDrag=move|resize|tab` holds a
    drag mid-way for a screenshot of its guides or size box.
  - **Tests:**
    - `test/landscapeArrange.test.ts`: `snapRect` (grid, neighbours, GAP
      beside, SNAP_PX on screen, inside edges, resize edges and minimum);
      `planResizeTo` and `planMoveTile` pushing, refusals; `planStack`,
      `newStackName`, `planUnstack` (front, dissolving, dropped over its own
      stack, refusals); `planTidy` with a ghost and its undo, `tidyRefusal`;
      ghosts in `resolveLayout` (kept places, placed when they have none,
      pushed never pushing, `replaces`), `forgetPatch`, `ghostDrawnHeight`.
    - `test/workspaceActions.test.ts`: Tidy and the ghosts' rows in the area
      model, `ghostsActions` off with none, `ghostActions` (folder gone,
      taken over). `test/selectionBar.test.ts`: Stack ⌘G on, and off with
      planStack's reason. `test/scrollback.test.ts`: `closedOutput` (tail
      from a line's start, refused while running or not this Mac's, "" with
      none saved), `tailOf`, `missingFolders`.
    - `test/uiLandscapeGhosts.test.ts` drives `?landscapeGhostAudit` (every
      ghost at 10%, 13%, 15%, 20%, 30%, 45% and 100%: inside its area and
      clear of other areas' name lines, every row it shows wholly inside it,
      the rows it shows a prefix of its order) and `?landscapeGhostLifeAudit`
      (the tree's foot, ⌘K's rows, close → ghost in place → Reopen in place,
      Start fresh, Forget, Clear ghosts, the Loose row's Reopen all).
    - `test/uiLandscapeArrange.test.ts` drives `?landscapeArrangeAudit`: =a a
      header drag snapping to an edge with a guide, an edge resize with its
      size box and no pty resize until the drop, a locked area refusing both;
      =b ⌘G, a tab switch, a tab dragged out over s1 with nothing left
      overlapping, T and the note's Undo.
    - `test/uiLandscapeBar.test.ts`: the several bar's Stack now on.
  - **Decisions for Ryan:**
    - Ghosts are resumable closed sessions (accepted with option A); Reopen
      relaunches under the same id; merged groups' ghosts move into the area
      they merged into (the rename drops their places; they're placed anew).
    - Closing on the landscape always leaves a ghost, even a clean worktree's
      (the grid forgot those), and so does a dead workspace's Close & clean
      up (a taken-over one's ghost offers Take it back); the dialog's push
      and discard still forget.
    - A press on a ghost (not its buttons) is one on the landscape where it
      lies: it selects the area, or starts a marquee. Ghosts aren't selected.
    - Clear ghosts asks (a browser confirm); a single Forget doesn't.
    - The notes (Tidy's Undo among them) moved from the top to over the zoom
      HUD, as design E has its toast, clear of the selection bar.
    - Size presets push neighbours instead of moving to a free spot.
    - A stack's auto-name is `tabs`, `tabs-2`…; ⌘G with a stack picked fills
      that stack; a stack of one dissolves.
    - Tidy packs into the area's inside width and lets the area shrink.
    - Loose drops and resizes stay clear of areas (S4's rule) and push only
      loose things.
    - Ghosts can't be dragged; Tidy and pushing move them.
  - **Differences from the designs left, and why:**
    - guides have a colour of their own (`--snap-guide`, review round 1); no
      board shows them;
    - at 100% a ghost leaves the rest of its place empty (option A's frame),
      its actions under the title rather than centred;
    - ghosts aren't rows in the area tree; an area's summary counts them
      ("n closed").
  - **Left for later:** a ghost dragged by hand; Tidy along wires (phase 3).
- **S6b review fixes (round 1) — As built:**
  - **Closed sessions list** (Ryan's decision; `ClosedSessions.tsx`,
    `closedListOf`): only a closed session with a kept place (its own, or its
    stack's) is a ghost; `resolveLayout` places nothing for one without. The
    rest are listed under the area tree above the Connected line, and in ⌘K
    (Reopen all, Forget all, each one's Reopen); every closed session while
    there's no layout yet (the landscape still being read in). Rows run the
    ghost model (`ghostActions`), so the take-over rule is the same: a copy a
    teammate continues offers Take it back, never Reopen. Reopen from the
    list placed it loose when its area was gone (round 2 changed that: it
    never changes the group). A ghost's group with no area draws it loose;
    ghosts never form areas (M4).
    The migration (`migrateLayout`'s `closed`) no longer places a closed
    session the grid's layout didn't name: Previous stays a list.
  - **H1:** pending renames settle only when the closed list has followed
    too (`renamesLeft`), so a ghost in a renamed or merged area stays in it.
  - **M1:** main refuses a relaunch while one is under way (`relaunching`,
    "It's being reopened already") or while it's running ("It's running
    already"), and a forget while it's being relaunched or resumed. The
    window keeps a busy set per closed session (`whileClosedBusy`): its
    Reopen and Forget are off meanwhile (`CLOSED_BUSY_WHY`), and Reopen all
    is off while one runs.
  - **M2:** a left or top edge dragged past the area's inside edge stops
    there, the opposite edge kept (`planResizeTo`).
  - **M3:** Tidy's Undo applies only while the landscape's revision is the
    one the Tidy saved (`LandscapeStore.revNow`); otherwise the note says it
    can't.
  - **M5:** every forget goes through `forgetSession` or `forgetGhosts`,
    which read `forgetPatch` before the kill (a stack's entry included, now
    for running stacks with closed tabs too); places left in old data by
    sessions neither live nor resumable are passed over by placing and Tidy
    (`withoutGone`, only once every list has been read), never pruned.
  - **M6:** a tab drag starts only past `TAB_DRAG_PX` (14) or off its
    workspace's header; the tab-out note has Undo (`undoOfPlan`, groups back
    first, then places).
  - **M7:** the note's ⌘Z is a capture-phase listener while the note has an
    action, skipping terminals, text fields, menus and dialogs.
  - **Low:** Reopen offered for a removed worktree whose branch is still here
    or on origin (`folderGone`: `MissingFolder` with accurate wording for a
    branch gone, a folder gone, a repo gone, a volume not connected); a
    stack's ghost's Reopen and Forget cover all its closed tabs; Reopen all
    counts only reopenable ones and is off with a reason at none; the Loose
    tree row shows for loose ghosts alone; the preview's relaunch refuses a
    taken-over copy and a running one; Start fresh hides the ghost from the
    moment its replacement is placed and lets its place go before the
    forget, saying a failure; a stack keeps its closed tabs when one running
    tab is left; `freeSubName` shared by `newStackName` and `nextSubName`;
    the note placed by `notePlacement` (left of the minimap, above a low
    selection bar); ghost status `flex-shrink: 0`; a workspace card's stack
    chip `stack · N` with its tabs' names; hover toolbar Tidy first; ghost
    type 11 px on screen from 100% down (`max(1, inv)` in every band); snap
    guides in `--snap-guide`, running 16 px past both ends; stack layers at
    least 3 and 6 px apart on screen; no ⋯ on a ghost zoomed out to cards;
    room sends' failures as notes; the section named Ghosts; `runRow` and
    Start fresh say what went wrong.
  - **Preview:** the fixture's p1 is a loose ghost; o1 (5102) and o2 (5150,
    no area) are closed with no place, so listed. `?lsUnplaced=<id,…>` drops
    those sessions' places (closed off the landscape); `?lsHold` never
    answers the landscape read (no layout). New audits:
    `?landscapeClosedAudit=list|hold`, `?landscapeFixAudit=a|b`.
  - **Tests:** `sessionLifecycle` (relaunch and forget refusals),
    `scrollback` (`missingFolders` cases), `landscapeArrange` (list rule,
    loose ghosts, rename and merge with ghosts, M2, `forgetPatch` for running
    stacks, `withoutGone`, unstack Undo, closed tabs keep a stack,
    `notePlacement`), `landscapeMigrate` (Previous unplaced),
    `workspaceActions` (busy, branch kept, stacks, Reopen all counts),
    `uiLandscapeClosed` (the list with and without a layout; toolbar order;
    ⌘Z after a toolbar Tidy; Undo refused after a drag and a lock; guide
    colour and reach; the note against the bar and the minimap; a slipped
    tab click; tab-out Undo; Esc on a move, a resize and a tab drag; ghost
    status zoomed out; type size either side of 75%).
  - **Decisions for Ryan:**
    - Data already migrated keeps its places, so sessions that were in
      Previous when the landscape was first turned on stay ghosts; only new
      migrations leave them listed. Clear ghosts in an area or the Loose row
      clears them.
    - (Superseded in round 2: Reopen never changes the group.)
    - Start fresh from the list opens New session seeded as from a ghost but
      leaves the closed one listed, to forget by hand (there's no place to
      take over).
    - The list's clear-all reads "Forget all" (there are no ghosts in it);
      the confirms now say "Forget …" everywhere.
    - Undo after Tidy or a tab-out is refused once anything else changed
      the landscape (another window's change too), rather than checked field
      by field.
    - Orphan places are ignored, not pruned, so a list read wrongly can't
      delete anything.
- **S6b review fixes (round 2) — As built:**
  - **H1:** `withoutGone` takes the pending renames: a stack is known by its
    key on either side of one (`renamedKeys`, shared with `resolveLayout`'s
    hold), so a stack isn't passed over, placed anew and saved while the
    sessions and the landscape's re-keying disagree, in either order.
  - **M1:** a relaunch never makes a branch (`createWorktree`'s `mustExist`,
    from `launchAgain` through `create`'s `relaunch`): a branch origin has
    deleted is made again from what the last fetch kept (`--track -b b path
    origin/b`); with none of that it throws "Its branch, b, isn't here or on
    origin any more: start fresh", starting nothing. Every relaunch path
    (ghosts, the list, the grid's Previous, NewSession restore, transcript
    open, post-update restore) goes through `launchAgain`.
  - **M2 (the coordinator's rule):** Reopen never changes the group
    (`placeReopened` removed). The session lands in its group's area, which
    the layout forms around it again if it's gone, as for any running
    session; a failed relaunch leaves everything as it was.
  - **M3:** a merge keeps this Mac's closed sessions' places inside the old
    area, and the stacks of closed tabs, moved into the area joined
    (`renameAreaPatch`'s `closed`, from main's resumable list read before
    the rename; `mergeClosedInto`): each where it sat measured from the
    area's corner when that's free inside, else where a new workspace goes,
    the area growing and pushing what's in its way aside (`pushAside`, areas
    with what's in them).
  - **M4:** a stack's card zoomed out has its `stack · N` chip in the title
    row and a row of its own for the other tabs' names (`.ls-card-tabs`), "N
    needs you" first, ending in an ellipsis; the footer keeps its tokens.
  - **Low:** a worktree folder deleted outside git is unregistered
    (`git worktree remove`, that path only) before it's added again; a
    stack's ghost has Reopen off when none of its tabs can reopen; Reopen of
    several (a stack's, Reopen all) asks once about cost (`useCostGate`'s
    `resumeAll`, `sumEstimates`); ⌘Z's check is `ownsKeys` (the code editor
    too); a tab pressed and let go without being dragged out is brought to
    the front by the gesture itself, the browser's click taken; Undo of a
    tab-out puts the stack's entry back first, then the groups, then lets the
    tabs' own places go (`undoOfPlan` → `{ patch, after }`), saving nothing
    between; Undo goes by the revision the change's own save made
    (`LandscapeStore.save`, `carryOut`'s `rev`); a failed read of the closed
    sessions is said and tried again (1 s, doubling to 30 s) until it's read,
    the error cleared then; a ghost is in its group's area only while it lies
    inside it, else the area holding it, else loose; a move never snaps past
    its area's inside top or left; the list's header is one line with an
    ellipsis, its rows' titles carry their status, its menus are headed
    "Closed sessions" (`menuOf`'s names), its wording agrees in number
    ("Forget all 15 closed sessions? They can't be reopened after."), its ⋯
    holds Reopen all and Forget all, and its rows carry the ghost's hollow
    ring; the guide colour is violet (#c44dff dark, #9d1fff light), ΔE 50 or
    more from every area accent; `whileClosedBusy` catches, logs and says
    what its work throws; the selection bar keeps clear of the minimap
    (`barPlace`'s `avoid`); no peek opens on what a drop leaves under the
    resting pointer; a detached worktree's session relaunches in its own
    folder (refused once that's gone), never the main checkout.
  - **Preview:** `?lsRelaunchFails`, `?lsBigResume`, `?lsManyClosed`,
    `?lsClosedReadFails`, `window.__mbRaceUpdate` (another window's change
    told before a save's answer). Audits: `?landscapeClosedAudit=retry|many`;
    the list, hold, fix a and fix b audits extended.
  - **Tests:** `landscapeArrange` (renamed stacks in `withoutGone` both
    ways; ghosts in the area they lie in; the merge test on the real
    `renameAreaPatch`; no snapping past the inside; Undo's order with
    nothing saved between), `landscapeAreas` (a merge keeping closed places
    and stacks; growing and pushing aside), `sessionLifecycle` (relaunch from
    the tracking ref, refused with no branch, a folder deleted outside git, a
    detached worktree), `workspaceActions`, `contextBudget`
    (`sumEstimates`), `contrast` (guide vs accents), `selectionBar`
    (`barPlace` clear of the minimap), `uiLandscapeClosed` (Reopen into a
    gone area with a failing and a throwing relaunch; Reopen all asking once;
    the read retried; a long list; ⌘Z in the code editor; Undo refused on a
    race; slips at 50% and 100%; the stack card at Fit and 30%; no peek after
    a drop; the bar clear of the minimap), `uiLandscapeGhosts` (wording).
  - **Decisions for Ryan:**
    - Reopen never changes a session's group (the coordinator's call, as
      you hadn't said): one whose area is gone gets it back around it.
    - A move snaps nowhere past its area's inside top or left (a drop moves
      it back in from there); past the right or bottom it still snaps, as the
      area grows to hold it.
    - The guide is violet; it reads apart from every accent and the focus
      outline.
    - The Closed sessions header's Forget all lives in a ⋯ beside Reopen
      all (the sidebar is narrow), as well as the header's right-click.
    - A failed read of the closed sessions is retried with backoff, forever,
      while it keeps failing; each failure is in the status bar.
- **S6b review fixes (round 3) — As built:**
  - **M1 (zoomed out far):** a card's width in landscape px doesn't change with
    the zoom, so a container query's fixed width can't tell how wide it is on
    screen. `.ls-card` is a size container with `--ls-narrow`, a length that's
    far above 0 while its content box is under 200 screen px (`200 * var(--u) -
    100cqw`, times 1000; `100cqw` is the content box, so that's a card about 222
    px wide on screen) and far below it over them, and clamps on it do the giving
    way: there a stack card's ticket goes (its area names it) and `×N` before the title
    takes over from `stack · N` after it, where the ⋯ over the head's end can't
    reach it (there are two chips, one with no width at any time). No render and
    no JS: it follows the camera. `.ls-card-title` has a floor of `4ch`. 200
    rather than the review's 170, as the title was still "API: las…" at 1440
    Fit, about 190 px wide. At 10% a stack card is 97 px wide on screen: a
    reserved margin for the ⋯ after the chip would leave its title under 4ch.
  - **M2:** the list's header reads **Closed (n)**, whole at every count at the
    default sidebar; `aria-label` and `title` say Closed sessions (n), and the
    word still gives way before the count at a far narrower sidebar.
  - **M3:** `launchAgain` asks `whereAgain` where a closed session runs. In the
    checkout itself: `{cwd}` and whichever branch is out now, so `create` never
    reaches `slugBranch` or `checkoutBranch`. A relaunch never switches a
    branch or makes one, whatever its ticket or `branchName`. `branchName` there
    is `currentBranch`'s, as what a session says it's on is what stops another
    switching the checkout under it (`create`'s `other`). Tried against real
    repos: its branch deleted, the checkout moved on, and a custom branch.
  - **Worktrees, one folder at a time:** `unregisterMissing` runs `git worktree
    remove` only on a path `worktree list --porcelain` itself marks `prunable`;
    that command deletes a folder that's there, ignored files (a `.env`)
    included. `folderThere` tells gone (ENOENT, ENOTDIR) from can't-look
    (EACCES throws), where `existsSync` said false to both, and `createWorktree`
    runs one at a time per path (`oneAtATime`), so several at once on a stale
    registration all get the one folder. Locked and missing stays registered,
    and `worktree add` says why.
  - **`startPoint` with origin in trouble:** `onOrigin` says whether origin
    answered (`asked`). A relaunch that found origin unreachable goes straight
    to the last fetch's ref, without a fetch that would only wait out its
    timeout; one whose fetch fails after origin answered logs it and uses the
    ref. `--track` is left off with no `origin` remote (a ref a removed remote
    left), where git refuses it. A new session's fetch still fails aloud.
  - **Suffixed folders:** a worktree session runs in `old.cwd` while that's there
    (a take-over's can be `<branch>-2`). (Round 4: one that's gone is made again
    there too, not at `worktreeRoot/<branch>`.)
  - **One reading of what's where:** `keptIn`, `shiftKept`, `looseOf`, `pushAll`
    and `FullPatch` moved to `shared/landscape.ts`, and `mergeClosedInto` now uses
    them instead of its own `within` loops and `moveAreaWhole`. `holdingArea` is
    the one place "the area holding this place" is decided (`keptIn`, a ghost's
    area in `resolveLayout`, `renameAreaPatch`'s "inside `from`"). That gives
    a merge's growth the loose windows and cards it missed, and its push no longer
    brings back what it dropped: a Kept's `at` is null once the patch has dropped
    it, in gestures too. Main has no layout, so in a merge every place counts as
    not shown: pushed aside, pushing nothing.
  - **Merges keep every ghost inside the old area:** `sessions:renameGroup` passes
    all resumable sessions, as a ghost from group G lying inside A is A's; the
    `inFrom` check limits which places move.
  - **Reads retried, errors by their own source:** `readGone` retries like
    `readClosed` (`goneFails`), and `readCleared(what)` takes only that read's
    error off the status bar.
  - **Chained renames:** `renamedKeys` follows them both ways, nearest first, and
    ends on a cycle; `areaSelectionNow` goes by it too.
  - **Layout fuzz (`test/landscapeFuzz.test.ts`):** 40 fixed seeds of 120 random
    steps, in about 2 s: moves, area moves, resizes, presets, stacks, unstacks,
    Tidy, forget, reopen, close, a session gone from both lists, new sessions,
    merges, renames, locks and windows. After each step: one pass settles, areas
    keep AREA_GAP, nothing overlaps (places nothing draws included), a workspace
    in an area is inside it and one in none is over none, a locked area moves
    whole with its insides where they were, the mover stays, and membership is
    the same on a second pass. A last test fails if any gesture went untried. A
    wider one-off (600 seeds of 200 steps) found nothing more. (Round 4 widened it.)
  - **What the fuzz found:** dragging an area dropped it over what's in no area.
    `planMoveArea` now pushes that aside (`looseThings`, shared with `growArea`),
    the other areas staying put, as one pushed into an area goes on past it.
  - **LOW:**
    - `stack · N` comes before the ticket, so the ⋯ covers the ticket, as on any
      card; with no ticket a margin keeps the chip clear of it, and `×N` is left
      of the title. So a selected stack card always shows its count.
    - A tab's slip off its header has 8 screen px of slop (`TAB_SLIP_PX`), since
      the header is 16 px at 50%.
    - The guide's colour is checked against `--ls-a*`, what areas are really drawn
      in (amber, teal, `--git-mod`, m-2, m-4, m-5). It passes unchanged: ΔE at
      least 68 dark, 66 light.
    - `sumEstimates` says "their caches…" or "some of their caches…" for several;
      Forget all reads "Forget all the closed sessions here: they can't…".
    - `snapRect` keeps the plain grid inside an area's top and left too, a move's
      and a top or left edge's, so what's held is where a drop leaves it; a drop
      back where it started has an empty plan (`planMoveTile`, as `planMoveArea`
      and `planResizeTo` had), so it's let go at once rather than waiting out
      `SETTLE_MS`.
    - The status bar's meter drops its parts whole, last first (they wrap to a
      row its height hides), so nothing is cut into, and today's word and number
      go together. Its floor went from 48 to 56 px, room for "5h 100%".
- **S6b review fixes (round 4) — As built:**
  - **M1 (a relaunch in a folder on another branch):** `worktreeAt` picks
    `<root>/feat-2` only when `<root>/feat` is on another branch, so remaking a
    gone `feat-2` at the usual place returned that other folder. Now a gone
    worktree is remade at `old.cwd` (`createWorktree`'s `at`, which skips the
    old layout), so the agent returns to the folder its transcript is kept by.
    And `createWorktree` reuses a folder only if `branchIn` says it's a checkout
    of that branch: it refuses one on another, a plain one (even inside another
    repository), and a detached one. An old-layout folder on another branch isn't
    holding the branch, so a new session's worktree goes at the usual place.
    `unregisterMissing` takes the path itself, resolved by `realOf`, so a `-2`
    folder deleted outside git clears its own registration.
  - **`whereAgain` settles the folder, all of it:** it makes a gone worktree or
    throws, so `create` no longer takes a `relaunch` flag. `relaunch` calls it
    before `freeConversation`, so a background session isn't stopped for a
    session with nowhere to run. `resume` does too, but only when there's a
    conversation to free: with none, its first check to the kill still waits on
    nothing, and a failure after that leaves the session resumable, as before.
  - **What's out in its folder:** a worktree session's label is read from
    `currentBranch` as a checkout session's is, what `reviewPrompt` and
    `companionSession` go by, and the pane says "This session was on x. Its
    folder is on y now." when they differ. A failed read logs and keeps the record.
    A repo-less session runs in its own `cwd`, not home, and is refused once that's gone.
  - **The checkout's guard** sees any live session there, a plain one too: it
    runs on whatever's out, so switching would move it. A plain terminal in the
    checkout now blocks a new ticket session there unless nothing would switch.
  - **Refusals:** a branch that's missing when origin couldn't be asked says to
    try again when online, not to start fresh. `mkdirSync` went from
    `createWorktree` and `worktreeAt`, as `worktree add` makes the folders above
    it, so a refusal leaves nothing behind.
  - **`removeWorktree`** no longer runs `worktree prune`, which counted an
    unreadable folder (and likely a disconnected volume) as gone.
  - **Merges:** another group's closed stack lying inside the old area moves like
    a closed session of that group there. One with nobody closed in it is let go,
    as any place inside the old area is; the fuzz found it left lying inside the
    grown area, under a ghost.
  - **Reopen drops a place outside its own area** (`reopenPatch`, from
    `LandscapeStore.sessionReopened`, after `sessions:relaunch` succeeds, so every
    way of reopening goes by it). Running, a session is in its group's area wherever
    it sits, so dragging that area would leave it behind. With no area of its own a
    free place stays for one to form round; loose, one inside an area goes.
  - **Any card's ticket gives way** below the threshold, not only a stack's.
  - **Status bar notes** (`readNotes.ts`): each read source has its own note, and a
    dismissed one stays away until a success or different words, so retries neither
    overwrite one another nor bring back what was dismissed. `unlessError` and the
    session list now clear theirs on success too.
  - **`renamedKeys`** stops at `RENAMED_MAX` keys: `{A/b→A}` makes a longer key each
    time round, and it runs in a render.
  - **Layout fuzz, widened:** a 2×2 grid at exactly AREA_GAP, so growth pushes; a
    pass between a plan's patch, groups and `after`; renames on their way, chained
    too, in either order, saving nothing and forming no area meanwhile; collapse;
    an area dragged onto a loose ghost; another group's ghost and closed stack lying
    inside an area. New assertions: closed places survive a merge, inside the
    area joined; nothing's left under the old name; ghosts are inside their area or
    over none; and only what's drawn pushes (each thing that moved in the area was
    reached by the mover, or by something drawn that moved). Passive off in `keptIn`
    or `ghostKept` fails it, and each has a unit test.
  - **UI tests' cleanup race** (`scripts/ui-preview.mjs`): `stopChild` asks Chrome,
    waits 10 s, then SIGKILLs it, and `removeWhenLetGo` tries for about 10 s, as its
    helpers can still be writing. A folder that won't go is a warning naming it, not a
    failed test.

### S7 · Needs you
- **The tray** drops down from the top-bar button. Phase 1 items:
  - waiting permission prompts (amber status);
  - finished workspaces that are now idle;
  - room join requests.
- **Each item** has Go there (focuses the workspace) and Dismiss. Allowing or
  denying a permission prompt happens in the terminal, as today.
- **`N` / ⇧N** move to the next / previous item.
- **Badges:**
  - **Areas:** a waiting count in the sidebar, switcher and pill.
  - **Card footers:**
    - diff size, from the worktree's `git diff --shortstat` against the area
      repo's base, refreshed with the SCM view's poll;
    - PR state, from `pipeline.ts`;
    - cost and tokens, from the meters.
  - **"What it did" line:** the first line of the agent's latest message from
    its transcript, the same source the digests use.
  - **Tests badge:** waits for phase 3.
- **Tests:**
  - tray contents from fixture statuses;
  - N order;
  - badge values;
  - a badge whose source fails shows "—" plus a logged reason, never a
    stale value.
- **S7 — As built:**
  - **The tray** (`NeedsYou.tsx`; its rules, pure, in `needsYouModel.ts`):
    - **The button:** "Needs you" with its count, in the top bar before New
      / Import, shown on every tab while the Labs flag is on. Amber with a
      count while anything waits; it drops the tray (an `AnchoredPopover`
      with `below`): under the button, right-aligned to it, never taller
      than the window below it (its list scrolls), and placed again when
      its size or the window's changes (a `ResizeObserver`). The tray takes
      no focus ring; Esc closes it and gives the keyboard back to the
      button, where N and ⇧N still work, as its tooltip says. A dialog, the
      command palette or Quick Open opening puts the tray away
      (`DIALOG_OPENED`, `useDialogFocus` in `Modal.tsx`) rather than leaving
      it over their backdrop, and they give the keyboard back to the button
      when they close. The button is 24 px tall, beside New / Import, with its count
      or without, so the tray under it never moves. In the top bar nothing
      wraps (`nowrap`); below 1000 px the brand's name and New / Import's ⌘N
      hint go, so the bar fits at 860.
    - **Its items, in order** (`needsItems`): sessions waiting on you
      first (a permission prompt, "API wants to use Bash", the tool set in
      code, or a question it asked, labelled Waiting), then join requests,
      then finished sessions; newest first within each kind. Each line says
      its kind, its area's short name (the full name on hover) and how long
      it has waited.
    - **What's left out** (`notMine`): a teammate's session (it waits on
      them), a copy a teammate took over or took back (`takenOverWhy`, the
      same rule as the action model's), and a morning brief or wrap-up (it
      lives on the WorkTracker tab). A muted session is still listed: muting
      silences its notifications, not what it waits on. Closed sessions
      (ghosts, a stack's closed tabs, the Closed sessions list) are never
      listed or counted, though their records keep how they stood when they
      closed, a turn's end or an unanswered prompt: the tray reads the live
      list, not the resumable one. A reopened one starts from nothing
      (`create` makes a new record), so it's finished only once a turn ends
      in it.
    - **Join requests** are the list the admin's prompt and Members ▾
      already read (`adminRequests(teamStatus)`, `joinAsks` in `main.tsx`):
      only those this install answers as a room's admin and still waiting.
      Accepting or declining stays in the admin's prompt. When the team
      status can't be read, the tray's first row says so ("Couldn't read the
      rooms' join requests: …"), so no requests listed isn't taken for none;
      with nothing else listed, the button's tooltip and N say it too, and
      "Nothing needs you right now" isn't said.
    - **"Finished, now idle"** is told by the main process, since the
      window can't tell a session that has just started (idle) from one
      whose turn ended (idle): the Stop hook sets `finishedAt` on the
      session (`finishedAtAfter` in `sessions.ts`; `hooks.ts` passes
      `finished` for Stop). It holds while the session stays idle (the
      idle reminder keeps it, a second Stop keeps the first time), and goes
      when it works, waits or starts again, or exits. Claude Code's Stop
      fires once at the end of the agent's turn, not at each tool call, so
      this is a turn ending, not wire-sense finishing (`finish_step`,
      phase 2).
    - **Each item's actions** are the action model's rows (`needsActions` in
      `workspaceActions.tsx`, section `needs`), drawn as buttons:
      - **Go there** (`toNeeds` in `main.tsx`, the same path N takes): from
        any tab, a workspace is brought into view (a stack's tab brought to
        the front first, `reveal`'s `front`), selected, and the keyboard
        given to the landscape, at any zoom (the cards band included), not
        to the workspace's terminal. Codex's approval prompt answers to a
        single y, a or n, and Claude Code's to a number, so a habitual N, or
        any letter, typed into the terminal could answer it. Enter (focus)
        or a click on the terminal gives it the keyboard; Go there's tooltip
        says so. A join request flies to its room's area, selects it and
        shows the admin's prompt (or says it has been answered); a room with
        no area on the landscape still shows the prompt, and the landscape
        gets the keyboard when it closes (`keysTo`), the tray having gone.
        From focus on another workspace, focus ends and the keyboard goes
        to the landscape (`leaveFocus`), not to the overlay leaving with it.
        It's off with the reason as its tooltip when the target can't be
        gone to (`targetOf` / `goCan`: the session has gone, or the request
        was answered). Allowing or denying a prompt stays in the terminal.
      - **Dismiss** takes it off the list and the counts until its state
        changes (the item's `sig`: a new prompt, another turn ended, the
        request answered), then it's back. A prompt's `sig` carries
        `waitingAt`, the time main saw the session start waiting
        (`sessions.ts`), so a second prompt worded like the first is a new
        item. Dismissals are kept in localStorage (`mb.needsYou.dismissed`),
        at most 200 and none older than 3 days, unless its state is still
        current, which would bring back an item that hasn't changed; a saved
        list that isn't one is let go and said in the console
        (`dismissedFrom`). The keyboard moves to the tray as a Dismiss or
        Undo runs (its button leaves with it). For 450 ms after a Dismiss a
        click on any of the tray's actions is let go and the tray holds its
        height, so a double click's second click, on the item that slid up
        or past the last item's end, stays in the tray and never reaches the
        landscape. The tray's foot says how many are dismissed, with Undo for
        the last one.
  - **N and ⇧N** (`stepItem`): the next or previous item, round the end;
    from no current item N starts at the first and ⇧N at the last. The
    current item is the one N or Go there last went to while the selection
    is still the one that left (`NeedsLast`), so two join requests on one
    room, or one whose room has no area, don't hold N in place; otherwise
    the selected workspace, or the selected area for a join request
    (`currentIndex`). It's lit in the tray, its list scrolled to keep it in
    view. N does what Go there does but shows no join prompt: the keyboard
    stays with the landscape, so a second N can't type into an agent's
    prompt. The landscape takes it as it takes M and Esc: only while it has
    the keyboard, never in a text field or a terminal. In the open tray N
    and ⇧N step the same way and keep it open: the tray's root takes them
    wherever its focus is (the popover's `onKeyDown`), and the item is
    brought into view clear of the tray's box (`avoid`, `clearRoom`: left of
    it when 200 px or more are there, which 1024×768's 240 are). "Nothing
    needs you right now" when the list is empty.
  - **Area badges:** each area's count is its items (`needsByArea`), so the
    tree's amber count, a collapsed area's pill and the switcher ("3 need
    you: see Needs you", on hover and to a screen reader; `needsLabel`
    says "1 needs you") agree with the tray, dismissals included. A stack's
    row in the tree and a stack's card, of its other tabs, count their own
    items the same way (`needIds`), so a dismissed prompt or a teammate's
    waiting tab counts on neither. A loose workspace counts toward the loose
    group's row. Selecting an area clears the landscape's picks.
  - **Card badges** (`cardBadges.tsx`): on a card, at the end of its foot's
    line after the kind and status, in design D's order with the cost at
    the right, each with its full story on hover:
    - **Diff:** "+214 −38" (green and red) since the worktree forked from
      its area repo's base: `git diff --shortstat` against the merge base
      with that branch (`branchStat` in `files.ts`, `git:branchStat`), its
      commits and uncommitted changes; an untracked file counts once it's
      added. The base is the area's entry for the session's repo, as
      `origin/<base>` or a local `<base>`; with none, the repository's own
      dev/main-style branch. One read per folder and base, shared by every
      card on it and kept a minute after the last one goes (`readStore`, so
      a zoom or a remount reads nothing unless its source changed
      meanwhile or its read failed). A read goes through a card showing it
      now: one that has gone may be a closed session's, which main refuses,
      and a failure is read again when a card goes, or when it comes back
      through a card that went while it was on its way, the cards still there
      seeing no failure. It's read again when
      the folder watch the Changes view refreshes on says that folder
      changed (`onFolderChanged`, one window-wide subscription), when the
      window shows again, and by one window-wide safety net every 60 s for
      what the watch can't see (a commit in a worktree, whose git folder is
      the main repository's), none while the window is hidden. Main keeps
      an answer 3 s, or until that folder changes (`forgetBranchStat`); a
      round is two gits (`show-ref --head` for where HEAD and the base are,
      then the diff), plus merge-base only when either moved (kept by HEAD
      and the base's tip), at most three rounds run at once (`turns`), and
      one folder runs one round and at most one more, shared by whoever
      asks meanwhile, however often it changes (`statRounds`). None when
      nothing has changed, and none for a teammate's session, a terminal
      outside git or an exited one.
    - **PR:** "PR #88", the newest pull request pipeline.json records from
      the session's branch for its ticket (its own, or its group's when
      that's named after one), with its target, age, the ticket's stage and
      its link on hover (`usePipelinesRead` in `TicketPipeline.tsx`, the
      store the pipeline panel reads).
    - **Cost:** "22M · 14%", its tokens over its conversations and its
      share of the current 5-hour limit, from the meters; not on a
      teammate's session or a terminal.
    - **What it did:** a line under the card's head, the first line of the
      agent's latest message (`lastReplyOf` in `handoff.ts`,
      `transcripts:lastReply`), markdown marks stripped. Main finds the
      transcript itself (`replyFiles`), so a new session's line doesn't
      wait for the conversation index: for Claude Code only
      `<conversation>.jsonl`, from the hook's `transcript_path` (kept per
      conversation, `transcriptOf`), else the index, else looked for under
      `~/.claude/projects`; for Codex the index's rollouts and the hook's,
      newest first, an older file read only when the newest holds no
      message. The hook's path comes from the events file, so whatever can
      write there could name any file: it's opened only when its real path
      is inside `~/.claude/projects` or `~/.codex/sessions` and it's a
      regular file (`hookTranscript`: a FIFO would hold a thread). One that
      can't be looked at (a link loop, no permission) is refused too; only
      one that isn't there isn't. A refusal is logged once for each reason
      (`logError`) and, when nothing else held a message, shows as "—" with
      why on hover (an agent with its own `CLAUDE_CONFIG_DIR` keeps its
      transcripts elsewhere). Whichever file is picked, what's read is what's
      checked: opened with `O_NOFOLLOW | O_NONBLOCK`, `fstat`ed and read from
      that handle, so a link or a FIFO swapped in since it was picked is
      refused and can't hold the open. A subagent's file (`subagents/`) and
      sidechain lines are never read, here or in the digests and the
      take-over brief, its quoted conversation and its latest plan alike
      (`filesOf`, `isSidechainFile`, `c.sidechain`, `isSidechain`). It reads
      the last 1 MB, then 8 MB when a long tool output fills that; past that
      it says why ("—", the reason on hover). An answer is kept by file,
      size and modified time, and the file read without blocking main. One
      read per session, shared like the diffs, read again as its turn moves
      on (status, `finishedAt`, conversation), which its record remembers,
      so a card back on screen after its turn ended reads it then; a failed
      read is tried again by the safety net. None for a terminal or a
      teammate's session. When the card's terminal line only says what this
      line says (an idle agent's last output is its last message,
      `repeatsDid`), the terminal line isn't drawn.
    - **A failing source** shows "diff —", "PR —" or "cost —" (a bare dash
      for "what it did"), its reason on hover, and `[mockingbird] a
      landscape card couldn't read <what> for <session>: <reason>` in the
      console once per different reason (`logFailure`). A failed read
      replaces the value; a badge never goes on showing what it read
      before. The meters' error comes from `metersGet` and their pushes
      (`metersChanged` sends `{ error }` when the conversation index can't
      be opened or synced, rather than no sessions or what it last had), the
      pipelines' from their first read, said once. The window then lets go
      of the meters (`setMeters(null)`), so the rail's tokens, a group's bar
      and the usage meter's today go too rather than go stale beside
      "cost —". On the status bar the meters have their own note
      (`readNotes.ts`), gone once they're read again. An index that can't be
      written (locked, full, corrupt: `isIndexFailure`) fails the sync rather
      than counting as one skipped transcript, while what one transcript can
      cause (unreadable, a line SQLite refuses) stays a skip. A failed sync
      is tried again after 30 s (`retryingSync`), since with idle agents
      nothing else asks for one for minutes. A refresh brief and a handoff
      go on when a sync fails (`syncForFiles`): they read the conversation's
      own files and only need them known. The weekly rollup, worked out from
      the index's contents, fails with it.
    - **On a card at any zoom:** under its head it's laid out from the
      bottom in columns that wrap, so a row too tall for what's left goes
      whole, never cut mid-glyph: `.ls-card-mid` holds `.ls-card-body` and
      above it a stack's other tabs' names; the body holds the foot and
      above it the words (`.ls-card-text`): what it did, then the terminal's
      line. So a short card lets go of the terminal's line, a whole line at
      a time (its height rounded down to whole lines in a size container,
      `.ls-card-lines`), what it did, the foot and lastly the tabs' names,
      and an exited card's Resume and Close & clean up stay whole below it
      all, on a stack's card too. The terminal's line never outlasts what
      it did. In the foot's line the badges take only the room the words
      leave (a flex basis of 0), each whole (the group is one line tall and
      wraps, the last first). A teammate's name leads the same group, going
      whole last of it, so it gives way before the status is ever cut; when
      the status alone doesn't fit, it ends in an ellipsis. In the live and
      read-only bands the workspace footer (its rail) already has the PR
      cell and the tokens, so it gains only a Diff cell after the git cells
      (`DiffCell`); "what it did" is on cards only.
  - **Preview:**
    - `?needsTray` (the tray open; the stub keeps the shot's resize from
      closing it), `?needsStep=<n>` (N pressed n times on the landscape, a
      negative n ⇧N, a moment apart) and `?needsTrayStep=<n>` (pressed in
      the tray instead, `?lsFit` fitting the landscape first);
    - `?teamFail` (the team status can't be read);
    - `?needsMany` (four more sessions on a permission prompt: with
      `?joinRequest=later`, seven items);
    - `?closedAsLeft` (the closed sessions' records as main keeps them: g2
      and o2 on an unanswered prompt, the rest idle with a turn's end);
    - `?badgeFail=diff,pr,reply,meters` (those sources fail; the meters
      answer and push as main does when the index can't sync);
    - `?landscapeNeedsAudit=a|g|b|c|d|e|f|s` (`src/preview/needsYouAudit.ts`),
      whose key presses and clicks, where it matters, are real ones: the
      audit asks for them (`window.__mbKeys`) and `ui-preview.mjs` sends them
      through the DevTools protocol to whatever has the focus or is under
      the pointer (a synthetic event when it runs without one, said in its
      report). =a the button, tree, stack row, pill and switcher counts, the
      tray, N from the landscape, in the tray (focus anywhere in it, after a
      Dismiss too), on the button after Esc, in a text field and in a
      terminal, two join requests on one room and one on a room with no
      area, Dismiss, its Undo, its double-click guard and its return, a
      taken-over copy leaving; =g Go there for a prompt, N and Go there for
      a stack's tab behind another and off screen, at the cards' zoom (the
      keyboard on the landscape, not the terminal), for a join request (the
      keyboard the landscape's after its prompt), from focus on another
      workspace and from another tab; =b every workspace's badges, "what it
      did" and Diff cell as drawn at the camera given (inside its card and
      area and its foot, or dropped by their row), each row of each card
      whole, in order and its actions inside it (with `?deadFront`, on a
      stack's card whose front tab exited), whole lines of the terminal's
      line, no status cut beside a badge or a teammate's name, no "what it
      did" said twice, what was said in the console, the diff failing then
      read again, and the meters' status bar note going once they're read
      and today's tokens going with a pushed failure; =c the tray under its
      button, inside the window and scrolling, as it grows open and when
      opened again, ⇧N to the last item kept in the list's view, and with
      `?lsFit` N bringing each card clear of the tray; =d the top bar on one
      line and the amber button's contrast; =e (with
      `?closedAsLeft&lsClosed=s3`) ghosts, the Closed sessions list and a
      stack's closed tab left out of the tray, the tree, the switcher and a
      pill, then a ghost reopened, not listed until a turn ends in it; =f a
      keyboard Dismiss, a real double click on the last item's, the tray
      with nothing left or the rooms unreadable (`?teamFail`), Undo with the
      mouse, the button's height, and ⌘N, ⌘K and ⌘P with the tray open; =s a
      stack's card's count against the tray and the tree: a tab on a prompt,
      dismissed, on a second prompt, finished, and a teammate's tab waiting;
    - fixtures: s8 finished 12 minutes ago, PR #88 from 5101's branch, the
      branch stats and last replies, s5's and s8's meters.
  - **Tests:**
    - `test/needsYou.test.ts`: the tray's contents from fixture statuses
      and what's left out, join requests filtered, the area counts, N's
      order (round the end, from none, a join request's area, walked with
      the real selection: two requests on one room, a room with no area),
      Dismiss until the state changes and a second prompt worded like the
      first, Undo, the saved list trimmed and checked, a dismissal kept
      while its state is current, Go there's targets and taken-over reasons,
      the action rows, the count's wording;
    - `test/cardBadges.test.ts`: each badge's value, none when there's
      nothing to say (no cost on a terminal), "diff —" and the rest with
      their reasons, the failure logged once per reason, a terminal line
      that repeats "what it did", one read shared by every card on a folder
      and kept across a remount, a folder change reading only that folder's
      diffs, reads through a card still showing, a failure read again when
      the card it went through goes (before or while it's on its way), by a
      card shown again and by the safety net, another turn or a source
      changed while no card showed it read when one next does, and main's
      meters failing on a sync;
    - `test/files.test.ts` (`branchStat` on a real repo: commits plus
      uncommitted changes against dev, a missing base and an option-looking
      one refused, a folder change forgetting the kept answer, one round and
      one more shared however often it changes, the merge base kept until
      HEAD moves, `turns`), `test/handoff.test.ts` (`lastReplyOf` and the
      digest: a subagent's lines never taken, a long tool output read past
      or said, a file read once while unchanged; `replyFiles`: the hook's
      file, the index's, one looked for, a subagent's never;
      `hookTranscript` and `replyOfConversation`: inside with links
      followed, outside, a link out, a name beside the folder, a FIFO, a link
      loop and no permission refused, the why, the fallback; a FIFO or a link
      swapped in before the read), `test/takeoverBrief.test.ts` (a subagent's
      lines out of the quoted conversation and the latest plan),
      `test/landscapeView.test.ts` (`clearRoom` at 1024×768),
      `test/transcripts.test.ts` (a subagent's file searchable under its
      parent, never among the conversation's files; a locked index failing
      the sync and picked up after, a line SQLite refuses still one skip,
      `retryingSync`, what goes on or fails with a sync),
      `test/sessionStatus.test.ts` (`finishedAt`, `waitingAt` and
      `transcript_path` through the real hook script, `finishedAtAfter`, and
      a reopened agent's or terminal's record not finished until a turn
      ends in it);
    - `test/uiLandscapeNeeds.test.ts` drives `?landscapeNeedsAudit` in
      Chrome: =a, =g, =b at 15%, at 1024×768's fit (11%), at 10% and at the
      wide fit (each with a stack's front tab exited too), at 10.5%, 11% and
      13%, the fit's 18%, 50% and 100%, and with every source failing, =c at
      1024×768, at 1024×600 and at 1024×768's fit, =d at 860 px in the light
      theme, =e, =f with a join request and with the rooms unreadable, =s;
      `test/uiLandscapeAreas.test.ts` counts the tree's 5101 as 2 (s2's
      prompt and s8 finished).
  - **Decisions for Ryan:**
    - **Order:** by kind, then newest (prompts and questions, join
      requests, finished), where landscape.md says newest first: what holds
      someone up comes before what's only done, as the Inbox design lists
      them. Newest-first overall is a one-line change (`RANK`).
    - **Every item has Dismiss**, a finished one too (the Inbox design gives
      a finished item only Go there), and a prompt has Go there and Dismiss
      in place of the design's Allow once / Deny.
    - **Questions count:** a session waiting with no permission tool (a
      question, an elicitation) is listed as Waiting beside prompts.
    - **Finished** means its turn ended (Stop) and it has been idle since;
      it doesn't wait for wires' `finish_step`.
    - **Go there doesn't dismiss:** the item goes when its state changes (you
      answer the prompt, type into the finished session).
    - **A join request's Go there** shows the admin's prompt; N only flies to
      and selects its area.
    - **N keeps the keyboard on the landscape**, and since the review so
      does Go there (a single letter can answer a prompt); Enter or a click
      gives the terminal it.
    - **Left out:** teammates', taken-over and debrief sessions; muted ones
      are listed.
    - **Cost** is tokens plus the 5-hour share; no dollar figure (the
      meters have none on a plan).
    - **The PR badge** is the number only: pipeline.json doesn't keep
      whether a PR is approved or merged. The live footer's PR cell, which
      asks the provider, keeps its state.
    - **Diff** hides at zero and doesn't count untracked files.
    - **The button shows on every tab** while the flag is on, not only on
      the landscape.
  - **Found, not fixed:**
    - the live band has no "what it did" (its terminal shows it);
    - at 1024×768's fit (11%) a card's foot is too narrow for its kind and
      a longer status together, so "Working" ends in an ellipsis; the
      status dot in its head still says it;
    - the selection bar can sit under the open tray at 1024 wide, the card
      itself clear of it;
    - the keyboard ends on the body after three ways out of the palette: a
      click on its scrim, palette → a dialog → Esc, and palette → Go to from
      focus;
    - a card's terminal line can stop mid-sentence with no ellipsis;
    - Claude Code's number-key prompt shortcuts are from its interface, and
      Codex's y / a / n from its source; neither was driven here.

### S8 · First run and switching over
- **The migration tour** (4 steps, spotlighting the real landscape), the
  shortcuts sheet on `?`, and the empty landscape.
- **The top bar** (designs N and O): the Landscape tab in place of Sessions,
  Dashboard, WorkTracker, Council and Settings, the Needs you button, and
  **+ New**, which opens the right-click create menu at the view's centre.
- **The switch:**
  - turn the Labs flag on by default and remove it;
  - delete the grid code (`layoutTree.ts`, `gridModel.ts`, `drawTree`,
    shown/pinned/groupLayouts state);
  - leave the legacy localStorage keys, so a downgrade still has its grid.
- **Docs:** README (Sessions → Landscape; roadmap), `docs/landscape.md`
  status, and the 1.7.0 changelog lines, drafted for your OK.
- **Checks:**
  - a full run of typecheck, `CI=true npm test`, build, the ui* Chrome tests and
    `MB_E2E_APP=1`;
  - an e2e test that starts the real app with legacy prefs and checks the
    migrated landscape.
- **S8a — As built** (the first half; the switch, S8b, turns the flag on and
  deletes the grid). Everything here is in the landscape's branch, behind the
  Labs flag:
  - **The migration tour** (`LandscapeTour.tsx`; its rules, pure, in
    `landscapeFirstRun.ts`):
    - **Its steps are data:** the first is built for what's there
      (`tourSteps`), the rest are one entry each in `TOUR_LATER`, each with
      its title, body, what the "Next:" line calls it, and its target. Step 3
      is the tool windows for now; the wires slices replace it.
      1. **Your groups are now areas:** the open area on screen with the most
         in it (`tourAreaOf`). With no area drawn, "Your sessions are now
         workspaces", on the first loose workspace or ghost.
      2. **Zoom out to see it all, focus to work:** the zoom's buttons
         (`.ls-hud`).
      3. **Your sidebar's tools are windows now:** the rail's buttons.
      4. **What needs you is in one place:** the Needs you button, whether or
         not anything waits. Done, with nothing to skip.
    - **When it's due** (`tourSettled` in `main.tsx`): the migration is done,
      nothing stands in for the file (`readProblem`), every session list has
      been read (`knownSessions`), and `tourDone` isn't set. Nothing to tour
      (`nothingToTour`: no area, workspace or ghost) settles it the other way:
      `tourDone` is saved, so a fresh install gets the empty landscape and no
      tour about "your groups" once it has a workspace. A placed tool window
      or a Closed list alone counts as nothing to tour. A file that couldn't
      be read, a list that failed and teammates' sessions not read settle
      nothing either way.
    - **How it ends:** Next through to Done, Skip the tour, or Esc: `tourDone`
      through `landscapeStore.update`, so it survives a restart
      (`?lsPersist`). A save that fails says so over the landscape ("The tour
      may show again next time") and in the console, and it's gone for this
      run (`tourEnded`).
    - **When it comes up:** once nothing else is open over the app
      (`OVER_TOUR`, looked for every 400 ms): What's new after an update, the
      setup wizard, a dialog, a popover, the Needs you tray. Those hold Esc,
      so it never takes one from under them. It waits out focus, whose overlay
      covers what it points at, and picks up at the same step. A peek closes
      as it comes up.
    - **The spotlight:** a full-window layer at z-index 45, under dialogs
      (50), the palette (60) and menus (90), which can open over it. The ring
      is a hole in the dim, made with its own box-shadow, so what it shows is
      live. It follows the camera with a listener, as the selection bar does,
      never by a render. The dim is the app's background at 68%, so it dims
      towards the background in both themes. A target on the landscape is kept
      inside the view, one in the chrome inside the window (the rail's ring
      stops 2 px short of the window's edge so its outline shows).
    - **Off screen:** `tourCamera` moves the camera only when the target isn't
      wholly in view or is under 160 px wide on screen (`fitBelow`, so with
      the switcher's strip left clear). The camera goes back at the end,
      unless something moved it since (`tourMoved`).
    - **The card** (`tourCardAt`): beside the target on the side with the most
      room for it, a right-hand side favoured 1.5×, as design G has it; its
      foot level with the target's when it's beside it. A target too big to go
      beside has it over its lower right corner. It's clear of the top bar,
      and its height is capped with the window's.
    - **The keyboard:** it holds it from the moment it's up, so nothing typed
      reaches a terminal behind it: Tab goes round the card's buttons, a press
      on the dim doesn't take focus, focus sent elsewhere comes back to the
      card (`focusin`), and keys on the body bring it back to the card too.
      Come up as someone types, it takes none of it (review fixes, M1).
      `OVERLAYS` includes it,
      so ⌘E, a peek's keys and the selection's Esc hold off. ⌘K, ⌘N and ⌘P
      still open their dialogs over it, and they give it the keyboard back.
      When it goes, what had the keyboard has it again (`useDialogFocus`); a
      terminal the tour's camera took out of a band that takes keys gets it
      once the camera is back and the band has followed, up to 2 s, the
      landscape holding it meanwhile (`tourTerm`).
    - **Motion:** the card enters and leaves as a menu does (`usePresence`);
      nothing else animates of its own. A flight is the one going-to-an-area
      uses, with the ring following it.
  - **The shortcuts sheet** (`TopBar.tsx`'s `ShortcutsSheet`; its rows in
    `landscapeShortcuts.ts`): `?` on the landscape, "? Shortcuts" in the top
    bar, a row in ⌘K. An `AnchoredPopover` under its button, the rows
    scrolling between its head and foot in a window too short for them; at
    1024×768 it needs no scrolling. It says so as a dialog does
    (`useDialogFocus`, so the Needs you tray goes) and goes when one opens
    (`DIALOG_OPENED`), handing back what had the keyboard. `?` in it closes
    it; Esc gives the keyboard back to the landscape after `?` and to the
    button after a click.
    - **Honest as far as is practical:** every row has an `id`, and
      `test/uiLandscapeFirstRun.test.ts` fails unless
      `?landscapeFirstRunAudit=k` drove that id and saw it work, with real key
      presses, wheel events and drags through the Chrome driver. A new row
      with no step fails; a handler taken away fails. The driver gained every
      letter, the keys these use, Alt and Ctrl, a held key, right-clicks, the
      wheel and drags.
    - **Rows not on the board:** ⇧N, ⌘= / ⌘-, ⌘\, ⌥⇥, the four tool windows'
      keys, ⌘P, ⌘J, ⌘N, Shift-click, ⌘Z after a Tidy, Esc. **On the board,
      dropped:** Connect, Add next step, along the pipeline (no wires yet),
      and double-click for a new workspace (only right-click makes one).
      **Changed:** "Esc" as the way back from focus is ⌘E · ⌘Esc: a focused
      terminal has the keyboard and takes a plain Esc.
    - **`?` and the letters** work only while the landscape itself has the
      keyboard, never in a terminal or a text field, and never with the
      keyboard nowhere (review fixes, H1). A window opening on the landscape,
      or its tab being clicked, gives it the keyboard, so `?` works with no
      click first.
  - **The empty landscape** (`LandscapeEmpty.tsx`; `emptyStateOf` and
    `EMPTY_TILES` in `landscapeFirstRun.ts`):
    - **Four states, never guessed:** `drawn` (nothing to say), `empty`,
      `broken` (something couldn't be read, and it says what, with Try again
      where that's a list) and `reading` (said after 300 ms). A file that only
      stands in, a store error, a read-in that failed, and any session list
      not read keep it from saying "An empty landscape". A corrupt file moved
      aside is really empty, but it's headed "The layout was reset" and says
      where the old file went.
    - **The cases decided:** only ghosts, only a placed tool window or
      artifact card, or only an empty area: not empty, no panel, and the
      camera's first fit goes by them (`fitRects`), so they're in view. Only a
      docked window: empty, since it's beside the landscape. Only a Closed
      list: empty, with a line saying how many are in the side bar's Closed
      list, and "Show it" when the side bar is hidden.
    - **Tiles** are data, each naming the create menu's row it runs
      (`runTile`, `actionOf`), placed at the view's centre: a flow that's
      still "coming" there can't be a tile (a test checks). Start from a
      ticket says "From your ADO board" (the picker has no House tickets), New
      workspace "Claude, Codex, terminal". Pipeline template isn't there: its
      row is "coming". A press on a tile or link leaves the keyboard on the
      landscape.
    - **Right-click anywhere** is true: the panel takes no presses but its
      buttons', and a right-click on those reaches the landscape's
      `onContextMenu` too. The zoom's buttons aren't drawn with nothing to
      zoom, so nothing is in the way. Seven places are right-clicked in the
      test.
    - **"Join a room…"** is a link to the dialog itself, with ⌘K named on
      hover. There's no Team tab; the Team view is reached from the Connected
      line, which only shows once you have a room.
  - **The top bar** (`TopBar.tsx`'s `LandscapeTopBar`): the brand and What's
    new, the tabs ("Landscape" for Sessions), Needs you, "? Shortcuts" and +
    New, on every tab. Today's Import is in + New's menu (and the dialog's
    Import, and ⌘K); ⌘N still goes straight to the dialog; Layout is the
    grid's. The WorkTracker dot and Council's badge stay on their tabs.
    - **+ New:** on the landscape the create menu at the view's centre
      (`newAsk`), the area's when the centre is in one, and what it makes goes
      there or the nearest free place (`placeAt`). On another tab, or while
      the landscape isn't laid out, New session's dialog.
    - **Narrow windows:** what doesn't fit folds behind "» n more" (`foldBar`,
      measured before anything is painted), the shortcuts button first, then
      tabs from the right; the open tab, the brand, Needs you and + New stay.
      It's a menu rather than the selection bar's second row, since the bar is
      one line tall. A folded tab's badge shows on », in its tooltip and on
      its row. `?` with the button folded opens the sheet under ». Nothing
      folds at 860.
  - **Preview:**
    - `?lsTour` (the tour not yet seen; with `?landscape=fresh`, the real
      first run), `?lsTourStep=<n>` (Next pressed n times),
      `?lsOnly=nothing|ghosts|closed|windows|docked|area`, `?lsListFail=<n>`,
      `?lsTourSaveFails`, `?keysSheet`, `?newMenu`;
    - `?landscapeFirstRunAudit=k|t|u|e|b` (`src/preview/firstRunAudit.ts`),
      whose keys and mouse are real ones: =k drives every row; =t walks the
      tour (`&do=done|skip|esc`, `?lsPersist` reloads to see it stay gone); =u
      has it against a terminal, a dialog, the palette, focus and the tray; =e
      reads the empty landscape's place, right-clicks all over it and runs its
      tiles; =b measures the top bar at the window's width
      (`&case=tab|fold|sheet`).
  - **Tests:**
    - `test/landscapeFirstRun.test.ts`: `emptyStateOf`'s every state and what
      beats what, the tiles against the create menu, the steps and their
      "Next:" line, `tourAreaOf`, `tourCamera`, `tourCardAt` at four window
      sizes, `ringAround`, `fitRects`, the rows naming nothing this build
      lacks and including what the board did;
    - `test/uiLandscapeFirstRun.test.ts` drives the audit in Chrome: every
      row, the tour's steps at 1440×900 and 1024×768, in light and dark where
      it matters, off screen with motion off and on, ending each way and
      staying gone after a reload, against unread and unreadable state, its
      save failing, a terminal, a dialog, the palette, focus and the tray; the
      empty landscape's cases and its broken ones; the top bar at 1440, 1024,
      860 and 640. Headless Chrome's window size counts 87 px of its own, so a
      "1024x768" run's page is 681 tall, shorter than the real thing; the
      sheet's test asks for 1024x855 to read a page of 768.
  - **Decisions for Ryan:**
    - **"Start from a ticket"** says "From your ADO board" where the board
      says "House or ADO": the dialog's picker has only ADO tickets. House
      tickets start from a room's Board.
    - **Three tiles in a row** (the board has four in two rows): a two-column
      grid would leave a hole. They wrap in a narrow view.
    - **Only a Closed list** counts as empty, with a line naming the list;
      **only ghosts, windows, cards or an empty area** don't; only a docked
      window does. A Closed list alone gets no tour, even after those sessions
      are reopened.
    - **The broken and "reading" panels** have no board: the empty landscape's
      title and text styles, with Try again.
    - **The tour with no area** ("Your sessions are now workspaces") has no
      board.
    - **+ New on another tab** opens New session's dialog: there's no view to
      place a menu's workspace in. Going to the landscape first is the other
      way.
    - **? Shortcuts shows on every tab**, as Needs you does, though its keys
      are the landscape's.
    - **» is a menu**, not a second row; **? Shortcuts folds first**.
    - **Left out of the top bar:** design D's "5h · 41%" (the status bar has
      it) and "Go to… ⌘K" (the sheet has it).
    - **Step 2 spotlights the zoom's buttons**, not a workspace: they're
      always there and moving nothing shows them; focus is in its words.
    - **The dim covers the whole window**, the top bar included (the board
      leaves the top bar bright), so the rail and Needs you can be spotlighted
      the same way.
    - **Sheet rows beyond the board** make it 26 rows; it fits a 768-tall
      window, and it could lose ⌘J and ⌘P if that's long.
    - **No replay:** nothing shows the tour again once it's seen.
  - **Found, not fixed:**
    - ⌘/'s help still describes the grid (`HelpGuide.tsx`);
    - the minimap can sit over the zoom's buttons in a window about 640 wide;
    - an end-to-end test starting the real app from legacy prefs meets the
      tour: `tourDone` isn't set there, as for anyone migrating, so it has to
      end it or set it.
  - **Not verified:**
    - keys through the real app's macOS menu: there's no
      `Menu.setApplicationMenu`, so Electron's default menu has ⌘0, ⌘= and ⌘-
      as View roles, which the Chrome driver can't reach;
    - a real trackpad pinch (⌃-wheel and ⌘-wheel are simulated);
    - `?` on a keyboard other than US;
    - any of this in the real app: all of it ran in the preview.
- **S8a review fixes (round 1) — As built:**
  - **H1, keys after a terminal goes:** keys with the keyboard nowhere do
    nothing. The landscape's listener for keys aimed at the body is gone, so a
    terminal or field that goes while being typed in (closed elsewhere, a
    remote pane dropping) leaves what's typed on going nowhere, as before S8a:
    no N, no Tidy, no Enter into another session's prompt. The ways the
    keyboard used to land on the body after a palette or a dialog now give it
    back to a real place instead (M4), and a window opening on the landscape
    still gives it the keyboard.
  - **M4, giving the keyboard back:** `useDialogFocus` keeps a chain: what had
    the keyboard as a dialog, the palette, the sheet or a menu opened, then
    what those it was opened from had (`openers`, with `useOpener` for menus).
    A row's palette or menu goes a moment after its row opens something, so
    the keyboard goes back past the row to what had it before: the terminal
    after ⌘K → Shortcuts → Esc, » after »'s ? Shortcuts, focus's terminal in
    focus. When nothing in the chain is left, it goes to the landscape (or
    focus) while that's on screen (`useKeyboardHome`). A press on a dialog's
    backdrop or the palette's scrim no longer takes the keyboard to the page
    after the close has given it back. Shared code: every dialog opened from
    the palette or a menu goes back the same way.
  - **M1, a tour that comes up as someone types:** come up over a terminal or
    a field, or within a second of a key, the card itself has the keyboard,
    with no button to press, and Tab, Enter, Space and Esc do nothing in it
    until the keys have stopped for a second (`stillTyping`). Focus pulled
    away comes back to the card, never a button.
  - **M2, the tour's camera:** where it moved the camera from and to is kept
    in a pref (`TOUR_CAMERA_PREF`) while the tour is up, so a tab away and
    back or a restart doesn't lose the way back. A flight still on its way to
    the tour's place counts as the tour's: Esc or Skip during it stops it and
    goes back. While the tour holds the camera, the camera saved as the
    window's is the one it moved from (`userCamera`), so a restart opens
    there.
  - **M3, » and the sheet under it:** » stays the same element while the bar
    is measured again (a Needs you count or a badge changing), drawn as last
    folded and left out of the measurement, so the sheet anchored to it and
    the keyboard on it stay. `AnchoredPopover` can take its anchor as a
    function, read whenever it's placed, and `placeKey` places it again when
    what's folded changes. A tab with the keyboard that folds into » leaves it
    on ».
  - **M5, + New in focus:** the create menu is for the focused workspace's
    area, and what it makes is placed beside that workspace. Outside focus
    it's the area at the view's centre, where the menu opens over it. So + New
    never seeds an area the window isn't showing, a room's included.
  - **M6, the sheet kept honest:** each row's printed keys are split into what
    it prints ("⌘0 / ⌘1": ⌘0 and ⌘1), every step presses only what its row
    prints (`pressAs`, the key read from the text), and a row fails if
    anything it prints wasn't driven. ⇧N is checked with three or more in
    Needs you (`?needsMany`) going back to where N was; ⌥⇥ starts from nothing
    selected and is pressed twice.
  - **L1:** "nothing to tour" settles the tour for the run too, so a fresh
    install whose save failed gets no tour later in it. Saving `tourDone` is a
    flag's write (`update(…, { flag: true })`): a failure is said by its
    caller, not made the store's error, so it can't turn a known-empty
    landscape into "The layout has a problem".
  - **L2:** a patch that only sets a flag (`flagOnly`) doesn't move `revNow`,
    so saving `tourDone` leaves a Tidy's Undo working.
  - **L3:** the Closed list's line offers "Show it" when the side bar shows
    Team rooms too (`treeHidden`).
  - **L4:** the reset panel says where the old file went, and the stand-in
    panel says why the file can't be read, in the panel: the banner saying it
    can be put away.
  - **L5:** House's Start session popover (`.t2s-back`) is among what the tour
    waits under and the window's keys hold off for. It only opens over the
    House board's dialog, whose backdrop already held both, so no test can
    tell it's there.
  - **L6:** folding measures the bar as drawn, its gaps included: each folded
    item gives back its width and the gap beside it. The window has a minimum
    width of 640 px (`minWidth`).
  - **L7:** a dialog whose field with the keyboard is swapped out as it fills
    in (New session's repo search replaced by the repo) keeps the keyboard on
    the dialog.
  - **L8:** the empty panel scrolls in a view too short for it, from its
    title; while it does, it takes the wheel and presses, which otherwise go
    through it.
  - **Tests that passed for the wrong reason, now each failing without its
    fix:** a drag from the empty panel's words draws the marquee
    (`pointer-events: none`); ⌘K's Go to during the tour is left alone (the
    moved-since check); ⌘E under the tour focuses nothing (`.ls-tour-back` in
    `OVERLAYS`); a failed migration settles nothing (`migration.step` in
    `tourSettled`); a step's target gone leaves no ring (`ring.hidden`); the
    keyboard goes back to the field that had it (the tour's `useDialogFocus`).
  - **A terminal given its keyboard back after the tour** is asked again until
    it takes it: its terminal is attached only once the band has rested at
    100%, and the first ask could come before (within the 2 s it's held for,
    `tourTerm`).
  - **Preview:** `?lsMigrateFails`; the audit's =c (the tour's camera,
    &case=esc|skip|tab|restart|goto) and =u cases typing, dropped, keys,
    field, ring and undo; =b cases handback, foldsheet and edges; =e's
    addArea, tall and team; the driver holds a drag mid-way (`hold`);
    `setSession` changes or drops a live session; the audit's landscape
    changes arrive as main sends them, the patch alone.
  - **Checked by reverting:** each fix above, and each strengthened test, was
    taken out on its own and its test failed, but for L5 (above) and
    `minWidth`, which is the main process's window option and has no test.
  - **Skip during the first flight** is pressed from the keyboard in =c (Tab
    from Next, then Space): the card follows its target while the camera
    flies, further than it goes in the 100–280 ms a press aimed at Skip takes
    to arrive, so a click there missed about half the time. Each of =c's
    esc and skip says whether the flight was still on its way when the press
    arrived (`endedFlying`). `?keysSheet` opens the sheet from »'s menu when
    its button is folded.
  - **Found, not fixed:** a peek's keys (Space, Enter on a kept one) act
    wherever the keyboard is but a field, a terminal's included (S3): with a
    peek open under a resting pointer, Space and Enter typed on after a
    terminal goes would keep and focus it (fixed in round 2: H2). At 640 px
    wide the minimap overlaps the zoom HUD. Help's guide still describes the
    grid (S8b's switch).
- **S8a review fixes (round 2) — As built:**
  - **The arming rule (`src/renderer/keyArm.ts`). Every key handler on the
    landscape goes through it, and every later one must.** A key without ⌘
    or Ctrl (`typed`: letters, `?`, Enter, Space, Esc, Tab, ⌥ keys, a peek's
    keys) acts on the landscape only while the landscape is *armed*
    (`isArmed`). The keyboard landing on it isn't enough: it lands there on
    its own too, and what's typed on then was meant for somewhere else, often
    another session's prompt.
    - **Armed only by an act of the user aimed at it:** a press on the canvas,
      a card or the landscape's own chrome (`armOnPress`, from the viewport's
      pointerdown: at once if it has the keyboard, or as the press's own focus
      move gives it it; a press that gives a terminal or a button the keyboard
      arms nothing); a command that leaves a terminal for it or goes to it
      (⌘E, ⌘Esc, Esc out of focus, Go there, `armFocus`); the window opening
      on it, or its tab clicked; and the user leaving what they opened from it
      while it was armed. "Leaving" means Esc, `?` (the sheet's own key) or a
      press (Cancel, ×, outside it). Then `useDialogFocus` and the context
      menu give the keyboard back armed. A dialog submitted with Enter, or a
      palette row run with it, gives it back disarmed: keys may still be
      coming for what it made.
    - **Disarmed whenever the keyboard goes anywhere else**, however that
      happens (`focusin` elsewhere, focus falling to the page), and nothing
      but the acts above arms it again. So a hand-back after a terminal,
      field, dialog or menu went, a band change (`commitBand`, `offKeys`), a
      reveal, the tour ending, or anything else that moves the keyboard by
      code leaves it disarmed. The tour never arms (`useDialogFocus({ rearms:
      false })`).
    - **A disarmed landscape swallows typed keys**, Tab included, so a burst
      can't walk onto a button and press it with the Enter after. ⌘ and Ctrl
      chords still work (⌘0, ⌘1, ⌘K, ⌘E), and ⌥⇥ is the window's, from
      anywhere. Focus's frame (`.ls-focus`) is a surface too: Esc on the
      frame itself leaves focus only while it's armed.
    - **A new key handler:** if it acts on a typed key, it asks
      `isArmed(surface)`. A peek's keys also act while the peek itself has
      the keyboard. Code that gives the landscape the keyboard for the user's
      own command calls `armFocus`; anything else calls `focus()` and leaves
      it disarmed. Preview audits that stand in for a press use `armFocus` in
      their setup (`giveLandscape`); the tests of the rule itself press for
      real.
  - **H1, the tour's hand-back:** the tour's end never gives the landscape
    the keyboard. Come up over a terminal on the landscape, it hands nothing
    back itself (`handsBack`); `tourClosed` gives that terminal its keyboard
    once it takes keys. Until then, while the camera is on its way back to
    where terminals take keys, the tour's hold stays on: keys typed meanwhile
    are swallowed, each one holding it a while longer, as the card does. A
    press, or the keyboard going anywhere, ends the hold, and the terminal
    then gets nothing. Past the cap (`TOUR_KEYS_BACK_MS` after the last key)
    the keyboard is left nowhere, said in the log. With no way back (a view
    terminals take no keys in, and no flight or band change coming), it's
    left nowhere at once.
  - **H2, a peek's keys:** Space, Esc and Enter act only while the landscape
    is armed or the peek itself has the keyboard: never in a terminal
    elsewhere (the bottom panel's log included), never with the keyboard
    nowhere.
  - **M1, ⌘K during the tour:** a jump during the tour (any reveal: ⌘K, the
    side bar, a notification) clears the tour's camera pref. The tour's end
    doesn't fly back over it (a later step moves from where the jump went),
    and the terminal that had the keyboard as the tour came up gets nothing.
    A jump that places the keyboard (`keyboardMoves`) names its session as
    the one to get it after the tour, if its terminal takes keys by then. A
    terminal on the landscape asked for the keyboard while the tour is up,
    from the palette over it too, is held off and named the same way
    (`onKeysAsked`).
  - **L1, a palette or menu row that moves the keyboard itself:**
    `jumpToSession` says so (`keyboardMoves`, until the frame after). The
    palette or menu closing as it's picked then gives nothing back to what
    had the keyboard. The session's terminal is focused at once if it's
    there, else 50 ms later as before. Meanwhile the keyboard is nowhere, so
    a key typed straight after Enter goes nowhere, never into the session
    left.
  - **Tests:** =a in the first-run audit, every case driven by real keys and
    presses:
    - the tour ended by Esc, by Skip (motion on) and by a press as the camera
      comes back, at 1024×768;
    - a peek over the log terminal being typed in, and over a field removed
      mid-typing;
    - ⌘K during the tour, and keys straight after ⌘K's Enter;
    - the landscape given the keyboard by code (keys do nothing, the palette
      left gives it back disarmed), then armed by a press (N works, the
      palette left with Esc gives it back armed);
    - a trackpad zoom out of a terminal (N does nothing);
    - the hold running to its cap, s1's terminal made unable to take the
      keyboard: a key during it holds it longer, then the keyboard is left
      nowhere and the log says so;
    - focus's frame given the keyboard by code (Esc doesn't leave focus), then
      armed by a press on its header (Esc does).

    Each "nothing reached s1" has a positive control: a key typed once things
    settle reaches the right session. The log terminal's input guard holds
    back keys it can't attribute (`dropped-unattributed`); the peek test
    counts those as reaching it.
  - **Checked by reverting**, each taken out on its own with its test
    failing:
    - H1's three layers, together (the state before the fix) and one at a
      time: the tour giving the landscape no keyboard, the hold swallowing
      what's typed, and a press ending the hold;
    - the arming check;
    - focus falling to the page disarming, and focus going elsewhere
      disarming;
    - a press arming;
    - leaving a palette re-arming;
    - H2's peek check;
    - M1's jump;
    - L1's `keyboardMoves`;
    - the cap's log line, and each key holding the hold longer;
    - the focus frame swallowing typed keys while disarmed.
  - **Not tested:** a terminal asked for during the tour taking the keyboard
    after it. In the tour's zoomed-out step the jump's terminal isn't
    attached, so the hand-back finds no way back and leaves the keyboard
    nowhere, which is what's tested.
  - **Found, not fixed:** with the keyboard nowhere (the page's body), Tab
    still moves it to the window's first control and Enter presses it. That's
    the browser's own, outside the landscape.

## Risks

- **Pty size versus zoom.** If a resize leaks through during zoom, agents
  redraw constantly. S2's test pins it.
- **Many live terminals.** Mitigated by the zoom bands, attaching only
  on-screen workspaces, and WebGL; measured in S3.
- **Shortcut conflicts.** Single-letter keys (N, M, T, ?) work only while the
  landscape has focus and the user armed it (keyArm.ts, S8a review round 2),
  never in a terminal.
- **Electron gestures.** Pinch arrives as ctrl+wheel, and trackpad scroll as
  wheel with fractional deltas; the camera handles both, as `wheelLines`
  already does for scrolling.
- **Follow in rooms.** It keeps working by focused workspace; viewport
  following waits for phase 4.

## Decisions taken for phase 1

- **Workspace sizes** are big enough to read a session at 100%, about what one
  pane shows today in a wide window:

  | Preset | Agents | Terminals |
  | --- | --- | --- |
  | S | 110 × 32 | 90 × 16 |
  | **M (default)** | **140 × 42** | **120 × 24** |
  | L | 180 × 52 | 160 × 36 |

  At 12.5 px mono, M is roughly 1050 × 760 px. One M workspace fills most of a
  laptop screen at 100%, and two side by side fit at about 70%, which is still
  live and read-only.
- **The Collaborate tab** stays until phase 2 moves collabs onto the landscape.
- **Focus reflows your own workspaces and scales teammates'.** In focus, an
  own workspace's terminal takes the window's size and redraws; leaving focus
  puts the placement's size back. Teammates' workspaces keep their owner's
  size and are scaled to fit.
- **Development flag:** the work goes behind a Labs flag while it's in
  progress, so `main` can take each slice without changing what you use.
- **Actions at any zoom come from the selection bar** (design Q), never from
  zooming in; room tools show only for areas that are rooms.
- **Tools are windows on the landscape** (design O), with Artifacts as a
  window in every area rather than a header menu, P's Members menu in a room
  area's header, and N's workspace header, footer and ⋯ menu. Every sidebar
  and room control has a home (landscape.md, Tools).
