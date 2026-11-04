import { useEffect } from "react";
import type React from "react";
import { formatTokens, totalTokens, type SessionInfo, type SessionMeter } from "../shared/types";
import { WORKSPACE_CHROME, type Size } from "../shared/landscape";
import type { Tile } from "./landscapeModel";
import { StatusDot } from "./StatusDot";
import { OwnerTag, isRemote } from "./team/RoomLive";
import { titleOf } from "./appModel";
import { BackIcon, ExpandIcon } from "./Icons";
import { WorkspaceCard, kindLabel } from "./WorkspaceCard";
import { holdSize } from "./TerminalPane";

/**
 * The frame around a workspace's terminal, from the size colsRows takes off: the sides' padding, and the
 * header bar with the padding under the terminal. Drawn from WORKSPACE_CHROME, so the terminal's holder is
 * exactly the room colsRows counts cells in.
 */
const PAD = WORKSPACE_CHROME.w / 2;
const HEAD = WORKSPACE_CHROME.h - PAD;

/**
 * What a workspace shows (Landscape.tsx decides): `live`, its terminal attached; `focus`, that filling the
 * window; `placeholder`, its place kept while it's in focus; `card`, C's status card (zoomed out); `still`, its
 * frame with nothing attached (off screen, or behind focus); `snapshot`, its screen as text while its terminal
 * is lent to a peek.
 */
export type NodeMode = "live" | "focus" | "placeholder" | "card" | "still" | "snapshot";

/**
 * One workspace on the landscape (design B): a card with a header bar (status dot, title, agent chip,
 * tokens) over its live terminal. A stack shows its front member, with a tab for each. In `focus` it fills
 * the window and its header leads back; as a `placeholder` it keeps the workspace's place while it's in focus.
 * Zoomed out it's C's compact card. Whenever nothing attaches its terminal, the terminal is kept at the
 * workspace's size (holdSize), so attaching it again resizes nothing.
 */
export function WorkspaceNode({
  tile,
  name,
  mode,
  size,
  selected,
  picked = false,
  meters,
  snapshot,
  inv,
  gen,
  onSelect,
  onFocus,
  onBack,
  onTab,
  body,
}: {
  tile: Tile;
  /** A stack's sub-group, shown before its tabs. */
  name: string | null;
  mode: NodeMode;
  /** Its size at 100%: its placement's, or the window's in focus. */
  size: Size;
  selected: boolean;
  /** In the marquee's selection, which Make area… takes. */
  picked?: boolean;
  meters?: Record<string, SessionMeter>;
  /** In `snapshot`: the screen's rows as text when its terminal was lent. */
  snapshot?: string | null;
  /** 1 / the camera's zoom when it rendered, which a card's type is sized by (the landscape keeps it current as it zooms). */
  inv: number;
  /** The front session's terminal's generation (main.tsx's termKey): a restart gives it a new terminal, which whatever reads the old one must take up. */
  gen: string;
  /** A press on it; `header` when it was on the header (or a card), which leaves the keyboard with the landscape. */
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
  const away = mode === "card" || mode === "still" || mode === "snapshot";
  useEffect(() => (away ? holdSize(s, size) : undefined), [away, s.id, s.createdAt, s.status === "dead", size.w, size.h, gen]);
  const style: React.CSSProperties =
    mode === "focus"
      ? { width: size.w, height: size.h }
      : mode === "card"
        ? // drawn inset by --ci (a few px on screen, styles.css), so cards stand apart and clear of their area's edge
          // zoomed out, where the gaps between placements are a pixel or two
          { left: `calc(${tile.rect.x}px + var(--ci))`, top: `calc(${tile.rect.y}px + var(--ci))`, width: `calc(${size.w}px - 2 * var(--ci))`, height: `calc(${size.h}px - 2 * var(--ci))` }
        : { left: tile.rect.x, top: tile.rect.y, width: size.w, height: size.h };
  const card = mode === "card";
  return (
    <div
      className={["ls-node", mode, selected ? "selected" : "", picked ? "picked" : "", tile.hidden && mode !== "focus" ? "hidden" : "", waiting ? "st-waiting" : "", s.status === "dead" ? "st-dead" : "", isRemote(s) ? "remote" : ""].filter(Boolean).join(" ")}
      style={card ? { ...style, ["--ls-inv" as string]: inv } : { ...style, gridTemplateRows: `${HEAD}px minmax(0, 1fr)` }}
      data-ws={tile.key}
      data-front={s.id}
      onPointerDown={(e) => onSelect(tile, card || !!(e.target as Element).closest?.(".ls-head"))}
      onDoubleClick={card ? () => onFocus(tile) : undefined}
    >
      {card ? (
        <WorkspaceCard key={gen} tile={tile} name={name} meters={meters} />
      ) : (
        <>
          <div
            className="ls-head"
            title={mode === "focus" ? undefined : "double-click to focus"}
            onDoubleClick={(e) => {
              if ((e.target as Element).closest("button")) return;
              if (mode !== "focus" && mode !== "placeholder") onFocus(tile);
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
            {mode !== "focus" && mode !== "placeholder" && (
              <button className="ls-focus-btn" data-tip="Focus — fill the window (Enter or ⌘E)" aria-label="Focus" onClick={() => onFocus(tile)}>
                <ExpandIcon />
              </button>
            )}
          </div>
          <div className="ls-term" style={{ padding: `0 ${PAD}px ${PAD}px` }}>
            {mode === "placeholder" ? (
              <div className="ls-away">In focus</div>
            ) : mode === "still" ? (
              <div className="ls-still" />
            ) : mode === "snapshot" ? (
              <pre className="ls-snap" aria-label="Its screen, while it's peeked">
                {snapshot}
              </pre>
            ) : (
              body(s, size)
            )}
          </div>
        </>
      )}
    </div>
  );
}
