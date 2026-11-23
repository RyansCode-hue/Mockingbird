import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Camera, Rect, Size } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { MoreIcon } from "./Icons";
import { StatusDot } from "./StatusDot";
import { usePaneGit } from "./TerminalPane";
import { useChatUnread } from "./team/RoomChat";
import { titleOf } from "./appModel";
import { enter, motion } from "./motion";
import { OVERLAYS } from "./keys";
import { BAR_MARGIN, areaBarItems, barAnchorFor, barPlace, escapeClears, foldBar, workspaceBarItems, type BarItem, type BarTarget } from "./selectionBarModel";
import { menuOf, type ModelAction } from "./workspaceActions";
import { AccentDot } from "./AreaColour";

/**
 * The selection bar (designs Q and Q2; docs/landscape.md, Tools): the actions of whatever is selected on the
 * landscape — an area, a workspace, or several workspaces — at normal size whatever the zoom, floating just above the
 * selection and sliding to stay inside the window. Its buttons are the action model's rows (selectionBarModel.ts
 * turns them into buttons), with their handlers, the reasons a row is off, and the one tool gate behind them; ⋯ is
 * the selection's whole menu, the one right-click gives. In a narrow window buttons fold behind "» n more" in priority
 * order, and » puts them on a second row until « Less.
 */

/** What every kind of bar needs from the landscape: where it goes, and what clears the selection. */
export interface BarPlace {
  target: BarTarget;
  /** The camera, followed every frame without a render (Landscape's listeners). */
  listeners: Set<(cam: Camera) => void>;
  cam: React.MutableRefObject<Camera>;
  vp: Size;
  /** The strip along the view's top the bar stays under (the area switcher's). */
  minTop: number;
  /** What it keeps clear of, in the view (the minimap); null for nothing. */
  avoid: Rect | null;
  /** Folded buttons on a second row (» … « Less), remembered (selectionBarModel.ts). */
  extended: boolean;
  onExtended: (on: boolean) => void;
  /** Esc in the bar: the selection cleared. */
  onClear: () => void;
}

const MEASURE = "$";
const ID = `${MEASURE}id`;
const MORE = `${MEASURE}more`;
const DOTS = `${MEASURE}dots`;

/**
 * The bar itself: the selection's name, its buttons and ⋯ (`more`, the selection's whole menu). A right-click on the
 * bar opens `menu` (by default `more`), the menu a right-click on the selection opens. Its width comes from its
 * buttons; when they don't fit the view, buttons fold behind » (measured once for each set of buttons, `idText` — the
 * text `identity` shows — and width of view, before it's painted). It's placed by the camera's listener, every frame
 * the camera moves, never by a render.
 */
export function SelectionBar({ label, identity, idText, items, more, menu = more, place }: { label: string; identity: ReactNode; idText: string; items: readonly BarItem[]; more: (() => MenuEntry[]) | null; menu?: (() => MenuEntry[]) | null; place: BarPlace }) {
  const el = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const size = useRef<Size>({ w: 0, h: 0 });
  const now = useRef(place);
  now.current = place;
  const ctx = useContextMenu(label);
  const sig = [idText, ...items.map((i) => `${i.key}:${i.label}:${i.disabled ? 1 : 0}`), more ? "more" : "", place.vp.w].join("\n");
  const [fold, setFold] = useState<{ sig: string; folded: string[] } | null>(null);
  const measuring = fold?.sig !== sig;
  const folded = measuring ? [] : fold.folded;
  const foldedSet = new Set(folded);

  /** Where it goes now: above its selection on screen, inside the view. */
  const put = (cam: Camera) => {
    const e = el.current;
    const p = now.current;
    if (!e || !p.vp.w) return;
    const at = barPlace(barAnchorFor(p.target, cam, size.current.h), size.current, p.vp, p.minTop, undefined, undefined, p.avoid);
    e.style.translate = `${Math.round(at.x)}px ${Math.round(at.y)}px`;
  };
  useEffect(() => {
    const l = (c: Camera) => put(c);
    place.listeners.add(l);
    return () => void place.listeners.delete(l);
  }, [place.listeners]);
  // which buttons fit, measured with every one in the row before anything is painted
  useLayoutEffect(() => {
    const e = el.current;
    const r = row.current;
    if (!measuring || !e || !r) return;
    const width = (k: string) => r.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`)?.offsetWidth ?? 0;
    const gap = parseFloat(getComputedStyle(r).columnGap) || 0;
    const chrome = e.offsetWidth - r.offsetWidth;
    const fit = foldBar(
      [{ key: ID, w: width(ID), rank: 0 }, ...items.map((i) => ({ key: i.key, w: width(i.key), rank: i.rank })), ...(more ? [{ key: DOTS, w: width(DOTS), rank: 0 }] : [])],
      place.vp.w - 2 * BAR_MARGIN - chrome,
      width(MORE),
      gap
    );
    setFold({ sig, folded: fit.folded });
  }, [sig, measuring]);
  // its size once drawn, and its place for it
  useLayoutEffect(() => {
    const e = el.current;
    if (!e || measuring) return;
    size.current = { w: e.offsetWidth, h: e.offsetHeight };
    put(place.cam.current);
  });
  useLayoutEffect(() => {
    if (el.current && motion() === "full") enter("menu", el.current);
  }, []);

  const button = (it: BarItem) => (
    <span key={it.key} className="ls-sb-i" data-k={it.key}>
      {it.sep && <span className="ls-sb-sep" aria-hidden="true" />}
      {it.element ?? (
        <button
          type="button"
          className={`ls-sb-btn ${it.tone ?? ""}`}
          data-act={it.key}
          disabled={it.disabled}
          title={it.title}
          aria-haspopup={it.menu ? "menu" : undefined}
          onClick={(e) => {
            const b = e.currentTarget;
            if (it.menu) ctx.openBelow(b, it.menu());
            else it.onPick?.(b);
          }}
        >
          {it.label}
          {it.menu && <span className="caret">▾</span>}
          {it.kbd && <kbd>{it.kbd}</kbd>}
        </button>
      )}
    </span>
  );
  const shown = items.filter((i) => !foldedSet.has(i.key));
  const rest = items.filter((i) => foldedSet.has(i.key));
  return (
    <div
      ref={el}
      className={`ls-selbar ${measuring ? "measuring" : ""}`}
      role="toolbar"
      aria-label={label}
      onKeyDown={(e) => {
        // a menu or popover opened from the bar takes Esc first (portals aren't inside it), and a peek has closed on it
        // already (its listener runs first); else Esc clears the selection
        if (e.key !== "Escape" || !el.current?.contains(e.target as Node) || !escapeClears({ selected: true, peek: false, overlay: !!document.querySelector(OVERLAYS) })) return;
        e.preventDefault();
        e.stopPropagation();
        place.onClear();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (menu) ctx.openAt({ x: e.clientX, y: e.clientY }, menu());
      }}
    >
      <div ref={row} className="ls-sb-row">
        <span className="ls-sb-id" data-k={ID}>
          {identity}
          <span className="ls-sb-sep" aria-hidden="true" />
        </span>
        {shown.map(button)}
        {measuring ? (
          <span className="ls-sb-i ls-sb-probe" data-k={MORE} aria-hidden="true">
            <span className="ls-sb-btn more">» 9 more</span>
          </span>
        ) : (
          rest.length > 0 && (
            <span className="ls-sb-i">
              <button
                type="button"
                className={`ls-sb-btn more ${place.extended ? "on" : ""}`}
                data-act="more-buttons"
                aria-expanded={place.extended}
                title={place.extended ? "Put the extra buttons away" : `${rest.map((i) => i.label).join(", ")}: on a second row`}
                onClick={() => place.onExtended(!place.extended)}
              >
                {place.extended ? "« Less" : `» ${rest.length} more`}
              </button>
            </span>
          )
        )}
        {more && (
          <span className="ls-sb-i" data-k={DOTS}>
            <button type="button" className="ls-sb-dots" data-act="more" aria-label={`${label}: every action`} aria-haspopup="menu" title="Every action — or right-click" onClick={(e) => ctx.openBelow(e.currentTarget, more())}>
              <MoreIcon />
            </button>
          </span>
        )}
      </div>
      {!measuring && place.extended && rest.length > 0 && <div className="ls-sb-row2">{rest.map(button)}</div>}
      {ctx.menu}
    </div>
  );
}

/**
 * An area's bar (Q): its colour (a press on it opens the area's Colour popover, `onColour`), short name and status,
 * its room tools when it's a room's, Ask for status, Tools ▾ and ⋯.
 */
export function AreaBar({
  group,
  name,
  title,
  accent,
  status,
  actions,
  roomId,
  members,
  onColour,
  place,
}: {
  group: string;
  name: string;
  title: string;
  accent: number;
  status: string;
  actions: readonly ModelAction[];
  roomId: string | null;
  members: ReactNode | null;
  onColour?: (dot: HTMLElement) => void;
  place: BarPlace;
}) {
  const u = useChatUnread()[roomId ?? ""];
  const chatCount = roomId && u?.unread ? (u.mentions ? `@${u.mentions}` : String(u.unread)) : null;
  return (
    <SelectionBar
      label={`${title}: actions`}
      idText={`${name} ${status}`}
      identity={
        <span className={`ls-sb-who a${accent}`} title={title}>
          <AccentDot className="ls-sb-dot" area={group} title={title} onColour={onColour} />
          <span className="ls-sb-name">{name}</span>
          {status && <span className="ls-sb-status">{status}</span>}
        </span>
      }
      items={areaBarItems(actions, { chatCount, members })}
      more={() => menuOf(actions)}
      place={place}
    />
  );
}

/** A workspace's bar (Q): its status and name, Focus, Δ Changes, ▶ Run, Files, Artifacts and ⋯. */
export function WorkspaceBar({ session, actions, runs, onFocus, place }: { session: SessionInfo; actions: readonly ModelAction[]; runs: number; onFocus: () => void; place: BarPlace }) {
  // its changes as its header's Δ chip counts them, read for the selected workspace only; a failed read says so
  const { git, gitErr } = usePaneGit(session, true);
  const changes = gitErr !== null ? { error: gitErr } : git?.dirty ? git.dirtyFiles : 0;
  return (
    <SelectionBar
      label={`${titleOf(session)}: actions`}
      idText={titleOf(session)}
      identity={
        <span className="ls-sb-who" title={titleOf(session)}>
          <StatusDot status={session.status} />
          <span className="ls-sb-name plain">{titleOf(session)}</span>
        </span>
      }
      items={workspaceBarItems(actions, { onFocus, changes, runs })}
      more={() => menuOf(actions)}
      place={place}
    />
  );
}

/** Several workspaces' bar (Q): how many, Make area… M, Stack ⌘G (coming), Move to area ▾ and Close…. */
export function SeveralBar({ count, items, menu, place }: { count: number; items: readonly BarItem[]; menu: () => MenuEntry[]; place: BarPlace }) {
  return (
    <SelectionBar
      label="Selected workspaces"
      idText={`${count} selected`}
      identity={
        <span className="ls-sb-who">
          <span className="ls-sb-name plain">{count} selected</span>
        </span>
      }
      items={items}
      more={null}
      menu={menu}
      place={place}
    />
  );
}
