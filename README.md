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
- **Claude or Codex** — every session runs one of two coding agents: Claude Code, or OpenAI's **Codex CLI** (`npm i -g @openai/codex`, then `codex login` with your ChatGPT subscription — no API key). Pick it in New Session (with its own model / reasoning-effort choices, remembered per agent); Codex panes carry a `codex` chip. Status dots, broadcasts, ticket kickoff prompts, restore-after-restart (`codex resume --last`), the Files explorer and the close-session dialog all work the same for both. Settings → install hooks writes Codex's hooks to `~/.codex/hooks.json` alongside Claude's; **Codex ignores new hooks until you approve them once — type `/hooks` in any Codex session** (and answer its one-time "trust this directory?" prompt per worktree). Codex has no `Notification` event, so its `PermissionRequest` is what turns a pane amber. Plan usage in the status bar is Claude-only for now — Codex doesn't expose its rate limits. **New/Import Session → Import** resumes any Claude or Codex conversation on this Mac — started in cmux, a terminal, anywhere; search it by words, files or commands — in the folder it ran in, with its repo filled in, into a group or a team room (the top bar's **Import** opens several at once).
- **Agents talk to each other** — every Claude and Codex session gets a small Mockingbird MCP server with two tools: `list_sessions` (id, title, agent, repo, branch, group, status, and whether it shares your ticket group) and `send_message(to, message)`. Ask a session to "tell the backoffice session about the API change" and the message is typed into that pane's prompt, labelled with who sent it and that it came from an agent, not you; the receiver replies the same way. Delivery is immediate when the target is idle, waits for the end of its turn when it's busy or blocked on a permission prompt, and, if you've typed something in that pane you haven't sent yet, waits for you to send it — it's never appended to your draft or submitted with it (a draft left untouched for 2 minutes gets the message placed after it without Enter). Guardrails: at most 8 messages between any two sessions per 5 minutes (the 9th is refused and you get a notification), 8k characters per message, shells and debriefs can't be messaged, and the relay socket (`~/.mockingbird/mb.sock`) is owner-only. Settings → **Agent-to-agent messages** switches auto-send off, so incoming messages sit in the prompt until you press Enter. The server runs on the app's own binary (`ELECTRON_RUN_AS_NODE`), so it needs no Node install, and it's passed per-session (`--mcp-config` / `-c mcp_servers…`), so your own CLI configs aren't touched. Sessions started before this build need a restart to get the tools.
- **Collaborate** — a tab of rooms where models discuss an idea or feature with you: **GPT-6 Astra**, **Claude Opus 5.5** and **Claude Fable 5.1** by default, or any Claude or Codex model id ("Other model…"). They run through the CLIs and plans you already have (`codex exec` / `claude -p`, no API keys), each keeping its own conversation, and take turns round-robin: on its turn a model sees what the others (and you) said since it last spoke, labelled by speaker, and ends with a stance — *agrees* or *continue*. **Layout:** the room list collapses to a rail of initials (a dot marks one that's running or waiting on you); the discussion reads as a **Thread** (a divider per round, long messages folded) or, with the **Rounds** toggle, a grid — a column per model, a row per round, each cell its stance and first line, opening in place; the panel on the right holds the models and what each may do, the repository, the test copy, always-allowed calls and the plan (it floats over the discussion in narrow windows, and hides with ▥). **Models** (in a room, or when creating one) sets each seat: which model, its **effort** (Claude: low → max; Codex: minimal → xhigh), the speaking order, whether it **reads the code**, whether it **runs commands**, and whether it **uses Docker**. Add or remove models any time — a newcomer reads the whole discussion on its first turn; a model that leaves keeps its past messages; effort and code access apply from the next turn without losing the conversation. **Code readers and questions:** give a room a repo and choose who may read it. Models that can't get an **ask_code_reader** tool: mid-turn they ask, the first reader in speaking order looks it up in the repo (in its own lookup thread, so it builds up knowledge of the codebase without cluttering the discussion), and the answer comes straight back — the exchange is shown in the transcript for everyone (a few questions per turn). **Running commands:** a model allowed to run commands can run tests, builds and scripts during the discussion — in a disposable **test copy** of the repo (a git clone of HEAD plus your uncommitted and untracked files, without ignored ones like `node_modules`, under `~/.mockingbird/collab/work/`), never your checkout. It's made on first need, kept between turns (so installs survive), and thrown away by **Reset test copy**, a repo change, or deleting the room. These turns run in the CLI's OS sandbox — Claude's Bash sandbox, Codex's workspace-write — which allows writes only inside the copy and lets them use the network (package installs, local services), with no Docker unless you tick **uses Docker** for that model. A Docker model can start, stop and run containers (Claude's sandbox opens the Docker socket; Codex gets a permission profile allowing it) — but the daemon works outside the sandbox and a container can mount any folder, so for that model the "only the test copy" guarantee rests on its instructions, not the sandbox. A Docker model's `docker` commands are pre-approved. They can write files there too (test scripts, probes); they're told to check facts and test ideas, not implement. **Approvals in the room:** when a Claude model wants something its permissions don't cover — a command Claude's safety check holds, a file outside its folder, a web fetch — the room shows a card with the exact call: **Allow**, **Deny**, or **Always allow** that kind in this room (one CLI and subcommand, one folder, or one site; never chained commands or writes). Its turn waits; you get a notification; no answer in 10 minutes, or Stop, counts as no. Always-allowed kinds are listed under **Models**, where ✕ takes one back. (Codex has no such hook — its sandbox decides on its own.) **Pacing** switches like Claude's Shift+Tab (Shift+Tab in the message box cycles it): **Step**, **Auto** (a set number of rounds), **Until agreed** (stops when every model agrees, with a cap). Type at any point and your message reaches each model on its next turn; **Stop** ends the current turn. **Nothing is edited until you approve:** discussion turns can't touch your code — Claude without edit tools or a shell (unless it runs commands, and then only in the test copy), Codex in its read-only sandbox (or confined to the test copy) — and run with no MCP servers, apps or plugins (their tools can act outside the repo), except the room's own ask tool. **Approve** one model's message, or **Write up plan** with a model of your choice and approve that; then **Implement with…** starts a normal session (with that seat's model and effort) on a new `collab-…` branch in its own worktree, with the approved plan as its first prompt. Rooms are saved in `~/.mockingbird/collab/`; every turn and lookup counts against your Claude and ChatGPT plan limits.
- **Tabs** — the top bar is always visible with five tabs: **Sessions** (the grid), **Dashboard** (the ADO board), **WorkTracker** (debriefs), **Collaborate** (multi-model rooms), and **Settings**. Settings has a category sidebar — **General** (theme, notifications, setup wizard), **Agents** (Claude Code and Codex versions with Update, Restart all sessions, status hooks, agent-message auto-send, binary paths), **Repos** (repo folders and the worktree janitor), **Azure DevOps** (connection, WorkTracker folder), **Debriefs** (auto-run, Azure CLI, MCP servers), **Control room** (Broadcast and the CLAUDE.md editor, also ⌘⇧B), and **About** (version, check for updates). Every setting is a row with its current state, and changes save as you make them. New session is always one click away.
- **Setup wizard** — first launch walks through agents (is `claude` / `codex` installed and signed in), status hooks, repo roots, and Azure DevOps, each step checking the machine's real state; reopen it from ⌘K → Setup or Settings → General → **Run setup**.
- **WorkTracker tab** — the morning brief and 4pm wrap-up run here as their own panes, not in the coding grid (the tab shows an amber dot when a debrief is waiting on you). The wrap-up reads `session-digests/<date>.md`, written at kick-off from every live session's metadata and ANSI-stripped terminal tail — a passive snapshot from memory, so no session is messaged or interrupted. Both debriefs also get `session-digests/ado-snapshot-<date>.md` — your open work items' live states, descriptions, and recent comments pulled at kickoff via the app's own PAT — so ticket truth doesn't depend on Claude Code having an ADO connector (PR review votes still do). Debrief panes are ephemeral and don't survive restarts.
- **Grid** — click sessions in the sidebar to show/hide them in the grid. Panes always fill the grid — no filler tiles: a new one splits the largest pane along its longer side, and a hidden or closed one hands its space to its neighbours. **Drag a session onto a pane to place it**: onto an edge to split that pane there (a preview animates the result before you drop), onto the middle to swap the two panes or open it as a tab, onto the header to open it as a tab; drag a workspace by its name to move the whole pane. **Resize a pane like a window from its own edges**: right edge for width, bottom edge for height, corner grip for both — the panes on either side of that edge trade size (double-click a handle to even out; sizes persist per group). ⛶ fullscreens a pane (⌘E / esc); – hides a pane (session keeps running). **The grid shows one group at a time**: click a group header to switch to it, toggle rows to hide/show individual panes, and clicking a session from another group switches the grid over to it. **Each group remembers which of its sessions were visible** — switching back restores that subset; click the active group's header again to re-show all of it. **▦ Layout** arranges the panes into a snap layout (or back to the automatic fit), and marks the one they're in.
- **Status dots** — teal=working, amber=needs your input, grey=idle, red=dead. Driven by hooks both agents call: Claude Code's Stop / Notification / UserPromptSubmit / PreToolUse, and Codex's Stop / PermissionRequest / UserPromptSubmit / PreToolUse / PostToolUse (Codex has no Notification event — PermissionRequest is its amber). An approved permission flips back to *working* the moment the tool starts. Native notifications fire when a session finishes or needs you.
- **Plan usage** — the status bar shows plan usage for Claude, Codex, or both (`Claude 5h 2% wk 17%  Codex 5h 1% wk 1%`; red at 90%). Click it for a panel like claude.ai's: each agent's plan, every limit as a bar with its percentage and reset time ("Resets in 4 hr 18 min", "Resets Sun 2:00 PM"), and a **Show: Claude · Codex · Both** switch. Claude's numbers come from a Mockingbird statusline passed with `--settings` (after a session's first response; model-specific weekly limits appear when your plan has them), and its plan name from `claude auth status`. Codex's come from the rate-limit events in its own session logs — undocumented, so if Codex changes that format the Codex half just shows nothing. A window whose reset time has passed shows 0% until the next report. Sessions skip the Claude reporter if you have your own `statusLine` in `~/.claude/settings.json`, and API-key logins have no plan limits to show.
- **VS Code-style workbench** — on the Sessions tab, an activity bar on the far left switches the side bar between **Sessions**, **Explorer** (`⌘⇧E`), **Source Control** (`⌃⇧G`, with a count of uncommitted files) and **Search** (`⌘⇧F`); clicking the lit icon or `⌘B` hides the side bar, and its right edge resizes it. Explorer and Source Control follow the focused session: click into a pathlight pane and you see that worktree, click a backoffice pane and you see that one (each tree remembers its expanded folders). Files and diffs open in an **editor** column beside the side bar, as tabs: every file you click gets its own tab (up to 24; the oldest closes past that); staged and working-tree diffs of a file are separate tabs. Code is syntax-highlighted, diffs show inline or side by side, and **@** types `@path` into the focused session's prompt. Files are editable like in an IDE — undo, find and replace (⌘F), multiple cursors, bracket matching, folding, indentation that follows the file — and ⌘S saves. An unsaved file shows a dot on its tab; closing it, **Close all** (tab bar or Open editors) and quitting ask first. If an agent changes a file you're editing, you choose whose version to keep; saving never overwrites a change made since you opened the file without asking, and keeps the file's line endings and byte-order mark. Hover any editor button for what it does (@ types `@path` into the focused session's prompt; ⧉ copies the path). **`⌘P`** opens any file in the focused session's folder by typing part of its name (`name:42` jumps to line 42). The Explorer opens with what changed since the last commit (files, +lines −lines, and a bar), then **Open editors**, then the tree — file-type badges, folder icons and indent guides, changed files colored (blue modified · green added/untracked · red deleted) and the folders holding them dotted. Source Control works like VS Code's: the branch with ↑ahead ↓behind its upstream, **Fetch**, **Pull** (fast-forward only — never a merge commit or a rewrite; if both sides moved it says so and changes nothing) and **Push**. If a git action fails (fetch, pull, push, commit…), its error shows in Source Control with **Ask the session to fix**, which types the error into that worktree's chat for the agent. A branch Mockingbird makes from `origin/dev` tracks `origin/dev` until its first push — so ↓ counts dev's new commits and Pull brings them in — and **Publish branch** always pushes it under its own name, never into dev. Then a commit box (⌘↵) whose ✦ button writes the message from the staged change (or everything, when nothing is staged) with the session's own agent, then **Staged changes** (the next commit) and **Changes** (edits not staged yet) with stage (+), unstage (−) and discard (↺ — asks first; new files go to the Trash) per file or all at once. **Branch vs origin/dev** (collapsed) lists everything the branch changed since it split off its `dev`/`main`-style base, commits included: what a pull request would contain. **Graph** draws the commit history of the branch, what it tracks and its base — merges and forks as lanes, branch and tag labels — and a commit opens to its files, each opening that commit's diff. A pane's git line (↑ commits to push · ↓ commits to pull · uncommitted files) opens Source Control. Live sessions' repository folders are watched, so the tree, change list, open files and each pane's change count ("3 files · +120 −8" in its header — click it for Source Control) refresh when a file changes, with a slow poll as the safety net. Files are addressed by session id + relative path, so the renderer can't read outside a live session's folder.
- **CLAUDE.md** — edit the global or any active repo's CLAUDE.md in-app; on save, every live session is told to re-read it. Busy sessions get the message when they finish their current task, so nothing is interrupted.
- **Broadcast** — send any instruction to all/selected sessions once, instead of repeating yourself.
- **Debriefs** — "Morning brief" / "4pm wrap-up" buttons (or auto-schedule in Settings) spawn an Assistant session in your WorkTracker folder that follows `instructions/morning.md` / `wrap-up.md`. Answer its interview questions right in the pane.
- **Run and Debug** (⌘⇧D) — runs the focused worktree's services (API, frontend, a Docker Compose stack) with live logs in a panel under the grid (⌘J), status, clickable ports, and start / stop / restart per service or all at once. A repo's run setup lives in Mockingbird (per main checkout, shared by its worktrees, nothing committed): **Draft with Claude** reads the repo's launch configs, scripts, compose files and README — read-only, never its env files — and proposes the services, the ports, what a worktree needs copied in, what blocks side-by-side runs (with the one-line fix, and an "Ask the session to fix" button) and the sign-in redirect URIs to register; you review and save it. **Swap** runs one copy of an app at a time on its standard ports (starting it in one worktree stops it in the other); **Side by side** gives each running worktree its own slot of ports (+10 per slot). A port held by something Mockingbird didn't start is reported, never killed without asking. Compose stacks get a per-worktree override, so a worktree runs its own code and side-by-side copies get their own containers and ports. **Prepare** copies a new worktree's gitignored env files and certs from the main checkout and installs what's missing. Stopping takes down the whole process group; quitting Mockingbird stops everything it started. **Debug** (the bug next to a service) runs it under a built-in debugger: click a line number in the editor to set a breakpoint (kept per repo, so they apply in every worktree), and when it stops the file opens at that line with the controls in Run and Debug — continue, pause, step over / into / out, stop — plus the call stack, variables (expandable), watch expressions, the breakpoint list, and a Debug Console under the grid that evaluates in the paused frame. The program still runs on its own terminal, so its log is where it always is. Python services (FastAPI under uvicorn, scripts, `python -m …`) debug through debugpy; `--reload` is off while debugging. A dev server for a browser app (Vite, Next…) debugs in its own Chrome window per worktree — breakpoints in your TypeScript, mapped through the source maps — and other Node programs (`node file`, npm scripts, children followed) debug under Node, both through js-debug. .NET services (`dotnet run --project …`, ASP.NET included) build on their terminal, then run under netcoredbg with their output in the same log; hot reload is off while debugging. A server that hosts a Blazor WebAssembly client also opens a debug Chrome window, where breakpoints in `.razor` and client `.cs` code work through the Blazor debug proxy. Python inside a Docker container is debugged by attaching: Mockingbird mounts debugpy into the container (`$MOCKINGBIRD_DEBUGPY`) and publishes its port on loopback; the container's start command runs `python -m debugpy --listen 0.0.0.0:5678 …` when that's set (the draft lists the change). Debuggers are downloaded on first use and checked against their published SHA-256.
- **Token meters** — a pane's info row shows the tokens all its conversations have used and, while a 5-hour window is running, its estimated share of the limit ("1.2M · ≈18% of 5h"; hover for new input, output and cache). The status bar adds today's total, and the usage popover shows today per agent. Plans only report how full a window is, not its size in tokens, so a pane's share is estimated: its usage in the window over everything this Mac's sessions used in it, weighted by model (Opus output fills a window much faster than cached Sonnet input), times the window's reported %. Use outside this Mac isn't in its transcripts, so shares can read high.
- **Search** — ⌘⇧F opens the Search view, over **Conversations** or **Files**. Conversations searches every Claude and Codex conversation on this Mac — open, closed, or never opened in Mockingbird — by what was said, the files it touched and the commands it ran. Each result opens where it lives: **go to pane**, **restore session** (a closed Mockingbird session), **open room** (a Collaborate model's), or **open as session** (resumes it in its folder). The index (`~/.mockingbird/transcripts.db`) stays on this Mac, is built in the background on first launch (a few seconds), and keeps up as transcripts grow; tool output isn't indexed. Files searches the text of every file in the focused session's folder (git grep: tracked files plus untracked ones `.gitignore` doesn't exclude), with match-case and regex toggles; a result opens the file at that line. A search stops at 2,000 matches or 20 seconds and says so.
- **Previous sessions** — after an app restart (an update, a reboot, a quit), ↺ relaunches a session in its old folder and resumes **the exact conversation that pane last ran** (`claude --resume <id>` / `codex resume <id>`), not just the folder's most recent one — which matters when several chats started in the same folder. **Terminal panes remember too:** if you ran `claude` or `codex` inside a terminal, it comes back with that conversation resumed, and quitting it leaves you at the terminal prompt. Mockingbird learns each pane's conversation from the status hooks (every pane exports `MOCKINGBIRD_SESSION`, so events are matched to the right pane even when an agent `cd`s elsewhere); `/clear` moves it to the new conversation. Starting Claude in your home folder, it asks whether to trust the folder first, as it always does there. **↺ restore all** relaunches everything; relaunched sessions keep their id, so they return to their old grid slot and group. Renderer-only changes don't even need that — rebuild and hit `⌘R` (View → Reload) and the sessions keep running.
- **Groups and workspaces** — sessions sharing a ticket # group automatically. The sidebar is an outline: each **group** is a plain header (your own groups first, then the team rooms' under **Connected Sessions**; a header's **+** starts a session in that group), and inside it each **workspace** is a folder row with up to three status dots (waiting first, then `+N`) — the folder is open while that workspace is in the grid, and its sessions fold away otherwise (the chevron opens or closes them by hand). Session rows show the name and, underneath, the branch (and `codex` for Codex panes). Name a group `5038/backend` (or set a workspace in the ⤷ dialog) to put sessions in a workspace: it shows in the grid as **one pane with a tab per session**. Each tab's **×** hides just that session from the grid (it keeps running); the pane goes when its last tab does, and clicking the workspace's folder brings them all back. To manage: drag a sidebar row onto another group or workspace, drop one loose session onto another to make a workspace of the two, click a row's ⤷ (or ⌘K → "Change group…") for a move/create/remove dialog, or set the Group field in New Session. Double-click a group or workspace to rename it; a workspace's ✕ dissolves it (its sessions move up into the group).
- **Command palette & keyboard layer** — `⌘K` opens a palette with every action plus jump-to-session (waiting sessions show their reason and wait time). `⌘N` new session · `⌘1–9` jump to pane · `⌥⇥` next waiting session (oldest first) · `⌘E` fullscreen pane (esc restores) · `⌘⌃1–4` arrange in 1–4 columns · `⌘⇧B` broadcast · `⌘/` how-to-use popup (also auto-opens on first launch).
- **Dashboard (board)** — an ADO-style kanban read via the WorkTracker folder's `config.json` + PAT file. A filter bar scopes the board: an **"Assigned to" multi-select** (defaults to you — the PAT's owner — check any mix of people, "Unassigned" included, or Everyone; the whole project loads, capped honestly at the 200 most recent) and **column show/hide toggles**. Both persist. Columns are the real ADO states — **drag a card to another column to change its state** (optimistic, reverts on API error). Clicking a card opens a **centered work-item dialog like ADO's**: title/description/discussion (read + **post comments**) in the main column, state and session actions in the sidebar — start a worktree session from the ticket (auto-grouped under its id) or attach an existing one. Starting a session offers **New branch** (fetches the freshest `origin/dev`-style base — auto-detected per repo, changeable — and branches off it) or **Existing branch** (local or origin), and by default **sends the ticket title + description to the Claude session as its first prompt** so it starts working with full context. Cards carry ADO's type colors and show live session dots plus the assignee when viewing Everyone. The PAT never leaves the Electron main process.
- **Selecting and copying** — releasing a selection copies it (a "Copied" toast confirms; "Couldn't copy selection" if the clipboard refused). For more than a screen: click where it starts, scroll with the wheel, and shift-click where it ends; or drag past a pane's top or bottom edge and it scrolls as you select. The wheel scrolls a pane's own history; it's only handed to the CLI when the CLI turns on mouse tracking. **Full-screen Claude** (`"tui": "fullscreen"`) turns mouse tracking on and selects and copies its transcript itself, so a plain drag in its pane is Claude's selection; **Option-drag** for a plain terminal selection of what's on screen instead (Claude's "option+click to native select" hint). Claude copies through the Mac's clipboard (`pbcopy`); a Claude running remotely or in a container, which can only ask the terminal to copy (OSC 52), can't reach your clipboard yet — Option-drag there. Pasting text always pastes the text, even when the clipboard also holds an image; an image alone lands in the prompt as [Image #1].
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

Team rooms are tested at every layer: the signed protocol and invite codes, the
signaling room logic (also served over WebSockets by the local signaling
server, `npm run team:signaling`), the event log, and the WebRTC wire against
the local server. Everything above the transport runs over an in-process
loopback (`src/main/team/loopback.ts`) with real session managers and real git
(a local bare origin and clones): live panes, the Co-authored-by hooks, chat,
the plan board, backups and take-over with the owner online (Hand over, Keep,
no answer, dropping offline mid-request), away or restarted, the old copy
stopping, its unsent changes sent and applied, and Take it back.
`test/teamWebrtc.e2e.test.ts` runs real WebRTC between two peer
hosts (skipped in CI). With `MB_E2E_APP=1`, `test/teamApp.e2e.test.ts` and
`test/teamLiveApp.e2e.test.ts` run two real Mockingbird instances in throwaway
homes (their windows open while they run): share and join, a terminal watched
and typed into, chat, a package claimed, a turn of a Claude stand-in backed up,
a session handed over from the owner's prompt, and Take over once the owner
has quit, their copy stopping when it starts again. `MB_E2E_SIGNALING_URL=https://…` runs
them against a deployed Worker — allow the fingerprint `npm run
team:e2e-fingerprint` prints there first — with a relay-only variant that
proves the TURN fallback.

## UI preview

```bash
npm run ui-preview   # http://localhost:5190 — rebuilds on every change; reload the page
```

The real interface in a browser, over a stand-in for the main process
(`src/preview/stub.ts`) that answers from fixture data: two ticket groups with a
workspace, sessions in every state, a small repository for the explorer, editor
and Source Control, a board, a ticket pipeline, usage and token meters. Nothing
real is touched — no sessions run, no files, git, ADO or agents. Typing in a pane
is echoed; calls the stand-in doesn't simulate answer like a real failure and are
logged in the console and in `window.__mbCalls`. `?reset` starts again from the
fixtures.

Sessions find this on their own: `AGENTS.md` (Codex) and `CLAUDE.md` (Claude
Code, which imports it) tell them how to check a change. Without a browser a
session can take a screenshot and look at it —
`npm run ui-preview -- --shot out/shot.png --query "tab=dashboard&theme=light"`
renders in headless Chrome; with the Claude in Chrome extension (`/chrome`) it
can open the live preview and click through it. When a feature adds a
main-process call, add it to the stand-in so the preview shows it.

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
- **Weekly rollup** — WorkTracker → Weekly rollup (or ⌘K) writes this or
  last week into `session-digests/rollup-week-of-<Monday>.md`: active time
  (messages under 10 minutes apart) per ticket and per day, stage moves, pull
  requests and stakeholder feedback from the ticket pipeline, the top
  conversations, work outside tickets by repository, tokens per agent (cache
  reads apart), and links to that week's daily digests. Nothing is sent to a
  session or model.
- **Scrollback that survives restarts** — each pane's terminal history is
  saved (every minute it changes, when it closes for resuming, and at quit)
  and replayed when the pane comes back, after an app restart, Update or a
  session restart, above a dim "restarted · earlier output above" line.
- **Notification controls** — mute a session from its sidebar row (or ⌘K;
  its pane shows "muted", and it stays muted through restarts), quiet hours
  in Settings → General (spans past midnight work), and an option to be
  notified only when a session needs you, not when it finishes.
- **Codex parity, checked** — a watched run of Codex 0.156 in a read-only
  sandbox asking to write a file: its UserPromptSubmit, PreToolUse and
  PermissionRequest hooks reach Mockingbird tagged with the pane, which turns
  amber ("Codex needs your permission to use Bash"); those payload shapes are
  now a test.
- **Agent messaging, filled out** — a message log (who told whom what,
  delivered or refused; "Msgs 2↓ 1↑" on each pane's rail, or ⌘K for all),
  a per-group choice in the group bar between auto-send and leave-in-prompt
  (overriding the app-wide setting), and "Ask for status", which asks every
  agent session in the group for a three-line report as its turn ends.
- **Session health watchdog** — panes record the CLI version they started
  with; when Claude Code or Codex updates itself under them, the status bar
  says "Claude Code updated to 2.1.x · N sessions on the old version —
  Restart" (one prompt, to Restart all). A pane that's working but has shown
  no output for 5 minutes says it may be stuck and offers Repaint or Restart
  (resuming its conversation).
- **Conflict early warning** — when two sessions' worktrees of the same
  repository change the same file (on their branches since the base, or not
  yet committed), both panes show "⚠ N overlap"; hover lists the files and
  the other branch, click goes to the other session. Checked when either
  folder changes and every 2 minutes.
- **Undo an agent's turn** — every prompt you send first records the
  worktree's files in a private ref (`refs/mockingbird/snapshots/<session>/…`;
  the branch, staged changes and history are untouched). ↶ on a pane (or ⌘K)
  lists the last 10 turns by their prompt, shows which files would come back
  or go, and restores them — including changes made by shell commands and by
  either agent. The restore is itself recorded, so it can be undone; ignored
  files and anything over 5 MB are left alone (and named). The conversation
  isn't rewound; "Tell the agent" types a note into the session.
- **Cross-agent review** — "Second opinion: review with Codex" (or Claude)
  in Source Control starts the other agent in the same folder to review the
  branch, committed and not, for bugs, security, silent failures and missing
  tests; it changes nothing and sends its findings back to the session over
  agent messaging.
- **Editor intelligence** — files open with their language's own server:
  problems underlined as you type (and in the gutter), hover, completions,
  go to definition (F12 or ⌘-click; Alt-click adds a cursor), rename across
  files (F2 — open files change for review, the rest are saved) and format
  (⇧⌥F, or on save in Settings → General). TypeScript/JavaScript use
  TypeScript 7's native language server, Python uses pyright, C# uses
  csharp-ls on the Mac's .NET; each downloads once, when you first open such
  a file and click Install, pinned and checked against its registry's hash.
- **PR status in the pane rail** — each pane's branch shows its pull
  request (Azure DevOps or GitHub): open, draft, approved, changes requested,
  merged or closed, with conflicts flagged and who reviewed it on hover;
  click to open it.
- **Session presets** — one-click setups in Settings → Presets (or "Save as
  preset…" in New session): Claude, Codex or a terminal; a repo; the branch
  as checked out, an existing branch, or a fresh one from a pattern like
  `review-{date}` off dev, optionally in its own worktree; a group; and a
  kickoff prompt (a terminal runs it as a command). Start them from New
  session or ⌘K.
- **Continue in the other agent** — ⇄ on a pane (or ⌘K) hands its task to
  Codex or Claude: the agent taking over reads the conversation and the
  worktree and writes a handoff (goal, done, in progress, next steps, watch
  out for), which you can edit before a new session starts from it in the
  same folder, branch and group — optionally closing the old one.
- **Ticket pipeline** — each ticket's stage (BA → coding → local testing →
  PR to dev → stakeholder testing → approved → PR to main → staging/prod →
  comms → done), kept locally, on a stage rail in the ticket dialog and as a
  chip on board cards and the group bar. Each stage has its next step:
  "Create PR to dev/main" checks the branch (commits, uncommitted files, the
  ticket's Description/Security docs, a PR already open), writes the
  description from the branch, then pushes and opens the PR — on Azure DevOps
  linked to the work item, on GitHub through `gh`. Stakeholder feedback loops
  back to local testing (and can go straight to the session); comms to users
  are drafted from the ticket and its PRs. Every stage drafts a ticket comment
  that posts only when you click Post. The promotion gates' checklists ride
  along at the stages they guard.
- **Grouping and snap layouts, finished** — moving a session into a group
  keeps your panes and opens just the moved one; a group header always
  restores the panes you last had; **pinned** panes (pane header, sidebar row
  or ⌘K) stay on screen across group switches; dropping a session on a pane's
  header or tab strip makes it a tab there, on the body moves it (a sidebar
  row dropped on a pane opens as a tab). Layout templates now always apply:
  drag a pane into a zone (swapping with the one there), empty zones offer
  "Open a session here", and extra panes flow into rows below.
- **Token meters** — each pane's tokens across all its conversations, and
  its estimated share of the current 5-hour limit ("1.2M · ≈18% of 5h");
  today's total in the status bar and, per agent, in the usage popover.
- **Split layouts, no empty tiles** — each group's grid is a split tree, as
  in VS Code: panes always fill it (a closed pane's neighbours take its
  space; leaving fullscreen goes back to the layout). Drag a session onto a
  pane's edge to split it there — halves beside one pane, thirds beside two —
  or onto its middle to swap, or open it as a tab; a tab dragged out of a
  workspace gets a pane of its own. While dragging, a preview animates the
  layout the drop would leave; the terminals only resize on the drop. Snap
  layouts and ⌘⌃1–4 arrange the panes once, and pane numbers read top-left
  first. Old templates and column counts carry over.

### Now

- **Team rooms** ([design](docs/team-rooms.md)) — a group shared live with a
  teammate's Mockingbird. Built and tested end to end on one Mac; next is the
  first run between two laptops through the deployed Worker.
  - **Connecting:** each install has a key pair and a display name (Settings →
    Team; `npm run team:fingerprint`). Laptops connect peer to peer over WebRTC
    (in a hidden window), introduced by a Cloudflare signaling Worker
    (`signaling/`, deployed once; only fingerprints in its `ALLOWED_CREATORS`
    create rooms) with Cloudflare TURN as the fallback relay. Every connection
    detail is signed and each certificate pinned. A room is a shared group (⇪
    shares one; New/Import Session → Connected → **+ New room** makes one and
    starts the session in it, then shows the invite code; Join a room… — in the
    Team tab, New/Import Session → Connected, or ⌘K — takes a teammate's code);
    every member keeps its signed, ordered event log and merges it on reconnect.
  - **Sessions:** a session in a shared group is one row and one pane on every
    member's Mockingbird, tagged with its owner's initials; shared groups sit
    under **Connected Sessions** in the sidebar. Start one from a shared
    group's **+**, **New session** in the Team room view, or New session →
    Where → **Connected** (it lists your rooms, who's online, and offers the
    repo the room works in; **+ New room** shares a new group first, keyed by
    a leading ticket number: "5120 Donor search" is group 5120). It streams to
    whoever shows it, anyone can type into it, initials show who's looking,
    Follow mirrors a teammate's grid, and everyone hears when it waits. Room
    sessions start knowing the room's plan and unable to read secret files:
    Claude through permission rules, Codex (0.138+) through a sandbox set by
    `-c` on that launch alone, enforced on every command it runs: it commits,
    stashes and installs packages, but can't read logins or push — pushing is
    yours. Commits in turns a teammate typed into credit them with
    Co-authored-by.
  - **Backups and Take over:** after every agent turn a room session's worktree
    (ignored and secret files left out) is pushed to a hidden ref on origin,
    `refs/mockingbird/rooms/<room>/<session>`, and sent to connected teammates
    with its conversation, which never goes to git. Rows and panes say how
    fresh each backup is. **Take over** continues a teammate's session on your
    laptop from the newest snapshot, on its branch, resuming the conversation
    (or a summary of what arrived). A connected owner is asked first (**Hand
    over** / **Keep**, kept after 2 minutes unanswered): handing over lets their
    turn finish, sends that exact backup straight to you and stops their agent.
    An owner who was away stops their copy as soon as their Mockingbird is back
    (or started): its worktree stays untouched, its pane says "Continued on
    Nick's laptop" with **Take it back** (the same take-over, in reverse) and
    **Close**, and when it has changes the taker never got it says so and
    **Send to Nick** delivers them as a patch he reviews and applies — never
    applied by itself. Anyone who can read the repository can fetch backed-up
    work in progress; a backup is deleted once its session is forgotten,
    merged, idle for 14 days, or taken over and backed up again.
  - **Team room chat:** a thread per room (the **Team room** view, the **Room
    chat** chip) with @mentions, agents' updates (turns, waits, take-overs,
    board changes), `list_sessions` and `send_message` across laptops, and
    **@assistant**, answered on the asker's laptop.
  - **Plan board** (▦): work packages with owned paths, contracts and tests,
    claimed by members, kept on the `mockingbird/plan` branch and as a
    read-only copy in every worktree. Agents change it with `update_team_plan`;
    an agent's first edit of a file a teammate's package owns is held back once
    with a warning; a teammate's pushed branch that changes your files shows on
    the pane ("Nick's branch also changes …") and opens the board.

### Next

Nothing queued.

### Later

- **Signed + notarized builds.** Updating is covered by the in-app Update
  (pull, build, restart). What's left needs an Apple Developer ID: no
  right-click→Open for new users, and updates that install in the background.
