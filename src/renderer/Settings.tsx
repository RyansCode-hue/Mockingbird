import React, { useEffect, useMemo, useState } from "react";
import { Pick } from "./Menu";
import { reachesBroadcast, titleOf } from "./appModel";
import { PresetsSection } from "./Presets";
import { getFormatOnSave, setFormatOnSave } from "./CodeEditor";
import { isErr, type AgentCheck, type BroadcastOutcome, type SetupStatus, type SessionInfo, type SessionPreset, type Settings, type WorktreeEntry, type OptionalTab } from "../shared/types";
import { OPTIONAL_TABS } from "../shared/types";
import { loadLS } from "./uiUtil";
import { TAB_LABELS } from "./tabs";

/** The Settings tab, with the worktree janitor and the control room (broadcast + CLAUDE.md). */

// ---- broadcast + CLAUDE.md control room (design 1g) ----
type DeliveryState = { state: "delivered" | "queued" | "skipped"; at?: string; note?: string };

function ControlRoomPanel({ sessions }: { sessions: SessionInfo[] }) {
  const repoPaths = useMemo(
    () => [...new Set(sessions.filter((s) => s.repoPath).map((s) => s.repoPath!))],
    [sessions]
  );
  const [target, setTarget] = useState("~/.claude/CLAUDE.md");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loadedPath, setLoadedPath] = useState("");
  const [message, setMessage] = useState("");
  const [bError, setBError] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delivery, setDelivery] = useState<Record<string, DeliveryState>>({});

  const [ioError, setIoError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; // a slower earlier read must not land on top of a newer target
    setIoError(null);
    window.mb
      .readClaudeMd(target)
      .then((r: { path: string; content: string } | { error: string }) => {
        if (!alive) return;
        if (isErr(r)) {
          // an unreadable file must never look like an empty one — saving that
          // empty editor back would overwrite the real CLAUDE.md
          setIoError(`Couldn't read ${target}: ${r.error}`);
          setContent("");
          setOriginal("");
          setLoadedPath(target);
          return;
        }
        setContent(r.content);
        setOriginal(r.content);
        setLoadedPath(r.path);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  const dirty = content !== original;
  const changedLines = useMemo(() => {
    if (!dirty) return 0;
    const a = original.split("\n");
    const b = content.split("\n");
    let n = Math.abs(b.length - a.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
    return n;
  }, [content, original, dirty]);

  // who a broadcast can reach (main skips shells, where it would run as
  // commands, debriefs, which are mid-interview, and dead panes)
  const live = sessions.filter(reachesBroadcast);
  // sessions that will be told to re-read: rooted in the repo, or all live for global
  const repoOf = target.replace(/\/CLAUDE\.md$/, "");
  const rereadTargets = target.startsWith("~")
    ? live
    : live.filter((s) => s.repoPath === repoOf);

  const bTargets = scope === "all" ? live : live.filter((s) => selected.has(s.id));

  const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // what main did with each pane: given it now, queued until its turn ends (or
  // its unsent prompt text is sent), or skipped
  const markDelivery = (outcomes: BroadcastOutcome[]) => {
    setDelivery((prev) => {
      const d: Record<string, DeliveryState> = { ...prev };
      for (const o of outcomes) {
        const s = sessions.find((x) => x.id === o.id);
        d[o.id] =
          o.outcome === "delivered" ? { state: "delivered", at: now(), note: `delivered ${now()}` }
          : o.outcome === "skipped" ? { state: "skipped", note: s?.status === "dead" ? "skipped · dead" : "skipped" }
          : { state: "queued", note: s?.status === "waiting" ? "queued · waiting on you" : s?.status === "idle" ? "queued · unsent text in its prompt" : "queued · busy" };
      }
      return d;
    });
  };

  // promote queued → delivered when a session's queue drains (visible per design 1g)
  useEffect(() => {
    setDelivery((prev) => {
      let changed = false;
      const d = { ...prev };
      for (const s of sessions) {
        if (d[s.id]?.state === "queued" && (s.queuedCount ?? 0) === 0 && s.status !== "working") {
          d[s.id] = { state: "delivered", at: now(), note: `delivered ${now()}` };
          changed = true;
        }
      }
      return changed ? d : prev;
    });
  }, [sessions]);

  const saveAndReread = async (broadcastToo: boolean) => {
    if (ioError) return; // don't write an editor we never managed to fill
    const r = await window.mb.saveClaudeMd(target, content);
    if (isErr(r)) {
      setIoError(`Couldn't save ${target}: ${r.error}`);
      return; // no broadcast — nothing was written to re-read
    }
    setIoError(null);
    setOriginal(content);
    if (broadcastToo && rereadTargets.length) {
      const b = await window.mb.broadcast({
        message: `Heads up: ${loadedPath} was just updated. Please re-read it now and apply it to all work going forward in this session.`,
        sessionIds: rereadTargets.map((s) => s.id),
        whenIdle: true,
      });
      if (isErr(b)) return setBError(`Saved, but couldn't ask the sessions to re-read it: ${b.error}`);
      setBError(null);
      markDelivery(b);
    }
  };

  const queueBroadcast = async () => {
    if (!message.trim() || !bTargets.length) return;
    const r = await window.mb.broadcast({ message, sessionIds: bTargets.map((s) => s.id), whenIdle: true });
    if (isErr(r)) return setBError(`Couldn't queue the broadcast: ${r.error}`);
    setBError(null);
    markDelivery(r);
    setMessage("");
  };

  return (
    <div className="control">
        <div className="editor">
          <div className="hd">
            <span className="t">CLAUDE.md</span>
            <span className="path">{loadedPath}</span>
            {dirty && <span className="unsaved">unsaved</span>}
            {ioError && <span className="err-inline">{ioError}</span>}
          </div>
          <Pick value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="~/.claude/CLAUDE.md">global — ~/.claude/CLAUDE.md</option>
            {repoPaths.map((p) => (
              <option key={p} value={`${p}/CLAUDE.md`}>{p.split("/").pop()} — {p}/CLAUDE.md</option>
            ))}
          </Pick>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          <div className="ft">
            <span className="diff">{dirty ? `${changedLines} line${changedLines === 1 ? "" : "s"} changed` : "no changes"}</span>
            <button className="outline" disabled={!dirty} onClick={() => saveAndReread(false)}>Save</button>
            <button className="primary" disabled={!dirty || !rereadTargets.length} onClick={() => saveAndReread(true)}>
              Save &amp; re-read in {rereadTargets.length}
            </button>
          </div>
        </div>

        <div className="rail-b">
          <div className="hd">
            <span className="t">Broadcast</span>
            <span className="unsaved kbd" style={{ color: "var(--text-4)" }}>⌘⇧B</span>
          </div>
          <div className="composer">
            <textarea
              placeholder="e.g. Run the linter before declaring anything done."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="pills">
              <button className={`pill ${scope === "all" ? "on" : ""}`} onClick={() => setScope("all")}>
                All ({live.length})
              </button>
              <button className={`pill ${scope === "selected" ? "on" : ""}`} onClick={() => setScope("selected")}>
                Selected ({selected.size})
              </button>
            </div>
            <button className="primary" disabled={!message.trim() || !bTargets.length} onClick={queueBroadcast}>
              Queue for {bTargets.length} session{bTargets.length === 1 ? "" : "s"}
            </button>
            {bError && <div className="err">{bError}</div>}
          </div>
          <div className="delivery">
            <div className="grp">Delivery</div>
            {sessions.filter((s) => !s.shell && !s.debrief).map((s) => {
              const d = delivery[s.id];
              const note =
                d?.note ??
                (s.status === "dead" ? "skipped · dead" : (s.queuedCount ?? 0) > 0 ? "queued · busy" : "");
              const cls = note.startsWith("delivered") ? "teal" : note.startsWith("queued") ? "amber" : "";
              return (
                <div
                  key={s.id}
                  className="drow"
                  style={{ cursor: scope === "selected" ? "pointer" : "default", opacity: scope === "selected" && !selected.has(s.id) ? 0.55 : 1 }}
                  onClick={() =>
                    scope === "selected" &&
                    setSelected((p) => {
                      const n = new Set(p);
                      n.has(s.id) ? n.delete(s.id) : n.add(s.id);
                      return n;
                    })
                  }
                >
                  <span className={`dot sm ${s.status}`} />
                  <span className="nm">{titleOf(s)}</span>
                  <span className={`st ${cls}`}>{note}</span>
                </div>
              );
            })}
          </div>
        </div>
    </div>
  );
}

// ---- settings tab: general config (with native pickers) + the control room ----

/** Settings card: every <repo>-worktrees checkout, with strays removable. */
function WorktreeJanitor() {
  const [list, setList] = useState<WorktreeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const load = async () => {
    const r = await window.mb.listWorktrees();
    if (isErr(r)) return setError(r.error);
    setError("");
    setList(r);
    // a rescan drops selections for worktrees that are gone or now in use
    const removable = new Set((r as WorktreeEntry[]).filter((w) => !w.inUse).map((w) => w.path));
    setSelected((s) => new Set([...s].filter((p) => removable.has(p))));
  };
  useEffect(() => {
    load();
  }, []);
  const riskOf = (w: WorktreeEntry) =>
    w.dirty
      ? `${w.name}: ${w.dirtyFiles} uncommitted file${w.dirtyFiles === 1 ? "" : "s"} will be lost`
      : w.ahead
        ? `${w.name}: ${w.ahead} unpushed commit${w.ahead === 1 ? "" : "s"} on ${w.branch} (the branch is kept)`
        : null;
  // one confirmation for the whole batch, listing every worktree that would lose work;
  // removals run one at a time and every failure is reported, not just the first
  const remove = async (ws: WorktreeEntry[]) => {
    if (ws.length === 0) return;
    const risks = ws.map(riskOf).filter(Boolean) as string[];
    const what = ws.length === 1 ? `the worktree folder ${ws[0].path}` : `${ws.length} worktree folders`;
    const msg = (risks.length ? `${risks.join("\n")}\n\n` : "") + `Remove ${what}?`;
    if (!window.confirm(msg)) return;
    setBusy("remove");
    const failures: string[] = [];
    for (const w of ws) {
      const r = await window.mb.removeWorktree(w.repoPath, w.path);
      if (isErr(r)) failures.push(`${w.name}: ${r.error}`);
    }
    setBusy(null);
    await load(); // reload first: it clears the error, and these failures must stay visible
    setError(failures.join(" · "));
  };
  const strays = list?.filter((w) => !w.inUse) ?? [];
  const chosen = strays.filter((w) => selected.has(w.path));
  const toggle = (path: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  const allChosen = strays.length > 0 && chosen.length === strays.length;
  const movable = list?.filter((w) => w.legacy && !w.inUse && !w.error) ?? [];
  const migrate = async (ws: WorktreeEntry[]) => {
    setBusy("migrate");
    const failures: string[] = [];
    for (const w of ws) {
      const r = await window.mb.migrateWorktree(w.repoPath, w.path);
      if (isErr(r)) failures.push(`${w.name}: ${r.error}`);
    }
    setBusy(null);
    await load(); // reload first: it clears the error, and these failures must stay visible
    setError(failures.join(" · "));
  };
  return (
    <div className="set-card">
      <h3>Worktrees</h3>
      <label>
        Isolated checkouts{" "}
        <span className="wi-note">
          one folder beside your repos: <code>worktrees/&lt;repo&gt;/&lt;branch&gt;</code> · {list ? `${list.length} total · ${strays.length} not in use` : "scanning…"}
        </span>
      </label>
      {movable.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 4 }}>
          <button className="outline" disabled={busy === "migrate"} onClick={() => migrate(movable)}>
            {busy === "migrate" ? "moving…" : `Move ${movable.length} old-layout worktree${movable.length === 1 ? "" : "s"} into worktrees/`}
          </button>
          <span className="wi-note">from <code>&lt;repo&gt;-worktrees/</code> · in-use ones are skipped</span>
        </div>
      )}
      {strays.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-start", gap: 10, marginTop: 4 }}>
          <label className="check-line" style={{ margin: 0, textTransform: "none", letterSpacing: 0 }}>
            <input
              type="checkbox"
              checked={allChosen}
              onChange={() => setSelected(allChosen ? new Set() : new Set(strays.map((w) => w.path)))}
            />
            <span>all {strays.length} not in use</span>
          </label>
          <button className="outline" disabled={chosen.length === 0 || busy === "remove"} onClick={() => remove(chosen)}>
            {busy === "remove" ? "removing…" : `Remove ${chosen.length || ""} selected`}
          </button>
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {list && list.length === 0 && <div className="wi-note">none — sessions are running in repo checkouts</div>}
      {list && list.length > 0 && (
        <div className="wt-list">
          {list.map((w) => (
            <div key={w.path} className={`wt-row ${w.inUse ? "live" : ""} ${selected.has(w.path) ? "sel" : ""}`}>
              <input
                type="checkbox"
                className="wt-check"
                disabled={w.inUse}
                checked={selected.has(w.path)}
                onChange={() => toggle(w.path)}
                title={w.inUse ? "in use by a session" : "select for removal"}
              />
              <span className="wt-repo">{w.repoName}</span>
              <span className="wt-name" title={w.path}>
                {w.name}
                {w.legacy && <span className="wt-legacy"> old layout</span>}
              </span>
              <span className="wt-meta">
                {w.error
                  ? `⚠ ${w.error}`
                  : [
                      w.branch,
                      w.dirty ? `${w.dirtyFiles} dirty` : "clean",
                      w.ahead ? `↑${w.ahead}` : null,
                      w.behind ? `↓${w.behind}` : null,
                      w.ageDays ? `${w.ageDays}d` : "today",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
              {w.inUse ? (
                <span className="wt-live">in use</span>
              ) : (
                <button className="outline" disabled={busy === "remove"} onClick={() => remove([w])}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "repos", label: "Repos" },
  { id: "presets", label: "Presets" },
  { id: "ado", label: "Azure DevOps" },
  { id: "debriefs", label: "Debriefs" },
  { id: "control", label: "Control room" },
  { id: "about", label: "About" },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** One setting: name and a short note on the left, its control on the right. */
function SetRow({ title, note, children }: { title: React.ReactNode; note?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {note && <div className="set-row-note">{note}</div>}
      </div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function SettingsView({
  sessions,
  theme,
  onTheme,
  onRestartAll,
  onSetup,
  onUpdate,
  jump,
  onHiddenTabs,
  presets,
  onPresets,
  onMsgDefaultSend,
  onStartPreset,
}: {
  sessions: SessionInfo[];
  theme: "dark" | "light";
  onTheme: (t: "dark" | "light") => void;
  onRestartAll: () => void;
  onSetup: () => void;
  onUpdate: () => void;
  /** Open a specific section, e.g. the control room from ⌘⇧B. */
  jump: { section: SettingsSection; n: number } | null;
  onHiddenTabs: (tabs: OptionalTab[]) => void;
  /** The App's preset list, which ⌘N's "Save as preset" also changes while this view is open. */
  presets: SessionPreset[];
  onPresets: (presets: SessionPreset[]) => void;
  onMsgDefaultSend: (send: boolean) => void;
  onStartPreset: (p: SessionPreset) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(() => jump?.section ?? loadLS("mb.setSection", "general"));
  useEffect(() => {
    if (jump) setSection(jump.section);
  }, [jump]);
  useEffect(() => localStorage.setItem("mb.setSection", JSON.stringify(section)), [section]);
  const [s, setS] = useState<Settings | null>(null);
  const [saveState, setSaveState] = useState<{ ok: boolean; msg: string } | null>(null);
  const [status, setStatus] = useState<SetupStatus | { error: string } | null>(null);
  const [conn, setConn] = useState<{ az: boolean; global: string[]; project: string[] } | { error: string } | null>(null);
  const [updating, setUpdating] = useState<"claude" | "codex" | null>(null);
  const [agentNote, setAgentNote] = useState("");
  const [updNote, setUpdNote] = useState("");
  // a newer version found by the check (About checks as soon as it opens)
  const [newerVersion, setNewerVersion] = useState<string | null>(null);
  const checkForUpdate = async () => {
    setUpdNote("Checking…");
    const r = await window.mb.updateCheck();
    const where = (u: { source: string }) => (u.source === "release" ? "the latest release" : "the newest version on GitHub");
    setNewerVersion(r && !r.error && r.newer ? r.latest : null);
    if (r === null) setUpdNote("This build doesn't say where its updates come from, so it can't check.");
    else if (isErr(r)) setUpdNote(`Couldn't check: ${r.error}`);
    else if (r.newer) setUpdNote(`Version ${r.latest} is available (you're on ${r.current}).`);
    else if (r.latest === r.current) setUpdNote(`Up to date — ${r.current} is ${where(r)}.`);
    else setUpdNote(`Up to date — you're on ${r.current}, ahead of ${where(r)} (${r.latest}).`);
  };
  useEffect(() => {
    if (section === "about") checkForUpdate();
  }, [section]);
  const [adoCfg, setAdoCfg] = useState<{ orgUrl: string; project: string; patFile: string } | null>(null);
  const [adoNote, setAdoNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [fmtOnSave, setFmtOnSave] = useState(getFormatOnSave);
  const [mcpCmd, setMcpCmd] = useState("");
  const [mcpErr, setMcpErr] = useState("");
  const [version, setVersion] = useState("");
  const [loadError, setLoadError] = useState("");

  const loadStatus = () => {
    setStatus(null);
    window.mb.setupStatus().then(setStatus);
  };
  const loadConnectors = () => window.mb.connectorsStatus().then(setConn);
  useEffect(() => {
    window.mb.getSettings().then((r: Settings | { error: string }) => (isErr(r) ? setLoadError(r.error) : setS(r)));
    window.mb.appVersion().then((v: string | { error: string }) =>
      isErr(v) ? console.error("[mockingbird] couldn't read the app version:", v.error) : setVersion(v)
    );
    window.mb.adoConfigGet().then((r: any) => {
      if (isErr(r)) setAdoNote({ ok: false, msg: `Couldn't read your Azure DevOps config: ${r.error}` });
      else setAdoCfg(r);
    });
    loadStatus();
    loadConnectors();
  }, []);
  if (!s) return <div className="settings-page">{loadError && <div className="err">Couldn't read settings: {loadError}</div>}</div>;

  // every change saves immediately — there is no Save button to forget. Only the
  // patch is sent: the store merges it, so settings written elsewhere since this
  // view loaded (update folder, presets, per-group message modes) are kept
  const upd = async (patch: Partial<Settings>) => {
    setS((cur) => cur && { ...cur, ...patch });
    const r = await window.mb.setSettings(patch);
    setSaveState(isErr(r) ? { ok: false, msg: `Couldn't save: ${r.error}` } : { ok: true, msg: "Saved" });
    if (patch.repoRoots || patch.claudeBin || patch.codexBin) loadStatus();
  };
  /** A path from the system picker; null when it was cancelled, or failed (said beside the section list). */
  const pick = async (opts: { file?: boolean; defaultPath?: string }): Promise<string | null> => {
    const p: string | null | { error: string } = await window.mb.pickPath(opts);
    if (isErr(p)) setSaveState({ ok: false, msg: `Couldn't open the picker: ${p.error}` });
    return typeof p === "string" && p ? p : null;
  };
  const pickBin = async (key: "claudeBin" | "codexBin") => {
    const p = await pick({ file: true, defaultPath: "/usr/local/bin" });
    if (p) upd({ [key]: p });
  };
  const addRoot = async () => {
    const p = await pick({ defaultPath: s.repoRoots[0] ?? "~" });
    if (p) upd({ repoRoots: [...new Set([...s.repoRoots, p])] });
  };
  const connectAdo = async () => {
    if (!adoCfg) return;
    setConnecting(true);
    const r = await window.mb.adoConfigSet(adoCfg);
    if (isErr(r)) {
      setConnecting(false);
      return setAdoNote({ ok: false, msg: `Couldn't save: ${r.error}` });
    }
    const me = await window.mb.adoMe();
    setConnecting(false);
    setAdoNote(isErr(me) ? { ok: false, msg: me.error } : { ok: true, msg: `Connected as ${me.display}` });
    loadStatus();
  };
  const st = status && !isErr(status) ? status : null;
  const agentLine = (a?: AgentCheck) =>
    !a ? "checking…" : !a.found ? "not installed" : `${a.version ?? ""}${a.signedIn === true ? " · signed in" : a.signedIn === false ? " · not signed in" : ""}`;

  return (
    <div className="settings-page set2">
      <nav className="set-nav">
        {SETTINGS_SECTIONS.map((x) => (
          <button key={x.id} className={section === x.id ? "on" : ""} onClick={() => setSection(x.id)}>
            {x.label}
          </button>
        ))}
        {saveState && <span className={`set-saved ${saveState.ok ? "" : "bad"}`}>{saveState.msg}</span>}
      </nav>

      <div className={`set-body ${section === "control" ? "wide" : ""}`}>
        {section === "general" && (
          <>
            <h2>General</h2>
            <SetRow title="Theme">
              <span className="seg">
                <button className={theme === "dark" ? "on" : ""} onClick={() => onTheme("dark")}>Dark</button>
                <button className={theme === "light" ? "on" : ""} onClick={() => onTheme("light")}>Light</button>
              </span>
            </SetRow>
            <SetRow title="Tabs" note="Turned-off tabs leave the top bar and the command palette. A notification or search result can still open one; WorkTracker debriefs and Collaborate rooms keep running.">
              <span className="tab-toggles">
                {OPTIONAL_TABS.map((t) => {
                  const hidden = s.hiddenTabs ?? [];
                  const on = !hidden.includes(t);
                  return (
                    <label key={t} className="tab-toggle">
                      <Toggle
                        label={`Show ${TAB_LABELS[t]}`}
                        on={on}
                        onChange={(v) => {
                          const next = v ? hidden.filter((x) => x !== t) : [...hidden, t];
                          upd({ hiddenTabs: next });
                          onHiddenTabs(next);
                        }}
                      />
                      {TAB_LABELS[t]}
                    </label>
                  );
                })}
              </span>
            </SetRow>
            <SetRow
              title="Format on save"
              note="Files are formatted by their language server when you save them in the editor (TypeScript, JavaScript, C#; Python's server doesn't format). ⇧⌥F formats any time."
            >
              <Toggle
                label="Format on save"
                on={fmtOnSave}
                onChange={(v) => {
                  setFormatOnSave(v);
                  setFmtOnSave(v);
                }}
              />
            </SetRow>
            <SetRow title="Notifications" note="When a session needs you, or finishes its turn. A session can be muted from its row in the sidebar (or ⌘K).">
              <Toggle label="Notifications" on={s.notifications} onChange={(v) => upd({ notifications: v })} />
            </SetRow>
            {s.notifications && (
              <>
                <SetRow title="When a session finishes" note="Off: only sessions that need you notify">
                  <Toggle label="Notify when a session finishes" on={s.notifyFinished !== false} onChange={(v) => upd({ notifyFinished: v })} />
                </SetRow>
                <SetRow title="Quiet hours" note="No session notifications between these times (the Dock badge and menu bar still count)">
                  <span className="quiet-hours">
                    <input
                      type="time"
                      value={s.quietHours?.from ?? "18:00"}
                      disabled={!s.quietHours?.enabled}
                      onChange={(e) => upd({ quietHours: { enabled: true, from: e.target.value, to: s.quietHours?.to ?? "08:00" } })}
                    />
                    <span>to</span>
                    <input
                      type="time"
                      value={s.quietHours?.to ?? "08:00"}
                      disabled={!s.quietHours?.enabled}
                      onChange={(e) => upd({ quietHours: { enabled: true, from: s.quietHours?.from ?? "18:00", to: e.target.value } })}
                    />
                    <Toggle
                      label="Quiet hours"
                      on={!!s.quietHours?.enabled}
                      onChange={(v) => upd({ quietHours: { enabled: v, from: s.quietHours?.from ?? "18:00", to: s.quietHours?.to ?? "08:00" } })}
                    />
                  </span>
                </SetRow>
              </>
            )}
            <SetRow title="Setup wizard" note="Agents, status hooks, repo folders, Azure DevOps">
              <button className="outline" onClick={onSetup}>Run setup</button>
            </SetRow>
          </>
        )}

        {section === "agents" && (
          <>
            <h2>Agents</h2>
            {status && isErr(status) && <div className="err">Couldn't check agents: {status.error}</div>}
            <SetRow title="Claude Code" note={agentLine(st?.claude)}>
              <button
                className="outline"
                disabled={updating !== null}
                onClick={async () => {
                  setUpdating("claude");
                  const r = await window.mb.agentUpdate("claude");
                  setUpdating(null);
                  setAgentNote(isErr(r) ? `Claude Code update failed: ${r.error}` : `Claude Code: ${r} — restart sessions to use it`);
                  loadStatus();
                }}
              >
                {updating === "claude" ? "Updating…" : "Update"}
              </button>
            </SetRow>
            <SetRow title="Codex" note={agentLine(st?.codex)}>
              <button
                className="outline"
                disabled={updating !== null || (st !== null && !st.codex.found)}
                onClick={async () => {
                  setUpdating("codex");
                  const r = await window.mb.agentUpdate("codex");
                  setUpdating(null);
                  setAgentNote(isErr(r) ? `Codex update failed: ${r.error}` : `Codex: ${r} — restart sessions to use it`);
                  loadStatus();
                }}
              >
                {updating === "codex" ? "Updating…" : "Update"}
              </button>
            </SetRow>
            {agentNote && <div className="set-note">{agentNote}</div>}
            <SetRow
              title="Restart all sessions"
              note="Moves every pane onto the newest CLI build and resumes each conversation — needed after an update, or when a new model says the CLI must update"
            >
              <button className="outline" onClick={onRestartAll}>Restart</button>
            </SetRow>
            <SetRow
              title="Status hooks"
              note={
                !st
                  ? "checking…"
                  : st.hooks.codex === false
                    ? "Codex hooks missing — Codex panes won't show working / waiting / idle"
                    : st.hooks.claude
                      ? `Installed for Claude Code${st.hooks.codex ? " and Codex (Codex asks you to trust them once: /hooks)" : ""}`
                      : "Not installed — panes won't show working / waiting / idle"
              }
            >
              {st && (!st.hooks.claude || st.hooks.codex === false) ? (
                <button
                  className="outline"
                  onClick={async () => {
                    const r = await window.mb.installHooks();
                    if (isErr(r)) setAgentNote(`Couldn't install hooks: ${r.error}`);
                    loadStatus();
                  }}
                >
                  Install
                </button>
              ) : st ? (
                <span className="set-ok">✓</span>
              ) : null}
            </SetRow>
            <SetRow
              title="Auto-send agent messages"
              note="Sessions can message each other. Off: an incoming message waits in the prompt until you press Enter"
            >
              <Toggle
                label="Auto-send agent messages"
                on={s.agentMessagesSubmit !== false}
                onChange={(v) => {
                  upd({ agentMessagesSubmit: v });
                  onMsgDefaultSend(v);
                }}
              />
            </SetRow>
            <SetRow title="Claude Code binary" note={s.claudeBin}>
              <button className="outline" onClick={() => pickBin("claudeBin")}>Change…</button>
            </SetRow>
            <SetRow title="Codex binary" note={s.codexBin ?? "codex"}>
              <button className="outline" onClick={() => pickBin("codexBin")}>Change…</button>
            </SetRow>
          </>
        )}

        {section === "repos" && (
          <>
            <h2>Repos</h2>
            <p className="set-lede">New Session lists the git repos under these folders.</p>
            {s.repoRoots.map((r) => {
              const found = st?.repoRoots.find((x) => x.path === r);
              return (
                <SetRow
                  key={r}
                  title={r}
                  note={!found ? "" : !found.exists ? "folder not found" : `${found.repos} repo${found.repos === 1 ? "" : "s"}`}
                >
                  <button className="danger" title="Remove" onClick={() => upd({ repoRoots: s.repoRoots.filter((x) => x !== r) })}>
                    ✕
                  </button>
                </SetRow>
              );
            })}
            <div className="set-actions">
              <button className="outline" onClick={addRoot}>Add folder…</button>
            </div>
            <WorktreeJanitor />
          </>
        )}

        {section === "presets" && (
          <PresetsSection
            presets={presets}
            onStart={onStartPreset}
            onChange={(next) => {
              upd({ presets: next });
              onPresets(next);
            }}
          />
        )}

        {section === "ado" && (
          <>
            <h2>Azure DevOps</h2>
            <p className="set-lede">
              Powers the Dashboard, the ticket picker in New Session, and debrief snapshots. Use your own personal access
              token — the board's "assigned to me" follows whoever owns it.
            </p>
            <SetRow
              title="Connection"
              note={!st ? "checking…" : st.ado.connected ? `Connected as ${st.ado.display} · ${st.ado.detail}` : st.ado.detail}
            >
              {st && <span className={st.ado.connected ? "set-ok" : "set-bad"}>{st.ado.connected ? "✓" : "✕"}</span>}
            </SetRow>
            <SetRow title="WorkTracker folder" note={`${s.workTrackerPath} — holds config.json and debrief notes`}>
              <button
                className="outline"
                onClick={async () => {
                  const p = await pick({ defaultPath: s.workTrackerPath });
                  if (p) upd({ workTrackerPath: p });
                }}
              >
                Change…
              </button>
            </SetRow>
            {adoCfg && (
              <div className="set-form">
                <label>Organization URL</label>
                <input type="text" placeholder="https://dev.azure.com/YourOrg" value={adoCfg.orgUrl} onChange={(e) => setAdoCfg({ ...adoCfg, orgUrl: e.target.value })} />
                <label>Project</label>
                <input type="text" placeholder="YourProject" value={adoCfg.project} onChange={(e) => setAdoCfg({ ...adoCfg, project: e.target.value })} />
                <label>Token file</label>
                <div className="path-row">
                  <span className="p">{adoCfg.patFile || "a text file containing your personal access token"}</span>
                  <button
                    className="outline"
                    onClick={async () => {
                      const p = await pick({ file: true, defaultPath: s.workTrackerPath });
                      if (p) setAdoCfg({ ...adoCfg, patFile: p });
                    }}
                  >
                    Browse…
                  </button>
                </div>
                <div className="set-actions">
                  <button
                    className="outline strong"
                    disabled={connecting || !adoCfg.orgUrl.trim() || !adoCfg.project.trim() || !adoCfg.patFile.trim()}
                    onClick={connectAdo}
                  >
                    {connecting ? "Connecting…" : "Save and connect"}
                  </button>
                </div>
              </div>
            )}
            {adoNote && <div className={adoNote.ok ? "set-note ok" : "err"}>{adoNote.msg}</div>}
          </>
        )}

        {section === "debriefs" && (
          <>
            <h2>Debriefs</h2>
            <p className="set-lede">
              The morning brief and 4pm wrap-up run an assistant in your WorkTracker folder that follows{" "}
              <code>instructions/morning.md</code> and <code>wrap-up.md</code> there.
            </p>
            <SetRow title="Run automatically" note={`${s.debriefs.morning} and ${s.debriefs.wrapUp}, weekdays, while the app is open`}>
              <Toggle label="Run debriefs automatically" on={s.debriefs.enabled} onChange={(v) => upd({ debriefs: { ...s.debriefs, enabled: v } })} />
            </SetRow>
            <SetRow
              title="Azure CLI"
              note={
                conn === null
                  ? "checking…"
                  : isErr(conn)
                    ? `Couldn't check: ${conn.error}`
                    : conn.az
                      ? "Found — your token is passed to debrief sessions, so az boards / az repos work without az login"
                      : "Not installed — debriefs still get the ticket snapshot"
              }
            />
            <h3 className="set-sub">MCP servers for debrief sessions</h3>
            <p className="set-lede">
              Optional. Saved to WorkTracker/.mcp.json; Claude Code asks you to approve each on first use.
              {conn && !isErr(conn) && conn.global.length > 0 && ` Also configured for every session: ${conn.global.join(", ")} (manage with claude mcp).`}
            </p>
            {conn && !isErr(conn) &&
              conn.project.map((n) => (
                <SetRow key={n} title={n}>
                  <button
                    className="danger"
                    title="Remove"
                    onClick={async () => {
                      const r = await window.mb.mcpRemove(n);
                      setMcpErr(isErr(r) ? `Couldn't remove ${n}: ${r.error}` : "");
                      loadConnectors();
                    }}
                  >
                    ✕
                  </button>
                </SetRow>
              ))}
            <div className="set-inline">
              <input type="text" style={{ flex: 1 }} placeholder="azure-devops" value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
              <input type="text" style={{ flex: 2.2 }} placeholder="npx -y @azure-devops/mcp YourOrg" value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} />
              <button
                className="outline"
                disabled={!mcpName.trim() || !mcpCmd.trim()}
                onClick={async () => {
                  const r = await window.mb.mcpAdd(mcpName.trim(), mcpCmd.trim());
                  if (isErr(r)) return setMcpErr(`Couldn't add ${mcpName.trim()}: ${r.error}`);
                  setMcpErr("");
                  setMcpName("");
                  setMcpCmd("");
                  loadConnectors();
                }}
              >
                Add
              </button>
            </div>
            {mcpErr && <div className="err">{mcpErr}</div>}
          </>
        )}

        {section === "control" && (
          <>
            <h2>Control room</h2>
            <p className="set-lede">Broadcast an instruction to many sessions at once, or edit CLAUDE.md and have every session re-read it.</p>
            <div className="set-card p0">
              <ControlRoomPanel sessions={sessions} />
            </div>
          </>
        )}

        {section === "about" && (
          <>
            <h2>About</h2>
            <SetRow title="Mockingbird" note={version ? `Version ${version}` : ""}>
              {newerVersion ? (
                <button className="primary" title={`Pull and build ${newerVersion}, then restart into it — your sessions come back`} onClick={onUpdate}>
                  Update to {newerVersion}
                </button>
              ) : (
                <button className="outline" disabled={updNote === "Checking…"} onClick={checkForUpdate}>
                  {updNote === "Checking…" ? "Checking…" : "Check for updates"}
                </button>
              )}
            </SetRow>
            {updNote && <div className="set-note">{updNote}</div>}
            <UpdateSourceRow onUpdate={onUpdate} />
            <SetRow title="Guide" note="Every feature and shortcut">
              <span className="kbd">⌘/</span>
            </SetRow>
          </>
        )}
      </div>
    </div>
  );
}

/** Where in-app updates build from: the user's clone, found automatically or chosen. */
function UpdateSourceRow({ onUpdate }: { onUpdate: () => void }) {
  const [src, setSrc] = useState<{ configured: string | null; found: string | null; problem?: string } | null>(null);
  const load = () => window.mb.updateSource().then((r: any) => setSrc(isErr(r) ? { configured: null, found: null, problem: r.error } : r));
  useEffect(() => {
    load();
  }, []);
  const [error, setError] = useState("");
  const choose = async (dir: string | null) => {
    const r = await window.mb.setSettings({ updateSource: dir });
    if (isErr(r)) return setError(`Couldn't save the folder: ${r.error}`);
    setError("");
    load();
  };
  const browse = async () => {
    const d: string | null | { error: string } = await window.mb.pickPath({ defaultPath: src?.found ?? undefined });
    if (isErr(d)) setError(`Couldn't open the picker: ${d.error}`);
    else if (typeof d === "string" && d) choose(d);
  };
  const note = error
    ? error
    : !src
    ? "Looking for your clone…"
    : src.problem
      ? src.problem
      : src.found
        ? `${src.found}${src.configured ? "" : " (found automatically)"}`
        : "No clone of Mockingbird under your repo folders — updates can't build until you clone it or choose its folder.";
  return (
    <SetRow title="Updates build from" note={note}>
      <button className="outline" onClick={browse}>
        Choose…
      </button>
      {src?.configured && <button className="outline" onClick={() => choose(null)}>Find automatically</button>}
      <button className="outline" disabled={!src?.found} onClick={onUpdate}>Update…</button>
    </SetRow>
  );
}
