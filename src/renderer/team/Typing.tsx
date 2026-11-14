import { useEffect, useRef, useState, type MouseEvent } from "react";
import { isErr, type SessionInfo } from "../../shared/types";
import { TERMINAL_TYPING, type RoomSessionTag, type TypingAsk, type TypingGrant } from "../../shared/team/livePanes";
import { initialsOf } from "../Team";
import { firstName } from "./connectedModel";
import { settled } from "../settled";
import { ANSWER_GUARD_MS, cameraWait, keyClick, useHeldOff, useSettledRows } from "../answerGuard";

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

/** Answer a teammate's ask to type, or take typing back, through the main process's checks; its error, or null. */
export async function decideTyping(sessionId: string, member: string, choice: "session" | "minutes" | "deny" | "revoke"): Promise<string | null> {
  const r = await settled(window.mb.teamDecideTyping(sessionId, member, choice), "Couldn't answer");
  return isErr(r) ? r.error : null;
}

/**
 * The owner's prompt on its pane: a strip docked under the pane header,
 * "Nick wants to type in “Export API”", with Allow for this session / Allow
 * for 15 min / Deny. It lies over the terminal's top rows rather than taking
 * room from it: the pty is never resized for it. Only a click aimed at it
 * allows, with the Needs you tray's guards (answerGuard.ts): Allow's buttons
 * are no Tab stops and a key's click does nothing, so typing in the pane can't
 * allow anyone; an ask that just arrived or moved under the pointer, or that
 * the camera just carried there, takes no click, nor does a double click's
 * second once one answer is given. Deny, the safe answer, also takes the
 * keyboard.
 */
export function TypingAsks({ session, room }: { session: SessionInfo; room: RoomSessionTag }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const strip = useRef<HTMLDivElement>(null);
  const askWait = useSettledRows(strip, ".typing-ask[data-ask]", (el) => el.dataset.ask);
  const { holdOff, heldOff } = useHeldOff();
  const guardUntil = useRef(0);
  if (room.remote || !room.typingAsks?.length) return null;
  const title = session.ticketTitle ?? session.title;
  // a new ask from the same teammate is a new state, as the tray's rows are
  const askId = (a: TypingAsk) => `${a.member}:${a.at}`;
  const answer = async (e: MouseEvent, a: TypingAsk, choice: "session" | "minutes" | "deny") => {
    if (keyClick(e)) {
      if (choice !== "deny") return;
    } else {
      // a click not aimed at it is let go, and its button shows off until one there would count
      const wait = Math.max(guardUntil.current - Date.now(), askWait(askId(a)), cameraWait());
      if (wait > 0) return holdOff(`${askId(a)}:${choice}`, wait);
    }
    guardUntil.current = Date.now() + ANSWER_GUARD_MS;
    setBusy(a.member);
    setError((await decideTyping(session.id, a.member, choice)) ?? "");
    setBusy("");
  };
  return (
    <div className="typing-strip" ref={strip}>
      {room.typingAsks.map((a) => (
        <div
          key={a.member}
          className="typing-ask"
          data-ask={askId(a)}
          role="alert"
          title={
            session.shell
              ? `${a.name} would type into this terminal on your Mac, as you: it's a shell, outside the room's sandbox, and runs whatever they type.`
              : `${a.name} would type into this session on your Mac, as you. A \`!\` command typed at its prompt runs in your shell, outside the room's sandbox, as anything typed into a terminal does. Even then, only you can answer your agent's permission prompts: their keys wait while it asks.`
          }
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className="team-initials">{initialsOf(a.name)}</span>
          <span className="reason">
            {firstName(a.name)} wants to type in “{title}”{session.shell ? `, ${TERMINAL_TYPING}` : ""}
          </span>
          <button className="outline" tabIndex={-1} disabled={busy === a.member || heldOff(`${askId(a)}:session`)} aria-label={`Allow ${a.name} to type in “${title}” for this session`} onClick={(e) => answer(e, a, "session")}>
            Allow for this session
          </button>
          <button className="outline" tabIndex={-1} disabled={busy === a.member || heldOff(`${askId(a)}:minutes`)} aria-label={`Allow ${a.name} to type in “${title}” for 15 min`} onClick={(e) => answer(e, a, "minutes")}>
            Allow for 15 min
          </button>
          <button className="outline" disabled={busy === a.member || heldOff(`${askId(a)}:deny`)} aria-label={`Deny ${a.name} typing in “${title}”`} onClick={(e) => answer(e, a, "deny")}>
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

/**
 * The owner's pane header: "Nick can type", for as long as they can, with ✕ to take it back. ✕ is the only way to, so
 * when main refuses it the chip says why (and the console has it) until the next try.
 */
export function Typists({ session, room }: { session: SessionInfo; room: RoomSessionTag }) {
  const now = Math.max(useNow(30_000), Date.now()); // an allowance given since the last tick counts from now
  const [refused, setRefused] = useState<Record<string, string>>({});
  if (room.remote || !room.typists?.length) return null;
  const revoke = async (g: TypingGrant) => {
    setRefused(({ [g.member]: _, ...rest }) => rest);
    const error = await decideTyping(session.id, g.member, "revoke");
    if (!error) return;
    console.error(`[mockingbird] taking typing in ${session.id} back from ${g.name} was refused:`, error);
    setRefused((r) => ({ ...r, [g.member]: error }));
  };
  const asking = session.status === "waiting";
  return (
    <>
      {room.typists.map((g: TypingGrant) => (
        <span
          key={g.member}
          className={refused[g.member] ? "chip typist refused" : "chip typist"}
          title={`${g.name} can type into this session ${g.until ? `for ${minutesLeft(g.until, now)} more` : "until you close it"}${asking ? ". Not while your agent asks for permission: that answer is yours" : ""}. ${refused[g.member] ? `✕ didn't stop it: ${refused[g.member]}` : "✕ stops it now."}`}
        >
          {firstName(g.name)} can type{g.until ? ` · ${minutesLeft(g.until, now)}` : ""}
          {refused[g.member] && <span className="typist-err">· couldn't stop it: {refused[g.member]}</span>}
          <button
            className="typist-x"
            aria-label={`Stop ${g.name} typing`}
            onClick={(e) => {
              e.stopPropagation();
              void revoke(g);
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
