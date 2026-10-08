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
  `member.renamed`, `member.removed` (leaving and removal, below),
  `room.approval`, `join.declined` (joining, below);
  `session.upsert` / `session.removed` (room sessions);
  `session.backup`, `session.takenOver`, `session.backupDropped` (take-over);
  `chat.message`, `chat.update`, `chat.assistant` (team room); `plan.package`,
  `plan.claim`, `plan.status`, `plan.remove`, `plan.repo`, `plan.branches`
  (plan board). Terminal output, views and typing are streams and requests
  between connected members, never stored; so are take-over's copies and
  questions (`takeover.have`, `.snapshot`, `.transcript`, `.ask`, `.progress`,
  `.changes`).

## Rooms

- **A room is a shared top-level group** (e.g. "#5110 Donor entities"). It's
  created on one laptop, and teammates join with an **invite code** a member
  hands over (room id, signaling URL, a one-time join token, and the
  inviter's key fingerprint), once the room's **admin** accepts them
  (Joining, below). Joining records the joiner's public key as a member; after
  that, members reconnect by key.
- Being in a room is the permission. Members can do anything in it — invite
  others included — except let someone in or remove someone else, which are
  the room's **admin**'s (below). Leave room for viewer/driver roles later.
- **Every member keeps a full copy of the room's state**: members, sessions,
  chat, board, presence. It's an append-only event log, ordered by Lamport time
  and merged on reconnect. The room keeps working for whoever's online when the
  creator's laptop is off. An event whose Lamport time is more than a million
  past a member's is refused, so no event can leave the room unable to take
  the next. Origin URLs go into the log without any user name or token, and an
  event carrying one is refused.
- The sidebar shows the room as a group with a shared badge and the initials of
  who's connected right now. Sessions outside rooms are never visible to anyone.

## Joining

Decided with Ryan, 2026-10-08: joins have to be accepted, by the room's
admin only — its creator, or the longest-standing member once the creator
has left (`roomAdmin`). Before this, a valid code let anyone in at once: the
inviter's Mockingbird checked the code and added them, and the signaling
Worker admitted their key as soon as the join key matched.

- **Codes stay open to any member** (the UX is unchanged): Share/Invite…
  makes a one-time code, valid 7 days. The dialog says who will accept: "You're
  the room's admin…" or "it's sent to Ryan (the room's admin) for approval".
- **The request.** The joiner proves to the inviter (the key the code names)
  that it holds the code (an HMAC keyed by the token). The inviter's
  Mockingbird checks it and takes the code — it works once, whatever the admin
  says — then:
  - **the inviter is the admin:** its Mockingbird asks it (below);
  - **otherwise:** it passes the request on to the admin's Mockingbird over
    the room's peer-to-peer channel (`room.joinRequest`), signed by the
    inviter: the joiner's id, key, name and fingerprint, which invite (its
    token hash), and when it expires. If the admin is offline it's held (on
    disk, `join-requests.json` in the room's folder) and passed on when the
    admin connects. An admin on an older Mockingbird can't take it: the
    inviter's Settings → Team says it needs an update.
  The inviter tells the joiner whom it waits for (`join-pending`): the
  joiner's Join a room… and Settings → Team say **"Waiting for Ryan to
  accept"**; an inviter who isn't the admin sees **"Sent to Ryan for
  approval"** (Share/Invite…, and Settings → Team under the room).
- **The admin is asked:** a desktop notification and a prompt, **"Nick wants
  to join #5101"**, with Nick's fingerprint (as Settings → Team shows
  fingerprints) to check with Nick another way — it's what his Settings → Team
  shows as this Mockingbird's fingerprint — and who invited him: **Accept**,
  **Decline**, or **Later**. Requests wait in Settings → Team under the room
  ("Asking to join"), so a missed prompt can be answered later.
- **Accept** is the admin's `member.added` (carrying the inviter); **decline**
  is the admin's `join.declined`, and the Worker drops the joiner at its door
  (`deny`). Both reach the inviter in the room log — at once, or when it's
  next online — and the inviter tells the joiner (`join-accepted`, or
  `join-rejected` saying "Ryan declined your request to join #5101"). The
  joiner keeps trusting only the key its code names: rather than also taking
  the admin's word, which it couldn't check until it had the room's log, it
  hears the outcome from the inviter, who has the request anyway (to pass it
  on). The log still decides: the inviter can't make anyone a member, only the
  admin's `member.added` counts. A joiner that can't be reached when the
  inviter learns the answer hears it the next time it asks (it asks again
  every minute while it waits, and whenever the inviter comes online).
- **Declined:** the joiner is told and gets nothing of the room — no log, no
  connection to any member (members' Mockingbirds refuse non-members, and the
  joiner only connects to its inviter once accepted). The code stays used: a
  declined key needs a new code to ask again.
- **Expiry:** a request expires with its code (7 days at most). The admin's
  list drops it and Accept refuses it; the joiner, still waiting, is told "The
  code expired before Ryan accepted — ask for a new one".
- **Everyone** sees the join in the chat — "Ryan accepted Nick" ("Nick
  joined" for joins from before this) — and members other than the admin who
  accepted and the joiner get a notification, "Nick joined #5101".
- **The room log's rule** (`mayAddMember`, next to `roomAdmin` in
  `src/main/team/rooms.ts`): a `member.added` counts only if its author is the
  admin at that point in the room's order — except for rooms from before
  this. Today's logs hold `member.added` events written by whichever member's
  code was used, so the members those added must stay members. That's kept by
  **position**: a room needs accepting from a point in its order — its
  `room.created` for a room created now (`approval: true`), else its admin's
  first `room.approval`, which the admin's Mockingbird publishes once it has
  this (on start, or on becoming admin). Before that point any member's add
  counts, as it did; after it only the admin's. Every member places events in
  the same order, so every member reduces the same membership, whatever order
  they arrive in. Position rather than a version in the event: a version an
  older (or uncooperative) Mockingbird simply leaves out would keep its adds
  counting forever; a point in the log doesn't move. Adds that don't count are
  kept and passed on, like a non-admin's removal.
- **The signaling Worker's door** (`approve`). A hello with a valid join key
  no longer makes the key a member: it **knocks**. At the door it can only
  exchange the join handshake (`join`, `join-pending`, `join-accepted`,
  `join-rejected`) with members — no WebRTC negotiation, no TURN credentials,
  no invites, admits or revokes, and its welcome lists no member but its
  inviter (when connected), with no removals; members see it flagged as
  knocking. The knock expires with the invite. It becomes a member only when
  the admin, as the Worker knows it (the creator it learned from the salt,
  else the member it admitted earliest; see revoke), sends `admit` for its key
  — the admin's Mockingbird admits everyone its log counts, so accepting does
  it — and is welcomed again as a member. **Only the admin's admit adds
  keys**: a member's admit of a key that isn't a member is ignored (and
  logged). Re-admitting existing members needs nothing: they're already
  members, and a Worker that lost its storage lost its creator record too, so
  it has no known admin — and a room with no known admin (from before revoke,
  its creator not seen since) takes any member's admit, as before, so it
  can't lock everyone out. Every member's Mockingbird keeps admitting the
  members its log counts; since only the admin's `member.added` counts, a
  Worker whose admin differs from the app's (after the creator left) still
  gets the right keys from whoever it sees as admin. **Decline** is `deny
  { member }` from the admin: the knock and its connections go (told
  `declined`), and the invite stays used.
- **Compatibility.** `SIGNALING_PROTOCOL` stays 1: the Worker announces
  `features: ["revoke", "approve"]` in its welcome and `/health`. Against an
  older Worker the joiner is a member at the Worker at once (presence, TURN),
  but approval still happens in the apps — nothing of the room reaches the
  joiner until the admin accepts — and Mockingbird says "Update it (cd
  signaling && npx wrangler deploy) to also hold joiners at the door" in the
  prompt, under the room, and when a decline can't drop them there. Older
  apps: a joiner on an older Mockingbird ignores `join-pending` and simply
  waits; an inviter on an older Mockingbird still adds joiners itself, which
  counts only in a room that doesn't need accepting yet (its admin hasn't
  switched it).
- **Limits.**
  - The room log trusts each author's Lamport time, as removal does: an
    uncooperative member's Mockingbird could backdate an add before a room's
    `room.approval`. Rooms created now need accepting from their first event,
    so there's nothing before it to backdate into.
  - The joiner hears the outcome from its inviter: accepted while the inviter
    is offline, the joiner waits until the inviter is back (the admin can
    still see it's accepted).
  - If the admin who holds a request leaves before answering, the request
    goes with their copy of the room; the inviter passes its own on again to
    the next admin, but a code the old admin made itself has to be sent again.
  - A joiner who cancels doesn't withdraw the request: the admin can still
    accept it until it expires (the joiner just doesn't come in).

## Leaving and removing members

Decided with Ryan, 2026-10-08: members can be removed, and a room that's left
— or that you're removed from — is deleted from your Mac.

- **Who's in the room** is decided by the room log, the same on every member:
  an event counts only if its author is a member at that point in the room's
  order. `member.removed { member, reason }` takes someone out: a member may
  remove themselves (they **leave**); only the room's **admin** removes someone
  else. The admin is the room's creator while a member, else the
  longest-standing member (the earliest `member.added`, in room order, of those
  still in it) — `roomAdmin` in `src/main/team/rooms.ts`. A removal by anyone
  else is kept in the log but changes nothing.
- **After a removal** the member is a *former* member (`state.former`, so their
  name still shows on what they wrote): what they did before still counts,
  anything they write after — written before they heard, or by a Mockingbird
  that doesn't cooperate — changes nothing, including invites they hand out.
  Members' transports refuse their frames, requests and streams as any
  non-member's. A later `member.added` (a new code, from any member, that the
  admin accepts) brings them back, as the newest member.
- **Codes stay open to any member**; letting someone in is the admin's
  (Joining, above). A review flagged "any member can add members": that's now
  closed by the admin accepting, without taking codes away from members.
- **Leave room…** (Settings → Team per room, or the Team tab's ⋯): the leave is
  published and sent to the teammates connected now, who confirm they have it;
  then the signaling Worker cuts this install's key off; then everything of the
  room on this Mac is deleted (below). A failure before publishing changes
  nothing; after it, the rest still runs and what didn't work is shown. Leaving
  as the last member deletes the room the same way.
- **Remove…** (Settings → Team, per teammate, shown to the admin only, saying
  who the admin is and why): the removal is published and sent to everyone
  connected, the removed member included (kept connected a moment so it gets
  through, and confirmed), then the Worker cuts them off. Removing someone
  already removed asks the Worker again — the dialog offers it when the Worker
  didn't. The confirm dialogs say what happens on each side.
- **On the Mac that left, or was removed** (as soon as its Mockingbird applies
  the removal: at once, from a teammate it still shares a connection with, or
  from the Worker when its hello is refused): it stops taking part — no
  connection, live panes, chat, plan or take-over for the room — and deletes:
  - the room's folder `~/.mockingbird/team/rooms/<roomId>/` entirely: log,
    snapshot, settings, invites, take-over records, teammates' conversations
    and received patches;
  - its entries in `chat-read.json` and `live-muted.json`, and a pending join;
  - the plan copies in its worktrees (`.mockingbird/plan.md`, `claims.json`,
    `agent-context.md`; rewritten without the room where another room still
    uses the repository) and its sessions' co-author lists;
  - hidden refs `refs/mockingbird/{rooms,rooms-origin,rooms-left,rooms-sent}/<roomId>/*`
    in every repository Mockingbird knows;
  - its own backups on origin (`git push origin :<ref>`, with a lease), best
    effort: what fails is listed, not hidden.
  The group stays as an ordinary local group; its sessions keep running, no
  longer room sessions (no streaming, typing in, backups or trailers). A
  notice says "You left #5101" or "Ryan removed you from #5101" (a removal
  also as a desktop notification), listing anything that couldn't be cleaned
  up. A cleanup cut short — Mockingbird quitting, a folder that couldn't be
  deleted — runs again on the next start.
- **On the remaining members' Macs**, when they apply a removal: the member's
  sessions leave the room (`ext.sessions`, so their panes go) and their backups
  count as deleted (nobody can take those sessions over); each Mac forgets what
  it got from them — their snapshots in its clone, conversations, records,
  changes they sent, a pending request to hand over — and the mutes of their
  panes; the chat says "Ryan removed Nick" or "Nick left". Commits and their
  Co-authored-by trailers, plan-board history and the `mockingbird/plan`
  branch stay; so do the packages they claimed, under their name, until a
  member changes them.
- **The Worker's side (revoke).** `revoke { member, event }` on the signaling
  connection: allowed for oneself, and for someone else from the room's admin
  as the Worker knows it. The Worker stores the creator's id once its hello
  proves the salt the room id was made from (at creation, and on a later hello
  for a room created before this — so an older room learns its admin the next
  time its creator connects; until then only leaving works there, and refused
  revokes are logged). After the creator leaves, the Worker's admin is the
  member it admitted earliest. On a revoke it deletes the key from the room,
  closes its connections (passing the signed removal on), drops the invites it
  made, refuses its TURN requests and any other message (membership is checked
  on every message), and refuses its hellos with the removal attached — until
  a new invite's join key brings it to the door again (Joining). A member's `admit` (keeping the
  Worker in step with its log) can't bring a revoked key back; only the
  admin's can. The Worker hands the newest removals to members in their
  welcome, so a member who was offline when someone left hears of it even if
  nobody else is online. It can't make up or alter a removal: each app checks
  the event's signature and places it in its own log like any other.
  The admin's Mockingbird also revokes every former member on each connection
  to the Worker, so a revoke that failed (or happened while the Worker was
  older) is made once the Worker can.
- **Compatibility.** `SIGNALING_PROTOCOL` stays 1: a Worker announces what it
  can do in its welcome (`features: ["revoke"]`, also in `/health`). Against an
  older Worker the removal still applies peer to peer, and Mockingbird says
  "Update your signaling Worker (cd signaling && npx wrangler deploy) to also
  cut them off at the Worker" (Settings → Team's dialogs warn before, too).
- **Limits.**
  - Removal can't force a machine to delete anything: a Mockingbird older than
    this, or one that doesn't cooperate, keeps its copy of the room. What cuts
    it off is the Worker — and peers refusing it.
  - The Worker only knows when it admitted each key, not the room log's order:
    after the creator has left, its admin can differ from the app's (two joins
    racing through different inviters, or the Worker having lost its storage
    and re-admitted everyone at once). Then it refuses the revoke and the app
    says so; the removal still applies peer to peer.
  - A member removed while offline whose copy of the room is too old to check
    the removal (the remover joined after they last synced) can't apply it;
    they see the Worker's refusal on the room and can leave by hand.
  - With an older Worker, a member removed while offline only hears of it from
    a teammate they still share another room with; otherwise their room stays
    until they leave it.
  - Someone who leaves while nobody else is online is told nothing back; the
    others hear it from the Worker's welcome (an older Worker: they see them as
    an offline member until the admin removes them).
  - Leaving waits for the cleanup, including deleting backups on origin (each
    push has its own timeout): with an unreachable origin the dialog takes a
    while, then lists what's left there.

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

- Roles/permissions beyond "member" and the admin who lets people in and removes them.
- Other transports (Tailscale, a self-hosted relay): designed for, not built.
- Running sessions on an always-on shared host.

## Testing

- Unit tests for the protocol, signed signaling messages, event-log merge,
  invite codes, snapshot/ref naming, transcript placement, claims matching, and
  the secret deny list. The Worker's room logic is a plain module, tested
  directly and also served by a local signaling server for tests.
- Leaving and removal (`test/teamMembership.test.ts`, and the take-over, live
  panes, plan and signaling tests): who may remove whom, the admin after the
  creator leaves, a removed member's later events changing nothing whatever
  order events arrive in, coming back with a new invite; over the loopback,
  removal of a connected and an offline member, leaving with and without
  anyone online, an older Worker (peer to peer, the message to update it, the
  admin's catch-up once it's updated); what each Mac deletes (the room's
  folder, read marks, mutes, plan copies, hidden refs, backups on origin —
  and a failure there reported), a cleanup cut short finished on the next
  start; the Worker's revoke (self, admin, refused, a room from before revoke,
  admin succession, re-admission, stale admits) and the app's client against
  a new and an older local Worker.
- Joining (`test/teamJoinApproval.test.ts`, the signaling and wire tests):
  `mayAddMember` — the admin's add counts, a member's doesn't, a room from
  before keeps the adds before its admin's switch, in any delivery order;
  over the loopback, the inviter as admin (Accept, Decline, the code used
  up, a new code asking again), an inviter who isn't the admin (passed on,
  the admin offline until later, the answer relayed after the inviter was
  away), expiry, an admin on an older Mockingbird, a member's own add letting
  nobody in, the notifications, an older Worker; the Worker's door (knocking:
  no TURN, invites, admits or member list, only the handshake; expiry; the
  admin's admit promotes, a member's is ignored; deny; a room with no known
  admin; a Worker from before) and the real wire and client against the
  local Worker for accept, decline and an older Worker.
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
  (`MB_E2E_APP=1`): create room, join by code (the admin accepting from its
  prompt, again after removing the joiner), live pane, remote typing,
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
