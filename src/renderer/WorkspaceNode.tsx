import type React from "react";
import { AGENT_NAME, formatTokens, totalTokens, type SessionInfo, type SessionMeter } from "../shared/types";
import { WORKSPACE_CHROME, type Size } from "../shared/landscape";
import type { Tile } from "./landscapeModel";
import { StatusDot } from "./StatusDot";
import { OwnerTag, isRemote } from "./team/RoomLive";
import { titleOf } from "./appModel";
import { BackIcon, ExpandIcon } from "./Icons";

/**
 * The frame around a workspace's terminal, from the size colsRows takes off: the sides' padding, and the
 * header bar with the padding under the terminal. Drawn from WORKSPACE_CHROME, so the terminal's holder is
 * exactly the room colsRows counts cells in.
 */
const PAD = WORKSPACE_CHROME.w / 2;
const HEAD = WORKSPACE_CHROME.h - PAD;

const kindLabel = (s: SessionInfo): string => (s.shell ? "Terminal" : AGENT_NAME[s.agent ?? "claude"]);

/**
 * One workspace on the landscape (design B): a card with a header bar (status dot, title, agent chip,
 * tokens) over its live terminal. A stack shows its front member, with a tab for each. In `focus` it fills
 * the window and its header leads back; as a `placeholder` it keeps the workspace's place while it's in focus.
 */
export function WorkspaceNode({
  tile,
  name,
  mode,
  size,
  selected,
  meters,
  onSelect,
  onFocus,
  onBack,
  onTab,
  body,
}: {
  tile: Tile;
  /** A stack's sub-group, shown before its tabs. */
  name: string | null;
  mode: "live" | "focus" | "placeholder";
  /** Its size at 100%: its placement's, or the window's in focus. */
  size: Size;
  selected: boolean;
  meters?: Record<string, SessionMeter>;
  /** A press on it; `header` when it was on the header, which leaves the keyboard with the landscape. */
  onSelect: (tile: Tile, header: boolean) => void;
  onFocus: (tile: Tile) => void;
  onBack?: () => void;
  onTab: (tile: Tile, id: string) => void;
  /** The terminal of the session in front, at this size. */
  body: (s: SessionInfo, size: Size) => React.ReactNode;
}) {
  const s = tile.front;
  const meter = meters?.[s.id];
  const tokens = meter ? totalTokens(meter.tokens) : 0;
  const waiting = tile.members.some((m) => m.status === "waiting");
  const style: React.CSSProperties =
    mode === "focus"
      ? { width: size.w, height: size.h }
      : { left: tile.rect.x, top: tile.rect.y, width: size.w, height: size.h };
  return (
    <div
      className={["ls-node", mode, selected ? "selected" : "", waiting ? "st-waiting" : "", s.status === "dead" ? "st-dead" : "", isRemote(s) ? "remote" : ""].filter(Boolean).join(" ")}
      style={{ ...style, gridTemplateRows: `${HEAD}px minmax(0, 1fr)` }}
      data-ws={tile.key}
      data-front={s.id}
      onPointerDown={(e) => onSelect(tile, !!(e.target as Element).closest?.(".ls-head"))}
    >
      <div
        className="ls-head"
        title={mode === "focus" ? undefined : "double-click to focus"}
        onDoubleClick={(e) => {
          if ((e.target as Element).closest("button")) return;
          if (mode === "live") onFocus(tile);
        }}
      >
        {mode === "focus" && onBack && (
          <button className="ls-back" data-tip="Back to the landscape (⌘E, ⌘Esc, or Esc when you're not typing in the terminal)" onClick={onBack}>
            <BackIcon />
          </button>
        )}
        {tile.stack ? (
          <span className="ls-tabs" role="tablist" aria-label={name ?? "Stack"}>
            {name && <span className="ls-stack-name">{name}</span>}
            {tile.members.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={m.id === s.id}
                className={`ls-tab ${m.id === s.id ? "on" : ""}`}
                title={titleOf(m)}
                onClick={() => m.id !== s.id && onTab(tile, m.id)}
              >
                <StatusDot status={m.status} className="sm" />
                <span className="t">{titleOf(m)}</span>
              </button>
            ))}
          </span>
        ) : (
          <>
            <StatusDot status={s.status} />
            <span className="ls-title" title={titleOf(s)}>
              {titleOf(s)}
            </span>
          </>
        )}
        {s.room && <OwnerTag room={s.room} />}
        <span className="chip ls-kind">{kindLabel(s)}</span>
        <span className="ls-spacer" />
        {tokens > 0 && (
          <span className="ls-tokens" title={`This session's conversations: ${formatTokens(tokens)} tokens`}>
            {formatTokens(tokens)}
          </span>
        )}
        {mode === "live" && (
          <button className="ls-focus-btn" data-tip="Focus — fill the window (Enter or ⌘E)" aria-label="Focus" onClick={() => onFocus(tile)}>
            <ExpandIcon />
          </button>
        )}
      </div>
      <div className="ls-term" style={{ padding: `0 ${PAD}px ${PAD}px` }}>
        {mode === "placeholder" ? <div className="ls-away">In focus</div> : body(s, size)}
      </div>
    </div>
  );
}
