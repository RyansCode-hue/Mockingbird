import { useEffect, useState } from "react";
import { isErr, type SessionInfo } from "../../shared/types";
import type { RoomSessionTag, TypingAsk, TypingGrant } from "../../shared/team/livePanes";
import { initialsOf } from "../Team";
import { firstName } from "./connectedModel";
import { settled } from "../settled";

/**
 * Typing into a teammate's session (docs/team-rooms.md, "Typing"): a
 * teammate's copy is view-only until the session's owner lets them type.
 * The owner's pane asks them, shows who can type and takes it back; the
 * teammate's says where they stand and offers "Ask to type".
 */

/** A refusal stays on the teammate's pane this long after their last key. */
const REFUSED_SHOWN_MS = 8000;

/** The time, moving every `ms`, so "12 min" stays true. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const minutesLeft = (until: number, now: number) => `${Math.max(1, Math.ceil((until - now) / 60_000))} min`;

async function decide(sessionId: string, member: string, choice: "session" | "minutes" | "deny" | "revoke"): Promise<string | null> {
  const r = await settled(window.mb.teamDecideTyping(sessionId, member, choice), "Couldn't answer");
  return isErr(r) ? r.error : null;
}

/**
 * The owner's prompt on its pane: a strip docked under the pane header,
 * "Nick wants to type in “Export API”", with Allow for this session / Allow
 * for 15 min / Deny. It lies over the terminal's top rows rather than taking
 * room from it: the pty is never resized for it. Only a click answers it:
 * it never takes focus or a key, so typing in the pane can't answer it.
 */
export function TypingAsks({ session, room }: { session: SessionInfo; room: RoomSessionTag }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  if (room.remote || !room.typingAsks?.length) return null;
  const title = session.ticketTitle ?? session.title;
  const answer = async (a: TypingAsk, choice: "session" | "minutes" | "deny") => {
    setBusy(a.member);
    setError((await decide(session.id, a.member, choice)) ?? "");
    setBusy("");
  };
  return (
    <div className="typing-strip">
      {room.typingAsks.map((a) => (
        <div
          key={a.member}
          className="typing-ask"
          role="alert"
          title={`${a.name} would type into this session on your Mac, as you. A \`!\` command typed at its prompt runs in your shell, outside the room's sandbox, as anything typed into a terminal does. Even then, only you can answer your agent's permission prompts: their keys wait while it asks.`}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className="team-initials">{initialsOf(a.name)}</span>
          <span className="reason">
            {firstName(a.name)} wants to type in “{title}”
          </span>
          <button className="outline" disabled={busy === a.member} onClick={() => answer(a, "session")}>
            Allow for this session
          </button>
          <button className="outline" disabled={busy === a.member} onClick={() => answer(a, "minutes")}>
            Allow for 15 min
          </button>
          <button className="outline" disabled={busy === a.member} onClick={() => answer(a, "deny")}>
            Deny
          </button>
        </div>
      ))}
      {error && <div className="typing-ask err">{error}</div>}
    </div>
  );
}

/** Whether teammates can type into this session of this Mac's now: its pane is outlined in teal. */
export const typingOn = (room: RoomSessionTag | null | undefined): boolean => !!room && !room.remote && !!room.typists?.length;

/** The owner's pane header: "Nick can type", for as long as they can, with ✕ to take it back. */
export function Typists({ session, room }: { session: SessionInfo; room: RoomSessionTag }) {
  const now = Math.max(useNow(30_000), Date.now()); // an allowance given since the last tick counts from now
  if (room.remote || !room.typists?.length) return null;
  const asking = session.status === "waiting";
  return (
    <>
      {room.typists.map((g: TypingGrant) => (
        <span
          key={g.member}
          className="chip typist"
          title={`${g.name} can type into this session ${g.until ? `for ${minutesLeft(g.until, now)} more` : "until you close it"}${asking ? ". Not while your agent asks for permission: that answer is yours" : ""}. ✕ stops it now.`}
        >
          {firstName(g.name)} can type{g.until ? ` · ${minutesLeft(g.until, now)}` : ""}
          <button
            className="typist-x"
            aria-label={`Stop ${g.name} typing`}
            onClick={(e) => {
              e.stopPropagation();
              void decide(session.id, g.member, "revoke");
            }}
          >
            ✕
          </button>
        </span>
      ))}
    </>
  );
}

async function ask(paneId: string): Promise<void> {
  const r = await settled(window.mb.teamAskToType(paneId), "Couldn't ask");
  if (isErr(r)) console.error(`[mockingbird] asking to type into ${paneId} failed:`, r.error);
}

/** A teammate's pane header: view-only with "Ask to type", asked, or "You can type". */
export function TypingChip({ session, room }: { session: SessionInfo; room: RoomSessionTag }) {
  const now = Math.max(useNow(30_000), Date.now()); // an allowance given since the last tick counts from now
  const t = room.typing;
  if (!room.remote || !room.online || !room.live || !t || t.state === "legacy") return null;
  const owner = firstName(room.ownerName);
  if (t.state === "allowed") {
    const paused = session.status === "waiting";
    return (
      <span className={`chip ${paused ? "" : "teal"}`} title={paused ? `${room.ownerName}'s agent is asking for permission: only ${owner} can answer it, so your keys wait` : `${room.ownerName} lets you type into this session${t.until ? ` for ${minutesLeft(t.until, now)} more` : " while it runs"}`}>
        {paused ? "Typing paused" : `You can type${t.until ? ` · ${minutesLeft(t.until, now)}` : ""}`}
      </span>
    );
  }
  if (t.state === "asked") return <span className="chip" title={`Waiting for ${room.ownerName} to answer`}>Asked {owner}…</span>;
  return (
    <button
      className="chip view-only"
      title={`View only: ${room.ownerName} hasn't let you type into this session. Ask, and ${owner} chooses.`}
      onClick={(e) => {
        e.stopPropagation();
        void ask(session.id);
      }}
    >
      View only · Ask to type
    </button>
  );
}

/** On a teammate's pane, just after keys didn't go: why, and "Ask to type" when asking could help. */
export function TypingRefused({ session, room }: { session: SessionInfo; room: RoomSessionTag }) {
  const now = useNow(1000);
  const t = room.typing;
  if (!room.remote || !t?.refused || now - t.refused.at > REFUSED_SHOWN_MS) return null;
  const canAsk = t.state === "view-only" || t.state === "denied";
  return (
    <div className="team-pane-note typing-refused" role="status">
      <span className="reason">{t.refused.why}</span>
      {canAsk && (
        <button
          className="outline"
          onClick={(e) => {
            e.stopPropagation();
            void ask(session.id);
          }}
        >
          Ask to type
        </button>
      )}
    </div>
  );
}
