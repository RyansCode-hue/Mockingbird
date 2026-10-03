import React, { useEffect, useState } from "react";
import type { RunProfile, RunServiceState, SessionInfo } from "../shared/types";
import { SparkleIcon } from "./Icons";

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

interface ProfileInfo {
  worktree: string;
  repo: string;
  file: string;
  profile: RunProfile | null;
}
type Conflict = { port: number; service: string; pid: number | null; command: string };

const ACTIVE = new Set(["starting", "running", "stopping"]);
const DOT: Record<RunServiceState["status"], string> = { starting: "amber", running: "teal", stopping: "amber", stopped: "grey", failed: "red" };

const TEMPLATE = {
  services: [
    { name: "api", cwd: ".", command: "npm run dev -- --port ${port:api}", ports: [{ name: "api", base: 3000, url: "http://localhost:${port}" }], ready: { port: "api" } },
  ],
  prepare: { copy: [".env"], commands: [{ cwd: ".", command: "npm ci", ifMissing: "node_modules" }] },
  sideBySide: { slots: 3, step: 10 },
};

/**
 * Run and Debug for the focused session's worktree: its repository's services
 * with status, ports and logs; start, stop and restart; swap (one copy of the
 * app at a time, on its standard ports) or side by side (each worktree on its
 * own slot of ports); Prepare copies a new worktree's env files and installs.
 */
export function RunView({
  session,
  states,
  onShowLog,
  onAskSession,
}: {
  session: SessionInfo | null;
  states: RunServiceState[];
  onShowLog: (runId: string) => void;
  /** Type a request into the session's pane (to fix a blocker in the code). */
  onAskSession: (text: string) => void;
}) {
  const [info, setInfo] = useState<Result<ProfileInfo> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState<{ list: Conflict[]; services?: string[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [mode, setMode] = useState<"swap" | "side">("swap");
  const sid = session?.id ?? null;

  const load = () => sid && window.mb.runProfile(sid).then((r: Result<ProfileInfo>) => setInfo(r));
  useEffect(() => {
    setInfo(null);
    setError("");
    setConflicts(null);
    setEditing(null);
    load();
  }, [sid]);
  const repoKey = info && !isErr(info) ? info.repo : "";
  useEffect(() => {
    if (!repoKey) return;
    try {
      setMode(JSON.parse(localStorage.getItem(`mb.run.mode:${repoKey}`) ?? '"swap"'));
    } catch {
      setMode("swap");
    }
  }, [repoKey]);
  const pickMode = (m: "swap" | "side") => {
    setMode(m);
    try {
      localStorage.setItem(`mb.run.mode:${repoKey}`, JSON.stringify(m));
    } catch {
      /* not remembered; still applies now */
    }
  };

  if (!session) return <div className="fp-note">Click into a session to run its worktree.</div>;
  if (info === null) return <div className="fp-note">loading…</div>;
  if (isErr(info)) return <div className="fp-note err">{info.error}</div>;

  const { worktree, repo, profile } = info;
  const mine = states.filter((s) => s.worktree === worktree);
  const elsewhere = states.filter((s) => s.repo === repo && s.worktree !== worktree && ACTIVE.has(s.status));
  const stateOf = (name: string) => mine.find((s) => s.service === name);
  const slot = mine.find((s) => ACTIVE.has(s.status))?.slot;

  const act = async (what: string, fn: () => Promise<any>) => {
    setBusy(what);
    setError("");
    try {
      const r = await fn();
      if (isErr(r)) setError(r.error);
      return r;
    } finally {
      setBusy("");
    }
  };
  const start = async (services?: string[]) => {
    const r = await act("start", () => window.mb.runStart(session.id, { mode, services }));
    if (r && !isErr(r) && "blocked" in r) setConflicts({ list: r.blocked, services });
    else if (r && !isErr(r) && r.ids?.length) onShowLog(r.ids[r.ids.length - 1]);
  };
  const stopAndStart = async () => {
    if (!conflicts) return;
    const pids = [...new Set(conflicts.list.map((c) => c.pid).filter((p): p is number => p !== null))];
    const r = await act("free", () => window.mb.runStopListeners(session.id, pids));
    if (isErr(r)) return;
    const services = conflicts.services;
    setConflicts(null);
    await new Promise((res) => setTimeout(res, 800)); // give them a moment to let go of the ports
    await start(services);
  };
  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editing ?? "");
    } catch (err) {
      return setError(`That isn't valid JSON: ${(err as Error).message}`);
    }
    const r = await act("save", () => window.mb.runSaveProfile(session.id, parsed));
    if (!isErr(r)) {
      setEditing(null);
      setDraftNote("");
      load();
    }
  };
  const draft = async () => {
    setDraftNote("Claude is reading the repository (launch configs, scripts, compose files, README) — this takes a minute or two…");
    const r = await act("draft", () => window.mb.runDraft(session.id));
    if (isErr(r)) return setDraftNote("");
    setEditing(JSON.stringify("profile" in r ? stripRepo(r.profile) : safeParse(r.raw) ?? r.raw, null, 2));
    setDraftNote("profile" in r ? "Here's the draft — check the commands and ports, then save." : `The draft needs fixing before it can be saved: ${r.error}`);
  };

  const header = (
    <div className="rv-head">
      <div className="rv-repo" title={worktree}>
        {baseName(repo)}
        <span className="rv-wt">{worktree === repo ? "main checkout" : baseName(worktree)}</span>
      </div>
      <span className="fp-seg rv-mode" title="Swap: one copy of the app at a time on its standard ports — starting here stops it in other worktrees. Side by side: each worktree gets its own ports (+10 per slot).">
        <button className={mode === "swap" ? "on" : ""} onClick={() => pickMode("swap")}>Swap</button>
        <button className={mode === "side" ? "on" : ""} onClick={() => pickMode("side")}>Side by side</button>
      </span>
    </div>
  );

  if (editing !== null) {
    return (
      <div className="rv">
        {header}
        {draftNote && <div className="fp-note">{draftNote}</div>}
        <textarea className="rv-json" spellCheck={false} value={editing} onChange={(e) => setEditing(e.target.value)} />
        {error && <div className="fp-note err">{error}</div>}
        <div className="rv-bar">
          <button className="primary" disabled={!!busy} onClick={save}>{busy === "save" ? "Saving…" : "Save"}</button>
          <button className="outline" onClick={() => (setEditing(null), setError(""), setDraftNote(""))}>Cancel</button>
          <span className="rv-hint">${"{port:name}"} · ${"{slot}"} · ${"{worktree}"}</span>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="rv">
        {header}
        <div className="rv-empty">
          <p>
            There's no run setup for <b>{baseName(repo)}</b> yet. Claude can draft one from its launch configs, scripts, compose files and README — you review it before
            anything runs.
          </p>
          <button className="primary" disabled={!!busy} onClick={draft}>
            <SparkleIcon /> {busy === "draft" ? "Drafting…" : "Draft with Claude"}
          </button>
          <button className="outline" onClick={() => setEditing(JSON.stringify(TEMPLATE, null, 2))}>Write it yourself</button>
          {draftNote && <div className="fp-note">{draftNote}</div>}
          {error && <div className="fp-note err">{error}</div>}
        </div>
      </div>
    );
  }

  const anyActive = mine.some((s) => ACTIVE.has(s.status));
  const preparing = mine.find((s) => s.service === "prepare" && ACTIVE.has(s.status));
  return (
    <div className="rv">
      {header}
      <div className="rv-bar">
        <button className="primary" disabled={!!busy || !!preparing} onClick={() => start()} title={mode === "swap" && elsewhere.length ? `Stops it in ${[...new Set(elsewhere.map((s) => baseName(s.worktree)))].join(", ")} first` : "Start every service"}>
          ▶ {busy === "start" ? "Starting…" : "Start all"}
        </button>
        <button className="outline" disabled={!!busy || !anyActive} onClick={() => act("stop", () => window.mb.runStop(session.id))}>
          ■ Stop all
        </button>
        <button className="outline" disabled={!!busy || !!preparing} title="Copy the gitignored files this worktree needs (env files, certs) from the main checkout, then install what's missing" onClick={async () => {
          const r = await act("prepare", () => window.mb.runPrepare(session.id));
          if (r && !isErr(r) && r.id) onShowLog(r.id);
          else if (r && !isErr(r)) setError([r.copied.length ? `Copied ${r.copied.join(", ")}` : "", r.missing.length ? `Not found in the main checkout: ${r.missing.join(", ")}` : "", "Nothing to install."].filter(Boolean).join(" · "));
        }}>
          {preparing || busy === "prepare" ? "Preparing…" : "Prepare"}
        </button>
        <button className="icon" title="Edit the run setup" onClick={() => setEditing(JSON.stringify(stripRepo(profile), null, 2))}>✎</button>
      </div>
      {slot !== undefined && slot > 0 && <div className="fp-note">Slot {slot} — ports +{slot * (profile.sideBySide?.step ?? 10)}</div>}
      {conflicts && (
        <div className="rv-conflict">
          {conflicts.list.map((c) => (
            <div key={`${c.port}:${c.pid}`}>
              Port <b>{c.port}</b> ({c.service}) is in use by <b>{c.command}</b>
              {c.pid ? ` (pid ${c.pid})` : ""}.
            </div>
          ))}
          <div className="rv-bar">
            {conflicts.list.some((c) => c.pid) && <button className="outline danger-btn" onClick={stopAndStart}>Stop {conflicts.list.length === 1 ? "it" : "them"} and start</button>}
            <button className="outline" onClick={() => setConflicts(null)}>Cancel</button>
            {mode === "swap" && (profile.sideBySide?.slots ?? 3) > 0 && (
              <button className="outline" onClick={() => (pickMode("side"), setConflicts(null))} title="Run beside it on other ports instead">
                Use side by side
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div className="fp-note err">{error}</div>}
      <div className="fp-scroll">
        {profile.services.map((s) => {
          const st = stateOf(s.name);
          const active = st && ACTIVE.has(st.status);
          return (
            <div key={s.name} className="rv-svc" onClick={() => st && onShowLog(st.id)} title={st?.error ?? (st ? "Show its log" : s.command)}>
              <span className={`rv-dot ${st ? DOT[st.status] : "grey"}`} />
              <span className="rv-name">{s.name}</span>
              <span className="rv-ports">
                {(st?.ports ?? (s.ports ?? []).map((p) => ({ name: p.name, port: p.base, url: undefined as string | undefined }))).map((p) =>
                  p.url && active ? (
                    <a key={p.name} className="rv-port live" title={`Open ${p.url}`} onClick={(e) => (e.stopPropagation(), window.mb.openExternal(p.url))}>
                      :{p.port}
                    </a>
                  ) : (
                    <span key={p.name} className="rv-port">:{p.port}</span>
                  )
                )}
              </span>
              <span className="rv-acts" onClick={(e) => e.stopPropagation()}>
                {active ? (
                  <>
                    <button className="icon" title="Restart" disabled={!!busy} onClick={async () => (await act("stop", () => window.mb.runStop(session.id, [s.name])), start([s.name]))}>↻</button>
                    <button className="icon" title="Stop (and what depends on it)" disabled={!!busy} onClick={() => act("stop", () => window.mb.runStop(session.id, [s.name]))}>■</button>
                  </>
                ) : (
                  <button className="icon" title="Start (and what it depends on)" disabled={!!busy} onClick={() => start([s.name])}>▶</button>
                )}
              </span>
              {st?.status === "failed" && <div className="rv-err">{st.error}</div>}
              {st?.status === "running" && st.error && <div className="rv-err warn">{st.error}</div>}
            </div>
          );
        })}
        {elsewhere.length > 0 && (
          <div className="rv-else">
            Also running: {[...new Set(elsewhere.map((s) => `${baseName(s.worktree)} (slot ${s.slot})`))].join(", ")}
            {mode === "swap" && " — Start here stops it there first."}
          </div>
        )}
        {(profile.blockers?.length ?? 0) > 0 && (
          <div className="rv-sec">
            <div className="ex-sec">Before running side by side</div>
            {profile.blockers!.map((b, i) => (
              <div key={i} className="rv-blocker">
                <div>{b.what}</div>
                <code>{b.fix}</code>
                <button className="outline" title="Type this request into the session's terminal" onClick={() => onAskSession(`Make this change so the app can run beside other worktrees: ${b.what}. Change: ${b.fix}`)}>
                  Ask the session to fix
                </button>
              </div>
            ))}
          </div>
        )}
        {(profile.notes?.length ?? 0) > 0 && (
          <div className="rv-sec">
            <div className="ex-sec">Notes</div>
            {profile.notes!.map((n, i) => (
              <div key={i} className="rv-note">{n}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The profile without its repo path, which is implied by where it's saved. */
function stripRepo(p: RunProfile) {
  const { repo: _repo, ...rest } = p;
  return rest;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
