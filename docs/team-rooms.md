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
  creator's laptop is off.
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
  drafter uses. Nothing in that list is ever sent over the connection.
  Teammates swap `.env` files by hand.
- **What the deny rules don't cover:** they stop Claude's file tools, not a
  shell command the user approves (`cat .env`). Codex gets none: its deny-read
  rules live in a permission profile in `~/.codex/config.toml`, which replaces
  its sandbox settings, so Mockingbird doesn't set them; a Codex room session
  says "codex: secrets unguarded". A terminal in a shared group is shared too
  (anyone in the room sees and can type into it) and says so. A session moved
  into a shared group while running keeps what it started with until it's
  restarted, and offers the restart.
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
  mirrors peer to peer. After every agent turn, Mockingbird also snapshots the
  worktree, the same way Undo turn does, and pushes it to a hidden ref
  `refs/mockingbird/rooms/<room>/<session>` on origin. That's the backup when
  the owner's laptop is off. Each session shows how fresh its backup is
  ("backed up 2 min ago", or a warning when a push failed).
- **Conversation:** the transcript syncs **peer to peer only, never to GitHub**.
  Take-over places it where the taker's CLI resumes it (Claude's
  `~/.claude/projects/<slug>/<id>.jsonl` for the taker's checkout path, or
  Codex's rollout). If the newest transcript never reached the taker, the agent
  resumes from a handoff summary instead (the existing handoff digest), and says so.
- Take-over creates the session's branch/worktree on the taker's laptop from
  the newest snapshot it has (peer copy or hidden ref, whichever is newer). It
  says which snapshot it used. The original owner sees the session as
  taken over when they come back.
- **Who can see a backup:** while a session is backed up, anyone with read
  access to the repository can fetch its work in progress from the hidden ref
  (secrets — `.env*`, keys, certificates, credential files — are never in it).
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
  current, plus agent instructions pointing at it. Agents propose changes
  through a Mockingbird tool rather than editing it.
- A work package lists what it owns (folders/files), what it provides and uses
  (contracts), and how it's tested. It's claimed by a member.
- **Claims + warnings:**
  - Before an agent edits a file claimed by a teammate's package, it's warned
    (hook/tool feedback), and so are you. You can still proceed.
  - Mockingbird's overlap check extends across machines: files changed on a
    teammate's pushed branches show up as "Nick's branch also changes this".

## Not in this release

- Roles/permissions beyond "member".
- Other transports (Tailscale, a self-hosted relay): designed for, not built.
- Running sessions on an always-on shared host.

## Testing

- Unit tests for the protocol, signed signaling messages, event-log merge,
  invite codes, snapshot/ref naming, transcript placement, claims matching, and
  the secret deny list. The Worker's room logic is a plain module, tested
  directly and also served by a local signaling server for tests.
- Two Mockingbird instances on one Mac (separate HOME/userData, local
  signaling server, real WebRTC between them) driven end to end: create room, join by code, live pane, remote
  typing, notifications, chat, cross-machine message, board claim + warning,
  take-over with the owner offline.
- Then a real run between Ryan's and Nick's laptops through the deployed
  Worker, including from a network that forces the TURN fallback.
