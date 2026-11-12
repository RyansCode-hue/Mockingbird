import React, { useCallback, useEffect, useRef, useState } from "react";
import { plural } from "../shared/format";
import { EMPTY_TILES, type EmptyState } from "./landscapeFirstRun";

/** How long "Reading…" waits before it's said: a launch's reads are usually done sooner, and it would only flicker. */
const READING_AFTER_MS = 300;

/** A click on a tile or a link leaves the keyboard with the landscape (the press gave it there), so `?` and the letters still work after what it opens. */
const keepKeyboard = (e: React.MouseEvent) => e.preventDefault();

/**
 * The panel, taller than the view it's in (a short window): it scrolls, and takes presses for as long as that lasts,
 * since a wheel on it has to reach it. Otherwise presses go through it to the landscape.
 */
function useScrollsWhenTall() {
  const ro = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const check = () => el.toggleAttribute("data-scrolls", el.scrollHeight > el.clientHeight + 1);
    ro.current = new ResizeObserver(check);
    ro.current.observe(el);
    if (el.firstElementChild) ro.current.observe(el.firstElementChild);
    check();
  }, []);
}

/**
 * What goes on a landscape with nothing drawn on it (design H), by what's known: the tiles and how to right-click only
 * when it's really empty; what couldn't be read when it can't be told; "Reading…" until it can. It takes no presses but
 * its own buttons', so a press or a right-click anywhere else is the landscape's, and a right-click on a button opens
 * the same menu as anywhere (Landscape's onContextMenu).
 */
export function LandscapeEmpty({
  state,
  onTile,
  busy,
  onJoinRoom,
  treeHidden,
  onShowTree,
}: {
  state: Exclude<EmptyState, { kind: "drawn" }>;
  /** A tile's create-menu row run, for a workspace placed at the view's centre. */
  onTile: (row: string) => void;
  /** The rows whose flow is under way (off in the create menu): their tiles say so. */
  busy?: ReadonlySet<string>;
  onJoinRoom: () => void;
  /** The side bar is hidden, or shows Team rooms: its Closed list needs showing. */
  treeHidden: boolean;
  onShowTree: () => void;
}) {
  const [late, setLate] = useState(false);
  const fits = useScrollsWhenTall();
  const reading = state.kind === "reading";
  useEffect(() => {
    if (!reading) return setLate(false);
    const t = setTimeout(() => setLate(true), READING_AFTER_MS);
    return () => clearTimeout(t);
  }, [reading]);
  if (state.kind === "reading")
    return (
      <div ref={fits} className="ls-empty" data-empty="reading">
        {late && <div className="ls-empty-text">{state.why}</div>}
      </div>
    );
  if (state.kind === "broken")
    return (
      <div ref={fits} className="ls-empty" data-empty="broken" role="status">
        <div className="ls-empty-in">
          <div className="ls-empty-title">{state.title}</div>
          <div className="ls-empty-text">{state.why}</div>
          {state.retry && (
            <button type="button" className="outline ls-empty-link" data-act="retry" onClick={state.retry}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  return (
    <div ref={fits} className="ls-empty" data-empty={state.reset ? "reset" : "empty"}>
      <div className="ls-empty-in">
        <div className="ls-empty-title">{state.reset ? "The layout was reset" : "An empty landscape"}</div>
        <div className="ls-empty-text">
          {state.reset && `${state.reset} `}Right-click anywhere to add a workspace, or start from one of these.
        </div>
        <div className="ls-empty-tiles">
          {EMPTY_TILES.map((t) => {
            const going = !!busy?.has(t.row);
            return (
              // still pressable while its flow is under way: the press runs the row, which is off and says why
              <button key={t.row} type="button" className="ls-empty-tile" data-tile={t.row} aria-busy={going || undefined} onMouseDown={keepKeyboard} onClick={() => onTile(t.row)}>
                <span className="t">{t.title}</span>
                <span className="s">{going ? "Opening…" : t.sub}</span>
              </button>
            );
          })}
        </div>
        {state.closed > 0 && (
          <div className="ls-empty-closed" data-closed={state.closed}>
            {plural(state.closed, "closed session")} can be reopened from the Closed list in the side bar.
            {treeHidden && (
              <>
                {" "}
                <button type="button" className="ls-empty-link" data-act="show-tree" onMouseDown={keepKeyboard} onClick={onShowTree}>
                  Show it
                </button>
              </>
            )}
          </div>
        )}
        <div className="ls-empty-foot">
          Press ? for shortcuts ·{" "}
          <button type="button" className="ls-empty-link" data-act="join" title="Paste a teammate's invite code (it's in ⌘K too)" onMouseDown={keepKeyboard} onClick={onJoinRoom}>
            Join a room…
          </button>
        </div>
      </div>
    </div>
  );
}
