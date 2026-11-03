import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isErr, type SessionInfo } from "../../shared/types";
import type { LivePanesState, MemberView, RoomSessionTag } from "../../shared/team/livePanes";
import type { MemberId } from "../../shared/team/types";
import { initialsOf } from "../Team";
import { followPlan, mergeRoomSessions, sameList } from "./roomLiveModel";
import { firstName } from "./connectedModel";
import { ReadIcon } from "../Icons";
import { useCrossfade } from "../motion";
import { settled } from "../settled";

/**
 * Team rooms in the window, stage 2 (live panes): teammates' room sessions
 * shown with this window's own, who's looking at what, and Follow. See
 * docs/team-rooms.md, "Sessions in a room".
 */

/**
 * This window's sessions with teammates' room sessions merged in (and its own
 * room sessions tagged), kept current. Tells the main process what the grid
 * shows and which pane is focused, for teammates' presence initials, Follow,
 * and which teammates' sessions to stream here.
 */
export function useRoomLive(own: SessionInfo[], shown: string[], focused: string | null): RoomLive {
  const [state, setState] = useState<LivePanesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let alive = true;
    void settled(window.mb.teamLive()).then((s: LivePanesState | { error: string }) => {
      if (!alive) return;
      if (isErr(s)) {
        console.error("[mockingbird] couldn't read the room sessions:", s.error);
        setError(s.error);
      } else {
        setError(null);
        setState(s);
      }
    });
    return () => {
      alive = false;
    };
  }, [tries]);
  useEffect(
    () =>
      window.mb.onTeamLive((s: LivePanesState) => {
        setError(null);
        setState(s);
      }),
    []
  );
  const retry = useCallback(() => setTries((n) => n + 1), []);
  const sessions = useMemo(() => mergeRoomSessions(own, state), [own, state]);
  const shownKey = shown.join(",");
  useEffect(() => {
    window.mb.teamLiveView({ shown, focused });
  }, [shownKey, focused]);
  return { sessions, state, error, retry };
}

export interface RoomLive {
  sessions: SessionInfo[];
  /**
   * The room sessions as the main process has them; null until they're read.
   * Main indexes teammates' sessions from the saved rooms as it starts, before
   * any window can ask, so once this is set they're all in it (none when no
   * room is joined, or team rooms couldn't start: `problems` says which).
   */
  state: LivePanesState | null;
  /** Why they couldn't be read; retry() asks again. */
  error: string | null;
  retry: () => void;
}

export interface Follow {
  /** The teammate being followed, and their view (undefined while they show nothing here). */
  leader: { id: MemberId; name: string; view: MemberView | undefined } | null;
  /** Teammates who can be followed: connected, with a view. */
  candidates: MemberView[];
  follow(id: MemberId): void;
  stop(): void;
}

/** A change to the grid this soon after following applied a view is following's own. */
const OWN_CHANGE_MS = 600;

/**
 * Follow a teammate: the grid mirrors the room sessions they show and the one
 * they're in, until you stop or change the grid yourself (show, hide or move
 * a pane, switch groups). Clicking into a pane to type doesn't stop it.
 */
export function useFollow(o: {
  views: MemberView[];
  sessions: SessionInfo[];
  shown: string[];
  groupOf: (s: SessionInfo) => string;
  show: (group: string, ids: string[], focused: string | null) => void;
}): Follow {
  const [leader, setLeader] = useState<{ id: MemberId; name: string } | null>(null);
  const applied = useRef<{ plan: string; at: number; shown: string[] | null } | null>(null);
  const view = leader ? o.views.find((v) => v.member === leader.id) : undefined;
  const plan = leader ? followPlan(view, o.sessions, o.groupOf) : null;
  const planKey = plan ? JSON.stringify(plan) : "";
  useEffect(() => {
    if (!leader || !plan || applied.current?.plan === planKey) return;
    applied.current = { plan: planKey, at: Date.now(), shown: null };
    o.show(plan.group, plan.ids, plan.focused);
  }, [leader?.id, planKey]);
  const shownKey = o.shown.join(",");
  useEffect(() => {
    const a = applied.current;
    if (!leader || !a) return;
    if (a.shown === null && Date.now() - a.at < OWN_CHANGE_MS) {
      a.shown = o.shown;
      return;
    }
    if (a.shown === null || !sameList(a.shown, o.shown)) {
      applied.current = null;
      setLeader(null);
    }
  }, [shownKey]);
  return {
    leader: leader ? { ...leader, view } : null,
    candidates: o.views,
    follow: (id) => {
      const v = o.views.find((x) => x.member === id);
      applied.current = null;
      setLeader({ id, name: v?.name ?? id.slice(0, 8) });
    },
    stop: () => {
      applied.current = null;
      setLeader(null);
    },
  };
}

/** The owner's initials on a teammate's session (its sidebar row and pane header). */
export function OwnerTag({ room }: { room: RoomSessionTag }) {
  // whose it is and whether they're there: a change of either crossfades the badge
  const fade = useCrossfade<HTMLSpanElement>();
  if (!room.remote) return null;
  const where = !room.online ? " — their Mockingbird is offline" : !room.live ? " — closed there (they can resume it)" : "";
  const away = !(room.online && room.live);
  return (
    <span key={`${room.owner}:${away}`} ref={fade} className={`team-owner ${away ? "away" : ""}`} title={`${room.ownerName}'s session: it runs on ${room.ownerName}'s Mockingbird${where}. You can watch it; typing into it needs ${room.ownerName}'s OK.`}>
      {initialsOf(room.ownerName)}
    </span>
  );
}

/** Initials of the teammates showing a room session; ringed for the ones in it. */
export function Lookers({ room }: { room: RoomSessionTag }) {
  if (!room.lookers.length) return null;
  const tip = room.lookers.map((l) => `${l.name} ${l.focused ? "is in this pane" : "has it on screen"}`).join("\n");
  return (
    <span className="team-lookers" title={tip}>
      {room.lookers.map((l) => (
        <span key={l.id} className={`team-initials ${l.focused ? "focused" : ""}`}>
          {initialsOf(l.name)}
        </span>
      ))}
    </span>
  );
}

/** Following someone, or who can be followed, for the group bar: who to follow only in a shared group. */
export function FollowControls({ follow, shared }: { follow: Follow; shared: boolean }) {
  if (follow.leader) {
    const away = !follow.leader.view;
    const who = firstName(follow.leader.name);
    return (
      <span className="team-follow on" title={`Your grid mirrors what ${follow.leader.name} shows. Changing your grid stops it.`}>
        <ReadIcon />
        {away ? `Following ${who} — waiting for a shared session` : `Following ${who}`}
        <button className="gb-btn" onClick={follow.stop}>
          Stop
        </button>
      </span>
    );
  }
  if (!shared || !follow.candidates.length) return null;
  return (
    <span className="team-follow">
      {follow.candidates.map((v) => (
        <button key={v.member} className="gb-btn" title={`Mirror ${v.name}'s grid: the shared sessions they show, and the one they're in`} onClick={() => follow.follow(v.member)}>
          <ReadIcon />
          <span className="gb-t">Follow</span> {firstName(v.name)}
        </button>
      ))}
    </span>
  );
}

/** Problems with room sessions (a record that couldn't be published…), above the session list. */
export function LiveProblems({ state }: { state: LivePanesState | null }) {
  if (!state?.problems.length) return null;
  return (
    <div className="team-live-problems">
      {state.problems.map((p) => (
        <div key={p} className="err">
          {p}
        </div>
      ))}
    </div>
  );
}

/** Whether a session runs on a teammate's Mockingbird (shown here as a copy). */
export const isRemote = (s: SessionInfo | null | undefined): boolean => !!s?.room?.remote;
