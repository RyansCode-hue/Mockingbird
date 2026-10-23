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
  `~/.mockingbird/team/identity.json`, never synced) and a display name set in
  Settings → Team. The private key is sealed with Electron's `safeStorage`,
  whose key the macOS Keychain keeps for Mockingbird ("Mockingbird Safe
  Storage"), so the file alone — from a backup, a disk image, another account
  — isn't enough to act as the member (security review R3). Chosen over a
  generic-password item written by the `security` CLI: that item trusts
  `/usr/bin/security`, so any process running as the user could read it back
  without a prompt; the safeStorage item is readable without asking only by an
  app with Mockingbird's code signature. On the first start with it, a plain
  key (version 1) is moved: the same key, so the same fingerprint (no room
  joined again); sealed, opened again and compared, the file replaced in one
  step (owner-only from the moment it exists), read back from disk and
  compared again — a read-back that doesn't match puts the plain file back.
  Without the Keychain (or off macOS) the plain file keeps working, with one
  warning in the log and Settings → Team. A sealed key that can't be opened
  (the Keychain refused) stops team rooms with that reason and is never
  replaced: the next start with the Keychain back opens it. Limits: a copy of
  the plain file in an older backup or snapshot stays readable; resetting the
  login keychain loses the key (the member joins their rooms again); an
  unsigned build may be asked once per update to use its Keychain item.
  `npm run team:fingerprint` reads only the public key. Tests seal with a fake
  (`KeySealer`); the two-instance tests run with `--use-mock-keychain`.
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
  `session.backup`, `session.takenOver`, `session.backupDropped`,
  `session.awayGrant`, `session.takeoverAccepted` (take-over);
  `room.settings` (the admin's: backups to origin, the migration check and
  migration folders); `migration.reserved`, `migration.released` (migration
  numbers, below);
  `chat.message`, `chat.update`, `chat.assistant` (team room); `house.project`
  (the admin's), `house.track`, `house.untrack`, `house.nudge` (House board;
  never the House's titles, claims or statuses); `artifact.add`,
  `artifact.update`, `artifact.remove` (artifacts' records — never a file's
  bytes). Older rooms' `plan.*` events are kept but change nothing. Terminal
  output, views and typing are streams and requests between connected
  members, never stored; so are take-over's copies and questions
  (`takeover.have`, `.snapshot`, `.transcript`, `.handover`, `.progress`,
  `.changes`; `.ask` is the pre-grant request, refused) and artifacts' files
  (`artifact.have`, `.chunk`).

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
- **Names are one line.** A room's name and a member's (`room.created`,
  `member.added`, `member.renamed`) are refused with a control character in
  them — a line break above all: names go into what agents read, where one
  could pass for a line of Mockingbird's. Only events being added are checked,
  never a log being loaded, so a room that stored such a name before still
  loads; and whatever its source, every teammate- or House-sourced name an
  agent reads (the room's instructions, the claims check, a teammate's agent
  message, @assistant, the artifact tools) is on one line, quoted unless it's
  plain words, with `<` and `>` escaped in quotes
  (`src/shared/team/agentText.ts`).
- **A failed request tells the teammate little.** When answering a
  teammate's request fails, they're told only that it failed there ("the
  reason is in its log"); the reason, which may name this Mac's folders, is
  logged here. Refusals written for them (wrong room, not their session,
  malformed parameters) still say why.
- The **Team room** view lists the rooms, each with its presence in words
  ("Shared room · Nick online"), its sessions — yours and teammates' — and its
  chat. The Sessions view lists your own sessions in a room's group (marked
  "Shared room") but not teammates', and one **Connected sessions** line
  ("Connected sessions · 4", who's online) that opens the Team room view: on
  the only room, or on the room list. Sessions outside rooms are never visible to anyone.

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
- **Leave room…** (Settings → Team per room, or a room's More / right-click menu in the Team tab): the leave is
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
  - the teammates' conversations it saved in its worktrees at the room's
    take-overs (`.mockingbird/takeover/`, below);
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
  not the path), under their own Claude/Codex account. It shows for everyone;
  its row says whose it is, whether it runs and who's looking, in words
  ("Nick's session · live · Sam is in it"). The pane header keeps the owner's
  and lookers' initials, with tooltips.
- **Live panes:** a room session's terminal streams to every member. Its
  scrollback is replayed on join, then live output follows. Remote panes render
  like local ones (status, waiting reason, git chips from the owner's side).
  A copy is drawn at its owner's terminal size, which a teammate never
  changes: its font shrinks to fit the pane, and where the pane is taller
  than that, the owner's screen sits at the bottom, prompt last.
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
  select and Focus view; Codex's full-screen transcript). Inline also means a
  teammate's copy holds everything the session's terminal keeps, as far back
  as it goes, not only the screen on view: whatever it printed (a secret an
  agent showed, say) is in their scrollback too — the setting's note says so.
  **Settings → Team → Room sessions run inline** (on by default, per install)
  turns it off for that Mac's room sessions. It applies as a session starts: one that joined
  the room while running keeps its screen until restarted, which its "restart
  with the room's rules" chip offers. Anything still full screen (`less`,
  `vim`, a session started before this) shows one screen in a copy;
  scrolling it says so instead.
- **Room sessions stay in their panes:** every Claude Mockingbird starts has
  Claude Code's agent view off (`CLAUDE_CODE_DISABLE_AGENT_VIEW=1`), so `←`
  at an empty prompt or `/background` can't move a room session into Claude's
  own background daemon. There it would run outside the room: no pane for
  teammates' copies, a worker that outlives its owner quitting Mockingbird,
  the launch flags Claude carries over (the denied reads, the Mockingbird
  tools and the room's instructions) but the environment of whichever
  terminal started Claude's daemon rather than the room pty's (its hooks,
  inline rendering). Resuming a pane whose
  conversation got there anyway stops the background copy first and says so
  in the pane (not mid-turn: the resume says why and waits).
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
on their laptop under their own account — only with the owner's signed
consent (below: "The owner's consent").

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
  room's admin makes **Also back up to GitHub** available (below) and the
  session's owner allowed it for their own sessions. Then each snapshot
  is also pushed to that hidden ref on origin, so a session can be taken over
  while its owner's laptop is off even by a teammate whose Mac has no copy of
  its latest turns — and the rows say "backed up 2m ago", or warn when a
  push failed.
- **Conversation:** the transcript syncs **peer to peer only, never to GitHub**.
  Take-over **starts a new conversation on the taker's account; it never
  resumes the owner's** (decided with Ryan, 2026-10-12). A resumed
  conversation is sent whole on its first turn, and the taker's account has
  none of it cached: a long session cost the taker a large share of their
  usage window just to continue. The new session's first input is a
  **handover brief** Mockingbird builds without a model call
  (`src/main/team/takeoverBrief.ts`, about 15k tokens at most): the session's
  title, ticket, room and repository; the branch and the worktree its snapshot
  was checked out in; the changed files (`git diff --stat` against the base it
  was cut from, and untracked files); the latest to-do list or plan (Claude's
  TodoWrite or ExitPlanMode, Codex's update_plan); and the conversation's
  first request and last turns — user and agent text, tool names and short
  inputs, never tool output. What came from the owner's session is fenced
  (`<handover>` … `</handover>`, one entry per line, its own angle brackets
  swapped) and the agent is told it's a record, not instructions: it could
  carry text written to steer an agent.
- **The whole transcript, on demand.** What arrived is saved read-only
  (owner-only, 0400) in the new worktree at
  `.mockingbird/takeover/<transcript's file name>` — `.mockingbird/` is in the
  repository's `.git/info/exclude` first, so it's never committed or in a
  backup — and the brief says where, to read only when it needs detail. If it
  can't be saved (a repository that tracks `.mockingbird/`), the brief says so
  and the failure is logged.
- **Kept only while it's needed.** It's the owner's whole conversation, never
  filtered for secrets, readable by any agent started in that worktree, so
  Mockingbird records where it saved it (`takeover.json`'s `saved`) and
  deletes `.mockingbird/takeover/` once the session continued there
  is done with it: when that session is taken over again (taken back, or
  handed back — as soon as this Mac hears), closed, or its backup dropped by
  its owner (closed, merged, stale); on the prune (start and daily) when it's
  gone or had no turn for 14 days, or never started; when this Mac leaves the
  room or is removed; and with the room's files when its repository is no
  longer any room's. The taker's first backup — which drops the owner's old
  one — doesn't: the agent may still need it. One saved by 1.4.7–1.4.9, with
  no record, is found from the room's take-overs and the worktree the
  continued session runs in. Each deletion is logged; it goes through
  `fileOps.ts`'s helpers (a `.mockingbird` or `takeover` that is a link is
  refused, never followed; links inside it are removed, not their targets),
  and one that fails is logged, shown with the room's warnings ("conversation
  not deleted from its worktree"; in the notice when leaving) and retried on
  the next prune.
- **Part or none of it arrived:** the brief says the conversation's end is
  missing (it's built from what arrived), or that there's nothing of it but the
  files, and the agent is asked to say so first.
- **Taking it back resumes your own conversation.** When the session being
  taken over is one this Mac's own session became (Take it back), this Mac's
  own conversation resumes — on its own account, moved to the new worktree —
  and its first input is the brief of what the teammate did meanwhile. The
  dialog says which it will be.
- Take-over creates the session's branch/worktree on the taker's laptop from
  the newest snapshot it has **that the owner signed** (security review N6):
  only a commit the room log's `session.backup` names (its newest, or the one
  it says origin holds) — or, for a hand-over, the one the owner's signed
  answer names — chosen by the time in those signed records, never a date
  inside a commit. The peer copy is the commit the owner's Mockingbird sent
  this Mac (`takeover.snapshot` names it; the bundle's objects are fetched,
  the ref set to that commit only if it arrived — a commit's id is the hash of
  its content — whatever the bundle's own ref says, and a mismatch is refused
  and logged). In a room that backs up to origin, origin's hidden ref counts
  only when it points at one of those signed commits; anything else — anyone
  who can push to the repository can set that ref, member or not, and plant a
  tree with `.claude/settings.json` or `.mcp.json` in it — is ignored, its
  copy deleted, logged and shown in the dialog ("origin's backup ref points
  at 1a2b3c4d, a commit Ryan never recorded backing up — ignored"). So
  origin's newer backup is used once the room's record of it reached the
  taker (through any member), not before. A room kept peer to peer never
  fetches from origin, and keeps no `rooms-origin` copy.
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
- **The owner's consent** (security review R6, M3; 1.5). A take-over counts
  only with a grant the session's owner signed with their identity key
  (`src/main/team/takeoverGrants.ts`), carried in `session.takenOver`. Every
  member's reducer checks it where the take-over falls in the room's order —
  the owner's key as the room knows it, the session, the taker and (for a
  hand-over) the snapshot, the event's time within the grant's — so the
  owner's Mac stops its session only for a take-over its owner granted, from
  whichever Mockingbird it came, and the taker's Mac checks the same before it
  starts anything. **No role gets past it**: the room's admin can't take a
  session over without its owner's grant either. (Room roles may later add an
  emergency path for an owner gone for good; it would be its own explicit,
  announced and logged event, not an exception to this check.) A take-over
  without a valid grant changes nothing — the owner's session runs on and
  keeps backing up — and is kept in the room's state as `ungranted`, so the
  owner's Mac can say so: once per taker, in the room's chat ("“Export API”
  keeps running on Ryan's laptop: Nick's Mockingbird needs to update to take
  over…") — the only way to reach an older Mockingbird, which believes it took
  the session over — in the log, and under the room's warnings. Times are the
  take-over event's own (its author's clock, the only one every member
  agrees on): a taker whose clock is set wrong on purpose can use a grant past
  its expiry, but never without the owner having signed one for that session.
- **Owner online → asked first** (decided with Ryan, 2026-10-07). If the owner
  is connected when a teammate clicks Take over, it doesn't happen at once:
  the owner gets a prompt (and a notification), "<Nick> wants to take over
  “<session>”", with **Hand over** / **Keep it**. Hand over lets
  the turn in progress finish (at once if the agent isn't working; a turn
  still running after 30 minutes keeps the session), backs the session up,
  copies that snapshot and the whole conversation to the taker peer to peer,
  stops the owner's agent, and answers (`takeover.handover`) with the
  snapshot and a signed **hand-over**: for that session, that teammate and
  exactly that snapshot, good for 30 minutes. The take-over then uses exactly
  it. Keep, no answer within 2 minutes, or the owner dropping offline
  mid-request: the taker is told, and nothing is taken over. The taker's
  dialog shows the request's progress.
- **Owner away → only with their away grant.** Before leaving, the owner
  allows it: Settings → Team, per room, **While I'm away** — all their
  sessions in the room, or one, for 8 hours, a day, 3 days or a week (at
  most). Their Mockingbird signs an **away grant** and publishes it
  (`session.awayGrant`); only their latest counts, it ends by itself, and
  **Stop** withdraws it (publishing none). With it, Take over works while
  they're offline from the newest signed backup, as above; the button leads
  and its title says until when. Without one, an offline owner's session
  can't be taken over: the dialog says why and whom to ask ("Ryan hasn't
  allowed take-overs while they're away. Ask Ryan to hand it over when
  they're back online, or to allow take-overs while they're away (Settings →
  Team).") and Take over is disabled. Online, they're asked first whatever
  their away grant says.
- **Mixed versions** (both teammates need 1.5 for take-over; the rest of the
  room works with older peers as before). An older taker's request
  (`takeover.ask`) is refused: "Nick needs to update Mockingbird to take over
  “Export API”: take-overs now need Ryan's signed hand-over". An older owner
  can't be asked (there's no `takeover.handover` there): "Ryan needs to update
  Mockingbird to hand “Export API” over". An older owner's offline sessions
  can't be taken over (they can't sign an away grant; their backups lack
  `grants: 1`, and the dialog says they need an update). An older taker's
  take-over while the owner is away changes nothing on a newer owner's Mac
  (above), though that older Mac believes it took the session over until it's
  updated. Take-overs from before grants: a newer Mac replays the room's log,
  so an old take-over without a grant would no longer count; the owner's
  Mockingbird, on its first start with grants, accepts each one it had
  already honoured (it kept a record of each copy it stopped: `takeover.json`'s
  `left`) with `session.takeoverAccepted`, with the old backup's drop if the
  taker made one — and never one it didn't honour.
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
  repositories differ). Its note says what it does — after each turn, the
  room sessions' snapshot (uncommitted and untracked files, never secrets) of
  each member who allows it also goes to a hidden ref on the remote, where
  anyone with read access to the repository can fetch it, so a teammate can
  take over while the owner's laptop is off — who the admin is, and who last
  changed it. Turning it on asks first, with that warning; turning it off
  doesn't.
- **Each member's own consent** (security review R7; 1.5). The admin's
  switch only makes it available: nobody's work goes to origin on the
  admin's word. Each member is asked once per room, "Back up my room sessions
  to GitHub (origin)?" — Allow / Not now — and the answer is kept on their Mac
  (`~/.mockingbird/team/backup-consent.json`, owner-only, like the House
  token's consent; forgotten when they leave the room). Settings → Team has
  their own switch under the admin's ("Back up my sessions to GitHub").
  Until they allow it their backups stay peer to peer, recorded with
  `toOrigin: false` and the push outcome "not on origin: its owner keeps
  their backups peer to peer"; teammates then don't read origin for those
  sessions. Allowing it pushes their newest snapshots at once; turning their
  own off deletes from origin what they pushed (as the admin's switch turning
  off does), a failure shown and retried.
- **The admin's alone.** It's a replicated room setting: `room.settings
  { backupsToOrigin }`, signed like every event, reduced on every member. Only
  the room's admin at that point in the room's order (`roomAdmin`) changes
  anything; anyone else's event is kept in the log and changes nothing, and
  the switch is disabled for them, naming the admin. A room with no settings
  event — every room made before this — is off.
- **On:** each owner who allowed it pushes its sessions' newest snapshots at once (not only
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
  under `refs/mockingbird/rooms-origin/<room>/<session>`. The taker's Mac also
  has the conversation in the new worktree's `.mockingbird/takeover/` while
  the continued session needs it.
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
  Since 2026-10-14 (a terminal of Nick's running Claude showed live on
  Ryan's Mac while messages to it were refused as "no running session"):
  `list_sessions` lists every running pane a teammate's live panes
  show in the room (`agents.list` answers with the same set the owner
  publishes), by the id `send_message` takes. A terminal is listed but never
  typed into, whatever runs in it — a message typed after its agent quits
  would run as a shell command — and an exited agent's pane likewise; both
  carry `accepts_messages: false` and `why` (`roomMessageRefusal`,
  `src/shared/team/livePanes.ts`; `list_teammate_changes` marks its sessions
  the same way from their records). A refused message says why, from the
  owner's Mockingbird, and is logged on both Macs: a terminal or an exited
  agent; closed (only its owner can resume it); taken over (where it
  continues, by the id to use); in another room the sender is in (named).
  A session outside every room the sender shares gets the same words as an
  id that never existed, so no group outside the room is ever named.
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
  `.env*`, `*.pem`, `*.key`, credentials…), holding a private key, or in one
  of this Mac's credential stores by its real path (`~/.ssh`, `~/.aws`,
  `~/.config/gh`, `~/.netrc`, `~/.git-credentials`, `~/.config/radley-house`)
  is added only when asked again: teammates get a copy; agents never read it.
  A file from a credential store is marked so in its `artifact.add`
  (`wasSecret`), so renaming it never makes it readable. A note whose text
  holds a private key is asked about the same way when it's added, and when a
  save (or Save as copy) brings one in.
- **Notes edited together.** Saves are explicit. An edit saved from a
  revision someone else's edit replaced doesn't overwrite it: the editor says
  "Nick edited this while you were editing" and offers Overwrite, Save mine as
  a copy, or Reload. When the two edits crossed while apart (offline, a
  partition), every member keeps both — the one first in the room's order as
  the note, the other beside it as "Spec (Ryan's edit)" — and its author is
  told: "Your edit of 'Spec' crossed Nick's; yours is kept as 'Spec (Ryan's
  edit)'". A copy of a note agents may not read (Save mine as a copy, or a
  crossed edit) stays unreadable to them: the copy's `artifact.add` carries
  `wasSecret`, kept the same on every member, so ".env (copy)" renamed to
  "notes" is still withheld.
- **Removing doesn't take it back.** `artifact.remove` deletes a file's bytes
  on every member and the copies agents were given, and chat chips say
  "(removed)". But the room log is append-only and every member keeps all of
  it: the artifact's name, and for a note every text ever saved, stay in each
  member's log and reach anyone who joins later; a copy someone saved with
  Save as… stays theirs. Any member can remove, rename or edit any artifact,
  not only its author. The remove confirmation says so. (Nothing is
  encrypted per artifact, so nothing can be shredded after the fact.)
- **Repo file references** are made from a session's folder, at its HEAD:
  only for a committed file ("commit it first"), with a warning when the file
  has uncommitted changes (the reference is HEAD, without them) and when HEAD
  isn't on any remote branch ("teammates can't see abc1234 until you push").
  On a teammate's Mac it opens in a clone of the same origin — in a live
  session's folder there (the focused one first, then the room's), or as the
  file was at that commit, read-only with the lines highlighted — fetching
  once when the commit isn't there yet (a person opening one always fetches;
  an agent's read, or an @assistant question naming it, doesn't fetch again
  within five minutes of a fetch that didn't bring that commit; the rest of
  @assistant's excerpts never fetch, so a turn never waits on fetches for
  references nobody asked about). It says when the file changed since,
  or why it can't open: "No clone of github.com/acme/backoffice on this Mac",
  "Commit abc1234 isn't in your clone — not pushed yet?".
- **In chat:** `#` in the composer completes an artifact's name, sent as
  `#[name](artifact:<id>)` and shown as a chip (its current name, or
  "(removed)"). A message carries the ids of the live artifacts it names
  (`artifacts` in `chat.message`; older Mockingbirds leave it out).
- **Agents** read them through two Mockingbird MCP tools, pre-allowed for
  Claude room sessions: `list_room_artifacts` (id, kind, name, who and when,
  size and type, url, repo origin/path/commit/lines, and whether it's
  readable — a withheld one without its url or repo fields) and
  `read_room_artifact`: a note, link or text file comes back as text, a repo
  reference as its lines at the commit (and whether the file changed since),
  an image, PDF or other file as a read-only, quarantined copy in the
  session's folder, `.mockingbird/artifacts/<id>/` (folders owner-only) —
  excluded from git at any depth (`**/.mockingbird/artifacts/` in the
  repository's exclude file; a repository that tracks anything under
  `.mockingbird/`, the folder itself committed as a symbolic link included,
  gets nothing written), deleted when the artifact goes, becomes secret, or
  the room is left. A file not here yet is fetched first (up to 30 s).
  Everything is labelled as a teammate's content, not the user's
  instructions: the artifact's name quoted, and what it holds between
  `<room-artifact>` tags (the tag taken out of the content, so it can't end
  the fence early). A tool call that fails is told to the agent and logged
  here. Room agents start knowing the tools and the `#[name](artifact:<id>)`
  form. **@assistant** gets them in its prompt the same way: the list (a
  withheld link or reference without its url or path), then what the
  question names, notes, text files and repo excerpts within a budget.
- **Secrets:** agents never reach the store — it's under
  `~/.mockingbird/team`, which Claude's deny rules and Codex's room sandbox
  keep unreadable — only copies the tool makes after checking. An artifact is
  withheld from agents (listed as not readable, saying why) when its name is
  on the secret file list, or ever was (renaming `.env` to `env.txt` doesn't
  make it readable), when it came from a credential store or is a copy of a
  withheld note (`wasSecret`), when a repo reference points at such a file,
  or when a file or a note holds a private key.
- **Writes into worktrees never follow links.** A worktree and a session's
  folder are the agent's to write, so it could turn `.mockingbird` (or
  `agent-context.md`, or the repository's `info/exclude`) into a symbolic
  link to `~/.zshrc` and have Mockingbird write there. Every file Mockingbird
  writes or deletes inside one — `claims.json`, `agent-context.md`,
  `overlaps.json`, `migrations.json`, the old `plan.md`, agents' artifact
  copies, the exclude line — goes through
  `fileOps.ts`'s worktree helpers: each folder under the worktree is checked
  with lstat and a link (or something that isn't a folder) is refused, a file
  is read only when it's a regular file, and it's written as a new file
  beside its name (`O_EXCL | O_NOFOLLOW`) then renamed over it, which
  replaces the name, never a link's target. A refusal is shown: on the room's
  board for the claims copy, to the agent and in the log for an artifact copy,
  in the room's artifact problems for a copy's cleanup. Node has no `openat`,
  so a folder swapped for a link between the check and the write isn't
  caught; one already there always is.
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
- **Each member allows their own token, once per room and project** (Ryan's
  decision after the security audit, 2026-10-12). The admin picks the project,
  but nothing reads a member's env file or calls the House with their token
  for the room until that member says yes: "Use your <project> builder token
  for room <name>?" — **Allow** / **Not now**, on a toast that stays until it's
  answered and on the board, which shows **Connect your <project> token**
  meanwhile (while that room's board is open, its toast steps aside: one
  question in one place). The answer is kept on this Mac per room and project
  (`~/.mockingbird/team/house-consent.json`, never in the room log) and asked
  again when the admin points the room at another project; leaving the room
  forgets it. The admin choosing a project on their own board is their
  answer. Until a member allows it, polls and teammates' nudges read nothing
  there, and their agents' House tools answer that their user hasn't
  connected the House for this room.
- **The token stays in the main process.** Every House call is made there,
  with the acting member's own token: never sent to the window, an agent, the
  room log or a log line, and scrubbed from every error. Requests go only to
  `HOUSE_API_URL/api/projects/<id>/external/…`, never follow a redirect, and
  time out after 15 s. An answer is read as it streams and refused past 5 MB
  (a chunked one too). Errors carry the House's own message, on one line
  with no angle brackets (agents get errors as tool answers).
- **What the board shows** (**Board**, with the kanban-board icon, on a room in
  the Team room view and in a shared group's bar, or "House board" in the
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
  again; a new ticket's nudge reads the whole list, for its place in the
  House's order). A nudge is read only for a ticket on the board (the open
  backlog as last read, or one the room added), so a teammate can't make your
  token read any number they like; and per room at most one go every 3 s,
  the nudges in between gathered — a go of more than five tickets, or a new
  ticket, reads the whole board instead, at most once every 30 s. A ticket is
  read as the House answers it: `number`, `status`, `priority`, `tags`, the
  claim from `assignee` + `branch`, `blocked_by`, `waiting_on` and `history`
  (other field names the House might use are still looked for). When the
  list's work items lack one of the fields read (no claim field at all,
  `status`, `title`, or a number), the board warns that the House's API may
  have changed, rather than showing every ticket as unclaimed. Titles, claims
  and statuses are never copied into the room log; the chat's agent updates
  say only "Ryan claimed #143", or "Ryan's agent (Export API) claimed #143".
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
  question, note) and `get_house_spec` (the requirements document). A call
  acts as the session's owner, through the Mockingbird that runs the session,
  so a teammate's agent never uses your token. An agent started in a room
  gets a short summary of the board in its launch — the open backlog (up to
  40 tickets, each with its claim, status, priority, handoff tag, blockers and
  whether the room added it), then the room's other tickets — fenced and
  labelled as data from the House and teammates, not instructions; every
  House- or teammate-sourced string in it is on one line with `<` and `>`
  swapped out, so nothing can close the fence. Otherwise the SessionStart
  hook adds the same from the worktree's `.mockingbird/agent-context.md`.
  @assistant gets the same summary.
- **An agent's writes wait for its owner's OK in its pane** (Ryan's decision
  after the security audit, 2026-10-12: a prompt-injected agent could
  otherwise claim, release, comment on or create any ticket with its owner's
  token). The reads — `list_house_tickets`, `read_house_ticket`,
  `get_house_spec` — run without asking. Every call of `create_house_ticket`,
  `claim_house_ticket`, `release_house_ticket` and `post_house_ticket_event`
  asks first, with the agent's own permission prompt in that session's pane:
  - **Claude:** a room session's launch pre-allows only the read tools (and
    the room artifacts' two), and Mockingbird's MCP server marks each write
    tool `_meta["anthropic/requiresUserInteraction"]`, so Claude Code prompts
    on every call — in auto, acceptEdits and bypassPermissions modes too,
    with no "don't ask again", whatever allow rules say. In `dontAsk` mode
    it refuses the call instead.
  - **Codex:** every session's launch sets
    `mcp_servers.mockingbird.tools.<write tool>.approval_mode="prompt"` (the
    rest of the server's tools stay pre-approved). "prompt" asks on every
    call (it offers no approve-for-the-session); with `approval_policy =
    "never"` Codex refuses the call. Codex honours per-tool `approval_mode`
    from 0.138 (checked: 0.156.1 validates it, with values auto, prompt,
    writes, approve); a Codex session older than that, or whose version
    Mockingbird couldn't read, has its House writes refused by Mockingbird,
    with what to do instead. So does a Codex session that joined the room
    while running: outside the room's permission profile, a Codex set to
    `approval_policy = "never"` with full disk access approves a tool set
    to ask; restarted in the room, it runs under the profile.

  Writes made from the board itself need no extra prompt. Every approved
  write is logged and shows in the room's chat ("Ryan's agent (Export API)
  claimed #143"); one that fails is logged and listed on the owner's board
  besides the agent being told.
- **Claims and warnings:** a ticket claimed on a branch owns the files the
  claimant's room sessions on that branch have changed — as their pushed
  branch shows it, fetched from origin into a clone here and compared with the
  repo's base. Only a clone that this Mac's own live sessions in the room work
  in is fetched into (`git fetch --prune` every 5 minutes, and on a
  teammate's nudge at most every 30 s), never another clone of the same
  repository. A fetch that fails, or a teammate's branch that can't be read
  (not pushed yet, no base branch), is a line on the board. No paths are
  entered by hand. Mockingbird writes them to
  `.mockingbird/claims.json` in every worktree of the room's repositories
  (git-ignored, read-only; a worktree on that same branch leaves the ticket
  out; a worktree whose branch can't be read keeps its last copy, and the
  board says why). An agent's first edit of one of those files in a conversation is held
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

## Teammates' changes and migration numbers

Decided with Ryan, 2026-10-13: Ryan's and Nick's agents work in the same
repository (atticus-backoffice) on separate branches and kept producing merge
conflicts — worst on numbered migration files (two branches both adding
migration 0025) and docs, but any file can. Three things, built together
(1.4.9): migration number reservations, a heads-up when teammates change the
same file, and tools for agents to see what teammates change.

- **What a teammate is changing,** as this Mac already has it — never a
  request to their Mac (`src/main/team/teamChanges.ts`): their room sessions'
  pushed branches (fetched by the House board's teammate reads, compared with
  the base), and the newest take-over snapshot of each of their sessions that
  reached a clone here peer to peer (`refs/mockingbird/rooms/…`): its commit's
  parent against the base is committed work, the snapshot against its parent
  uncommitted work as of their last turn. Nothing new crosses the wire: the
  snapshots were already sent for take-over, and backups' rules hold (secrets,
  ignored and big files are never in them). A teammate session with neither
  (its branch not pushed, no snapshot yet, no clone of its repository here) is
  listed with why.
- **Every room repository's worktrees get the files,** House project or not
  (before this, only rooms with a House project did): beside `claims.json`
  and `agent-context.md`, `.mockingbird/overlaps.json` (each teammate session
  in the room working in this repository — member, title, ticket, branch — and
  its committed and uncommitted files, up to 2,000 each; a worktree on that
  session's own branch leaves it out: that's their work checked out here) and
  `.mockingbird/migrations.json` (the room's migration folders for this
  repository, whether the check is on, and the live reservations). Written
  read-only through `fileOps.ts`'s link-refusing helpers, git-excluded, every
  teammate-sourced string one-lined with `<` `>` swapped (`fenced`). They're
  rewritten when teammates' changes or reservations change, so the hook reads
  them with no network call.
- **The heads-up.** The agents' PreToolUse hook (the claims check's script,
  `claims-check.js`) also reads `overlaps.json`: an edit (Claude's Edit, Write,
  MultiEdit, NotebookEdit; Codex's apply_patch) of a file a teammate session
  is changing goes ahead, with `additionalContext` for the agent — "Heads-up
  from Mockingbird: Nick's session "Export API" (ticket #453, branch
  feature/453-x), in uncommitted work on their Mac, is also changing
  "src/api/x.ts". Coordinate before you both change it… send_message …
  read_teammate_diff …" — and a `systemMessage` line for the user. Per
  conversation and file it's said once, then again only after 30 minutes
  (`~/.mockingbird/overlaps-warned/`). Both sides learn it: each Mac's agents
  hear about the other's sessions. Codex 0.156's hook schema takes
  `additionalContext` on PreToolUse (checked against the installed binary's
  embedded schema), so Codex gets the same heads-up; that it reaches the
  model the way Claude's does isn't proven by a model run. When a claims
  hold-back or a migration hold-back denies the same edit, the heads-up rides
  along in the deny's reason. Each of the three checks fails on its own: an
  unreadable copy is reported (`ClaimCheckFailed`, in the log and as a
  notice) and the others still answer; the edit is never blocked by a
  failure.
- **The panes' chips** count the same changes: "Nick's work also changes x.ts"
  when some of it is uncommitted (the tooltip marks those files), "Nick's
  branch also changes …" when it's all on his branch.
- **Agents' tools** (Mockingbird MCP; the reads pre-allowed in Claude room
  launches like the House's reads and approved in Codex; Codex asks before
  each `reserve_migration_number`, below): `list_teammate_changes` — per teammate room session its id (as
  `list_sessions` gives it, for `send_message`; `accepts_messages: false` and
  `why` for a closed session, a terminal or an exited agent), owner, title,
  ticket, branch, repository, where the files were read from, and each file
  with `committed`,
  `uncommitted` and `also_changed_here` (this worktree changes it too), up to
  300 per session; `read_teammate_diff(session, file)` — that file's diff
  against the base branch, from the snapshot (committed and uncommitted) or
  else the pushed branch, between `<teammate-diff>` tags (the tag taken out of
  the content), cut at 30,000 characters by default (up to 100,000, saying
  where it was cut). Only files the session changes are read; a file named
  like a secret (`secrets.ts`, the artifacts' rules) or one of this Mac's
  known secret files, or a diff holding a private key, is withheld, saying
  so. git runs with `--no-ext-diff --no-textconv`, so a repository's
  configured diff drivers never run. Every string a teammate controls is
  one-lined (`fenced`, `named`, `quoted`), and the answers say they're
  teammate content, not instructions.
- **Migration folders** are found by themselves (`detectMigrationFolders`,
  `src/shared/team/migrations.ts`), from the base branch's files and the
  clone's: a folder whose files are mostly (60%) numbered — an optional `V`,
  digits, then `_`, `-` or `.` (`0024_add_x.sql`, `V25__x.sql`,
  `20261012_x.rb`, `001-init.sql`) — and whose path says migrations
  (`migrations`, `migrate`, `db`, `schema`, `sql`, `versions`, `flyway`…) or
  holding two or more numbered `.sql` files; never under `node_modules`,
  `vendor`, build output or the top folder. Its padding and prefix come from
  most of its files. Where detection is wrong, the room's admin names a
  repository's folders in Settings → Team (`room.settings { migrationFolders:
  { <origin key>: [...] } }`; an empty list goes back to detection).
- **Reserving:** `reserve_migration_number(folder?)` — the folder only when
  there are several (the answer lists them) or detection missed it. Origin is
  fetched first (a failure is said in the answer and logged; the numbers are
  then as last fetched); the number is one above every number in the folder
  on the base branch (`baseRef`: origin's UAT/dev/main), on each teammate
  room session's branch as fetched, in teammates' snapshots here, in every
  worktree of this clone (files on disk, uncommitted too), and in every live
  reservation for that repository and folder in any room here. It's written
  as the folder writes numbers (`0026`, `V26`). The answer names the file
  pattern and where the highest number came from. `migration.reserved
  { repo (origin key), folder, number, label, session { id, title }, ticket,
  branch }` is published, and the worktrees' copies are rewritten before the
  tool answers, so the agent's next edit sees the number as its user's.
  `list_migration_reservations` lists them; `release_migration_number(number,
  folder?)` gives one back.
- **What counts as reserved:** a reservation holds its number in its
  repository and folder for its **member** (any of their sessions), until it's
  released. Two members reserving the same number while apart (or at once):
  the first in the room's order holds it, the same on every member; the other
  is kept, marked `clash`, holds nothing, and its owner's agent is told to
  reserve again (and is held back if it uses that number). Released: by its
  member or the room's admin (`migration.released { reservation, reason }`),
  when its member leaves or is removed, and by its member's Mockingbird once a
  file with that number is on the base branch (`merged`) or its branch exists
  neither here nor on origin (`branch-gone`; a branch it can't check is kept,
  never released on a guess). Every member also treats a reservation whose
  number it sees on the base branch as released, without waiting for the
  event. Events are checked strictly: an origin key without credentials, a
  plain repository-relative folder, a whole number of at most 15 digits whose
  label matches, a session id, and a session title, ticket and branch on one
  line; a room keeps at most 400 reservations (released ones dropped first).
- **Caps:** a member holds at most 5 live reservations in one
  repository's folder and 20 in the room, and a room 100 in all. One over a
  cap is kept, marked `refused`, and holds nothing — decided in the room's
  order, the same on every member, like a clash (`capReached`,
  `src/shared/team/migrations.ts`). The reserve tool checks first and answers
  with the numbers its user holds and to release ones no longer needed,
  publishing nothing. (Rooms' snapshots from before are reduced again under
  the caps.)
- **Plausible numbers only:** a reservation counts only up to 20
  above the highest number in its folder's files as this Mac has them (the
  base branch, teammates' branches and shared work, this clone's worktrees).
  One above that — a 15-digit number would make the next one 16 digits, which
  no event may carry, and block everyone — is ignored by each member: kept
  out of the next number, `migrations.json`, the list and the board line,
  logged and shown on the board once ("Nick's reservation of 0040 in
  "db/migrations" is ignored: it's more than 20 above the highest migration
  there (5) …"). A folder this Mac hasn't read yet is taken on trust until it
  has (a new reservation reads it soon); the reserve tool always reads first.
  The tool never publishes an implausible number either: when the next free
  one would be more than 20 above the highest file, or longer than 15
  digits, it answers why instead.
- **Codex asks** before each `reserve_migration_number` (its launch sets the
  tool's `approval_mode="prompt"`, as for the House's writes; agents.ts
  `CODEX_ASKS_TOOLS`): a reservation is a room event every teammate's agents
  are held to. Unlike the House's writes, an older Codex (or one that joined
  the room while running) isn't refused: a reservation spends no one's
  credentials, and the caps and plausibility bound what an agent approving
  its own calls can do. Claude asks as its permission mode says (the tool
  isn't pre-allowed).
- **The hold-back** (on by default; the room's admin turns it off in Settings →
  Team, `room.settings { migrationCheck }`, admin-only like backups): the hook
  reads `migrations.json`; creating a file that doesn't exist yet in one of
  the folders, with a number reserved by someone else or by nobody, is held
  back once per conversation and file with the reason and what to do ("…
  would add migration 0003 to "db/migrations", which Nick's session "Export
  API" (ticket #447, branch feature/447-export) reserved … Reserve a number
  first with reserve_migration_number …"); the same edit again goes through.
  Editing an existing migration, or a file in another folder, is never held.
  The app hears each hold-back (`RoomCheck`), logs it and notifies the user.
  Off, nothing is held back and agents are told to reserve anyway.
- **On the board:** a line under the House board's heading, "Migrations: 0025
  Nick (#447), 0026 You (#453)" (a clash marked), with what couldn't be read
  or released below it. Settings → Team, per room: **Hold back unreserved
  migrations** (the admin's switch, saying who the admin is) and each
  repository's migration folders, with **Change…** for the admin.
- **Agents are told** (the room's instructions in their launch and
  `agent-context.md`): to reserve before creating a migration and which
  folders there are, and that a heads-up may come with an edit, with the
  tools to use.
- **Limits.**
  - Only room sessions are seen: a teammate's session outside a room, or work
    neither pushed nor backed up since their last turn, isn't.
  - A room session's record names its repository by its origin URL; an origin
    that's a bare path on disk isn't published, so its repository gets no
    copies (a `file://` URL works).
  - Reservations live in the room: a teammate outside the room, or someone
    adding a migration by hand, isn't held to them. The hook only sees edit
    tools: a migration written by a shell command isn't held back.
  - The number is as fresh as the fetch: two members reserving offline both
    get one, and the clash rule settles who keeps it once they reconnect.

## Not in this release

- Roles/permissions beyond "member" and the admin who lets people in, removes
  them and makes backups to origin available. No role takes over a session
  without its owner's grant; an emergency path for an owner gone for good is
  left to Room roles (README), as an explicit logged event.
- An audit log of remote actions on this Mac (security review R5): take-over
  asks, hand-overs, away grants and refused take-overs are marked
  `TODO(audit-log)` in `takeover.ts` for it.
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
  folder, read marks, mutes, the room's worktree files, conversations saved
  at take-overs, hidden refs, backups on origin —
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
- The owner's consent (`test/teamTakeover.test.ts`, `test/teamTakenOver.test.ts`):
  refused while the owner is away without an away grant (saying why and whom
  to ask, nothing launched or published), then allowed for the session named
  and stopped on the owner's Mac; away grants covering only the sessions
  named, an expired one forced through anyway counting for nothing, withdrawn;
  every grant checked against the owner's key, the session, the taker, the
  snapshot, the room and its lifetime (forged and edited ones refused); an
  ungranted take-over — the room admin's own — changing nothing on the owner's
  Mac, which says so in the chat once; an older taker's `takeover.ask` told to
  update, an older owner reported as needing one; take-overs from before
  grants accepted on the owner's first start when it had honoured them, never
  otherwise; hand-overs over the loopback carrying the signed grant.
- The snapshot a take-over starts from (`test/teamTakeover.test.ts`): a ref
  planted on origin by someone outside the room, dated in the future with a
  `.claude/settings.json` in it, ignored, logged and its copy deleted, the
  take-over starting from the signed snapshot; a planted ref alone never a
  snapshot; a peer copy kept only as the commit it names, a bundle whose ref
  says otherwise refused; origin's newer backup used once its record reached
  the taker through another member.
- Backups to origin need each member's consent (`test/teamTakeover.test.ts`):
  the admin's switch alone pushing nothing, Not now kept, Allow pushing at
  once, one member's answer not another's, the answer only on this Mac
  (owner-only), turning one's own off deleting what was pushed.
- The identity key (`test/teamIdentity.test.ts`, `test/teamService.test.ts`),
  against a fake sealer, never the Keychain: a plain key moved keeping its id,
  public key and signatures, no plain copy or temporary file left; a new one
  sealed from the start; without the Keychain the plain file kept with one
  warning (shown in Settings → Team); a read-back that doesn't match putting
  the plain file back; a sealed key that can't be opened refused, never
  replaced; `safeStorage` used only on macOS and only when it says it can.
- The conversation saved at a take-over (`test/teamTakeover.test.ts`,
  `test/worktreeWrites.test.ts`): kept past the taker's first backup and
  while turns come, deleted (and logged) after 14 days without one, when the
  continued session is forgotten or found closed, when its backup is dropped,
  when it's taken back (once the taker hears), when the taker leaves the
  room, and where an earlier version saved it without a record; a `takeover` folder
  swapped for a link refused, its target untouched and the failure reported;
  links inside it removed, never followed.
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
  tokens and House titles never in a view, log line or the room log; each
  member asked once per room and project before their token is used, with
  nothing read meanwhile and the answer kept locally; the write tools asking
  in the pane (Claude's launch pre-allowing only the reads, the MCP server
  marking the writes, Codex's per-tool `approval_mode="prompt"`, an old or
  unknown Codex's writes refused); nudges read only for board tickets and
  rate-limited per room; a chunked answer cut off past 5 MB; the fenced
  board and the House's error text kept on one line; teammates' branches
  fetched only into a clone this Mac's room sessions use, failures on the
  board; failed agent writes, an unreadable ticket page, a failed board
  read, schema drift and an unreadable worktree branch all logged and shown;
  old `plan.*` logs and snapshots still loading. `test/houseLive.test.ts` runs
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
- Teammates' changes and migration numbers (`test/teamMigrations.test.ts`,
  `test/teamChanges.test.ts`): folder detection (usual forms, docs and
  dependencies left out), the next number and labels; malformed events
  refused (a line break in a title above all), the first reservation in the
  room's order holding a number when two cross a partition, the same on every
  member, release by its member or the admin only, leaving releasing; only
  the admin's switch counting. Through the installed hook script: an
  unreserved new migration held back once (Claude's Write, Codex's
  apply_patch), a teammate's reservation named, the user's own, existing
  files, other folders and the check off let through, teammates' words on
  one line, an unreadable copy reported while the other checks answer; the
  overlap heads-up once, again after 30 minutes, the user's own sessions
  silent, riding along with a hold-back. Against a bare origin and two
  clones over the loopback: teammates' pushed and snapshot changes in each
  worktree's `overlaps.json` and the panes' chips (not in a worktree on their
  branch); the tools' output fenced, a fence-closing file escaped, secrets by
  name and private keys withheld, diffs cut with a note; numbers above the
  base, a teammate's branch and shared work, the worktrees and reservations;
  both members seeing and releasing them; release when merged or the branch
  is gone; several folders, none, and a failed fetch logged; caps (the sixth
  in a folder and the 21st in the room refused on every member, a release
  making room, the room's 100) and the tool refusing before it publishes; a
  teammate's 15-digit and 0040 reservations ignored, logged and on the board
  while the next number stays 0006, and one that would take the next past
  the window refused. Codex's launch asks before each reservation.
- Two Mockingbird instances on one Mac (separate HOME/userData, local
  signaling server, real WebRTC between them) driven end to end
  (`MB_E2E_APP=1`): create room, join by code (the admin accepting from its
  prompt, again after removing the joiner), live pane, remote typing, chat,
  board claim, a turn backed up peer to peer (nothing on origin), a hand-over
  from the owner's prompt (their agent stopped, the taker continuing, the
  room recording the signed hand-over), a take-over refused with the owner
  quit without an away grant (the dialog saying why, Take over disabled),
  then — the owner back, allowing take-overs while away (its IPC), and
  quitting — a take-over from the peer copy under that grant,
  and the owner's app stopping its copy when it starts again; a migration
  number reserved through the agents' tool socket on one instance seen,
  stepped over and held back on the other, released, and each side's
  uncommitted work (a turn's backup) a heads-up on the other's edit, listed
  and diffed by its tools. Notifications,
  the cross-machine message, the claim warning, Keep / no answer / dropping
  offline mid-request, unsent changes sent and applied, and Take it back are
  tested over the loopback.
- The same against the deployed Worker (`MB_E2E_SIGNALING_URL`, the creator's
  fingerprint from `npm run team:e2e-fingerprint` allowed on it), asserting
  each connection's path, plus a relay-only variant that forces the TURN
  fallback.
- Then a real run between Ryan's and Nick's laptops through the deployed
  Worker, including from a network that forces the TURN fallback.
