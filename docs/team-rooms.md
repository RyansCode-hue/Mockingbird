# Team rooms

Live co-presence between two (later more) Mockingbirds: share a group as a
room, see and type into each other's sessions, talk in a team room with your
agents, keep files, notes, repo references and links in it, claim the
project's Radley House tickets on a shared board, and take over a teammate's
session when they're away.

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
  `room.settings` (the admin's: backups to origin);
  `chat.message`, `chat.update`, `chat.assistant` (team room); `house.project`
  (the admin's), `house.track`, `house.untrack`, `house.nudge` (House board;
  never the House's titles, claims or statuses); `artifact.add`,
  `artifact.update`, `artifact.remove` (artifacts' records — never a file's
  bytes). Older rooms' `plan.*` events are kept but change nothing. Terminal
  output, views and typing are streams and requests between connected
  members, never stored; so are take-over's copies and questions
  (`takeover.have`, `.snapshot`, `.transcript`, `.ask`, `.progress`,
  `.changes`) and artifacts' files (`artifact.have`, `.chunk`).

## Rooms

- **A room is a shared top-level group** (e.g. "#5110 Donor entities"). It's
  created on one laptop, and teammates join with an **invite code** a member
  hands over (room id, signaling URL, a one-time join token, and the
  inviter's key fingerprint), once the room's **admin** accepts them
  (Joining, below). Joining records the joiner's public key as a member; after
  that, members reconnect by key.
- Being in a room is the permission. Members can do anything in it — invite
  others included — except let someone in, remove someone else, and choose
  whether backups go to origin, which are the room's **admin**'s (below, and
  "Take-over"). Leave room for viewer/driver roles later.
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
  connection, live panes, chat, House board or take-over for the room — and deletes:
  - the room's folder `~/.mockingbird/team/rooms/<roomId>/` entirely: log,
    snapshot, settings, invites, take-over records, teammates' conversations,
    received patches and the room's artifact files (their downloads stopped
    first);
  - the copies of room artifacts agents were given in their folders
    (`.mockingbird/artifacts/<id>/`);
  - its entries in `chat-read.json` and `live-muted.json`, and a pending join;
  - the room's files in its worktrees (`.mockingbird/claims.json`,
    `agent-context.md`; rewritten without the room where another room still
    uses the repository) and its sessions' co-author lists;
  - hidden refs `refs/mockingbird/{rooms,rooms-origin,rooms-left,rooms-sent}/<roomId>/*`
    in every repository Mockingbird knows;
  - any backups it pushed to origin (`git push origin :<ref>`, with a lease;
    only in a room that backs up there, or where it did before), best effort:
    what fails is listed, not hidden.
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
  Co-authored-by trailers stay; so do their claims in the House, which the
  House alone changes.
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
  - Leaving waits for the cleanup, including deleting any backups on origin
    (each push has its own timeout): with an unreachable origin the dialog
    takes a while, then lists what's left there.

## Sessions in a room

- **Either member can start a session in the room.** It runs on the starter's
  laptop, in their clone of the repo (matched across laptops by the origin URL,
  not the path), under their own Claude/Codex account. It shows for everyone,
  tagged with the owner's initials.
- **Live panes:** a room session's terminal streams to every member. Its
  scrollback is replayed on join, then live output follows. Remote panes render
  like local ones (status, waiting reason, git chips from the owner's side).
- **Scrolling is your own:** in a teammate's pane the wheel, trackpad,
  scrollbar and PageUp/PageDown scroll only your copy — what it has received
  and the scrollback fetched on open — and stay put while output arrives, also
  when the copy is redrawn from the owner's scrollback (a gap in its stream,
  Repaint, the owner back online, the pane shown again after a spell hidden):
  the view is found again by its rows' text. The
  copy's terminal is never given mouse tracking (selection there is native),
  and the wheel never reaches xterm, which would otherwise send the owner's
  program mouse reports or, on the alternate screen, arrow keys. As a backstop
  the owner drops a teammate's input that is only mouse reports or
  PageUp/PageDown (logged once a minute in `pty-audit.log`); typing, paste,
  Ctrl-C and arrow keys go through.
- **Room sessions run inline:** a full-screen agent keeps its history inside
  itself, so a copy of it would show one screen with nothing to scroll. Room
  sessions therefore start on the normal screen, where their history lands in
  the terminal's scrollback — the owner's and every copy's. Claude Code gets
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` in every room pty's environment
  (it outranks a `tui: "fullscreen"` setting and `CLAUDE_CODE_NO_FLICKER`;
  a `claude` started by hand in a room's terminal runs inline too). Codex gets
  `-c tui.alternate_screen="never"` (what `--no-alt-screen` sets, outranking
  `tui.fullscreen_transcript`), fresh or resumed: a setting rather than the
  flag, since an older Codex ignores an unknown setting but refuses to start
  on an unknown flag. The owner gives up the full-screen views in room
  sessions (Claude Code's flicker-free renderer, clicking in it, copy on
  select and Focus view; Codex's full-screen transcript). **Settings → Team →
  Room sessions run inline** (on by default, per install) turns it off for
  that Mac's room sessions. It applies as a session starts: one that joined
  the room while running keeps its screen until restarted, which its "restart
  with the room's rules" chip offers. Anything still full screen (`less`,
  `vim`, a session started before this) shows one screen in a copy;
  scrolling it says so instead.
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
  `.env` files by hand. The same list decides which room artifacts agents
  may not read (Artifacts, below).
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

- **Work:** after every agent turn (the agent going from working or waiting
  to idle, or exiting: the same turns Co-authored-by counts), Mockingbird
  snapshots the worktree, the same way Undo turn does, under a hidden ref
  `refs/mockingbird/rooms/<room>/<session>`, and copies it peer to peer into
  each connected teammate's clone under the same ref (a teammate who connects
  later gets it then). That copy is the backup a teammate takes over from.
  Each session's sidebar row and pane header say where its backup is: the
  owner's "copied to Nick 2m ago" (or "no teammate has a copy yet"), a
  teammate's "copied here 2m ago", "copied here 1h ago · newer on Ryan's
  laptop" or "no copy here · only on Ryan's laptop". A teammate's row also
  offers **Take over**, prominent while its owner is offline.
- **Off GitHub by default, GitHub opt-in** (decided with Ryan, 2026-10-08:
  "Peer to peer, GitHub opt-in"). Backups never reach origin unless the
  room's admin turns on **Also back up to GitHub** (below). Then each snapshot
  is also pushed to that hidden ref on origin, so a session can be taken over
  while its owner's laptop is off even by a teammate who wasn't connected
  when its turns ended — and the rows say "backed up 2m ago", or warn when a
  push failed.
- **Conversation:** the transcript syncs **peer to peer only, never to GitHub**.
  Take-over places it where the taker's CLI resumes it (Claude's
  `~/.claude/projects/<slug>/<id>.jsonl` for the taker's checkout path, or
  Codex's rollout). If the newest transcript never reached the taker, the agent
  resumes from a handoff summary instead (the existing handoff digest), and says so.
- Take-over creates the session's branch/worktree on the taker's laptop from
  the newest snapshot it has: the peer copy in its clone, or — in a room that
  backs up to origin — origin's hidden ref, whichever is newer (a room kept
  peer to peer never fetches from origin, and keeps no `rooms-origin` copy).
  The dialog says which snapshot it uses and how old it is; kept peer to peer
  with the owner offline, it says plainly that this is the newest copy that
  reached this Mac and that newer work may be on the owner's laptop (turns
  since the two were last connected). With no copy here at all, Take over is
  refused, saying so: it can be taken over once the owner is back online
  (and asked), or once the admin turns on backups to origin. The taker's new session is the room's from then
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
- **Who can see a backup:** kept peer to peer, only the room's members whose
  Mockingbird got a copy. Backed up to origin, anyone with read access to the
  repository can fetch its work in progress from the hidden ref. Either way
  secrets — `.env*`, keys, certificates, credential files — are never in it,
  staged or not (one already committed stays as the branch's commit has it),
  and the conversation is never in git.
- **Backups don't pile up.** Only a session's current owner deletes its backup
  — its hidden ref here, and on origin where it pushed one — and members then
  delete their copies: when the owner forgets the session, when all its work
  is merged into the base branch, after 14 days without a turn (pruned on
  start and daily), and — for a taken-over session — once the taker's own
  first backup has been taken (and, in a room backing up to origin, pushed).
  A deletion that fails is shown and retried.

### Also back up to GitHub (the admin's opt-in)

- **Settings → Team, per room:** a switch, "Also back up to GitHub" (or the
  remote's name: Azure DevOps, GitLab, a host, or "origin" when the room's
  repositories differ). Its note says what it does — after each turn, every
  member's room sessions' snapshot (uncommitted and untracked files, never
  secrets) also goes to a hidden ref on the remote, where anyone with read
  access to the repository can fetch it, so a teammate can take over while
  the owner's laptop is off — who the admin is, and who last changed it.
  Turning it on asks first, with that warning; turning it off doesn't.
- **The admin's alone.** It's a replicated room setting: `room.settings
  { backupsToOrigin }`, signed like every event, reduced on every member. Only
  the room's admin at that point in the room's order (`roomAdmin`) changes
  anything; anyone else's event is kept in the log and changes nothing, and
  the switch is disabled for them, naming the admin. A room with no settings
  event — every room made before this — is off.
- **On:** each owner pushes its sessions' newest snapshots at once (not only
  after the next turn), then after every turn, with a lease, as before — but
  now through the repository's own pre-push hook (no `--no-verify`), so a
  secret scanner sees each push first. A hook that refuses one (or chokes on
  a hidden ref) fails the push, and the session shows "backup failed: …" with
  the hook's message; the copy to teammates still goes. Deleting a ref skips
  the hook: a deletion pushes no content, and a hook that refuses hidden refs
  mustn't leave a backup on origin for good.
- **Off again:** each owner deletes from origin every backup ref it pushed for
  the room (`git push origin :<ref>`, with a lease) and pushes no more. A
  deletion that fails shows on the room (Settings → Team's warnings, "backup
  not deleted from origin") and is retried on the next prune (start and
  daily). Teammates stop reading origin for take-overs at once.
- **Rooms from before the setting** are off: their old backups read as pushed
  (their events say nothing of it), and each owner's Mockingbird deletes what
  it pushed from origin on its first start after updating.
- **Mixed versions.** A backup kept off origin still carries a push outcome —
  `{ ok: false, error: "not on origin: this room keeps backups peer to peer" }`
  — with `toOrigin: false`, so a Mockingbird from before the setting accepts
  the event and shows that as why it isn't on origin. An older Mockingbird
  ignores `room.settings` and keeps pushing its own sessions' backups until
  it's updated.

### What's stored where

- **The owner's Mac:** the newest snapshot of each of its room sessions under
  `refs/mockingbird/rooms/<room>/<session>` in the session's repository, and
  `~/.mockingbird/team/rooms/<room>/takeover.json` (what it last snapshotted,
  and what it pushed to origin, if anything).
- **Each teammate's Mac:** the copy sent peer to peer under the same ref in
  its clone (found by origin URL), the conversation under
  `~/.mockingbird/team/rooms/<room>/transcripts/<session>/`, and — only in a
  room backing up to origin, while taking over — what it read from origin
  under `refs/mockingbird/rooms-origin/<room>/<session>`.
- **Origin:** nothing, unless the room's admin turned on backups to origin;
  then each session's newest snapshot under
  `refs/mockingbird/rooms/<room>/<session>` (never a branch, never fetched by
  default). The conversation is never there.

## Team room

A chat thread in each room, for people and agents:

- **Agent updates:** agents post what they claimed, finished, and where
  they're stuck (from board changes and session status).
- **Agents across machines:** Mockingbird's agent messaging (`send_message`,
  `list_sessions`) reaches room sessions on the other laptop through the room.
- **@assistant:** a member @-mentions the assistant. It runs on **the asker's
  laptop under their account**, reads the room (chat, the House board as the
  asker's Mockingbird reads it, session list, artifacts) and the repo's docs,
  and posts its answer to the room.

## Artifacts

Decided with Ryan, 2026-10-12: a room keeps what its members share besides
chat — files and screenshots, notes anyone edits, references to a file (and
lines) in the room's repository, and links — for people and agents alike.

- **Four kinds.** A **file** (a screenshot pasted or dropped, a PDF, a log, at
  most 25 MB); a **note** (markdown, edited by anyone); a **repo file
  reference** (a file, optionally lines, at a commit, in a repository known by
  its origin — it opens in Mockingbird's file viewer in your own clone); a
  **link** (https only, with a title; Azure DevOps work items and pull
  requests are recognised: "ADO #5110", "PR #45").
- **In the room log**, as `artifact.add` (its event id is the artifact's id),
  `artifact.update` (a rename, a note's new text) and `artifact.remove`. Each
  is checked strictly before it's stored — a name of 1–200 characters without
  control characters; a file's size and SHA-256; a note's text up to 60,000
  characters; a repo reference's origin without credentials, a relative path
  without `..`, a full commit id; an https link without a user name — and a
  room keeps at most 500. A member who leaves takes nothing with them: what
  they added stays the room's.
- **A file's bytes never go in the log.** Each member fetches them from a
  teammate who has them, by hash (`artifact.have`, then `artifact.chunk`, half
  a megabyte at a time), and keeps them only once the whole file's SHA-256
  matches the record. Members answer only for live files of the room asked
  about whose checked copy they hold, and only to that room's members. A file
  comes from whoever added it when they're connected, else from any connected
  member that has it; a download cut short resumes from what arrived, from
  whoever has it; a copy that doesn't match its hash is thrown away, the
  member who sent it tried last from then on, and the next one asked. Newest
  files first, files someone opened (or an agent asked for) ahead of the rest;
  up to 1 GB of a room's files come without being asked, older ones beyond
  that when opened. Rounds that fail wait 10 s, 30 s, 2 minutes, then 5
  minutes, and start over when a member connects. Each file's row says where
  it stands: downloading from Nick (how far), "Nick added it and is offline;
  no connected teammate has it yet", or why it failed ("Nick's Mockingbird
  needs an update to share files").
- **Stored** in the room's folder, `~/.mockingbird/team/rooms/<room>/artifacts/`
  (owner-only): `blobs/<sha256>` (read-only, checked: the only files ever
  served), `partial/<sha256>` (a download in progress), `tmp/` (a file being
  added; cleared on start), `view/<id>/<name>` (read-only, quarantined copies
  for Quick Look, Reveal in Finder and Save as). What no live artifact uses is
  deleted (on removal, on start). Leaving the room deletes all of it with the
  room's folder, after stopping its downloads.
- **Shown by content, never by name.** Mockingbird looks at a file's bytes:
  PNG, JPEG, GIF, WebP, BMP and SVG are images (SVG only ever through an
  image element; an image over 50 megapixels goes to Quick Look), PDFs open in
  macOS Quick Look, UTF-8 text without NULs is text (markdown or CSV by its
  extension) — HTML is text; anything else is a file to Quick Look, Reveal or
  Save as. Nothing is ever opened with its default app or run; Quick Look,
  Reveal and Save as act, on a click, on paths Mockingbird made itself, and a
  saved file is quarantined like a download.
- **Adding** (the Team tab's Artifacts section, drag and drop, pasting a
  screenshot) refuses folders, anything that isn't a regular file, files over
  25 MB, anything in Mockingbird's team folder and the ADO PAT file, naming
  each file and why. A file named like a secret (the secret file list:
  `.env*`, `*.pem`, `*.key`, credentials…) or holding a private key is added
  only when asked again: teammates get a copy; agents never read it.
- **Notes edited together.** Saves are explicit. An edit saved from a
  revision someone else's edit replaced doesn't overwrite it: the editor says
  "Nick edited this while you were editing" and offers Overwrite, Save mine as
  a copy, or Reload. When the two edits crossed while apart (offline, a
  partition), every member keeps both — the one first in the room's order as
  the note, the other beside it as "Spec (Ryan's edit)" — and its author is
  told: "Your edit of 'Spec' crossed Nick's; yours is kept as 'Spec (Ryan's
  edit)'".
- **Repo file references** are made from a session's folder, at its HEAD:
  only for a committed file ("commit it first"), with a warning when the file
  has uncommitted changes (the reference is HEAD, without them) and when HEAD
  isn't on any remote branch ("teammates can't see abc1234 until you push").
  On a teammate's Mac it opens in a clone of the same origin — in a live
  session's folder there (the focused one first, then the room's), or as the
  file was at that commit, read-only with the lines highlighted — fetching
  once when the commit isn't there yet. It says when the file changed since,
  or why it can't open: "No clone of github.com/acme/backoffice on this Mac",
  "Commit abc1234 isn't in your clone — not pushed yet?".
- **In chat:** `#` in the composer completes an artifact's name, sent as
  `#[name](artifact:<id>)` and shown as a chip (its current name, or
  "(removed)"). A message carries the ids of the live artifacts it names
  (`artifacts` in `chat.message`; older Mockingbirds leave it out).
- **Agents** read them through two Mockingbird MCP tools, pre-allowed for
  Claude room sessions: `list_room_artifacts` (id, kind, name, who and when,
  size and type, url, repo origin/path/commit/lines, and whether it's
  readable) and `read_room_artifact`: a note, link or text file comes back as
  text, a repo reference as its lines at the commit (and whether the file
  changed since), an image, PDF or other file as a read-only copy in the
  session's folder, `.mockingbird/artifacts/<id>/` — excluded from git at any
  depth (`**/.mockingbird/artifacts/` in the repository's exclude file;
  a repository that tracks that folder gets nothing written), deleted when the
  artifact goes, becomes secret, or the room is left. A file not here yet is
  fetched first (up to 30 s). Everything is labelled as a teammate's content,
  not the user's instructions. Room agents start knowing the tools and the
  `#[name](artifact:<id>)` form. **@assistant** gets them in its prompt: the
  list, then what the question names, notes, text files and repo excerpts
  within a budget.
- **Secrets:** agents never reach the store — it's under
  `~/.mockingbird/team`, which Claude's deny rules and Codex's room sandbox
  keep unreadable — only copies the tool makes after checking. An artifact is
  withheld from agents (listed as not readable, saying why) when its name is
  on the secret file list, or ever was (renaming `.env` to `env.txt` doesn't
  make it readable), when a repo reference points at such a file, or when a
  file holds a private key.
- **Compatibility.** `TEAM_PROTOCOL` stays 1: everything is new events and
  requests. An older Mockingbird keeps the events without showing them, and
  answers file requests with no handler, shown as "Nick's Mockingbird needs an
  update to share files".

## Radley House board

Decided with Ryan, 2026-10-12: the room's board mirrors the project's
**Radley House** tickets instead of a hand-made plan. The House is the system
of record; the room keeps only what the House doesn't. Once the live check
had read the real House the same day, Ryan decided the board leads with the
House's **open backlog**.

- **Which project:** the room's admin chooses it on the board (`house.project`,
  admin-only like `room.settings`: anyone else's is refused locally and
  ignored by every reducer). It names the project, e.g. `atticus-backoffice`;
  each member's Mockingbird reads its **own** `~/.config/radley-house/<project>.env`
  (mode 600: `HOUSE_API_URL`, `HOUSE_PROJECT_ID`, `HOUSE_BUILD_TOKEN`, or the
  House CLI's `EXTERNAL_BUILD_TOKEN`). Each builder mints their own token in
  the House (the project's Overview → External build setup). A missing file,
  one other users can read, a non-https `HOUSE_API_URL` or a missing token
  shows on the board with what to do; the board stays empty there and the
  agents' tools answer the same.
- **The token stays in the main process.** Every House call is made there,
  with the acting member's own token: never sent to the window, an agent, the
  room log or a log line, and scrubbed from every error. Requests go only to
  `HOUSE_API_URL/api/projects/<id>/external/…`, never follow a redirect, and
  time out after 15 s. Errors carry the House's own message.
- **What the board shows** (▦ on a shared group, or "House board" in the
  palette): "Radley House · <project>" with **+ Add ticket**, then:
  - **Open backlog** — every ticket whose status isn't `done` or `dropped`,
    in the House's own order (`GET work-items` lists priority-sorted, high to
    low). Its **Needs an agent** filter keeps the tickets tagged
    `needs-agent` (handed back to an agent), with their count.
  - **Added by the room** — the room's own tickets (`house.track` /
    `house.untrack`, by number, any member) that the open backlog doesn't
    hold: closed ones, or ones the House's list left out.

  A ticket shows once. The room's ticket that is open stays in the backlog,
  in the House's order, with an **added** mark ("Nick added it"), rather than
  being pulled out: the backlog stays complete and its order means something,
  and the second section holds only what the backlog can't show — a ticket
  the room tracked keeps its place on the board after staff close it.

  Each row is `#<n>`, the priority (high, medium, low, investigate), the
  title, its marks — `needs-human` (an agent is blocked on a question for a
  person) and `needs-agent`, "blocked by #122" (`blocked_by`), "waiting on …"
  (`waiting_on`), "added" — then "<person> · <status>" when claimed or the
  status and **Claim** (on a branch: one of your room sessions', or
  `feature/<n>-<slug>`; not offered on a closed ticket). Statuses read as the
  House's flow, human-readably: parked → ready → in progress → review →
  validating → done, or dropped. A row opens the ticket: its detail,
  acceptance, blockers (each opens that ticket) and history, Claim / Release,
  a comment, progress, status change or question, and **Open in the House**.
  History entries are the House's `{at, actor, event, note?, to_status?}`: a
  status change, which has a `to_status` and no note, reads "Ryan · status →
  review"; others read "Nick · progress" with the note below. + Add ticket
  puts an existing ticket on the board, or creates one in the House (it
  starts parked) and adds it.
- **The spec is the requirements document.** `GET spec` answers the frozen
  spec (`title`, `frozen_at`, `sections` …), not a ticket list, so the board
  doesn't read it; agents read it with `get_house_spec`. (The board's first
  version took a "current slice" of tickets from it, and found none.)
- **Who has a ticket:** the room member whose room sessions are on the claim's
  branch, else the member whose name matches the House's claimant, else the
  House's name for them.
- **Reading:** each member's Mockingbird reads the backlog (`GET work-items`)
  and any of the room's tickets the backlog didn't include, about once a
  minute while the board is open or one of its room sessions runs, when the
  admin changes the project, and when a teammate's write nudges it
  (`house.nudge {n}`, published after every write so others read that ticket
  again at once; a new ticket's nudge reads the whole list, for its place in
  the House's order). A ticket is read as the House answers it: `number`,
  `status`, `priority`, `tags`, the claim from `assignee` + `branch`,
  `blocked_by`, `waiting_on` and `history` (other field names the House
  might use are still looked for). Titles, claims and statuses are never
  copied into the room log; the chat's agent updates say only "Ryan claimed
  #143".
- **Writing** (from the board or an agent, as that member): claim
  (`POST …/claim {branch}`), release, progress and status changes
  (`POST …/events {event: "progress", note, status?, reference?}`), a
  question (`{event: "question"}`, then the handoff tags: `needs-human` on,
  `needs-agent` off), a comment (`PATCH …/work-items/<n> {note}`), a new ticket
  (`POST work-items`, then `PATCH {tags}` if it has any). Only staff close a
  ticket as done or dropped; the board never offers it.
- **Agents** in a room get the mockingbird MCP tools `list_house_tickets`
  (no filter: the board — the open backlog, then the room's tickets outside
  it; `filter`: `open`, `tracked` (the room's own) or `all` (everything the
  House lists, closed included, read now); `tag` narrows any, e.g.
  `needs-agent`), `read_house_ticket` (with history), `create_house_ticket`
  (also added to the board), `claim_house_ticket` (on the session's branch
  unless given one; a session on a base branch is asked for one),
  `release_house_ticket`, `post_house_ticket_event` (progress, status,
  question, note) and `get_house_spec` (the requirements document),
  pre-allowed for Claude (Codex approves the server's tools itself). A call
  acts as the session's owner, through the Mockingbird that runs the session,
  so a teammate's agent never uses your token. An agent started in a room
  gets a short summary of the board in its launch — the open backlog (up to
  40 tickets, each with its claim, status, priority, handoff tag, blockers and
  whether the room added it), then the room's other tickets — fenced and
  labelled as data from the House and teammates, not instructions; otherwise
  the SessionStart hook adds the same from the worktree's
  `.mockingbird/agent-context.md`. @assistant gets the same summary.
- **Claims and warnings:** a ticket claimed on a branch owns the files the
  claimant's room sessions on that branch have changed — as their pushed
  branch shows it, fetched from origin into a clone here and compared with the
  repo's base. No paths are entered by hand. Mockingbird writes them to
  `.mockingbird/claims.json` in every worktree of the room's repositories
  (git-ignored, read-only; a worktree on that same branch leaves the ticket
  out). An agent's first edit of one of those files in a conversation is held
  back with the reason ("src/api/x.ts has been changing on Nick's ticket #141
  …"), and so are you told ("Nick's ticket #141 has been changing this
  file"); repeating the edit goes through with a reminder.
- **Overlaps across machines:** the same teammates' branches (every room
  session's, not only claimed ones) feed the overlap check: files changed on
  a teammate's pushed branch show on the pane as "Nick's branch also changes
  <file>", and clicking it opens the room's board.
- **Before the House board,** rooms had a work-package board (`plan.*`
  events, `plan.md` on a `mockingbird/plan` branch). Old rooms' logs still
  load: those events are kept and passed on but change nothing and aren't
  shown. Mockingbird no longer commits or pushes `mockingbird/plan`; branches
  already on origin are left alone (delete them by hand if you like), and a
  worktree's old `.mockingbird/plan.md` is removed the next time its copy is
  written.

## Not in this release

- Roles/permissions beyond "member" and the admin who lets people in, removes
  them and turns on backups to origin.
- Other transports (Tailscale, a self-hosted relay): designed for, not built.
- Running sessions on an always-on shared host.

## Testing

- Unit tests for the protocol, signed signaling messages, event-log merge,
  invite codes, snapshot/ref naming, transcript placement, claims matching, and
  the secret deny list. The Worker's room logic is a plain module, tested
  directly and also served by a local signaling server for tests.
- Leaving and removal (`test/teamMembership.test.ts`, and the take-over, live
  panes, House board and signaling tests): who may remove whom, the admin after the
  creator leaves, a removed member's later events changing nothing whatever
  order events arrive in, coming back with a new invite; over the loopback,
  removal of a connected and an offline member, leaving with and without
  anyone online, an older Worker (peer to peer, the message to update it, the
  admin's catch-up once it's updated); what each Mac deletes (the room's
  folder, read marks, mutes, the room's worktree files, hidden refs, backups on origin —
  and a failure there reported), a cleanup cut short finished on the next
  start; the Worker's revoke (self, admin, refused, a room from before revoke,
  admin succession, re-admission, stale admits) and the app's client against
  a new and an older local Worker.
- Where backups go (`test/teamTakeover.test.ts`, `test/teamTakenOver.test.ts`):
  a room left as it starts never pushes or fetches `refs/mockingbird/*` on
  origin (asserted on the bare origin), copies each snapshot peer to peer,
  and takes over and hands over from that copy; the dialog's age and "newer
  on their laptop", and the refusal with no copy here; only the admin's
  `room.settings` counts (a member's is refused locally and ignored by every
  reducer; after the creator leaves, the next admin's counts); turned on, the
  owners push at once, through a pre-push hook that can refuse (shown as a
  failed backup); turned off, each owner deletes what it pushed (a failure
  shown and retried by the prune); a room from before the setting behaves as
  off, its owner deleting its old backups from origin on start.
- The House board (`test/teamHouse.test.ts`, `test/teamHouseService.test.ts`,
  `test/teamClaims.test.ts`), against a fake House on this Mac (nothing calls
  the real one; it answers with the real House's fields and order): the env
  file (a non-https URL, credentials in it, a missing or placeholder token, a
  file others can read — the token in no message); every route with the
  right method, path, body and token; the House's errors, a timeout, a
  redirect never followed; real-shaped work items and history entries read,
  a status change rendered "status → review"; the open backlog leaving out
  done and dropped in the House's order, the needs-agent filter, each
  ticket shown once (the room's open ones marked in the backlog, the rest
  under Added by the room); every agent tool and its filters, each member's
  calls made with their own token and the House deciding what they may do;
  the agents' context and @assistant's summary listing the open backlog;
  `house.track` and nudges reaching the other member, who reads with their
  own token (a new ticket's nudge reading the list again); polling only while
  the board is open or a room session runs; only the admin's project
  counting; a Mac without the env file; claims from a claimed ticket's branch
  and its pushed files, not in a worktree on that branch, gone once released;
  tokens and House titles never in a view, log line or the room log; old
  `plan.*` logs and snapshots still loading. `test/houseLive.test.ts` runs
  `test/houseCheck.ts` against the real House (GETs only) when run by hand
  with `MB_HOUSE_LIVE=1`, never in CI: the open backlog non-empty when the
  House has open tickets, every status and priority known, histories
  rendered — printing only field names, counts and enum values. The same
  check runs against the fake House in the suite, which proves it reads only
  and prints no title, name, note or branch.
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
- Artifacts (`test/teamArtifacts.test.ts`, `teamArtifactStore`,
  `teamArtifactFiles`, `teamArtifactAgents`): every malformed or oversized
  event refused; add, rename, edit, remove and anything after a removal the
  same on every member; the room's limit; a secret name staying secret through
  renames; edits crossing across a partition giving identical state on both
  sides, a copy, and the notice to its author only; a stale save, Overwrite
  and Save as a copy. Sniffing (HTML named .png is text, SVG, huge images,
  private keys across chunks) and adds refused (folders, symlinks to folders,
  over 25 MB, the team folder, the PAT file). Over the loopback: a file
  reaching a teammate byte-identical in full-size chunks; from a third member
  when the adder is offline; waiting while nobody connected has it; an older
  Mockingbird ("needs an update"); a corrupted copy refused and logged and the
  next member used; a download cut short resumed from its partial; chunk and
  have requests refused for another room's, a removed or a non-member's file;
  removal deleting the files and agents' copies on both sides; files beyond
  the eager budget fetched once opened; leaving deleting the room's files and
  agents' copies while what the leaver added stays. Repo references against
  a bare origin and two clones (warnings, untracked refused, found by origin,
  opened in a session's folder, changed since, no clone, a commit not pushed
  until it is); the agents' tools through Messaging (text inline, an image
  copied into a subfolder's `.mockingbird/artifacts/` git-ignored and fetched
  first, a repository tracking that folder refused, secrets and private keys
  withheld, a session outside a room refused); @assistant's section (named
  ones first, secrets withheld) through a question asked in the chat; Quick
  Look, Reveal and Save as on copies main made, quarantined.
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
  prompt, again after removing the joiner), live pane, remote typing, chat,
  board claim, a turn backed up peer to peer (nothing on origin), a hand-over
  from the owner's prompt (their agent stopped, the taker continuing),
  take-over from the peer copy with the owner quit,
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
