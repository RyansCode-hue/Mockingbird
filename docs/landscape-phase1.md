# Landscape, phase 1: build plan

Status: S1 (model, store, migration) and S2 (the surface, behind Settings →
Labs → Landscape) built; S3 next. The spec is
[landscape.md](landscape.md); this file is how its phase 1 gets built.

Phase 1 replaces the grid with the landscape: workspaces, areas, stacks, the
Needs you tray and migration. It has **no wires**; those are phases 2–3.
It ships as a minor release (1.7.0). `landscape.json` is new data, and an older
version ignores it and still finds its grid layout in localStorage, so nothing
breaks for a teammate who hasn't updated.

## How it maps onto today's code

| Today | Phase 1 |
| --- | --- |
| `mb.trees`, `mb.shown`, `mb.pinned`, `mb.groupLayouts` (localStorage, `main.tsx:166-312`) | `~/.mockingbird/landscape.json`, owned by the main process |
| `layoutTree.ts`, `gridModel.ts`, `drawTree` (`main.tsx:928`) | removed at the end (S7); kept until the grid is switched off |
| A group (`taskGroup` string) | An area: a rectangle, repos and options, keyed by that group string |
| A sub-group cell `ws:<top/sub>` with tabs | A stack, the same `top/sub` group, so rooms and usage need no changes |
| The group bar (`main.tsx:2389-2440`) | The area header (the same component, moved out of `main.tsx`) |
| ⌘E maximize (`zoomed`, `main.tsx:190`) | Focus |
| `fit()` → `sessionResize` (`cachedTerm.ts:113,431`) | The workspace's size sets cols/rows; zoom never resizes the pty |
| `followFixedSize` scaling (`cachedTerm.ts:409`) | How every workspace renders at zoom ≠ 100% |
| `terms` cache (`TerminalPane.tsx:65`) | Unchanged; cards and peek read it, live nodes attach it |

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
default until S7.

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

### S4 · Areas
- `AreaFrame.tsx`:
  - a solid patch when zoomed out, a dashed outline and header at 100%;
  - the group bar is extracted from `main.tsx` into `GroupBar.tsx` and becomes
    the area header;
  - repo chips (several repos per area), the stage chip and usage.
- **Make an area:**
  - a marquee selection, then M or the **Make area…** button, gives a name, and
    `setGroup` moves the selection into it;
  - dragging a workspace across an area's edge sets its group, with the area
    highlighted on hover.
- **Go to an area:** the sidebar's area tree, the area switcher and ⌘K "Go
  to…" fly the camera there, ending immediately under reduced motion. Check it
  with `?motionAudit`.
- **The area's hover toolbar:** Collapse (to a pill that keeps its counts),
  Lock and Tidy (S5).
- **Rooms:**
  - a room's group is an area like any other, its layout local in phase 1;
  - a teammate's sessions appear in it through `placeNew`;
  - Follow keeps following the teammate's focused workspace;
  - `teamLiveView` still reports the grid's `shown` while the landscape
    shows (left from S2): it should report the workspaces on screen, which
    decides which teammates' sessions stream here.
- **Tests:**
  - marquee → area → `setGroup` calls;
  - dragging across an edge;
  - rename;
  - collapse and lock;
  - a remote session landing in a room area.

### S5 · Creating and arranging
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
- **Ghost cards:** they show the title, summary, branch and Reopen. An area
  menu has **Clear ghosts**.
  - Left from S2: a closed session's placement stays in `workspaces` (it may
    be resumed); closing should turn it into a ghost, or they pile up.
- **Tests:**
  - snapping and guides;
  - stack create, switch and unstack;
  - Tidy and its undo;
  - ghost written on close and resumed on Reopen.

### S6 · Needs you
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

### S7 · First run and switching over
- **The migration tour** (4 steps, spotlighting the real landscape), the
  shortcuts sheet on `?`, and the empty landscape.
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
