import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRepos } from "./RepoPick";
import { Pick } from "./Menu";
import { cardMove, columnOf, orderColumns, pickBoard, COLUMN_PREFS_KEY, legacyColumnPrefs, type ColumnPrefs } from "./boardView";
import { beginDrag, cue, dragging, overTarget, placeBeside, samePlace, sideOf, useDrag, type Side } from "./drag";
import { stateRank, suggestTicketName, ticketKickoffPrompt, useRepoBranches, workflowStates } from "./tickets";
import { titleOf } from "./appModel";
import { Popover } from "./Popover";
import { PipelinePanel, StageChip, usePipelines } from "./TicketPipeline";
import { isErr, slugBranch, topOfKey, type SessionInfo, type AdoWorkItem, type AdoComment, type AdoBoard } from "../shared/types";
import { openLink } from "./uiUtil";
import { ago, agoShort, fmtElapsed, plural } from "../shared/format";
import { Modal } from "./Modal";
import { usePersisted } from "./prefs";
import { useAction } from "./useAction";
import { isRemote } from "./team/RoomLive";

/** The Dashboard tab: the team's Azure DevOps board, and starting sessions from its tickets. */

// ---- ADO board: near-ADO kanban — drag cards between state columns, comment, link sessions ----
// ADO's own work-item type colors, used as card accents
const TYPE_COLORS: Record<string, string> = {
  Task: "#f2cb1d",
  Bug: "#cc293d",
  "User Story": "#009ccc",
  "Product Backlog Item": "#009ccc",
  Feature: "#773b93",
  Epic: "#ff7b00",
};
const typeColor = (t: string) => TYPE_COLORS[t] ?? "#8d877c";

export function DashboardBoard({
  sessions,
  onJump,
  onAskSession,
  onOpenScm,
  onCreated,
}: {
  sessions: SessionInfo[];
  onJump: (id: string) => void;
  onAskSession: (sessionId: string, text: string) => void;
  onOpenScm: (sessionId: string) => void;
  onCreated: (s: SessionInfo) => void;
}) {
  const pipelines = usePipelines();
  const [items, setItems] = useState<AdoWorkItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [stateCols, setStateCols] = useState<string[]>([]);
  const { doing, run, error, setError } = useAction();
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  // filters: multi-select "Assigned to" (empty = everyone) and hidden columns
  const [me, setMe] = useState("");
  const [who, setWho] = usePersisted<string[] | null>("mb.board.who", null);
  const [whoOpen, setWhoOpen] = useState(false);

  // The team's Azure Boards board — its real columns — when it can be read; work item states otherwise
  const [boardsInfo, setBoardsInfo] = useState<{ team: string; boards: AdoBoard[] } | { error: string } | null>(null);
  const [boardName, setBoardName] = usePersisted<string>("mb.board.name", "");
  const boards = boardsInfo && !isErr(boardsInfo) ? boardsInfo.boards : null;
  const board = boards ? boards.find((b) => b.name === boardName) ?? pickBoard(items ?? [], boards) : null;

  // column order and hidden columns, kept per board ("states" when there's no board)
  const [colPrefs, setColPrefs] = usePersisted<ColumnPrefs>(COLUMN_PREFS_KEY, legacyColumnPrefs);
  const prefKey = board ? `board:${board.name}` : "states";
  const defaultHidden = board ? board.columns.filter((c) => c.type === "outgoing").map((c) => c.name) : [];
  const prefs = colPrefs[prefKey] ?? { order: [], hidden: defaultHidden };
  const setPrefs = (p: { order: string[]; hidden: string[] }) => setColPrefs((all) => ({ ...all, [prefKey]: p }));
  const allCols = board ? board.columns.map((c) => c.name) : stateCols;
  const orderedCols = orderColumns(allCols, prefs.order);
  const hiddenCols = new Set(prefs.hidden);
  const toggleHidden = (c: string) => setPrefs({ ...prefs, hidden: hiddenCols.has(c) ? prefs.hidden.filter((x) => x !== c) : [...prefs.hidden, c] });
  const [colsOpen, setColsOpen] = useState(false);
  /** The column a card sits in: its board column, or its state without a board. */
  const colOfItem = (it: AdoWorkItem) => (board ? columnOf(it, board) : it.state);

  const drag = useDrag();
  const reorderCols = (src: string, target: string, side: Side) => setPrefs({ ...prefs, order: placeBeside(orderedCols, src, target, side) });
  /** What dropping the current drag on a column would do: move a column beside it, or move a ticket into it. */
  const columnTarget = (e: React.DragEvent, col: string) => {
    const srcCol = dragging("text/mb-col");
    if (srcCol) {
      const side = sideOf(e, e.currentTarget, "x");
      return srcCol === col || samePlace(orderedCols, srcCol, col, side) ? null : { key: `c:${col}`, side, outcome: `Put ${srcCol} ${side} ${col}` };
    }
    const it = items?.find((i) => String(i.id) === dragging("text/mb-wi"));
    if (!it) return null;
    if (!board) return it.state !== col ? { key: `c:${col}`, outcome: `#${it.id}: ${it.state} → ${col}` } : null;
    const mv = cardMove(it, board, col);
    return mv ? { key: `c:${col}`, outcome: `#${it.id} → ${col}${mv.stateChanges ? ` (${it.state} → ${mv.state})` : ""}` } : null;
  };

  /** Drop a card in a board column: the column (and its state for the card's type) is saved to ADO. */
  const moveCard = async (id: number, col: string) => {
    const prev = items?.find((i) => i.id === id);
    if (!prev) return;
    if (!board) return changeState(id, col);
    const mv = cardMove(prev, board, col);
    if (!mv) return;
    setError("");
    setItems((p) => (p ? p.map((i) => (i.id === id ? { ...i, boardColumn: col, state: mv.state } : i)) : p));
    const r = await window.mb.adoMoveToColumn(id, prev.type, board.name, col);
    if (isErr(r)) {
      setItems((p) => (p ? p.map((i) => (i.id === id ? prev : i)) : p));
      setError(`Couldn't move ${id} to ${col}: ${r.error}`);
    }
  };
  // detail edit state
  const [title, setTitle] = useState("");
  const [state, setState] = useState("");
  const [desc, setDesc] = useState("");
  const [typeStates, setTypeStates] = useState<string[]>([]);
  // discussion
  const [comments, setComments] = useState<AdoComment[] | null>(null);
  const [draft, setDraft] = useState("");
  // start/attach session
  const { repos, error: reposError } = useRepos();
  const [repoPath, setRepoPath] = useState("");
  const [ticketName, setTicketName] = useState("");
  const [attachId, setAttachId] = useState("");
  const [branchMode, setBranchMode] = useState<"new" | "existing">("new");
  const [dashWorktree, setDashWorktree] = useState(true);
  const { branches: branchInfo, base: baseBranch, setBase: setBaseBranch, error: branchError } = useRepoBranches(repoPath);
  const [existingBranch, setExistingBranch] = useState("");
  useEffect(() => setExistingBranch(""), [repoPath]);
  const [sendTicket, setSendTicket] = useState(true);

  const load = async (fresh = false) => {
    setError("");
    window.mb.adoBoards(fresh).then((b: { team: string; boards: AdoBoard[] } | { error: string }) => setBoardsInfo(b));
    const r: { items: AdoWorkItem[]; total: number; me: string } | { error: string } =
      await window.mb.adoList();
    if (isErr(r)) {
      setItems([]);
      setError(r.error);
      return;
    }
    setItems(r.items);
    setTotal(r.total);
    setMe(r.me);
    // first run: default the assigned-to filter to the PAT's owner; on later runs,
    // heal any stale spelling of "me" persisted by an older build
    setWho((prev) => {
      if (prev === null) return r.me ? [r.me] : [];
      return r.me
        ? prev.map((p) => (p.toLowerCase() === r.me.toLowerCase() ? r.me : p))
        : prev;
    });
    setSyncedAt(Date.now());
    // board columns = union of the valid states for every type on the board
    const fetched = await workflowStates([...new Set(r.items.map((i) => i.type))]);
    if (fetched.error) setError(fetched.error);
    const all = new Set<string>([...r.items.map((i) => i.state), ...fetched.states]);
    all.delete("Removed");
    setStateCols([...all].sort((a, b) => stateRank(a) - stateRank(b) || a.localeCompare(b)));
  };

  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (reposError) setError(`Couldn't list your repos: ${reposError}`);
  }, [reposError]);

  const people = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items ?? []) {
      const n = i.assignedTo || "Unassigned";
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    // selected people and "me" always get a row, even with no cards loaded —
    // a checked filter must never be invisible
    for (const w of who ?? []) if (!counts.has(w)) counts.set(w, 0);
    if (me && !counts.has(me)) counts.set(me, 0);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, who, me]);

  const whoSet = new Set(who ?? []);
  const visibleItems = (items ?? []).filter(
    (i) => whoSet.size === 0 || whoSet.has(i.assignedTo || "Unassigned")
  );
  const whoLabel =
    who === null
      ? "…"
      : whoSet.size === 0
        ? "Everyone"
        : whoSet.size === 1
          ? [...whoSet][0] === me
            ? "Me"
            : [...whoSet][0]
          : `${whoSet.size} people`;
  const toggleWho = (name: string) =>
    setWho((prev) => {
      const n = new Set(prev ?? []);
      n.has(name) ? n.delete(name) : n.add(name);
      return [...n];
    });

  const detail = items?.find((i) => i.id === detailId) ?? null;

  // the work item last opened: a slower answer for one opened before it is dropped
  const detailReq = useRef<number | null>(null);
  const openDetail = (it: AdoWorkItem) => {
    detailReq.current = it.id;
    setDetailId(it.id);
    setTitle(it.title);
    setState(it.state);
    setDesc(it.description);
    setTypeStates([]);
    setTicketName(suggestTicketName(it.title));
    setAttachId("");
    setComments(null);
    setDraft("");
    window.mb.adoStates(it.type).then((r: string[] | { error: string }) => {
      if (detailReq.current !== it.id) return;
      if (Array.isArray(r)) setTypeStates(r);
      else setError(`Couldn't read the states a ${it.type} can be in: ${r.error}`);
    });
    loadComments(it.id);
  };
  const loadComments = (id: number) =>
    window.mb.adoComments(id).then((r: AdoComment[] | { error: string }) => {
      if (detailReq.current !== id) return;
      if (Array.isArray(r)) setComments(r);
      else {
        setComments([]);
        setError(r.error);
      }
    });

  /** Optimistic state change (drag between columns or the detail dropdown). */
  const changeState = async (id: number, newState: string) => {
    const prev = items?.find((i) => i.id === id);
    if (!prev || prev.state === newState) return;
    setError("");
    setItems((p) => (p ? p.map((i) => (i.id === id ? { ...i, state: newState } : i)) : p));
    if (detailId === id) setState(newState);
    const r = await window.mb.adoUpdate(id, { state: newState });
    if (isErr(r)) {
      setItems((p) => (p ? p.map((i) => (i.id === id ? { ...i, state: prev.state } : i)) : p));
      if (detailId === id) setState(prev.state);
      setError(`Couldn't move ${id} to ${newState}: ${r.error}`);
    }
  };

  const dirty = !!detail && (title !== detail.title || state !== detail.state || desc !== detail.description);

  const save = async () => {
    if (!detail || !dirty) return;
    const patch: Record<string, string> = {};
    if (title !== detail.title) patch.title = title;
    if (state !== detail.state) patch.state = state;
    if (desc !== detail.description) patch.description = desc;
    const r = await run("save", () => window.mb.adoUpdate(detail.id, patch));
    if (isErr(r)) return;
    setItems((p) => (p ? p.map((i) => (i.id === detail.id ? { ...i, title, state, description: desc } : i)) : p));
  };

  const postComment = async () => {
    if (!detail || !draft.trim()) return;
    const r = await run("comment", () => window.mb.adoAddComment(detail.id, draft.trim()));
    if (isErr(r)) return;
    setComments((p) => [...(p ?? []), r]);
    setDraft("");
  };

  const groupOf = (it: AdoWorkItem) => String(it.id);
  // sub-group-aware: a session in "5038/backend" still belongs to ticket 5038
  const topGroupOf = (s: SessionInfo) => topOfKey(s.taskGroup ?? "");
  const linkedTo = (it: AdoWorkItem) => sessions.filter((s) => topGroupOf(s) === groupOf(it));
  const linked = detail ? linkedTo(detail) : [];
  // a teammate's session is theirs to move, and the pipeline types into sessions: this Mac's only
  const attachable = detail ? sessions.filter((s) => topGroupOf(s) !== groupOf(detail) && s.status !== "dead" && !isRemote(s)) : [];

  const startSession = async () => {
    if (!detail || !repoPath) return;
    if (branchMode === "existing" && !existingBranch) return;
    const prompt = sendTicket ? ticketKickoffPrompt(detail.id, title, desc) : undefined;
    const info = await run("start", () =>
      window.mb.createSession({
        repoPath,
        ticketId: String(detail.id),
        ticketTitle: ticketName || suggestTicketName(detail.title),
        useWorktree: dashWorktree,
        ...(branchMode === "existing"
          ? { branchName: existingBranch }
          : baseBranch
            ? { baseBranch }
            : {}),
        initialPrompt: prompt,
      })
    );
    if (isErr(info)) return;
    onCreated(info);
  };

  return (
    <div className="board">
      <div className="board-filter">
        <span className="flbl">Assigned to</span>
        <span className="who-wrap">
          <button className="who-btn" onClick={() => setWhoOpen((o) => !o)}>
            {whoLabel} <span className="kbd">▾</span>
          </button>
          {whoOpen && (
            <Popover className="who-pop" onClose={() => setWhoOpen(false)}>
              <div
                className={`who-row ${whoSet.size === 0 ? "on" : ""}`}
                onClick={() => setWho([])}
              >
                <span className={`ck ${whoSet.size === 0 ? "on" : ""}`}>{whoSet.size === 0 ? "✓" : ""}</span>
                Everyone
                <span className="cnt">{items?.length ?? 0}</span>
              </div>
              <div className="who-div" />
              {people.map(([p, n]) => (
                <div key={p} className={`who-row ${whoSet.has(p) ? "on" : ""}`} onClick={() => toggleWho(p)}>
                  <span className={`ck ${whoSet.has(p) ? "on" : ""}`}>{whoSet.has(p) ? "✓" : ""}</span>
                  {p === me ? `${p} (me)` : p}
                  <span className="cnt">{n}</span>
                </div>
              ))}
              <div className="who-hint">check any number of people · stays open while you pick</div>
            </Popover>
          )}
        </span>
        <span className="vdiv" />
        {boards && boards.length > 0 && (
          <>
            <span className="flbl">Board</span>
            <Pick
              className="board-pick"
              value={board?.name ?? ""}
              title={boardsInfo && !isErr(boardsInfo) ? `${boardsInfo.team}'s boards in Azure DevOps` : undefined}
              onChange={(e) => setBoardName(e.target.value)}
            >
              {boards.map((b) => (
                <option key={b.id} value={b.name}>{b.name}</option>
              ))}
            </Pick>
          </>
        )}
        <span className="who-wrap">
          <button className="who-btn" onClick={() => setColsOpen((o) => !o)}>
            Columns {hiddenCols.size > 0 && <span className="kbd">{orderedCols.length - [...hiddenCols].filter((c) => orderedCols.includes(c)).length}/{orderedCols.length}</span>}{" "}
            <span className="kbd">▾</span>
          </button>
          {colsOpen && (
            <Popover className="who-pop cols-pop" onClose={() => setColsOpen(false)}>
              <div className="who-hint cols-src">
                {board
                  ? `${board.name} board · ${boardsInfo && !isErr(boardsInfo) ? boardsInfo.team : ""} — as set up in Azure DevOps`
                  : boardsInfo && isErr(boardsInfo)
                    ? `Showing work item states — couldn't read your team's board: ${boardsInfo.error}`
                    : "Showing work item states"}
              </div>
              {orderedCols.map((c) => {
                const n = visibleItems.filter((i) => colOfItem(i) === c).length;
                return (
                  <div
                    key={c}
                    className={`who-row col-row ${hiddenCols.has(c) ? "" : "on"}`}
                    data-drop={cue(drag, `cl:${c}`)}
                    onDragOver={(e) => {
                      const src = dragging("text/mb-col");
                      const side = sideOf(e, e.currentTarget, "y");
                      overTarget(e, !src || src === c || samePlace(orderedCols, src, c, side) ? null : { key: `cl:${c}`, side, outcome: `Put ${src} ${side} ${c}` });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const src = e.dataTransfer.getData("text/mb-col");
                      if (src && src !== c) reorderCols(src, c, sideOf(e, e.currentTarget, "y"));
                    }}
                  >
                    <span className="col-grip" draggable title="Drag to reorder" onDragStart={(e) => beginDrag(e, "text/mb-col", c, `Moving column ${c}`)}>
                      ⋮⋮
                    </span>
                    <span className={`ck ${hiddenCols.has(c) ? "" : "on"}`} title={hiddenCols.has(c) ? "Show column" : "Hide column"} onClick={() => toggleHidden(c)}>
                      {hiddenCols.has(c) ? "" : "✓"}
                    </span>
                    <span onClick={() => toggleHidden(c)}>{c}</span>
                    <span className="cnt">{n}</span>
                  </div>
                );
              })}
              <div className="who-div" />
              <div className="who-row" onClick={() => setPrefs({ order: [], hidden: defaultHidden })}>
                {board ? "Reset to the board's order" : "Reset order"}
              </div>
            </Popover>
          )}
        </span>
        <span style={{ marginLeft: "auto" }} />
        <span className="flbl-info">
          {items ? `${visibleItems.length} items` : ""}
          {board && items && visibleItems.some((i) => colOfItem(i) === null)
            ? ` · ${visibleItems.filter((i) => colOfItem(i) === null).length} on other boards`
            : ""}
          {total > (items?.length ?? 0) ? ` · showing ${items!.length} of ${total}` : ""}
          {syncedAt ? ` · synced ${fmtElapsed(syncedAt)} ago` : " · syncing…"}
        </span>
        <button className="outline" onClick={() => load(true)}>Refresh</button>
      </div>
      {error && <div className="err board-err">{error}</div>}
      <div className="board-cols">
        {items === null && <div className="wi-empty" style={{ padding: 14 }}>Loading work items…</div>}
        {items !== null && stateCols.length === 0 && !error && (
          <div className="wi-empty" style={{ padding: 14 }}>No active work items.</div>
        )}
        {orderedCols.filter((c) => !hiddenCols.has(c)).map((col) => {
          const colItems = visibleItems.filter((i) => colOfItem(i) === col);
          return (
            <div
              key={col}
              className="bcol"
              data-drop={cue(drag, `c:${col}`)}
              onDragOver={(e) => overTarget(e, columnTarget(e, col))}
              onDrop={(e) => {
                e.preventDefault();
                const movedCol = e.dataTransfer.getData("text/mb-col");
                if (movedCol) return movedCol !== col && reorderCols(movedCol, col, sideOf(e, e.currentTarget, "x"));
                const id = parseInt(e.dataTransfer.getData("text/mb-wi"), 10);
                if (id) moveCard(id, col);
              }}
            >
              <div
                className="bcol-hd"
                draggable
                title="drag to reorder columns"
                onDragStart={(e) => beginDrag(e, "text/mb-col", col, `Moving column ${col}`)}
              >
                {col}
                <span className="cnt">{colItems.length}</span>
              </div>
              <div className="bcol-body">
                {colItems.map((it) => {
                  const live = linkedTo(it);
                  return (
                    <div
                      key={it.id}
                      className="bcard"
                      draggable
                      onDragStart={(e) => beginDrag(e, "text/mb-wi", String(it.id), `Moving #${it.id}`)}
                      onClick={() => openDetail(it)}
                      title="drag to another column to change state"
                    >
                      <span className="tbar" style={{ background: typeColor(it.type) }} />
                      <div className="bc-top">
                        <span className="wi-id">{it.id}</span>
                        <span className="bc-type">{it.type}</span>
                        <span className="bc-age">{it.changed ? agoShort(Date.parse(it.changed)) : ""}</span>
                      </div>
                      <div className="bc-title">{it.title}</div>
                      <div className="bc-foot">
                        {live.map((s) => (
                          <span key={s.id} className={`dot sm ${s.status}`} />
                        ))}
                        <span>{live.length ? plural(live.length, "session") : "no session"}</span>
                        <StageChip p={pipelines[String(it.id)]} />
                        {it.assignedTo !== me && (
                          <span className="bc-who">{it.assignedTo || "Unassigned"}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {detail && (
        <Modal className="bdetail" onClose={() => setDetailId(null)}>
          <div className="hd">
            <span className="tsq" style={{ background: typeColor(detail.type) }} />
            <span className="wi-id">{detail.id}</span>
            <span className="path">{detail.type}{detail.assignedTo ? ` · ${detail.assignedTo}` : " · Unassigned"}</span>
            <span style={{ marginLeft: "auto" }} />
            {dirty && <span className="kbd" style={{ color: "var(--amber)" }}>unsaved</span>}
            <button className="primary" disabled={!dirty || doing("save")} onClick={save}>
              {doing("save") ? "Saving…" : "Save"}
            </button>
            <button className="outline" onClick={() => openLink(detail.url)}>Open in ADO</button>
            <button className="icon" title="Close (esc)" onClick={() => setDetailId(null)}>✕</button>
          </div>
          <div className="bd-body">
            <div className="wi-form bd-main">
              <PipelinePanel
                ticketId={String(detail.id)}
                title={detail.title}
                details={desc}
                sessions={linked.filter((s) => !isRemote(s))}
                onAskSession={(id, text) => {
                  setDetailId(null);
                  onAskSession(id, text);
                }}
                onOpenScm={(id) => {
                  setDetailId(null);
                  onOpenScm(id);
                }}
                onPosted={() => loadComments(detail.id)}
              />
              <label>Title</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
              <label>
                Description <span className="wi-note">plain text — rich formatting is simplified on save</span>
              </label>
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} spellCheck={false} style={{ minHeight: 140 }} />
              <div className="wi-sec">Discussion</div>
              {comments === null && <div className="wi-empty">Loading comments…</div>}
              {comments?.length === 0 && <div className="wi-empty">No comments yet.</div>}
              {comments?.map((c) => (
                <div key={c.id} className="cmt">
                  <div className="cmt-hd">
                    <b>{c.author}</b>
                    <span>{c.date ? ago(Date.parse(c.date)) : ""}</span>
                  </div>
                  <div className="cmt-tx">{c.text}</div>
                </div>
              ))}
              <div className="cmt-compose">
                <textarea
                  placeholder="Write a comment…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{ minHeight: 64 }}
                />
                <div className="row">
                  <button className="primary" disabled={!draft.trim() || doing("comment")} onClick={postComment}>
                    {doing("comment") ? "Posting…" : "Comment"}
                  </button>
                </div>
              </div>
            </div>
            <div className="wi-form bd-side">
              <label>State</label>
              <Pick value={state} onChange={(e) => setState(e.target.value)}>
                {[...new Set([state, ...typeStates])].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Pick>
              <div className="wi-sec">Sessions on this ticket</div>
              {linked.length === 0 && <div className="wi-empty">None yet.</div>}
              {linked.map((s) => (
                <div key={s.id} className="drow" style={{ cursor: "pointer" }} onClick={() => onJump(s.id)}>
                  <span className={`dot sm ${s.status}`} />
                  <span className="nm">{titleOf(s)}</span>
                  <span className="st">open ⏎</span>
                </div>
              ))}
              <label>New session</label>
              <Pick value={repoPath} onChange={(e) => setRepoPath(e.target.value)}>
                <option value="">repo…</option>
                {repos.map((r) => (
                  <option key={r.path} value={r.path}>{r.name}</option>
                ))}
              </Pick>
              <div className="check-line" style={{ marginTop: 6 }}>
                <input type="checkbox" id="dash-wt" checked={dashWorktree} onChange={(e) => setDashWorktree(e.target.checked)} />
                <label htmlFor="dash-wt" style={{ margin: 0 }}>
                  isolated worktree
                  <span className="wi-note"> {dashWorktree ? "own folder under worktrees/<repo>/" : "off — branch is checked out in the repo itself"}</span>
                </label>
              </div>
              <div className="pills" style={{ marginTop: 6 }}>
                <button className={`pill ${branchMode === "new" ? "on" : ""}`} onClick={() => setBranchMode("new")}>
                  New branch
                </button>
                <button
                  className={`pill ${branchMode === "existing" ? "on" : ""}`}
                  onClick={() => setBranchMode("existing")}
                >
                  Existing branch
                </button>
              </div>
              {branchMode === "new" ? (
                <>
                  <input
                    type="text"
                    value={ticketName}
                    onChange={(e) => setTicketName(e.target.value)}
                    style={{ marginTop: 6 }}
                    title="Short name — becomes the branch/worktree suffix"
                  />
                  {branchInfo && branchInfo.branches.length > 0 && (
                    <Pick
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                      style={{ marginTop: 6 }}
                      title="The base is fetched fresh from origin before the new branch is cut"
                    >
                      <option value="">base: current HEAD</option>
                      {branchInfo.branches.map((b) => (
                        <option key={b} value={b}>base: origin/{b}</option>
                      ))}
                    </Pick>
                  )}
                </>
              ) : (
                <Pick
                  value={existingBranch}
                  onChange={(e) => setExistingBranch(e.target.value)}
                  style={{ marginTop: 6 }}
                >
                  <option value="">branch…</option>
                  {(branchInfo?.branches ?? []).map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </Pick>
              )}
              <div className="check-line">
                <input
                  type="checkbox"
                  checked={sendTicket}
                  onChange={(e) => setSendTicket(e.target.checked)}
                  id="sendtk"
                />
                <label htmlFor="sendtk" style={{ margin: 0, textTransform: "none", letterSpacing: 0 }}>
                  send ticket title + description to Claude
                </label>
              </div>
              <button
                className="primary"
                style={{ marginTop: 7 }}
                disabled={!repoPath || doing("start") || (branchMode === "existing" && !existingBranch)}
                onClick={startSession}
              >
                {doing("start") ? "Starting…" : "Start session"}
              </button>
              {branchMode === "new" && repoPath && ticketName && (
                <div className="wi-note">
                  creates worktree {slugBranch(String(detail.id), ticketName)}
                  {baseBranch ? ` from origin/${baseBranch}` : ""}
                </div>
              )}
              {branchMode === "existing" && existingBranch && (
                <div className="wi-note">opens a worktree on {existingBranch}</div>
              )}
              {branchError && <div className="err">{branchError}</div>}
              {attachable.length > 0 && (
                <>
                  <label>Attach existing</label>
                  <Pick value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                    <option value="">choose session…</option>
                    {attachable.map((s) => (
                      <option key={s.id} value={s.id}>{titleOf(s)}</option>
                    ))}
                  </Pick>
                  <button
                    className="outline"
                    style={{ marginTop: 7 }}
                    disabled={!attachId}
                    onClick={async () => {
                      const r = await window.mb.setGroup(attachId, groupOf(detail));
                      if (isErr(r)) return setError(`Couldn't attach the session: ${r.error}`);
                      setAttachId("");
                    }}
                  >
                    Attach
                  </button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
