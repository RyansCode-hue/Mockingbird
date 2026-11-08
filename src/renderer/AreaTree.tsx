import React, { useMemo, useRef } from "react";
import type { SessionInfo, SessionStatus } from "../shared/types";
import { LOOSE_GROUP, areaKeyOf, stackKeyOf } from "../shared/landscape";
import { splitGroupKey } from "../shared/types";
import { plural } from "../shared/format";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { ChevronIcon } from "./Icons";
import { StatusDot } from "./StatusDot";
import { titleOf } from "./appModel";
import { usePersisted } from "./prefs";
import { initialsOf } from "./Team";
import type { AreaCounts } from "./landscapeModel";

/** One row under an area in the tree: a workspace, or a stack (a sub-group) with its tabs. */
export type TreeItem = { kind: "ws"; key: string; s: SessionInfo } | { kind: "stack"; key: string; name: string; members: SessionInfo[] };

/** The sessions shown, by area then by workspace, as the landscape holds them: areas in `order`, then any other, loose last. */
export function treeOf(sessions: readonly SessionInfo[], order: readonly string[]): { key: string; items: TreeItem[] }[] {
  const byArea = new Map<string, TreeItem[]>();
  for (const k of order) if (k !== LOOSE_GROUP) byArea.set(k, []);
  const stacks = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const area = areaKeyOf(s);
    if (!byArea.has(area)) byArea.set(area, []);
    const stack = stackKeyOf(s);
    if (!stack) {
      byArea.get(area)!.push({ kind: "ws", key: s.id, s });
      continue;
    }
    const members = stacks.get(stack);
    if (members) members.push(s);
    else {
      const list = [s];
      stacks.set(stack, list);
      byArea.get(area)!.push({ kind: "stack", key: `ws:${stack}`, name: splitGroupKey(stack).sub ?? stack, members: list });
    }
  }
  const loose = byArea.get(LOOSE_GROUP);
  byArea.delete(LOOSE_GROUP);
  return [...[...byArea].map(([key, items]) => ({ key, items })), ...(loose ? [{ key: LOOSE_GROUP, items: loose }] : [])];
}

/** What an area's tree rows are doing, as areaCounts counts its workspaces: a stack once, statuses of this Mac's sessions only. */
export function treeCounts(items: readonly TreeItem[]): AreaCounts {
  const c: AreaCounts = { working: 0, waiting: 0, idle: 0, dead: 0, workspaces: items.length, closed: 0 };
  for (const it of items) for (const s of it.kind === "ws" ? [it.s] : it.members) if (!s.room?.remote) c[s.status]++;
  return c;
}

const WORST: SessionStatus[] = ["waiting", "working", "idle", "dead"];
/** The status a stack's row shows: its most pressing member's. */
const stackStatus = (members: readonly SessionInfo[]): SessionStatus => WORST.find((st) => members.some((s) => s.status === st)) ?? "idle";

export interface TreeArea {
  key: string;
  title: string;
  accent: number | null;
  collapsed: boolean;
  /** A room's area: its online teammates, whose initials the row shows. */
  online: { id: string; name: string }[] | null;
  counts: AreaCounts;
  items: TreeItem[];
}

/**
 * The area tree (designs L and M): the Sessions view while the landscape shows. Each area with its waiting count
 * (or how many workspaces it has), a room's with who's online, and its workspaces and stacks under it; the filter
 * finds a workspace. A press on an area flies there, on a workspace selects it and flies to it (its row and its
 * workspace are one selection, so ↑↓ move both), a double-click or Enter focuses it, and right-click is its menu.
 */
export function AreaTree({
  areas,
  filter,
  onFilter,
  selected,
  onArea,
  onPick,
  onFocus,
  onHide,
  menuFor,
  areaMenu,
  footer,
}: {
  areas: TreeArea[];
  filter: string;
  onFilter: (q: string) => void;
  /** The selected session. */
  selected: string | null;
  onArea: (key: string) => void;
  onPick: (s: SessionInfo) => void;
  onFocus: (s: SessionInfo) => void;
  /** Collapse the tree to the rail (⌘\). */
  onHide: () => void;
  /** A workspace row's right-click: its workspace's actions (its ⋯'s). */
  menuFor: (s: SessionInfo) => MenuEntry[];
  areaMenu: (key: string) => MenuEntry[] | null;
  /** Under the tree: Previous and the Connected line. */
  footer: React.ReactNode;
}) {
  const [closed, setClosed] = usePersisted<string[]>("mb.areaTree.closed", [LOOSE_GROUP]);
  const [openStacks, setOpenStacks] = usePersisted<string[]>("mb.areaTree.stacks", []);
  const menu = useContextMenu("Area tree");
  const list = useRef<HTMLDivElement>(null);
  const filtering = !!filter.trim();
  const open = (key: string) => filtering || !closed.includes(key);
  const toggle = (key: string) => setClosed((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  // the rows the keyboard walks, top to bottom: every workspace row on screen
  const rows = useMemo(
    () =>
      areas.flatMap((a) =>
        open(a.key) ? a.items.flatMap((it) => (it.kind === "ws" ? [it.s] : [it.members[0], ...(openStacks.includes(it.key) ? it.members.slice(1) : [])])) : []
      ),
    [areas, closed, openStacks, filtering]
  );
  const onKey = (e: React.KeyboardEvent, s: SessionInfo) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onFocus(s);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.id === s.id);
      const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      onPick(next);
      requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-sid="${CSS.escape(next.id)}"]`)?.focus());
    }
  };
  // one line per workspace (design L): who's in it, its backup and what a teammate sent are on its header and its ⋯
  const wsRow = (s: SessionInfo, depth: 1 | 2, extra?: React.ReactNode, key = s.id) => {
    return (
      <div
        key={key}
        data-sid={s.id}
        className={`lt-row lt-ws d${depth} ${selected === s.id ? "on" : ""} ${s.status === "waiting" ? "waiting" : ""} ${s.room?.remote ? "remote" : ""}`}
        tabIndex={0}
        title={`${s.cwd} — click to go there, double-click or Enter to focus it, right-click for more`}
        onClick={() => onPick(s)}
        onDoubleClick={() => onFocus(s)}
        onKeyDown={(e) => e.target === e.currentTarget && onKey(e, s)}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.openAt({ x: e.clientX, y: e.clientY }, menuFor(s));
        }}
      >
        <span className="lt-line">
          <StatusDot status={s.status} className="sm" />
          <span className="lt-t">{titleOf(s)}</span>
          {extra ?? (s.status === "dead" ? <span className="lt-tag bad">exited</span> : s.shell ? <span className="lt-tag">terminal</span> : selected === s.id ? <span className="lt-tag" aria-hidden="true">↗</span> : null)}
        </span>
      </div>
    );
  };
  return (
    <div className="area-tree">
      <div className="lt-find">
        <input className="filter" placeholder="Find a workspace" aria-label="Find a workspace" value={filter} onChange={(e) => onFilter(e.target.value)} />
        <button type="button" className="lt-hide" aria-label="Hide the area tree" title="Hide the area tree (⌘\\)" onClick={onHide}>
          ⇤
        </button>
      </div>
      <div className="scroll lt-list" ref={list}>
        <div className="lt-h">Areas</div>
        {areas.map((a) => {
          const isOpen = open(a.key);
          const loose = a.key === LOOSE_GROUP;
          if (filtering && !a.items.length) return null;
          return (
            <div key={a.key} className="lt-area" data-area={a.key}>
              <div
                className={`lt-row lt-head ${loose ? "loose" : ""}`}
                title={loose ? "Workspaces in no area" : `Go to ${a.title}${a.collapsed ? " (collapsed)" : ""}`}
                onClick={() => (loose ? toggle(a.key) : onArea(a.key))}
                onContextMenu={(e) => {
                  const items = areaMenu(a.key);
                  if (!items) return;
                  e.preventDefault();
                  menu.openAt({ x: e.clientX, y: e.clientY }, items);
                }}
              >
                <button
                  type="button"
                  className="lt-chev"
                  aria-label={isOpen ? `Hide ${a.title}'s workspaces` : `Show ${a.title}'s workspaces`}
                  aria-expanded={isOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(a.key);
                  }}
                >
                  <ChevronIcon open={isOpen} />
                </button>
                <span className={`lt-sq ${a.accent === null ? "none" : `a${a.accent}`}`} />
                <span className="lt-t">{a.title}</span>
                {a.online?.map((m) => (
                  <span key={m.id} className="lt-av" title={`${m.name} is online`}>
                    {initialsOf(m.name).slice(0, 1)}
                  </span>
                ))}
                {a.counts.waiting > 0 ? (
                  <span className="lt-badge" title={`${a.counts.waiting} waiting on you`}>
                    {a.counts.waiting}
                  </span>
                ) : (
                  <span className="lt-n" title={plural(a.counts.workspaces, "workspace")}>
                    {a.counts.workspaces}
                  </span>
                )}
              </div>
              {isOpen &&
                a.items.map((it) => {
                  if (it.kind === "ws") return wsRow(it.s, 1);
                  const stOpen = openStacks.includes(it.key);
                  const waiting = it.members.filter((s) => s.status === "waiting").length;
                  const front = it.members[0];
                  return (
                    <React.Fragment key={it.key}>
                      <div
                        data-sid={front.id}
                        data-ws={it.key}
                        className={`lt-row lt-ws lt-stack d1 ${it.members.some((s) => s.id === selected) ? "on" : ""}`}
                        tabIndex={0}
                        title={`${it.members.map(titleOf).join("\n")}\n— click to go there, double-click or Enter to focus it`}
                        onClick={() => onPick(it.members.find((s) => s.id === selected) ?? front)}
                        onDoubleClick={() => onFocus(it.members.find((s) => s.id === selected) ?? front)}
                        onKeyDown={(e) => e.target === e.currentTarget && onKey(e, front)}
                      >
                        <span className="lt-line">
                          <button
                            type="button"
                            className="lt-chev sm"
                            aria-label={stOpen ? `Hide ${it.name}'s tabs` : `Show ${it.name}'s tabs`}
                            aria-expanded={stOpen}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenStacks((o) => (o.includes(it.key) ? o.filter((k) => k !== it.key) : [...o, it.key]));
                            }}
                          >
                            <ChevronIcon open={stOpen} />
                          </button>
                          <StatusDot status={stackStatus(it.members)} className="sm" />
                          <span className="lt-t">{it.name}</span>
                          <span className="lt-tag">stack · {it.members.length}</span>
                          {waiting > 0 && <span className="lt-badge">{waiting}</span>}
                        </span>
                      </div>
                      {stOpen && it.members.map((s) => wsRow(s, 2, undefined, `${it.key}:${s.id}`))}
                    </React.Fragment>
                  );
                })}
            </div>
          );
        })}
        {filtering && !areas.some((a) => a.items.length) && <div className="lt-none">No workspace matches “{filter.trim()}”</div>}
      </div>
      {footer}
      {menu.menu}
    </div>
  );
}

/**
 * The area switcher (designs M and C): the areas as a row of buttons over the landscape's top-left while the area
 * tree isn't on screen, each with its waiting count; the one the view is in is lit. `onShowTree` (⇥ Areas) brings
 * the tree back.
 */
export function AreaSwitcher({
  areas,
  current,
  onArea,
  onShowTree,
}: {
  /** The areas in the landscape's order, then LOOSE_GROUP (accent null) while any workspace is in none. */
  areas: { key: string; name: string; title: string; accent: number | null; waiting: number }[];
  current: string | null;
  onArea: (key: string) => void;
  onShowTree: () => void;
}) {
  if (!areas.length) return null;
  return (
    <div className="ls-switcher" role="toolbar" aria-label="Areas">
      <button type="button" className="ls-sw-tree" title="Show the area tree (⌘\\)" onClick={onShowTree}>
        ⇥ Areas
      </button>
      <span className="ls-sw-bar">
        {areas.map((a) => (
          <button key={a.key} type="button" data-area={a.key} className={`ls-sw ${a.accent === null ? "loose" : `a${a.accent}`} ${current === a.key ? "on" : ""}`} title={`Go to ${a.title}`} onClick={() => onArea(a.key)}>
            {a.name}
            {a.waiting > 0 && <span className="w">{a.waiting}</span>}
          </button>
        ))}
      </span>
    </div>
  );
}
