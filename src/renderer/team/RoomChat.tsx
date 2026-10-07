import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createIpcStore, loadInto } from "../ipcStore";
import { readPref, writePref } from "../prefs";
import { initialsOf, roomOfGroup } from "../Team";
import { chatSegments, type ChatSegment } from "./chatText";
import { isErr } from "../../shared/types";
import { ASSISTANT_MENTION, isRead, mentionHandle, mentionsOf, updateLine, type AgentUpdate, type ChatEntry, type ChatUnread, type RoomChatView } from "../../shared/team/chat";
import type { TeamRoomSummary, TeamStatus } from "../../shared/team/types";

/**
 * The team room in the window (docs/team-rooms.md → Team room): a side bar
 * view with each shared room's chat — members, agents' updates and the
 * @assistant — plus its activity bar badge and the group bar's chip.
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

/** The room the chat shows, remembered across restarts. */
const PICK_KEY = "mb.roomChat.room";
const picked = createIpcStore<string | null>(readPref<string | null>(PICK_KEY, null), () => {});
const pickRoom = (roomId: string) => {
  picked.set(roomId);
  writePref(PICK_KEY, roomId);
};

const ChatIcon = () => (
  <svg className="ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.25 3.75a1.5 1.5 0 0 1 1.5-1.5h8.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.25l-3 2.5v-2.5h-.5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M5.25 5.75h5.5M5.25 7.75h3.5" />
  </svg>
);

const sumUnread = (u: ChatUnread) => Object.values(u).reduce((acc, r) => ({ unread: acc.unread + r.unread, mentions: acc.mentions + r.mentions }), { unread: 0, mentions: 0 });

/** The activity bar's team room icon, with unread messages (mentions of you as @N). */
export function TeamRoomIcon() {
  const { unread, mentions } = sumUnread(useChatUnread());
  return (
    <>
      <ChatIcon />
      {unread > 0 && (
        <span className="ab-badge" title={`${unread} unread in team rooms${mentions ? ` · ${mentions} mentioning you` : ""}`}>
          {mentions ? `@${mentions > 9 ? "9+" : mentions}` : unread > 99 ? "99+" : unread}
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
      className={`chip ${u?.unread ? "teal" : ""}`}
      data-tip="The team room's chat — teammates, their agents' updates, and @assistant"
      onClick={() => {
        pickRoom(room.id);
        onOpen();
      }}
    >
      Room chat{u?.unread ? ` · ${u.mentions ? `@${u.mentions}` : u.unread}` : ""}
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
        pickRoom(roomId);
        ref.current();
      }),
    []
  );
}

/** The side bar view: the chat of the room picked, or of the shared group on screen. */
export function RoomChatPanel({ status, activeGroup }: { status: TeamStatus | { error: string } | null; activeGroup: string | null }) {
  const choice = picked.use();
  const groupRoom = activeGroup ? roomOfGroup(status, activeGroup) : undefined;
  // switching the grid to a shared group shows its room
  useEffect(() => {
    if (groupRoom) pickRoom(groupRoom.id);
  }, [groupRoom?.id]);
  if (!status) return <div className="rc-empty">Loading…</div>;
  if (isErr(status)) return <div className="rc-empty err">Couldn't read the team status: {status.error}</div>;
  const rooms = status.rooms;
  const room = rooms.find((r) => r.id === choice) ?? groupRoom ?? rooms[0];
  if (!room) {
    return (
      <div className="rc-empty">
        No team rooms yet. Share a group from its row in the Sessions view (⇪), or join a teammate's room with a code (⇲). Each room has a chat here: what teammates say, what
        their agents are up to, and an @assistant.
      </div>
    );
  }
  return <RoomChat key={room.id} room={room} rooms={rooms} selfName={status.self?.name ?? "you"} />;
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

function RoomChat({ room, rooms, selfName }: { room: TeamRoomSummary; rooms: TeamRoomSummary[]; selfName: string }) {
  const [view, setView] = useState<RoomChatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  // where "new" starts: the first unread entry when the room was opened (or new ones arrived unseen)
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const nameOf = useMemo(() => {
    const names = new Map(room.members.map((m) => [m.id, m.self ? "You" : m.name]));
    return (id: string) => names.get(id) ?? "A teammate";
  }, [room.members]);

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
  useEffect(() => {
    window.mb.teamChatViewing(room.id);
    return () => void window.mb.teamChatViewing(null);
  }, [room.id]);
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
    if (!newFrom) setNewFrom(view.entries.find((e) => !isRead(e, view.read, view.joinedAt) && e.author !== view.self)?.id ?? null);
    if (!focused) return;
    window.mb.teamChatRead(room.id).then((r: unknown) => isErr(r) && setError(`Couldn't mark the room read: ${r.error}`));
  }, [view, focused]);
  // stay at the newest entry unless scrolled up to read
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [view?.entries.length, view?.entries.at(-1)?.id]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const r = await window.mb.teamChatPost(room.id, text);
    setSending(false);
    if (isErr(r)) return setError(`Not sent: ${r.error}`);
    setError(null);
    setDraft("");
    setNewFrom(null);
    atBottom.current = true;
    load();
  };

  const others = room.members.filter((m) => !m.self);
  const online = others.filter((m) => room.online.includes(m.id));
  const entries = view?.entries ?? [];

  return (
    <div className="rc">
      <div className="rc-head">
        {rooms.length > 1 ? (
          <select className="rc-pick" value={room.id} onChange={(e) => pickRoom(e.target.value)} title="Which room's chat to show">
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="rc-name" title={room.name}>
            {room.name}
          </span>
        )}
        <div className="rc-members">
          {room.members.map((m) => {
            const on = m.self || room.online.includes(m.id);
            return (
              <span key={m.id} className={`rc-member ${on ? "on" : ""}`} title={`${m.name}${m.self ? " (you)" : on ? " · connected" : " · offline"}`}>
                <span className="rc-initials">{initialsOf(m.name)}</span>
                {m.self ? "you" : mentionHandle(m.name)}
              </span>
            );
          })}
        </div>
      </div>
      <div
        className="rc-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {view && !entries.length && <div className="rc-empty">Nothing said yet. Messages reach teammates now, or when they're next online; @{mentionHandle(others[0]?.name ?? "name")} mentions someone, @assistant asks the assistant.</div>}
        {entries.map((e, i) => (
          <React.Fragment key={e.id}>
            {e.id === newFrom && <div className="rc-new">new</div>}
            <Entry e={e} prev={entries[i - 1]} entries={entries} nameOf={nameOf} members={room.members} selfName={selfName} self={view!.self} />
          </React.Fragment>
        ))}
      </div>
      {error && <div className="err rc-err">{error}</div>}
      <Composer room={room} draft={draft} setDraft={setDraft} send={send} sending={sending} />
      <div className="rc-hint">
        <span>{others.length === 0 ? "Invite a teammate to talk here" : online.length ? `${online.map((m) => mentionHandle(m.name)).join(", ")} connected` : "Nobody else is connected — they'll get it when they're back"}</span>
        <span>⏎ send · ⇧⏎ new line</span>
      </div>
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
      <div className="rc-update">
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
  if (e.kind === "assistant") {
    const q = entries.find((x) => x.id === e.replyTo);
    const stale = e.state === "thinking" && Date.now() - e.at > THINKING_STALE_MS;
    return (
      <div className={`rc-assist ${e.state ?? ""}`}>
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
    <div className={`rc-msg ${continued ? "cont" : ""} ${mentionsOf(e, self) ? "for-me" : ""}`}>
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
  return <div className="rc-text">{segs.map(renderSegment)}</div>;
}

function renderSegment(s: ChatSegment, i: number): React.ReactNode {
  switch (s.t) {
    case "text":
      return <React.Fragment key={i}>{s.s}</React.Fragment>;
    case "code":
      return <code key={i}>{s.s}</code>;
    case "block":
      return <pre key={i}>{s.s}</pre>;
    case "bold":
      return <strong key={i}>{s.s}</strong>;
    case "em":
      return <em key={i}>{s.s}</em>;
    case "link":
      return (
        <a
          key={i}
          href={s.s}
          onClick={(ev) => {
            ev.preventDefault();
            window.mb.openExternal(s.s).then((r: unknown) => isErr(r) && alert(`Couldn't open ${s.s}: ${r.error}`));
          }}
        >
          {s.s}
        </a>
      );
    case "mention":
      return (
        <span key={i} className={`rc-mention ${s.me ? "me" : ""} ${s.assistant ? "assistant" : ""}`}>
          {s.s}
        </span>
      );
  }
}

/** The message box, with @-completion of members and the assistant. */
function Composer({ room, draft, setDraft, send, sending }: { room: TeamRoomSummary; draft: string; setDraft: (s: string) => void; send: () => void; sending: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const handles = useMemo(
    () => [
      { handle: ASSISTANT_MENTION, label: "assistant — answers here, run on your laptop" },
      ...room.members.filter((m) => !m.self).map((m) => ({ handle: mentionHandle(m.name), label: `${m.name}${room.online.includes(m.id) ? "" : " · offline"}` })),
    ],
    [room.members, room.online]
  );
  const partial = /(^|\s)@([\w.-]*)$/.exec(draft.slice(0, caret));
  const suggestions = partial ? handles.filter((h) => h.handle.toLowerCase().startsWith(partial[2].toLowerCase())) : [];
  const complete = (handle: string) => {
    if (!partial) return;
    const start = caret - partial[2].length - 1;
    const next = `${draft.slice(0, start)}@${handle} ${draft.slice(caret)}`;
    setDraft(next);
    const at = start + handle.length + 2;
    setCaret(at);
    requestAnimationFrame(() => ref.current?.setSelectionRange(at, at));
  };
  return (
    <div className="rc-bar">
      {suggestions.length > 0 && (
        <div className="rc-suggest" role="listbox">
          {suggestions.map((h, i) => (
            <div
              key={h.handle}
              role="option"
              aria-selected={i === pick % suggestions.length}
              className={`rc-sug ${i === pick % suggestions.length ? "on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(h.handle);
              }}
            >
              <b>@{h.handle}</b>
              <span>{h.label}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={2}
        value={draft}
        placeholder="Message the room — @ to mention, @assistant to ask"
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setPick(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setPick((p) => (p + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
          } else if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
            e.preventDefault();
            complete(suggestions[pick % suggestions.length].handle);
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
