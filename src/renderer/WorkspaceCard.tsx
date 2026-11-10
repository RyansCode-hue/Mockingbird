import React, { useContext, useEffect, useState } from "react";
import { AGENT_NAME, isErr, ticketIdOf, type SessionInfo, type SessionMeter } from "../shared/types";
import { BadgeContext, BadgeRow, askBadge, repeatsDid, useCardBadges } from "./cardBadges";
import { lastMeaningfulLine, terminalLines } from "../shared/terminalText";
import type { Tile } from "./landscapeModel";
import { needsLabel } from "./needsYouModel";
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
 * A session's terminal line for its card: the last meaningful line of its cached terminal (made for it if no pane has
 * made it yet, so the data pump keeps it current), read again a moment after output arrives. A session that has
 * exited reads its saved output once instead. Its error, when that read fails.
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
  const { needIds } = useContext(BadgeContext);
  // what it did (its latest message), and its diff, PR and cost badges (cardBadges.tsx)
  const { badges, did } = useCardBadges(s, tile.area, meters?.[s.id]);
  // a stack's other tabs, by name under its title, those Needs you lists counted first (the front one's status is its own)
  const others = tile.members.filter((m) => m.id !== s.id);
  const need = others.filter((m) => needIds.has(m.id)).length;
  const tabs = tile.members.length + (tile.closed?.length ?? 0);
  const resume = usable(actions, "resume");
  const close = s.status === "dead" ? usable(actions, "close") : undefined;
  // an idle agent's last output is its last message: said once, as what it did
  const repeated = !error && did && !did.failed && repeatsDid(line, did.text);
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
      {/* drawn bottom up (styles.css, .ls-card-mid, .ls-card-body): the foot, its words (what it did, the terminal's
          line), a stack's other tabs, so a short card lets go of the line, what it did, the foot, then the tabs, each whole */}
      <div className="ls-card-mid">
        <div className="ls-card-body">
          <div className="ls-card-foot">
            <span className="chip ls-kind">{kindLabel(s)}</span>
            <span className={`ls-card-status st-${s.status}`}>{STATUS[s.status]}</span>
            <BadgeRow badges={badges} lead={isRemote(s) && s.room ? <span className="ls-card-owner">{s.room.ownerName}'s</span> : null} />
          </div>
          <div className="ls-card-text">
            {did && (
              <div className={`ls-card-did ${did.failed ? "bad" : ""}`} data-did="" title={did.title}>
                {did.text}
              </div>
            )}
            {!repeated && (
              <div className="ls-card-lines">
                <div className={`ls-card-line ${error ? "bad" : ""}`} title={error ?? line ?? undefined}>
                  {error ? "Couldn't read its output" : line ?? (s.status === "dead" ? `process exited${typeof s.exitCode === "number" ? ` · code ${s.exitCode}` : ""}` : "No output yet")}
                </div>
              </div>
            )}
          </div>
        </div>
        {tile.stack && (others.length > 0 || !!tile.closed?.length) && (
          <div className="ls-card-tabs" title={[...tile.members, ...(tile.closed ?? [])].map(titleOf).join("\n")}>
            {need > 0 && <span className="ls-card-needs">{needsLabel(need)}</span>}
            {others.map((m) => {
              // a teammate's ask to type in it: the front one's is the card's badge
              const ask = askBadge(m);
              return (
                <span key={m.id} className={ask ? "ls-card-tab ask" : "ls-card-tab"} data-sid={m.id} title={ask ? `${titleOf(m)} — ${ask.text}` : undefined}>
                  {titleOf(m)}
                </span>
              );
            })}
            {!!tile.closed?.length && <span className="ls-card-tab closed">{tile.closed.length} closed</span>}
          </div>
        )}
      </div>
      {s.status === "dead" && (resume || close) && (
        <div className="ls-card-acts">
          {resume && (
            <button type="button" className="outline strong" title={resume.title || "Resume"} onClick={(e) => (e.stopPropagation(), resume.onPick())}>
              Resume
            </button>
          )}
          {close && (
            <button type="button" className="outline" title={close.title || "Close & clean up"} onClick={(e) => (e.stopPropagation(), close.onPick())}>
              Close &amp; clean up
            </button>
          )}
        </div>
      )}
    </div>
  );
}
