import type React from "react";
import type { ReactNode } from "react";
import type { AreaCounts, AreaView, Band } from "./landscapeModel";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { LockIcon } from "./Icons";
import { plural } from "../shared/format";

/**
 * One area on the landscape: its outline with the header bar along its top edge at 75% and up and in the
 * read-only band (design B), a solid patch with its name over it zoomed out to cards (C), and a pill once it's
 * collapsed (E). Its type keeps its size on screen at any zoom: the header and the name scale by the camera's
 * 1/zoom (--ls-hs, --ls-inv, set by Landscape.apply), so zoomed out the header grows up from the area's top edge
 * rather than over its workspaces. Hovered, its toolbar offers Tidy (coming), Collapse and Lock: over the header's
 * right end, or on the name's line zoomed out.
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
  hot,
  selected = false,
  onSelect,
  menu,
  onCollapse,
  onLock,
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
  /** A workspace dragged over it would move into it. */
  hot: boolean;
  /** It's the selection: the selection bar shows its actions (Landscape.tsx). */
  selected?: boolean;
  /** A right-click on it (its header, name or pill) selects it, as one on its patch does. */
  onSelect?: () => void;
  menu: () => MenuEntry[];
  onCollapse: (collapsed: boolean) => void;
  onLock: (locked: boolean) => void;
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
          onClick={() => onCollapse(false)}
          onContextMenuCapture={onSelect}
          onContextMenu={openMenu}
        >
          <span className="n">{title}</span>
          <span className="c">{plural(counts.workspaces, "workspace")}</span>
          {counts.waiting > 0 && (
            <span className="w" title={`${counts.waiting} waiting on you`}>
              {counts.waiting}
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
      <button type="button" disabled title="Tidy lays the area out along its wires: coming in a later version">
        Tidy
      </button>
      <button type="button" onClick={() => onCollapse(true)} title="Collapse to a pill that keeps its counts">
        Collapse
      </button>
      <button type="button" className={a.locked ? "on" : ""} aria-pressed={!!a.locked} onClick={() => onLock(!a.locked)} title={a.locked ? "Unlock: workspaces can be moved in, out and around it again" : "Lock its layout: nothing moves in, out or around it"}>
        {a.locked ? "Locked" : "Lock"}
      </button>
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
      {!counts.workspaces && <div className="ls-area-empty">No workspaces here yet. Drag one in, or remove the area from its ⋯ menu.</div>}
      {ctx.menu}
    </div>
  );
}
