import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentKind, CollabMode, CollabModel, CollabParticipantSpec, CollabRoom, RepoEntry } from "../shared/types";

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

/** Rooms where several models discuss an idea; edits only happen after the user approves a plan. */
export function CollaborateView({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const [rooms, setRooms] = useState<CollabRoom[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({ presets: [], efforts: { claude: [], codex: [] } });
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState("");

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

  const room = rooms.find((r) => r.id === selected) ?? null;

  return (
    <div className="collab">
      <aside className="collab-rooms">
        <button className="primary collab-new" onClick={() => setSelected("new")}>New room</button>
        {rooms.map((r) => (
          <button key={r.id} className={`collab-room-row ${r.id === selected ? "on" : ""}`} onClick={() => setSelected(r.id)}>
            <span className="t">
              {r.running && <span className="dot sm working" />}
              {r.title}
            </span>
            <span className="s">
              {r.participants.map((p) => p.label.replace(/^Claude /, "")).join(" · ")} · round {r.round}
              {r.plan?.approved ? " · plan approved" : ""}
            </span>
          </button>
        ))}
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

function Room({ room, catalog, onDeleted, onOpenSession }: { room: CollabRoom; catalog: Catalog; onDeleted: () => void; onOpenSession: (id: string) => void }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<CollabParticipantSpec[] | null>(null);
  const [repoDraft, setRepoDraft] = useState<string>(room.repoPath ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const label = useMemo(() => Object.fromEntries(room.participants.map((p) => [p.key, p.label])), [room.participants]);
  const color = useMemo(() => Object.fromEntries(room.participants.map((p) => [p.key, p.color])), [room.participants]);
  const seated = room.participants.filter((p) => !p.removed);
  const openModels = () => {
    setRepoDraft(room.repoPath ?? "");
    setEditing(seated.map((p) => ({ key: p.key, label: p.label, agent: p.agent, model: p.model, effort: p.effort, readsCode: p.readsCode, runsCommands: !!p.runsCommands, usesDocker: !!p.usesDocker })));
  };
  // braces matter: scrollIntoView returns a Promise in current Chromium, and React
  // would call a returned value as the effect's cleanup (crashing on unmount)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [room.messages.length, room.speaking]);

  const call = async (what: string, fn: () => Promise<unknown>) => {
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

  return (
    <div className="collab-room">
      <header className="collab-head">
        <div className="collab-title">
          <h2>{room.title}</h2>
          <span className="wi-note">
            {room.repoPath ? `reads ${room.repoPath.split("/").pop()}` : "no repository"} · round {room.round}
          </span>
        </div>
        <div className="collab-people">
          {seated.map((p) => (
            <span
              key={p.key}
              className={`collab-chip c-${p.color} ${room.speaking === p.key ? "speaking" : ""}`}
              title={`${p.model}${p.effort ? ` · effort ${p.effort}` : ""}${
                room.repoPath
                  ? p.runsCommands
                    ? ` · reads the code, runs commands in a test copy${p.usesDocker ? ", uses Docker" : ""}`
                    : p.readsCode
                      ? " · reads the code"
                      : " · no code access"
                  : ""
              }`}
            >
              {p.label}
              {p.effort && <span className="eff">{p.effort}</span>}
              {room.repoPath && p.readsCode && <span className="eff" aria-label="reads the code">{"</>"}</span>}
              {room.repoPath && p.runsCommands && <span className="eff" aria-label="runs commands">{"$_"}</span>}
              {room.repoPath && p.usesDocker && <span className="eff" aria-label="uses Docker">docker</span>}
            </span>
          ))}
          <button className="outline" onClick={() => (editing ? setEditing(null) : openModels())}>Models</button>
          {room.workspacePath && (
            <button
              className="outline"
              disabled={room.running || !!busy}
              title={`Models run commands in ${room.workspacePath}. Resetting throws it away; the next turn copies the repository again, with your latest changes.`}
              onClick={() => call("reset", () => window.mb.collabResetCopy(room.id))}
            >
              Reset test copy
            </button>
          )}
        </div>
        <button className="icon" title="Delete this room" onClick={() => window.confirm(`Delete "${room.title}"?`) && call("delete", () => window.mb.collabDelete(room.id)).then((r) => !isErr(r) && onDeleted())}>
          ✕
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

      {room.plan && (
        <div className={`collab-plan ${room.plan.approved ? "approved" : ""}`}>
          <div className="collab-plan-head">
            <strong>{room.plan.approved ? "Approved plan" : "Plan — waiting for your approval"}</strong>
            <span className="wi-note">by {label[room.plan.by] ?? room.plan.by}</span>
            {room.implementedIn ? (
              <button className="outline" onClick={() => onOpenSession(room.implementedIn!)}>Open the implementing session</button>
            ) : room.plan.approved ? (
              room.repoPath ? (
                <ImplementMenu room={room} onDone={(id) => onOpenSession(id)} setError={setError} />
              ) : (
                <span className="wi-note">add a repository to implement it</span>
              )
            ) : (
              <button
                className="outline strong"
                onClick={() => {
                  const m = [...room.messages].reverse().find((x) => x.kind === "plan");
                  if (m) call("approve", () => window.mb.collabApprove(room.id, m.id));
                }}
              >
                Approve plan
              </button>
            )}
          </div>
        </div>
      )}

      <div className="collab-transcript">
        {room.messages.map((m) => (
          <div key={m.id} className={`collab-msg ${m.speaker === "you" ? "you" : m.speaker === "system" ? "sys" : `c-${color[m.speaker] ?? 0}`} ${m.kind ?? ""}`}>
            {m.speaker !== "system" && (
              <div className="collab-msg-head">
                <span className="who">{m.speaker === "you" ? "You" : label[m.speaker] ?? m.speaker}</span>
                {m.kind === "lookup" && <span className="wi-note">looked up the code for {label[m.askedBy ?? ""] ?? m.askedBy}</span>}
                {m.round > 0 && m.speaker !== "you" && <span className="wi-note">round {m.round}</span>}
                {m.kind === "plan" && <span className="collab-stance plan">plan</span>}
                {m.stance && <span className={`collab-stance ${m.stance}`}>{m.stance === "agree" ? "agrees" : "continue"}</span>}
                {m.speaker !== "you" && m.kind !== "error" && m.kind !== "lookup" && (
                  <button
                    className="collab-approve"
                    title="Approve this as the plan — then a model can implement it"
                    onClick={() => call("approve", () => window.mb.collabApprove(room.id, m.id))}
                  >
                    Approve
                  </button>
                )}
              </div>
            )}
            <div className="collab-text">{m.text}</div>
          </div>
        ))}
        {room.speaking && (
          <div className={`collab-msg thinking c-${color[room.speaking] ?? 0}`}>
            <span className="who">{label[room.speaking]}</span> is thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>

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
            <>
              <SynthMenu room={room} busy={busy === "synth"} onPick={(k) => call("synth", () => window.mb.collabSynthesize(room.id, k))} />
              <button className="outline" onClick={() => window.mb.collabRun(room.id)}>
                {room.mode === "step" ? "Next round" : "Run"}
              </button>
            </>
          )}
          <button className="primary" disabled={!draft.trim()} onClick={send}>Send</button>
        </div>
      </footer>
    </div>
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
          {room.participants.map((p) => (
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
