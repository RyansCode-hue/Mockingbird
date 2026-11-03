import { useEffect, useState } from "react";
import { AGENT_NAME, formatTokens, isErr, ticketIdOf, totalTokens, type SessionInfo, type SessionMeter } from "../shared/types";
import { lastMeaningfulLine, terminalLines } from "../shared/terminalText";
import type { Tile } from "./landscapeModel";
import { tailLines } from "./cachedTerm";
import { landscapeTerm } from "./TerminalPane";
import { StatusDot } from "./StatusDot";
import { isRemote } from "./team/RoomLive";
import { titleOf } from "./appModel";
import { settled } from "./settled";

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
  const agent = !s.shell;
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
 * cards band (--ls-inv), drawn from the session and its cached terminal's buffer. No xterm is attached.
 */
export function WorkspaceCard({ tile, name, meters }: { tile: Tile; name: string | null; meters?: Record<string, SessionMeter> }) {
  const s = tile.front;
  const { line, error } = useLastLine(s);
  const meter = meters?.[s.id];
  const tokens = meter ? totalTokens(meter.tokens) : 0;
  const waiting = tile.members.filter((m) => m.status === "waiting").length;
  return (
    <div className="ls-card">
      <div className="ls-card-head">
        <StatusDot status={s.status} />
        <span className="ls-card-title" title={titleOf(s)}>
          {titleOf(s)}
        </span>
        {s.ticketId && <span className="ls-card-ticket">#{ticketIdOf(s.ticketId)}</span>}
      </div>
      <div className={`ls-card-line ${error ? "bad" : ""}`} title={error ?? line ?? undefined}>
        {error ? "Couldn't read its output" : line ?? (s.status === "dead" ? `process exited${typeof s.exitCode === "number" ? ` · code ${s.exitCode}` : ""}` : "No output yet")}
      </div>
      <div className="ls-card-foot">
        <span className="chip ls-kind">{kindLabel(s)}</span>
        <span className={`ls-card-status st-${s.status}`}>{STATUS[s.status]}</span>
        {tile.stack && (
          <span className="ls-card-stack" title={tile.members.map(titleOf).join("\n")}>
            {name ? `${name}: ` : ""}
            {tile.members.length} tabs{waiting && s.status !== "waiting" ? `, ${waiting} need you` : ""}
          </span>
        )}
        {isRemote(s) && s.room && <span className="ls-card-owner">{s.room.ownerName}'s</span>}
        {tokens > 0 && <span className="ls-card-tokens">{formatTokens(tokens)}</span>}
      </div>
    </div>
  );
}
