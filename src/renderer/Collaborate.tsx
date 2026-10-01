import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CollabMode, CollabModel, CollabRoom, RepoEntry } from "../shared/types";

const MODES: { id: CollabMode; label: string; note: string }[] = [
  { id: "step", label: "Step", note: "one round, then waits for you" },
  { id: "auto", label: "Auto", note: "runs a set number of rounds" },
  { id: "consensus", label: "Until agreed", note: "stops when every model agrees" },
];
const nextMode = (m: CollabMode): CollabMode => MODES[(MODES.findIndex((x) => x.id === m) + 1) % MODES.length].id;

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);

/** Rooms where several models discuss an idea; edits only happen after the user approves a plan. */
export function CollaborateView({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const [rooms, setRooms] = useState<CollabRoom[]>([]);
  const [models, setModels] = useState<CollabModel[]>([]);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    window.mb.collabModels().then(setModels);
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
            models={models}
            onCreated={(r) => {
              setRooms((rs) => [r, ...rs.filter((x) => x.id !== r.id)]);
              setSelected(r.id);
              window.mb.collabRun(r.id);
            }}
          />
        ) : (
          <Room
            room={room}
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

function NewRoom({ models, onCreated }: { models: CollabModel[]; onCreated: (r: CollabRoom) => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [mode, setMode] = useState<CollabMode>("auto");
  const [error, setError] = useState("");
  useEffect(() => setPicked(models.map((m) => m.key)), [models]);
  useEffect(() => {
    window.mb.listRepos().then((r: Result<RepoEntry[]>) => (isErr(r) ? setError(`Couldn't list repos: ${r.error}`) : setRepos(r)));
  }, []);
  const create = async () => {
    const r: Result<CollabRoom> = await window.mb.collabCreate({ title, brief, repoPath: repo || null, models: picked, mode });
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
      <label>Models <span className="wi-note">they speak in this order</span></label>
      <div className="collab-models">
        {models.map((m) => (
          <label key={m.key} className={`collab-model c-${m.key} ${picked.includes(m.key) ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={picked.includes(m.key)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.key] : p.filter((k) => k !== m.key)))}
            />
            {m.label}
            <span className="via">via {m.agent === "codex" ? "Codex" : "Claude Code"}</span>
          </label>
        ))}
      </div>
      <label>Title</label>
      <input type="text" placeholder="CSV export for the donor list" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label>The idea or feature</label>
      <textarea
        rows={7}
        placeholder="We need a way to export the donor list to CSV from the backoffice. It has to respect the user's filters and handle 200k rows…"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <label>Repository <span className="wi-note">optional — read-only while they discuss</span></label>
      <select value={repo} onChange={(e) => setRepo(e.target.value)}>
        <option value="">No repository — ideas only</option>
        {repos.map((r) => (
          <option key={r.path} value={r.path}>{r.name}</option>
        ))}
      </select>
      <label>Pacing</label>
      <ModeSeg mode={mode} onMode={setMode} />
      {error && <div className="err">{error}</div>}
      <div className="set-actions">
        <button className="primary" disabled={!brief.trim() || picked.length < 2} onClick={create}>
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

function Room({ room, onDeleted, onOpenSession }: { room: CollabRoom; onDeleted: () => void; onOpenSession: (id: string) => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const label = useMemo(() => Object.fromEntries(room.participants.map((p) => [p.key, p.label])), [room.participants]);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [room.messages.length, room.speaking]);

  const call = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    const r = await fn();
    setBusy("");
    if (isErr(r)) setError(r.error);
    return r;
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
          {room.participants.map((p) => (
            <span key={p.key} className={`collab-chip c-${p.key} ${room.speaking === p.key ? "speaking" : ""}`}>{p.label}</span>
          ))}
        </div>
        <button className="icon" title="Delete this room" onClick={() => window.confirm(`Delete "${room.title}"?`) && call("delete", () => window.mb.collabDelete(room.id)).then((r) => !isErr(r) && onDeleted())}>
          ✕
        </button>
      </header>

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
          <div key={m.id} className={`collab-msg ${m.speaker === "you" ? "you" : m.speaker === "system" ? "sys" : `c-${m.speaker}`} ${m.kind ?? ""}`}>
            {m.speaker !== "system" && (
              <div className="collab-msg-head">
                <span className="who">{m.speaker === "you" ? "You" : label[m.speaker] ?? m.speaker}</span>
                {m.round > 0 && m.speaker !== "you" && <span className="wi-note">round {m.round}</span>}
                {m.kind === "plan" && <span className="collab-stance plan">plan</span>}
                {m.stance && <span className={`collab-stance ${m.stance}`}>{m.stance === "agree" ? "agrees" : "continue"}</span>}
                {m.speaker !== "you" && m.kind !== "error" && (
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
          <div className={`collab-msg thinking c-${room.speaking}`}>
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
  const [models, setModels] = useState<CollabModel[]>([]);
  useEffect(() => {
    window.mb.collabModels().then(setModels);
  }, []);
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
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
