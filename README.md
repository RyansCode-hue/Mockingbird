# 🪶 Mockingbird

Grid manager for parallel Claude CLI sessions — git worktrees, live status, broadcast, and WorkTracker/Azure DevOps integration.

## Setup (first time)

```bash
cd ~/Code/Mockingbird
npm install
npm start
```

Note: `npm install` compiles node-pty natively and needs Xcode Command Line Tools (`xcode-select --install` if you don't have them). If a `node_modules` folder exists from another machine, delete it first: `rm -rf node_modules package-lock.json`.

Then in the app, click **install now** in the sidebar to add the status hooks to `~/.claude/settings.json` (they coexist with your existing WorkTracker SessionEnd hook).

To build a real .app for your Dock: `npm run package` → `dist/mac-arm64/Mockingbird.app` (also emits a DMG + zip in `dist/`). Copy it to /Applications and launch from the Dock — it runs independently of any terminal (add it to Login Items if you want it always up). Native deps use node-pty's prebuilt binaries (`npmRebuild: false`), so packaging doesn't need a working C++ toolchain.

**Updates:** dev runs pick up renderer changes with `npm run build` + ⌘R (main-process changes need a restart). The packaged app checks GitHub for new releases (on launch and every 6h) once `package.json` has a `"repository": "github:<owner>/<repo>"` field — a newer release triggers a native notification and a teal "⭮ vX.Y available" link in the status bar (Settings → Check for updates works manually too). To ship an update: bump `version`, `npm run package`, create a GitHub release tagged `vX.Y.Z` with the DMG/zip attached. True silent auto-update would additionally need an Apple Developer ID signature + notarization.

## What it does (v1)

- **+ Session** — fuzzy-pick a repo from `~/Code` / `~/Personal Projects`, then either **pick one of your ADO tickets from the dropdown** (auto-fills ticket #, name, and offers to send the ticket title + description to Claude as its first prompt) or enter a ticket manually (# and name → branch `5038-filterOrgsByFoundation`). New branches are cut from a freshly fetched `origin/dev`-style base (changeable). Mockingbird creates the git worktree and launches `claude` in it; multiple sessions per ticket group together in the sidebar.
- **Tabs** — the top bar is always visible with four tabs: **Sessions** (the grid), **Dashboard** (the ADO board), **WorkTracker** (debriefs), and **Settings** (app config with native folder pickers, a light/dark theme switch, plus the CLAUDE.md editor and Broadcast panel). New session is always one click away.
- **WorkTracker tab** — the morning brief and 4pm wrap-up run here as their own panes, not in the coding grid (the tab shows an amber dot when a debrief is waiting on you). The wrap-up reads `session-digests/<date>.md`, written at kick-off from every live session's metadata and ANSI-stripped terminal tail — a passive snapshot from memory, so no session is messaged or interrupted. Both debriefs also get `session-digests/ado-snapshot-<date>.md` — your open work items' live states, descriptions, and recent comments pulled at kickoff via the app's own PAT — so ticket truth doesn't depend on Claude Code having an ADO connector (PR review votes still do). Debrief panes are ephemeral and don't survive restarts.
- **Grid** — click sessions in the sidebar to show/hide them in the grid. The grid grows with the number of open sessions — no filler tiles. **Resize a pane like a window from its own edges**: right edge for width, bottom edge for height, corner grip for both — neighboring panes absorb the change so everything stays grid-aligned (double-click a handle to even out; sizes persist). ⛶ fullscreens a pane (⌘E / esc); – hides a pane (session keeps running). **The grid shows one group at a time**: click a group header to switch to that group (collapsing the others — ▸ toggles one individually, with a short slide on the swap), toggle rows within the group to hide/show individual panes, and clicking a session from another group switches the grid over to it. **Each group remembers which of its sessions were visible** — switching back restores that subset; click the active group's header again to re-show all of it.
- **Status dots** — teal=working, amber=needs your input, grey=idle, red=dead. Driven by Claude Code hooks (Stop / Notification / UserPromptSubmit / PreToolUse — the last one flips an approved permission back to *working* the moment the tool starts, instead of staying amber until the turn ends), with native notifications when a session finishes or needs you.
- **CLAUDE.md** — edit the global or any active repo's CLAUDE.md in-app; on save, every live session is told to re-read it. Busy sessions get the message when they finish their current task, so nothing is interrupted.
- **Broadcast** — send any instruction to all/selected sessions once, instead of repeating yourself.
- **Debriefs** — "Morning brief" / "4pm wrap-up" buttons (or auto-schedule in Settings) spawn an Assistant session in your WorkTracker folder that follows `instructions/morning.md` / `wrap-up.md`. Answer its interview questions right in the pane.
- **Previous sessions** — after an app restart, ↺ relaunches a session in its old worktree with `claude --continue`, resuming the conversation. **↺ restore all** relaunches everything; relaunched sessions keep their id, so they return to their old grid slot and group. Renderer-only changes don't even need that — rebuild and hit `⌘R` (View → Reload) and the sessions keep running.
- **Groups & sub-groups** — sessions sharing a ticket # group automatically; click a header to focus the whole group in the grid. Name a group `5038/backend` (or set a sub-group in the ⤷ dialog) for cmux-style workspaces: sub-groups appear indented in the sidebar and as **tabs in the group bar above the grid** — click a tab to show just that slice, All to show the group. The group bar always names the active group and how many of its sessions are visible. To manage them: drag a sidebar row onto another group's header, click a row's ⤷ (or ⌘K → "Change group…") for a move/create/remove dialog, or set the Group field in New Session (suggests existing groups, defaults to the ticket #). Double-click a group header to rename it.
- **Command palette & keyboard layer** — `⌘K` opens a palette with every action plus jump-to-session (waiting sessions show their reason and wait time). `⌘N` new session · `⌘1–9` jump to pane · `⌥⇥` next waiting session (oldest first) · `⌘E` fullscreen pane (esc restores) · `⌘⌃1–4` column count · `⌘⇧B` broadcast · `⌘/` how-to-use popup (also auto-opens on first launch).
- **Dashboard (board)** — an ADO-style kanban read via the WorkTracker folder's `config.json` + PAT file. A filter bar scopes the board: an **"Assigned to" multi-select** (defaults to you — the PAT's owner — check any mix of people, "Unassigned" included, or Everyone; the whole project loads, capped honestly at the 200 most recent) and **column show/hide toggles**. Both persist. Columns are the real ADO states — **drag a card to another column to change its state** (optimistic, reverts on API error). Clicking a card opens a **centered work-item dialog like ADO's**: title/description/discussion (read + **post comments**) in the main column, state and session actions in the sidebar — start a worktree session from the ticket (auto-grouped under its id) or attach an existing one. Starting a session offers **New branch** (fetches the freshest `origin/dev`-style base — auto-detected per repo, changeable — and branches off it) or **Existing branch** (local or origin), and by default **sends the ticket title + description to the Claude session as its first prompt** so it starts working with full context. Cards carry ADO's type colors and show live session dots plus the assignee when viewing Everyone. The PAT never leaves the Electron main process.
- **Pane density tiers** — pane chrome follows the column count: 4 cols shows dot + name only, 3 cols adds branch + elapsed, 1–2 cols adds a context rail (elapsed · git ahead/behind/dirty · repo · queued broadcasts).
- **Close-session safety** — closing a session whose worktree is dirty or unpushed opens a dialog: keep worktree (default), commit WIP + push + remove, or discard (never the default). Clean worktrees close silently.
- **Control room** — Broadcast and CLAUDE.md share one panel: edit + "Save & re-read in N", compose a broadcast, and watch per-session delivery states (`delivered · queued busy · skipped dead`).
- **Menu bar + Dock** — the 🪶 tray item counts sessions *blocked on you* (never working ones), lists them oldest-wait-first, and clicking one focuses that pane. The Dock badge shows the same waiting count, and the Dock/app icon is the feather on the design's dark tile (regenerate with `npm run icon` → `build/icon.png` + `build/icon.icns`; dev runs set it at launch, packaged builds embed it).

## Design system

The UI follows `design_handoff_mockingbird` (see the zip in this folder): warm dark
palette, Helvetica Neue for anything you click, JetBrains Mono (falls back to
SF Mono) for anything the machine produced, and one hard rule — **amber
`#e0a34a` means "a session needs you" and nothing else**. Status is always a
dot: teal working · amber waiting (pulsing) · grey idle · red dead. Not yet
implemented from the handoff: cross-session transcript search (1f), the
draft-comment queue from the ADO design (1d ships as the Dashboard without
`pending-comments.md`), and token/cost + PR instrumentation in the pane rail.

## Debrief prerequisites

Azure DevOps needs no setup: debriefs get a live ticket snapshot written by the app's own PAT client at kickoff, and the PAT is auto-injected into debrief sessions as `AZURE_DEVOPS_EXT_PAT` so `az boards` / `az repos` work without `az login` (if the Azure CLI is installed). Settings → **Connectors** shows the status of all three paths. An ADO MCP server remains optional (richer PR data — review votes aren't in the snapshot or covered by the injected PAT queries the instructions use):

```bash
claude mcp add azure-devops -- npx -y @azure-devops/mcp <org>
claude mcp add outlook ...   # Outlook/Slack still come from Claude Code's own MCP config
claude mcp add slack ...
```

Without those, the Assistant does what it can and tells you what it couldn't reach.

## Roadmap

- v2: ADO ticket sidebar (reads WorkTracker `config.json` + PAT), start-session-from-ticket, draft comments → `pending-comments.md`
- v3: quick notes → weekly log, dashboard tab, richer session summaries for the wrap-up
