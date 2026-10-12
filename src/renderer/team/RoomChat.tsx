import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createIpcStore, loadInto } from "../ipcStore";
import { readPref, writePref } from "../prefs";
import { initialsOf, LeaveRoomDialog, roomOfGroup, TeamNotices } from "../Team";
import { MenuButton } from "../Menu";
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
 * view with each shared room's chat — members, agents' updates and the
 * @assistant — and its artifacts (Artifacts.tsx), plus its activity bar
 * badge and the group bar's chip.
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

/** What the room's artifacts need from the window: this Mac's sessions, for repo files. */
export interface RoomArtifactProps {
  /** This Mac's sessions (not teammates'): a repo file is picked from one, and opens in one. */
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  /** Open a repo file in the editor, from a session whose folder is in a clone of its repo. */
  onOpenRepoFile: (open: NonNullable<RepoResolution["open"]>) => void;
}

/**
 * The side bar view: the chat of the room picked, or of the shared group on
 * screen. `onNewSession` opens New session in a room's group; `onJoinRoom`
 * opens Join a room, for a teammate's invite code.
 */
export function RoomChatPanel({
  status,
  activeGroup,
  visible,
  onNewSession,
  onJoinRoom,
  ...artifactProps
}: {
  status: TeamStatus | { error: string } | null;
  activeGroup: string | null;
  visible: boolean;
  onNewSession: (groupKey: string) => void;
  onJoinRoom: () => void;
} & RoomArtifactProps) {
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
  const notices = status.notices?.length ? (
    <div className="rc-notices">
      <TeamNotices notices={status.notices} />
    </div>
  ) : null;
  if (!room) {
    return (
      <>
        {notices}
        <div className="rc-empty">
          No team rooms yet. Share a group from its row in the Sessions view (⇪), or join a teammate's room with the invite code they sent you. Each room has a chat here: what
          teammates say, what their agents are up to, and an @assistant.
          <div>
            <button className="outline rc-join" onClick={onJoinRoom}>
              Join a room…
            </button>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {notices}
      <RoomChat key={room.id} room={room} rooms={rooms} selfName={status.self?.name ?? "you"} visible={visible} onNewSession={onNewSession} onJoinRoom={onJoinRoom} {...artifactProps} />
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
  onNewSession,
  onJoinRoom,
  sessions,
  focusedSessionId,
  onOpenRepoFile,
}: {
  room: TeamRoomSummary;
  rooms: TeamRoomSummary[];
  selfName: string;
  visible: boolean;
  onNewSession: (groupKey: string) => void;
  onJoinRoom: () => void;
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
  const [leaving, setLeaving] = useState(false);
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
        <div className="rc-top">
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
          <button className="rc-new-session" title="Join a teammate's room with the invite code they sent you" onClick={onJoinRoom}>
            Join a room…
          </button>
          <MenuButton
            className="rc-new-session rc-more"
            label="⋯"
            title="More for this room"
            items={[{ key: "leave", label: "Leave room…", onPick: () => setLeaving(true) }]}
          />
        </div>
        <div className="rc-sub">
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
          {room.groupKey && (
            <button className="rc-new-session" title={`New connected session in ${room.name} — teammates see it`} onClick={() => onNewSession(room.groupKey)}>
              + New session
            </button>
          )}
        </div>
      </div>
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
  if (e.kind === "member") {
    return (
      <div className="rc-member-note">
        <span>{memberLine(e, nameOf)}</span>
        <span className="rc-when">{when(e.at)}</span>
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
              <span>{s.label}</span>
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
