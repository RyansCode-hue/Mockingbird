import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createIpcStore, loadInto } from "../ipcStore";
import { readPref, usePersisted, writePref } from "../prefs";
import { initialsOf, LeaveRoomDialog, RoleChip, RoleNotice, roomOfGroup, RoomWarnings, TeamNotices, useMemberActions } from "../Team";
import { roleIn } from "./rolesModel";
import { ActionBar, pickActions, tidyMenu, useContextMenu, type MenuEntry } from "../ContextMenu";
import { BackIcon, ChatIcon, ChevronIcon, CloseIcon, GridIcon, InviteIcon, KanbanIcon, PlusIcon } from "../Icons";
import { roomPresence } from "./connectedModel";
import { presenceTurn, useChatArrivals, useTurns } from "../motion";
import { chatSegments } from "./chatText";
import { renderSegment, type InlineContext } from "./markdownView";
import { ArtifactChip, ArtifactShelf, useArtifactActions, useArtifacts, useFileDrop } from "./Artifacts";
import { ARTIFACT_TRIGGER, artifactCompletions, artifactMeta, mentionLabel } from "./artifactModel";
import { ArtifactGlyph } from "./ArtifactViewer";
import { isErr, type SessionInfo } from "../../shared/types";
import { encodeArtifactPicks, type ArtifactSummary, type RepoResolution } from "../../shared/team/artifacts";
import { ASSISTANT_MENTION, countsAsUnread, isRead, memberLine, mentionHandle, mentionsOf, updateLine, type AgentUpdate, type ChatEntry, type ChatUnread, type RoomChatView } from "../../shared/team/chat";
import type { TeamRoomSummary, TeamStatus } from "../../shared/team/types";

/**
 * The team room in the window (docs/team-rooms.md → Team room): a side bar
 * view with the rooms, each with its sessions — teammates' and this Mac's —
 * and its chat — members, agents' updates and the @assistant — and its
 * artifacts (Artifacts.tsx), plus its activity bar badge and the group bar's
 * chip.
 */

/** Unread entries and mentions per room, kept current. */
const unreadStore = createIpcStore<ChatUnread>({}, ({ set }) => {
  const load = () => loadInto("the team chat's unread counts", window.mb.teamChatUnread(), (r: ChatUnread) => set(r && typeof r === "object" ? r : {}));
  load();
  let timer: ReturnType<typeof setTimeout> | null = null;
  window.mb.onTeamChatChanged(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      load();
    }, 80);
  });
});

export function useChatUnread(): ChatUnread {
  return unreadStore.use();
}

/** The room the view shows, remembered across restarts; LIST is the room list. */
const PICK_KEY = "mb.roomChat.room";
const LIST = "";
const picked = createIpcStore<string | null>(readPref<string | null>(PICK_KEY, null), () => {});
const pickRoom = (roomId: string) => {
  picked.set(roomId);
  writePref(PICK_KEY, roomId);
};

/** The shared group's room the grid showed when the Team view last looked (the view unmounts while hidden). */
let lastGroupRoom: string | undefined;
/** The view is being opened on a room or the list on purpose: the grid's group doesn't override it as it opens. */
let pickedOnPurpose = false;
let panelOpen = false;

/** Open the Team view on a room (its sessions and chat), or on the room list (null), whatever group the grid shows. */
export const openTeamView = (roomId: string | null) => {
  pickRoom(roomId ?? LIST);
  pickedOnPurpose = !panelOpen;
};

const sumUnread = (u: ChatUnread) => Object.values(u).reduce((acc, r) => ({ unread: acc.unread + r.unread, mentions: acc.mentions + r.mentions }), { unread: 0, mentions: 0 });

/** The activity bar's team room icon: a count of unread messages, ringed when any of them mention you. */
export function TeamRoomIcon() {
  const { unread, mentions } = sumUnread(useChatUnread());
  return (
    <>
      <ChatIcon />
      {unread > 0 && (
        <span className={`ab-badge${mentions ? " mention" : ""}`} title={`${unread} unread in team rooms${mentions ? ` · ${mentions} mentioning you` : ""}`}>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </>
  );
}

/** A shared group's chip in the group bar: opens its room's chat. */
export function RoomChatChip({ room, onOpen }: { room: TeamRoomSummary; onOpen: () => void }) {
  const u = useChatUnread()[room.id];
  return (
    <button
      className={`gb-btn ${u?.unread ? "teal" : ""}`}
      data-tip="The team room's chat — teammates, their agents' updates, and @assistant"
      onClick={() => {
        openTeamView(room.id);
        onOpen();
      }}
    >
      <ChatIcon />
      <span className="gb-t">Room chat</span>
      {u?.unread ? <span className="gb-n">{u.mentions ? `@${u.mentions}` : u.unread}</span> : null}
    </button>
  );
}

/** A clicked mention notification opens that room's chat. */
export function useRoomChatOpen(open: () => void): void {
  const ref = useRef(open);
  ref.current = open;
  useEffect(
    () =>
      window.mb.onTeamChatOpen((roomId: string) => {
        openTeamView(roomId);
        ref.current();
      }),
    []
  );
}

/** What the room's artifacts need from the window: this Mac's sessions, for repo files. */
export interface RoomArtifactProps {
  /** This Mac's sessions (not teammates'): a repo file is picked from one, and opens in one. */
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  /** Open a repo file in the editor, from a session whose folder is in a clone of its repo. */
  onOpenRepoFile: (open: NonNullable<RepoResolution["open"]>) => void;
}

/**
 * What the Team view needs from the window to show a room's sessions and act
 * on the room: the rows are the Sessions view's own (main.tsx), so they work
 * the same in both places.
 */
export interface TeamViewHooks {
  sessionCount: (groupKey: string) => number;
  renderSessions: (groupKey: string) => React.ReactNode;
  /** Show the room's sessions in the grid. */
  onShowGroup: (groupKey: string) => void;
  onOpenBoard: (roomId: string) => void;
  /** Invite a teammate: a one-time code for the room. */
  onInvite: (groupKey: string, title: string) => void;
  /** New session in the room's group: teammates see it. */
  onNewSession: (groupKey: string) => void;
  /** Join a teammate's room with the invite code they sent. */
  onJoinRoom: () => void;
}

/** A room's actions, for its header's buttons and its right-click menu. */
function roomActions(room: TeamRoomSummary, hooks: TeamViewHooks, o: { onChat?: () => void; chatLabel?: string; onLeave: () => void }): MenuEntry[] {
  return tidyMenu([
    o.onChat && { key: "chat", label: o.chatLabel ?? "Chat", menuLabel: "Open the room's chat", icon: <ChatIcon />, title: "The room's chat: teammates, their agents' updates, @assistant", onPick: o.onChat },
    !!room.groupKey && { key: "show", label: "Show", menuLabel: "Show its sessions in the grid", icon: <GridIcon />, onPick: () => hooks.onShowGroup(room.groupKey) },
    { key: "board", label: "Board", menuLabel: "House board", icon: <KanbanIcon />, title: "House board — the room's Radley House tickets and who has each", onPick: () => hooks.onOpenBoard(room.id) },
    !!room.groupKey && { key: "invite", label: "Invite", menuLabel: "Invite a teammate…", icon: <InviteIcon />, title: "A one-time invite code for a teammate", onPick: () => hooks.onInvite(room.groupKey, room.name) },
    !!room.groupKey && { key: "new", label: "New", menuLabel: "New session in this room…", icon: <PlusIcon />, title: `New connected session in ${room.name} — teammates see it`, onPick: () => hooks.onNewSession(room.groupKey) },
    "-",
    { key: "join", label: "Join", menuLabel: "Join another room…", icon: <PlusIcon />, title: "Join a teammate's room with the invite code they sent you", onPick: hooks.onJoinRoom },
    { key: "leave", label: "Leave", menuLabel: "Leave room…", icon: <CloseIcon />, danger: true, onPick: o.onLeave },
  ]);
}

/** A room's name, its presence in words, and its labelled actions; right-click for all of them. */
function RoomHead({ room, hooks, onChat, onLeave }: { room: TeamRoomSummary; hooks: TeamViewHooks; onChat?: () => void; onLeave: () => void }) {
  const u = useChatUnread()[room.id];
  const menu = useContextMenu(room.name);
  const acts = roomActions(room, hooks, { onChat, chatLabel: u?.unread ? `Chat · ${u.mentions ? `@${u.mentions}` : u.unread}` : "Chat", onLeave });
  return (
    <div className="room-head" {...menu.bind(acts)}>
      {onChat ? (
        <button className="room-name" title={`Open ${room.name}: its sessions and chat`} onClick={onChat}>
          {room.name}
        </button>
      ) : (
        <span className="room-name" title={room.name}>
          {room.name}
        </span>
      )}
      <div className={`room-presence ${room.problem || room.signaling !== "online" ? "warn" : room.online.length ? "" : "idle"}`} title={room.problem}>
        {roomPresence(room)}
        {room.problem ? ` · ${room.problem}` : ""}
      </div>
      <RoomWarnings room={room} />
      <ActionBar className="room-acts" actions={pickActions(acts, [onChat ? "chat" : "show", "board", "invite", "new"])} more={acts} label={room.name} />
      {menu.menu}
    </div>
  );
}

/** A room's sessions (teammates' and this Mac's), under a header that folds them away. */
function RoomSessions({ room, hooks, foldable }: { room: TeamRoomSummary; hooks: TeamViewHooks; foldable: boolean }) {
  const [open, setOpen] = usePersisted("mb.roomSessions.open", true);
  const n = hooks.sessionCount(room.groupKey);
  const shown = !foldable || open;
  return (
    <div className="room-sessions">
      {foldable && (
        <button className="art-toggle room-sess-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide the room's sessions" : "Show the room's sessions"}>
          <ChevronIcon open={open} />
          Sessions · {n}
        </button>
      )}
      {shown && (
        <div className="room-sess-body">
          {n ? hooks.renderSessions(room.groupKey) : <div className="art-empty">No sessions in this room yet. New starts one teammates see.</div>}
        </div>
      )}
    </div>
  );
}

/** Every room, each with its sessions and a way into its chat. */
function RoomList({ rooms, hooks }: { rooms: TeamRoomSummary[]; hooks: TeamViewHooks }) {
  const [leaving, setLeaving] = useState<TeamRoomSummary | null>(null);
  return (
    <div className="scroll room-list">
      <div className="room-list-head">
        <span>{rooms.length} rooms</span>
        <button className="rc-new-session" title="Join a teammate's room with the invite code they sent you" onClick={hooks.onJoinRoom}>
          Join a room…
        </button>
      </div>
      {rooms.map((r) => (
        <div key={r.id} className="room-card">
          <RoomHead room={r} hooks={hooks} onChat={() => pickRoom(r.id)} onLeave={() => setLeaving(r)} />
          <RoomSessions room={r} hooks={hooks} foldable={false} />
        </div>
      ))}
      {leaving && <LeaveRoomDialog room={leaving} onClose={() => setLeaving(null)} />}
    </div>
  );
}

/**
 * The side bar view: the room list, or one room — its sessions, artifacts and
 * chat. The room picked, or of the shared group on screen; with one room,
 * always that one.
 */
export function RoomChatPanel({
  status,
  activeGroup,
  visible,
  hooks,
  ...artifactProps
}: {
  status: TeamStatus | { error: string } | null;
  activeGroup: string | null;
  visible: boolean;
  hooks: TeamViewHooks;
} & RoomArtifactProps) {
  const choice = picked.use();
  const groupRoom = activeGroup ? roomOfGroup(status, activeGroup) : undefined;
  // switching the grid to a shared group shows its room — a switch, not every time the view opens, so the room list stays
  useEffect(() => {
    const purpose = pickedOnPurpose;
    pickedOnPurpose = false;
    if (groupRoom?.id === lastGroupRoom) return;
    lastGroupRoom = groupRoom?.id;
    if (groupRoom && !purpose) pickRoom(groupRoom.id);
  }, [groupRoom?.id]);
  useEffect(() => {
    panelOpen = true;
    return () => void (panelOpen = false);
  }, []);
  if (!status) return <div className="rc-empty">Loading…</div>;
  if (isErr(status)) return <div className="rc-empty err">Couldn't read the team status: {status.error}</div>;
  const rooms = status.rooms;
  const room = choice === LIST && rooms.length > 1 ? undefined : rooms.find((r) => r.id === choice) ?? groupRoom ?? rooms[0];
  const notices = status.notices?.length ? (
    <div className="rc-notices">
      <TeamNotices notices={status.notices} />
    </div>
  ) : null;
  if (!rooms.length) {
    return (
      <>
        {notices}
        <div className="rc-empty">
          No team rooms yet. Share a group from its header in the Sessions view (⇪), or join a teammate's room with the invite code they sent you. Each room shows here with
          its sessions — yours and teammates' — and its chat: what teammates say, what their agents are up to, and an @assistant.
          <div>
            <button className="outline rc-join" onClick={hooks.onJoinRoom}>
              Join a room…
            </button>
          </div>
        </div>
      </>
    );
  }
  if (!room) {
    return (
      <>
        {notices}
        <RoomList rooms={rooms} hooks={hooks} />
      </>
    );
  }
  return (
    <>
      {notices}
      <RoomChat key={room.id} room={room} rooms={rooms} selfName={status.self?.name ?? "you"} visible={visible} hooks={hooks} {...artifactProps} />
    </>
  );
}

const when = (ms: number) => {
  const d = new Date(ms);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** A turn still "thinking" after this long has lost its asker's Mockingbird. */
const THINKING_STALE_MS = 5 * 60_000;
const DOT_OF: Record<AgentUpdate["kind"], string> = { started: "working", finished: "idle", waiting: "waiting", ended: "dead", takeover: "rc-dot", board: "rc-dot" };

/** References to the room's artifacts in chat text: chips with each one's current name. */
const ArtifactRefs = React.createContext<InlineContext>({});

function RoomChat({
  room,
  rooms,
  selfName,
  visible,
  hooks,
  sessions,
  focusedSessionId,
  onOpenRepoFile,
}: {
  room: TeamRoomSummary;
  rooms: TeamRoomSummary[];
  selfName: string;
  visible: boolean;
  hooks: TeamViewHooks;
} & RoomArtifactProps) {
  const [view, setView] = useState<RoomChatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  // where "new" starts: the first unread entry when the room was opened (or new ones arrived unseen)
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // a teammate connecting or leaving turns their initials; a teammate's new message slides in
  const membersRef = useRef<HTMLDivElement>(null);
  useTurns(membersRef, ".rc-member", "data-member", (el) => el.classList.contains("on"), (el, on) => presenceTurn(el, el.querySelector(".rc-initials"), on));
  useChatArrivals(listRef, view?.entries ?? null, view?.self ?? "");
  const [leaving, setLeaving] = useState(false);
  const memberActs = useMemberActions(room);
  const memberMenu = useContextMenu("Teammate");
  const arts = useArtifacts(room.id);
  const actions = useArtifactActions(room.id);
  const artifacts = arts.view?.items ?? [];
  const [viewing, setViewing] = useState<string | null>(null);
  // the composer's #[name] picks, sent as #[name](artifact:id)
  const picks = useRef(new Map<string, string>());
  const input = useRef<HTMLTextAreaElement>(null);
  const drop = useFileDrop((files) => void actions.addFiles(files));
  const refs = useMemo<InlineContext>(
    () => ({
      // until the room's artifacts are read, a reference is only its label: not "(removed)", which it may not be
      artifact: (id, label, key) =>
        arts.view ? (
          <ArtifactChip key={key} item={artifacts.find((a) => a.id === id)} label={label} onOpen={setViewing} />
        ) : (
          <span key={key} className="rc-artifact gone unread" title={arts.error ?? "Reading the room's artifacts…"}>
            {label}
          </span>
        ),
    }),
    [arts.view, arts.error]
  );
  /** Put #[name] into the message box at the caret, remembering which artifact it means. */
  const mention = (a: Pick<ArtifactSummary, "id" | "name">) => {
    const label = mentionLabel(a.name);
    picks.current.set(label, a.id);
    const el = input.current;
    const at = el ? el.selectionStart ?? draft.length : draft.length;
    const before = draft.slice(0, at);
    const insert = `${before && !/\s$/.test(before) ? " " : ""}#[${label}] `;
    setDraft(before + insert + draft.slice(at));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + insert.length, at + insert.length);
    });
  };
  const nameOf = useMemo(() => {
    // people who left still wrote what they wrote
    const names = new Map([...(room.former ?? []).map((m): [string, string] => [m.id, m.name]), ...room.members.map((m): [string, string] => [m.id, m.self ? "You" : m.name])]);
    return (id: string) => names.get(id) ?? "A teammate";
  }, [room.members, room.former]);

  const load = useCallback(() => {
    window.mb.teamChatView(room.id).then((r: RoomChatView | { error: string }) => {
      if (isErr(r)) return setError(`Couldn't read the chat: ${r.error}`);
      setView(r);
      setError((e) => (e?.startsWith("Couldn't read the chat") ? null : e));
    });
  }, [room.id]);
  useEffect(() => {
    load();
    return window.mb.onTeamChatChanged((id: string) => (id === room.id || id === "*") && load());
  }, [load]);
  // a collapsed side bar keeps the view mounted but off screen: not viewing, and nothing gets read
  useEffect(() => {
    window.mb.teamChatViewing(visible ? room.id : null);
    return () => void window.mb.teamChatViewing(null);
  }, [room.id, visible]);
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  // what's on screen in a focused window is read
  useEffect(() => {
    if (!view || !view.unread) return;
    if (!newFrom) setNewFrom(view.entries.find((e) => !isRead(e, view.read, view.joinedAt) && countsAsUnread(e, view.self))?.id ?? null);
    if (!focused || !visible) return;
    window.mb.teamChatRead(room.id).then((r: unknown) => isErr(r) && setError(`Couldn't mark the room read: ${r.error}`));
  }, [view, focused, visible]);
  // stay at the newest entry unless scrolled up to read
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [view?.entries.length, view?.entries.at(-1)?.id]);

  const send = async () => {
    const text = encodeArtifactPicks(draft.trim(), picks.current, artifacts);
    if (!text || sending) return;
    setSending(true);
    const r = await window.mb.teamChatPost(room.id, text);
    setSending(false);
    if (isErr(r)) return setError(`Not sent: ${r.error}`);
    setError(null);
    setDraft("");
    picks.current.clear();
    setNewFrom(null);
    atBottom.current = true;
    load();
  };

  const others = room.members.filter((m) => !m.self);
  const online = others.filter((m) => room.online.includes(m.id));
  const entries = view?.entries ?? [];

  return (
    <div className="rc" {...drop.handlers}>
      <div className="rc-head">
        {rooms.length > 1 && (
          <button className="rc-back" title="Every room, each with its sessions" onClick={() => pickRoom(LIST)}>
            <BackIcon />
            All rooms · {rooms.length}
          </button>
        )}
        <RoomHead room={room} hooks={hooks} onLeave={() => setLeaving(true)} />
        <div className="rc-members" ref={membersRef}>
          {room.members.map((m) => {
            const on = m.self || room.online.includes(m.id);
            const acts = m.self ? [] : memberActs.actionsFor(m);
            const role = roleIn(room, m.id);
            return (
              <span
                key={m.id}
                data-member={m.id}
                className={`rc-member ${on ? "on" : ""}`}
                title={`${m.name}${m.self ? " (you)" : on ? " · connected" : " · offline"}${role !== "member" ? ` · ${role}` : ""}${acts.length ? " — right-click for their role" : ""}`}
                {...(acts.length ? memberMenu.bind(acts) : {})}
              >
                <span className="rc-initials">{initialsOf(m.name)}</span>
                {m.self ? "you" : mentionHandle(m.name)}
                <RoleChip room={room} id={m.id} className="rc-role" />
              </span>
            );
          })}
        </div>
        <RoleNotice room={room} />
        {memberActs.error && <div className="rc-error err">{memberActs.error}</div>}
      </div>
      {memberMenu.menu}
      {memberActs.dialogs}
      <RoomSessions room={room} hooks={hooks} foldable />
      <ArtifactShelf
        room={room}
        self={arts.view?.self ?? view?.self ?? ""}
        arts={arts}
        actions={actions}
        viewing={viewing}
        setViewing={setViewing}
        onMention={mention}
        ctx={refs}
        sessions={sessions}
        focusedSessionId={focusedSessionId}
        onOpenRepoFile={onOpenRepoFile}
      />
      <div
        className="rc-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {view && !entries.length && <div className="rc-empty">Nothing said yet. Messages reach teammates now, or when they're next online; @{mentionHandle(others[0]?.name ?? "name")} mentions someone, @assistant asks the assistant.</div>}
        <ArtifactRefs.Provider value={refs}>
          {entries.map((e, i) => (
            <React.Fragment key={e.id}>
              {e.id === newFrom && <div className="rc-new">new</div>}
              <Entry e={e} prev={entries[i - 1]} entries={entries} nameOf={nameOf} members={room.members} selfName={selfName} self={view!.self} />
            </React.Fragment>
          ))}
        </ArtifactRefs.Provider>
      </div>
      {error && <div className="err rc-err">{error}</div>}
      <Composer
        room={room}
        draft={draft}
        setDraft={setDraft}
        send={send}
        sending={sending}
        inputRef={input}
        self={arts.view?.self ?? view?.self ?? ""}
        artifacts={artifacts}
        rememberPick={(label, id) => picks.current.set(label, id)}
        onPasteFiles={actions.addFiles}
      />
      <div className="rc-hint">
        <span>{others.length === 0 ? "Invite a teammate to talk here" : online.length ? `${online.map((m) => mentionHandle(m.name)).join(", ")} connected` : "Nobody else is connected — they'll get it when they're back"}</span>
        <span>⏎ send · ⇧⏎ new line</span>
      </div>
      {leaving && <LeaveRoomDialog room={room} onClose={() => setLeaving(false)} />}
      {drop.over && (
        <div className="art-drop">
          <div>
            <b>Drop to share with the room</b>
            <span>Every member gets a copy · 25 MB a file at most</span>
          </div>
        </div>
      )}
      {actions.dialog}
    </div>
  );
}

function Entry({
  e,
  prev,
  entries,
  nameOf,
  members,
  selfName,
  self,
}: {
  e: ChatEntry;
  prev?: ChatEntry;
  entries: ChatEntry[];
  nameOf: (id: string) => string;
  members: { name: string }[];
  selfName: string;
  self: string;
}) {
  if (e.kind === "update") {
    return (
      <div className="rc-update" data-entry={e.id}>
        <div className="rc-update-head">
          <span>agents · {e.author === self ? "your laptop" : `${nameOf(e.author)}'s laptop`}</span>
          <span className="rc-when">{when(e.at)}</span>
        </div>
        {(e.items ?? []).map((u, i) => (
          <div key={i} className={`rc-upd k-${u.kind}`} title={updateLine(u)}>
            <span className={`dot sm ${DOT_OF[u.kind]}`} />
            <span className="rc-upd-text">{updateLine(u)}</span>
          </div>
        ))}
      </div>
    );
  }
  if (e.kind === "member") {
    return (
      <div className="rc-member-note" data-entry={e.id}>
        <span>{memberLine(e, nameOf)}</span>
        <span className="rc-when">{when(e.at)}</span>
      </div>
    );
  }
  if (e.kind === "assistant") {
    const q = entries.find((x) => x.id === e.replyTo);
    const stale = e.state === "thinking" && Date.now() - e.at > THINKING_STALE_MS;
    return (
      <div className={`rc-assist ${e.state ?? ""}`} data-entry={e.id}>
        <div className="rc-msg-head">
          <span className="rc-who">assistant</span>
          <span className="rc-via">via {e.author === self ? "you" : nameOf(e.author)}</span>
          <span className="rc-when">{when(e.at)}</span>
        </div>
        {q && (
          <div className="rc-quote" title={q.text}>
            ↳ {nameOf(q.author)}: {q.text}
          </div>
        )}
        {e.state === "thinking" ? (
          <div className="rc-thinking">{stale ? `No answer — ${e.author === self ? "your" : `${nameOf(e.author)}'s`} Mockingbird may have closed before it finished.` : "thinking…"}</div>
        ) : e.state === "error" ? (
          <div className="rc-text rc-error">Couldn't answer: {e.text}</div>
        ) : (
          <ChatText text={e.text} members={members} selfName={selfName} />
        )}
      </div>
    );
  }
  const continued = prev?.kind === "message" && prev.author === e.author && e.at - prev.at < 5 * 60_000;
  return (
    <div className={`rc-msg ${continued ? "cont" : ""} ${mentionsOf(e, self) ? "for-me" : ""}`} data-entry={e.id}>
      {!continued && (
        <div className="rc-msg-head">
          <span className="rc-who">{nameOf(e.author)}</span>
          <span className="rc-when">{when(e.at)}</span>
        </div>
      )}
      <ChatText text={e.text} members={members} selfName={selfName} />
    </div>
  );
}

function ChatText({ text, members, selfName }: { text: string; members: { name: string }[]; selfName: string }) {
  const segs = useMemo(() => chatSegments(text, members, selfName), [text, members, selfName]);
  const refs = React.useContext(ArtifactRefs);
  return <div className="rc-text">{segs.map((s, i) => renderSegment(s, i, refs))}</div>;
}

/** A pasted screenshot's name: the clipboard calls every image "image.png". */
const pastedName = (f: File, n: number) => {
  if (f.name && f.name !== "image.png") return f.name;
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  const ext = f.type === "image/jpeg" ? "jpg" : f.type.replace(/^image\//, "").replace(/\W.*$/, "") || "png";
  return `Screenshot ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}${n ? ` (${n + 1})` : ""}.${ext}`;
};

interface Suggestion {
  key: string;
  head: React.ReactNode;
  label: string;
  /** The text the partial word becomes. */
  insert: string;
  onPick?: () => void;
}

/**
 * The message box, with @-completion of members and the assistant, and
 * #-completion of the room's artifacts (shown only when one matches, so a
 * ticket number like #5110 still sends on Enter). A pasted image is added
 * to the room's artifacts and named in the message.
 */
function Composer({
  room,
  draft,
  setDraft,
  send,
  sending,
  inputRef,
  self,
  artifacts,
  rememberPick,
  onPasteFiles,
}: {
  room: TeamRoomSummary;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  send: () => void;
  sending: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  self: string;
  artifacts: ArtifactSummary[];
  /** A #[label] in the draft means this artifact. */
  rememberPick: (label: string, id: string) => void;
  onPasteFiles: (files: File[]) => Promise<{ id: string; name: string }[]>;
}) {
  const ref = inputRef;
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  // the text before the caret when Esc closed the list: it stays closed until that changes
  const [dismissed, setDismissed] = useState<string | null>(null);
  const handles = useMemo(
    () => [
      { handle: ASSISTANT_MENTION, label: "assistant — answers here, run on your laptop" },
      ...room.members.filter((m) => !m.self).map((m) => ({ handle: mentionHandle(m.name), label: `${m.name}${room.online.includes(m.id) ? "" : " · offline"}` })),
    ],
    [room.members, room.online]
  );
  const head = draft.slice(0, caret);
  const at = /(^|\s)@([\w.-]*)$/.exec(head);
  const hash = at ? null : ARTIFACT_TRIGGER.exec(head);
  const partial = at ?? hash;
  const suggestions: Suggestion[] = at
    ? handles
        .filter((h) => h.handle.toLowerCase().startsWith(at[2].toLowerCase()))
        .map((h) => ({ key: h.handle, head: <b>@{h.handle}</b>, label: h.label, insert: `@${h.handle} ` }))
    : hash
      ? artifactCompletions(hash[2], artifacts).map((a) => {
          const label = mentionLabel(a.name);
          return {
            key: a.id,
            head: (
              <>
                <ArtifactGlyph a={a} />
                <b>{a.name}</b>
              </>
            ),
            label: artifactMeta(a, self),
            insert: `#[${label}] `,
            onPick: () => rememberPick(label, a.id),
          };
        })
      : [];
  const shown = suggestions.length > 0 && dismissed !== head;
  const complete = (s: Suggestion) => {
    if (!partial) return;
    const start = caret - partial[2].length - 1;
    s.onPick?.();
    setDraft(`${draft.slice(0, start)}${s.insert}${draft.slice(caret)}`);
    const to = start + s.insert.length;
    setCaret(to);
    requestAnimationFrame(() => ref.current?.setSelectionRange(to, to));
  };
  const paste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    const where = e.currentTarget.selectionStart ?? draft.length;
    const added = await onPasteFiles(images.map((f, n) => new File([f], pastedName(f, n), { type: f.type })));
    if (!added.length) return;
    const refs = added.map((a) => {
      const label = mentionLabel(a.name);
      rememberPick(label, a.id);
      return `#[${label}]`;
    });
    setDraft((d) => {
      const before = d.slice(0, Math.min(where, d.length));
      return `${before}${before && !/\s$/.test(before) ? " " : ""}${refs.join(" ")} ${d.slice(Math.min(where, d.length))}`;
    });
    ref.current?.focus();
  };
  return (
    <div className="rc-bar">
      {shown && (
        <div className="rc-suggest" role="listbox">
          {suggestions.map((s, i) => (
            <div
              key={s.key}
              role="option"
              aria-selected={i === pick % suggestions.length}
              className={`rc-sug ${hash ? "art" : ""} ${i === pick % suggestions.length ? "on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(s);
              }}
            >
              {s.head}
              <span className="rc-sug-meta">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={2}
        value={draft}
        placeholder="Message the room — @ to mention, # for an artifact"
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setPick(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onPaste={paste}
        onKeyDown={(e) => {
          if (shown && e.key === "Escape") {
            e.preventDefault();
            setDismissed(head);
          } else if (shown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setPick((p) => (p + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
          } else if (shown && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
            e.preventDefault();
            complete(suggestions[pick % suggestions.length]);
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        readOnly={sending}
      />
    </div>
  );
}
