# Landscape, phase 1: build plan

Status: S1 (model, store, migration), S2 (the surface, behind Settings →
Labs → Landscape) and S3 (semantic zoom and peek) built; S4 next. The spec is
[landscape.md](landscape.md); this file is how its phase 1 gets built.

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
  v: 1;                         // raised whenever a field is added (see below)
  migratedAt?: string;          // set once the grid layout has been read in
  tourDone?: boolean;
  workspaces: Record<string, Placement>;   // by session id; a stack's members have none
  areas: Record<string, Area>;             // by group key
  stacks: Record<string, Stack>;           // by "top/sub" group key
  ghosts: Record<string, Ghost>;           // closed workspaces, by old session id
}
interface Placement { x: number; y: number; w: number; h: number } // landscape px at 100%, absolute
interface Area {
  x: number; y: number; w: number; h: number;
  repos: { path: string; base: string | null }[];  // null: the repo's own default
  collapsed?: boolean; locked?: boolean;
  autoCreate?: boolean;         // phase 2: agent proposals without asking
}
interface Stack { active: string; placement: Placement } // its members share the one placement
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
  - **The peek** opens after the pointer rests 300 ms on a card or a
    read-only workspace (never while dragging, panning with Space or a
    button held, never at 75% and up, never for an exited session). It's the
    workspace at its 100% size, shrunk to fit 80% × 86% of the viewport and
    centred on it. Its terminal is lent (`lendTerm`) once the workspace's
    pane has let it go, at its own cols × rows with its font fitted to the
    box, and handed back while the peek is still in the page, its font put
    back where xterm can measure it. A read-only workspace shows its screen
    as text meanwhile, taken again when a kept-open peek crosses into the
    read-only band; a card stays a card. Space keeps it open (and lets it go
    again); Esc, moving onto another workspace or the bare landscape, a
    press elsewhere, or moving the camera closes it; a dialog or menu open
    over it has Space and Esc first. Its stack bringing another tab to the
    front, or a restart giving the session a new terminal, ends it. A click
    focuses the workspace. It fades and scales in under full motion and
    appears at once under reduce.
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

### S5 · Tools and the workspace header
Design O, with Artifacts as a window, and N's workspace header.
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

### S6 · Creating and arranging
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
- **Tests:**
  - snapping and guides;
  - stack create, switch and unstack;
  - Tidy and its undo;
  - ghost written on close and resumed on Reopen.

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
- **Tools are windows on the landscape** (design O), with Artifacts as a
  window in every area rather than a header menu, P's Members menu in a room
  area's header, and N's workspace header, footer and ⋯ menu. Every sidebar
  and room control has a home (landscape.md, Tools).
