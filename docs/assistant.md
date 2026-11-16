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
| **confirm** | Nothing happens: a **card** appears in the sheet, and the call returns "card shown, the user decides". It runs only when the user presses **Do it** | restart (permission mode, model, effort), close, resume, type into a session, broadcast, allow/deny a prompt, start sessions/worktrees/templates/reviews, hand off, git cleanup/push/PR, room actions, approve a gate, create or change a standing rule |

- A card names the exact target and effect ("Restart api-fix in plan mode:
  stops its current turn and resumes the same conversation"), and lists its
  warnings: uncommitted changes, unpushed commits, mid-turn, and the
  danger color for bypass permissions or deleting a worktree.
- **Guards are checked twice**: when the card is made, so it says why it
  can't be done, and again on Do it, against the state then. A card expires
  after 30 minutes, or sooner when its target changes. An allow/deny card
  expires as soon as the prompt it was about is no longer the one showing,
  the same check phone replies make.
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
| Auto (`auto`) | `--permission-mode auto` | `--full-auto` |
| Bypass (`bypass`) | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

- A room-sandboxed session (claudeRoomSandbox.ts / codexRoomSandbox.ts) can
  only be given a mode that leaves the room's sandbox in force. Bypass isn't
  offered there, and no mode may replace the sandbox's own flags.
- Relaunching with a new mode, model or effort goes through the same
  `relaunchGuard` and `ownOnly` checks as a plain relaunch.
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
| Standing rules | list rules | turn a rule on/off, remove one | create or change a rule |

## Standing rules

- **Made only through a card.** The card shows the trigger and each action,
  and says that once it's on, it runs them without asking each time.
- **Triggers are app state, never text**: a session's turn finished, it has
  waited on you N minutes, it exited, or a time of day (`HH:MM`, chosen
  weekdays). The target is a session, a group, or any session.
- **Actions** come from the same registry, with their arguments fixed when
  the rule is made (a message to type is fixed text), plus two only rules
  have: a desktop notification, and texting you (phone alerts' sender to
  your own handle; a development build only logs it).
- **Not allowed in a rule**: allowing or denying prompts (that would be a
  standing yes to every prompt), bypass mode, closing with forget, worktree
  cleanup, push or PR, leaving a room, take-over.
- **Limits**: at most 20 rules, 5 actions each. A rule runs at most once per
  trigger event and 6 times an hour. After 3 failed runs in a row it pauses
  itself and says why. Guards are checked on every run.
- Rules run in main whenever Mockingbird is running. A time missed while the
  Mac slept or the app was closed is skipped, not caught up.
- Kept in `~/.mockingbird/assistant-rules.json`. The thread and cards are
  memory only.

## The sheet and ⌘K

- ⌘K: once you've typed something, an **Ask Assistant** row joins the list.
  It comes first and selected when nothing matches or what you typed reads
  as a sentence (3+ words), and last otherwise. ⌘⏎ always asks. Asking
  closes the palette and opens the sheet.
- **The sheet** docks at the right edge, over the landscape, and stays until
  you close it. It holds the thread (your words, its reply, step rows with
  state, Undo on direct steps), open cards (Do it / Cancel), recent rule runs,
  and a **Rules** section (on/off, remove). It never takes the keyboard from
  a session: clicking its buttons hands the keys back the way the landscape's
  tab and × buttons do (keyArm.ts).
- Replies show as plain text with light markdown, never HTML.

## Plumbing

- **MCP:** the Assistant is its own caller kind on Mockingbird's MCP server
  (messaging.ts). Its token is minted for the turn and bound to the
  `claude` process it spawns (`mcpLaunch` / `bindMcpLaunch`). `tools/list`
  gives it only the Assistant's tools. `dispatch` refuses Assistant tools
  from any other caller, and pane tools from the Assistant.
- **Registry:** `src/main/assistant/` — `registry.ts` (the tool type: name,
  tier, schema, `label(args)`, `check(args)` → why not, `run(args)` → result
  plus undo for direct tools, `rule?: boolean`), and one file per group
  under `tools/`. The cards, undo, rules and turn runner use only the
  registry.
- **Window-only steps** (focus, camera) go to the window as
  `assistant:window` events. Landscape moves are planned in main with the
  same planners the window uses, so main refuses what the window would.
- **Contract:** `src/shared/assistant.ts` (the view, IPC channels,
  rules), `src/shared/permissionModes.ts`.
