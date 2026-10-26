import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { Select } from "../Menu";
import { KanbanIcon, LinkIcon, ReadIcon, RunIcon } from "../Icons";
import { tidyMenu, useContextMenu, type MenuEntry } from "../ContextMenu";
import { TicketStartPopover } from "./TicketStart";
import { useAction } from "../useAction";
import { useEscape } from "../useEscape";
import { usePersisted } from "../prefs";
import { useFlip, usePresenceRefs } from "../motion";
import { beginDrag, cue, dragging, overTarget, useDrag, type DropTarget } from "../drag";
import { ago, plural } from "../../shared/format";
import { isErr, type SessionInfo } from "../../shared/types";
import {
  branchFor,
  BUILDER_STATUSES,
  historyWhat,
  HOUSE_EVENT_KINDS,
  HOUSE_PRIORITIES,
  isOpenStatus,
  NEEDS_AGENT,
  NEEDS_HUMAN,
  needsAgent,
  ownerChip,
  statusLabel,
  type BuilderStatus,
  type HouseEventKind,
  type HouseRow,
  type HouseConsentAsk,
  type HouseTicket,
  type HouseTicketView,
  type HouseView,
  type HouseWrite,
} from "../../shared/team/house";
import type { ClaimWarningNotice } from "../../shared/team/claims";
import { MigrationsLine } from "./Migrations";
import {
  boardMove,
  CLOSE_REFUSAL,
  columnLayout,
  DEFAULT_FOLDS,
  groupRows,
  landingGap,
  moveCard,
  moveLabel,
  moveWrite,
  placeName,
  placeOf,
  shownStatus,
  stepPlace,
  type HouseFolds,
  type HousePlace,
  type PendingMove,
} from "./houseColumns";

/**
 * A shared room's Radley House board (docs/team-rooms.md, "Radley House
 * board"): the House's open backlog and the room's own tickets as columns by
 * status, with a "Needs an agent" filter — who has each — and a ticket's
 * detail and history with its actions. The House is the system of record;
 * everything here is read and written by the main process with this member's
 * own builder token.
 */

type Err = { error: string };

/** A room's board, kept current while the dialog is open (an open board keeps the House read). */
function useHouseView(roomId: string): HouseView | Err | null {
  const [view, setView] = useState<HouseView | Err | null>(null);
  useEffect(() => {
    let alive = true;
    window.mb.houseWatch(roomId, true).then((v: HouseView | Err) => {
      if (!alive) return;
      if (isErr(v)) console.error(`[mockingbird] couldn't read room ${roomId}'s House board:`, v.error);
      setView(v);
    });
    const off = window.mb.onHouseChanged((v: HouseView) => {
      if (v?.roomId === roomId) setView(v);
    });
    return () => {
      alive = false;
      off();
      void window.mb.houseWatch(roomId, false);
    };
  }, [roomId]);
  return view;
}

const KIND_LABEL: Record<HouseEventKind, string> = { note: "Comment", progress: "Progress", status: "Status change", question: "Question for a person" };

/** Choosing the project the room works in: its admin's call; everyone else sees who makes it. */
function ProjectLine({ view, act, onCancel }: { view: HouseView; act: (what: string, w: HouseWrite) => Promise<unknown>; onCancel?: () => void }) {
  const [name, setName] = useState(view.project ?? "");
  if (!view.isAdmin) {
    return <div className="house-note warn">The room's admin{view.admin ? ` (${view.admin})` : ""} hasn't connected a Radley House project yet. Once they do, the board shows the House's open backlog and the tickets the room adds.</div>;
  }
  const connect = () => {
    if (name.trim() && name.trim() !== view.project) void act("project", { kind: "project", project: name.trim() }).then((r) => !isErr(r as Err) && onCancel?.());
  };
  return (
    <div className="house-note">
      <span>
        Which House project does this room work in? Type the name of your env file without <code>.env</code> — for <code>~/.config/radley-house/atticus-backoffice.env</code>, type <code>atticus-backoffice</code>. Not the project ID or your token: each member's Mockingbird reads those from their own file of that name.
      </span>
      <div className="house-inline">
        <input type="text" autoFocus value={name} placeholder="e.g. atticus-backoffice" aria-label="Env file name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()} />
        <button className="primary" disabled={!name.trim() || name.trim() === view.project} onClick={connect}>
          Connect
        </button>
        {onCancel && (
          <button className="outline" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** "Use your <project> builder token for room <room>?": nothing here reads the House for the room until this member allows it. */
function ConsentNote({ view, onAnswer }: { view: HouseView; onAnswer: (allow: boolean) => void }) {
  if (view.connection.state !== "consent" || !view.project) return null;
  const declined = view.connection.declined;
  return (
    <div className="house-note house-consent">
      <b>Connect your {view.project} token</b>
      <span>
        {view.isAdmin ? "This room works in" : `${view.admin ?? "The room's admin"} connected this room to`} Radley House project <code>{view.project}</code>. Use your {view.project} builder token (from <code>{view.envFile}</code>) for this room? Mockingbird then reads and writes the House for this room as you — from this board, and from your agents once you approve each write in their pane.
        {declined ? " You chose Not now: nothing on this Mac uses your token for this room." : " Until you allow it, nothing on this Mac reads your token or calls the House for this room."}
      </span>
      <div className="house-inline">
        <button className="primary" onClick={() => onAnswer(true)}>
          Allow
        </button>
        {!declined && (
          <button className="outline" onClick={() => onAnswer(false)}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}

/** How this Mac reaches the House, when it doesn't. */
function ConnectionNote({ view }: { view: HouseView }) {
  const c = view.connection;
  if (c.state === "missing" || c.state === "bad") {
    return (
      <div className="house-note warn">
        <b>{c.state === "missing" ? "No House token on this Mac." : "Your House env file needs fixing."}</b> {c.message} Until then the board stays empty here, and your agents can't use the House.
      </div>
    );
  }
  if (c.state === "error") return <div className="house-note bad">The House couldn't be read: {c.message}</div>;
  return null;
}

/** "+ Add ticket": put an existing ticket on the board by number, or create one in the House. */
function AddTicket({ act, onDone }: { act: (what: string, w: HouseWrite) => Promise<unknown>; onDone: () => void }) {
  const [mode, setMode] = useState<"track" | "create">("track");
  const [n, setN] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const num = Number(n.trim().replace(/^#/, ""));
  const ok = (r: unknown) => !isErr(r as Err) && onDone();
  return (
    <div className="house-add">
      <div className="house-tabs">
        <button className={mode === "track" ? "on" : ""} onClick={() => setMode("track")}>
          Existing ticket
        </button>
        <button className={mode === "create" ? "on" : ""} onClick={() => setMode("create")}>
          New ticket
        </button>
      </div>
      {mode === "track" ? (
        <div className="house-inline">
          <input type="text" autoFocus value={n} placeholder="e.g. #143" onChange={(e) => setN(e.target.value)} onKeyDown={(e) => e.key === "Enter" && num > 0 && void act("add", { kind: "track", n: num }).then(ok)} />
          <button className="primary" disabled={!(Number.isSafeInteger(num) && num > 0)} onClick={() => void act("add", { kind: "track", n: num }).then(ok)}>
            Add to the board
          </button>
          <button className="outline" onClick={onDone}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <label>Title — the outcome</label>
          <input type="text" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Donor export skips archived donors" />
          <label>Description — context and approach</label>
          <textarea className="house-ta" value={description} onChange={(e) => setDescription(e.target.value)} />
          <label>Acceptance — the observable finish line</label>
          <textarea className="house-ta short" value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
          <div className="row">
            <span className="foot-hint house-dim">Created in the House with your token (it starts parked), and added to the room's board.</span>
            <button className="outline" onClick={onDone}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!title.trim() || !description.trim()}
              data-tip={!title.trim() ? "Give it a title first" : !description.trim() ? "Add a description first" : undefined}
              onClick={() => void act("create", { kind: "create", title: title.trim(), description, acceptance }).then(ok)}>
              Create ticket
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Choose the branch a claim goes on: this Mac's room sessions' branches, or feature/<n>-<slug>. */
function ClaimForm({ n, title, branches, busy, onClaim, onCancel }: { n: number; title: string; branches: string[]; busy: boolean; onClaim: (branch: string) => void; onCancel: () => void }) {
  const [branch, setBranch] = useState(branches.find((b) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(b)) ?? branchFor(n, title));
  const list = `house-branches-${n}`;
  useEscape(onCancel);
  return (
    <div className="house-inline house-claim" onClick={(e) => e.stopPropagation()}>
      <span className="house-dim">on branch</span>
      <input type="text" autoFocus list={list} value={branch} onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && branch.trim() && onClaim(branch.trim())} />
      <datalist id={list}>
        {branches.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <button className="primary" disabled={busy || !branch.trim()} onClick={() => onClaim(branch.trim())}>
        Claim
      </button>
      <button className="outline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** A priority as the House names it, coloured when it's one the board knows. */
function Priority({ p }: { p: string | null }) {
  const known = !!p && (HOUSE_PRIORITIES as readonly string[]).includes(p);
  return <span className={`house-pri ${known ? `p-${p}` : ""}`}>{p ?? ""}</span>;
}

/** A card's handoff tags, and that the room added it. */
function Marks({ t, addedBy }: { t: HouseTicket; addedBy?: string }) {
  const human = t.tags.includes(NEEDS_HUMAN);
  const agent = t.tags.includes(NEEDS_AGENT);
  if (!human && !agent && !addedBy) return null;
  return (
    <div className="house-card-marks">
      {human && (
        <span className="house-mark human" title="An agent is blocked on a question for a person">
          {NEEDS_HUMAN}
        </span>
      )}
      {agent && (
        <span className="house-mark agent" title="Handed back to an agent">
          {NEEDS_AGENT}
        </span>
      )}
      {addedBy && (
        <span className="house-mark added" title={`${addedBy} added it to the room's tickets: it stays on the board once it's done or dropped`}>
          added
        </span>
      )}
    </div>
  );
}

/** What holds a ticket up — the tickets it's blocked by, whom it waits on — each as the Dashboard marks blocked work. */
function holdsOf(t: HouseTicket): { text: string; tip: string }[] {
  const out: { text: string; tip: string }[] = [];
  if (t.blockedBy.length) {
    const all = t.blockedBy.map((b) => `#${b}`).join(", ");
    out.push({ text: `Blocked by ${t.blockedBy.length > 2 ? `#${t.blockedBy[0]} +${t.blockedBy.length - 1}` : all}`, tip: `Blocked by ${all}` });
  }
  if (t.waiting) out.push({ text: t.waiting.on ? `Waiting on ${t.waiting.on}` : "Waiting", tip: t.waiting.on ? `Waiting on ${t.waiting.on}` : "Waiting" });
  return out;
}

const DRAG_TYPE = "text/mb-house";

/** Why a ticket can't get a session from here (someone else has it, or it's closed); null when it can. */
export function cantStart(t: Pick<HouseTicket, "n" | "status">, owner: HouseRow["owner"]): string | null {
  if (!isOpenStatus(t.status)) return `#${t.n} is ${statusLabel(t.status)}`;
  if (owner && !owner.self) return `${owner.name} has #${t.n}`;
  return null;
}

/** A ticket's right-click menu: start a session on it, open it, open it in the House. */
function ticketMenu(o: { n: number; why: string | null; readOnly: boolean; onStart: () => void; onOpen: () => void; onOpenHouse: () => void }): MenuEntry[] {
  return tidyMenu([
    { key: "start", label: "Start session", menuLabel: "Start session…", icon: <RunIcon />, title: o.why ?? (o.readOnly ? "The House isn't connected here" : `Claim #${o.n}, make its worktree and start an agent on it`), disabled: !!o.why || o.readOnly, onPick: o.onStart },
    "-",
    { key: "open", label: "Open", menuLabel: "Open the ticket", icon: <ReadIcon />, onPick: o.onOpen },
    { key: "house", label: "House", menuLabel: "Open in the House ↗", icon: <LinkIcon />, onPick: o.onOpenHouse },
  ]);
}

/** One ticket on the board: what the list showed, a card to open or drag. */
function Card({
  row,
  status,
  lifted,
  gap,
  asking,
  saving,
  readOnly,
  branches,
  onOpen,
  onKeyDown,
  onClaim,
  onCancelClaim,
  onStart,
  onOpenHouse,
}: {
  row: HouseRow;
  status: string;
  lifted: boolean;
  gap: "above" | "below" | undefined;
  asking: boolean;
  saving: boolean;
  readOnly: boolean;
  branches: string[];
  onOpen: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onClaim: (branch: string) => void;
  onCancelClaim: () => void;
  /** Start session on it, the confirmation placed by `at`. */
  onStart: (at: HTMLElement) => void;
  onOpenHouse: () => void;
}) {
  const t = row.ticket!;
  const holds = holdsOf(t);
  const mine = !!row.owner?.self;
  const who = row.owner ? (row.owner.self ? "You" : row.owner.name) : isOpenStatus(status) ? "unclaimed" : "";
  const branch = t.claim?.branch;
  const el = useRef<HTMLDivElement>(null);
  const menu = useContextMenu(`#${row.n}`);
  const why = cantStart({ n: row.n, status }, row.owner);
  const startable = !why && !readOnly && !asking && !saving;
  return (
    <div
      ref={el}
      data-id={row.n}
      className={`bcard house-card ${holds.length ? "blocked" : ""} ${mine ? "mine" : ""} ${lifted ? "lifted" : ""}`}
      data-gap={gap}
      draggable={!readOnly && !asking && !saving}
      tabIndex={0}
      aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowLeft Alt+ArrowRight"}
      title={readOnly ? undefined : `${row.problem ? `${row.problem} · ` : ""}drag to another column to change its status in the House · ⌥← ⌥→ move it · right-click for more`}
      onDragStart={(e) => beginDrag(e, DRAG_TYPE, String(row.n), `Moving #${row.n} — drop it on another column`)}
      onClick={asking ? undefined : onOpen}
      onKeyDown={onKeyDown}
      {...menu.bind(() => ticketMenu({ n: row.n, why, readOnly: readOnly || asking || saving, onStart: () => el.current && onStart(el.current), onOpen, onOpenHouse }))}
    >
      {mine && <span className="tbar" />}
      <div className="bc-top">
        <span className="wi-id">#{row.n}</span>
        <Priority p={t.priority} />
        {saving && <span className="bc-age">saving…</span>}
        {startable && (
          <button
            className="house-start"
            title={`Start session: ${mine ? "" : `claim #${row.n}, `}make its worktree and start an agent on it`}
            onClick={(e) => {
              e.stopPropagation();
              onStart(e.currentTarget);
            }}
          >
            <RunIcon /> Start
          </button>
        )}
      </div>
      <div className="bc-title">{t.title}</div>
      {holds.length > 0 && (
        <div className="house-card-holds">
          {holds.map((h) => (
            <span key={h.text} className="chip blocked" title={h.tip}>
              {h.text}
            </span>
          ))}
        </div>
      )}
      <Marks t={t} addedBy={row.addedBy} />
      <div className="bc-foot">
        <span className={`house-who ${row.owner ? "" : "house-dim"}`}>{who}</span>
        {branch && (
          <span className="house-branch" title={`on ${branch}`}>
            {branch}
          </span>
        )}
      </div>
      {asking && <ClaimForm n={row.n} title={t.title} branches={branches} busy={saving} onClaim={onClaim} onCancel={onCancelClaim} />}
      {menu.menu}
    </div>
  );
}

/**
 * The board's tickets as columns by House status, Parked folded into a row
 * above them, Done folded and Dropped hidden until asked for. Dragging a card
 * to another column (or ⌥← ⌥→) writes the move to the House with this
 * member's token, from this drag only (houseColumns.ts).
 */
function Columns({ roomId, view, onOpen, onStart, onOpenHouse }: { roomId: string; view: HouseView; onOpen: (n: number) => void; onStart: (n: number, at: HTMLElement) => void; onOpenHouse: (n: number) => void }) {
  const [agentOnly, setAgentOnly] = useState(false);
  const [folds, setFolds] = usePersisted<HouseFolds>("mb.house.folds", DEFAULT_FOLDS);
  const [otherOpen, setOtherOpen] = useState(true);
  const [moves, setMoves] = useState<Record<number, PendingMove>>({});
  const [savingNs, setSavingNs] = useState<number[]>([]);
  const saving = useRef(new Set<number>());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const drag = useDrag();
  const readOnly = view.connection.state !== "ok";

  const order = (view.open ?? []).map((r) => r.n);
  const all = [...(view.open ?? []), ...view.added];
  const latest = useRef(all);
  latest.current = all;
  const forAgents = all.filter((r) => needsAgent(r.ticket));
  const rows = agentOnly ? forAgents : all;
  const g = groupRows(rows, order, moves);
  const cols = columnLayout(g, folds);
  const placeOfRow = (r: HouseRow) => placeOf(shownStatus(r, moves) ?? "other");

  // a written move shows until the board's next read has it; a read that already has it ends it at once
  useEffect(() => {
    setMoves((m) => {
      const next = { ...m };
      for (const [k, mv] of Object.entries(m)) {
        const r = all.find((x) => x.n === Number(k));
        if (mv.landed || (!mv.asking && r?.ticket?.status === mv.status)) delete next[Number(k)];
      }
      return next;
    });
  }, [view]);

  const show = (n: number, status: string | null) =>
    setMoves((m) => {
      const next = { ...m };
      if (status === null) delete next[n];
      else next[n] = { status };
      return next;
    });
  const commit = async (row: HouseRow, from: HousePlace, to: HousePlace, w: HouseWrite) => {
    if (saving.current.has(row.n)) return setNotice(`#${row.n} is still being saved — move it again once it has landed`);
    saving.current.add(row.n);
    setSavingNs([...saving.current]);
    setError("");
    setNotice("");
    const r = await moveCard(row, from, to, w, (x) => window.mb.houseWrite(roomId, x), show);
    saving.current.delete(row.n);
    setSavingNs([...saving.current]);
    // a card moved from the keyboard is followed until its move has landed, or gone back
    setTimeout(() => refocus.current === row.n && (refocus.current = null), 0);
    if ("error" in r) return setError(r.error);
    setMoves((m) => {
      if (!m[row.n]) return m;
      const next = { ...m };
      if (latest.current.find((x) => x.n === row.n)?.ticket?.status === to) delete next[row.n];
      else next[row.n] = { status: to, landed: true };
      return next;
    });
  };
  /** Move a card, from a drop or a keypress: a claim asks for its branch first, on the card. */
  const move = (row: HouseRow, to: HousePlace) => {
    const from = placeOfRow(row);
    const mv = boardMove(row, from, to);
    if (!mv) return;
    if ("refused" in mv) {
      setError("");
      return setNotice(`#${row.n} stays in ${placeName(from)}: ${mv.refused}.`);
    }
    if (mv.kind === "claim") {
      setNotice("");
      return setMoves((m) => ({ ...m, [row.n]: { status: to, asking: { from } } }));
    }
    void commit(row, from, to, moveWrite(row, mv, from));
  };

  const dragged = (): HouseRow | undefined => {
    const p = dragging(DRAG_TYPE);
    return p ? all.find((r) => String(r.n) === p && r.ticket) : undefined;
  };
  /** What dropping the dragged card on `place` would do: where it lands (the House's order puts it), or why it can't. */
  const target = (place: HousePlace, column: HouseRow[]): DropTarget | null => {
    const row = dragged();
    if (!row) return null;
    const mv = boardMove(row, placeOfRow(row), place);
    if (!mv) return null;
    const key = `h:${place}`;
    if ("refused" in mv) return { key, outcome: mv.refused, refused: true };
    if (saving.current.has(row.n) || moves[row.n]?.asking) return { key, outcome: `#${row.n} is still being saved`, refused: true };
    return { key, outcome: moveLabel(row, mv, place), ...(place === "parked" ? {} : { gap: landingGap(column, row, order) }) };
  };
  const dropOn = (e: React.DragEvent, place: HousePlace, column: HouseRow[]) => {
    e.preventDefault();
    const row = dragged();
    if (row && target(place, column) && !target(place, column)!.refused) move(row, place);
  };
  const dropProps = (place: HousePlace, column: HouseRow[]) =>
    readOnly
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => overTarget(e, target(place, column)),
          onDrop: (e: React.DragEvent) => dropOn(e, place, column),
        };

  // a card moved from the keyboard keeps the focus: React re-inserting it in its new column drops it
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const n = refocus.current;
    if (n === null) return;
    const active = document.activeElement;
    const el = document.querySelector<HTMLElement>(`.house-card[data-id="${n}"]`);
    if (el && active !== el && (!active || active === document.body || !active.isConnected)) el.focus();
    else if (active !== el) refocus.current = null;
  }, [moves, view]);

  const lifted = drag?.type === DRAG_TYPE ? drag.payload : null;
  const card = (r: HouseRow, place: HousePlace, gapHere: number | undefined, idx: number) => (
    <Card
      key={r.n}
      row={r}
      status={shownStatus(r, moves) ?? ""}
      lifted={lifted === String(r.n)}
      gap={gapHere === idx ? "above" : gapHere === idx + 1 ? "below" : undefined}
      asking={!!moves[r.n]?.asking}
      saving={savingNs.includes(r.n)}
      readOnly={readOnly}
      branches={view.branches}
      onOpen={() => onOpen(r.n)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (!readOnly && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          const to = stepPlace(place, e.key === "ArrowLeft" ? -1 : 1);
          if (!to) return;
          refocus.current = r.n;
          move(r, to);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(r.n);
        }
      }}
      onClaim={(branch) => {
        const from = moves[r.n]?.asking?.from ?? placeOfRow(r);
        void commit(r, from, "in_progress", { kind: "claim", n: r.n, branch });
      }}
      onCancelClaim={() => show(r.n, null)}
      onStart={(at) => onStart(r.n, at)}
      onOpenHouse={() => onOpenHouse(r.n)}
    />
  );

  const fold = (place: "parked" | "other", open: boolean, toggle: () => void) => {
    const list = g[place];
    const refused = place === "other" ? { onDragOver: (e: React.DragEvent) => overTarget(e, dragged() ? { key: "h:other", outcome: "That row holds statuses the board doesn't know; it can't take a card", refused: true } : null) } : dropProps(place, list);
    return (
      <div className={`house-fold ${open ? "open" : ""}`} data-col={placeName(place)} data-drop={cue(drag, `h:${place}`)} {...refused}>
        <button className="house-fold-h" aria-expanded={open} onClick={toggle} title={place === "parked" ? "Parked: not ready to start. Drop a card here to park it." : "Tickets in a status the board doesn't have a column for"}>
          {placeName(place)} · {list.length} <span aria-hidden>{open ? "▾" : "▸"}</span>
        </button>
        {open && list.length > 0 && <div className="house-fold-body">{list.map((r, i) => card(r, place, undefined, i))}</div>}
      </div>
    );
  };

  const empty = !view.open
    ? view.connection.state === "ok"
      ? "Reading the House…"
      : null
    : agentOnly && !forAgents.length
      ? `No ticket on the board is tagged ${NEEDS_AGENT}: nothing has been handed back to an agent.`
      : !all.length
        ? "Nothing open: every ticket in the House is done or dropped."
        : null;
  return (
    <div className="house-board">
      <div className="house-board-bar">
        <span className="house-section-hint">The open backlog and the room's tickets, high priority first{readOnly ? "" : " · drag a card to another column to change its status"}</span>
        <span className="house-section-tools">
          <button className={`house-filter ${agentOnly ? "on" : ""}`} aria-pressed={agentOnly} title={`Only the tickets tagged ${NEEDS_AGENT}: handed back to an agent`} onClick={() => setAgentOnly(!agentOnly)}>
            Needs an agent <span className="house-cnt">{forAgents.length}</span>
          </button>
          <button className={`house-filter ${folds.showDropped ? "on" : ""}`} aria-pressed={folds.showDropped} title={folds.showDropped ? "Hide the dropped tickets" : "Show the room's dropped tickets"} onClick={() => setFolds({ ...folds, showDropped: !folds.showDropped })}>
            Dropped <span className="house-cnt">{g.dropped.length}</span>
          </button>
        </span>
      </div>
      {error && (
        <div className="fp-note err" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="house-problem" role="status">
          {notice}
        </div>
      )}
      {empty && <div className="house-empty">{empty}</div>}
      {g.unread.map((r) => (
        <button key={r.n} className="link house-unread" onClick={() => onOpen(r.n)}>
          #{r.n} {r.problem ? `couldn't be read: ${r.problem}` : "not read yet"}
        </button>
      ))}
      {fold("parked", !folds.parked, () => setFolds({ ...folds, parked: !folds.parked }))}
      {g.other.length > 0 && fold("other", otherOpen, () => setOtherOpen(!otherOpen))}
      <div className="board-cols house-cols">
        {cols.map((c) => {
          const list = g[c.place];
          const key = `h:${c.place}`;
          const here = drag?.type === DRAG_TYPE && drag.target?.key === key ? drag.target : null;
          const gapHere = here && !here.refused ? here.gap : undefined;
          const unfold = c.place === "done" ? () => setFolds({ ...folds, done: !folds.done }) : null;
          if (c.folded) {
            return (
              <div key={c.place} className="bcol house-col folded" data-col={c.name} data-drop={cue(drag, key)} {...dropProps(c.place, list)}>
                <button className="house-col-unfold" aria-expanded={false} title={`Show the ${c.count} ${c.name.toLowerCase()} tickets${c.accepts ? "" : ` · ${CLOSE_REFUSAL}`}`} onClick={unfold!}>
                  {c.name} · {c.count} <span aria-hidden>▸</span>
                </button>
              </div>
            );
          }
          return (
            <div key={c.place} className="bcol house-col" data-col={c.name} data-drop={gapHere === undefined ? cue(drag, key) : undefined} {...dropProps(c.place, list)}>
              <div className="bcol-hd" title={c.accepts ? undefined : `${CLOSE_REFUSAL}: a card can't be dragged here`}>
                {c.name}
                <span className="cnt">{c.count}</span>
                {unfold && (
                  <button className="link house-col-fold" aria-expanded title="Fold the column" onClick={unfold}>
                    ◂
                  </button>
                )}
              </div>
              <div className="bcol-body" data-gap={gapHere !== undefined && list.length === 0 ? "empty" : undefined}>
                {here?.refused && <div className="house-refuse">{here.outcome}</div>}
                {list.map((r, i) => card(r, c.place, gapHere, i))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One ticket: its detail and history, claim or release, a note, and the House's own page. */
function TicketDetail({ roomId, n, view, onBack, onOpen, onStart }: { roomId: string; n: number; view: HouseView; onBack: () => void; onOpen: (n: number) => void; onStart: (n: number, at: HTMLElement) => void }) {
  const [t, setT] = useState<HouseTicketView | null>(null);
  const { run, doing, error } = useAction();
  const [claiming, setClaiming] = useState(false);
  const [kind, setKind] = useState<HouseEventKind>("note");
  const [status, setStatus] = useState<BuilderStatus | "">("");
  const [text, setText] = useState("");
  const [openNote, setOpenNote] = useState("");
  const load = () => window.mb.houseTicket(roomId, n).then((v: HouseTicketView) => setT(v));
  useEffect(() => {
    void load();
  }, [roomId, n]);
  const write = async (what: string, w: HouseWrite) => {
    const r = await run(what, () => window.mb.houseWrite(roomId, w));
    if (!isErr(r)) await load();
    return r;
  };
  const head = (
    <div className="house-head">
      <button className="link" onClick={onBack}>
        ← Board
      </button>
      <h3>#{n}</h3>
    </div>
  );
  if (!t) return <>{head}<div className="hint">Reading #{n} from the House…</div></>;
  if ("error" in t) return <>{head}<div className="err">{t.error}</div></>;
  const d = t.detail;
  const readOnly = view.connection.state !== "ok";
  return (
    <>
      {head}
      <div className="house-detail-title">{d.title}</div>
      <div className="house-meta">
        {t.owner ? <span className={`house-chip claimed ${t.owner.self ? "mine" : ""}`}>{ownerChip(t.owner, d.status)}</span> : <span className="house-status">{statusLabel(d.status)}</span>}
        {d.claim?.branch && <span className="chip">{d.claim.branch}</span>}
        {d.priority && <span className="chip">{d.priority} priority</span>}
        {d.kind && <span className="chip">{d.kind}</span>}
        {d.tags.map((tag) => (
          <span key={tag} className={`chip ${tag === NEEDS_HUMAN ? "amber" : tag === NEEDS_AGENT ? "teal" : ""}`}>
            {tag}
          </span>
        ))}
        {d.blockedBy.map((b) => (
          <button key={b} className="link house-blocker" title={`Open #${b}`} onClick={() => onOpen(b)}>
            blocked by #{b}
          </button>
        ))}
        {d.waiting && <span className="chip amber">{d.waiting.on ? `waiting on ${d.waiting.on}` : "waiting"}</span>}
        <span className="house-meta-r">
          <button
            className="link"
            onClick={() =>
              void run("open", () => window.mb.houseOpen(roomId, n)).then((r: { note?: string } | Err | undefined) => setOpenNote(r && !isErr(r) && r.note ? r.note : ""))
            }
          >
            Open in the House ↗
          </button>
        </span>
      </div>
      {openNote && <div className="house-problem">{openNote}</div>}
      {d.detail.trim() && <div className="house-text">{d.detail}</div>}
      {d.acceptance.trim() && (
        <div className="house-text">
          <span className="house-k">Acceptance</span> {d.acceptance}
        </div>
      )}
      {!readOnly && (
        <div className="house-acts">
          {!claiming && !cantStart(d, t.owner) && (
            <button className="primary" title={`${t.owner?.self ? "" : `Claim #${n}, `}make its worktree and start an agent on it, briefed on the ticket`} onClick={(e) => onStart(n, e.currentTarget)}>
              <RunIcon /> Start session
            </button>
          )}
          {!t.owner && !claiming && isOpenStatus(d.status) && (
            <button className="outline" onClick={() => setClaiming(true)}>
              Claim
            </button>
          )}
          {claiming && <ClaimForm n={n} title={d.title} branches={view.branches} busy={doing("claim")} onCancel={() => setClaiming(false)} onClaim={(branch) => void write("claim", { kind: "claim", n, branch }).then((r) => !isErr(r) && setClaiming(false))} />}
          {t.owner?.self && (
            <button className="outline" disabled={doing("release")} title="Give it back, so someone else can pick it up" onClick={() => void write("release", { kind: "release", n })}>
              Release
            </button>
          )}
          {t.tracked && t.open && (
            <button className="link" title="It stays in the open backlog, without the room's mark" onClick={() => void write("untrack", { kind: "untrack", n })}>
              Remove from the room's tickets
            </button>
          )}
          {t.tracked && !t.open && (
            <button className="link" title="Take it off this room's board; it stays in the House" onClick={() => void write("untrack", { kind: "untrack", n }).then((r) => !isErr(r) && onBack())}>
              Remove from the board
            </button>
          )}
          {!t.tracked && (
            <button
              className="link"
              title={t.open ? "Marks it as the room's in the open backlog; it stays on the board once it's done or dropped" : "Shows it under Added by the room"}
              onClick={() => void write("track", { kind: "track", n })}
            >
              {t.open ? "Add to the room's tickets" : "Add to the board"}
            </button>
          )}
        </div>
      )}
      {!readOnly && (
        <div className="house-post">
          <div className="house-inline">
            <Select
              className="house-kind"
              value={kind}
              onChange={(v) => {
                setKind(v as HouseEventKind);
                if (v === "status" && !status) setStatus("review");
              }}
              options={HOUSE_EVENT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            />
            {(kind === "status" || kind === "progress") && (
              <Select
                className="house-kind"
                value={status}
                onChange={(v) => setStatus(v as BuilderStatus | "")}
                options={[...(kind === "progress" ? [{ value: "", label: "status unchanged" }] : []), ...BUILDER_STATUSES.map((s) => ({ value: s, label: `→ ${statusLabel(s)}` }))]}
              />
            )}
          </div>
          <textarea className="house-ta short" value={text} placeholder={kind === "question" ? "The question; the ticket is handed to a person (needs-human)" : kind === "status" ? "Why it moves" : "What to add to the ticket's history"} onChange={(e) => setText(e.target.value)} />
          <div className="house-inline end">
            <button
              className="primary"
              disabled={!text.trim() || doing("post") || (kind === "status" && !status)}
              data-tip={!text.trim() ? "Write it first" : kind === "status" && !status ? "Pick the new status first" : undefined}
              onClick={() => void write("post", { kind: "event", n, event: kind, text, ...((kind === "status" || kind === "progress") && status ? { status } : {}) }).then((r) => !isErr(r) && setText(""))}
            >
              Post
            </button>
          </div>
        </div>
      )}
      {error && <div className="fp-note err">{error}</div>}
      <div className="house-section-h">History {d.history.length > 0 && <span className="house-cnt">{d.history.length}</span>}</div>
      {!d.history.length && <div className="house-empty">Nothing yet.</div>}
      <div className="house-history">
        {[...d.history].reverse().map((e, i) => (
          <div key={i} className={`house-event k-${e.kind}`}>
            <span className="house-when">{e.at ? (Number.isNaN(Date.parse(e.at)) ? e.at : ago(Date.parse(e.at))) : ""}</span>
            <b>{e.by ?? "someone"}</b> <span className="house-dim">· {historyWhat(e)}</span>
            {e.text && <div className="house-event-text">{e.text}</div>}
            {e.reference && <div className="house-dim">{e.reference}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

export function HouseBoardDialog({ roomId, onClose, onStarted }: { roomId: string; onClose: () => void; onStarted: (s: SessionInfo) => void }) {
  const view = useHouseView(roomId);
  const { run, busy, doing, error } = useAction();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  // Start session's confirmation, by the button or card it was asked from
  const [starting, setStarting] = useState<{ n: number; at: HTMLElement } | null>(null);
  const [openNote, setOpenNote] = useState("");
  const startPop = starting && <TicketStartPopover key={starting.n} roomId={roomId} n={starting.n} anchor={starting.at} onClose={() => setStarting(null)} onStarted={onStarted} />;
  const onStart = (n: number, at: HTMLElement) => setStarting({ n, at });
  const openHouse = (n: number) => void run("open", () => window.mb.houseOpen(roomId, n)).then((r: { note?: string } | Err | undefined) => setOpenNote(r && !isErr(r) && r.note ? r.note : ""));
  const [renaming, setRenaming] = useState(false);
  const act = (what: string, w: HouseWrite) => run(what, () => window.mb.houseWrite(roomId, w));
  if (!view || isErr(view)) {
    return (
      <Modal className="modal house-modal" onClose={onClose}>
        <h3>
          <KanbanIcon /> Radley House
        </h3>
        {view ? <div className="err">Couldn't read the board: {view.error}</div> : <div className="hint">Reading the board…</div>}
        <div className="row">
          <button className="outline" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  if (open !== null) {
    return (
      <Modal className="modal house-modal" onClose={onClose}>
        <TicketDetail key={open} roomId={roomId} n={open} view={view} onBack={() => setOpen(null)} onOpen={setOpen} onStart={onStart} />
        {startPop}
        <div className="row">
          <button className="outline" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  const connected = view.connection.state === "ok";
  return (
    <Modal className="modal house-modal house-board-modal" onClose={onClose} closeOnBackdrop={!adding}>
      <div className="house-head">
        <h3 title={view.envFile ? `Read and written with your own token, from ${view.envFile}` : undefined}>
          <KanbanIcon /> Radley House · {view.project ?? "no project"}
          {view.isAdmin && view.project && !renaming && (
            <button className="link house-change" title="Connect the room to another House project" onClick={() => setRenaming(true)}>
              change
            </button>
          )}
        </h3>
        <span className="house-dim" title="The board is read again about once a minute while it's open">
          {view.refreshing ? "reading…" : view.fetchedAt ? `read ${ago(view.fetchedAt)}` : ""}
        </span>
        {view.project && view.connection.state !== "consent" && (
          <button className="outline" disabled={view.refreshing} onClick={() => void run("refresh", () => window.mb.houseRefresh(roomId))}>
            Refresh
          </button>
        )}
        <button className="outline" disabled={!connected || adding} onClick={() => setAdding(true)}>
          + Add ticket
        </button>
      </div>
      <div className="sub-h">
        The House is the system of record: claims, status moves, notes and new tickets are written there with your own builder token, from here or by your agents. A file a teammate's sessions have changed on a ticket they claimed is theirs — an agent editing it is held back once and warned.
      </div>
      <MigrationsLine roomId={roomId} />
      {(renaming || !view.project) && <ProjectLine view={view} act={act} onCancel={view.project ? () => setRenaming(false) : undefined} />}
      <ConsentNote view={view} onAnswer={(allow) => void run("consent", () => window.mb.houseConsent(roomId, allow))} />
      {view.project && <ConnectionNote view={view} />}
      {view.drift && <div className="house-note warn">{view.drift}</div>}
      {view.copiesProblem && <div className="house-note bad">{view.copiesProblem}</div>}
      {adding && <AddTicket act={act} onDone={() => setAdding(false)} />}
      {error && <div className="fp-note err">{error}</div>}
      {view.project && view.connection.state !== "missing" && view.connection.state !== "bad" && view.connection.state !== "consent" && <Columns roomId={roomId} view={view} onOpen={setOpen} onStart={onStart} onOpenHouse={openHouse} />}
      {openNote && <div className="house-problem">{openNote}</div>}
      {startPop}
      {view.writeProblems?.map((p) => (
        <div key={`${p.at}-${p.text}`} className="house-problem">
          <span className="house-when">{ago(p.at)}</span>
          {p.text}
        </div>
      ))}
      {view.branchProblems?.map((p) => (
        <div key={p} className="house-problem">
          {p}
        </div>
      ))}
      <div className="row">
        {busy && <span className="foot-hint house-dim">{doing("refresh") ? "Reading the House…" : "Saving to the House…"}</span>}
        <button className="outline" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

const NOTICE_MS = 15_000;

/** The rooms whose House project this member hasn't answered for: asked here until they answer (the board asks too). */
function useConsentAsks(): [(HouseConsentAsk & { problem?: string })[], (ask: HouseConsentAsk, allow: boolean | null) => void] {
  const [asks, setAsks] = useState<(HouseConsentAsk & { problem?: string })[]>([]);
  useEffect(() => {
    let alive = true;
    const add = (a: HouseConsentAsk) => setAsks((list) => [...list.filter((x) => x.roomId !== a.roomId), a]);
    window.mb.housePendingConsents().then((list: HouseConsentAsk[] | Err) => {
      if (!alive) return;
      if (isErr(list)) console.error("[mockingbird] couldn't read which rooms ask for your House token:", list.error);
      else list.forEach(add);
    });
    const off = window.mb.onHouseConsent((a: HouseConsentAsk) => add(a));
    // answered on the board, or the room's project changed: this ask is done
    const offView = window.mb.onHouseChanged((v: HouseView) => {
      if (v.connection.state !== "consent" || v.connection.declined) setAsks((list) => list.filter((x) => x.roomId !== v.roomId));
    });
    return () => {
      alive = false;
      off();
      offView();
    };
  }, []);
  const answer = (ask: HouseConsentAsk, allow: boolean | null) => {
    if (allow === null) return setAsks((list) => list.filter((x) => x.roomId !== ask.roomId));
    void window.mb.houseConsent(ask.roomId, allow).then((r: HouseView | Err) => {
      if (isErr(r)) setAsks((list) => list.map((x) => (x.roomId === ask.roomId ? { ...x, problem: r.error } : x)));
      else setAsks((list) => list.filter((x) => x.roomId !== ask.roomId));
    });
  };
  return [asks, answer];
}

/**
 * The token asks to show as toasts: all of them but the open board's room, whose board asks in its own
 * card. One question in one place; the toast comes back if the board closes unanswered.
 */
export function consentToasts<T extends { roomId: string }>(asks: T[], boardRoomId: string | null): T[] {
  return boardRoomId ? asks.filter((a) => a.roomId !== boardRoomId) : asks;
}

/** Claim warnings as they happen: which agent touched which teammate's ticket. Click one to go to its session. */
export function HouseWarnings({ onJump, onOpenBoard, boardRoomId }: { onJump: (sessionId: string) => void; onOpenBoard: (roomId: string) => void; boardRoomId: string | null }) {
  const [notices, setNotices] = useState<(ClaimWarningNotice & { key: number })[]>([]);
  const [allAsks, answer] = useConsentAsks();
  const asks = consentToasts(allAsks, boardRoomId);
  // toasts rise in, leave sideways, and the rest slide to make room (motion.ts)
  const stack = useRef<HTMLDivElement>(null);
  useFlip(stack);
  const toastRef = usePresenceRefs<HTMLDivElement>("toast");
  useEffect(
    () =>
      window.mb.onHouseWarning((n: ClaimWarningNotice) => {
        const key = Date.now() + Math.random();
        setNotices((list) => [...list.slice(-2), { ...n, key }]);
        setTimeout(() => setNotices((list) => list.filter((x) => x.key !== key)), NOTICE_MS);
      }),
    []
  );
  if (!notices.length && !asks.length) return null;
  return (
    <div ref={stack} className="house-toasts" role="status">
      {asks.map((a) => (
        <div key={`consent-${a.roomId}`} ref={toastRef(`consent-${a.roomId}`)} className="house-toast consent">
          <span className="house-toast-body">
            <b>Use your {a.project} builder token for room {a.room}?</b> {a.admin ? `${a.admin} connected the room` : "The room is connected"} to Radley House project {a.project}. Nothing here reads your token or calls the House for this room until you allow it.
            {a.problem && <span className="err"> {a.problem}</span>}
          </span>
          <button className="primary" onClick={() => answer(a, true)}>
            Allow
          </button>
          <button className="outline" onClick={() => answer(a, false)}>
            Not now
          </button>
          <button className="link" onClick={() => onOpenBoard(a.roomId)}>
            Board
          </button>
        </div>
      ))}
      {notices.map((n) => {
        const c = n.conflicts[0];
        const hit = c?.hits[0];
        const what =
          n.decision === "failed"
            ? `The team room's claims check failed in ${n.sessionTitle}'s hook; its edit went ahead unchecked. ${n.error ?? ""}`
            : `${n.sessionTitle} ${n.decision === "deny" ? "tried to edit" : "edited"} ${c?.file}${n.conflicts.length > 1 ? ` and ${plural(n.conflicts.length - 1, "more file")}` : ""} — ${hit?.owner.name}'s ticket #${hit?.n} has been changing ${n.conflicts.length > 1 ? "these files" : "this file"}. ${n.decision === "deny" ? "The agent was held back once; it can repeat the edit." : "It went ahead after the warning."}`;
        return (
          <div key={n.key} ref={toastRef(n.key)} className={`house-toast ${n.decision}`}>
            <button className="house-toast-body" title={n.sessionId ? "Go to the session" : undefined} onClick={() => n.sessionId && onJump(n.sessionId)}>
              {what}
            </button>
            {hit && (
              <button className="link" onClick={() => onOpenBoard(hit.roomId)}>
                Board
              </button>
            )}
            <button className="icon" title="Dismiss" onClick={() => setNotices((list) => list.filter((x) => x.key !== n.key))}>
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
