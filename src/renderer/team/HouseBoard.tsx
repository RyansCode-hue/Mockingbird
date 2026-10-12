import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { Select } from "../Menu";
import { useAction } from "../useAction";
import { ago, plural } from "../../shared/format";
import { isErr } from "../../shared/types";
import {
  branchFor,
  BUILDER_STATUSES,
  HOUSE_EVENT_KINDS,
  ownerChip,
  statusLabel,
  type BuilderStatus,
  type HouseEventKind,
  type HouseRow,
  type HouseTicketView,
  type HouseView,
  type HouseWrite,
} from "../../shared/team/house";
import type { ClaimWarningNotice } from "../../shared/team/claims";

/**
 * A shared room's Radley House board (docs/team-rooms.md, "Radley House
 * board"): the House's current slice and the tickets the room added, who has
 * each, and a ticket's detail and history with its actions. The House is the
 * system of record; everything here is read and written by the main process
 * with this member's own builder token.
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
    return <div className="house-note warn">The room's admin{view.admin ? ` (${view.admin})` : ""} hasn't connected a Radley House project yet. Once they do, the board shows the House's current slice and the tickets the room adds.</div>;
  }
  const connect = () => {
    if (name.trim() && name.trim() !== view.project) void act("project", { kind: "project", project: name.trim() }).then((r) => !isErr(r as Err) && onCancel?.());
  };
  return (
    <div className="house-note">
      <span>
        Which House project does this room work in? Each member's Mockingbird reads its own <code>~/.config/radley-house/&lt;project&gt;.env</code> with that member's token.
      </span>
      <div className="house-inline">
        <input type="text" autoFocus value={name} placeholder="atticus-backoffice" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()} />
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
          <input type="text" autoFocus value={n} placeholder="#143" onChange={(e) => setN(e.target.value)} onKeyDown={(e) => e.key === "Enter" && num > 0 && void act("add", { kind: "track", n: num }).then(ok)} />
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
          <input type="text" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Donor export skips archived donors" />
          <label>Description — context and approach</label>
          <textarea className="house-ta" value={description} onChange={(e) => setDescription(e.target.value)} />
          <label>Acceptance — the observable finish line</label>
          <textarea className="house-ta short" value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
          <div className="row">
            <span className="foot-hint house-dim">Created in the House with your token (it starts parked), and added to the room's board.</span>
            <button className="outline" onClick={onDone}>
              Cancel
            </button>
            <button className="primary" disabled={!title.trim() || !description.trim()} onClick={() => void act("create", { kind: "create", title: title.trim(), description, acceptance }).then(ok)}>
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

function Row({ row, view, onOpen, act, busy }: { row: HouseRow; view: HouseView; onOpen: () => void; act: (what: string, w: HouseWrite) => Promise<unknown>; busy: boolean }) {
  const [claiming, setClaiming] = useState(false);
  const t = row.ticket;
  const readOnly = view.connection.state !== "ok";
  return (
    <div className={`house-row ${row.owner?.self ? "mine" : ""}`}>
      <button className="house-row-main" onClick={onOpen} title={row.problem ?? (row.addedBy ? `Added by ${row.addedBy}` : undefined)}>
        <span className="house-n">#{row.n}</span>
        <span className={`house-title ${t ? "" : "house-dim"}`}>{t ? t.title : row.problem ? `couldn't be read: ${row.problem}` : "not read yet"}</span>
        {t && row.owner ? (
          <span className={`house-chip claimed ${row.owner.self ? "mine" : ""}`} title={t.claim?.branch ? `on ${t.claim.branch}` : undefined}>
            {ownerChip(row.owner, t.status)}
          </span>
        ) : t && !claiming ? (
          <span className="house-chip-wrap">
            <span className="house-status">{statusLabel(t.status)}</span>
            {!readOnly && (
              <button
                className="outline house-claim-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setClaiming(true);
                }}
              >
                Claim
              </button>
            )}
          </span>
        ) : null}
      </button>
      {claiming && t && <ClaimForm n={row.n} title={t.title} branches={view.branches} busy={busy} onCancel={() => setClaiming(false)} onClaim={(branch) => void act(`claim:${row.n}`, { kind: "claim", n: row.n, branch }).then((r) => !isErr(r as Err) && setClaiming(false))} />}
    </div>
  );
}

function Section({ title, rows, empty, ...rest }: { title: string; rows: HouseRow[]; empty: string; view: HouseView; onOpen: (n: number) => void; act: (what: string, w: HouseWrite) => Promise<unknown>; busy: boolean }) {
  return (
    <div className="house-section">
      <div className="house-section-h">
        {title} <span className="house-cnt">{rows.length}</span>
      </div>
      {rows.map((r) => (
        <Row key={r.n} row={r} view={rest.view} onOpen={() => rest.onOpen(r.n)} act={rest.act} busy={rest.busy} />
      ))}
      {!rows.length && <div className="house-empty">{empty}</div>}
    </div>
  );
}

/** One ticket: its detail and history, claim or release, a note, and the House's own page. */
function TicketDetail({ roomId, n, view, onBack }: { roomId: string; n: number; view: HouseView; onBack: () => void }) {
  const [t, setT] = useState<HouseTicketView | null>(null);
  const { run, doing, error } = useAction();
  const [claiming, setClaiming] = useState(false);
  const [kind, setKind] = useState<HouseEventKind>("note");
  const [status, setStatus] = useState<BuilderStatus | "">("");
  const [text, setText] = useState("");
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
          <span key={tag} className={`chip ${tag === "needs-human" ? "amber" : ""}`}>
            {tag}
          </span>
        ))}
        <span className="house-meta-r">
          <button className="link" onClick={() => void run("open", () => window.mb.houseOpen(roomId, n))}>
            Open in the House ↗
          </button>
        </span>
      </div>
      {d.detail.trim() && <div className="house-text">{d.detail}</div>}
      {d.acceptance.trim() && (
        <div className="house-text">
          <span className="house-k">Acceptance</span> {d.acceptance}
        </div>
      )}
      {!readOnly && (
        <div className="house-acts">
          {!t.owner && !claiming && (
            <button className="primary" onClick={() => setClaiming(true)}>
              Claim
            </button>
          )}
          {claiming && <ClaimForm n={n} title={d.title} branches={view.branches} busy={doing("claim")} onCancel={() => setClaiming(false)} onClaim={(branch) => void write("claim", { kind: "claim", n, branch }).then((r) => !isErr(r) && setClaiming(false))} />}
          {t.owner?.self && (
            <button className="outline" disabled={doing("release")} title="Give it back, so someone else can pick it up" onClick={() => void write("release", { kind: "release", n })}>
              Release
            </button>
          )}
          {t.onBoard === "added" && (
            <button className="link" title="Take it off this room's board; it stays in the House" onClick={() => void write("untrack", { kind: "untrack", n }).then((r) => !isErr(r) && onBack())}>
              Remove from the board
            </button>
          )}
          {!t.onBoard && (
            <button className="link" onClick={() => void write("track", { kind: "track", n })}>
              Add to the board
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
            <b>{e.by ?? "someone"}</b> <span className="house-dim">{e.kind}{e.status ? ` → ${statusLabel(e.status)}` : ""}</span>
            {e.text && <div className="house-event-text">{e.text}</div>}
            {e.reference && <div className="house-dim">{e.reference}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

export function HouseBoardDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const view = useHouseView(roomId);
  const { run, busy, doing, error } = useAction();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const act = (what: string, w: HouseWrite) => run(what, () => window.mb.houseWrite(roomId, w));
  if (!view || isErr(view)) {
    return (
      <Modal className="modal house-modal" onClose={onClose}>
        <h3>Radley House</h3>
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
        <TicketDetail roomId={roomId} n={open} view={view} onBack={() => setOpen(null)} />
        <div className="row">
          <button className="outline" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  const connected = view.connection.state === "ok";
  const sliceTitle = `Current slice${view.slice?.name ? ` · ${view.slice.name}` : ""}`;
  return (
    <Modal className="modal house-modal" onClose={onClose} closeOnBackdrop={!adding}>
      <div className="house-head">
        <h3>
          Radley House · {view.project ?? "no project"}
          {view.isAdmin && view.project && !renaming && (
            <button className="link house-change" title="Connect the room to another House project" onClick={() => setRenaming(true)}>
              change
            </button>
          )}
        </h3>
        <span className="house-dim" title="The board is read again about once a minute while it's open">
          {view.refreshing ? "reading…" : view.fetchedAt ? `read ${ago(view.fetchedAt)}` : ""}
        </span>
        {view.project && (
          <button className="outline" disabled={view.refreshing} onClick={() => void run("refresh", () => window.mb.houseRefresh(roomId))}>
            Refresh
          </button>
        )}
        <button className="outline" disabled={!connected || adding} onClick={() => setAdding(true)}>
          + Add ticket
        </button>
      </div>
      <div className="sub-h">
        The House is the system of record: claims, notes and new tickets are written there with your own builder token, from here or by your agents. A file a teammate's sessions have changed on a ticket they claimed is theirs — an agent editing it is held back once and warned.
      </div>
      {(renaming || !view.project) && <ProjectLine view={view} act={act} onCancel={view.project ? () => setRenaming(false) : undefined} />}
      {view.project && <ConnectionNote view={view} />}
      {view.copiesProblem && <div className="house-note bad">{view.copiesProblem}</div>}
      {adding && <AddTicket act={act} onDone={() => setAdding(false)} />}
      {error && <div className="fp-note err">{error}</div>}
      {view.project && view.connection.state !== "missing" && view.connection.state !== "bad" && (
        <>
          <Section
            title={sliceTitle}
            rows={view.slice?.rows ?? []}
            empty={view.sliceProblem ? `The House's spec couldn't be read: ${view.sliceProblem}` : !view.slice ? (connected ? "Reading the spec…" : "—") : view.slice.listsTickets ? "The slice has no tickets." : "The House's spec doesn't name tickets for this slice; add the ones the room works on."}
            view={view}
            onOpen={setOpen}
            act={act}
            busy={!!busy}
          />
          <Section title="Added by the room" rows={view.added} empty={connected ? "None yet — + Add ticket puts one here by number, or creates one." : "—"} view={view} onOpen={setOpen} act={act} busy={!!busy} />
        </>
      )}
      {view.fetchProblem && <div className="house-dim">Teammates' branches couldn't be fetched, so their claimed files may be out of date: {view.fetchProblem}</div>}
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

/** Claim warnings as they happen: which agent touched which teammate's ticket. Click one to go to its session. */
export function HouseWarnings({ onJump, onOpenBoard }: { onJump: (sessionId: string) => void; onOpenBoard: (roomId: string) => void }) {
  const [notices, setNotices] = useState<(ClaimWarningNotice & { key: number })[]>([]);
  useEffect(
    () =>
      window.mb.onHouseWarning((n: ClaimWarningNotice) => {
        const key = Date.now() + Math.random();
        setNotices((list) => [...list.slice(-2), { ...n, key }]);
        setTimeout(() => setNotices((list) => list.filter((x) => x.key !== key)), NOTICE_MS);
      }),
    []
  );
  if (!notices.length) return null;
  return (
    <div className="house-toasts" role="status">
      {notices.map((n) => {
        const c = n.conflicts[0];
        const hit = c?.hits[0];
        const what =
          n.decision === "failed"
            ? `The team room's claims check failed in ${n.sessionTitle}'s hook; its edit went ahead unchecked. ${n.error ?? ""}`
            : `${n.sessionTitle} ${n.decision === "deny" ? "tried to edit" : "edited"} ${c?.file}${n.conflicts.length > 1 ? ` and ${plural(n.conflicts.length - 1, "more file")}` : ""} — ${hit?.owner.name}'s ticket #${hit?.n} has been changing ${n.conflicts.length > 1 ? "these files" : "this file"}. ${n.decision === "deny" ? "The agent was held back once; it can repeat the edit." : "It went ahead after the warning."}`;
        return (
          <div key={n.key} className={`house-toast ${n.decision}`}>
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
