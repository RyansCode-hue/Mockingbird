# Landscape, phase 1: build plan

Status: S1 (model, store, migration), S2 (the surface, behind Settings →
Labs → Landscape), S3 (semantic zoom and peek), S4 (areas), S5 (tools and
the workspace header) and S6a (the selection bar and right-click create)
built; S6b (moving, resizing, stacks, Tidy, ghost cards) next.
The spec is [landscape.md](landscape.md); this file is how its phase 1 gets
built.

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
    - anything into, out of or around a locked area;
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
      workspaces and ghosts.

    An area moves with everything inside it. That includes the places of
    sessions that aren't shown (waiting to be resumed) and of stacks none of
    whose sessions are, so a relaunched session comes back inside its area.
    Those places also stay taken when workspaces join an area.

    A locked area never moves. `pushAside` takes it as fixed: an area pushed
    into it goes on past it. A gesture that would grow an area into a locked
    one is refused, and says so. An area growing to hold a new session moves
    clear of everything instead.

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
    and a lock, can't be dragged, and nothing moves into, out of or within it.
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
      `clearOf`, `pushAside` (locked areas fixed), `renameAreaPatch` (merges
      letting go of every place inside), `resolveLayout`'s forming, pending
      renames and pushing (resumable places moved, locked areas not),
      collapsed areas off screen, the three plans and their refusals (growing
      into a locked area, resumable places moved and kept taken, loose drops
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
      ⟨name⟩ — Stop once, in the window's status bar.)
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
        dialog never replaces another's (`closeWaits`). Off when none of them
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
    and base, and goes in the nearest free spot as before.
    - **Placed where it was clicked:** the first session of this Mac made in
      that area after the click (`createdAt`) goes at the click (`placeAt`:
      on the grid, inside the area's padding and under its header, or the
      nearest free spot by the edges of what's there), and its place is saved
      like any new one's. One that would reach past the area's edge is moved
      in to fit when that's within its own size of the click; otherwise the
      area grows for it, to the nearest spot where the area, grown to hold
      it, still keeps the gap from every other area (a full area grows down
      rather than into the area beside it). A spot the area holds without
      growing is taken as it is, even in an area already closer than the gap
      to another. Where no spot keeps the gap, the area grows towards an
      unlocked neighbour, which the layout moves aside as it does for any
      area that grows, by the click; never towards a locked one, and the area
      itself never moves. Where every way out is a locked area, the
      right-click makes nothing and says "No room in ⟨area⟩: ⟨locked⟩ is
      locked" (`rightClickRefusal`, asked before the dialog opens); should
      that happen only after the dialog (an area locked meanwhile), the
      session goes where a new one of the area goes (its area growing as for
      New session here…), and that's said: the layout reports it
      (`hintRefused`) and the notice adds "so it went with the area's other
      workspaces". The hint lasts until that place is saved, 10 s
      after the dialog makes it, or the dialog closing without one. A click
      outside every area places a loose one there.
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
      `review:start`, `turns:restore` and `usage:briefStart` look their
      session up through `untakenSessionOf` (`takenOverGuard.ts`), which
      throws `takenOverRefusal`'s reason, saying what was refused. That's the
      taken-over check alone, the window's rule; `relaunchRefusal` adds to
      it the copy from a refused take-over, which only relaunching refuses.
      A copy taken back since into another session here says so instead
      (`room.takenOver.back`: "It was taken back into another session here,
      which goes on with it: this copy doesn't run again"), in its rows, its
      pane's line, its sidebar row and Resume, rather than that the teammate
      continues it.
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
    - `test/landscape.test.ts`: `placeAt`.
    - `test/landscapeView.test.ts`: a right-click's placement hint (own,
      new since, in the area clicked; loose).
    - `test/landscapeTools.test.ts`: `compactPlaces` inside areas, beside or
      squeezed, and clear of another area's name line.
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
      right-click in an area hemmed in by locked ones, and Close… on several
      waiting for a single Close's dialog.
    - `test/takenOverGuard.test.ts` and `test/teamTakeover.test.ts`: main's
      guarded calls, on a taken-over copy, a copy from a refused take-over
      and one no one took; `test/teamTakenOver.test.ts`: a copy taken back
      tagged `back`.
    - `?landscapeAreasAudit` reads the several bar where it read S4's pick
      bar.
  - **Left for S6b:** moving and resizing with snapping and guides; stacks
    (the bar's Stack is off until then); Tidy; ghost cards, Reopen all and
    Clear ghosts, with S2's and S4's leftovers above.

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

## Risks

- **Pty size versus zoom.** If a resize leaks through during zoom, agents
  redraw constantly. S2's test pins it.
- **Many live terminals.** Mitigated by the zoom bands, attaching only
  on-screen workspaces, and WebGL; measured in S3.
- **Shortcut conflicts.** Single-letter keys (N, M, T, ?) work only while the
  landscape has focus, never in a terminal.
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
