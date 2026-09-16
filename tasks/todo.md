# Design handoff implementation — Mockingbird UI (1a–1h)

Source: `Mockingbird terminal session manager.zip` → `design_handoff_mockingbird/`
(README + `Mockingbird.dc.html`). High-fidelity spec; recreate inside the existing
React/Electron renderer using its patterns. Where design conflicts with an
existing pattern, the existing pattern wins (per the handoff README).

## Scope decisions

- [x] **In scope:** 1a grid restyle, 1b density tiers, 1c command palette +
      keyboard layer, 1e close-session dialog (worktree hygiene), 1g broadcast +
      CLAUDE.md control room, 1h menu-bar/Dock glanceability, waiting-reason
      capture, notification coalescing.
- [x] **Out of scope (needs v2/v3 backend per handoff roadmap):** 1d ADO ticket
      sidebar (ADO REST), 1f cross-session transcript search (transcript index),
      token/cost instrumentation (CLI usage reporting not wired), PR state
      (git host API). The instrumented rail (1b) ships with the cells we have
      real data for: elapsed + git; no fake data.
- [x] Fonts: JetBrains Mono not installed and CSP blocks network fonts → stack
      `'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace` (design's
      stated fallback). Helvetica Neue is system.

## Tasks

- [x] `shared/types.ts` — add `waitingReason`, `waitingSince`, `queuedCount` to
      `SessionInfo`; extend `WorktreeState` usage.
- [x] `main/hooks.ts` — capture Notification payload `message` as waiting
      reason; pass session info (not just title) to the notify callback.
- [x] `main/sessions.ts` — track `waitingReason`/`waitingSince` on status
      change; expose `queuedCount` in `list()`; `onChanged` callback for tray.
- [x] `main/worktrees.ts` — richer state (dirty file count, ahead/behind);
      `cleanupWorktree(mode: keep|push|discard)` (push commits WIP first).
- [x] `main/index.ts` — Tray (waiting-first dropdown, count in title) + Dock
      badge (waiting count only); notification coalescing (≤1/session/30s);
      IPC: `worktree:cleanup`, ui-command events (focus session, new session).
- [x] `main/preload.ts` — new APIs: `worktreeCleanup`, `onUiCommand`.
- [x] `renderer/styles.css` — full retheme to handoff tokens (bg/chrome/pane,
      amber-reserved-for-waiting rule, typography scale, radii, shadows,
      waiting pulse with `prefers-reduced-motion` fallback).
- [x] `renderer/TerminalPane.tsx` — density tiers (minimal/standard/
      instrumented from column count), branch chip + meta, waiting banner with
      specific reason + live duration, amber border + 3px glow, dead-pane
      Resume / Close & clean up, assistant teal treatment, context rail
      (elapsed · git), warm xterm theme.
- [x] `renderer/main.tsx` — top bar (brand, cols segmented control, Enlarge
      2×2 / Zoom, Broadcast, CLAUDE.md, amber New session ⌘N); sidebar (group
      hairlines, dot + name + pane index rows, WorkTracker footer with brief
      buttons); status bar (counts with dots, ⌘K hint); command palette (⌘K);
      global shortcuts (⌘N ⌘1–9 ⌥⇥ ⌘E ⌘⌃1–4 ⌘⇧B); close-session dialog wired
      to worktree state (safe default preselected, silent close when clean);
      control room modal (CLAUDE.md editor + Save & re-read in N, broadcast
      composer + target pills + delivery list); persistence of grid order /
      cols / enlarged / sidebar state (localStorage).
- [x] Verify: `npm run typecheck` + `npm run build` clean.

## Review notes

- **Verification:** `tsc --noEmit` and esbuild both clean. Visual verification
  done by loading the real `dist/renderer.js` bundle in a browser against a
  mocked `window.mb` (scratchpad harness): confirmed grid (waiting glow +
  reason banner, dead-pane resume body, assistant teal), density tiers at
  2/3/4 columns with the context rail, ⌘K palette (groups, amber selection,
  waiting reasons), close-session dialog (safe default, red destructive
  option), and control room delivery states (`queued · busy`, `skipped · dead`).
- **Deviations from the handoff, deliberate:**
  - No token/cost/PR cells in the context rail and no transcript search field
    in the top bar — that instrumentation doesn't exist yet; nothing fake is
    rendered. Rail shows elapsed · git · repo · queued instead.
  - Kept the existing "auto" column mode alongside 1–4 (existing pattern wins).
  - Tray uses a native menu (Electron limitation) — waiting sessions first,
    oldest-wait first, 🪶 + count title; only waiting sessions are counted.
  - CLAUDE.md changed-line gutter simplified to a changed-line count in the
    footer (plain textarea; a mirrored-overlay editor wasn't worth the risk).
- **New behavior worth knowing:** the hook Notification `message` is now
  stored as `waitingReason` and shown in the pane banner, palette, tray, and
  native notifications; notifications coalesce to one per session per 30s.
  Close now inspects the worktree: clean+pushed closes silently, otherwise the
  1e dialog runs `keep` / `push` (commits WIP with `--no-verify`) / `discard`
  (worktree remove --force + branch -D, confirmed and never the default).
- **Safety note:** the only destructive git path (`discard`) is behind an
  explicit non-default dialog choice; `push` mode commits WIP before removing
  the worktree so nothing is lost silently.

## Iteration 2 — group management, restart resilience, help popup

- [x] `sessions:setGroup` IPC + `SessionManager.setGroup` (live or previous
      sessions; null = ungroup).
- [x] Move sessions between groups: drag a sidebar row onto a group header or
      another row; ⤷ button / ⌘K "Change group…" opens a move/create/remove
      dialog (also groups previously ungrouped sessions).
- [x] New Session modal: Group field with datalist of existing groups
      (defaults to ticket # when blank).
- [x] Restart resilience: `relaunch` now reuses the old session id
      (`reuseId`), `mb.shown` is no longer pruned against the live list, and a
      "↺ restore all" button relaunches every previous session — grid slots
      and groups survive an app restart. Renderer-only changes need only
      `npm run build` + ⌘R (PTYs live in the main process and replay their
      buffer on reload).
- [x] How-to-use popup: auto-opens once on first launch (`mb.helpSeen`),
      reachable via ⌘/, the palette, and "? help" in the status bar. Covers
      the amber rule, grid basics, groups, the shortcut map, broadcast
      delivery, and restart restore.
- [x] Verified in the mock harness: group dialog moves a session between
      groups live; help popup auto-opens on first run. `typecheck` + `build`
      clean.

## Iteration 3 — intuitive resize, fullscreen, rename affordances, ADO dashboard

- [x] **Resizable panes** (user request: "resize like a browser window, keep
      the grid"): drag the edge between panes to resize the grid tracks
      pair-wise (iTerm-style), min pane 150×90px, double-click an edge to even
      out, sizes persisted per column/row count. Implemented as `.cell`
      wrappers with pointer-capture handles over the 8px gutters.
- [x] **Removed the Enlarge-2×2 concept** (user found it confusing; edge-drag
      covers it). Zoom renamed/reworked as a single ⛶ fullscreen toggle on the
      pane, ⌘E, esc restores. Top-bar Enlarge/Zoom buttons deleted.
- [x] **Rename discoverability**: double-click the pane header title renames
      inline (design 1a behavior, previously missing); ✎ affordance on sidebar
      row hover; "Rename …" action in the palette.
- [x] **ADO Dashboard** (user request; = design 1d minus the comment queue):
      `src/main/ado.ts` reads `workTrackerPath/config.json`
      (azureDevOps.orgUrl/project/patFile) — PAT read only in the main
      process, never sent to the renderer. WIQL: assigned to @Me, state not in
      Closed/Done/Removed, 50 most recently changed. Dashboard modal: card
      list (id · type chip · state, linked-session dots), detail with editable
      title/state/description ("Save to ADO", state options fetched per work
      item type), Open in ADO (shell.openExternal, https only), start a
      worktree session from a ticket (auto-grouped under the ticket id), or
      attach an existing session (setGroup).
- [x] Help popup + README updated for the new interactions.
- [x] Verified in harness (mocked mb API): edge-drag resizes and persists
      fractions; ⌘E fullscreens; dashboard renders with correct
      enabled/disabled states.
- [ ] **Untested against real ADO** — the REST calls (wiql POST, workitems
      batch GET, states GET, PATCH json-patch) follow api-version=7.0 but the
      first live run happens in the real app. Errors surface in the dashboard
      via the safeAsync → {error} path.

## Iteration 4 — Dashboard rebuilt as an ADO-style board

- [x] User feedback: dashboard should look near-identical to the Azure DevOps
      board. Rebuilt as a full-window kanban: one column per real ADO state
      (union of valid states across the work item types on the board, ordered
      canonically), column headers with counts, cards with ADO's type colors
      (Task #f2cb1d · Bug #cc293d · Story #009ccc · Feature #773b93 · Epic
      #ff7b00), id/type/age row, and live session-status dots per card.
- [x] **Drag a card between columns to change its state** — optimistic update,
      `adoUpdate({state})`, reverted with a visible error if ADO rejects the
      transition. State can also be changed in the detail pane's dropdown.
- [x] **Detail pane** (slides over the board's right edge, esc closes):
      editable title/state/description, Open in ADO, sessions on the ticket
      (open pane / start worktree session / attach existing), and a
      **Discussion thread** — comments read via the ADO comments API
      (7.1-preview.3) and a composer that posts user-authored comments.
- [x] WIQL widened: active items plus Closed/Done changed in the last 14 days,
      so terminal columns aren't empty and cards can be dragged back out.
- [x] Verified in harness: board renders columns/cards correctly, drop onto a
      column moves the card and updates counts, comment posting appends to the
      thread, disabled states correct. `typecheck` + `build` clean. Real ADO
      calls still pending a live run (errors surface in the board header).

## Iteration 5 — board filters, centered work-item dialog, traffic-light fix

- [x] **Scope filter**: Mine / Everyone pills. "Everyone" widens the WIQL to
      the whole project (no AssignedTo clause, test artifacts excluded),
      fetches `System.AssignedTo`, and the batch cap is surfaced as
      "showing 200 of N most recent" instead of a silent cap.
- [x] **Person filter**: assignee dropdown (derived from results, includes
      "Unassigned") filters cards client-side; cards show the assignee in the
      footer when viewing Everyone.
- [x] **Column filter**: per-state show/hide pill toggles, persisted
      (`mb.board.hidden`); scope persisted (`mb.board.scope`).
- [x] **Centered work-item dialog** (user request: like ADO): detail moved
      from a right slide-over to a centered 820px modal — main column
      title/description/discussion + composer, right sidebar state + session
      actions, Save in the header like ADO's Save & Close. Esc/scrim closes.
- [x] **macOS traffic-light overlap fixed**: the board header now carries the
      same 84px left inset as the top bar and acts as the drag region.
- [x] Verified in harness: Everyone scope shows others' cards with assignees,
      person select narrows to one person, column toggle hides + persists,
      dialog renders centered with correct button states. `typecheck` +
      `build` clean.

## Iteration 6 — "Assigned to" multi-select (replaces Mine/Everyone)

- [x] User disliked the Mine/Everyone pills + single-person select. Replaced
      with one **Assigned to** multi-select dropdown: checkbox rows per person
      with card counts, "(me)" tag on the PAT owner, "Unassigned" bucket, and
      an Everyone row that clears the selection. Empty selection = everyone.
      Selection persists (`mb.board.who`), defaults to me on first run.
- [x] Backend: board always loads the whole project now (single WIQL); "me"
      resolved once via `connectionData` (`providerDisplayName`) and returned
      with the list so the renderer can default and tag the filter — if that
      call fails the board still works, just without a "me" default.
- [x] Cards show the assignee in the footer whenever the item isn't mine.
- [x] Verified in harness: defaults to Me (3 items), toggling Sarah Chen gives
      "2 people" / 4 items, dropdown stays open for multi-toggle, selection
      persisted. `typecheck` + `build` clean.

## Iteration 7 — tabbed navigation (Sessions / Dashboard / Settings)

- [x] User feedback: the board hid the top bar. Restructured to persistent
      tabs in the always-visible top bar: **Sessions** (sidebar + grid),
      **Dashboard** (board rendered inline in the body — overlay removed, no
      more ✕/esc-to-close, board chrome merged into the filter row), and
      **Settings**. "New session" stays in the top bar on every tab;
      cols/Import controls show only on Sessions. Active tab persists.
- [x] **Settings tab** replaces the settings modal AND the control-room
      modal: a General card (repo roots as a list with native "Add folder…"
      picker + remove, WorkTracker folder and claude binary with Browse…
      via a new `dialog:pick` IPC using Electron's showOpenDialog) and the
      CLAUDE.md + Broadcast control room embedded below it.
- [x] ⌘⇧B and palette actions now switch tabs; sidebar ⚙ opens the Settings
      tab; jump-to-session switches back to the Sessions tab. Help popup
      updated.
- [x] Fixed a path-display bug (RTL ellipsis trick reversed "~/Code" into
      "Code/~") caught during harness verification.
- [x] Verified in harness: tab switching, board inline with persisted
      filters, Settings tab with working folder picker (mocked), delivery
      list intact. `typecheck` + `build` clean.

## Iteration 8 — WorkTracker tab + passive session digest for debriefs

- [x] User feedback: debriefs shouldn't appear as coding sessions. Added a
      `debrief` flag on SessionInfo (set by runDebrief, preserved through
      relaunch) and a **WorkTracker tab**: debrief panes render there
      full-width (instrumented density, no zoom/reorder, ✕ closes the
      debrief), with Morning brief / 4pm wrap-up buttons in the tab's toolbar.
      The tab label shows an amber dot when a debrief is waiting on you.
- [x] Sessions tab, sidebar, status-bar counts, and Previous now exclude
      debriefs; persisted debrief sessions are purged at app startup
      (ephemeral reviews). Sidebar/palette debrief actions switch to the
      WorkTracker tab; jump-to-session routes by kind.
- [x] **Passive day digest**: `SessionManager.digest()` snapshots every live
      coding session's metadata + ANSI-stripped terminal tail (~3KB each)
      straight from the in-memory buffers — read-only, nothing written to any
      pty. `writeSessionDigest` saves it to
      `<workTracker>/session-digests/<date>.md` when the 4pm wrap-up starts,
      and the wrap-up prompt instructs claude to fold it in. Digest failure is
      logged and the debrief still runs.
- [x] Also fixed a latent bug: runDebrief used to mutate the title after
      create() (never persisted/emitted); it now passes title through create.
- [x] Verified in harness: debrief hidden from Sessions sidebar/counts, shown
      on WorkTracker tab with waiting banner + amber tab dot, brief buttons in
      toolbar. `typecheck` + `build` clean. The digest file content gets its
      first real exercise on the next live 4pm wrap-up.

## Iteration 9 — feather app icon + brand mark

- [x] App icon: `scripts/make-icon.js` rasterizes the 🪶 emoji onto the
      design's dark dock tile (1h: #242320 rounded tile) at 1024px using the
      local Electron (offscreen canvas), `scripts/make-icns.sh` derives
      `build/icon.icns` via sips/iconutil. `npm run icon` regenerates both;
      assets committed under `build/`.
- [x] Dev runs call `app.dock.setIcon(build/icon.png)` at launch (guarded by
      `app.isPackaged` + existence); packaged builds embed
      `build/icon.icns` via electron-builder `mac.icon`.
- [x] Top-bar brand mark: amber square → the 🪶 feather next to
      "Mockingbird v0.1" (also frees the amber square for the waiting rule).
- [x] Icon verified visually (rendered PNG inspected); `typecheck` + `build`
      clean.

## Iteration 10 — multi-select affordance + sidebar footer cleanup

- [x] User reported the Assigned-to filter "isn't multi-select" — it was
      (iter 6), but a running-app-stale build plus weak affordance made it
      read as single-select. Rows now render real checkboxes (teal fill when
      checked) with a "check any number of people · stays open while you
      pick" hint footer.
- [x] Removed the sessions sidebar footer (WorkTracker briefs + ⚙ settings) —
      redundant with the WorkTracker and Settings tabs. Hooks status moved:
      an amber "⚠ install hooks" appears in the status bar only when hooks
      are missing, and Settings → General shows install state with an
      Install button.
- [x] Verified in harness: checkbox dropdown with 2 selected, sidebar footer
      gone. `typecheck` + `build` clean.

## Iteration 11 — group focus, auto-growing grid, light mode

- [x] **Group focus** (the point of grouping, per user): clicking a group
      header fills the grid with exactly that group's sessions, collapses
      every other group in the sidebar (▸/▾ chevron toggles one group without
      touching the grid), and focuses the first pane. Headers show a session
      count; collapse state persists (`mb.collapsed`). Double-click still
      renames; drag-to-move still works.
- [x] **Auto-growing grid**: removed the edge-drag track resizing entirely
      (user preference) and the "+ new session" ghost tile — the grid now
      derives purely from session count with equal cells (auto cols 1/2/3/4
      by count, manual override still available). Cell wrappers, pointer
      handles, and track persistence deleted.
- [x] **Light/dark mode**: all remaining hardcoded colors swept into design
      tokens, a full warm-light palette added under
      `:root[data-theme="light"]` (amber darkened to #a06a12 for contrast,
      the amber rule intact), xterm themes switch live via `applyTermTheme`.
      Toggle in Settings → Theme (segmented Dark/Light) and ⌘K
      ("Switch to light/dark mode"); persists as `mb.theme`.
- [x] Help popup rewritten for the new grid/group behavior.
- [x] Verified in harness (one screenshot): light mode across chrome +
      terminal, group click focused #5038 with others collapsed, single
      session fills the window with no ghost tile. `typecheck` + `build`
      clean.

## Iteration 12 — window-style pane resizing

- [x] User wanted drag-resize back but with window semantics, not gutter
      grabbing: handles now live on a pane's OWN edges — right edge resizes
      width, bottom edge resizes height, a bottom-right corner grip (visible
      on hover) resizes both in one gesture. Same grid-track math underneath,
      so neighboring panes absorb the change and everything stays aligned;
      double-click any handle to even the grid out; sizes persist per layout.
- [x] Last-column/last-row panes have no right/bottom handle (their outer
      edge is the window). Fullscreen and the WorkTracker tab render no
      handles. Corner uses both axis handlers on one pointer capture.
- [x] Verified with a real pointer drag in the harness: one corner drag took
      the 2×2 grid from equal cells to 409/775 × 288/520, persisted, banner
      and rail intact. `typecheck` + `build` clean. Help + README updated.

## Iteration 13 — group-exclusive grid + slide transition

- [x] Enforced the one-group-at-a-time rule everywhere: `showSession` swaps
      the whole grid (and collapses other sidebar groups) when the target
      session belongs to a different group, and appends when it's the active
      group. All entry points route through it — sidebar rows, palette /
      tray / board jumps, new-session creation (now passes the full
      SessionInfo instead of an id to avoid stale-state races), imports
      (batch becomes the active group), and resume.
- [x] Within-group hiding confirmed: with N sessions in the active group,
      toggling rows hides/re-shows individual panes (e.g. 5 in group, 2
      visible).
- [x] Safety net: a persisted layout that mixes groups is pruned to the
      first session's group on load (unknown ids kept for restore-all).
- [x] Slide animation (user request mid-turn): a 240ms translate+fade on the
      grid container when the active group changes — terminals never
      double-mount; `prefers-reduced-motion` disables it. (Deliberate
      deviation from the handoff's "only the waiting dot animates" rule, at
      the user's request.)
- [x] Verified in harness: stale mixed grid pruned to one group; header
      click swapped groups with `slide-in` class active mid-transition;
      row toggle hid one of two group panes; cross-group row click swapped
      the grid. `typecheck` + `build` clean.

## Iteration 14 — assigned-to filter: invisible "Me" selection fixed

- [x] Bug: the button could read "Me" while no such row existed in the
      dropdown. Two root causes addressed:
      1. The dropdown was built only from loaded items' assignees — if your
         cards aren't in the 200-most-recent project items, your row didn't
         exist. Selected people and "me" now ALWAYS get a row (0 count when
         no cards loaded), so a checked filter can never be invisible.
      2. ADO identity quirk: `connectionData.providerDisplayName` can differ
         from `System.AssignedTo.displayName` on work items. "Me" is now
         resolved to the work items' own spelling — matched by email
         (`uniqueName` vs `connectionData` Account) first, then
         case-insensitive name — and a persisted stale spelling in
         `mb.board.who` self-heals on load.
- [x] Verified in harness: a selected person with zero loaded cards renders
      as a checked row with count 0 ("Ghost Person 0 ✓") next to
      "(me)". Email-based resolution runs in the main process — first real
      exercise on the live board. `typecheck` + `build` clean.

## Iteration 15 — ticket sessions: branch modes, fresh dev/uat base, auto-prompt

- [x] Start-session from a ticket now has **New branch / Existing branch**
      modes. New branch: `createWorktree` fetches `origin/<base>` first and
      cuts the branch off it — base auto-detected per repo
      (dev > develop > development > uat > main > master, from local+origin
      refs via new `repo:branches` IPC) and changeable in a select; falls
      back to the local base loudly if the fetch fails (offline). Existing
      branch: local branches check out directly, origin-only branches are
      fetched and tracked (`worktree add --track -b`).
- [x] **Ticket → first prompt**: a default-on checkbox sends the ticket
      number, title (with unsaved edits), and description to the new claude
      session as its kickoff message (`initialPrompt` in NewSessionRequest,
      delivered via bracketed paste ~6s after spawn, same mechanism as
      debriefs).
- [x] Verified in harness: mode pills + base select render, base defaults to
      origin/dev, note shows "creates worktree 5110-… from origin/dev", and
      the captured createSession request carried baseBranch + the full
      ticket prompt. The git flows (fetch/track/branch-off) run in the main
      process — first live exercise on next real use. `typecheck` + `build`
      clean.

## Iteration 16 — ADO ticket picker in the New Session modal

- [x] The New Session modal (used from groups/topbar/⌘N) now has an
      "Azure DevOps ticket" dropdown: your tickets first, then the rest of
      the project's (from the same board load). Picking one auto-fills
      Ticket # and Ticket name (still editable). Manual entry unchanged;
      if ADO is unreachable the picker disables with a note and manual
      entry still works.
- [x] Parity with the dashboard flow: base-branch select (fresh
      origin/dev-style base, auto-detected per repo) appears once a repo is
      chosen, and a default-on "send ticket title + description to Claude"
      checkbox appears when a ticket is picked (same initialPrompt).
- [x] Verified in harness: picking #5110 filled 5110 /
      loginRetryLoopOnExpired, worktree line showed
      5110-loginRetryLoopOnExpired, base defaulted to origin/dev, prompt
      checkbox present. `typecheck` + `build` clean.

## Iteration 17 — per-group layout memory

- [x] Bug: switching groups always showed the whole group, forgetting which
      sessions were minimized. Added `groupLayouts` (persisted,
      `mb.groupLayouts`): the active group's visible subset is recorded on
      every change; switching to a group restores its remembered subset
      (pruned to sessions that still exist); clicking the ALREADY-active
      group's header re-shows the full group (the explicit "open everything"
      action). Cross-group row clicks restore the target group's memory plus
      the clicked session.
- [x] Verified in harness: hide 1 of 2 in group 5101 → switch to 5038 →
      switch back restores exactly the 1-pane subset; re-clicking the active
      header expands to both. `typecheck` + `build` clean.

## Iteration 18 — waiting status clears on permission approval

- [x] Bug: a pane stayed amber ("permission: …") after the user approved the
      permission, until the whole turn finished. Cause: approval fires no
      hook among Stop/Notification/UserPromptSubmit — the next event was
      Stop. Fix: added **PreToolUse** to the installed hooks; it fires when
      the approved tool starts executing and maps to `working`, clearing the
      banner/border/reason immediately.
- [x] `hooksInstalled()` is now strict (every event must be wired), so
      existing installs missing PreToolUse show the "⚠ install hooks"
      status-bar warning — one click merges the new event into
      ~/.claude/settings.json. The hook script is unchanged (append + exit 0,
      no stdout), so PreToolUse never blocks a tool.
- [x] events.jsonl now truncates at launch if >10MB (PreToolUse appends per
      tool call; only post-launch events are ever read).
- [x] `typecheck` + `build` clean. Hook behavior is exercised live — needs
      the app restarted AND one click on "install hooks" to add the new
      event.

## Iteration 19 — my-tickets-only picker + visible identity

- [x] New Session modal's ticket picker now filters to work items assigned
      to the PAT owner ("My Azure DevOps tickets"); disabled with a note
      when none are assigned; falls back to all items only if identity
      resolution fails.
- [x] Identity model surfaced: new `ado:me` IPC (`adoIdentity`) and a line
      in Settings under the WorkTracker folder — "signed in to ADO as
      <name> (<email>) · project <p>" — plus a note that identity comes
      from the PAT in that folder. Per-user by construction: PAT +
      home-relative paths + per-user ~/.mockingbird + localStorage mean
      another person's own machine/config resolves everything to them; no
      Ryan-specific defaults ship in the app.
- [x] Verified in harness: picker lists only the PAT owner's 3 tickets;
      Settings shows the signed-in identity line. `typecheck` + `build`
      clean.

## Iteration 20 — Shift+Enter inserts a newline in Claude prompts

- [x] Terminals send plain CR for both Enter and Shift+Enter, so xterm panes
      submitted on Shift+Enter. Added an xterm custom key handler per pane:
      Shift+Enter (no other modifiers) writes ESC+CR to the pty — the same
      sequence Option+Enter sends, which the Claude CLI treats as "insert
      newline, don't submit". All other keys pass through unchanged.
- [x] Help popup keyboard list documents ⇧⏎. Verified in harness: a
      Shift+Enter keydown on the terminal produced exactly "\\x1b\\r" to
      sessionWrite. `typecheck` + `build` clean.

## Iteration 21 — sidebar shows renamed session titles

- [x] Bug: sidebar rows rendered `ticketTitle ?? branch ?? title`, so
      renaming a no-ticket session (title updated, ticketTitle null) still
      showed the branch (`mb-…`) in the sidebar while the pane header showed
      the new name. Sidebar now uses the same `ticketTitle ?? title` as the
      pane, palette, and dialogs. (Unrenamed branch sessions look identical
      — their title defaults to the branch name at creation.)
- [x] `typecheck` + `build` clean.

## Iteration 22 — clickable status-bar counts

- [x] The working/waiting/idle/dead counts in the status bar are now
      clickable (when non-zero): a popover opens upward listing that
      status's sessions — name plus group key (waiting rows show the wait
      duration instead). Clicking a session routes through jumpToSession,
      which switches to its group (restoring the remembered layout) and
      un-hides the pane if it was minimized. Outside click closes.
- [x] Verified in harness: with the grid on another group, "1 waiting" →
      popover row "filterOrgsByFoundation · 3m" → click → grid swapped to
      group 5038 with the waiting pane visible, popover closed. `typecheck`
      + `build` clean.

## Iteration 23 — rearrangeable board columns

- [x] Board columns can be dragged by their headers to reorder (drop onto
      another column inserts before it), so the board can mirror the real
      ADO column order instead of the canonical-guess sort. Custom order
      persists (`mb.board.colOrder`); states not yet in the custom order
      append in canonical order; the Columns filter pills follow the same
      order. Card drag-to-change-state unchanged (separate drag payloads).
- [x] Verified in harness: dragging Resolved onto New reordered to
      Resolved/New/Active and persisted. `typecheck` + `build` clean.

## Iteration 24 — debriefs get a live ADO snapshot (connector-independent)

- [x] User's wrap-up flagged "ADO connector unavailable — ticket states
      reconstructed". Root cause: the debrief claude session depends on
      Claude Code's own ADO access (MCP server / az CLI), which Mockingbird
      can't guarantee. Fix: `writeAdoSnapshot` (ado.ts) pulls the PAT
      owner's open work items (≤15, non-terminal states) with descriptions
      + last 3 comments each via the app's REST client and writes
      `session-digests/ado-snapshot-<date>.md`; both debriefs' kickoff
      prompts point at it as the source of truth for ticket state. Honest
      limits stated in the file and prompt: PR review votes not included.
- [x] Kickoff restructured: context assembly is async; the prompt sends at
      max(6s-boot, 1s-after-ready). Snapshot/digest failures log and the
      debrief still runs.
- [x] `typecheck` + `build` clean. Snapshot content gets its first live
      exercise at the next debrief.

## Iteration 25 — Connectors section + az PAT injection for debriefs

- [x] Debrief sessions now spawn with `AZURE_DEVOPS_EXT_PAT` injected from
      the WorkTracker PAT file (`adoEnv`, debrief sessions only — coding
      sessions don't get the PAT), so the az DevOps CLI authenticates
      without `az login` or an MCP server. Combined with the kickoff
      snapshot, `claude mcp add` is now fully optional for ticket data.
- [x] Settings → **Connectors** card shows the three access paths: ADO app
      identity (moved from the WorkTracker note), az CLI detection + the
      injection note, and Claude Code MCP servers (read from ~/.claude.json
      + WorkTracker/.mcp.json) with the optional add command when none
      configured. New `connectors:status` IPC.
- [x] Verified in harness: card renders identity/az/mcp rows. az injection
      is exercised at the next real debrief. `typecheck` + `build` clean.

## Iteration 26 — Settings scroll fix + editable Connectors

- [x] Scroll bug: settings cards were flex children that compressed to fit
      (the overflow-hidden control-room card collapsed to 0), so nothing
      overflowed. `flex-shrink: 0` on cards restores real scrolling.
- [x] Connectors are now editable in-app:
      - **Azure DevOps**: org URL / project inputs + PAT-file Browse…,
        "Save connector" merge-writes only the `azureDevOps` keys into
        WorkTracker/config.json (rest preserved), resets the identity cache,
        and the connected-as line refreshes to confirm.
      - **MCP servers**: add (name + command) / remove rows writing
        WorkTracker/.mcp.json — project-scoped, so debrief sessions load
        them and Claude Code asks approval on first use. Global Claude Code
        servers listed read-only with a `claude mcp` pointer.
- [x] Verified in harness: page scrolls (1335/652), ADO form loads config,
      MCP add creates a removable row and clears the form. `typecheck` +
      `build` clean.

## Iteration 27 — status popover opens upward (visibility fix)

- [x] Bug: the status-count popover rendered below the status bar
      (off-screen). Cause: `.who-pop`'s `top` anchor was declared later in
      the stylesheet and tied `.stat-pop`'s override on specificity, so the
      downward anchor won. Fixed with `.who-pop.stat-pop` (higher
      specificity) anchoring `bottom: calc(100% + 10px)`.
- [x] Verified with a real screenshot this time: clicking "1 working" shows
      the session list floating above the status bar. `typecheck` + `build`
      clean.

## Iteration 28 — sub-groups (workspaces), group bar, sidebar cleanup

- [x] **Sub-groups via path-style names** (`5038/backend` in taskGroup) — no
      schema change, zero migration, all existing mechanics (rename, drag,
      persistence, setGroup) work unchanged. Grid exclusivity + layout
      memory now key on the TOP-level group; sub-groups are views within it.
- [x] **Group bar above the grid** (the intuitiveness fix): always names the
      active group and shows "N of M shown"; when the group has sub-groups
      they render as workspace tabs — [All (n)] [backend (2)] … — clicking a
      tab shows just that slice (cmux-workspace feel).
- [x] **Sidebar**: sub-groups render as indented mini-headers with counts
      (click to focus, drop target to move sessions in); ⤷ dialog gained a
      Sub-group field (applied to whichever group you pick); removed the
      pane-index numbers next to session names (user: noise that truncated
      names — the row highlight already marks what's in the grid).
- [x] Dashboard ticket linkage is sub-group-aware (a session in
      "5038/backend" still counts and attaches under ticket 5038).
- [x] Verified in harness: indented ETL sub-header in sidebar, group bar
      with All/etl tabs, tab click narrowed 2→1 panes with "1 of 2 shown".
      `typecheck` + `build` clean. Help popup updated.

## Iteration 29 — paste images + drop files into panes

- [x] ⌘V with an image on the clipboard now works like cmux/iTerm: a
      capture-phase paste listener on each pane detects image clipboard
      items and forwards Ctrl+V (\\x16) to the pty — Claude Code reads the
      image from the macOS pasteboard natively and shows "[Image #1]".
      Text pastes are untouched (xterm's normal path).
- [x] Dragging files (screenshots or anything) onto a pane inserts their
      quoted filesystem paths into the prompt — paths resolved via
      Electron's webUtils.getPathForFile in the preload (File.path is gone
      in modern Electron). File drops don't collide with session-reorder
      drags (different payloads, stopPropagation).
- [x] Help popup documents ⌘V image paste + file drop. Verified in harness:
      image paste → "\\x16" written to the pty; file drop → quoted path
      written. `typecheck` + `build` clean.

## Iteration 30 — plain terminal sessions (no Claude)

- [x] New Session modal gained a **Launch: Claude / Terminal** toggle (⌘K
      also has "New terminal"). Terminal sessions spawn interactive zsh in
      the chosen cwd — same repo/worktree/branch machinery, no claude.
- [x] Safety/semantics: shell sessions start **idle** (no hooks), carry a
      `shell` flag + "shell" chip, and are **excluded from broadcasts,
      CLAUDE.md re-reads, and the delivery list** — a broadcast typed into
      a shell would execute as commands. Kickoff prompts are suppressed.
      If the user manually runs `claude` inside the shell, the cwd-matched
      hooks light the status dots up normally. Relaunch preserves the flag
      (respawns zsh).
- [x] `typecheck` + `build` clean.

## Iteration 31 — sub-groups reworked as tabbed workspace panes (cmux-style)

- [x] User disliked the filter-style sub-groups; picked "tabbed panes like
      cmux" via AskUserQuestion. Rework: same path data model
      (`group/sub`), new rendering — a sub-group is ONE grid cell (.ws-pane)
      with a tab strip: sub name + one tab per session (status dot + name);
      clicking a tab switches which session's TerminalPane renders inside
      (terminals stay cached, scrollback survives switches). Active tab per
      workspace persists (`mb.wsTabs`); jump-to-session fronts its tab.
- [x] Tabs list ALL of the workspace's sessions (the workspace is the
      visibility unit; any shown member brings the pane). Grid column math
      counts cells, not sessions. A waiting member gives the workspace the
      amber border + its tab dot pulses. Embedded panes drop their own
      border/radius (wrapper owns chrome); resize handles work on workspace
      cells. Group bar simplified to name + "N of M shown" (sub pills gone —
      the pane carries its tabs).
- [x] Verified in harness: ETL workspace with two tabs, tab click switched
      billing-export → authRetry (dead body rendered inside), highlight
      moved. `typecheck` + `build` clean. Help + README updated.

## Iteration 32 — terminal-independent app + GitHub update channel

- [x] **Packaged app works**: `npm run package` produced
      dist/mac-arm64/Mockingbird.app (+ DMG/zip). The electron-rebuild step
      failed on this machine (broken CLT: even `#include <functional>`
      fails) — fixed by `npmRebuild: false` + `asarUnpack` for node-pty,
      shipping its prebuilt N-API binaries (same ones dev mode uses).
      Verified pty.node + spawn-helper unpacked with the executable bit.
      Launched from the Dock, the app has no terminal dependency.
- [x] **Update channel**: `updates.ts` checks the GitHub latest release
      (source = package.json `repository`, absent → cleanly disabled);
      polls at launch + every 6h; a newer version fires one native
      notification per version (click → release page) and a teal
      "⭮ vX.Y available" status-bar link; Settings → "Check for updates"
      for manual checks with honest states (up to date / available / not
      configured / failed). No silent self-replace — unsigned macOS apps
      can't; documented that Developer ID signing unlocks electron-updater
      later.
- [x] Release flow documented in README (bump version → package → tag
      vX.Y.Z release with DMG/zip). `typecheck` + `build` clean; the live
      check activates once the repo exists and `repository` is set.

## Iteration 33 — workspace (sub-group) lifecycle made direct

- [x] User confusion: sub-groups had no create/rename/delete controls (they
      only existed implicitly via session paths). Added direct manipulation:
      - **Create**: drag one loose session row onto another in the same
        group → a workspace ("tabs", auto-uniqued) holding both is created
        and the inline rename opens immediately. (⤷ dialog's sub field
        still works for precise placement.)
      - **Rename**: double-click the workspace name — sidebar label OR the
        pane's tab-strip name — inline edit re-paths every member.
      - **Dissolve**: hover-✕ on the sidebar workspace label — members move
        up into the parent group, sessions untouched.
- [x] Bug fixed en route: renaming a top-level group stranded its
      sub-pathed sessions (exact-match only); renameGroup is now
      prefix-aware ("5101" → "X" carries "5101/etl" → "X/etl").
- [x] Help popup rewritten with the explicit create/rename/dissolve recipe.
- [x] Verified in harness: ✕ dissolved etl (member's group became the
      parent; session intact), row-onto-row created "5101/tabs" for both
      sessions with the rename input auto-opened. `typecheck` + `build`
      clean.

## Iteration 34 — stale "waiting" statuses fixed + dismissable

- [x] Root cause found: Claude Code fires a Notification ("Claude is
      waiting for your input") after ~60s idle at the prompt — an idle
      reminder, not blocked-on-you — and Mockingbird treated every
      Notification as waiting, so finished sessions went amber a minute
      later. The watcher now classifies that message as **idle** (no amber,
      no notification); permission prompts still go waiting.
- [x] Manual escape hatch: the waiting banner has a ✕ ("dismiss — mark
      idle") wired to `sessions:clearWaiting` for any stale state from
      other causes (e.g. events missed while the app was closed).
- [x] Verified in harness: banner ✕ cleared the status (banner gone,
      counts 1→0 waiting, amber styling removed). The notification
      classification is main-process — verify live by letting a finished
      session sit >60s: it should stay grey now. `typecheck` + `build`
      clean.

## Iteration 35 — repo-less terminals + launch-toggle clarity

- [x] Opening a Terminal no longer requires picking a repo: the Start
      button only enforces repo-for-worktree in Claude mode; a repo-less
      terminal opens in the home folder (note shown in the modal), titled
      "terminal", and doesn't get the assistant teal treatment.
- [x] "Claude starts anyway": the Terminal spawn path is main-process code —
      it requires a full app quit+relaunch, not ⌘R; called out to the user.
      The spawn logic itself was verified correct (request carries
      shell:true, repoPath:null, no initialPrompt).
- [x] Verified in harness: Terminal + no repo → enabled "Open terminal"
      button, home note, correct request payload. `typecheck` + `build`
      clean.

## Iteration 36 — frozen panes after group/tab switches fixed

- [x] Root cause: each pane subscribed to its session's output only while
      MOUNTED — hidden panes (switched group / inactive workspace tab)
      missed all bytes produced meanwhile, so returning showed a frozen
      snapshot (⌘R "fixed" it by rebuilding terminals from the buffer).
      Replaced per-pane subscriptions with ONE global data pump that writes
      to cached terminals regardless of mount state; creation-time buffer
      replay covers anything before a terminal first exists. No refresh
      needed — hidden sessions stay current.
- [x] Belt-and-suspenders: a ⟳ button on every pane header hard-resyncs the
      terminal from the main process's buffer (term.reset + replay) for any
      residual weirdness.
- [x] Verified in harness with the exact repro: mounted s1 → switched
      groups → pushed output while hidden → switched back → the new output
      was present immediately. `typecheck` + `build` clean.

## Iteration 37 — workspace/group rename actually works

- [x] User: double-click rename on sub-groups didn't work. TWO real bugs:
      (1) header clicks scheduled focusTerm(+50ms) which stole focus from
      the just-opened rename input → instant blur-commit-close; (2) worse,
      the first click of a double-click collapses other groups → the
      sidebar layout shifts and the second click + dblclick land on a
      different element, so the rename never even started. Fixes: header
      single-click actions are deferred 250ms and canceled by double-click
      (no layout shift mid-gesture), and focusTerm removed from header
      clicks.
- [x] Added hover ✎ rename buttons to BOTH group headers and workspace
      labels — a timing/layout-proof path matching the session rows'
      affordance.
- [x] Verified with REAL pointer input: double-click opened a stable
      focused edit field; typing + Enter re-pathed the member session
      ("5101/etl" → "5101/pipeline"), closed the field, updated the label.
      (The one Return keypress that didn't commit in testing was a browser-
      pane CDP key-mapping artifact — JS-dispatched Enter and the real app's
      keyboard both commit.) `typecheck` + `build` clean.

## Iteration 38 — rename via dialog (root-caused), Move dialog rebuilt

- [x] The REAL flash-close cause (missed twice): the shared inline
      editInput rendered in TWO places when the workspace was visible —
      sidebar label AND the grid tab strip — both autoFocus, second mount
      stole focus from the first → blur → commit → both closed instantly.
      My harness repros had the workspace hidden, so they passed. Fix:
      group/workspace renames now open a small **RenameDialog** (single
      input, Save/Cancel/Enter/Esc) — immune to focus/layout/duplication;
      inline editing remains only for session rows and pane titles, which
      never had the problem.
- [x] **Move dialog rebuilt** (user: unintuitive, no save): now an explicit
      form — Group dropdown (+ "new group…" reveal), Workspace text field
      with per-group suggestions prefilled with the current workspace, and
      nothing happens until **Move** is clicked (Remove from group / Cancel
      alongside). No more instant-move-on-row-click.
- [x] Verified with REAL input in the previously-failing state (workspace
      visible in grid): double-click → dialog opened and stayed → Save →
      session re-pathed 5101/etl → 5101/pipeline, sidebar label AND grid
      tab-strip name updated. Move dialog renders group select + workspace
      field + explicit buttons. `typecheck` + `build` clean.

## Iteration 39 — workspaces can be minimized again

- [x] Regression from the workspace-unit rework: the pane's "–" only hid
      the active tab's session (no visible effect — tabs always list all
      members) and the sidebar label only revealed, never hid. Workspaces
      now minimize as ONE unit: the sidebar workspace label **toggles**
      (shown → minimize all members; hidden → reveal), and the workspace
      pane's "–" minimizes the whole workspace. Zoom clears if the zoomed
      session is inside.
- [x] Verified with real clicks: label click minimized the visible
      workspace, second click brought it back with its tabs, and the
      pane's "–" minimized it again. `typecheck` + `build` clean.

### Security notes (iteration 3)

- PAT: read from the file referenced by `azureDevOps.patFile`, kept in the
  main process; renderer only ever receives work-item fields.
- `shell:open` IPC validates `https://` before `shell.openExternal`.
- Ticket edits are user-initiated per click ("Save to ADO"); note the
  WorkTracker config's `ticketEdits: comments-only` guardrail applies to the
  debrief assistant — the app now allows direct edits at the user's explicit
  request.
- Description round-trip flattens HTML → plain text → simple divs; rich
  formatting in existing tickets is simplified if the description is edited.

## Iteration 40 — glitch/scrollbar fixes, `/clear` on refresh, span, code review

- [x] **Terminal glitching**: `resyncTerm` no longer replays corrupted byte
      history (old frames were drawn at other sizes — replay reproduces the
      garbage). It clears the terminal and nudges the pty size (cols-1 → cols),
      so the CLI redraws its current frame like a fresh SIGWINCH. `doFit` now
      only resizes when `proposeDimensions()` actually differs, which stops the
      resize churn that produced the duplicated lines. ⟳ retitled "Repaint".
- [x] **Scrollbar**: `.term-holder .xterm-viewport` scrollbars hidden.
- [x] **`/clear` running on refresh** (root cause found): the terminal's
      `onData` → pty path was live while the scrollback replay was being
      parsed. xterm auto-answers query sequences it finds in replayed output
      (DSR/DA/OSC colour), and those answers were written into the running
      Claude prompt as if typed — enough to submit a stray slash command.
      Fixed with a `ready` gate: nothing reaches the pty until the replay has
      been written, and live output that arrived before the buffer snapshot is
      dropped instead of being written twice (main appends to its buffer and
      sends `session:data` in the same handler, so ordering is guaranteed).
      All UI→pty writes now go through one `writeSession()` chokepoint.
- [x] **Span the last row**: an incomplete last row's pane spans the leftover
      columns (3 panes in 2 cols → bottom pane full width). Verified in a
      static grid harness: with columns dragged to 1.3fr/0.7fr, the two top
      panes measured 816px and 440px and the bottom pane 1264px = 816+440+8
      gap — it spans exactly, and respects dragged track sizes.
- [x] **Code review** (10 finder angles + verify + sweep, 15 findings). 14
      fixed, 1 deferred. Highlights beyond the `/clear` fix:
      hook events now route by Claude's own `session_id` (cwd alone collided
      for debriefs/assistants/shared worktrees); broadcasts no longer type into
      a `waiting` session (the trailing Enter could approve a pending
      permission prompt); queued broadcasts flush on any → idle; a failed
      relaunch no longer deletes the persisted session; a dying pty can no
      longer mark its replacement dead; state.json writes atomically and a
      corrupt file is preserved as `.corrupt-<ts>` instead of silently reset;
      `installHooks` refuses to overwrite an unparseable `~/.claude/settings.json`;
      CLAUDE.md read/save errors surface instead of loading/saving "";
      ADO identity failures are no longer cached; tray click-to-jump works
      (stale closure); ⌘1–9 addresses panes, not sessions; dropping a session
      onto another now opens the workspace rename dialog; renaming a group
      migrates its remembered layout/tab/collapse state.
- [ ] **Deferred**: `worktreeState` polling runs sync `git` on the main
      process (3–4 `execFileSync` per pane per 10s) — it should move to
      `execFile` + one cache per cwd. Same for `git fetch`/`git push` during
      session create/cleanup, which block every pty while they run.

## Iteration 41 — cmux-style "+" tabs in workspaces

- [x] **Workspace tab strip** gains a `+` at the end: opens New Session with the
      Group field pre-seeded to that workspace's path (`5038/backend`) and the
      label reading `GROUP → TAB IN "BACKEND"`, so the session joins as a tab
      instead of taking its own grid cell.
- [x] **Lone panes get `+` too** (pane header, next to ⛶): promotes the pane to
      a workspace and opens a second tab beside it. The existing session only
      moves once the new one is actually created — cancelling the dialog leaves
      the pane exactly as it was (verified: cancel → still 1 plain pane, no
      stray workspace).
- [x] Restored path syntax in the Group field. Iteration 40's review pass had
      sanitized it to a single segment, which silently broke the documented
      `5038/backend` workspace syntax; `normalizeGroupPath()` in
      `src/shared/types.ts` now canonicalizes group + one workspace segment and
      is the single definition both the field and the `+` buttons use.
- [x] Verified with real clicks in the harness: workspace `+` → backend went
      2 tabs → 3 with the new tab fronted and the grid still 2 cells; pane `+`
      → lone "api refactor" became workspace TABS with `api refactor | new
      session | +`; clicking an existing tab still switches panes.

## Iteration 42 — ticket picker: board columns, grouped, any assignee

- [x] **Working columns only.** The New Session ticket dropdown drops terminal
      states (Done/Closed/Removed/Resolved/Completed/Cut/Abandoned) — you pick
      from the columns you actually work out of (Approved (Do), Planning,
      Parked, In Progress, QA…). The Dashboard board is unchanged; it still
      shows every column.
- [x] **Grouped by column, in board order.** `<optgroup>` per state. Order of
      preference: the column order dragged into place on the Dashboard
      (`mb.board.colOrder`), then Azure DevOps' own workflow order for the work
      item type (fetched via `adoStates`), then the generic `STATE_ORDER` rank.
      Reordering columns on the board reorders the picker.
- [x] **Any assignee.** A person dropdown next to it (Anyone / you first / other
      names on the board) replaces the hard "only my tickets" filter. Defaults
      to the PAT owner, so the old behavior is still what you get on open.
      Changing person clears the current pick so a stale selection can't leak.
- [x] Verified in the harness with fixtures across 7 states and 2 assignees:
      as "Ryan" → Approved (Do), Planning, In Progress; as "Anyone" → Approved
      (Do) → Planning → Parked → In Progress → QA, Done/Closed absent in both;
      picking another person's QA ticket filled ticket #, name, and branch
      5044-donorMatchTuning.

## Iteration 43 — restart every Claude session at once

- [x] The CLI updates itself in the background and prints "Update installed ·
      Restart to update"; each running `claude` keeps the old build until its
      process restarts. Added **Restart all Claude sessions**:
      Settings → Updates, and ⌘K → "Restart all Claude sessions".
- [x] `SessionManager.restartAll(includeBusy)` kills and relaunches each live
      session through the existing `relaunch()` path — same id, so grid slot,
      group, worktree, and title are kept, and `--continue` resumes the
      conversation. Shells and dead panes are skipped (a shell has no CLI to
      update; a dead pane already has its Resume button).
- [x] Sessions that are **working or waiting are skipped by default** — killing
      one mid-turn loses the answer in flight. The dialog says how many are busy
      and offers an explicit opt-in checkbox to include them.
- [x] Renderer disposes the cached xterm for each restarted id so panes
      re-attach to the new pty and replay its buffer instead of showing a dead
      terminal.
- [x] Verified in the harness: with 1 working / 1 waiting / 1 idle the button
      read "Restart 1 session"; ticking the opt-in changed it to "Restart 3
      sessions"; running it restarted all three and the status bar went to
      3 working · 0 waiting · 0 idle.

## Iteration 44 — the /clear cause, found

Forensics, not theory. Claude Code writes a transcript per session under
`~/.claude/projects/`, and a `/clear` is recorded in it as
`<command-name>/clear</command-name>`. Every `/clear` across every project,
with the gap between them:

    2026-08-17T17:03:39.789Z              donor-raw-etl-worktrees-mb-msqglypk
    2026-08-17T17:03:39.797Z   +0.008s    -Users-ryanellerbroek
    2026-08-17T17:03:40.184Z   +0.387s    donor-raw-etl-worktrees-mb-msqglypk
    2026-08-17T17:03:40.193Z   +0.009s    -Users-ryanellerbroek
    …12 more, same two sessions, every ~394ms…

Two sessions cleared within ~8ms of each other, repeating every ~400ms, a
dozen times. That is not a person typing and not an idle timeout — it is a
feedback loop. xterm answers queries it finds in terminal output (cursor
position, device attributes, OSC colour). The answer goes to the pty, the CLI
redraws, the redraw contains the query again, xterm answers again — one lap
per round-trip, ~400ms. The CLI ends up acting on the injected bytes, and one
of the things it does is clear the session. Sessions in hidden panes keep
looping because a cached terminal keeps parsing output whether or not it is
on screen — which matches "windows nobody was interacting with".

- [x] A detached terminal (hidden pane, background workspace tab) never answers
      a query at all. Nobody is looking; its answers only start loops.
- [x] A visible terminal answers at most 4 queries per 3s. Startup needs a
      handful; a loop needs unlimited. Past the cap, answering stops.
- [x] Anything else that is not traceable to real input in that pane
      (keystroke, IME/dictation, paste, mouse) never reaches the pty.
- [x] Everything dropped is written to `~/.mockingbird/pty-audit.log` with the
      exact bytes, so the next occurrence names itself instead of being guessed.

## Iteration 45 — selection survives live output

Highlighting in a busy pane collapsed as soon as new output arrived, because
writing to xterm during a drag drops the selection — and a Claude session
redraws constantly. Output for a pane is now parked (not written) from
pointer-down while a highlight stands, and released the moment the selection
is dropped (`onSelectionChange`), with a 15s cap so a pane can never look
frozen. Verified in the harness with output streaming at 8 lines/sec: the
highlight stays put instead of vanishing.

## Iteration 46 — selection regression reverted, snap layouts

- [x] **Reverted the output-parking "fix".** Measured with xterm's own API in
      the harness: a selection survives writes untouched (`hasSelection()` stays
      true, `getSelection()` returns the same text after live output). Parking
      output never solved a real problem — and it caused a worse one: the DOM
      renderer repaints on write, so with writes parked the highlight didn't
      draw until release, and then drew stale. Writes go straight through again.
      Verified with dispatched mouse events: the highlight paints during the
      drag and stays put while output streams.
- [x] **Layout button replaces the `A 1 2 3 4` column control.** A flyout of six
      zone templates (two columns, two rows, three columns, big-left, big-top,
      quadrants) in the spirit of Windows snap layouts, remembered per group.
      A template governs only when its zone count matches the open panes: with
      fewer panes the zones collapse so nothing empty holds space, with more the
      extras flow into equal cells below. Edge-dragging still fine-tunes.
      Not yet built: dragging a pane onto a specific zone.

## Iteration 47 — the real selection killer: mouse-tracking enable mid-drag

Root cause found in xterm's own source: on mouse-protocol change,
`onProtocolChange` calls `selectionService.disable()` — immediately, mid-drag
included. The Claude CLI toggles mouse tracking as part of its redraw, so a
highlight tracked the cursor until the enable sequence was parsed, then froze
("stops following after a bit; select again and it works" — by then the CLI
had toggled it off again). Plain output was never the problem, which is why
the output-parking attempt fixed nothing.

- [x] While a drag is in progress or a highlight stands, mouse-tracking
      *enable* sequences (CSI ? 1000/1001/1002/1003/1005/1006/1015/1016 h) are
      parked; everything else renders live. Parked enables are delivered on
      pointer-up / selection-clear, so the CLI ends up in exactly the state it
      asked for. Disables always pass through — they only help.
- [x] Verified through the real pump path in the harness: enable arriving
      mid-drag → mode stays `none`, sequence held; pointer-up → flushed, mode
      becomes `drag`; disables untouched; output kept rendering throughout.

## Iteration 48 — selection: the actual mechanism, in two parts

Captured raw bytes from a real generating claude session and bisected them
against a live selection in the harness. Two independent killers, which is why
each earlier single fix failed:

1. Claude Code's newer TUI latches mouse tracking + the alt screen on for whole
   generations (`?1000/1002/1003/1006h`, `?1049h` — captured, never released).
   xterm answers a mouse-protocol enable with clearSelection() + selection
   service disabled. This arrived with a CLI self-update — nothing in our pane
   code changed — and shells never enable it, which is why shell panes always
   selected fine.
2. xterm clears a selection when a write touches the selected rows, and the
   claude TUI redraws its whole frame continuously (bisect: killed by plain
   `2K`/`1A`/`H` redraw sequences). Appends don't do this, which is why plain
   streaming tests passed.

Fix (both halves, claude panes only — shells untouched):
- mouse-tracking enables are stripped from the display stream (split-chunk
  safe via a carry buffer; history replay stripped too). Wheel still scrolls
  the CLI's alt-screen UI — with no mouse protocol, xterm converts wheel to
  arrow keys there, iTerm's default for such apps.
- while a drag is in progress or a highlight stands, output is parked and the
  pane freezes at the moment of selection; released the instant the selection
  drops (or after copy, 15s, or 400KB — whichever first).

Verified with the real capture replayed through the pump: selection text
byte-identical after a full generation's redraws; release → pane catches up;
mouse mode stays `none` throughout.

## Iteration 49 — copy-on-select, and wheel scrolls the transcript again

- [x] Stripping the CLI's mouse modes left xterm's fallback wheel behavior:
      arrow keys, which the CLI reads as prompt history. The pane now remembers
      what the CLI asked for (`wantsMouse`, cleared on the matching disable) and
      the wheel handler answers on its behalf with the SGR reports it expects
      (`ESC[<64/65;col;rowM`, up to 3 per tick) — transcript scrolls natively,
      arrows stay for history, and the mouse protocol still never activates in
      xterm, so selection keeps working. With a highlight standing the wheel is
      inert (the frame is frozen). Shell panes untouched.
- [x] Copy-on-select: finishing a highlight puts it on the clipboard; the
      highlight lingers ~1.5s as confirmation, then clears so the pane resumes
      live output. Manual ⌘C still works during the linger.
- [x] Verified in the harness against the real capture: wantsMouse latched with
      mode `none`; wheel → correct SGR reports both directions; wheel while
      selected → nothing, selection intact.

## Iteration 50 — highlight made visible and cmux-parity semantics

- [x] The dark theme's selection color was `#3a372f` — near-invisible against
      the `#201f1c` pane background, so selections looked broken even when the
      machinery worked. Now translucent white (`rgba(255,255,255,.35)`, dimmer
      when the pane is unfocused), stock-terminal style; light theme gets a
      translucent blue.
- [x] cmux-parity behavior: release copies to the clipboard and the pane
      resumes immediately; output holds only during the drag itself; nothing in
      our code ever clears a highlight (both auto-clear timers removed) — it
      stays until you click elsewhere or the CLI redraws over it, exactly like
      a normal terminal. Wheel is inert only mid-drag.
- [x] Verified with a real drag: white highlight visible across the dragged
      rows, still standing 3s after release with hold released and text intact.

## Iteration 51 — "Copied ✓" confirmation

- [x] Finishing a highlight shows a small "Copied ✓" pill in the pane's bottom
      right (teal on the header background), fading out over ~1.6s. It only
      appears when the clipboard write actually succeeded — a denied write
      shows nothing and leaves the selection standing for ⌘C.
- [x] Harness note: the sandboxed browser denies clipboard writes, so the
      trigger can't fire there; the toast's placement/style verified by
      injection, the trigger path relies on the same promise the (confirmed
      working) copy uses.

## Iteration 52 — trackpad scroll speed in claude panes

- [x] The synthesized wheel reports sent at least one scroll per wheel event —
      fine for a mouse (few chunky ±120 events), wild for a trackpad (dozens of
      tiny pixel deltas per second → dozens of reports). Deltas now accumulate
      into whole lines using the pane's real cell height with the remainder
      carried (the same conversion xterm applies natively), direction flips
      reset the remainder, and deltaMode line/page units are normalized.
      Verified: 120px across 30 trackpad events → 6 reports, equal to one
      120px mouse notch.

## Iteration 53 — "my chat became a regular terminal": diagnosed + chat sessions

Process-tree + state.json forensics: the affected panes were `shell: true`
records — Terminal panes with `claude` typed in by hand and then renamed.
When that claude exits (typically the CLI's update prompt), a real claude pane
goes red with Resume, but a shell-hosted one just drops to the zsh prompt; on
app restart the record faithfully restores a plain shell. Those panes also
miss every claude-pane protection (mouse stripping, selection fixes) —
confirmed by mouse-protocol reports in the audit log for one of them.

- [x] Repo-less Claude chats are now first-class: New Session with no repo
      selected starts a plain chat (button reads "Start chat", with a note) —
      tracked, resumable, restartable like any session.
- [x] Repo-less non-debrief sessions run in $HOME instead of the WorkTracker
      folder — home is also where claude keeps conversations started from bare
      terminals, so --continue/--resume can reach the previously lost chats.
      Debrief assistants stay in WorkTracker (their instructions live there).

## Iteration 54 — Group and Workspace as real selectors in New Session

- [x] The single Group text field (with its `group/workspace` path syntax) is
      replaced by two explicit controls: **Group** — auto (ticket #) / none,
      any existing group, or "new group…" with a name input — and
      **Workspace** — none (its own pane), the chosen group's existing
      workspaces, or "new workspace…". The workspace select stays disabled
      until a group is picked; changing group resets it. "Workspace" is now
      the user-facing name for what the path syntax called a sub-group.
- [x] The + buttons still seed the modal: an existing workspace preselects it,
      a not-yet-created name lands pre-filled under "new workspace…".
- [x] Verified in the harness: selects populated from live groups
      (none/5038/5101 + backend under 5038), and creating with a new workspace
      name produced `taskGroup: "5038/etl work"` in the create payload.

## Iteration 55 — white diff panel + iTerm-grade selection persistence

- [x] **White box = Claude's /diff panel in light theme.** The CLI picks
      light/dark by querying the terminal background at startup; the reply
      throttle from the /clear fix (4 answers per 3s, none while hidden) could
      eat that answer, so claude guessed light. The gate is now shaped like the
      actual loop signature: answers always flow (hidden panes included); only
      the SAME answer repeating more than 8× within 5s is suppressed,
      self-recovering each window. Verified: the OSC-11 background answer is
      forwarded again.
- [x] **The real selection-killer, final layer:** xterm subscribes
      clearSelection to coreService.onUserInput — which fires for its own
      automatic query answers, and the claude TUI queries constantly. In claude
      panes clearSelection is gated on real user input in the last 400ms:
      auto-replies can't nuke a highlight; typing and clicking still clear.
      Verified: selection survives 20 rounds of redraw+CPR+colour queries
      byte-identical; a click-attributed clear still clears.
- [x] Mis-themed sessions re-detect on their next claude start —
      Settings → Restart all Claude sessions.

## Iteration 56 — pick model and effort when starting a session

- [x] New Session (Claude launch) gains **Model** (default / Opus / Sonnet /
      Haiku / custom model id…) and **Effort** (default / low / medium / high /
      xhigh / max) selects, passed to the CLI as `--model` / `--effort`.
      "default" sends no flag, so claude's own configuration applies. The last
      choice is remembered across sessions.
- [x] Both values persist on the session record and ride through relaunch, so
      a restored or restarted session comes back on the same model and effort.
      Panes at full density show a `model · effort` chip next to the branch.
- [x] Verified in the harness: picking Opus + xhigh produced
      `model: "opus", effort: "xhigh"` in the create payload and both were
      remembered for the next open.

## Iteration 57 — the Resume loop, and dead panes that hide the error

- [x] **Resume loop**: relaunch always passed `--continue`, which exits at once
      when the cwd has no conversation yet. A session that died at startup
      therefore could never be resumed — every Resume re-died. relaunch now
      checks `~/.claude/projects/<cwd>` for a transcript and launches fresh
      (same repo/branch/model/effort) when there is nothing to continue.
- [x] **Dead panes show why**: the pane records the process exit code and
      renders the last dozen lines it wrote (ANSI-stripped) above the Resume /
      Close buttons — the red message that used to flash and vanish is now
      legible. Verified in the harness with a fixture that exited code 1.
- [ ] The original startup failure for #4859 is still unidentified (no hook
      ever fired from that worktree; `--model opus --effort xhigh` launches
      fine in a raw pty). The exit tail will name it next time.

## Iteration 58 — hide the CLI's diff panel

The white box in wide claude panes is Claude Code's own /diff side panel
(fullscreen TUI, auto-opens when the terminal is wide). Its × never worked in
Mockingbird because claude panes are deliberately denied the mouse protocol.

- [x] Header gains ⊟ "hide diff" while a panel is showing. It locates the
      panel's literal "×" glyph in the screen buffer and delivers a mouse
      press/release at that cell — the CLI's own close, never a keystroke into
      the prompt (typing /diff would submit any drafted text along with it).
- [x] Clicking the × glyph directly works the same way.
- [x] Presentation: the panel now renders dark — the light look was the theme
      misdetection fixed in iteration 55; sessions started before that build
      stay light until restarted. The panel's content is CLI-drawn text and
      cannot be restyled beyond that.
- [x] Verified in the harness: button appears with a panel present; click →
      `ESC[<0;69;1M ESC[<0;69;1m` at the ×'s cell.

## Iteration 59 — hide-diff button missing on long-lived sessions

- [x] The button gated on having seen the CLI's mouse-tracking request in the
      pane's history; a session running for hours has scrolled that startup
      sequence out of the 400KB replay, so wantsMouse stayed false and neither
      the button nor wheel-scroll worked. Claude panes now start from
      "wants the mouse" and only an explicit disable turns it off.
- [x] Panel detection no longer requires a drawn border: the panel is a
      background-filled box whose top row is spaces ending in the close glyph.
      A ×-family glyph as the last character of a top-right row is enough; a
      plain "x" additionally needs a box-drawing border on that row. Scan
      widened to six rows.
- [x] Verified in the harness: borderless panel, no enable sequence in history
      → button shown, click delivered at the × cell.
- Note: the panel still renders white in sessions started before the theme fix
  — claude reads the terminal background once, at its own startup. Restart the
  session (Settings → Restart all) to get the dark panel.

## Iteration 60 — New Session modal flickering

- [x] Both full-screen overlays (`.modal-back`, the popover backdrop) used
      `backdrop-filter: blur()`. Chromium re-filters the backdrop on every
      repaint beneath it, and beneath the modal sit live terminals repainting
      continuously — on some GPU paths that thrashes into on/off flashing that
      reads as the modal opening and closing. Not reproducible in the harness
      (key auto-repeat + output storm left the modal mounted, zero remounts),
      so this is the probable cause rather than a proven one. Blur removed;
      dim kept.
