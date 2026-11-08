import React, { useEffect, useState } from "react";
import { AGENT_NAME, isErr, ticketIdOf, type SessionInfo, type SessionMeter } from "../shared/types";
import { BadgeRow, useCardBadges } from "./cardBadges";
import { lastMeaningfulLine, terminalLines } from "../shared/terminalText";
import type { Tile } from "./landscapeModel";
import { tailLines } from "./cachedTerm";
import { landscapeTerm } from "./TerminalPane";
import { StatusDot } from "./StatusDot";
import { isRemote } from "./team/RoomLive";
import { titleOf } from "./appModel";
import { settled } from "./settled";
import { usable, type ModelAction } from "./workspaceActions";

/** How long a card waits after output arrives to read its line again: a spinner redraws many times a second. */
export const CARD_LINE_MS = 500;

const STATUS: Record<SessionInfo["status"], string> = { working: "Working", waiting: "Needs you", idle: "Idle", dead: "Exited" };

export const kindLabel = (s: SessionInfo): string => (s.shell ? "Terminal" : AGENT_NAME[s.agent ?? "claude"]);

/**
 * A session's "what it did" line for its card: the last meaningful line of its cached terminal (made for it if no
 * pane has made it yet, so the data pump keeps it current), read again a moment after output arrives. A session
 * that has exited reads its saved output once instead. Its error, when that read fails.
 */
function useLastLine(s: SessionInfo): { line: string | null; error: string | null } {
  const [got, setGot] = useState<{ line: string | null; error: string | null }>({ line: null, error: null });
  const dead = s.status === "dead";
  const agent = s.shell ? null : (s.agent ?? "claude");
  useEffect(() => {
    if (dead) {
      let alive = true;
      void settled(window.mb.sessionBuffer(s.id), `Couldn't read ${s.id}'s output for its card`).then((r) => {
        if (!alive) return;
        if (isErr(r)) return setGot({ line: null, error: r.error });
        setGot({ line: lastMeaningfulLine(terminalLines(r || ""), { agent }), error: null });
      });
      return () => void (alive = false);
    }
    const term = landscapeTerm(s);
    const read = () => setGot((g) => {
      const line = lastMeaningfulLine(tailLines(term), { agent });
      return g.line === line && !g.error ? g : { line, error: null };
    });
    read();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = term.onWriteParsed(() => {
      timer ??= setTimeout(() => {
        timer = null;
        read();
      }, CARD_LINE_MS);
    });
    return () => {
      sub.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [s.id, s.createdAt, dead]);
  return got;
}

/**
 * A workspace zoomed out (design C): a compact status card, its type sized for the screen at any zoom below the
 * cards band (--ls-inv), drawn from the session and its cached terminal's buffer. No xterm is attached. One whose
 * session has exited stays in its place with Resume and Close & clean up (its actions'); `more` is its ⋯.
 */
export function WorkspaceCard({ tile, name, meters, actions, more }: { tile: Tile; name: string | null; meters?: Record<string, SessionMeter>; actions: ModelAction[]; more: React.ReactNode }) {
  const s = tile.front;
  const { line, error } = useLastLine(s);
  // S7: what it did (its latest message), and its diff, PR and cost badges (cardBadges.tsx)
  const { badges, did } = useCardBadges(s, tile.area, meters?.[s.id]);
  // a stack's other tabs, by name under its title, those waiting on you counted first (the front one's status is its own)
  const others = tile.members.filter((m) => m.id !== s.id);
  const waiting = others.filter((m) => m.status === "waiting").length;
  const tabs = tile.members.length + (tile.closed?.length ?? 0);
  const resume = usable(actions, "resume");
  const close = s.status === "dead" ? usable(actions, "close") : undefined;
  return (
    <div className="ls-card">
      <div className="ls-card-head">
        <StatusDot status={s.status} />
        {tile.stack && (
          <span className="chip ls-card-chip ls-chip-short" title={name ?? undefined} aria-hidden="true">
            ×{tabs}
          </span>
        )}
        <span className="ls-card-title" title={titleOf(s)}>
          {titleOf(s)}
        </span>
        {tile.stack && (
          <span className="chip ls-card-chip ls-chip-long" data-stack={tile.stack} title={name ?? undefined}>
            stack · {tabs}
          </span>
        )}
        {s.ticketId && <span className="ls-card-ticket">#{ticketIdOf(s.ticketId)}</span>}
        {more}
      </div>
      {tile.stack && (others.length > 0 || !!tile.closed?.length) && (
        <div className="ls-card-tabs" title={[...tile.members, ...(tile.closed ?? [])].map(titleOf).join("\n")}>
          {waiting > 0 && <span className="ls-card-needs">{waiting} need{waiting === 1 ? "s" : ""} you</span>}
          {others.map((m) => (
            <span key={m.id} className="ls-card-tab">
              {titleOf(m)}
            </span>
          ))}
          {!!tile.closed?.length && <span className="ls-card-tab closed">{tile.closed.length} closed</span>}
        </div>
      )}
      {did && (
        <div className={`ls-card-did ${did.failed ? "bad" : ""}`} data-did="" title={did.title}>
          {did.text}
        </div>
      )}
      <div className={`ls-card-line ${error ? "bad" : ""}`} title={error ?? line ?? undefined}>
        {error ? "Couldn't read its output" : line ?? (s.status === "dead" ? `process exited${typeof s.exitCode === "number" ? ` · code ${s.exitCode}` : ""}` : "No output yet")}
      </div>
      <div className="ls-card-foot">
        <span className="chip ls-kind">{kindLabel(s)}</span>
        <span className={`ls-card-status st-${s.status}`}>{STATUS[s.status]}</span>
        {isRemote(s) && s.room && <span className="ls-card-owner">{s.room.ownerName}'s</span>}
      </div>
      <BadgeRow badges={badges} />
      {s.status === "dead" && (resume || close) && (
        <div className="ls-card-acts">
          {resume && (
            <button type="button" className="outline strong" onClick={(e) => (e.stopPropagation(), resume.onPick())}>
              Resume
            </button>
          )}
          {close && (
            <button type="button" className="outline" onClick={(e) => (e.stopPropagation(), close.onPick())}>
              Close &amp; clean up
            </button>
          )}
        </div>
      )}
    </div>
  );
}
