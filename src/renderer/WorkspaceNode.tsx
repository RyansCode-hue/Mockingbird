import { useEffect } from "react";
import type React from "react";
import type { SessionInfo, SessionMeter } from "../shared/types";
import { WORKSPACE_CHROME, WORKSPACE_FOOT, WORKSPACE_HEAD, type Size } from "../shared/landscape";
import type { Tile } from "./landscapeModel";
import { StatusDot } from "./StatusDot";
import { titleOf } from "./appModel";
import { BackIcon, ExpandIcon, MoreIcon } from "./Icons";
import { WorkspaceCard, kindLabel } from "./WorkspaceCard";
import { PaneChips, PaneRail, holdSize, usePaneGit, usePanePr, type PaneChipProps, type PaneRailProps } from "./TerminalPane";
import { isRemote } from "./team/RoomLive";
import { usable, type ModelAction } from "./workspaceActions";
import { DiffCell } from "./cardBadges";

/**
 * The frame around a workspace's terminal, from the size colsRows takes off: the sides' padding, the header bar over
 * it and the footer under it. Drawn from WORKSPACE_CHROME, so the terminal's holder is exactly the room colsRows
 * counts cells in.
 */
const PAD = WORKSPACE_CHROME.w / 2;

/**
 * What a workspace shows (Landscape.tsx decides): `live`, its terminal attached; `focus`, that filling the
 * window; `placeholder`, its place kept while it's in focus; `card`, C's status card (zoomed out); `still`, its
 * frame with nothing attached (off screen, or behind focus); `snapshot`, its screen as text while its terminal
 * is lent to a peek.
 */
export type NodeMode = "live" | "focus" | "placeholder" | "card" | "still" | "snapshot";

/** What a workspace's header chips and footer show beyond its git state, from its owner (main.tsx). */
export interface WorkspaceChrome {
  chips: Omit<PaneChipProps, "session" | "density" | "git" | "gitErr" | "onOpenRun" | "onOpenChanges" | "onTakeOver">;
  rail: Pick<PaneRailProps, "messages" | "onShowMessages" | "meter">;
}

/**
 * One workspace on the landscape (designs B and N): a header bar (status dot, title, agent, the pane's chips, ⋯) over
 * its live terminal, and a footer with the pane rail's cells. A stack shows its front member, with a tab for each. In
 * `focus` it fills the window and its header leads back; as a `placeholder` it keeps the workspace's place while it's
 * in focus. Zoomed out it's C's compact card. Whenever nothing attaches its terminal, the terminal is kept at the
 * workspace's size (holdSize), so attaching it again resizes nothing.
 *
 * Its actions are its owner's model (workspaceActions.tsx): the chips open what they name through it, ⋯ opens its
 * menu (`onMore`), and right-click opens the same anywhere on it (Landscape.tsx).
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
  actions,
  chrome,
  onSelect,
  onFocus,
  onBack,
  onTab,
  onMore,
  onClosedTab,
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
  /** The front session's actions: what its chips, ⋯ and right-click do. */
  actions: ModelAction[];
  chrome: WorkspaceChrome;
  /**
   * A press on it; `header` when it was on the header (or a card), off its buttons, which leaves the keyboard with the
   * landscape. A button's press is the button's: what had the keyboard (a terminal being typed in) keeps it.
   */
  onSelect: (tile: Tile, header: boolean) => void;
  onFocus: (tile: Tile) => void;
  onBack?: () => void;
  onTab: (tile: Tile, id: string) => void;
  /** ⋯ pressed: its menu, under the button. */
  onMore: (tile: Tile, from: HTMLElement) => void;
  /** A stack's closed tab pressed: its ghost's menu, under it. */
  onClosedTab?: (s: SessionInfo, from: HTMLElement) => void;
  /** The terminal of the session in front, at this size. */
  body: (s: SessionInfo, size: Size) => React.ReactNode;
}) {
  const s = tile.front;
  const waiting = tile.members.some((m) => m.status === "waiting");
  const away = mode === "card" || mode === "still" || mode === "snapshot";
  useEffect(() => (away ? holdSize(s, size) : undefined), [away, s.id, s.createdAt, s.status === "dead", size.w, size.h, gen]);
  // its git state and PR only while it's drawn with them: not as a card, off screen or behind focus
  const drawn = mode === "live" || mode === "focus" || mode === "snapshot";
  const { git, gitErr, gitRoot } = usePaneGit(s, drawn);
  const { pr, readPr } = usePanePr(drawn ? gitRoot : null, git?.branch);
  const pick = (key: string) => usable(actions, key)?.onPick;
  const style: React.CSSProperties =
    mode === "focus"
      ? { width: size.w, height: size.h }
      : mode === "card"
        ? // drawn inset by --ci (a few px on screen, styles.css), so cards stand apart and clear of their area's edge
          // zoomed out, where the gaps between placements are a pixel or two
          { left: `calc(${tile.rect.x}px + var(--ci))`, top: `calc(${tile.rect.y}px + var(--ci))`, width: `calc(${size.w}px - 2 * var(--ci))`, height: `calc(${size.h}px - 2 * var(--ci))` }
        : { left: tile.rect.x, top: tile.rect.y, width: size.w, height: size.h };
  const card = mode === "card";
  const more = (
    <button
      type="button"
      className="ls-more"
      aria-haspopup="menu"
      aria-label={`${titleOf(s)}: more actions`}
      data-tip="Its actions — or right-click it"
      onClick={(e) => {
        e.stopPropagation();
        onMore(tile, e.currentTarget);
      }}
    >
      <MoreIcon />
    </button>
  );
  return (
    <div
      className={["ls-node", mode, tile.stack ? "stack" : "", selected ? "selected" : "", picked ? "picked" : "", tile.hidden && mode !== "focus" ? "hidden" : "", waiting ? "st-waiting" : "", s.status === "dead" ? "st-dead" : "", isRemote(s) ? "remote" : ""].filter(Boolean).join(" ")}
      style={card ? { ...style, ["--ls-inv" as string]: inv } : { ...style, gridTemplateRows: `${WORKSPACE_HEAD}px minmax(0, 1fr) ${WORKSPACE_FOOT}px` }}
      data-ws={tile.key}
      data-front={s.id}
      onPointerDown={(e) => {
        const t = e.target as Element;
        onSelect(tile, !t.closest?.("button, [role=button], a[href]") && (card || !!t.closest?.(".ls-head")));
      }}
      onDoubleClick={card ? () => onFocus(tile) : undefined}
    >
      {card ? (
        <WorkspaceCard key={gen} tile={tile} name={name} meters={meters} actions={actions} more={more} />
      ) : (
        <>
          <div
            className="ls-head"
            title={mode === "focus" ? undefined : "double-click to focus · right-click for its actions"}
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
                    data-sid={m.id}
                    title={`${titleOf(m)} — drag it out to take it out of the stack`}
                    onClick={() => m.id !== s.id && onTab(tile, m.id)}
                  >
                    <StatusDot status={m.status} className="sm" />
                    <span className="t">{titleOf(m)}</span>
                  </button>
                ))}
                {tile.closed?.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="ls-tab closed"
                    data-closed={m.id}
                    title={`${titleOf(m)} — closed: its actions`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClosedTab?.(m, e.currentTarget);
                    }}
                  >
                    <span className="lg-dot" aria-hidden="true" />
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
            <span className="chip ls-kind">{kindLabel(s)}</span>
            {mode !== "placeholder" && (
              <span className="ls-chips">
                <PaneChips
                  {...chrome.chips}
                  session={s}
                  density="max"
                  git={git}
                  gitErr={null}
                  onOpenRun={pick("tool:run")}
                  onOpenChanges={pick("tool:changes")}
                  onTakeOver={pick("takeover") ? () => pick("takeover")?.() : undefined}
                />
              </span>
            )}
            <span className="ls-spacer" />
            {mode !== "focus" && mode !== "placeholder" && (
              <button className="ls-focus-btn" data-tip="Focus — fill the window (Enter or ⌘E)" aria-label="Focus" onClick={() => onFocus(tile)}>
                <ExpandIcon />
              </button>
            )}
            {more}
          </div>
          <div className="ls-term" style={{ padding: `0 ${PAD}px` }}>
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
          {drawn && s.status !== "dead" ? (
            <PaneRail className="rail ls-foot" session={s} git={git} gitErr={gitErr} pr={pr} readPr={readPr} {...chrome.rail} onOpenChanges={pick("tool:changes")} onOpenFiles={pick("tool:files")} afterGit={<DiffCell s={s} area={tile.area} on={drawn} />} />
          ) : (
            <div className="rail ls-foot" />
          )}
        </>
      )}
      {mode !== "focus" && mode !== "placeholder" && RESIZE_EDGES.map((e) => <div key={e} className={`ls-rz ${e}`} data-edge={e} aria-hidden="true" />)}
    </div>
  );
}

/** A workspace's resize handles (Landscape.tsx drags them): its four edges and four corners. */
export const RESIZE_EDGES = ["t", "r", "b", "l", "tl", "tr", "bl", "br"] as const;
export type ResizeEdge = (typeof RESIZE_EDGES)[number];
/** The edges a handle moves. */
export const edgesOf = (e: ResizeEdge): { left: boolean; right: boolean; top: boolean; bottom: boolean } => ({ left: e.includes("l"), right: e.includes("r"), top: e.includes("t"), bottom: e.includes("b") });
