# The Assistant

Ask Mockingbird to do things in plain words: "restart api-fix in plan mode",
"put the atticus workspaces together", "what's waiting on me?", "when tests
finishes, start the review". You ask in the Assistant's tab on the side
bar's rail (⇧⌘A), or from ⌘K, and keep asking there. The tab shows its steps
live, an Undo on each change it made, a confirm card for each change it
wants to make, and your standing rules.

Decided with Ryan, 2026-11-16: mockup 3 (⌘K, then a docked sheet), all ten
ability groups and standing rules in the first version, low-risk changes
direct with Undo, everything else on a card. The sheet became a rail tab
with its own message box, and the thread is kept across quits.

The room's `@assistant` (team-rooms.md → Team room) is a different thing and
stays as it is: it answers questions in a room's chat and has no tools,
because teammates write that chat.

## How a turn runs

- **One headless Claude turn per question**, on this Mac, under the user's
  own Claude Code account (`claude -p`, 180 s cap), on the model Settings →
  Assistant names: Sonnet (the default, faster) or Opus (smarter). It has
  **no built-in tools** (`--tools ""`) and **only Mockingbird's Assistant MCP
  server** (`--strict-mcp-config --mcp-config …`, `--allowedTools` limited to
  that server's tools). It saves nothing (`--no-session-persistence`). Codex
  isn't used: even read-only, its sandbox can read files.
- The prompt holds the Assistant's rules, the last 8 turns of the tab's
  thread (your words, its replies, what its steps did), so "those" and
  "them" work, and a compact snapshot: sessions, groups and rooms, one line
  each. Anything more it reads with its tools.
- Turns run one at a time. A question asked while one runs waits its turn,
  and the tab says so. Clear in the tab's header starts a fresh thread.
- Needs Claude Code installed. Without it, the Ask row says so and does
  nothing.

## Tiers: main decides, never the model

Every tool has a tier, fixed in main's registry. The model can't change it.

| Tier | What happens on the call | Examples |
|---|---|---|
| **read** | Runs and returns data | list sessions, what's waiting, usage, git status, why it's stuck, a session's output, files and diff, a pipeline's stages, held plans |
| **direct** | Runs, and its step shows **Undo** while what it changed is unchanged since (10 min, in memory) | focus, move/stack/size/arrange, move to a group, create/rename a group, rename, mute, an area's colour, open or close a tool window, view and notification settings, draw, move or remove a wire and change its settings, edit, insert or remove a step that hasn't started, a step's or closed session's model, re-lay out a pipeline |
| **confirm** | Nothing happens: a **card** appears in the tab, and the call returns "card shown, the user decides". It runs only when the user presses **Do it** | restart (permission mode, model, effort), close, resume, type into a session, broadcast, allow/deny a prompt, start sessions/worktrees/templates/reviews, hand off, git cleanup/push/PR, room actions, moving a session across a team room's boundary, approve a gate, a wire that sends without asking, a running session's model, forgetting a running or closed session, laying out or dismissing an Orchestrator's plan, create, change or turn on a standing rule, settings that change what agents may do or what reaches past this Mac |

- A card names the exact target and effect ("Restart “api-fix” · s5 ·
  atticus in Plan mode: stops its agent and starts it again on the same
  conversation"), and lists its warnings: uncommitted changes, unpushed
  commits, mid-turn, and the danger color for bypass permissions or deleting
  a worktree.
- **Sessions by id**: every card names a session as its title, its id and
  its group, else its folder (`lookup.ts` sessionRef). Titles are changed by
  the model, agents and teammates, and two sessions may share one.
- **The payload whole**: what a card types, sends or publishes is in its
  body, every character of it, shown as plain text in a scrolling monospace
  block (never HTML): a message or broadcast (up to 4,000), a first prompt
  (8,000), a preset's kickoff, a pull request's description (4,000). It
  warns when the target runs in a mode wider than the default (bypass in the
  danger color), and when the text starts with "!" or "/", which Claude and
  Codex may run as a shell or slash command. That's read on the text as it's
  typed (`shared/pasteText.ts`, which takes control characters out), so none
  in front of a "!" hides it.
- **A session started in a team room** (its group a room's, by the group's
  top-level key as the live panes map it: a stack that doesn't exist yet, a
  group inherited from the session it starts beside, a preset's group, a
  template's area, a House ticket, a review's or a handoff's session) is
  said so on its card in the danger color: "Teammates in “Atticus team” will
  see its terminal and scrollback". The card expires when that changes (the
  group shared as a room since, or the room left). `lookup.ts` roomOfGroup
  and roomJoined decide it for every start and the layout tools.
- An allow/deny card shows what the prompt asks: the pane's last lines as
  displayed (ANSI taken out, through the same output read as session_detail,
  guarded by whyNot("readOutput"), so never the Helpdesk workspace's). When
  they can't be read, the card says so and to answer it in the pane.
- **Guards are checked twice**: when the card is made, so it says why it
  can't be done, and again on Do it, against the state then. A card expires
  after 30 minutes, or sooner when its target changes. An allow/deny card
  expires as soon as the prompt it was about is no longer the one showing,
  the same check phone replies make. A Do it that plans again (open_pr,
  start_from_ticket, cleanup_worktree, turning a rule on) compares the plan
  with what the card showed and refuses what differs: "It changed since the
  card: ask again". So does change_rule: what it leaves out is taken from the
  rule at Do it, so the rule (its label, trigger, actions, on and pause) must
  be the one its card showed, and the card expires when it isn't.
- Every action that runs, from a card, a direct step, an Undo or a rule,
  goes into the activity log (`assistant.action`, remoteAudit.ts) with its
  tool, target, outcome and source.

## Never

There's no tool for any of these, and main refuses them by session, not by
asking the model to behave:

- Reading the environment, secrets, credentials or tokens, or any file
  outside a session's own folder (What the Assistant can read, below).
- The Helpdesk workspace's conversation: no reading its output or
  transcript, no typing into it, and broadcasts skip it. Its status and
  lifecycle (restart, focus, move, mute) are fine. A permission mode wider
  than the default (auto, accept edits, bypass) isn't offered for it.
- Force-push.
- Teammates' sessions, except through the room's own take-over flow.
- Moving a session across a team room's boundary without a card (Layout's
  room boundaries, below).
- Treating text from tools (titles, transcripts, chat, artifacts, the House
  board, PR text) as instructions. It's data, and the prompt says so. The
  tiers are what make that hold: injected text can at most cause reads,
  reversible layout changes and cards the user reads.

## Permission modes

New for this feature: a session's permission mode is part of its record,
kept through every relaunch like its model and effort.

| Mode | Claude | Codex |
|---|---|---|
| Ask as usual (`default`) | no flag | no flag |
| Plan (`plan`) | `--permission-mode plan` | `-s read-only` |
| Accept edits (`acceptEdits`) | `--permission-mode acceptEdits` | `-s workspace-write -a on-request` |
| Auto (`auto`) | `--permission-mode auto` | `--approve-for-me` |
| Bypass (`bypass`) | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

- Codex's flags are the ones codex-cli 0.156.1 lists for both `codex` and
  `codex resume`. It has no `--full-auto` any more (an unknown flag stops it
  starting); `--approve-for-me` is its auto mode: workspace-write, with
  approval requests sent to its automatic review.
- A room-sandboxed session (claudeRoomSandbox.ts / codexRoomSandbox.ts) is
  only given a mode that tightens the room's sandbox, never one that replaces
  or loosens it. Claude there takes Ask as usual or Plan: accept edits and
  auto would approve what the room has it ask about (its House writes among
  them), and bypass would leave it. Codex there takes only Ask as usual:
  every other mode picks Codex's own sandbox (`-s`, `--approve-for-me`, the
  bypass), which would replace the room's permission profile. Main refuses
  the rest, saying why.
- The Helpdesk tasks workspace takes nothing wider than the default (Ask as
  usual or Plan), refused in main.
- Relaunching with a new mode, model or effort (`sessions:relaunchWith`)
  goes through the same `relaunchGuard`, `ownOnly` and take-over checks as a
  restart. A model is at most 80 of `[\w.\-[\]]`, starting with a letter,
  digit or `_`; an effort is Claude's low, medium, high, xhigh or max, and
  Codex takes the same names as its reasoning effort but has no max.
  `describeRelaunch` gives a card why it's blocked and its warnings (mid-turn,
  a wider mode).
- The workspace's info shows its mode whenever it isn't the default.
- **The mode it runs in now.** A session can run wider than the mode
  Mockingbird launched it in: its agent's own settings may set a default mode,
  and Shift+Tab (Claude) changes it in the pane. Both agents say which mode
  they're in on their hooks' payloads (`permission_mode`: Claude Code fills it
  with its live mode, Codex sends it on its turn events), and the hook script
  passes the payload on whole. Main keeps the latest one from the pane's own
  events (`SessionInfo.liveMode`, cleared on every launch; an event matched
  only by its folder may be another agent's, so it's never taken), reading
  Claude's `bypassPermissions` as bypass and `dontAsk` as never wider. Every
  wider-mode check goes by the wider of the launched and the reported mode
  (`widerMode`, in `world.ts`): cards' warnings, a standing rule's refusal to
  type into such a session, and move_across_room's room-sandbox warning. A
  narrower mode reported never narrows the launch's. Until an agent's hooks
  report (not installed, or before its first event), only the launch's mode
  is known. session_detail shows what was reported as `reportedMode`.

## Ability groups (v1)

| Group | Read | Direct (Undo) | Confirm |
|---|---|---|---|
| Sessions | list, detail | — | restart with mode/model/effort, restart all (group), close, resume, hand off to a fresh session |
| Layout | landscape | focus, move, stack, size, arrange, move to group, create/rename group, rename, mute (none across a room's boundary), an area's colour, open or close a tool window | move a session into, out of or between team rooms |
| Start work | presets, templates, House/ADO tickets | — | new session/worktree/branch (agent, mode, model, first prompt), preset, lay out a template, from a ticket, review a branch |
| Triage | needs-you list, rollup | — | allow/deny a prompt once, type into a session, broadcast to a group |
| Git | worktrees (dirty/ahead/behind), branch stat, PR status | — | clean up a worktree, push, open a PR |
| Wires | wires, gates | draw, remove | approve a gate, send a handoff |
| Pipelines | a pipeline's stages, steps (not started ones too) and wires; held plans | edit, insert or remove a not-started step, move a wire's end, a wire's settings, a not-started step's or closed session's model, re-lay out | restart on another model, forget a running or closed session, a wire that sends without asking, lay out or dismiss a plan |
| Rooms | rooms, House board | — | share, leave, take over, room sandbox switch, claim/release a ticket |
| Settings | every setting but credentials paths and the phone handle | view and notification settings | settings that change what agents may do, what runs as you or what reaches past this Mac |
| Diagnose | stuck/exited detail, closed output tail, recent output of any of this Mac's sessions (never Helpdesk's; a teammate's only as mirrored here), usage and meters, which session touched a file (overlaps, turn changes, transcript search without Helpdesk) | — | — |
| Files | a session's files listed and read, its uncommitted diff (What the Assistant can read) | — | — |
| Standing rules | list rules | turn a rule off, remove one | create, change or turn on a rule |

Typing into a session (and a broadcast) refuses, or skips, a session waiting
on a permission prompt: keys typed there would answer it, past answer_prompt's
one-prompt check and the rules' ban on answering prompts.

- Layout's tools: `landscape`, `list_groups`, `focus_session`, `rename_session`,
  `move_workspace` (into an area, or next to another workspace), `stack_workspaces`,
  `unstack` (one tab out, beside its stack), `size_workspace` (S/M/L), `tidy_area`,
  `set_group`, `create_group`, `rename_group`, `mute_session`, `unmute`, and
  the one confirm tool, `move_across_room`. Each layout change's Undo is the
  window's: offered while the landscape's revision is the one the change made.
- **Room boundaries:** a session in a team room's group is a room session:
  teammates are streamed its terminal and scrollback (livePanes.ts), which no
  Undo takes back, and their agents can message it. So no direct tool moves
  one across a room's boundary: into a room's group, out of one, or between
  two. `set_group`, every planned change (`move_workspace`, `create_group`; a
  stack or an unstack stays in one area, so in one room) and every Undo of
  them are refused there (`layoutPlan.ts` roomBoundary, in the tool's check
  and again in `carry`, which every plan and its Undo go through), and the
  refusal names `move_across_room`. A group's room is its
  top-level group's, as the live panes map it. A standing rule's `set_group`
  meets the same refusal on every run.
- `move_across_room` (confirm, never a rule's) is that move on a card. It says
  what happens: "Teammates in “Atticus team” will see its terminal and
  scrollback, and their agents can message it" (a terminal: they can ask to
  type into it), and that moving it out again doesn't take back what they've
  seen; out of a room, that its teammates lose it. Into a room it's in the
  danger color, and warns when the session is running (it joins outside the
  room's settings: nothing crosses the room's line for it until it's
  restarted there), when it's a terminal (it can read any file), and when it
  runs in a permission mode the room's sandbox wouldn't allow
  (`permissionModeRefusal`, on the wider of its launched and reported mode).
  Its title names the session by sessionRef. The Helpdesk workspace is refused, as
  `sessions:setGroup` refuses it. The card expires when the session's group,
  the rooms it leaves or joins, its agent, mode, running state or the room's
  sandbox switch change.
- Wires: `approve_gate` is the ticket pipeline's stakeholder-testing gate
  (`pipeline:approve`); `send_handoff` sends what waits at a wire's gate, by its
  pending's id, as it was readied (`wires:send`; a stopped other end isn't
  started). `remove_wire`'s Undo lasts while the wire service still holds it.
- Pipelines (`tools/pipeline.ts`), through main's own paths: PipelineEdits
  (`steps:edit`, `steps:insert`, `sessions:setModel`), the wire service
  (`wires:set`, `wires:repoint`) and Forget (`sessions:forget`, its chain
  joined up over it). `pipeline` reads one pipeline (by a session) or every
  one in an area (by a group): its stages in the order Re-lay out puts them
  (`pipelineStages`), each step's state, agent, model and effort, a
  not-started step's prompt (its first line unless `full_prompts`), and the
  wires between them; collapsed areas are read too. `list_plans` reads the
  held plans as their dialog shows them. The snapshot only counts not-started
  steps and closed sessions per group ("3 not started") and the held plans,
  so it stays small; `list_sessions` lists them apart, `session_detail` gives
  a step's spec, and `list_wires` names their ends.
  - **Direct**: `edit_step` (not started: title, agent, model, effort, prompt;
    Undo sets back what it changed while the step is as it left it);
    `insert_step` (after, ahead of, or between two joined by a handoff, the
    wire into the second keeping its id; then the pipeline is laid out again;
    Undo moves that wire back, puts the places back and takes the step out);
    `repoint_wire` (Undo while the service holds the move); `relayout_pipeline`
    (`planRelayoutPipeline`, ghosts with the rest; Undo as a layout change's);
    `set_model` on a not-started step or a closed session (Undo while its model
    is still the one set); `wire_settings` (when, gate, rounds, tool output,
    what it sends, files; Undo sets back the keys it changed); `remove_step` on
    a not-started step (Undo through `sessions:unforget`, its place put back);
    `save_template` (the pipeline as a new template, as its Pipeline window's
    Save as template drafts it, `pipelineTemplateOf` then `templates:draft`;
    a name a template has is refused; Undo removes it while it's as saved).
  - **Confirm**: `restart_with_model` (a running session restarted in place,
    its card saying it keeps its id, wires, place and area); `automate_wire`
    (a change after which the wire sends without asking: an automatic gate
    that fires when its source finishes or its PR merges, or what such a wire
    sends); `forget_session` (running or closed; a running one's card carries
    the close warnings); `lay_out_plan` (the held plan as held, where it was
    listed going; then the pipeline laid out along its wires: the window
    instead tidies a plan's steps only when its area holds nothing else);
    `dismiss_plan` (its Orchestrator told, with the note); `replace_template`
    (a saved template written over with the pipeline under its id and name,
    as Replace does; the built-in one can't be; the card stands only while
    the template is as it was when the card was shown). A plan card expires
    when a newer plan is held in its place.
  - Model names are checked against what this Mac's agent offers (the
    models catalog, `modelRefusal`) before anything changes. Insert and
    template lay-outs wait (up to 3 s) for the window to draw and place
    what's new before laying the pipeline out, since a place saved first
    would be overwritten by the window's own; a lay-out that can't be laid
    out again says why and stands. None of these is a rule's.
- Rooms: `share_group` never gives the invite code (the Team view has it);
  `take_over` reads the take-over plan for its card. A House board that can't
  be read is never left out: `list_tickets` lists it as "(<room>'s board
  couldn't be read: why)", and `house_board` fails saying the same.
- Look: `set_area_colour` (by the Colour popover's names, or Automatic; its
  Undo puts the colour back while it's still the one set), `open_tool` and
  `close_tool` (Files, Changes, Search, Run & debug beside one of this Mac's
  workspaces; Artifacts, Chat in an area; or docked). A window is opened by the
  window itself (`assistant:window` openTool, through the same Show its own
  buttons use), which places it or docks it when its area has no room; main
  first refuses what those buttons would (a teammate's session, an exited one
  but Search, Chat outside a room's area, a collapsed area, one open there
  already). Its Undo closes the window it opened. close_tool closes through the
  landscape, as ×, and its Undo puts the window back while the landscape's
  revision is the one the close made. None is a rule's.
- Settings: `tools/settings.ts` SETTINGS_TABLE classifies every setting, one row
  each (phone alerts' parts one row each), and the tools read and change
  nothing else. Its type needs a row for every key of `Settings`, and
  `test/assistantSettings.test.ts` checks the interface's keys against it.
  - **Direct** (`set_setting`, with Undo, rule-able): notifications, finished
    alerts, quiet hours, phone alerts on/off (once set up), their away time and
    finished-turn texts, the hidden tabs, the Assistant's model.
  - **Confirm** (`change_setting`, a card, never a rule's): sending agents'
    messages at once (and by group), phone replies, debriefs, the repository
    folders, the Claude and Codex programs, where updates come from, your
    team name, the signaling address, running room sessions inline. The
    programs, the update folder and the signaling address are in the danger
    color. The card expires when the setting changes before Do it.
  - **Read only**: first-run setup, presets, saved templates, rooms without
    their sandbox (`set_room_sandbox` switches those, on a card).
  - **Never** read or changed: WorkTracker's folder (it leads to the ADO PAT)
    and where phone alerts go.
- Rule-able among these: `set_group`, `mute_session`, `unmute`, `set_setting`.

## What the Assistant can read

Read tools only; nothing here writes, and none is a rule's.

- **Output** (`session_output`): the recent terminal output of one of this
  Mac's sessions, Claude, Codex or a terminal, running, exited or closed (its
  pane's buffer, or a closed one's saved output), ANSI taken out, what looks
  like a secret redacted (`redactSecrets`), its last 120 lines unless asked for
  up to 400, and at most 24,000 characters, saying when it cut. Never the
  Helpdesk workspace's (`whyNot("readOutput")`). A teammate's room session is
  read only from the copy this Mac already mirrors for its open terminal
  (livePanes `mirrored`); nothing is fetched, and without one it's refused,
  saying to open its workspace or ask its owner.
- **Files** (`list_files`, `read_file`) and **the diff** (`git_diff`), only
  in one of this Mac's sessions' folders (its worktree, or the folder it runs
  in), through `assistant/sessionFiles.ts` FolderReader:
  - A path is relative to the folder: an absolute one and one climbing out
    with `..` are refused. The folder and the file are both resolved through
    their links and the file must still be inside (`resolveIn`), so a link out
    is refused; the file is opened without following a link.
  - Refused by name at any depth, in any case: SECRET_FILE_GLOBS (env files,
    keys, certificates, PAT and credentials files) and more for the Assistant:
    `.env*`, `id_*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`,
    `*credentials*`, `*secret*`; a link whose target is so named; git's own
    files (`.git/`); this Mac's known secret files (the ADO PAT file); and,
    in a repository, whatever git ignores (`check-ignore`), which keeps out
    dependencies, build output and most local secrets.
  - Never read: a folder that is the home folder or holds it, and anything in
    `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.mockingbird`,
    `~/.claude`, `~/.codex` or `~/Library`. The Helpdesk workspace's folder
    and teammates' sessions (whose folders are on their Macs) are refused.
  - `read_file` refuses binary files, files over 200 KB and text holding a
    private key, gives at most 2,000 lines or 60,000 characters at a time
    (saying where to read on), and redacts what looks like a secret.
  - `list_files` lists what git tracks and the untracked files it doesn't
    ignore (outside git, a walk that skips hidden, dependency and build
    folders), at most 500, saying when there are more and how many
    secret-shaped names it left out.
  - `git_diff` is the folder's uncommitted diff against its last commit, only
    what's staged, or one file's, through guardedGit (nothing the repository
    configures runs). Secret files are left out by git's own pathspecs and
    again file by file, and named; a file whose diff holds a private key is
    withheld; the rest is redacted and cut as a wire's `{diff}` is (`shapeDiff`).
    Untracked files are named, not shown.
- Every refusal says why, in plain words, and the prompt tells the model a
  refusal is the answer. The prompt's rules also tell it to read a session's
  output and diff before answering why it's stuck or what it changed. The
  per-turn snapshot stays one line a session: no output or files in it.

## Standing rules

- **Made, changed and turned on only through a card.** The card shows the
  trigger and each action as main spells it out from its arguments
  (`describe`, rules.ts describeAction), never the model's label: the full
  text it types, a first prompt whole, the mode, model and group, the
  sessions it names by id, the warnings each would carry, and the danger
  color. It says that once it's on, it runs them without asking each time.
  The tab's Rules list shows each rule's actions the same way, built again
  by main each time it's read. Turning a rule off (`turn_rule_off`) is direct
  with Undo, offered only while the rule is as it left it (changed, switched
  or paused since, it's the user's); turning one on (`turn_rule_on`, which
  clears a pause) is a card. A change_rule card says when the change clears a
  pause, as turn_rule_on's does.
- **Triggers are app state, never text**: a session's turn finished, it has
  waited on you N minutes, it exited, or a time of day (`HH:MM`, chosen
  weekdays). The target is a session, a group, or any session.
- **Actions** come from the same registry, with their arguments fixed when
  the rule is made (a message to type is fixed text), plus two only rules
  have: a desktop notification, and texting you (phone alerts' sender to
  your own handle; a development build only logs it).
- **Not allowed in a rule**: allowing or denying prompts (that would be a
  standing yes to every prompt), any permission mode wider than the default
  (accept edits, auto, bypass; plan and the default are fine), closing with
  forget, worktree cleanup, push or PR, leaving a room, take-over, starting
  from a House ticket (it claims the ticket on the room's shared board),
  moving a session across a team room's boundary (`move_across_room` isn't
  rule-able, and a rule's `set_group` is refused there on every run), and
  starting a session in a team room's group: start_session, start_preset,
  lay_out_template and review_branch are refused on every run whose session
  would start in one (`lookup.ts` ruleIntoRoom), as teammates would be
  streamed it with no one asked, and a rule's card says so.
- When a rule runs, it types nothing into a session that runs in a wider
  mode then (launched in one, or reported in one by its hooks: Permission
  modes → The mode it runs in now): send_to_session is refused, and a
  broadcast leaves it out, saying so in the run.
- **Limits**: at most 20 rules, 5 actions each. A rule runs at most once per
  trigger event and 6 times an hour. After 3 failed runs in a row it pauses
  itself and says why. Guards are checked on every run.
- Rules run in main whenever Mockingbird is running. A time missed while the
  Mac slept or the app was closed is skipped, not caught up.
- **One event, one run**: a Stop, a spell of waiting (counted from when it
  began), an exit (its agent quitting and its pty ending are one), a day's
  time. Main's 30 s tick reads waiting and the time of day; a time is caught
  within 90 s of it. Rules run one at a time, each action through the
  service's `runAction` (`ruleEngine.ts`). A target gone for a minute (a
  session closed and forgotten, a group that's gone) pauses the rule.
- **notify** follows the notification settings and quiet hours, as team
  chat's notices do. **text_me** needs phone alerts set up and on, sends
  nothing in quiet hours, and in a development build only logs.
- The deny list is explicit (`rules.ts` RULE_DENY_LIST), matched by tool name
  and by arguments (bypass, forget), and checked when a rule is made and
  again on every run, whatever a tool's `rule` says.
- Kept in `~/.mockingbird/assistant-rules.json`. The thread and cards are
  memory only. A rules file that can't be read is never overwritten: it's
  kept aside as `assistant-rules.json.corrupt-<time>`, logged, and the
  tab's Rules section says so; the rules that could be read are kept.
- Turning a rule off, removing it and pausing it hold in memory even when
  they can't be saved (a file that couldn't be moved aside, a failed write),
  so a rule the user stopped never runs again while Mockingbird does; the
  rule and the Rules section say it holds only until Mockingbird quits.
  Making, changing or turning on a rule must be saved, or it's refused.
- Who wrote the rules file isn't checked: a process of the user's that
  could write it could already run anything as the user.

## The tab and ⌘K

- **The tab** is the rail's last button (✦, ⇧⌘A from anywhere, the message
  box included). On the landscape it shows in the side bar in the area
  tree's place, as wide as the side bar is dragged; closing it goes back to
  the tree, or to a hidden side bar if that's how it was. In focus it takes
  the side bar's slot like Files, Changes and Run & debug, one at a time.
  It isn't a tool window placed on the landscape: its thread is about the
  whole app, not one workspace or area.
- It holds the thread (your words, its reply, step rows with state, Undo on
  direct steps), open cards (Do it / Cancel), recent rule runs, and a
  **Rules** section (on/off, remove, each rule's actions spelled out by
  main). The user's own switch there is direct; only the Assistant's turning
  one on is a card. Its header names the model (Settings → Assistant).
- **The message box** sits at its foot and grows to a few lines. ⏎ asks
  (queued behind a turn that's running, which the thread shows), ⇧⏎ is a
  new line, ↑ in an empty box brings back the last question. It empties and
  keeps the keyboard after asking. Past 4,000 characters it says so and
  won't ask, rather than cutting. Esc hands the keyboard back (the
  landscape, or the workspace in focus's terminal), keeping what's typed.
  With nothing yet, the tab offers example questions a click puts in the box.
- Only the message box takes the keyboard. Clicking the tab's buttons or its
  words leaves the keys where they were, the way the landscape's tab and ×
  buttons do (keyArm.ts). Opening the tab from its button, ⇧⌘A or ⌘K gives
  the box the keyboard; main's `openTab` (assistant:window) shows the tab
  and leaves the keyboard alone.
- ⌘K: once you've typed something, an **Ask Assistant** row joins the list.
  It comes first and selected when nothing matches or what you typed reads
  as a sentence (3+ words), and last otherwise. Words that all begin words
  of one row's label ("go to 5102", "Toggle the log panel") are that row's
  command, so ⏎ still runs it. ⌘⏎ always asks. Asking closes the palette,
  shows the landscape, opens the tab and leaves the keyboard in its box.
- Replies show as plain text with light markdown, never HTML.

## The thread across quits

- The thread (turns and the cards they put up) is saved to
  `~/.mockingbird/assistant-turns.json` whenever it changes, written whole
  and atomically, owner-only (`assistant/thread.ts`). It keeps the last 20
  turns; past 512 KB the oldest turns, then the oldest settled cards, are
  left out of the file (logged).
- At start-up it loads. A turn that was running or queued at the quit loads
  as "Stopped when Mockingbird quit"; a card waiting on Do it loads expired
  (its call isn't saved, so it can't run), one that was running loads
  failed; no Undo comes back, as what an Undo puts back lives in memory.
- Clear clears the file too: finished turns and settled cards go; a running
  or queued turn and an open card stay.
- A file that can't be read is renamed aside (`.corrupt-<time>`), logged,
  and named in the tab until Clear; the thread starts empty. One that can't
  be moved aside is never saved over. A save that fails is logged once and
  named in the tab until one works.

## Plumbing

- **MCP:** the Assistant is its own caller kind on Mockingbird's MCP server
  (messaging.ts). Its token is minted for the turn and bound to the
  `claude` process it spawns (`mcpLaunch` / `bindMcpLaunch`). `tools/list`
  gives it only the Assistant's tools. `dispatch` refuses Assistant tools
  from any other caller, and pane tools from the Assistant.
- **Deps:** `assistant/deps.ts` is all the tools reach: state and actions; a
  session's output only through `output` and `mirroredOutput`, its folder only
  through `folders` (FolderReader); never the environment or secrets.
- **Registry:** `src/main/assistant/` — `registry.ts` (the tool type: name,
  tier, schema, `label(args)`, `describe?(args)` → the call whole for a
  rule's card, `check(args, ctx)` → why not, `run(args, ctx)` → result plus
  undo for direct tools, `ctx.rule` when a standing rule runs it,
  `rule?: boolean`), and one file per group
  under `tools/`. The cards, undo, rules and turn runner use only the
  registry.
- **Window-only steps** (focus, camera, opening a tool window) go to the window as
  `assistant:window` events. Landscape moves are planned in main with the
  same planners the window uses (`src/shared/landscapeModel.ts`, which
  `renderer/landscapeModel.ts` re-exports; `assistant/layoutPlan.ts` carries
  a plan out as the window's carryPlan does), so main refuses what the window
  would.
- **Contract:** `src/shared/assistant.ts` (the view, IPC channels,
  rules), `src/shared/permissionModes.ts`.
