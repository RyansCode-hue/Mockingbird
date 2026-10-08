# Team rooms

Live co-presence between two (later more) Mockingbirds: share a group as a
room, see and type into each other's sessions, talk in a team room with your
agents, claim work on a shared plan board, and take over a teammate's session
when they're away.

Decided with Ryan, 2026-10-07 (connection changed from Tailscale to WebRTC the same day). Built for Ryan and Nick first; nothing here
should stop more members joining later.

## Connection

- **WebRTC data channels, peer to peer.** After the introduction, everything
  between two Mockingbirds goes laptop to laptop, encrypted end to end
  (DTLS). Nothing needs installing. The peer connections live in a hidden
  window (Electron's built-in WebRTC), bridged to the main process over IPC,
  so they survive the app window reloading.
- **Signaling: a Cloudflare Worker** with a Durable Object per room. It
  introduces two members and re-introduces them after sleep or a Wi-Fi change.
  Ryan deploys it once to a free Cloudflare account (the Worker's code lives in
  this repo, with a one-command deploy; the free plan's 100,000 requests a day
  is far more than two people use). It only ever sees signed connection
  details, never content.
- **NAT traversal:** public STUN. Where a direct connection is blocked (office
  firewalls, hotspots), traffic falls back automatically to **Cloudflare TURN**
  (still end-to-end encrypted; 1,000 GB a month free). The TURN API token stays
  in the Worker as a secret. The Worker hands room members short-lived TURN
  credentials, so no laptop holds the token.
- **Identity:** each Mockingbird install has its own key pair (in
  `~/.mockingbird`, never synced) and a display name set in Settings → Team.
  Connection details are signed by the sender's key and checked against the
  room's member list. Each side pins the other's DTLS fingerprint from those
  signed details, so a tampered signaling server can't step in between.
- Settings → Team: display name, signaling URL (from the deploy), connection
  status per teammate (direct / via TURN / offline).
- Messages are versioned. A peer on a different protocol version is shown as
  "needs an update" instead of half-working.
- The transport sits behind one small interface, so another way to connect
  could replace WebRTC later without the rest changing.
- **What the room log holds** (each event signed by its author; only a
  session's owner changes its records): `room.created`, `member.added`,
  `member.renamed`; `session.upsert` / `session.removed` (room sessions);
  `session.backup`, `session.takenOver`, `session.backupDropped` (take-over);
  `chat.message`, `chat.update`, `chat.assistant` (team room); `plan.package`,
  `plan.claim`, `plan.status`, `plan.remove`, `plan.repo`, `plan.branches`
  (plan board). Terminal output, views and typing are streams and requests
  between connected members, never stored; so are take-over's copies and
  questions (`takeover.have`, `.snapshot`, `.transcript`, `.ask`, `.progress`,
  `.changes`).

## Rooms

- **A room is a shared top-level group** (e.g. "#5110 Donor entities"). It's
  created on one laptop, and teammates join with an **invite code** the
  creator hands over (room id, signaling URL, a one-time join token, and the
  creator's key fingerprint). Joining records the joiner's public key as a
  member; after that, members reconnect by key.
- Being in a room is the permission. Members can do anything in it. There are
  no roles yet; leave room for viewer/driver roles later.
- **Every member keeps a full copy of the room's state**: members, sessions,
  chat, board, presence. It's an append-only event log, ordered by Lamport time
  and merged on reconnect. The room keeps working for whoever's online when the
  creator's laptop is off. An event whose Lamport time is more than a million
  past a member's is refused, so no event can leave the room unable to take
  the next. Origin URLs go into the log without any user name or token, and an
  event carrying one is refused.
- The sidebar shows the room as a group with a shared badge and the initials of
  who's connected right now. Sessions outside rooms are never visible to anyone.

## Sessions in a room

- **Either member can start a session in the room.** It runs on the starter's
  laptop, in their clone of the repo (matched across laptops by the origin URL,
  not the path), under their own Claude/Codex account. It shows for everyone,
  tagged with the owner's initials.
- **Live panes:** a room session's terminal streams to every member. Its
  scrollback is replayed on join, then live output follows. Remote panes render
  like local ones (status, waiting reason, git chips from the owner's side).
- **Typing:** any member can type into any room session, at the same time, like
  plain tmux. No lock.
- **Notifications:** when an agent in a room is waiting on input, every member
  is notified, whatever their focus.
- **Layout:** each member arranges their own grid. "Follow <name>" mirrors the
  other's shown panes and focus until you stop following.
- **Commits** in a session someone else typed into are authored by the owner,
  with `Co-authored-by: <teammate>` added for the turns the teammate drove.
- **Secrets:** room sessions start with Claude Code permission rules denying
  reads of `.env*` files and the known secret paths (the ADO PAT file,
  `*.pem`, `*.key`, `credentials.json`…), the same mechanism the run-setup
  drafter uses. One list of secret file patterns (`src/main/secrets.ts`)
  makes those rules, Codex's room sandbox (below) and what backups leave out,
  so nothing in it is ever sent over the connection or pushed. Teammates swap
  `.env` files by hand.
- **Codex room sessions** (Codex 0.138 or later) run in the room's sandbox:
  a permission profile, `mockingbird-room` (`src/main/codexRoomSandbox.ts`),
  defined and selected entirely by `-c` settings on that launch
  (`default_permissions`, `features.network_proxy` and an inline
  `permissions.mockingbird-room` table: `-c` splits its key on every dot, so
  path keys go inside the value). `~/.codex/config.toml` is never touched,
  sessions outside rooms are unaffected, and settings from the command line
  outrank `sandbox_mode` in any config file. Codex enforces it with the macOS
  sandbox on every command it runs — `cat`, `cp`, `ln`, a symlink — and on its
  own file reads (`apply_patch`, images). While a profile denies reads, Codex
  never runs a command outside the sandbox, even once approved, so the
  profile is everything the session can do:
  - **Reads:** everything but the secret patterns — inside the session's
    folders, and anywhere on disk except `*.pem` (system and Python CA bundles
    are `.pem` files every TLS client reads) — and the logins that could push
    or sign in as the user: `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`,
    `~/.git-credentials`, `~/.config/git/credentials`, the login keychain
    (`~/Library/Keychains`: git's osxkeychain helper and gh's token),
    Codex's own `auth.json` (the CLI reads it itself, outside the sandbox),
    `~/.mockingbird/team` and the ADO PAT file. Mockingbird's co-author hooks
    inside that team folder stay readable, so commits get their trailers.
  - **Writes:** the session's folders and temp folders (Codex's `:workspace`);
    the repository's git data — the common git folder and a worktree's own —
    so commits, branches, stashes and fetches work; and package caches in
    home: `~/.npm`, `~/.cache`, `~/Library/Caches` (pip, go-build, Yarn 1),
    Yarn Berry's and pnpm's stores, `~/go/pkg`, NuGet's packages and HTTP
    cache, Cargo's registry. A cache whose parent folder doesn't exist yet
    can't be created from inside (a toolchain's first run happens outside).
    Inside the git folder, what git would later run code from or follow when
    Mockingbird or the user runs git outside the sandbox stays read-only:
    `config` (fsmonitor, aliases, credential helpers), `hooks`, `modules`,
    other worktrees, and this worktree's `config.worktree`, `commondir` and
    `gitdir`. So `git config`, `git remote add` and new upstream tracking
    fail. Nothing on `PATH` (`~/.local/bin`, `~/go/bin`, `~/.cargo/bin`) is
    writable.
  - **Network:** on, through Codex's network proxy, for any domain and local
    services (`allow_local_binding`). Without the proxy the sandbox lets
    commands open Unix sockets and connect anywhere directly: an SSH agent
    could sign a push, a Docker daemon could mount any folder. Through it,
    only TCP via the proxy (and to localhost) gets out; tools that ignore
    `HTTPS_PROXY`, and Docker, don't work in a Codex room session.
  - **Pushing can't work from the agent:** a remote outside the session's
    folders can't be written, and every login a push needs is unreadable or
    unreachable. The session is told at launch that commits work and pushes
    are the user's (Source Control, or a `!` command in the pane, which Codex
    runs outside its sandbox). Approvals otherwise follow the user's own
    Codex settings.
  - Older Codex releases lack parts of this (`-c` settings outranking a
    config file's `sandbox_mode`, `extends`, `:workspace_roots`, denied reads
    that hold through approvals), so a Codex older than 0.138 starts its room
    sessions as configured and they say "codex: secrets unguarded", naming
    the update to make. Mockingbird reads the installed version before a room
    launch when it doesn't know it yet.
- **What the deny rules don't cover:** Claude's stop Claude's file tools, not
  a shell command the user approves (`cat .env`); Codex's stop everything the
  agent runs, but not a `!` command typed into the pane. A terminal in a
  shared group is shared too (anyone in the room sees and can type into it)
  and says so. A session moved into a shared group while running keeps what
  it started with until it's restarted, and offers the restart.
- **How commits get the trailer:** a room session starts with
  `GIT_CONFIG_PARAMETERS` pointing `core.hooksPath` at Mockingbird's hooks
  folder, so every git the session runs uses it and no repository's config
  changes. Each hook there runs the repository's own hook of the same name
  (`.git/hooks`, or its `core.hooksPath`, e.g. husky); `prepare-commit-msg`
  and `commit-msg` then add a trailer per teammate who typed into the current
  turn (in a terminal, which has no turns: in the last ten minutes).
- **Who's told what:** teammates are notified when a room session waits, not
  when a turn finishes. Muting a teammate's session mutes it for you only.

## Take-over

When the owner is away, a member clicks **Take over** and the session continues
on their laptop under their own account.

- **Work:** while members are connected, each room session's uncommitted work
  mirrors peer to peer. After every agent turn (the agent going from working
  or waiting to idle, or exiting: the same turns Co-authored-by counts),
  Mockingbird also snapshots the worktree, the same way Undo turn does, and
  pushes it to a hidden ref `refs/mockingbird/rooms/<room>/<session>` on
  origin. That's the backup when the owner's laptop is off. Each session's
  sidebar row and pane header show how fresh its backup is ("backed up 2 min
  ago", or a warning when a push failed); a teammate's also offers **Take
  over**, prominent while its owner is offline.
- **Conversation:** the transcript syncs **peer to peer only, never to GitHub**.
  Take-over places it where the taker's CLI resumes it (Claude's
  `~/.claude/projects/<slug>/<id>.jsonl` for the taker's checkout path, or
  Codex's rollout). If the newest transcript never reached the taker, the agent
  resumes from a handoff summary instead (the existing handoff digest), and says so.
- Take-over creates the session's branch/worktree on the taker's laptop from
  the newest snapshot it has (peer copy or hidden ref, whichever is newer). It
  says which snapshot it used. The taker's new session is the room's from then
  on. The original owner's copy leaves the room: their Mockingbird removes its
  record, stops streaming it, refuses teammates' typing into it and stops
  backing it up, as soon as it learns of the take-over — at once, or when it's
  next online or started. Until then, teammates hide the stale record.
- **Owner online → asked first** (decided with Ryan, 2026-10-07). If the owner
  is connected when a teammate clicks Take over, it doesn't happen at once:
  the owner gets a prompt (and a notification), "<Nick> wants to continue
  <session> on their laptop", with **Hand over** / **Keep**. Hand over lets
  the turn in progress finish (at once if the agent isn't working; a turn
  still running after 30 minutes keeps the session), backs the session up,
  copies that snapshot and the whole conversation to the taker peer to peer,
  stops the owner's agent, and answers with the snapshot: the take-over then
  uses exactly it. Keep, no answer within 2 minutes, or the owner dropping
  offline mid-request: the taker is told, and nothing is taken over; once the
  owner is offline, Take over works from the newest backup as before. The
  taker's dialog shows the request's progress. An owner whose Mockingbird is
  older can't be asked: the taker is told it needs an update, and it isn't
  taken over while it's connected.
- **The old copy stops.** When the owner's Mockingbird learns of a take-over
  (at once, on reconnecting, or on starting — even after relaunching the
  session before the room caught up), it ends that session's agent and never
  runs it again (relaunch, restart and Resume refuse it), leaving the worktree
  and every file in it as they are. Its pane and row say "Continued on
  <Nick>'s laptop" with **Take it back** — the same take-over, in reverse, of
  the copy that continues it now (asking its owner first when they're
  connected), offered once that copy has a backup — and **Close** (the usual
  close, the worktree kept or removed as for any session).
- **Nothing lost.** The snapshot the taker continued from is kept on the
  owner's side (`refs/mockingbird/rooms-left/<room>/<session>`), so changes
  the copy has that the taker never received — made after that snapshot, e.g.
  while offline — are counted ("This copy has 3 changed files Nick doesn't
  have", recounted every minute) and **Send to Nick** delivers them peer to
  peer: a patch (secrets, ignored and big files left out, as in backups) that
  lands on the taker's session as "Ryan sent 3 changed files", to review and
  **Apply** — only where it applies cleanly to their worktree as it is, after
  an Undo-turn snapshot so it can be taken out again; otherwise nothing
  changes and the files in the way are named, with the patch's path for a
  `git apply --3way` by hand. A line in the room's chat says it was sent. What
  was sent is remembered (`refs/mockingbird/rooms-sent/…`), so later edits
  count from there.
- **Who can see a backup:** while a session is backed up, anyone with read
  access to the repository can fetch its work in progress from the hidden ref
  (secrets — `.env*`, keys, certificates, credential files — are never in it,
  staged or not; one already committed stays as the branch's commit has it).
  The conversation is never there.
- **Backups don't pile up.** Only a session's current owner deletes its hidden
  ref (and members then delete their copies): when the owner forgets the
  session, when all its work is merged into the base branch, after 14 days
  without a turn (pruned on start and daily), and — for a taken-over session —
  once the taker's own first backup has landed. A deletion that fails is shown
  and retried.

## Team room

A chat thread in each room, for people and agents:

- **Agent updates:** agents post what they claimed, finished, and where
  they're stuck (from board changes and session status).
- **Agents across machines:** Mockingbird's agent messaging (`send_message`,
  `list_sessions`) reaches room sessions on the other laptop through the room.
- **@assistant:** a member @-mentions the assistant. It runs on **the asker's
  laptop under their account**, reads the room (chat, board, session list) and
  the repo's docs, and posts its answer to the room.

## Plan and claims board

- Lives on its own branch, **`mockingbird/plan`**, as `plan.md` (plus a small
  machine-readable claims block). Mockingbird commits and pushes each change and
  syncs it live between members. Feature branches never touch it, so it never
  conflicts.
- Every worktree in a room gets a **read-only copy** at a git-ignored path, kept
  current, plus agent instructions pointing at it. An agent started in a room
  gets those instructions in its launch (Claude's appended system prompt,
  Codex's developer instructions), with the tool pre-allowed for Claude;
  otherwise the SessionStart hook adds them from the worktree's copy. Agents
  propose changes through that Mockingbird tool (`update_team_plan`) rather
  than editing it.
- A work package lists what it owns (folders/files), what it provides and uses
  (contracts), and how it's tested. It's claimed by a member.
- **Claims + warnings:**
  - Before an agent edits a file claimed by a teammate's package, it's warned
    (hook/tool feedback), and so are you. You can still proceed.
  - Mockingbird's overlap check extends across machines: files changed on a
    teammate's pushed branches show on the pane as "Nick's branch also changes
    <file>", and clicking it opens the room's plan board.

## Not in this release

- Roles/permissions beyond "member".
- Other transports (Tailscale, a self-hosted relay): designed for, not built.
- Running sessions on an always-on shared host.

## Testing

- Unit tests for the protocol, signed signaling messages, event-log merge,
  invite codes, snapshot/ref naming, transcript placement, claims matching, and
  the secret deny list. The Worker's room logic is a plain module, tested
  directly and also served by a local signaling server for tests.
- Codex's room sandbox against the installed binary, without a model:
  `codex sandbox` runs probes under the exact `-c` settings a room launch
  passes (through the pane's shell quoting), with a throwaway `CODEX_HOME`
  and a HOME outside the temp folders (`out/sandbox-tests/`, since temp
  folders are writable to every command). Every secret file and login — in
  the repository, another folder, home, the keychain folder, Codex's
  `auth.json`, the PAT file — is unreadable while ordinary files,
  `/etc/ssl/cert.pem` and the co-author hooks stay readable. In a worktree,
  `git commit` (with its Co-authored-by trailer), `stash`, `branch` and
  `fetch` work, so do `npm install` (its cache), cache writes and a local
  service; pushing (to a file remote and over ssh), `git config`, writing a
  hook or the worktree's `commondir`, writing home or a `PATH` folder fail,
  and no SSH agent is reachable. The Codex CLI still reads its own
  `auth.json`. Skipped under CI and without Codex 0.138+.
- Two Mockingbird instances on one Mac (separate HOME/userData, local
  signaling server, real WebRTC between them) driven end to end
  (`MB_E2E_APP=1`): create room, join by code, live pane, remote typing,
  chat, board claim, a backed-up turn, a hand-over from the owner's prompt
  (their agent stopped, the taker continuing), take-over with the owner quit,
  and the owner's app stopping its copy when it starts again. Notifications,
  the cross-machine message, the claim warning, Keep / no answer / dropping
  offline mid-request, unsent changes sent and applied, and Take it back are
  tested over the loopback.
- The same against the deployed Worker (`MB_E2E_SIGNALING_URL`, the creator's
  fingerprint from `npm run team:e2e-fingerprint` allowed on it), asserting
  each connection's path, plus a relay-only variant that forces the TURN
  fallback.
- Then a real run between Ryan's and Nick's laptops through the deployed
  Worker, including from a network that forces the TURN fallback.
