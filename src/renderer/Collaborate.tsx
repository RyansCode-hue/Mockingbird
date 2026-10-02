import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentKind, CollabMessage, CollabMode, CollabModel, CollabParticipantSpec, CollabPermissionRequest, CollabRoom, RepoEntry } from "../shared/types";
import { agreement, initials, isLong, roundsGrid, summaryOf, threadItems, waited } from "./collabView";

const MODES: { id: CollabMode; label: string; note: string }[] = [
  { id: "step", label: "Step", note: "one round, then waits for you" },
  { id: "auto", label: "Auto", note: "runs a set number of rounds" },
  { id: "consensus", label: "Until agreed", note: "stops when every model agrees" },
];
const nextMode = (m: CollabMode): CollabMode => MODES[(MODES.findIndex((x) => x.id === m) + 1) % MODES.length].id;

type Result<T> = T | { error: string };
type Catalog = { presets: CollabModel[]; efforts: Record<AgentKind, string[]> };
const CUSTOM = "__custom";
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);

/** A remembered UI preference; storage can be unavailable, and then the default applies. */
function usePref<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* not remembered this time; the choice still applies */
    }
  };
  return [v, set];
}

/** Rooms where several models discuss an idea; edits only happen after the user approves a plan. */
export function CollaborateView({ onOpenSession, focusRoom }: { onOpenSession: (sessionId: string) => void; focusRoom?: { id: string; n: number } | null }) {
  const [rooms, setRooms] = useState<CollabRoom[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({ presets: [], efforts: { claude: [], codex: [] } });
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState("");
  const [railOpen, setRailOpen] = usePref<boolean>("mb.collab.rail", false);

  useEffect(() => {
    window.mb.collabModels().then(setCatalog);
    window.mb.collabList().then((r: Result<CollabRoom[]>) => {
      if (isErr(r)) return setError(r.error);
      setRooms(r);
      setSelected((s) => s ?? r[0]?.id ?? "new");
    });
    return window.mb.onCollabChanged((room: CollabRoom) =>
      setRooms((rs) => (rs.some((r) => r.id === room.id) ? rs.map((r) => (r.id === room.id ? room : r)) : [room, ...rs]))
    );
  }, []);

  useEffect(() => {
    if (focusRoom) setSelected(focusRoom.id);
  }, [focusRoom]);

  const room = rooms.find((r) => r.id === selected) ?? null;

  return (
    <div className="collab">
      <aside className={`collab-rooms ${railOpen ? "" : "rail"}`}>
        <div className="collab-rail-top">
          <button className="icon" title={railOpen ? "Collapse the room list" : "Show the room list"} onClick={() => setRailOpen(!railOpen)}>
            ☰
          </button>
          {railOpen ? (
            <button className="primary collab-new" onClick={() => setSelected("new")}>New room</button>
          ) : (
            <button className={`icon collab-rail-new ${selected === "new" ? "on" : ""}`} title="New room" onClick={() => setSelected("new")}>+</button>
          )}
        </div>
        {rooms.map((r) =>
          railOpen ? (
            <button key={r.id} className={`collab-room-row ${r.id === selected ? "on" : ""}`} onClick={() => setSelected(r.id)}>
              <span className="t">
                {r.running && <span className="dot sm working" />}
                {r.title}
              </span>
              <span className="s">
                {r.participants.filter((p) => !p.removed).map((p) => p.label.replace(/^Claude /, "")).join(" · ")} · round {r.round}
                {r.plan?.approved ? " · plan approved" : ""}
                {!!r.pending?.length && <span className="collab-needs"> · needs your OK</span>}
              </span>
            </button>
          ) : (
            <button
              key={r.id}
              className={`collab-rail-item ${r.id === selected ? "on" : ""}`}
              title={`${r.title}${r.running ? " — running" : ""}${r.pending?.length ? " — needs your OK" : ""}`}
              onClick={() => setSelected(r.id)}
            >
              {initials(r.title)}
              {r.pending?.length ? <span className="collab-rail-dot ask" /> : r.running ? <span className="collab-rail-dot run" /> : null}
            </button>
          )
        )}
      </aside>
      <main className="collab-main">
        {error && <div className="err">{error}</div>}
        {selected === "new" || !room ? (
          <NewRoom
            catalog={catalog}
            onCreated={(r) => {
              setRooms((rs) => [r, ...rs.filter((x) => x.id !== r.id)]);
              setSelected(r.id);
              window.mb.collabRun(r.id);
            }}
          />
        ) : (
          <Room
            key={room.id}
            room={room}
            catalog={catalog}
            onDeleted={() => {
              setRooms((rs) => rs.filter((r) => r.id !== room.id));
              setSelected("new");
            }}
            onOpenSession={onOpenSession}
          />
        )}
      </main>
    </div>
  );
}

function NewRoom({ catalog, onCreated }: { catalog: Catalog; onCreated: (r: CollabRoom) => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [seats, setSeats] = useState<CollabParticipantSpec[]>([]);
  const [repo, setRepo] = useState("");
  const [mode, setMode] = useState<CollabMode>("auto");
  const [error, setError] = useState("");
  useEffect(() => setSeats(catalog.presets.map((m) => ({ label: m.label, agent: m.agent, model: m.model, effort: null, readsCode: true }))), [catalog]);
  const create = async () => {
    const r: Result<CollabRoom> = await window.mb.collabCreate({ title, brief, repoPath: repo || null, participants: seats, mode });
    if (isErr(r)) return setError(r.error);
    onCreated(r);
  };
  return (
    <div className="collab-new-room">
      <h2>New room</h2>
      <p className="set-lede">
        Pick the models, describe the idea, and they'll discuss it in turns. They can read a repo for context, but nothing is
        changed until you approve a plan — then one model implements it in a normal session on a new branch.
      </p>
      <label>Repository <span className="wi-note">optional — pick one to let models read the code</span></label>
      <RepoPicker value={repo} onChange={setRepo} bare />
      <label>Models <span className="wi-note">they speak in this order</span></label>
      <SeatEditor seats={seats} onChange={setSeats} catalog={catalog} hasRepo={!!repo} />
      <label>Title</label>
      <input type="text" placeholder="CSV export for the donor list" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label>The idea or feature</label>
      <textarea
        rows={7}
        placeholder="We need a way to export the donor list to CSV from the backoffice. It has to respect the user's filters and handle 200k rows…"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <label>Pacing</label>
      <ModeSeg mode={mode} onMode={setMode} />
      {error && <div className="err">{error}</div>}
      <div className="set-actions">
        <button className="primary" disabled={!brief.trim() || seats.length < 2} onClick={create}>
          Start discussion
        </button>
      </div>
    </div>
  );
}

function ModeSeg({ mode, onMode }: { mode: CollabMode; onMode: (m: CollabMode) => void }) {
  return (
    <span className="seg collab-mode" title="Shift+Tab in the message box cycles these">
      {MODES.map((m) => (
        <button key={m.id} className={mode === m.id ? "on" : ""} title={m.note} onClick={() => onMode(m.id)}>
          {m.label}
        </button>
      ))}
    </span>
  );
}

type Call = (what: string, fn: () => Promise<unknown>) => Promise<unknown>;

function Room({ room, catalog, onDeleted, onOpenSession }: { room: CollabRoom; catalog: Catalog; onDeleted: () => void; onOpenSession: (id: string) => void }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<CollabParticipantSpec[] | null>(null);
  const [repoDraft, setRepoDraft] = useState<string>(room.repoPath ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [view, setView] = usePref<"thread" | "rounds">("mb.collab.view", "thread");
  const [inspector, setInspector] = usePref<boolean>("mb.collab.inspector", true);
  const [open, setOpen] = useState<Set<string>>(() => new Set()); // folded messages / grid cells the user opened
  const endRef = useRef<HTMLDivElement>(null);
  const asksRef = useRef<HTMLDivElement>(null);
  const label = useMemo(() => Object.fromEntries(room.participants.map((p) => [p.key, p.label])), [room.participants]);
  const color = useMemo(() => Object.fromEntries(room.participants.map((p) => [p.key, p.color])), [room.participants]);
  const seated = room.participants.filter((p) => !p.removed);
  const agree = agreement(room);
  const pending = room.pending ?? [];
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const openModels = () => {
    setRepoDraft(room.repoPath ?? "");
    setEditing(seated.map((p) => ({ key: p.key, label: p.label, agent: p.agent, model: p.model, effort: p.effort, readsCode: p.readsCode, runsCommands: !!p.runsCommands, usesDocker: !!p.usesDocker })));
  };
  // braces matter: scrollIntoView returns a Promise in current Chromium, and React
  // would call a returned value as the effect's cleanup (crashing on unmount)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [room.messages.length, room.speaking, view]);

  const call: Call = async (what, fn) => {
    setBusy(what);
    setError("");
    const r = await fn();
    setBusy("");
    if (isErr(r)) setError(r.error);
    return r;
  };
  const saveModels = async () => {
    if (!editing) return;
    if ((repoDraft || null) !== room.repoPath) {
      const rr = await call("repo", () => window.mb.collabRepo(room.id, repoDraft || null));
      if (isErr(rr)) return;
    }
    const r = await call("models", () => window.mb.collabParticipants(room.id, editing));
    if (!isErr(r)) setEditing(null);
  };
  const setMode = (mode: CollabMode, rounds?: number) => call("mode", () => window.mb.collabMode(room.id, mode, rounds));
  const send = async () => {
    const t = draft.trim();
    if (!t) return;
    const r = await call("send", () => window.mb.collabSend(room.id, t));
    if (!isErr(r)) setDraft("");
  };
  const jumpTo = (messageId: string) => {
    setView("thread");
    setOpen((s) => new Set(s).add(messageId));
    setTimeout(() => document.getElementById(`collab-msg-${messageId}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
  };

  return (
    <div className="collab-room">
      <div className="collab-center">
        <header className="collab-head">
          <h2 title={room.brief}>{room.title}</h2>
          <span className="collab-pill">round {room.round}</span>
          {agree && (
            <span className="collab-agree" title={`Stances in round ${agree.round}`}>
              {agree.agree} of {agree.of} agree
            </span>
          )}
          <span className="spacer" />
          {pending.length > 0 && (
            <button className="collab-waiting" onClick={() => asksRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })}>
              {pending.length === 1 ? "1 request waiting" : `${pending.length} requests waiting`}
            </button>
          )}
          <span className="seg" title="Read the discussion as a thread, or compare the models round by round">
            <button className={view === "thread" ? "on" : ""} onClick={() => setView("thread")}>Thread</button>
            <button className={view === "rounds" ? "on" : ""} onClick={() => setView("rounds")}>Rounds</button>
          </span>
          <button className={`icon ${inspector ? "on" : ""}`} title={inspector ? "Hide room details" : "Show room details"} onClick={() => setInspector(!inspector)}>
            ▥
          </button>
        </header>

        {editing && (
          <div className="collab-models-panel">
            <div className="set-lede">
              Changes apply from each model's next turn. A model you add reads the whole discussion first; one you remove keeps its past messages.
            </div>
            <RepoPicker value={repoDraft} onChange={setRepoDraft} />
            <SeatEditor seats={editing} onChange={setEditing} catalog={catalog} hasRepo={!!repoDraft} colors={color} />
            <div className="set-actions">
              <button className="primary" disabled={editing.length < 1} onClick={saveModels}>Save</button>
              <button className="outline" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}

        {view === "thread" ? (
          <Thread room={room} label={label} color={color} open={open} toggle={toggle} call={call} endRef={endRef} />
        ) : (
          <RoundsGrid room={room} color={color} open={open} toggle={toggle} call={call} endRef={endRef} />
        )}

        {pending.length > 0 && (
          <div className="collab-asks" ref={asksRef}>
            {pending.map((r) => (
              <AskCard key={r.id} room={room} req={r} label={label} color={color} call={call} />
            ))}
          </div>
        )}

        {error && <div className="err">{error}</div>}
        <footer className="collab-bar">
          <textarea
            rows={2}
            placeholder={room.running ? "Add to the discussion — the models see it on their next turn" : "Say something, or press Run to continue"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && e.shiftKey) {
                e.preventDefault();
                setMode(nextMode(room.mode));
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="collab-controls">
            <ModeSeg mode={room.mode} onMode={(m) => setMode(m)} />
            {room.mode !== "step" && (
              <label className="collab-rounds" title={room.mode === "auto" ? "Rounds per run" : "Give up after this many rounds"}>
                {room.mode === "auto" ? "rounds" : "cap"}
                <input type="number" min={1} max={20} value={room.maxRounds} onChange={(e) => setMode(room.mode, Number(e.target.value))} />
              </label>
            )}
            <span className="spacer" />
            {room.running ? (
              <button className="outline" onClick={() => call("stop", () => window.mb.collabStop(room.id))}>Stop</button>
            ) : (
              <button className="outline" onClick={() => window.mb.collabRun(room.id)}>
                {room.mode === "step" ? "Next round" : "Run"}
              </button>
            )}
            <button className="primary" disabled={!draft.trim()} onClick={send}>Send</button>
          </div>
        </footer>
      </div>

      {inspector && (
        <Inspector
          room={room}
          busy={busy}
          call={call}
          setError={setError}
          onEditModels={() => (editing ? setEditing(null) : openModels())}
          onJump={jumpTo}
          onOpenSession={onOpenSession}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

function ApproveButton({ room, m, call }: { room: CollabRoom; m: CollabMessage; call: Call }) {
  if (m.speaker === "you" || m.speaker === "system" || m.kind === "error" || m.kind === "lookup") return null;
  return (
    <button
      className="collab-approve"
      title="Approve this as the plan — then a model can implement it"
      onClick={(e) => {
        e.stopPropagation();
        call("approve", () => window.mb.collabApprove(room.id, m.id));
      }}
    >
      Approve
    </button>
  );
}

function StancePill({ m }: { m: CollabMessage }) {
  if (m.kind === "plan") return <span className="collab-stance plan">plan</span>;
  if (m.kind === "error") return <span className="collab-stance error">failed</span>;
  if (m.kind === "lookup") return <span className="collab-stance">lookup</span>;
  if (!m.stance) return null;
  return <span className={`collab-stance ${m.stance}`}>{m.stance === "agree" ? "agrees" : "continue"}</span>;
}

/** The discussion as a thread: a divider per round; long messages fold, except the newest. */
function Thread({
  room,
  label,
  color,
  open,
  toggle,
  call,
  endRef,
}: {
  room: CollabRoom;
  label: Record<string, string>;
  color: Record<string, number>;
  open: Set<string>;
  toggle: (id: string) => void;
  call: Call;
  endRef: React.RefObject<HTMLDivElement>;
}) {
  const newest = [...room.messages].reverse().find((m) => m.speaker !== "system")?.id;
  return (
    <div className="collab-transcript">
      {threadItems(room.messages).map((item) => {
        if (item.type === "divider") {
          return (
            <div key={`round-${item.round}`} className="collab-divider">
              <span>Round {item.round}</span>
            </div>
          );
        }
        const m = item.message;
        const foldable = m.id !== newest && isLong(m.text);
        const folded = foldable && !open.has(m.id);
        return (
          <div
            key={m.id}
            id={`collab-msg-${m.id}`}
            className={`collab-msg ${m.speaker === "you" ? "you" : m.speaker === "system" ? "sys" : `c-${color[m.speaker] ?? 0}`} ${m.kind ?? ""}`}
          >
            {m.speaker !== "system" && (
              <div className="collab-msg-head">
                {m.speaker !== "you" && <span className={`seat-dot c-${color[m.speaker] ?? 0}`} />}
                <span className="who">{m.speaker === "you" ? "You" : label[m.speaker] ?? m.speaker}</span>
                {m.kind === "lookup" && <span className="collab-meta">looked up the code for {label[m.askedBy ?? ""] ?? m.askedBy}</span>}
                <StancePill m={m} />
                <ApproveButton room={room} m={m} call={call} />
              </div>
            )}
            <div className={`collab-text ${folded ? "folded" : ""}`}>{m.text}</div>
            {foldable && (
              <button className="collab-more" onClick={() => toggle(m.id)}>
                {folded ? "Show more" : "Show less"}
              </button>
            )}
          </div>
        );
      })}
      {room.speaking && (
        <div className={`collab-msg thinking c-${color[room.speaking] ?? 0}`}>
          <span className="who">{label[room.speaking]}</span> is thinking…
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/** The discussion as a grid: a column per model, a row per round; a cell opens in place. */
function RoundsGrid({
  room,
  color,
  open,
  toggle,
  call,
  endRef,
}: {
  room: CollabRoom;
  color: Record<string, number>;
  open: Set<string>;
  toggle: (id: string) => void;
  call: Call;
  endRef: React.RefObject<HTMLDivElement>;
}) {
  const { columns, rows, after } = roundsGrid(room);
  const cols = { gridTemplateColumns: `48px repeat(${columns.length}, minmax(0, 1fr))` };
  const yours = (m: CollabMessage) => (
    <div key={m.id} className="collab-grid-you" style={{ gridColumn: "1 / -1" }}>
      <span className="who">You</span>
      <span className={open.has(m.id) ? "full" : ""} onClick={() => toggle(m.id)}>
        {open.has(m.id) ? m.text : summaryOf(m.text, 220)}
      </span>
    </div>
  );
  return (
    <div className="collab-grid-wrap">
      <div className="collab-grid" style={cols}>
        <div className="collab-grid-head" />
        {columns.map((p) => (
          <div key={p.key} className={`collab-grid-head c-${p.color} ${room.speaking === p.key ? "speaking" : ""}`}>
            <span className={`seat-dot c-${p.color}`} />
            <span className="who">{p.label}</span>
            {p.removed && <span className="collab-meta">left</span>}
          </div>
        ))}
        {rows.map((row) => (
          <React.Fragment key={row.round}>
            {row.before.map(yours)}
            <div className="collab-grid-round">R{row.round}</div>
            {columns.map((p) => {
              const ms = row.cells[p.key] ?? [];
              const thinking = room.speaking === p.key && row.round === room.round + 1;
              return (
                <div key={p.key} className={`collab-grid-cell ${ms.length ? "" : "empty"}`}>
                  {ms.map((m) => (
                    <div key={m.id} className={`collab-grid-msg ${open.has(m.id) ? "open" : ""}`} onClick={() => toggle(m.id)} title={open.has(m.id) ? "Fold" : "Open"}>
                      <div className="collab-msg-head">
                        <StancePill m={m} />
                        <ApproveButton room={room} m={m} call={call} />
                      </div>
                      <div className="collab-text">{open.has(m.id) ? m.text : summaryOf(m.text)}</div>
                    </div>
                  ))}
                  {thinking && <div className="collab-grid-thinking">thinking…</div>}
                </div>
              );
            })}
          </React.Fragment>
        ))}
        {after.map(yours)}
      </div>
      <div ref={endRef} />
    </div>
  );
}

/** A model's tool call waiting on the user; its turn is paused until they answer. */
function AskCard({ room, req, label, color, call }: { room: CollabRoom; req: CollabPermissionRequest; label: Record<string, string>; color: Record<string, number>; call: Call }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const answer = (d: "allow" | "deny" | "always") => call("permission", () => window.mb.collabPermission(room.id, req.id, d));
  return (
    <div className={`collab-ask-card c-${color[req.seat] ?? 0}`}>
      <div className="collab-msg-head">
        <span className={`seat-dot c-${color[req.seat] ?? 0}`} />
        <span className="who">{label[req.seat] ?? req.seat}</span>
        <span className="collab-meta">asks to {req.tool === "Bash" ? "run" : `use ${req.tool}`}</span>
        <span className="collab-ask-timer" title={`Denied automatically after ${room.askTimeoutMin ?? 10} minutes`}>
          waiting {waited(req.at, now)} of {room.askTimeoutMin ?? 10}m
        </span>
      </div>
      {req.description && <div className="collab-ask-why">{req.description}</div>}
      <pre className="collab-ask-detail">{req.detail}</pre>
      {["Edit", "Write", "MultiEdit"].includes(req.tool) && <div className="collab-ask-warn">This writes outside the test copy — possibly into your own code.</div>}
      <div className="set-actions">
        <button className="primary" onClick={() => answer("allow")}>Allow</button>
        {req.kind && (
          <button className="outline" onClick={() => answer("always")}>
            Always allow <code>{req.kind.replace(/^Bash: /, "").replace(/^(\w+): /, "$1 in ")}</code>
          </button>
        )}
        <button className="outline" onClick={() => answer("deny")}>Deny</button>
      </div>
    </div>
  );
}

/** Everything about the room that isn't the conversation: who's in it, what they may do, the test copy, the plan. */
function Inspector({
  room,
  busy,
  call,
  setError,
  onEditModels,
  onJump,
  onOpenSession,
  onDeleted,
}: {
  room: CollabRoom;
  busy: string;
  call: Call;
  setError: (e: string) => void;
  onEditModels: () => void;
  onJump: (messageId: string) => void;
  onOpenSession: (id: string) => void;
  onDeleted: () => void;
}) {
  const seated = room.participants.filter((p) => !p.removed);
  const runsCommands = !!room.repoPath && seated.some((p) => p.runsCommands);
  const planMsg = [...room.messages].reverse().find((m) => m.kind === "plan" || (room.plan && m.text === room.plan.text && m.speaker === room.plan.by));
  return (
    <aside className="collab-inspector">
      <section>
        <div className="ins-head">
          Models
          <button className="link" onClick={onEditModels}>Edit</button>
        </div>
        {seated.map((p) => (
          <div key={p.key} className={`ins-model c-${p.color} ${room.speaking === p.key ? "speaking" : ""}`} title={`${p.model}${p.effort ? ` · effort ${p.effort}` : ""}`}>
            <span className={`seat-dot c-${p.color}`} />
            <span className="who">{p.label}</span>
            {p.effort && <span className="ins-eff">{p.effort}</span>}
            <span className="ins-perms">
              {room.repoPath && p.readsCode && <span title="Reads the code">{"</>"}</span>}
              {room.repoPath && p.runsCommands && <span title="Runs commands in the test copy">{"$_"}</span>}
              {room.repoPath && p.usesDocker && <span title="Uses Docker">docker</span>}
              {room.repoPath && !p.readsCode && <span className="off" title="Asks a code reader">no code</span>}
            </span>
          </div>
        ))}
        {room.speaking && <div className="ins-note">{room.participants.find((p) => p.key === room.speaking)?.label} is taking its turn…</div>}
      </section>

      <section>
        <div className="ins-head">Repository</div>
        <div className="ins-value" title={room.repoPath ?? undefined}>{room.repoPath ? room.repoPath.split("/").pop() : "None — models discuss without code"}</div>
      </section>

      {runsCommands && (
        <section>
          <div className="ins-head">
            Test copy
            {room.workspacePath && (
              <button
                className="link"
                disabled={room.running || !!busy}
                title="Throw it away; the next command turn copies the repository again, with your latest changes"
                onClick={() => call("reset", () => window.mb.collabResetCopy(room.id))}
              >
                Reset
              </button>
            )}
          </div>
          <div className="ins-value" title={room.workspacePath ?? undefined}>
            {room.workspacePath ? "Ready — commands run here, never in your checkout" : "Made on the next turn that runs commands"}
          </div>
        </section>
      )}

      {seated.some((p) => p.agent === "claude") && (
        <section>
          <div className="ins-head">Approvals</div>
          <label className="ins-row" title="How long a model's request waits for you before it counts as no; the model's turn waits with it">
            Wait for my answer
            <select value={room.askTimeoutMin ?? 10} onChange={(e) => call("timeout", () => window.mb.collabAskTimeout(room.id, Number(e.target.value)))}>
              {[5, 10, 15, 20].map((m) => (
                <option key={m} value={m}>{m} min</option>
              ))}
            </select>
          </label>
          {!!room.allowKinds?.length && <div className="ins-note">Always allowed here:</div>}
          {!!room.allowKinds?.length && (
            <div className="collab-kinds">
              {room.allowKinds.map((k) => (
                <span key={k} className="collab-kind">
                  <code>{k.replace(/^Bash: /, "").replace(/^(\w+): /, "$1 in ")}</code>
                  <button className="icon" title="Ask me again" onClick={() => call("revoke", () => window.mb.collabRevokeKind(room.id, k))}>✕</button>
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="ins-head">Plan</div>
        {!room.plan ? (
          <>
            <div className="ins-value">Not written yet. Approve a model's message, or have one write the plan up.</div>
            {!room.running && (
              <SynthMenu room={room} busy={busy === "synth"} onPick={(k) => call("synth", () => window.mb.collabSynthesize(room.id, k))} />
            )}
          </>
        ) : (
          <>
            <div className="ins-value">
              {room.plan.approved ? "Approved" : "Written — waiting for your approval"} · by {room.participants.find((p) => p.key === room.plan!.by)?.label ?? room.plan.by}
            </div>
            <div className="ins-actions">
              {planMsg && <button className="link" onClick={() => onJump(planMsg.id)}>Show the plan</button>}
              {room.implementedIn ? (
                <button className="outline" onClick={() => onOpenSession(room.implementedIn!)}>Open the implementing session</button>
              ) : room.plan.approved ? (
                room.repoPath ? <ImplementMenu room={room} onDone={(id) => onOpenSession(id)} setError={setError} /> : <span className="ins-note">Add a repository to implement it</span>
              ) : (
                planMsg && <button className="outline strong" onClick={() => call("approve", () => window.mb.collabApprove(room.id, planMsg.id))}>Approve plan</button>
              )}
            </div>
          </>
        )}
      </section>

      <section className="ins-foot">
        <button
          className="link danger"
          onClick={() => window.confirm(`Delete "${room.title}"?`) && call("delete", () => window.mb.collabDelete(room.id)).then((r) => !isErr(r) && onDeleted())}
        >
          Delete room
        </button>
      </section>
    </aside>
  );
}

function SynthMenu({ room, busy, onPick }: { room: CollabRoom; busy: boolean; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="collab-menu">
      <button className="outline" disabled={busy || room.round === 0} onClick={() => setOpen((o) => !o)} title="Have one model turn the discussion into a written plan for you to approve">
        {busy ? "Writing plan…" : "Write up plan ▾"}
      </button>
      {open && (
        <div className="collab-pop">
          {room.participants.filter((p) => !p.removed).map((p) => (
            <button key={p.key} onClick={() => { setOpen(false); onPick(p.key); }}>{p.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}

function ImplementMenu({ room, onDone, setError }: { room: CollabRoom; onDone: (sessionId: string) => void; setError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const models = room.participants.filter((p) => !p.removed);
  return (
    <span className="collab-menu">
      <button className="primary" onClick={() => setOpen((o) => !o)} title="Start a session that makes the changes, on a new branch in its own worktree">
        Implement with ▾
      </button>
      {open && (
        <div className="collab-pop">
          {models.map((m) => (
            <button
              key={m.key}
              onClick={async () => {
                setOpen(false);
                const r = await window.mb.collabImplement(room.id, m.key);
                if (isErr(r)) setError(r.error);
                else onDone(r.id);
              }}
            >
              {m.label}
              {m.effort ? ` · ${m.effort}` : ""}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Edit a room's seats: which models, in what order, their effort, and who may read the code. */
function SeatEditor({
  seats,
  onChange,
  catalog,
  hasRepo,
  colors = {},
}: {
  seats: CollabParticipantSpec[];
  onChange: (s: CollabParticipantSpec[]) => void;
  catalog: Catalog;
  hasRepo: boolean;
  colors?: Record<string, number>; // existing seats keep their room color
}) {
  const set = (i: number, patch: Partial<CollabParticipantSpec>) => onChange(seats.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= seats.length) return;
    const next = [...seats];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const presetOf = (s: CollabParticipantSpec) => catalog.presets.find((m) => m.agent === s.agent && m.model === s.model)?.key ?? CUSTOM;
  const unused = catalog.presets.find((m) => !seats.some((s) => s.agent === m.agent && s.model === m.model));
  const readers = seats.filter((s) => s.readsCode).length;
  return (
    <div className="seat-editor">
      {seats.map((s, i) => {
        const preset = presetOf(s);
        return (
          <div key={s.key ?? `new-${i}`} className="seat-row">
            <span className={`seat-dot c-${(s.key !== undefined ? colors[s.key] : undefined) ?? i % 6}`} />
            <select
              value={preset}
              title={s.key ? "Changing the model starts it on a fresh conversation" : undefined}
              onChange={(e) => {
                const m = catalog.presets.find((x) => x.key === e.target.value);
                if (m) set(i, { label: m.label, agent: m.agent, model: m.model, effort: null, key: undefined });
                else set(i, { label: "", model: "", key: undefined });
              }}
            >
              {catalog.presets.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
              <option value={CUSTOM}>Other model…</option>
            </select>
            {preset === CUSTOM && (
              <>
                <select value={s.agent} onChange={(e) => set(i, { agent: e.target.value as AgentKind, effort: null, key: undefined })}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
                <input
                  type="text"
                  placeholder={s.agent === "codex" ? "gpt-6-astra-mini" : "claude-sonnet-5"}
                  value={s.model}
                  onChange={(e) => set(i, { model: e.target.value, label: e.target.value, key: undefined })}
                />
              </>
            )}
            <select value={s.effort ?? ""} onChange={(e) => set(i, { effort: e.target.value || null })} title="Effort / reasoning level">
              <option value="">default effort</option>
              {catalog.efforts[s.agent].map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
            {hasRepo ? (
              <>
                <label className="seat-code" title="May read the room's repository; models that can't, ask the first one that can">
                  <input
                    type="checkbox"
                    checked={s.readsCode}
                    onChange={(e) => set(i, e.target.checked ? { readsCode: true } : { readsCode: false, runsCommands: false, usesDocker: false })}
                  />
                  reads code
                </label>
                <label className="seat-code" title="May run tests, builds and scripts in a disposable copy of the repository — never your checkout. Implies reading the code.">
                  <input
                    type="checkbox"
                    checked={!!s.runsCommands}
                    onChange={(e) => set(i, e.target.checked ? { runsCommands: true, readsCode: true } : { runsCommands: false, usesDocker: false })}
                  />
                  runs commands
                </label>
                <label
                  className="seat-code"
                  title="May use Docker: start, stop and run containers. Docker works outside the sandbox — a container can mount any folder — so this model is no longer limited to the test copy. Implies running commands."
                >
                  <input
                    type="checkbox"
                    checked={!!s.usesDocker}
                    onChange={(e) => set(i, e.target.checked ? { usesDocker: true, runsCommands: true, readsCode: true } : { usesDocker: false })}
                  />
                  uses Docker
                </label>
              </>
            ) : (
              <span className="seat-code off" title="Pick a repository to choose which models read the code">no repository</span>
            )}
            <span className="seat-move">
              <button className="icon" disabled={i === 0} onClick={() => move(i, -1)} title="Speak earlier">↑</button>
              <button className="icon" disabled={i === seats.length - 1} onClick={() => move(i, 1)} title="Speak later">↓</button>
            </span>
            <button className="icon danger" title="Remove from the room" onClick={() => onChange(seats.filter((_, j) => j !== i))}>✕</button>
          </div>
        );
      })}
      <div className="seat-add">
        <button
          className="outline"
          onClick={() => {
            const m = unused ?? catalog.presets[0];
            onChange([...seats, { label: unused ? m.label : "", agent: m.agent, model: unused ? m.model : "", effort: null, readsCode: true, runsCommands: false, usesDocker: false }]);
          }}
        >
          Add model
        </button>
        {hasRepo && seats.length > 0 && (
          <span className="wi-note">{readers === seats.length ? "all of them can read the code" : `${readers} of ${seats.length} can read the code`}</span>
        )}
      </div>
    </div>
  );
}

/** The room's repository: what code readers read and where an approved plan is implemented. */
function RepoPicker({ value, onChange, bare }: { value: string; onChange: (v: string) => void; bare?: boolean }) {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    window.mb.listRepos().then((r: Result<RepoEntry[]>) => (isErr(r) ? setError(`Couldn't list repos: ${r.error}`) : setRepos(r)));
  }, []);
  const select = (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No repository — ideas only</option>
      {value && !repos.some((r) => r.path === value) && <option value={value}>{value.split("/").pop()}</option>}
      {repos.map((r) => (
        <option key={r.path} value={r.path}>{r.name}</option>
      ))}
    </select>
  );
  return (
    <>
      {bare ? select : <div className="repo-picker"><span className="wi-note">Repository</span>{select}</div>}
      {error && <div className="err">{error}</div>}
    </>
  );
}
