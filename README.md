# 🪶 Mockingbird

Run Claude Code and OpenAI Codex sessions side by side, one per branch or ticket — git worktrees, live status, a file explorer with diffs, agents that can message each other, and Azure DevOps integration.

## Setup (first time)

**New machine? Follow [SETUP.md](SETUP.md).** It covers installing a build you
were sent *or* building from source, the first-run wizard, your own Azure DevOps
PAT, and the optional Codex setup. Short version from source:

```bash
npm install
npm start            # dev run
npm run package      # → release/mac-arm64/Mockingbird.app → copy to /Applications (package under Node 22)
```

The first launch opens a setup wizard that checks your agents, installs the
status hooks, and sets your repo folders. Native deps use node-pty's prebuilt
binaries (`npmRebuild: false`), so packaging doesn't need a working C++
toolchain.

**Updates:** Settings → Agents → **Update** (next to Claude Code or Codex) runs that CLI's own updater — needed when a new model (e.g. a new Opus) says the CLI must update — then **Restart all sessions** moves every pane onto the new build without losing conversations. For Mockingbird itself: dev runs pick up renderer changes with `npm run build` + ⌘R (main-process changes need a restart). The packaged app checks GitHub (on launch and every 6h; Settings → About → Check for updates any time) against the latest release, or — with none published — the `version` on `main`. The repository is private, so the check signs in with the GitHub CLI (`gh auth login` once). A newer version shows a teal "⭮ vX.Y available" link in the status bar; **Update** pulls and builds it in your clone of the repo (found under your repo folders, or chosen under Settings → About) while you keep working — it stops if the clone has uncommitted changes, isn't on `main`, can't fast-forward, or lacks Node 22. When the build is ready, **Restart to update** quits, swaps the app in /Applications (putting the old one back if anything fails), reopens it, and brings back the sessions that were open; the status bar says how it went (log: `~/.mockingbird/update.log`). To ship an update: bump `version` on `main` (and optionally publish a GitHub release). True silent auto-update would additionally need an Apple Developer ID signature + notarization.

## What it does (v1)

- **+ Session** — fuzzy-pick a repo from your repo roots (set in the setup wizard; `~/Code` and `~/Personal Projects` by default), choose **Claude**, **Codex**, or a plain **Terminal**, then either **pick one of your ADO tickets from the dropdown** (auto-fills ticket #, name, and offers to send the ticket title + description to the agent as its first prompt) or enter a ticket manually (# and name → branch `5038-filterOrgsByFoundation`). New branches are cut from a freshly fetched `origin/dev`-style base (changeable). Ticket sessions get an isolated worktree in one tidy place — `worktrees/<repo>/<branch>` beside your repos — and the agent launches there; untick **isolated worktree** to check the branch out in the repo itself instead (the choice is remembered); multiple sessions per ticket group together in the sidebar.
- **Claude or Codex** — every session runs one of two coding agents: Claude Code, or OpenAI's **Codex CLI** (`npm i -g @openai/codex`, then `codex login` with your ChatGPT subscription — no API key). Pick it in New Session (with its own model / reasoning-effort choices, remembered per agent); Codex panes carry a `codex` chip. Status dots, broadcasts, ticket kickoff prompts, restore-after-restart (`codex resume --last`), the Files explorer and the close-session dialog all work the same for both. Settings → install hooks writes Codex's hooks to `~/.codex/hooks.json` alongside Claude's; **Codex ignores new hooks until you approve them once — type `/hooks` in any Codex session** (and answer its one-time "trust this directory?" prompt per worktree). Codex has no `Notification` event, so its `PermissionRequest` is what turns a pane amber. Plan usage in the status bar is Claude-only for now — Codex doesn't expose its rate limits.
- **Agents talk to each other** — every Claude and Codex session gets a small Mockingbird MCP server with two tools: `list_sessions` (id, title, agent, repo, branch, group, status, and whether it shares your ticket group) and `send_message(to, message)`. Ask a session to "tell the backoffice session about the API change" and the message is typed into that pane's prompt, labelled with who sent it and that it came from an agent, not you; the receiver replies the same way. Delivery is immediate when the target is idle, waits for the end of its turn when it's busy or blocked on a permission prompt, and, if you've typed something in that pane you haven't sent yet, waits for you to send it — it's never appended to your draft or submitted with it (a draft left untouched for 2 minutes gets the message placed after it without Enter). Guardrails: at most 8 messages between any two sessions per 5 minutes (the 9th is refused and you get a notification), 8k characters per message, shells and debriefs can't be messaged, and the relay socket (`~/.mockingbird/mb.sock`) is owner-only. Settings → **Agent-to-agent messages** switches auto-send off, so incoming messages sit in the prompt until you press Enter. The server runs on the app's own binary (`ELECTRON_RUN_AS_NODE`), so it needs no Node install, and it's passed per-session (`--mcp-config` / `-c mcp_servers…`), so your own CLI configs aren't touched. Sessions started before this build need a restart to get the tools.
- **Collaborate** — a tab of rooms where models discuss an idea or feature with you: **GPT-6 Astra**, **Claude Opus 5.5** and **Claude Fable 5.1** by default, or any Claude or Codex model id ("Other model…"). They run through the CLIs and plans you already have (`codex exec` / `claude -p`, no API keys), each keeping its own conversation, and take turns round-robin: on its turn a model sees what the others (and you) said since it last spoke, labelled by speaker, and ends with a stance — *agrees* or *continue*. **Layout:** the room list collapses to a rail of initials (a dot marks one that's running or waiting on you); the discussion reads as a **Thread** (a divider per round, long messages folded) or, with the **Rounds** toggle, a grid — a column per model, a row per round, each cell its stance and first line, opening in place; the panel on the right holds the models and what each may do, the repository, the test copy, always-allowed calls and the plan (it floats over the discussion in narrow windows, and hides with ▥). **Models** (in a room, or when creating one) sets each seat: which model, its **effort** (Claude: low → max; Codex: minimal → xhigh), the speaking order, whether it **reads the code**, whether it **runs commands**, and whether it **uses Docker**. Add or remove models any time — a newcomer reads the whole discussion on its first turn; a model that leaves keeps its past messages; effort and code access apply from the next turn without losing the conversation. **Code readers and questions:** give a room a repo and choose who may read it. Models that can't get an **ask_code_reader** tool: mid-turn they ask, the first reader in speaking order looks it up in the repo (in its own lookup thread, so it builds up knowledge of the codebase without cluttering the discussion), and the answer comes straight back — the exchange is shown in the transcript for everyone (a few questions per turn). **Running commands:** a model allowed to run commands can run tests, builds and scripts during the discussion — in a disposable **test copy** of the repo (a git clone of HEAD plus your uncommitted and untracked files, without ignored ones like `node_modules`, under `~/.mockingbird/collab/work/`), never your checkout. It's made on first need, kept between turns (so installs survive), and thrown away by **Reset test copy**, a repo change, or deleting the room. These turns run in the CLI's OS sandbox — Claude's Bash sandbox, Codex's workspace-write — which allows writes only inside the copy and lets them use the network (package installs, local services), with no Docker unless you tick **uses Docker** for that model. A Docker model can start, stop and run containers (Claude's sandbox opens the Docker socket; Codex gets a permission profile allowing it) — but the daemon works outside the sandbox and a container can mount any folder, so for that model the "only the test copy" guarantee rests on its instructions, not the sandbox. A Docker model's `docker` commands are pre-approved. They can write files there too (test scripts, probes); they're told to check facts and test ideas, not implement. **Approvals in the room:** when a Claude model wants something its permissions don't cover — a command Claude's safety check holds, a file outside its folder, a web fetch — the room shows a card with the exact call: **Allow**, **Deny**, or **Always allow** that kind in this room (one CLI and subcommand, one folder, or one site; never chained commands or writes). Its turn waits; you get a notification; no answer in 10 minutes, or Stop, counts as no. Always-allowed kinds are listed under **Models**, where ✕ takes one back. (Codex has no such hook — its sandbox decides on its own.) **Pacing** switches like Claude's Shift+Tab (Shift+Tab in the message box cycles it): **Step**, **Auto** (a set number of rounds), **Until agreed** (stops when every model agrees, with a cap). Type at any point and your message reaches each model on its next turn; **Stop** ends the current turn. **Nothing is edited until you approve:** discussion turns can't touch your code — Claude without edit tools or a shell (unless it runs commands, and then only in the test copy), Codex in its read-only sandbox (or confined to the test copy) — and run with no MCP servers, apps or plugins (their tools can act outside the repo), except the room's own ask tool. **Approve** one model's message, or **Write up plan** with a model of your choice and approve that; then **Implement with…** starts a normal session (with that seat's model and effort) on a new `collab-…` branch in its own worktree, with the approved plan as its first prompt. Rooms are saved in `~/.mockingbird/collab/`; every turn and lookup counts against your Claude and ChatGPT plan limits.
- **Tabs** — the top bar is always visible with five tabs: **Sessions** (the grid), **Dashboard** (the ADO board), **WorkTracker** (debriefs), **Collaborate** (multi-model rooms), and **Settings**. Settings has a category sidebar — **General** (theme, notifications, setup wizard), **Agents** (Claude Code and Codex versions with Update, Restart all sessions, status hooks, agent-message auto-send, binary paths), **Repos** (repo folders and the worktree janitor), **Azure DevOps** (connection, WorkTracker folder), **Debriefs** (auto-run, Azure CLI, MCP servers), **Control room** (Broadcast and the CLAUDE.md editor, also ⌘⇧B), and **About** (version, check for updates). Every setting is a row with its current state, and changes save as you make them. New session is always one click away.
- **Setup wizard** — first launch walks through agents (is `claude` / `codex` installed and signed in), status hooks, repo roots, and Azure DevOps, each step checking the machine's real state; reopen it from ⌘K → Setup or Settings → General → **Run setup**.
- **WorkTracker tab** — the morning brief and 4pm wrap-up run here as their own panes, not in the coding grid (the tab shows an amber dot when a debrief is waiting on you). The wrap-up reads `session-digests/<date>.md`, written at kick-off from every live session's metadata and ANSI-stripped terminal tail — a passive snapshot from memory, so no session is messaged or interrupted. Both debriefs also get `session-digests/ado-snapshot-<date>.md` — your open work items' live states, descriptions, and recent comments pulled at kickoff via the app's own PAT — so ticket truth doesn't depend on Claude Code having an ADO connector (PR review votes still do). Debrief panes are ephemeral and don't survive restarts.
- **Grid** — click sessions in the sidebar to show/hide them in the grid. The grid grows with the number of open sessions — no filler tiles. **Resize a pane like a window from its own edges**: right edge for width, bottom edge for height, corner grip for both — neighboring panes absorb the change so everything stays grid-aligned (double-click a handle to even out; sizes persist). ⛶ fullscreens a pane (⌘E / esc); – hides a pane (session keeps running). **The grid shows one group at a time**: click a group header to switch to it, toggle rows to hide/show individual panes, and clicking a session from another group switches the grid over to it. **Each group remembers which of its sessions were visible** — switching back restores that subset; click the active group's header again to re-show all of it. **▦ Layout** offers snap-layout templates per group.
- **Status dots** — teal=working, amber=needs your input, grey=idle, red=dead. Driven by hooks both agents call: Claude Code's Stop / Notification / UserPromptSubmit / PreToolUse, and Codex's Stop / PermissionRequest / UserPromptSubmit / PreToolUse / PostToolUse (Codex has no Notification event — PermissionRequest is its amber). An approved permission flips back to *working* the moment the tool starts. Native notifications fire when a session finishes or needs you.
- **Plan usage** — the status bar shows plan usage for Claude, Codex, or both (`Claude 5h 2% wk 17%  Codex 5h 1% wk 1%`; red at 90%). Click it for a panel like claude.ai's: each agent's plan, every limit as a bar with its percentage and reset time ("Resets in 4 hr 18 min", "Resets Sun 2:00 PM"), and a **Show: Claude · Codex · Both** switch. Claude's numbers come from a Mockingbird statusline passed with `--settings` (after a session's first response; model-specific weekly limits appear when your plan has them), and its plan name from `claude auth status`. Codex's come from the rate-limit events in its own session logs — undocumented, so if Codex changes that format the Codex half just shows nothing. A window whose reset time has passed shows 0% until the next report. Sessions skip the Claude reporter if you have your own `statusLine` in `~/.claude/settings.json`, and API-key logins have no plan limits to show.
- **VS Code-style workbench** — on the Sessions tab, an activity bar on the far left switches the side bar between **Sessions**, **Explorer** (`⌘⇧E`), **Source Control** (`⌃⇧G`, with a count of uncommitted files) and **Search** (`⌘⇧F`); clicking the lit icon or `⌘B` hides the side bar, and its right edge resizes it. Explorer and Source Control follow the focused session: click into a pathlight pane and you see that worktree, click a backoffice pane and you see that one (each tree remembers its expanded folders). Files and diffs open in an **editor** column beside the side bar, as tabs: every file you click gets its own tab (up to 24; the oldest closes past that); staged and working-tree diffs of a file are separate tabs. Code is syntax-highlighted, diffs show inline or side by side, and **@** types `@path` into the focused session's prompt. Files are editable like in an IDE — undo, find and replace (⌘F), multiple cursors, bracket matching, folding, indentation that follows the file — and ⌘S saves. An unsaved file shows a dot on its tab; closing it, **Close all** (tab bar or Open editors) and quitting ask first. If an agent changes a file you're editing, you choose whose version to keep; saving never overwrites a change made since you opened the file without asking, and keeps the file's line endings and byte-order mark. Hover any editor button for what it does (@ types `@path` into the focused session's prompt; ⧉ copies the path). **`⌘P`** opens any file in the focused session's folder by typing part of its name (`name:42` jumps to line 42). The Explorer opens with what changed since the last commit (files, +lines −lines, and a bar), then **Open editors**, then the tree — file-type badges, folder icons and indent guides, changed files colored (blue modified · green added/untracked · red deleted) and the folders holding them dotted. Source Control works like VS Code's: the branch with ↑ahead ↓behind its upstream, **Fetch**, **Pull** (fast-forward only — never a merge commit or a rewrite; if both sides moved it says so and changes nothing) and **Push**. If a git action fails (fetch, pull, push, commit…), its error shows in Source Control with **Ask the session to fix**, which types the error into that worktree's chat for the agent. A branch Mockingbird makes from `origin/dev` tracks `origin/dev` until its first push — so ↓ counts dev's new commits and Pull brings them in — and **Publish branch** always pushes it under its own name, never into dev. Then a commit box (⌘↵) whose ✦ button writes the message from the staged change (or everything, when nothing is staged) with the session's own agent, then **Staged changes** (the next commit) and **Changes** (edits not staged yet) with stage (+), unstage (−) and discard (↺ — asks first; new files go to the Trash) per file or all at once. **Branch vs origin/dev** (collapsed) lists everything the branch changed since it split off its `dev`/`main`-style base, commits included: what a pull request would contain. **Graph** draws the commit history of the branch, what it tracks and its base — merges and forks as lanes, branch and tag labels — and a commit opens to its files, each opening that commit's diff. A pane's git line (↑ commits to push · ↓ commits to pull · uncommitted files) opens Source Control. Live sessions' repository folders are watched, so the tree, change list, open files and each pane's change count ("3 files · +120 −8" in its header — click it for Source Control) refresh when a file changes, with a slow poll as the safety net. Files are addressed by session id + relative path, so the renderer can't read outside a live session's folder.
- **CLAUDE.md** — edit the global or any active repo's CLAUDE.md in-app; on save, every live session is told to re-read it. Busy sessions get the message when they finish their current task, so nothing is interrupted.
- **Broadcast** — send any instruction to all/selected sessions once, instead of repeating yourself.
- **Debriefs** — "Morning brief" / "4pm wrap-up" buttons (or auto-schedule in Settings) spawn an Assistant session in your WorkTracker folder that follows `instructions/morning.md` / `wrap-up.md`. Answer its interview questions right in the pane.
- **Run and Debug** (⌘⇧D) — runs the focused worktree's services (API, frontend, a Docker Compose stack) with live logs in a panel under the grid (⌘J), status, clickable ports, and start / stop / restart per service or all at once. A repo's run setup lives in Mockingbird (per main checkout, shared by its worktrees, nothing committed): **Draft with Claude** reads the repo's launch configs, scripts, compose files and README — read-only, never its env files — and proposes the services, the ports, what a worktree needs copied in, what blocks side-by-side runs (with the one-line fix, and an "Ask the session to fix" button) and the sign-in redirect URIs to register; you review and save it. **Swap** runs one copy of an app at a time on its standard ports (starting it in one worktree stops it in the other); **Side by side** gives each running worktree its own slot of ports (+10 per slot). A port held by something Mockingbird didn't start is reported, never killed without asking. Compose stacks get a per-worktree override, so a worktree runs its own code and side-by-side copies get their own containers and ports. **Prepare** copies a new worktree's gitignored env files and certs from the main checkout and installs what's missing. Stopping takes down the whole process group; quitting Mockingbird stops everything it started. **Debug** (the bug next to a service) runs it under a built-in debugger: click a line number in the editor to set a breakpoint (kept per repo, so they apply in every worktree), and when it stops the file opens at that line with the controls in Run and Debug — continue, pause, step over / into / out, stop — plus the call stack, variables (expandable), watch expressions, the breakpoint list, and a Debug Console under the grid that evaluates in the paused frame. The program still runs on its own terminal, so its log is where it always is. Python services (FastAPI under uvicorn, scripts, `python -m …`) debug through debugpy; `--reload` is off while debugging. A dev server for a browser app (Vite, Next…) debugs in its own Chrome window per worktree — breakpoints in your TypeScript, mapped through the source maps — and other Node programs (`node file`, npm scripts, children followed) debug under Node, both through js-debug. .NET services (`dotnet run --project …`, ASP.NET included) build on their terminal, then run under netcoredbg with their output in the same log; hot reload is off while debugging. A server that hosts a Blazor WebAssembly client also opens a debug Chrome window, where breakpoints in `.razor` and client `.cs` code work through the Blazor debug proxy. Python inside a Docker container is debugged by attaching: Mockingbird mounts debugpy into the container (`$MOCKINGBIRD_DEBUGPY`) and publishes its port on loopback; the container's start command runs `python -m debugpy --listen 0.0.0.0:5678 …` when that's set (the draft lists the change). Debuggers are downloaded on first use and checked against their published SHA-256.
- **Token meters** — a pane's info row shows the tokens all its conversations have used and, while a 5-hour window is running, its estimated share of the limit ("1.2M · ≈18% of 5h"; hover for new input, output and cache). The status bar adds today's total, and the usage popover lists today per agent and the panes using the most of the current window. Plans only report how full a window is, not its size in tokens, so a pane's share is estimated: its usage in the window over everything this Mac's sessions used in it, weighted by model (Opus output fills a window much faster than cached Sonnet input), times the window's reported %. Use outside this Mac isn't in its transcripts, so shares can read high.
- **Search** — ⌘⇧F opens the Search view, over **Conversations** or **Files**. Conversations searches every Claude and Codex conversation on this Mac — open, closed, or never opened in Mockingbird — by what was said, the files it touched and the commands it ran. Each result opens where it lives: **go to pane**, **restore session** (a closed Mockingbird session), **open room** (a Collaborate model's), or **open as session** (resumes it in its folder). The index (`~/.mockingbird/transcripts.db`) stays on this Mac, is built in the background on first launch (a few seconds), and keeps up as transcripts grow; tool output isn't indexed. Files searches the text of every file in the focused session's folder (git grep: tracked files plus untracked ones `.gitignore` doesn't exclude), with match-case and regex toggles; a result opens the file at that line. A search stops at 2,000 matches or 20 seconds and says so.
- **Previous sessions** — after an app restart (an update, a reboot, a quit), ↺ relaunches a session in its old folder and resumes **the exact conversation that pane last ran** (`claude --resume <id>` / `codex resume <id>`), not just the folder's most recent one — which matters when several chats started in the same folder. **Terminal panes remember too:** if you ran `claude` or `codex` inside a terminal, it comes back with that conversation resumed, and quitting it leaves you at the terminal prompt. Mockingbird learns each pane's conversation from the status hooks (every pane exports `MOCKINGBIRD_SESSION`, so events are matched to the right pane even when an agent `cd`s elsewhere); `/clear` moves it to the new conversation. Starting Claude in your home folder, it asks whether to trust the folder first, as it always does there. **↺ restore all** relaunches everything; relaunched sessions keep their id, so they return to their old grid slot and group. Renderer-only changes don't even need that — rebuild and hit `⌘R` (View → Reload) and the sessions keep running.
- **Groups and workspaces** — sessions sharing a ticket # group automatically. The sidebar is an outline: each **group** is a plain header, and inside it each **workspace** is a folder row with up to three status dots (waiting first, then `+N`) — the folder is open while that workspace is in the grid, and its sessions fold away otherwise (the chevron opens or closes them by hand). Session rows show the name and, underneath, the branch (and `codex` for Codex panes). Name a group `5038/backend` (or set a workspace in the ⤷ dialog) to put sessions in a workspace: it shows in the grid as **one pane with a tab per session**. Each tab's **×** hides just that session from the grid (it keeps running); the pane goes when its last tab does, and clicking the workspace's folder brings them all back. To manage: drag a sidebar row onto another group or workspace, drop one loose session onto another to make a workspace of the two, click a row's ⤷ (or ⌘K → "Change group…") for a move/create/remove dialog, or set the Group field in New Session. Double-click a group or workspace to rename it; a workspace's ✕ dissolves it (its sessions move up into the group).
- **Command palette & keyboard layer** — `⌘K` opens a palette with every action plus jump-to-session (waiting sessions show their reason and wait time). `⌘N` new session · `⌘1–9` jump to pane · `⌥⇥` next waiting session (oldest first) · `⌘E` fullscreen pane (esc restores) · `⌘⌃1–4` column count · `⌘⇧B` broadcast · `⌘/` how-to-use popup (also auto-opens on first launch).
- **Dashboard (board)** — an ADO-style kanban read via the WorkTracker folder's `config.json` + PAT file. A filter bar scopes the board: an **"Assigned to" multi-select** (defaults to you — the PAT's owner — check any mix of people, "Unassigned" included, or Everyone; the whole project loads, capped honestly at the 200 most recent) and **column show/hide toggles**. Both persist. Columns are the real ADO states — **drag a card to another column to change its state** (optimistic, reverts on API error). Clicking a card opens a **centered work-item dialog like ADO's**: title/description/discussion (read + **post comments**) in the main column, state and session actions in the sidebar — start a worktree session from the ticket (auto-grouped under its id) or attach an existing one. Starting a session offers **New branch** (fetches the freshest `origin/dev`-style base — auto-detected per repo, changeable — and branches off it) or **Existing branch** (local or origin), and by default **sends the ticket title + description to the Claude session as its first prompt** so it starts working with full context. Cards carry ADO's type colors and show live session dots plus the assignee when viewing Everyone. The PAT never leaves the Electron main process.
- **Selecting and copying** — releasing a selection copies it (a "Copied" toast confirms). For more than a screen: click where it starts, scroll with the wheel, and shift-click where it ends; or drag past a pane's top or bottom edge and it scrolls as you select. The wheel scrolls a pane's own history; it's only handed to the CLI when the CLI turns on mouse tracking.
- **Pane density tiers** — pane chrome follows the column count: 4 cols shows dot + name only, 3 cols adds branch + elapsed, 1–2 cols adds a context rail (elapsed · git ahead/behind/dirty · repo · queued broadcasts).
- **Close-session safety** — closing a session whose worktree is dirty or unpushed opens a dialog: keep worktree (default), commit WIP + push + remove, or discard (never the default). Clean worktrees close silently.
- **Worktree janitor** — Settings → Repos → **Worktrees** lists every isolated checkout with its branch, dirty/ahead/behind state and age. Tick any that aren't in use (or "all not in use") and remove them in one go; a single confirmation lists every one that would lose uncommitted files or unpushed commits, and each failure is reported and stays ticked for a retry. Old `<repo>-worktrees/` folders can be moved into the new layout.
- **Control room** — Broadcast and CLAUDE.md share one panel: edit + "Save & re-read in N", compose a broadcast, and watch per-session delivery states (`delivered · queued busy · skipped dead`).
- **Menu bar + Dock** — the 🪶 tray item counts sessions *blocked on you* (never working ones), lists them oldest-wait-first, and clicking one focuses that pane. The Dock badge shows the same waiting count, and the Dock/app icon is the feather on the design's dark tile (regenerate with `npm run icon` → `build/icon.png` + `build/icon.icns`; dev runs set it at launch, packaged builds embed it).

## Tests

```bash
npm test             # Vitest, ~3s; also runs on every push (GitHub Actions, macOS)
npm run test:watch
```

Tests run the main-process code in plain Node (Electron is stubbed) against real
git repos and real files in a throwaway home directory per test file, so they
never touch your `~/.mockingbird`, `~/.claude` or `~/.codex`. They cover the file
explorer and its folder boundary, worktrees, both agents' launch and resume
logic, plan usage parsing, hook install and status routing, agent messaging (the
socket relay and the MCP server itself), message delivery timing, the shell
helpers, the setup checks, and the renderer's diff and usage formatting.

## Design system

The UI follows `design_handoff_mockingbird` (see the zip in this folder): warm dark
palette, Helvetica Neue for anything you click, JetBrains Mono (falls back to
SF Mono) for anything the machine produced, and one hard rule — **amber
`#e0a34a` means "a session needs you" and nothing else**. Status is always a
dot: teal working · amber waiting (pulsing) · grey idle · red dead. Not yet
implemented from the handoff: cross-session transcript search (1f), the
draft-comment queue from the ADO design (1d ships as the Dashboard without
`pending-comments.md`), and per-pane token/cost + PR instrumentation in the rail
(plan-level Claude usage is in the status bar).

## Debrief prerequisites

Azure DevOps needs no setup: debriefs get a live ticket snapshot written by the app's own PAT client at kickoff, and the PAT is auto-injected into debrief sessions as `AZURE_DEVOPS_EXT_PAT` so `az boards` / `az repos` work without `az login` (if the Azure CLI is installed). Settings → **Connectors** shows the status of all three paths. An ADO MCP server remains optional (richer PR data — review votes aren't in the snapshot or covered by the injected PAT queries the instructions use):

```bash
claude mcp add azure-devops -- npx -y @azure-devops/mcp <org>
claude mcp add outlook ...   # Outlook/Slack still come from Claude Code's own MCP config
claude mcp add slack ...
```

Without those, the Assistant does what it can and tells you what it couldn't reach.

## Roadmap

Ordered by intent: **Now** is being designed or actively hurts, **Next** is
agreed direction, **Later** is worth doing once the foundations settle.

### Shipped recently

- **Collaborate rooms** — models discuss an idea with you; per-model effort
  and access (none · read · run · docker), a disposable test copy, approvals
  in the room (with a Dock count, tab badge and reminder), plans you approve
  before anything is implemented; edited from the room's sidebar.
- **In-app updates** — Check for updates against the private repo (via the
  GitHub CLI), then Update pulls and builds in your clone and restarts into it,
  bringing your sessions back.
- **Dashboard = your real ADO board** — columns, order and state mapping
  read from your team's Azure Boards board (pick among its boards); cards sit
  in the column ADO recorded, and dropping one sets that column (and its
  state). A Columns list reorders and hides columns per board.
- **Drag and drop shows where things land** — an outline or a line on the
  side, a label saying what the drop will do, and edge scrolling; for
  sessions, panes, board columns and cards, and Collaborate models.
- **Search every conversation (⌘⇧F)** — a local index of every Claude and
  Codex transcript on the Mac (open, closed, or never opened in Mockingbird):
  what was said, the files touched and the commands run. A hit opens where it
  lives — its pane, the closed session (restored), its Collaborate room, or a
  new session that resumes it. The same view searches the focused session's
  files.
- **Run and Debug** — run a worktree's services with logs, swap or side by
  side on separate ports, compose stacks isolated per worktree; a built-in
  debugger for Python, Node, browser apps, .NET, Blazor WebAssembly and
  Python in Docker.
- **VS Code workbench** — an activity bar switching the side bar between
  Sessions, Explorer, Source Control and Search; an editor column with
  editable files (⌘S, unsaved dots, conflict-safe saves), tabs, syntax
  highlighting and side-by-side diffs; ⌘P quick open;
  each pane's uncommitted changes ("3 files · +120 −8", opens Source
  Control); views refresh when a session's folder changes instead of polling.
- **Main-process responsiveness** — git work (every pane's status poll,
  fetch/push on session create and close) no longer blocks the process that
  carries every pane's keystrokes: 10 panes polling a large repo went from one
  ~0.5 s freeze to stalls under 10 ms. Panes in the same folder share one read.
- **Tests** — 300+ Vitest tests, run in CI on every push, including real
  debugger sessions (debugpy, js-debug, netcoredbg) and real Docker Compose.
- **Usage panel** — Claude and Codex plan limits like claude.ai's, including
  the 5-hour window between reports.
- **Token meters** — each pane's tokens across all its conversations, and
  its estimated share of the current 5-hour limit ("1.2M · ≈18% of 5h");
  today's total in the status bar; the usage popover ranks panes by their
  share of the window.

### Now

- **Grouping & workspaces rework — second half.** Shipped: the outline-tree
  sidebar (groups → workspace folders → sessions, with status summaries),
  workspace tabs, × on any session closes it, naming the "ungrouped" bucket
  makes it a group, and minimizing a workspace folds its folder. Still to do
  from the design review: moving a session into a group keeps your current
  panes and opens just the moved one; clicking a group header always restores
  the layout you last had; individual panes can be **pinned** to survive group
  switches; drop on a pane's tab strip = add as tab, drop on its body =
  reorder; dragging a sidebar row onto a pane adds it as a tab there.
- **Finish snap layouts.** The Layout flyout shipped; still missing the
  FancyZones half — dragging a pane highlights the zone under the cursor and
  drops it into that slot, and templates should offer per-zone "open a session
  here" affordances instead of only applying when the pane count matches.

### Next

- **Ticket pipeline — "finish ticket" grown up.** Track where each ticket
  actually is, not just its ADO column. The real lifecycle: creation → BA →
  coding (sessions usually start here, sometimes at BA) → local testing →
  PR into dev/UAT → stakeholder testing → feedback loops back to local
  testing → approved → PR into prod/main → staging/prod testing → comms to
  users → moved to Done at next standup. The ticket dialog gets a stage rail
  showing that journey with per-stage actions: "create PR to dev" (commit,
  push, open the ADO PR, link the work item, scaffold the ticket-doc folder —
  Description + Security_Considerations per the team workflow), "record
  stakeholder feedback" (loops the stage back), "create PR to main", "post
  comms", "done". Reaching a stage drafts an ADO comment on the ticket (e.g.
  "PR to dev opened" with the link and a summary of the change) that you
  approve before it posts. Code review stages carry the security +
  clean-code checklist. Open design question: where stage state lives — ADO
  custom field, ticket comment convention, or the WorkTracker folder.
- **Continue in the other agent.** Hand a session to Codex or Claude with a
  generated summary of what's done and what's next — for when one hits its usage
  limit or gets stuck.
- **Session presets**: one-click recurring setups (repo + branch scheme +
  kickoff prompt), e.g. "review session on dev", "test-runner shell".
- **PR status in the pane rail.** Each pane shows its branch's pull request —
  open, approved, changes requested, merged — once the ADO PR surface is wired
  (with the ticket pipeline).
- **Editor intelligence.** Now that files are editable: go to definition,
  hover info, completions and rename from the languages' own servers
  (pyright, tsserver, a C# server), problems underlined as you type, and
  format on save.
- **Cross-agent review.** A button in Source Control starts a session with
  the *other* agent (Codex for a Claude branch, Claude for a Codex one) to review
  the branch's diff, and the findings come back to the original session over
  agent messaging — a second model's opinion before every PR.
- **Undo an agent's turn.** Snapshot the worktree when each prompt is submitted
  (from the hook Mockingbird already gets) into a private ref like
  `refs/mockingbird/snapshots/<session>/…` — no tokens, and the branch, index
  and history are untouched. Undo restores the files to before that turn,
  including changes made by shell commands and by either agent (Claude's own
  `/rewind` only covers its edit tools). Keep the last 10 turns per session;
  git stores only files that changed, so a typical turn costs a few KB.
  Gitignored files are skipped, and any single file over ~5 MB is skipped and
  reported. The conversation isn't rewound, only the files.
- **Conflict early warning.** When two sessions in the same repo change the same
  file in different worktrees, flag both panes before it becomes a merge
  conflict.
- **Session health watchdog**: the manual half shipped (Settings → Agents →
  Update, then Restart all sessions). Still to do:
  notice the CLI's self-update ("Restart to update" in any pane, or a model the
  CLI doesn't know yet) and surface that as one prompt; detect hung sessions
  (working with no output for N minutes) and offer a repaint/resume.
- **Agent messaging, next steps.** Sessions can already message each other
  (`list_sessions` / `send_message`, with a per-pair rate limit). Still to do: a
  visible message log (who told whom what, from the pane rail), a per-group
  switch between auto-send and leave-in-prompt (today it's one global
  setting), and a "Team" broadcast from the group bar that asks every session in
  a group for a status report.
- **Codex parity.** Plan usage and model choices shipped (read from Codex's
  own logs and model cache). Still to do: a watched test of the
  PermissionRequest → amber path.
- **Notification controls**: per-session mute and app-wide quiet hours — today
  every waiting flip notifies, which trains you to ignore them.
- **Scrollback that survives restarts**: resumed sessions get their
  conversation back via `--continue`, but the pane's visual history starts
  empty; persist per-session scrollback to disk and replay on relaunch.

### Later

- **Signed + notarized builds.** Updating is covered by the in-app Update
  (pull, build, restart). What's left needs an Apple Developer ID: no
  right-click→Open for new users, and updates that install in the background.
- **Weekly rollup** (sits on the indexer): compose the daily debrief digests
  and transcript stats into a weekly log with per-ticket time and outcomes.
