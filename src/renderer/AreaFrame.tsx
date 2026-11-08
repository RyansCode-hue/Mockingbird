import type React from "react";
import type { ReactNode } from "react";
import type { AreaCounts, AreaView, Band } from "./landscapeModel";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { LockIcon } from "./Icons";
import type { ModelAction } from "./workspaceActions";
import { plural } from "../shared/format";

/**
 * One area on the landscape: its outline with the header bar along its top edge at 75% and up and in the
 * read-only band (design B), a solid patch with its name over it zoomed out to cards (C), and a pill once it's
 * collapsed (E). Its type keeps its size on screen at any zoom: the header and the name scale by the camera's
 * 1/zoom (--ls-hs, --ls-inv, set by Landscape.apply), so zoomed out the header grows up from the area's top edge
 * rather than over its workspaces. Hovered, its toolbar offers its model's Collapse, Lock and Tidy (`arrange`): over
 * the header's right end, or on the name's line zoomed out.
 */
export function AreaFrame({
  area,
  accent,
  band,
  title,
  header,
  ticketChip,
  shared,
  summary,
  counts,
  needs = 0,
  hot,
  selected = false,
  onSelect,
  menu,
  arrange,
  onCollapse,
  onGrab,
}: {
  area: AreaView;
  accent: number;
  band: Band;
  title: string;
  /** The header bar (GroupBar.tsx's AreaHeader), drawn in the live and read-only bands. */
  header: ReactNode;
  /** "#5101 · Local test", beside the name zoomed out. */
  ticketChip: string | null;
  /** "Shared room with Nick", for a room's area. */
  shared: string | null;
  summary: string;
  counts: AreaCounts;
  /** What needs you in it (S7: the Needs you tray's items here), the count its pill keeps. */
  needs?: number;
  /** A workspace dragged over it would move into it. */
  hot: boolean;
  /** It's the selection: the selection bar shows its actions (Landscape.tsx). */
  selected?: boolean;
  /** A right-click on it (its header, name or pill), or a click on its pill, selects it, as one on its patch does. */
  onSelect?: () => void;
  menu: () => MenuEntry[];
  /** Its hover toolbar: its actions' Collapse, Lock and Tidy rows (workspaceActions.tsx), a disabled one saying why. */
  arrange: ModelAction[];
  /** Its pill clicked: it opens again. */
  onCollapse: (collapsed: boolean) => void;
  /** A press on its bare header or name: moving the area starts. */
  onGrab: (e: React.PointerEvent) => void;
}) {
  const a = area.rect;
  const ctx = useContextMenu(title);
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.openAt({ x: e.clientX, y: e.clientY }, menu());
  };
  const cls = `a${accent}`;
  if (a.collapsed) {
    return (
      <>
        <button
          type="button"
          className={`ls-area-pill ${cls} ${selected ? "selected" : ""}`}
          data-area={area.key}
          style={{ left: a.x, top: a.y, ["--aw" as string]: a.w }}
          title={`${title}: collapsed — click to open it again`}
          onClick={() => {
            onSelect?.();
            onCollapse(false);
          }}
          onContextMenuCapture={onSelect}
          onContextMenu={openMenu}
        >
          <span className="n">{title}</span>
          <span className="c">{plural(counts.workspaces, "workspace")}</span>
          {needs > 0 && (
            <span className="w" title={`${needs} waiting on you: see Needs you`}>
              {needs}
            </span>
          )}
          {a.locked && <LockIcon />}
          <span className="go" aria-hidden="true">
            ▸
          </span>
        </button>
        {ctx.menu}
      </>
    );
  }
  const tools = (
    <div className="ls-area-tools" role="toolbar" aria-label={`${title}: arrange`}>
      {arrange.map((t) => (
        <button
          key={t.key}
          type="button"
          data-act={t.key}
          className={t.pressed ? "on" : ""}
          aria-pressed={t.pressed}
          disabled={t.disabled}
          title={t.kbd && !t.disabled ? `${t.title ?? t.menuLabel ?? t.label} (${t.kbd})` : (t.title ?? t.menuLabel)}
          onClick={() => t.onPick()}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
  return (
    <div
      className={`ls-area ${cls} ${hot ? "drop-on" : ""} ${a.locked ? "locked" : ""} ${selected ? "selected" : ""}`}
      data-area={area.key}
      style={{ left: a.x, top: a.y, width: a.w, height: a.h, ["--aw" as string]: a.w }}
      onContextMenuCapture={onSelect}
      onContextMenu={openMenu}
    >
      {band === "cards" ? (
        <div
          className="ls-area-title"
          onPointerDown={(e) => {
            if (e.button === 0 && !(e.target as Element).closest("button")) onGrab(e);
          }}
        >
          <span className="n">{title}</span>
          {a.locked && <LockIcon />}
          {ticketChip && <span className="chip-stage">{ticketChip}</span>}
          {(shared || summary) && <span className="s">{[shared, summary].filter(Boolean).join(" · ")}</span>}
          {tools}
        </div>
      ) : (
        <div className="ls-area-head">
          {header}
          {tools}
        </div>
      )}
      {!counts.workspaces && !counts.closed && <div className="ls-area-empty">No workspaces here yet. Drag one in, or remove the area from its ⋯ menu.</div>}
      {ctx.menu}
    </div>
  );
}
