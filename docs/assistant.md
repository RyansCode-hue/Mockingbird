# The Assistant

Ask Mockingbird to do things in plain words: "restart api-fix in plan mode",
"put the atticus workspaces together", "what's waiting on me?", "when tests
finishes, start the review". You ask in ⌘K, and the Assistant works in a
slim sheet docked at the landscape's right edge. The sheet shows its steps
live, an Undo on each change it made, a confirm card for each change it
wants to make, and your standing rules.

Decided with Ryan, 2026-11-16: mockup 3 (⌘K, then a docked sheet), all ten
ability groups and standing rules in the first version, low-risk changes
direct with Undo, everything else on a card.

The room's `@assistant` (team-rooms.md → Team room) is a different thing and
stays as it is: it answers questions in a room's chat and has no tools,
because teammates write that chat.

## How a turn runs

- **One headless Claude turn per question**, on this Mac, under the user's
  own Claude Code account (`claude -p`, the `sonnet` alias, 180 s cap). It has
  **no built-in tools** (`--tools ""`) and **only Mockingbird's Assistant MCP
  server** (`--strict-mcp-config --mcp-config …`, `--allowedTools` limited to
  that server's tools). It saves nothing (`--no-session-persistence`). Codex
  isn't used: even read-only, its sandbox can read files.
- The prompt holds the Assistant's rules, the last 8 turns of the sheet's
  thread (your words, its replies, what its steps did), so "those" and
  "them" work, and a compact snapshot: sessions, groups and rooms, one line
  each. Anything more it reads with its tools.
- Turns run one at a time. A question asked while one runs waits its turn,
  and the sheet says so. Clear in the sheet's header starts a fresh thread.
- Needs Claude Code installed. Without it, the Ask row says so and does
  nothing.

## Tiers: main decides, never the model

Every tool has a tier, fixed in main's registry. The model can't change it.

| Tier | What happens on the call | Examples |
|---|---|---|
| **read** | Runs and returns data | list sessions, what's waiting, usage, git status, why it's stuck |
| **direct** | Runs, and its step shows **Undo** while what it changed is unchanged since (10 min, in memory) | focus, move/stack/size/arrange, move to a group, create/rename a group, rename, mute, settings toggles, draw or remove a wire |
| **confirm** | Nothing happens: a **card** appears in the sheet, and the call returns "card shown, the user decides". It runs only when the user presses **Do it** | restart (permission mode, model, effort), close, resume, type into a session, broadcast, allow/deny a prompt, start sessions/worktrees/templates/reviews, hand off, git cleanup/push/PR, room actions, approve a gate, create, change or turn on a standing rule |

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
  Codex may run as a shell or slash command.
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
  card: ask again".
- Every action that runs, from a card, a direct step, an Undo or a rule,
  goes into the activity log (`assistant.action`, remoteAudit.ts) with its
  tool, target, outcome and source.

## Never

There's no tool for any of these, and main refuses them by session, not by
asking the model to behave:

- Reading files, environment, secrets, credentials or tokens.
- The Helpdesk workspace's conversation: no reading its output or
  transcript, no typing into it, and broadcasts skip it. Its status and
  lifecycle (restart, focus, move, mute) are fine. A permission mode wider
  than the default (auto, accept edits, bypass) isn't offered for it.
- Force-push.
- Teammates' sessions, except through the room's own take-over flow.
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

## Ability groups (v1)

| Group | Read | Direct (Undo) | Confirm |
|---|---|---|---|
| Sessions | list, detail | — | restart with mode/model/effort, restart all (group), close, resume, hand off to a fresh session |
| Layout | landscape | focus, move, stack, size, arrange, move to group, create/rename group, rename, mute | — |
| Start work | presets, templates, House/ADO tickets | — | new session/worktree/branch (agent, mode, model, first prompt), preset, lay out a template, from a ticket, review a branch |
| Triage | needs-you list, rollup | — | allow/deny a prompt once, type into a session, broadcast to a group |
| Git | worktrees (dirty/ahead/behind), branch stat, PR status | — | clean up a worktree, push, open a PR |
| Wires | wires, gates | draw, remove | approve a gate, send a handoff |
| Rooms | rooms, House board | — | share, leave, take over, room sandbox switch, claim/release a ticket |
| Settings | settings | notifications, finished alerts, quiet hours, phone alerts on/off (once set up) | — |
| Diagnose | stuck/exited detail, closed output tail (never Helpdesk's), usage and meters, which session touched a file (overlaps, turn changes, transcript search without Helpdesk) | — | — |
| Standing rules | list rules | turn a rule off, remove one | create, change or turn on a rule |

Typing into a session (and a broadcast) refuses, or skips, a session waiting
on a permission prompt: keys typed there would answer it, past answer_prompt's
one-prompt check and the rules' ban on answering prompts.

- Layout's tools: `landscape`, `list_groups`, `focus_session`, `rename_session`,
  `move_workspace` (into an area, or next to another workspace), `stack_workspaces`,
  `unstack` (one tab out, beside its stack), `size_workspace` (S/M/L), `tidy_area`,
  `set_group`, `create_group`, `rename_group`, `mute_session`, `unmute`. Each
  layout change's Undo is the window's: offered while the landscape's revision
  is the one the change made.
- Wires: `approve_gate` is the ticket pipeline's stakeholder-testing gate
  (`pipeline:approve`); `send_handoff` sends what waits at a wire's gate, by its
  pending's id, as it was readied (`wires:send`; a stopped other end isn't
  started). `remove_wire`'s Undo lasts while the wire service still holds it.
- Rooms: `share_group` never gives the invite code (the Team view has it);
  `take_over` reads the take-over plan for its card.
- Settings: only notifications, finished alerts, quiet hours and phone alerts
  on/off; phone alerts only once a handle is set up, which is never read.
- Rule-able among these: `set_group`, `mute_session`, `unmute`, `set_setting`.

## Standing rules

- **Made, changed and turned on only through a card.** The card shows the
  trigger and each action as main spells it out from its arguments
  (`describe`, rules.ts describeAction), never the model's label: the full
  text it types, a first prompt whole, the mode, model and group, the
  sessions it names by id, the warnings each would carry, and the danger
  color. It says that once it's on, it runs them without asking each time.
  The sheet's Rules list shows each rule's actions the same way, built again
  by main each time it's read. Turning a rule off (`turn_rule_off`) is direct
  with Undo; turning one on (`turn_rule_on`, which clears a pause) is a card.
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
  forget, worktree cleanup, push or PR, leaving a room, take-over, and
  starting from a House ticket (it claims the ticket on the room's shared
  board).
- When a rule runs, it types nothing into a session that runs in a wider
  mode then: send_to_session is refused, and a broadcast leaves it out,
  saying so in the run.
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
  sheet's Rules section says so; the rules that could be read are kept.
- Turning a rule off, removing it and pausing it hold in memory even when
  they can't be saved (a file that couldn't be moved aside, a failed write),
  so a rule the user stopped never runs again while Mockingbird does; the
  rule and the Rules section say it holds only until Mockingbird quits.
  Making, changing or turning on a rule must be saved, or it's refused.
- Who wrote the rules file isn't checked: a process of the user's that
  could write it could already run anything as the user.

## The sheet and ⌘K

- ⌘K: once you've typed something, an **Ask Assistant** row joins the list.
  It comes first and selected when nothing matches or what you typed reads
  as a sentence (3+ words), and last otherwise. Words that all begin words
  of one row's label ("go to 5102", "Toggle the log panel") are that row's
  command, so ⏎ still runs it. ⌘⏎ always asks. Asking closes the palette,
  shows the landscape and opens the sheet.
- **The sheet** docks at the right edge, over the landscape, and stays until
  you close it. It holds the thread (your words, its reply, step rows with
  state, Undo on direct steps), open cards (Do it / Cancel), recent rule runs,
  and a **Rules** section (on/off, remove, each rule's actions spelled out by
  main). The user's own switch there is direct; only the Assistant's turning
  one on is a card. It never takes the keyboard from
  a session: clicking its buttons hands the keys back the way the landscape's
  tab and × buttons do (keyArm.ts).
- While the sheet is open, the landscape keeps what it brings into view clear
  of it: Fit, going to a workspace (`focus_session` too) or an area, and the
  arrow keys center in the part it leaves uncovered, and a workspace in focus
  fills only that part.
- Replies show as plain text with light markdown, never HTML.

## Plumbing

- **MCP:** the Assistant is its own caller kind on Mockingbird's MCP server
  (messaging.ts). Its token is minted for the turn and bound to the
  `claude` process it spawns (`mcpLaunch` / `bindMcpLaunch`). `tools/list`
  gives it only the Assistant's tools. `dispatch` refuses Assistant tools
  from any other caller, and pane tools from the Assistant.
- **Registry:** `src/main/assistant/` — `registry.ts` (the tool type: name,
  tier, schema, `label(args)`, `describe?(args)` → the call whole for a
  rule's card, `check(args, ctx)` → why not, `run(args, ctx)` → result plus
  undo for direct tools, `ctx.rule` when a standing rule runs it,
  `rule?: boolean`), and one file per group
  under `tools/`. The cards, undo, rules and turn runner use only the
  registry.
- **Window-only steps** (focus, camera) go to the window as
  `assistant:window` events. Landscape moves are planned in main with the
  same planners the window uses (`src/shared/landscapeModel.ts`, which
  `renderer/landscapeModel.ts` re-exports; `assistant/layoutPlan.ts` carries
  a plan out as the window's carryPlan does), so main refuses what the window
  would.
- **Contract:** `src/shared/assistant.ts` (the view, IPC channels,
  rules), `src/shared/permissionModes.ts`.
