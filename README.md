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

**Updates:** Settings → Agents → **Update** (next to Claude Code or Codex) runs that CLI's own updater — needed when a new model (e.g. a new Opus) says the CLI must update — then **Restart all sessions** moves every pane onto the new build without losing conversations. For Mockingbird itself: dev runs pick up renderer changes with `npm run build` + ⌘R (main-process changes need a restart). The packaged app checks GitHub (on launch and every 6h; Settings → About → Check for updates any time) against the latest release, or — with none published — the `version` on `main`. The repository is private, so the check signs in with the GitHub CLI (`gh auth login` once). A newer version shows a teal "⭮ vX.Y available" link in the status bar; **Update** pulls and builds it in your clone of the repo (found under your repo folders, or chosen under Settings → About) while you keep working — it stops if the clone has uncommitted changes, isn't on `main`, can't fast-forward, or lacks Node 22. When the build is ready, **Restart to update** quits, swaps the app in /Applications (putting the old one back if anything fails), reopens it, and brings back the sessions that were open; the top bar's version reads "Updated to X" and What's new opens once (a failed update, or sessions that couldn't come back, show in the status bar; log: `~/.mockingbird/update.log`). To ship an update: bump `version` on `main` (and optionally publish a GitHub release). True silent auto-update would additionally need an Apple Developer ID signature + notarization.

## What it does (v1)

- **+ Session** — fuzzy-pick a repo from your repo roots (set in the setup wizard; `~/Code` and `~/Personal Projects` by default), choose **Claude**, **Codex**, or a plain **Terminal**, then either **pick one of your ADO tickets from the dropdown** (auto-fills ticket #, name, and offers to send the ticket title + description to the agent as its first prompt) or enter a ticket manually (# and name → branch `5038-filterOrgsByFoundation`). New branches are cut from a freshly fetched `origin/dev`-style base (changeable). Ticket sessions get an isolated worktree in one tidy place — `worktrees/<repo>/<branch>` beside your repos — and the agent launches there; untick **isolated worktree** to check the branch out in the repo itself instead (the choice is remembered); multiple sessions per ticket group together in the sidebar.
- **Claude or Codex** — every session runs one of two coding agents: Claude Code, or OpenAI's **Codex CLI** (`npm i -g @openai/codex`, then `codex login` with your ChatGPT subscription — no API key). Pick it in New Session (with its own model / reasoning-effort choices, remembered per agent); Codex panes carry a `codex` chip. Status dots, broadcasts, ticket kickoff prompts, restore-after-restart (`codex resume --last`), the Files explorer and the close-session dialog all work the same for both. Settings → install hooks writes Codex's hooks to `~/.codex/hooks.json` alongside Claude's; **Codex ignores new hooks until you approve them once — type `/hooks` in any Codex session** (and answer its one-time "trust this directory?" prompt per worktree). Codex has no `Notification` event, so its `PermissionRequest` is what turns a pane amber. Plan usage in the status bar is Claude-only for now — Codex doesn't expose its rate limits. **New/Import Session → Import** resumes any Claude or Codex conversation on this Mac — started in cmux, a terminal, anywhere; search it by words, files or commands — in the folder it ran in, with its repo filled in, into a group or a team room (the top bar's **Import** opens several at once).
- **Agents talk to each other** — every Claude and Codex session gets a small Mockingbird MCP server with two tools: `list_sessions` (id, title, agent, repo, branch, group, status, and whether it shares your ticket group) and `send_message(to, message)`. Ask a session to "tell the backoffice session about the API change" and the message is typed into that pane's prompt, labelled with who sent it and that it came from an agent, not you; the receiver replies the same way. Delivery is immediate when the target is idle, waits for the end of its turn when it's busy or blocked on a permission prompt, and, if you've typed something in that pane you haven't sent yet, waits for you to send it — it's never appended to your draft or submitted with it (a draft left untouched for 2 minutes gets the message placed after it without Enter). Guardrails: at most 8 messages between any two sessions per 5 minutes (from a teammate's laptop: per teammate and target session; the 9th is refused and you get a notification), 8k characters per message, shells and debriefs can't be messaged, and the relay socket (`~/.mockingbird/mb.sock`) is owner-only. Settings → **Agent-to-agent messages** switches auto-send off, so incoming messages sit in the prompt until you press Enter. The server runs on the app's own binary (`ELECTRON_RUN_AS_NODE`), so it needs no Node install, and it's passed per-session (`--mcp-config` / `-c mcp_servers…`), so your own CLI configs aren't touched. Sessions started before this build need a restart to get the tools.
- **Council** — a tab of councils where models discuss an idea or feature with you: **GPT-6 Astra**, **Claude Opus 5.5** and **Claude Fable 5.1** by default, or any Claude or Codex model id ("Other model…"). They run through the CLIs and plans you already have (`codex exec` / `claude -p`, no API keys), each keeping its own conversation, and take turns round-robin: on its turn a model sees what the others (and you) said since it last spoke, labelled by speaker, and ends with a stance — *agrees* or *continue*. **Layout:** the council list collapses to a rail of initials (a dot marks one that's running or waiting on you); the discussion reads as a **Thread** (a divider per round, long messages folded) or, with the **Rounds** toggle, a grid — a column per model, a row per round, each cell its stance and first line, opening in place; the panel on the right holds the models and what each may do, the repository, the test copy, always-allowed calls and the plan (it floats over the discussion in narrow windows, and hides with ▥). **Models** (in a council, or when creating one) sets each seat: which model, its **effort** (Claude: low → max; Codex: minimal → xhigh), the speaking order, whether it **reads the code**, whether it **runs commands**, and whether it **uses Docker**. Add or remove models any time — a newcomer reads the whole discussion on its first turn; a model that leaves keeps its past messages; effort and code access apply from the next turn without losing the conversation. **Code readers and questions:** give a council a repo and choose who may read it. Models that can't get an **ask_code_reader** tool: mid-turn they ask, the first reader in speaking order looks it up in the repo (in its own lookup thread, so it builds up knowledge of the codebase without cluttering the discussion), and the answer comes straight back — the exchange is shown in the transcript for everyone (a few questions per turn). **Running commands:** a model allowed to run commands can run tests, builds and scripts during the discussion — in a disposable **test copy** of the repo (a git clone of HEAD plus your uncommitted and untracked files, without ignored ones like `node_modules`, under `~/.mockingbird/collab/work/`), never your checkout. It's made on first need, kept between turns (so installs survive), and thrown away by **Reset test copy**, a repo change, or deleting the council. These turns run in the CLI's OS sandbox — Claude's Bash sandbox, Codex's workspace-write — which allows writes only inside the copy and lets them use the network (package installs, local services), with no Docker unless you tick **uses Docker** for that model. A Docker model can start, stop and run containers (Claude's sandbox opens the Docker socket; Codex gets a permission profile allowing it) — but the daemon works outside the sandbox and a container can mount any folder, so for that model the "only the test copy" guarantee rests on its instructions, not the sandbox. A Docker model's `docker` commands are pre-approved. They can write files there too (test scripts, probes); they're told to check facts and test ideas, not implement. **Approvals in the council:** when a Claude model wants something its permissions don't cover — a command Claude's safety check holds, a file outside its folder, a web fetch — the discussion shows a card with the exact call: **Allow**, **Deny**, or **Always allow** that kind in this council (one CLI and subcommand, one folder, or one site; never chained commands or writes). Its turn waits; you get a notification; no answer in 10 minutes, or Stop, counts as no. Always-allowed kinds are listed under **Models**, where ✕ takes one back. (Codex has no such hook — its sandbox decides on its own.) **Pacing** switches like Claude's Shift+Tab (Shift+Tab in the message box cycles it): **Step**, **Auto** (a set number of rounds), **Until agreed** (stops when every model agrees, with a cap). Type at any point and your message reaches each model on its next turn; **Stop** ends the current turn. **Nothing is edited until you approve:** discussion turns can't touch your code — Claude without edit tools or a shell (unless it runs commands, and then only in the test copy), Codex in its read-only sandbox (or confined to the test copy) — and run with no MCP servers, apps or plugins (their tools can act outside the repo), except the council's own ask tool. **Approve** one model's message, or **Write up plan** with a model of your choice and approve that; then **Implement with…** starts a normal session (with that seat's model and effort) on a new `collab-…` branch in its own worktree, with the approved plan as its first prompt. **House tickets from the plan:** **Create House tickets…** on an approved plan splits it into Radley House ticket drafts — by its checklist, numbered steps or step sections, with no model call (goals, decisions, risks, files and checks are never tickets); a plan with none of those offers a model's split (it asks first, since it sends the plan; one fresh turn with no code access) or one ticket for the whole plan. Each draft has a title, detail (ending with the council it came from), acceptance criteria, priority and tags (`needs-agent` by default). Review them side by side — the list on the left (select two or more to **Merge**, **Remove**, ↑ ↓, + Add a ticket), the chosen one's fields on the right; the drafts are kept with the council as you edit. They go to the House project of the team room working in the council's repository (optionally added to the room's board), or else to any project you have a builder token file for, asked once per project ("Use your <project> builder token from the Council?"). Nothing is sent until you press the button that says exactly what it does — "Create 5 tickets in atticus-backoffice" — with your own token; a draft the House would refuse, or a missing token, stops it before anything is sent; if the House refuses one, the rest aren't sent and the review says which were created and which weren't, keeping those for another go. Created tickets are linked from the discussion (a note naming each, and their numbers under **Plan**, opening in the House). Councils are saved in `~/.mockingbird/collab/`; every turn and lookup counts against your Claude and ChatGPT plan limits.
- **Tabs** — the top bar is always visible with five tabs: **Sessions** (the landscape), **Dashboard** (the ADO board), **WorkTracker** (debriefs), **Council** (multi-model discussions), and **Settings**. Settings has a category sidebar — **General** (theme, setup wizard), **Notifications** (desktop notifications, quiet hours, phone alerts), **Agents** (Claude Code and Codex versions with Update, Restart all sessions, status hooks, agent-message auto-send, binary paths), **Repos** (repo folders and the worktree janitor), **Azure DevOps** (connection, WorkTracker folder), **Debriefs** (auto-run, Azure CLI, MCP servers), **Control room** (Broadcast and the CLAUDE.md editor, also ⌘⇧B), and **About** (version, check for updates). Every setting is a row with its current state, and changes save as you make them. New session is always one click away.
- **Setup wizard** — first launch walks through agents (is `claude` / `codex` installed and signed in), status hooks, repo roots, and Azure DevOps, each step checking the machine's real state; reopen it from ⌘K → Setup or Settings → General → **Run setup**.
- **WorkTracker tab** — the morning brief and 4pm wrap-up run here as their own panes, not on the landscape (the tab shows an amber dot when a debrief is waiting on you). The wrap-up reads `session-digests/<date>.md`, written at kick-off from every live session's metadata and ANSI-stripped terminal tail — a passive snapshot from memory, so no session is messaged or interrupted. Both debriefs also get `session-digests/ado-snapshot-<date>.md` — your open work items' live states, descriptions, and recent comments pulled at kickoff via the app's own PAT — so ticket truth doesn't depend on Claude Code having an ADO connector (PR review votes still do). Debrief panes are ephemeral and don't survive restarts.
- **Landscape** ([design](docs/landscape.md)) — the Sessions tab is a surface you pan and zoom, like a Figma canvas. Each session is a **workspace** on it, and each group an **area**: a coloured region with its name, its ticket's stage, its usage and, for a team room, the room's tools along its top. At 75% and up a workspace's terminal takes typing, down to 35% it's live but read-only, and below that it's a card with its title, status and last line (hover one for a peek). Drag a workspace's header to move it and its edges or corners to resize it — it snaps to an 8 px grid and to its neighbours, and what it lands on moves aside; dragging it into or out of an area changes its group. **Focus** (`⌘E` or Enter) fills the window with the selected workspace; esc goes back. `⌘0` fits everything on screen and `⌘1` goes to 100%; scroll pans (or Space-drag), ⌘-scroll or a pinch zooms about the cursor, and the minimap shows where you are. **Stacks** (sub-groups) are one card with a tab per session (`⌘G` on a selection, or **New tab…** on a workspace's ⋯). An area's ⋯ collapses it to a pill, locks its layout or **Tidy**s it. Closing a workspace leaves a **ghost** in its place to reopen. **Needs you** lists every permission prompt, question, teammate's ask to type (Allow for 15 min or Deny it there), join request and finished workspace (`N` / `⇧N` step through them), and cards carry badges (its diff, PR, cost, what it did). The first launch on the landscape reads the grid's layout in: groups become areas, sub-groups stacks, and workspaces keep the grid's arrangement, with a short tour; the grid's saved layout is left as it was, so an older Mockingbird still finds it.
- **Status dots** — teal=working, amber=needs your input, grey=idle, red=dead. Driven by hooks both agents call: Claude Code's Stop / Notification / UserPromptSubmit / PreToolUse, and Codex's Stop / PermissionRequest / UserPromptSubmit / PreToolUse / PostToolUse (Codex has no Notification event — PermissionRequest is its amber). An approved permission flips back to *working* the moment the tool starts. Native notifications fire when a session finishes or needs you.
- **Plan usage** — the status bar shows plan usage for Claude, Codex, or both (`Claude 5h 2% wk 17%  Codex 5h 1% wk 1%`; red at 90%). Click it for a panel like claude.ai's: each agent's plan, every limit as a bar with its percentage and reset time ("Resets in 4 hr 18 min", "Resets Sun 2:00 PM"), and a **Show: Claude · Codex · Both** switch. Above them, the **Context window** of the focused pane's session ("275.6k / 1M (28%)", with a bar; red at 90%), re-read every 2 s while the panel is open: Claude's comes from the same statusline (which knows a 1M model's window), kept per conversation in `~/.mockingbird/context/`; Codex's from the newest token_count event in its session log (Codex's own "% context left" sets a fixed baseline aside first, so the two differ slightly). It's one bar, not split by category: neither CLI reports that breakdown to Mockingbird. A teammate's session has no reading here (it runs on their Mac). Claude's numbers come from a Mockingbird statusline passed with `--settings` (after a session's first response; model-specific weekly limits appear when your plan has them), and its plan name from `claude auth status`. Codex's come from the rate-limit events in its own session logs — undocumented, so if Codex changes that format the Codex half just shows nothing. A window whose reset time has passed shows 0% until the next report. Sessions skip the Claude reporter if you have your own `statusLine` in `~/.claude/settings.json`, and API-key logins have no plan limits to show.
- **Tool windows, VS Code-style** — the rail on the far left opens **Files** (`⌘B` or `⌘⇧E`), **Changes** (`⌃⇧G`, with a count of uncommitted files), **Search** (`⌘⇧F`) and **Run & debug** (`⌘⇧D`) as windows on the landscape: docked at its edge, following the selected workspace, or placed beside a workspace and moving with it. Its **Sessions** icon (or `⌘\`) shows or hides the area tree, whose right edge resizes it. Select a pathlight workspace and Files and Changes show that worktree, a backoffice one and they show that one (each tree remembers its expanded folders). Files and diffs open in an **editor** column beside the side bar, as tabs: every file you click gets its own tab (up to 24; the oldest closes past that); staged and working-tree diffs of a file are separate tabs. Code is syntax-highlighted, diffs show inline or side by side, and **@** types `@path` into the focused session's prompt. Files are editable like in an IDE — undo, find and replace (⌘F), multiple cursors, bracket matching, folding, indentation that follows the file — and ⌘S saves. An unsaved file shows a dot on its tab; closing it, **Close all** (tab bar or Open editors) and quitting ask first. If an agent changes a file you're editing, you choose whose version to keep; saving never overwrites a change made since you opened the file without asking, and keeps the file's line endings and byte-order mark. Hover any editor button for what it does (@ types `@path` into the focused session's prompt; ⧉ copies the path). **`⌘P`** opens any file in the focused session's folder by typing part of its name (`name:42` jumps to line 42). Files opens with what changed since the last commit (files, +lines −lines, and a bar), then **Open editors**, then the tree — file-type badges, folder icons and indent guides, changed files colored (blue modified · green added/untracked · red deleted) and the folders holding them dotted. Changes works like VS Code's Source Control: the branch with ↑ahead ↓behind its upstream, **Fetch**, **Pull** (fast-forward only — never a merge commit or a rewrite; if both sides moved it says so and changes nothing) and **Push**. If a git action fails (fetch, pull, push, commit…), its error shows in Changes with **Ask the session to fix**, which types the error into that worktree's chat for the agent. A branch Mockingbird makes from `origin/dev` tracks `origin/dev` until its first push — so ↓ counts dev's new commits and Pull brings them in — and **Publish branch** always pushes it under its own name, never into dev. Then a commit box (⌘↵) whose ✦ button writes the message from the staged change (or everything, when nothing is staged) with the session's own agent, then **Staged changes** (the next commit) and **Changes** (edits not staged yet) with stage (+), unstage (−) and discard (↺ — asks first; new files go to the Trash) per file or all at once. **Branch vs origin/dev** (collapsed) lists everything the branch changed since it split off its `dev`/`main`-style base, commits included: what a pull request would contain. **Graph** draws the commit history of the branch, what it tracks and its base — merges and forks as lanes, branch and tag labels — and a commit opens to its files, each opening that commit's diff. A workspace's git line (↑ commits to push · ↓ commits to pull · uncommitted files) opens Changes. Live sessions' repository folders are watched, so the tree, change list, open files and each workspace's change count ("3 files · +120 −8" in its header — click it for Changes) refresh when a file changes, with a slow poll as the safety net. Files are addressed by session id + relative path, so the renderer can't read outside a live session's folder.
- **CLAUDE.md** — edit the global or any active repo's CLAUDE.md in-app; on save, every live session is told to re-read it. Busy sessions get the message when they finish their current task, so nothing is interrupted.
- **Broadcast** — send any instruction to all/selected sessions once, instead of repeating yourself.
- **Debriefs** — "Morning brief" / "4pm wrap-up" buttons (or auto-schedule in Settings) spawn an Assistant session in your WorkTracker folder that follows `instructions/morning.md` / `wrap-up.md`. Answer its interview questions right in the pane.
- **Run and Debug** (⌘⇧D) — runs the focused worktree's services (API, frontend, a Docker Compose stack) with live logs in a panel under the landscape (⌘J), status, clickable ports, and start / stop / restart per service or all at once. A repo's run setup lives in Mockingbird (per main checkout, shared by its worktrees, nothing committed): **Draft with Claude** reads the repo's launch configs, scripts, compose files and README — read-only, never its env files — and proposes the services, the ports, what a worktree needs copied in, what blocks side-by-side runs (with the one-line fix, and an "Ask the session to fix" button) and the sign-in redirect URIs to register; you review and save it. **Swap** runs one copy of an app at a time on its standard ports (starting it in one worktree stops it in the other); **Side by side** gives each running worktree its own slot of ports (+10 per slot). A port held by something Mockingbird didn't start is reported, never killed without asking. Compose stacks get a per-worktree override, so a worktree runs its own code and side-by-side copies get their own containers and ports. **Prepare** copies a new worktree's gitignored env files and certs from the main checkout and installs what's missing. Stopping takes down the whole process group; quitting Mockingbird stops everything it started. **Debug** (the bug next to a service) runs it under a built-in debugger: click a line number in the editor to set a breakpoint (kept per repo, so they apply in every worktree), and when it stops the file opens at that line with the controls in Run and Debug — continue, pause, step over / into / out, stop — plus the call stack, variables (expandable), watch expressions, the breakpoint list, and a Debug Console in that panel that evaluates in the paused frame. The program still runs on its own terminal, so its log is where it always is. Python services (FastAPI under uvicorn, scripts, `python -m …`) debug through debugpy; `--reload` is off while debugging. A dev server for a browser app (Vite, Next…) debugs in its own Chrome window per worktree — breakpoints in your TypeScript, mapped through the source maps — and other Node programs (`node file`, npm scripts, children followed) debug under Node, both through js-debug. .NET services (`dotnet run --project …`, ASP.NET included) build on their terminal, then run under netcoredbg with their output in the same log; hot reload is off while debugging. A server that hosts a Blazor WebAssembly client also opens a debug Chrome window, where breakpoints in `.razor` and client `.cs` code work through the Blazor debug proxy. Python inside a Docker container is debugged by attaching: Mockingbird mounts debugpy into the container (`$MOCKINGBIRD_DEBUGPY`) and publishes its port on loopback; the container's start command runs `python -m debugpy --listen 0.0.0.0:5678 …` when that's set (the draft lists the change). Debuggers are downloaded on first use and checked against their published SHA-256.
- **Token meters** — a pane's info row shows the tokens all its conversations have used and, while a 5-hour window is running, its estimated share of the limit ("1.2M · ≈18% of 5h"; hover for new input, output and cache). The status bar adds today's total, and the usage popover shows today per agent. Plans only report how full a window is, not its size in tokens, so a pane's share is estimated: its usage in the window over everything this Mac's sessions used in it, weighted by model (Opus output fills a window much faster than cached Sonnet input), times the window's reported %. Use outside this Mac isn't in its transcripts, so shares can read high. The group bar sums a group's sessions the same way (each conversation once, resumable sessions included), and a ticket's sum shows in the Dashboard's work-item dialog and the House ticket detail.
- **Context warnings and cost checks** — a pane's session past 75% of where its agent compacts by itself gets a chip in its pane header, next to the title (`ctx 79%`: amber; red past 90%), which opens a popover with what that means and the actions. Claude Code compacts 33k tokens below its window (2.1.310: a 20k output reserve plus a 13k buffer), so a 200k window warns at 125k and 150k, before Claude's own compaction at 167k; for Codex, its reported window stands in. **Compact** sends `/compact` only on your click and only to a session idle at its prompt — never mid-turn, on a permission prompt, or onto text you've typed there (the main process checks again); **Fresh session with a brief** opens the take-over brief of this conversation (task, latest plan, changed files, last turns, and the transcript's path), editable, with what it costs, and starts a new session in the same worktree and group; **Dismiss** hides it until the next threshold, or until the context drops and fills again. While Compact can't go (mid-turn, a permission prompt, a draft), the popover says why. Resuming a session asks first when its conversation is big and its cache cold: Claude's statusline says whether the prompt cache is warm, when it expires and how many tokens a cold request re-caches (`prompt_cache`); a cold re-read is priced as cache writes (1.25× input) against reads (0.1×), as a share of the 5-hour limit from this Mac's use of the window. It asks from 5% of the limit (or 150k tokens with no plan reading).
- **Search** — ⌘⇧F opens the Search view, over **Conversations** or **Files**. Conversations searches every Claude and Codex conversation on this Mac — open, closed, or never opened in Mockingbird — by what was said, the files it touched and the commands it ran. Each result opens where it lives: **go to pane**, **restore session** (a closed Mockingbird session), **open council** (a Council model's), or **open as session** (resumes it in its folder). The index (`~/.mockingbird/transcripts.db`) stays on this Mac, is built in the background on first launch (a few seconds), and keeps up as transcripts grow; tool output isn't indexed. Files searches the text of every file in the focused session's folder (git grep: tracked files plus untracked ones `.gitignore` doesn't exclude), with match-case and regex toggles; a result opens the file at that line. A search stops at 2,000 matches or 20 seconds and says so.
- **Ghosts and closed sessions** — after an app restart (an update, a reboot, a quit), each session is a ghost where it was, and **Reopen** relaunches it in its old folder and resumes **the exact conversation that pane last ran** (`claude --resume <id>` / `codex resume <id>`), not just the folder's most recent one — which matters when several chats started in the same folder. **Terminal panes remember too:** if you ran `claude` or `codex` inside a terminal, it comes back with that conversation resumed, and quitting it leaves you at the terminal prompt. Mockingbird learns each pane's conversation from the status hooks (every pane exports `MOCKINGBIRD_SESSION`, so events are matched to the right pane even when an agent `cd`s elsewhere); `/clear` moves it to the new conversation. Starting Claude in your home folder, it asks whether to trust the folder first, as it always does there. **Reopen all** in an area's ⋯ relaunches all of its ghosts; relaunched sessions keep their id, so they come back to their place and group. Closed sessions with no place on the landscape are in the **Closed sessions** list under the area tree, to reopen or forget. Renderer-only changes don't even need that — rebuild and hit `⌘R` (View → Reload) and the sessions keep running. **A pane's conversation stays in its pane:** Claude Code's background sessions (its agent view — `←` at an empty prompt, `/background`, `claude --bg`, `claude agents`) are off for every Claude Mockingbird starts (`CLAUDE_CODE_DISABLE_AGENT_VIEW=1`; a `claude` you start yourself in a plain terminal pane keeps them). A conversation moved there runs in Claude's own daemon, outside the pane: quitting Mockingbird leaves it running, its Mockingbird tools answer that the pane isn't running, and `claude --resume` refuses it or opens the background copy in the pane. If one is there anyway (moved before this, or from another terminal), resuming its pane first stops it there (`claude stop`; the conversation is kept) and says so in the pane — unless it's in the middle of a turn, when the resume says so and waits for you to try again.
- **Areas and stacks** — sessions sharing a ticket # group automatically, and each group is an area on the landscape. The side bar's **area tree** lists them, with their waiting counts and, inside each, its workspaces with their status dots: click an area to fly there, a workspace to bring it into view, double-click one to focus it; an area's ⋯ has **New session here…**. A team room's area is tagged as one, and the **Connected sessions** line under the tree opens a room's area and its chat, with the room's sessions and who's online (with several rooms, the list of them). Every workspace and area has a ⋯ (or a right-click) with everything it can do, in words (keyboard: the menu key or ⇧F10, arrows, Enter, Esc). Name a group `5038/backend` (or pick **New tab…** or `⌘G`) to put sessions in a **stack**: one card with a tab per session; a stack's ⋯ renames it or unstacks its tabs, and dragging a tab out unstacks that one. To move a session to another group, drag it into that area, pick **Move to area…** on its ⋯, or set the Group field in New Session; **Make area…** on a selection makes a new one. **Rename…** on a workspace's or an area's ⋯ renames it; double-click a stack's name to rename the stack.
- **Command palette & keyboard layer** — `⌘K` opens a palette with every action plus jump-to-session (waiting sessions show their reason and wait time). `⌘N` new session · `⌥⇥` next waiting session (oldest first) · `N` / `⇧N` through Needs you · `⌘E` focus the selected workspace (esc goes back) · `⌥` arrows select the nearest workspace that way · `⌘0` fit everything · `⌘1` 100% · `⌘G` stack · `⌘\` area tree · `⌘⇧B` broadcast · `⌘/` how-to-use popup (also auto-opens on first launch).
- **Dashboard (board)** — an ADO-style kanban read via the WorkTracker folder's `config.json` + PAT file. A filter bar scopes the board: an **"Assigned to" multi-select** (defaults to you — the PAT's owner — check any mix of people, "Unassigned" included, or Everyone; the whole project loads, capped honestly at the 200 most recent) and **column show/hide toggles**. Both persist. Columns are the team's board columns (or the work items' states when the board can't be read), and each column's cards are in **ADO's own order**: the team's backlog rank (Stack Rank or Backlog Priority, as the process names it), as on Azure Boards. **Drag a card up or down its column to reorder it, or into another column at the place you want** — a line marks the gap it will land in (its neighbours part a little to open it, under full motion), the card being dragged stays behind faded, and esc cancels; a focused card moves one place with **⌥↑ / ⌥↓**. A drop moves the card at once and writes it on that drop only: another column's state and Kanban column first, then its place between its new neighbours through the Work Items Order API; if ADO refuses, the card goes back with the error shown (or, when only the placing failed, says it moved but wasn't placed). The board is then re-read, so a reorder sticks after Refresh and a teammate's change made meanwhile shows. Clicking a card opens a **centered work-item dialog like ADO's**: title/description/discussion (read + **post comments**) in the main column, state and session actions in the sidebar — start a worktree session from the ticket (auto-grouped under its id) or attach an existing one. Starting a session offers **New branch** (fetches the freshest `origin/dev`-style base — auto-detected per repo, changeable — and branches off it) or **Existing branch** (local or origin), and by default **sends the ticket title + description to the Claude session as its first prompt** so it starts working with full context. Cards carry ADO's type colors, their tags, the board's card styles and tag colours, and show live session dots plus the assignee when viewing Everyone; blocked work is red, with a "N blocked" filter. The dialog edits a work item's **tags** — chips with a ✕, and **Add tag** suggesting the board's and the project's tags — and a card's right-click menu or the dialog can **Mark blocked** / **Unblock** (adds or removes the "blocked" tag; Unblock says so when the Blocked field or a card rule still blocks it). Tag changes are written on your click only, against the tags ADO has at that moment, and show at once (reverting, with the error, if ADO refuses). The PAT never leaves the Electron main process.
- **Selecting and copying** — releasing a selection copies it (a "Copied" toast confirms; "Couldn't copy selection" if the clipboard refused). For more than a screen: click where it starts, scroll with the wheel, and shift-click where it ends; or drag past a pane's top or bottom edge and it scrolls as you select. The wheel scrolls a pane's own history; it's only handed to the CLI when the CLI turns on mouse tracking. **Full-screen Claude** (`"tui": "fullscreen"`) turns mouse tracking on and selects and copies its transcript itself, so a plain drag in its pane is Claude's selection; **Option-drag** for a plain terminal selection of what's on screen instead (Claude's "option+click to native select" hint). Claude copies through the Mac's clipboard (`pbcopy`); a Claude running remotely or in a container, which can only ask the terminal to copy (OSC 52), can't reach your clipboard yet — Option-drag there. Claude Code and Codex wrap their text themselves at the pane's width, so a terminal selection in their panes (inline room sessions, Option-drag, Codex) would copy a long command as several lines: copying, on release or with ⌘C, joins the agent's own wraps back up — a path cut mid-word with no space, a wrapped sentence with one — and keeps real line breaks (`src/renderer/agentWraps.ts` has the rule; two real lines of code whose second's first word wouldn't have fit after the first are joined too). Pasting text always pastes the text, even when the clipboard also holds an image; an image alone lands in the prompt as [Image #1].
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
the Radley House board (against a fake House: each member's own token, claims
from a claimed ticket's branch), artifacts (files between members by hash —
from whoever has them, resumed, a corrupted copy refused — notes crossing
across a partition, repo references in a teammate's clone, the agents' tools
and secrets withheld), backups (peer to peer by default, never reaching
origin; the owner's opt-in to origin, its pre-push hook, and turning it off
again) and
take-over with the owner online (Hand over, Keep,
no answer, dropping offline mid-request), away or restarted, the old copy
stopping, its unsent changes sent and applied, and Take it back; take-over
with the owner's signed hand-over when they're online (forged, expired or
someone else's refused; the room's owner and admins asked too; an older
Mockingbird told to update; take-overs from before grants accepted once) and
none when they're offline (honoured on every log; one stamped while the
owner's Mac was connected to the taker refused and put back on every log; a
1.5 owner's sessions left alone; 1.5 away grants still loading), from a snapshot the owner
recorded (a planted ref on origin ignored and logged, a peer copy kept only
as the commit it named); backups to origin only for members who allowed it;
leaving and
removal (who may remove whom, what each Mac deletes, the Worker's revoke, and
an older Worker); room roles (each rule allowed and refused on receipt, migration of existing rooms, hand-over, the gone-owner claim and its contest, the chat's announcements, a 1.5.0 Mac beside a newer one, the Worker's roles); joining (only the owner's or an admin's add counts, rooms from before
keeping theirs; accept, decline, a request passed on to an admin while the owner is offline,
expiry; the Worker's door — knocking, the owner's or an admin's admit, deny — and an older
Worker); teammates' changes and migration numbers (folder detection, the next
number above every source, reservations clashing across a partition the same
on every member, the hook's hold-back and heads-up, the agents' tools fenced
with secrets withheld, release when merged or the branch is gone).
`test/teamWebrtc.e2e.test.ts` runs real WebRTC between two peer
hosts (skipped in CI). With `MB_E2E_APP=1`, `test/teamApp.e2e.test.ts` and
`test/teamLiveApp.e2e.test.ts` run two real Mockingbird instances in throwaway
homes (their windows open while they run): share, join (the owner accepting; then Nick made an admin from Ryan's right-click menu, accepting a third instance and removing it — at the Worker too — but refused removing Ryan
from its prompt), a terminal watched and typed into, chat, a package claimed,
a turn of a Claude stand-in backed up peer to peer (nothing on origin), a
session handed over from the owner's prompt, and taken over with no grant
once the owner has quit, from the copy that reached the taker, their copy
stopping when it starts again; and
migration numbers reserved through the agents' tools on one instance holding
back the other's file, with each side's uncommitted work a heads-up on the other. `MB_E2E_SIGNALING_URL=https://…` runs
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

Layout can be checked the same way: `pageDom` in `scripts/ui-preview.mjs`
renders a screen with `?measure=<selector>` and returns the page with where those
elements sit (`test/uiLayout.test.ts` checks that row actions, the Council's
inspector and its controls don't overlap; local only, like the screenshot test).

Context warnings: `?lsCamera=2000,0,0.6` has s5's heads-up (75%) on an idle workspace, `?lsCamera=0,0,0.6` s2's
firm one (90%), asking for permission; `?ctxPop` opens the first chip's popover, `?ctxBrief` goes on to Fresh
session with a brief, and `?lsFocus=s6&ctxResume` shows the cost check before a cold resume.
`?ctxAudit=idle|waiting|resume` clicks through them for `test/uiContextWarning.test.ts`.

Motion: `?motion=off|reduce|full` picks how much moves; screenshots and
`?measure` default to off, so they never catch a box mid-animation.
`?motionAudit` plays the animated moments (a dialog, a toast, the waiting
pulse), finishing each animation instead of waiting, and reports the end
states; `?motionMoments` does the same for the usage bars, teammates
connecting, chat arrivals and a session changing hands, logging every
animation started; `test/uiMotion.test.ts` reads them through `pageResult`, which runs
Chrome in real time.
`?termAudit` does what re-fits or moves terminals (side bar, bottom panel,
focus and back, another area and back, an area collapsed and opened, a stack's
tab switched, a waiting banner), then a Repaint and a relaunch in place, and reports any
terminal not at its holder's size or pty not told its terminal's size;
`test/uiTerminal.test.ts` reads it with motion full and off.

## Design system

The UI follows `design_handoff_mockingbird` (see the zip in this folder): warm dark
palette, Helvetica Neue for anything you click, JetBrains Mono (falls back to
SF Mono) for anything the machine produced, and one hard rule — **amber
`#e0a34a` means "a session needs you" and nothing else** (primary buttons
and the focus ring are neutral). Every text colour keeps 4.5:1 contrast on the
surfaces it sits on, in both themes (`test/contrast.test.ts` checks the tokens).
Status is always a
dot: teal working · amber waiting (pulsing for ~10 s) · grey idle · red dead.
Motion is "Fluid" (tokens in `styles.css`, helpers in `motion.ts`): only transform and opacity move, nothing waits on an
animation, and Settings → Motion (or macOS Reduce motion) cuts it to short
fades. Not yet
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

- **Take-over while the owner is offline, with no grant** (1.6.0) — any room
  member takes over an offline teammate's session without asking; an online
  owner is still asked first, whoever takes it. The owner's Mac keeps when
  it was connected to each teammate and refuses a take-over stamped while it
  was connected to the taker, with a signed event every member's log applies,
  so they all agree who holds the session. Settings → Team's **While I'm
  away** grant is gone; logs with 1.5's grants still load. Needs both
  teammates on 1.6.0.
- **Phone alerts** (for 1.6.0) — an iMessage to yourself when a session
  waits on you (a permission prompt or a question) or finishes while you're
  away: the screen locked, or no input for 5–60 minutes. Sent through
  Messages with AppleScript; it names the session, its ticket or group and
  what it waits on, never what an agent wrote. One per session per 10
  minutes, one per prompt, close ones batched; quiet hours and muted sessions
  apply. Opt-in replies (they need Full Disk Access — for Mockingbird and
  everything its panes run — said before it's granted; room sessions' agents
  are denied `~/Library/Messages` and `~/Library/Mail`, though a Claude
  session's shell commands aren't covered yet): `K4 1` allows that prompt once, `K4 2` denies it, `K4` and a
  message types into a finished session — only from your conversation with
  yourself, only after the alert, only while it's the same prompt; each in the
  remote-activity log and shown in the pane. Settings were mocked as three
  options (rows with an explainer, setup steps, settings beside a live preview
  of the conversation); the live preview is built, the others kept as mocks.
- **Context warnings** (1.6.0) — before a session reaches its context limit, a
  chip in its pane header says so: amber at 75% and red at 90% of
  where the agent compacts by itself (Claude Code 2.1.310 compacts 33k tokens
  below its window: about 167k of 200k, 967k of 1M; Codex's window stands in
  for its own limit). **Compact** sends `/compact` on the click, only to a
  session idle at its prompt with nothing typed there; **Fresh session with a
  brief** starts a new session in the same worktree from the take-over brief
  of this one (no model call; the whole transcript is pointed at);
  **Dismiss** holds until the next threshold. The chip opens a popover with
  these actions.
- **Usage per group and ticket, and a cost check** (1.6.0) — the group bar
  sums its sessions' tokens (each conversation once, resumable sessions
  included) with each agent's estimated share of the 5-hour limit; the
  Dashboard's work-item dialog and the House ticket detail show the ticket's.
  Resuming a big conversation whose cache has gone cold asks first, in plain
  words ("Resuming this re-reads about 380k tokens, roughly 7.5% of your
  5-hour limit"), and a fresh session from a brief shows what its brief costs
  before it starts.
- **Typing consent and the remote-activity log** (1.5.0, from the security
  review's R1, R2, R5) — teammates' copies of your room sessions are
  view-only until you allow typing (this session, or 15 min; revocable from
  the pane header); never while your agent asks for permission. Agent messages
  wait out permission prompts and are stripped of control characters. One
  audit log of remote actions, shown in Settings → Team. Prompt and indicator
  were mocked as three options (in-pane banner, docked strip, dialog); Ryan
  picked the docked strip with a teal outline around the pane.
- **What's new** (1.4.11) — click the version next to
  "Mockingbird" in the top bar: this version's changes, each tagged New, Fix,
  Polish or UI, then fold-outs for earlier versions (back to 1.0.0), what's
  coming next, and the suggestions filed so far with their status (open, on the
  roadmap, shipped, declined). The first launch on a new version reads
  "Updated to 1.4.11" and opens it once; dismissing it goes back to "v1.4.11".
  **Suggest something** files a GitHub issue on the Mockingbird repository,
  labelled `suggestion`, through your own `gh` sign-in, after showing exactly
  what will be posted and that everyone with access to the repository can see
  it; without `gh` or a sign-in it says how to fix that and offers **Copy
  suggestion**. The notes live in `src/shared/changelog.ts`, one entry per
  version bump.
- **Dashboard: tags and blocked work** (1.4.11) — board cards
  show their work item's tags (three, then "+N"; all of them in the tooltip
  and the work item's dialog). Blocked work is marked in red, with a Blocked
  chip and a "3 blocked" filter in the header: a "blocked" tag (or one like
  "blocked-by-crm"), the CMMI Blocked field, or a board style rule for it.
  The team's own card styles and tag colours are read from Azure DevOps
  (read-only) and applied where their conditions can be checked exactly
  (tags contain, field =), in colours kept at 4.5:1 in both themes; the
  rest are listed as not applied. Without them, blocked work is still marked.
  Tags can be changed from the Dashboard: the work item's dialog shows them
  as chips with a ✕ and an **Add tag** field that suggests the board's and
  the project's tags, and **Mark blocked** / **Unblock** (the card's
  right-click menu, or the dialog) adds or removes the "blocked" tag. Each
  change is written only on your click, re-reading the item's tags just
  before so a teammate's new tag isn't lost; tags dedupe case-insensitively,
  as in ADO. The card, its Blocked styling and the "N blocked" count change
  at once, and go back with the error shown if ADO refuses. When the Blocked
  field or a card rule is what blocks an item, Unblock says so instead.

- **Repaint keeps the scrollback; a relaunched pane gets its size** (not yet
  in a release) — Repaint no longer resets the terminal: it asks the session
  to redraw by a resize round trip, so an inline room session's history, a
  full-screen agent's alternate screen and its mouse scrolling all survive it
  (a full-screen agent's screen is cleared for its redraw). A session
  relaunched in place (Restore all, a dead pane's Relaunch) gets a fresh
  terminal, and every new terminal tells its pty its size on its first fit:
  the new pty had stayed at 120×32 under the pane's terminal until a Repaint.
  Terminals never fit to a holder with no area.

- **1.4.9: fewer merge conflicts between teammates** — migration numbers are
  reserved before an agent adds one (`reserve_migration_number`, shown on the
  House board; an unreserved new migration is held back once), an agent
  editing a file a teammate's session is also changing — committed or still
  uncommitted on their Mac — gets a heads-up naming that session, and agents
  can list teammates' changed files and read a file's diff. Room worktrees get
  their `.mockingbird/` files whether or not the room has a House project.

- **Motion** — one personality, "Fluid" (120/200/300/460 ms, the genie 480 ms, a critically damped
  spring, no bounce), with the genie for minimize: a workspace's folder in the
  side bar is open while it's on screen and closed while minimized; minimizing
  flies the pane into the open folder and the lid closes after it, restoring
  opens the lid and the pane comes back out (collapsed side bar: the rail's
  Sessions icon). Panes open, re-arrange and go fullscreen in place; group
  switches come from their side of the side bar; dialogs, menus, popovers and
  toasts ease in and out, closing at once (the exit plays on a copy); session
  rows slide to new places; arriving at waiting pops the dot once, and the
  pulse stops after ~10 s. Grid changes are View Transitions over snapshots, so
  terminals never animate and re-fit once; the side bar and file panel no
  longer animate width. **Settings → Motion**: Follow macOS / Reduce (fades of
  120 ms or less, no View Transitions, no loops) / Full. The genie and the
  grid's View Transitions went with the grid.
  Round two (1.6.0): the usage popover's bars spring to a new value only on a
  real change of a point or more, never on a poll that moved nothing; a
  teammate connecting or leaving turns the Connected line's dot and their
  initials in the room's chat, and their pane's owner badge crossfades; a
  teammate's new chat message slides up (your own, history and a burst of
  catching up just appear); a session that just changed hands — handed over,
  or taken over here — pulses its pane's ring once, over the terminal, and the
  note saying so eases in. Under Reduce those are fades or nothing.
- **UI review, first batch** — primary buttons and the focus ring are neutral,
  so amber means only "waiting on you" [G1]; every text colour keeps 4.5:1 on
  its surface in both themes, checked from the tokens [G5]; one disabled-button
  style that says why [G2]; a visible focused pane [P4]; the Team badge as a
  count [S4]; "↻ Restart N" [T2]; "e.g." placeholders [G6]; dialogs keep their
  title and buttons in view [H4]; the # completion fits [R4]; copy and labels
  [P7 C2 C3 C4 N1 N2 SET2 SET3 SET5].
- **A quit always finishes** — Electron acts on only the first SIGTERM,
  SIGINT or SIGHUP, so after a quit that didn't finish (the unsaved-changes
  question, with no one to answer it) the next `kill` did nothing. Now every
  signal quits; a second one while quitting exits at once; a signal doesn't
  stop to ask about unsaved editor changes (it logs that they were dropped);
  and a quit still running after 30 s is forced: the rest of the quit steps
  run, every pane's pty is killed, and the app exits. Each quit step runs on
  its own, so one that fails no longer skips the panes' shutdown or Update's
  installer. No pane starts once the quit has begun, since a pty started then
  would outlive the app. `main.log` notes each quit (`quit: …`). The
  two-instance tests kill every instance they start, with what it started,
  when its test ends (timed out included), and an instance quits by itself
  once its test process is gone.

- **1.4.7 UI fixes** — a session row's actions sit at the end of its title
  line, as icons with tooltips, never over its other lines or their buttons; a
  narrow council's details float over the discussion only, so Thread/Rounds,
  Run and Send stay in reach; the House token is asked in one place at a time
  (the board while it's open, else a toast); the guide (⌘/) covers today's
  rows and every tab; a CLAUDE.md read that fails outright shows its error.

- **Panes keep their Claude conversations** — Claude Code 2.1.29x can move a
  session to its background (`←` at an empty prompt, `/background`), where it
  outlives the pane: after an Update the pane came back blank or wouldn't
  resume, and the session's Mockingbird tools were gone. Claude panes
  now start with Claude's agent view off, and resuming a pane whose
  conversation is in Claude's background stops it there first and says so in
  the pane (not mid-turn: then the resume says why and waits).
- **Council** (was Collaborate, renamed so its councils aren't confused with
  team rooms; saved councils carry over) — models discuss an idea with you;
  per-model effort and access (none · read · run · docker), a disposable test
  copy, approvals in the discussion (with a Dock count, tab badge and
  reminder), plans you approve before anything is implemented; edited from
  the council's sidebar.
- **In-app updates** — Check for updates against the private repo (via the
  GitHub CLI), then Update pulls and builds in your clone and restarts into it,
  bringing your sessions back.
- **Dashboard = your real ADO board** — columns, order and state mapping
  read from your team's Azure Boards board (pick among its boards); cards sit
  in the column ADO recorded, and dropping one sets that column (and its
  state). A Columns list reorders and hides columns per board.
- **Drag and drop shows where things land** — an outline or a line on the
  side, a label saying what the drop will do, and edge scrolling; for
  sessions, panes, board columns and cards, and Council models.
- **Search every conversation (⌘⇧F)** — a local index of every Claude and
  Codex transcript on the Mac (open, closed, or never opened in Mockingbird):
  what was said, the files touched and the commands run. A hit opens where it
  lives — its pane, the closed session (restored), its council, or a
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
  "Open a session here", and extra panes flow into rows below. (The grid,
  pins and snap layouts gave way to the landscape.)
- **Token meters** — each pane's tokens across all its conversations, and
  its estimated share of the current 5-hour limit ("1.2M · ≈18% of 5h");
  today's total in the status bar and, per agent, in the usage popover.
- **Context window** — the usage popover shows how full the focused
  session's context is ("275.6k / 1M (28%)"), for Claude and Codex panes.
- **Split layouts, no empty tiles** — each group's grid is a split tree, as
  in VS Code: panes always fill it (a closed pane's neighbours take its
  space; leaving fullscreen goes back to the layout). Drag a session onto a
  pane's edge to split it there — halves beside one pane, thirds beside two —
  or onto its middle to swap, or open it as a tab; a tab dragged out of a
  workspace gets a pane of its own. While dragging, a preview animates the
  layout the drop would leave; the terminals only resize on the drop. Snap
  layouts and ⌘⌃1–4 arrange the panes once, and pane numbers read top-left
  first. Old templates and column counts carry over. (The landscape replaced
  the grid; its first launch reads these layouts in.)

### Now

- **The landscape and its wires** ([design](docs/landscape.md),
  [build plan](docs/landscape-phase1.md), [wires](docs/landscape-wires.md)) —
  the landscape has replaced the grid: workspaces, areas, stacks, tool
  windows, ghosts, Needs you and reading the grid's layout in are built, and
  the grid's code is gone. Wires between workspaces (handoff, context link,
  feedback loop, shared worktree, with gates and pipelines) are being built
  in their own slices: their book, delivery and drawing them on the landscape
  are in; making them and the send popover are next. They ship with the
  landscape in 1.7.0.
- **Team rooms** ([design](docs/team-rooms.md)) — a group shared live with a
  teammate's Mockingbird. Built and tested end to end on one Mac; next is the
  first run between two laptops through the deployed Worker.
  - **Connecting:** each install has a key pair and a display name (Settings →
    Team; `npm run team:fingerprint`; the private key in an owner-only file).
    Laptops connect peer to peer over WebRTC
    (in a hidden window), introduced by a Cloudflare signaling Worker
    (`signaling/`, deployed once; only fingerprints in its `ALLOWED_CREATORS`
    create rooms) with Cloudflare TURN as the fallback relay. Every connection
    detail is signed and each certificate pinned. A room is a shared group (⇪
    shares one; New/Import Session → Connected → **+ New room** makes one and
    starts the session in it, then shows the invite code; Join a room… — in the
    Team tab, New/Import Session → Connected, or ⌘K — takes a teammate's code);
    every member keeps its signed, ordered event log and merges it on reconnect.
  - **Room roles:** each room has one **owner** — its creator, until they
    hand it over — any number of **admins** the owner makes, and members. The
    owner does everything an admin does, makes and removes admins, hands over
    ownership, and alone sets where backups go and the room's House project.
    Admins accept or decline joins, remove members (never the owner or another
    admin) and set the room's rules (the migration check). Roles show as chips
    by each name in the Team tab and Settings → Team; right-click a teammate in
    the Team tab (or use the links in Settings → Team) for **Make admin**,
    **Remove as admin**, **Hand over ownership…** and **Remove from the
    room…**. Every change is a signed room event each Mac checks, and the chat
    says so ("Ryan made Nick an admin"). The owner hands over before leaving
    (Leave room… asks to whom). An owner gone for good: once they haven't been
    heard from in the room for 14 days, the longest-standing admin can claim
    ownership, announced to everyone; the old owner can take it back whenever
    they're back, and can't be removed for 14 days after the claim. Roles
    give no way past a session's owner: an online owner is always asked
    first, and a session is any member's to take — whatever their role — only
    while its owner is offline (below).
  - **Joining needs the owner or an admin:** any member hands out codes, but
    only the room's owner or an admin lets someone in. They get a notification
    and a prompt — "Nick wants to join #5101", with Nick's fingerprint to
    check with him and who invited him — to **Accept** or **Decline** (or
    answer later from Settings → Team, where requests wait under the room). A
    code from a member is sent to the owner and admins for approval (held
    until one of their Mockingbirds is online; whoever's around answers); the
    joiner sees "Waiting for Ryan or Nick to accept", then joins or is told it
    was declined, and gets nothing of the room meanwhile. The signaling Worker
    holds joiners at its door until the owner or an admin admits them
    (redeploy it to get this, and for admins' admits and removals to count
    there; an older Worker still works, and the app says so). The chat says
    "Ryan accepted Nick", and members are notified.
  - **Leaving and removing:** **Leave room…** (Settings → Team, or the Team
    tab's ⋯) tells the teammates online, has the signaling Worker cut your key
    off, and deletes the room from your Mac — its folder, chat read marks,
    mutes, the room's files in your worktrees, its artifacts, hidden refs and
    any backups you pushed to origin; the group stays
    as an ordinary one, its sessions running. The room's owner, or an admin
    (for members), can **Remove…** a teammate: every Mockingbird drops them and forgets what it
    had of their sessions, theirs deletes the room when it hears, and the
    Worker cuts them off (an older Worker says to redeploy it). Coming back
    takes a new invite; what couldn't be cleaned up is listed in a notice.
  - **Sessions:** a session in a shared group is one row and one workspace on every
    member's Mockingbird; its row says whose it is and who's looking in words
    ("Nick's session · live · Nick is in it"). The rooms and their sessions
    live in the **Team room** view: with one room it opens on that room (its
    sessions, artifacts and chat), with several on the room list, each room
    with its presence ("Shared room · Nick online"), its sessions and labelled
    actions (Chat, Board, Invite, New, More); a session row there shows its
    buttons while hovered, focused from the keyboard, or the pane you're in.
    The area tree lists your own room sessions in their area, and one
    **Connected sessions** line ("Connected sessions · 4",
    who's online) that opens the Team room view. Start one from a room's **New**, or New session →
    Where → **Connected** (it lists your rooms, who's online, and offers the
    repo the room works in; **+ New room** shares a new group first, keyed by
    a leading ticket number: "5120 Donor search" is group 5120). It streams to
    whoever shows it, its row names who's looking,
    Follow brings what a teammate selects into view, and everyone hears when it waits.
    A teammate's copy is **view-only**: typing into it (or **Ask to type**)
    asks the session's owner, whose pane shows a strip under its header,
    "Nick wants to type in “Export API”" — **Allow for this session**,
    **Allow for 15 min** or **Deny**. While Nick can type, the pane is outlined
    in teal and its header shows "Nick can type" with ✕ to take it back. The owner's Mockingbird enforces it, so a modified client can't skip
    it, and even an allowed teammate's keys are refused while the owner's
    agent asks for permission: approvals are always the owner's. An older
    Mockingbird typing in is refused with the reason (the connection stays).
    Agent messages from teammates never answer a permission prompt either:
    they wait until it's answered, and their text can't end the paste early
    (control characters are stripped). **Settings → Team → Recent remote
    activity** lists what teammates did on this Mac — typing asked, allowed
    and refused, keystrokes counted, agent messages, take-overs, files and
    backups — from `~/.mockingbird/team/audit.log` (owner-only, append-only,
    rotated), which never holds what was typed or said.
    Scrolling a teammate's session scrolls only your copy: room sessions run
    Claude Code and Codex inline, so their history — everything the terminal
    keeps, not just the screen on view — is in every copy's scrollback
    (Settings → Team turns that off per Mac). Room
    sessions start knowing the room's House board and artifact tools and
    unable to read secret files:
    Claude through permission rules, Codex (0.138+) through a sandbox set by
    `-c` on that launch alone, enforced on every command it runs: it commits,
    stashes and installs packages, but can't read logins or push — pushing is
    yours. Commits in turns a teammate typed into credit them with
    Co-authored-by.
  - **Backups and Take over:** after every agent turn a room session's worktree
    (ignored and secret files left out) is snapshotted to a hidden ref,
    `refs/mockingbird/rooms/<room>/<session>`, and sent peer to peer to
    connected teammates with its conversation, which never goes to git.
    Backups stay off GitHub by default: only the room's owner can turn on
    **Also back up to GitHub** (Settings → Team, per room, after a warning),
    which makes it available; each member is then asked once — **Back up my
    room sessions to GitHub (origin)?** Allow / Not now, kept on their Mac —
    and only those who allow it push their snapshots to that hidden ref on
    origin, through the repository's pre-push hook, so a session can be taken
    over while its owner's laptop is off; turned off, by the room's owner or by a
    member for their own, what was pushed is deleted.
    Rows and panes say where each backup is ("copied to Nick 2m ago",
    "backed up 2m ago"). **Take over** continues a teammate's session on your
    laptop from the newest snapshot that reached you (saying how old it is,
    and that newer work may be on their laptop), on its branch, as a new
    conversation on your account that starts from a handover brief (the task,
    its plan, the changed files and the last turns, built without a model
    call) rather than re-reading theirs, with their whole transcript saved in
    the worktree's git-excluded `.mockingbird/takeover/` for it to read when it
    needs detail (deleted once that session is done with it: taken back,
    closed, its backup dropped, 14 days without a turn, or you leaving the
    room); taking your own session back resumes your own conversation,
    briefed on what they did. **A connected owner is always asked first**
    — whoever takes over, the room's owner or an admin too ("Nick wants to
    take over “Export API”": **Hand over** / **Keep it**, kept after 2
    minutes unanswered): handing over lets their turn finish, sends that exact
    backup straight to you with their signed hand-over and stops their agent.
    **An offline owner's session is any member's to take**, without asking;
    the owner's Mac, which keeps when it was connected to each teammate,
    refuses one taken while it was connected to the taker (2 minutes' leeway
    for clocks), and every member's log puts the session back — their agent
    never stopped, the taker's copy stops. A take-over under a 1.5 away grant
    is checked the same way. Every Mac checks the hand-over, so
    a take-over with neither — an older Mockingbird's, say — changes nothing on
    the owner's Mac, which says so in the room. Taking over an offline owner's
    session needs both on 1.6. The snapshot it starts from is one the owner's signed room log
    names: a backup ref someone else pushed to origin is ignored.
    An owner who was away stops their copy as soon as their Mockingbird is back
    (or started): its worktree stays untouched, its pane says "Continued on
    Nick's laptop" with **Take it back** (the same take-over, in reverse) and
    **Close**, and when it has changes the taker never got it says so and
    **Send to Nick** delivers them as a patch he reviews and applies — never
    applied by itself. With backups to GitHub on, anyone who can read the
    repository can fetch backed-up work in progress; a backup is deleted once
    its session is forgotten, merged, idle for 14 days, or taken over and
    backed up again.
  - **Team room chat:** a thread per room (the **Team room** view, the **Room
    chat** chip) with @mentions, agents' updates (turns, waits, take-overs,
    board changes), `list_sessions` and `send_message` across laptops, and
    **@assistant**, answered on the asker's laptop.
  - **Artifacts:** files and screenshots, notes anyone edits, repo file
    references (a file and lines at a commit, opened in your own clone) and
    links, kept in the room — in the Team tab's Artifacts section (+ Add, drag
    and drop, paste), `#`-mentioned in chat as chips, opened in a viewer (PDFs
    and other files in Quick Look; nothing is ever run). Files go peer to peer
    by hash, never through git or the log, checked before they're kept, 25 MB
    each; notes that crossed an edit are kept as a copy, not lost. Room agents
    read them with `list_room_artifacts` / `read_room_artifact` (images and
    PDFs as a git-ignored, quarantined copy in their folder, never written
    through a symbolic link there), @assistant sees them in its prompt —
    names quoted, content fenced as a teammate's — and anything named like a
    secret, from one of this Mac's credential stores (`~/.aws`, `~/.netrc`…)
    or holding a private key (file or note) is asked about before it's added
    and stays, like any copy of it, unreadable to agents. Removing an
    artifact doesn't take it back: the room log keeps its name and every note
    text, for later joiners too.
  - **Radley House board** (the kanban-board icon: **Board** on a room in the
    Team room view and in the group bar): the room's House project (its owner's
    choice) as columns like the Dashboard's — Ready, In progress, Review,
    Validating, Done (folded), with Parked folded into a row above and
    Dropped behind a toggle — holding the open backlog (every ticket not done
    or dropped) and the room's own tickets, each once, in the House's
    priority order, with a "Needs an agent" filter; `needs-human` tags,
    blocked and waiting tickets in red, your own with a teal edge; who has
    each, a ticket's history ("Ryan · status → review"). Drag a card to
    another column (or ⌥← ⌥→) to change its status in the House: into In
    progress claims it (asking for the branch on the card), back to Ready
    releases it, Done and Dropped refuse it (only House staff close
    tickets), and a move the House refuses goes back with its reason. Also
    claim, release, comment, post progress or a question, create tickets.
    **Start session** on a ticket (the card's Start, its right-click menu, or
    the ticket's own button) does the rest in one go, after a small
    confirmation of the repo, branch and agent: it claims the ticket as you,
    makes its branch's worktree (the ticket's own branch, your claim's, or
    `feature/<n>-<slug>` cut from the repository's base on origin) in your
    clone of the room's repository, and starts Claude or Codex there in the
    room's group, briefed
    on the ticket — number, title, status, priority, tags, detail, acceptance,
    blockers, links — fenced as the House's words, not instructions. A ticket
    a teammate has, or a repository not cloned here, stops it before anything
    is written (and says who, or which repository); a worktree that can't be
    made releases the claim it made.
    The House is the system of record: each member's
    Mockingbird reads and writes it with their own builder token
    (`~/.config/radley-house/<project>.env`), which never leaves the main
    process — and only once that member has allowed it for the room ("Use
    your <project> builder token for room <name>?", asked once per room and
    project — on the board while it's open, otherwise in a toast). Agents use the `*_house_ticket` tools: reads run on their own,
    and every write (create, claim, release, post) waits for its owner's OK
    in the agent's own permission prompt in the pane. The files a teammate's
    sessions changed on a ticket they claimed are theirs: an agent's first edit
    of one is held back once with a warning ("Nick's ticket #141 has been
    changing this file"); a teammate's pushed branch that changes your files
    shows on the pane ("Nick's branch also changes …") and opens the board.
    It replaced the work-package plan board (`mockingbird/plan` is no longer
    pushed; old branches are left alone).
  - **Teammates' changes and migration numbers** — fewer merge conflicts
    between teammates' branches in one repository. An agent's first edit of a
    file a teammate's room session is also changing — on its pushed branch, or
    in the uncommitted work its last backup brought to your Mac — comes with a
    heads-up naming that session, ticket and branch ("coordinate with
    send_message"), from the agent's own PreToolUse hook (Claude's Edit/Write,
    Codex's apply_patch), again only after 30 minutes; the pane's chip says
    "Nick's work also changes …". `list_teammate_changes` and
    `read_teammate_diff` let agents look (fenced as teammate content, secret
    files' diffs withheld, cut to size). Numbered migration folders
    (`db/migrations/0024_x.sql`, `V25__x.sql`, `20261012_x.rb`) are found by
    themselves; an agent reserves the next number with
    `reserve_migration_number` — above every number on the base branch
    (fetched first), teammates' branches and shared work, your worktrees and
    every reservation — and a new migration file whose number isn't reserved
    for its user is held back once. Reservations are signed room events,
    shown on the House board ("Migrations: 0025 Nick (#447), 0026 Ryan
    (#453)"), released by hand or once their number is on the base branch or
    their branch is gone. The room's owner or an admin can turn the hold-back off, or name
    a repository's migration folders, in Settings → Team. Live reservations
    are capped (5 per member and folder, 20 per member, 100 per room), one
    more than 20 above the folder's highest migration is ignored, and Codex
    asks before each reservation.

### Next

Four phases, in order. UI-heavy items get 2–3 mocked options to pick from
before they're built.

**Phase 1 — reliability** — done: the artifact fetch retry race (1.4.10),
Settings checks that hung on "checking…" (1.4.12), tests leaving nothing
running (1.4.12), motion measured in the real app (1.4.12).

**Phase 2 — the daily workflow**

**Room roles, the rest** (roles themselves shipped in 1.6):
- **Closing the room** (the owner's): not built yet — today the owner removes
  everyone and leaves.

**Tooling profiles** — what Mockingbird adds to an agent, adjustable per project
so rules that fit one repo don't get in the way in another. Decided:
- Covers normal sessions and rooms. Settings live on this Mac (per repo) and in
  the room (signed, admin-set); a committed repo file (`.mockingbird/tooling.json`)
  is a later option, kept in mind but not built.
- The room's owner and admins set the room's rules; each person can quiet notes and
  heads-ups for their own agents only, never loosen a guard for anyone.
- Editable: **tools** on/off (House, artifacts, migrations, teammate changes,
  messaging); **guard strength** per guard (off · note · hold back once · block —
  claims, migrations, overlaps); **instruction text** agents read, with a preview
  of exactly what an agent sees. Launch rules (Codex push/network, pre-allowed
  Claude tools) stay fixed for now.
- Locked: secret-file blocks, the House-write approval and token consent can't
  be loosened by any profile.
- Presets to start from ("Radley House project", "Plain repo", "Strict",
  "Light"); every room change shows in its chat ("Ryan turned off migration
  hold-back"). Settings UI is mocked as options first.

**Phase 3 — coordination**
- A ticket's House status follows its PR (opened → review, merged → onward).
- Ticket pipeline stages update themselves from the work and ADO: a session on the ticket's branch → Coding, a PR to dev/UAT or main → PR stages, a merge → the testing stage after it, and the ADO board column. Each automatic move shows why; you can still set one by hand, and the drafted ADO comment still waits for your click.
- Ask a teammate to review a session's changes; their line comments go back to your agent.
- A prompt queue: line up instructions that send when a session goes idle.
- A daily room digest of what each member's agents did (commits, tickets moved, sessions finished), without a model call.

**Phase 4 — polish and extras**

The rest of the 1.4.7 UI review (its ids in brackets). Decided: a room gets tabs (R1).

**Look and feel**
- [G3 G4] A four-step type scale with nothing under 11px; mono only for code, paths, numbers and keys.
- [G7] Raw git and fetch errors become short chips, the full text in a popover with Copy and Retry.
- Labelled controls everywhere: Explorer, Source Control and Settings rows still use bare glyphs (✎ ✕ ⇪ ⤷).

**Landscape, side bar and bars**
- [P2 P3] Workspace headers: the title keeps ~40%, warnings merge into one chip.
- [P1] A responsive metric strip in the workspace footer.
- [S2] Two-line rows in the area tree: title, then branch · owner; backup and live state as glyphs.
- [S5] One Tab stop in the area tree (roving tabindex); area rows focusable.
- [T1 T3] One New session button with Import in its menu; the status bar in three clusters.
- The top bar overflows the window below about 700px wide (Import and New/Import Session run off the edge).

**Team, House and side views**
- [H3] The House board's problems in one banner, raw detail behind an expand. (H1: the board became status columns.)
- [V1] A session picker in Files, Changes and Run & debug (today they follow the selected workspace, or the one they're placed beside).
- [D1 W1] Dashboard columns flex to fill; WorkTracker as cards for its three debriefs.

**Bigger**
- [R1] A room in the Team tab gets tabs — Chat · Sessions · Artifacts · Board — with the chat's composer pinned at the bottom.
- [P6] The landscape in narrow windows: what the side bar and docked tool windows give up first.
- [SET1] Where Control room lives (a Broadcast action, or Settings → Tools).

### Later

- **Away mode** (parked): the take-over brief ready before you leave, and
  your sessions saying a teammate can take over in one click. Taking over
  while the owner is offline needs no grant from 1.6, so the 1.5 away grant
  is gone.
- **Signed + notarized builds.** Updating is covered by the in-app Update
  (pull, build, restart). What's left needs an Apple Developer ID: no
  right-click→Open for new users, and updates that install in the background.
- **Room identity key in the Keychain** (security review R3), once builds are
  signed: built (sealed with Electron's safeStorage, moved keeping its
  fingerprint) and held back because an unsigned build is asked to use its
  Keychain item after every update, and a moved key can't be read by an older
  Mockingbird (which would make it a major release).
