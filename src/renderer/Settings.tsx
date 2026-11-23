import React, { useEffect, useMemo, useState } from "react";
import { Pick } from "./Menu";
import { reachesBroadcast, titleOf } from "./appModel";
import { PresetsSection } from "./Presets";
import { getFormatOnSave, setFormatOnSave } from "./CodeEditor";
import { ASSISTANT_MODELS, assistantModelOf } from "../shared/assistant";
import { isErr, OPTIONAL_TABS, type AgentCheck, type BroadcastOutcome, type SetupStatus, type SessionInfo, type SessionPreset, type Settings, type WorktreeEntry, type OptionalTab } from "../shared/types";
import { TAB_LABELS } from "./tabs";
import { plural } from "../shared/format";
import { baseName } from "../shared/paths";
import { readPref, writePref } from "./prefs";
import { checkNote, runCheck, settled, type Check } from "./settled";
import { useAction } from "./useAction";
import { SetRow } from "./SetRow";
import { Toggle } from "./Toggle";
import { TeamSection } from "./Team";
import { PhoneAlertsSection } from "./PhoneAlerts";
import { useMotionPref, type MotionPref } from "./motion";

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
    // a rejected call is a failed read too, not an editor left blank
    void settled<{ path: string; content: string } | { error: string }>(window.mb.readClaudeMd(target)).then((r) => {
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
    const r = await settled(window.mb.saveClaudeMd(target, content));
    if (isErr(r)) {
      setIoError(`Couldn't save ${target}: ${r.error}`);
      return; // no broadcast — nothing was written to re-read
    }
    setIoError(null);
    setOriginal(content);
    if (broadcastToo && rereadTargets.length) {
      const b = await settled(
        window.mb.broadcast({
          message: `Heads up: ${loadedPath} was just updated. Please re-read it now and apply it to all work going forward in this session.`,
          sessionIds: rereadTargets.map((s) => s.id),
          whenIdle: true,
        })
      );
      if (isErr(b)) return setBError(`Saved, but couldn't ask the sessions to re-read it: ${b.error}`);
      setBError(null);
      markDelivery(b);
    }
  };

  const queueBroadcast = async () => {
    if (!message.trim() || !bTargets.length) return;
    const r = await settled(window.mb.broadcast({ message, sessionIds: bTargets.map((s) => s.id), whenIdle: true }));
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
              <option key={p} value={`${p}/CLAUDE.md`}>{baseName(p)} — {p}/CLAUDE.md</option>
            ))}
          </Pick>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          <div className="ft">
            <span className="diff">{dirty ? `${plural(changedLines, "line")} changed` : "no changes"}</span>
            <button className="outline" disabled={!dirty} data-tip={dirty ? undefined : "No changes to save"} onClick={() => saveAndReread(false)}>Save</button>
            <button
              className="primary"
              disabled={!dirty || !rereadTargets.length}
              data-tip={!dirty ? "No changes to save" : !rereadTargets.length ? "No running session reads this CLAUDE.md" : undefined}
              onClick={() => saveAndReread(true)}
            >
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
            <button
              className="primary"
              disabled={!message.trim() || !bTargets.length}
              data-tip={!message.trim() ? "Write the message first" : !bTargets.length ? (scope === "selected" ? "Select a session first" : "No running session to send it to") : undefined}
              onClick={queueBroadcast}
            >
              Queue for {plural(bTargets.length, "session")}
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
  const { doing, run, error, setError } = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const load = async () => {
    const r = await settled(window.mb.listWorktrees());
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
      ? `${w.name}: ${plural(w.dirtyFiles, "uncommitted file")} will be lost`
      : w.ahead
        ? `${w.name}: ${plural(w.ahead, "unpushed commit")} on ${w.branch} (the branch is kept)`
        : null;
  // one confirmation for the whole batch, listing every worktree that would lose work;
  // removals run one at a time and every failure is reported, not just the first
  const remove = async (ws: WorktreeEntry[]) => {
    if (ws.length === 0) return;
    const risks = ws.map(riskOf).filter(Boolean) as string[];
    const what = ws.length === 1 ? `the worktree folder ${ws[0].path}` : `${ws.length} worktree folders`;
    const msg = (risks.length ? `${risks.join("\n")}\n\n` : "") + `Remove ${what}?`;
    if (!window.confirm(msg)) return;
    const failures: string[] = [];
    const r = await run("remove", async () => {
      for (const w of ws) {
        const one = await window.mb.removeWorktree(w.repoPath, w.path);
        if (isErr(one)) failures.push(`${w.name}: ${one.error}`);
      }
    });
    if (isErr(r)) failures.push(r.error);
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
    const failures: string[] = [];
    const r = await run("migrate", async () => {
      for (const w of ws) {
        const one = await window.mb.migrateWorktree(w.repoPath, w.path);
        if (isErr(one)) failures.push(`${w.name}: ${one.error}`);
      }
    });
    if (isErr(r)) failures.push(r.error);
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
          <button className="outline" disabled={doing("migrate")} onClick={() => migrate(movable)}>
            {doing("migrate") ? "moving…" : `Move ${plural(movable.length, "old-layout worktree")} into worktrees/`}
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
          <button className="outline" disabled={chosen.length === 0 || doing("remove")} onClick={() => remove(chosen)}>
            {doing("remove") ? "removing…" : `Remove ${chosen.length || ""} selected`}
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
                <button className="outline" disabled={doing("remove")} onClick={() => remove([w])}>
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
  { id: "notifications", label: "Notifications" },
  { id: "agents", label: "Agents" },
  { id: "assistant", label: "Assistant" },
  { id: "repos", label: "Repos" },
  { id: "presets", label: "Presets" },
  { id: "ado", label: "Azure DevOps" },
  { id: "team", label: "Team" },
  { id: "debriefs", label: "Debriefs" },
  { id: "control", label: "Control room" },
  { id: "about", label: "About" },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The section to open on from the one remembered: General when it's one that's since gone. */
export const savedSection = (saved: unknown): SettingsSection => SETTINGS_SECTIONS.find((x) => x.id === saved)?.id ?? "general";


/** Settings → Motion: follow macOS's Reduce motion, or choose. */
function MotionRow() {
  const m = useMotionPref();
  const opt = (p: MotionPref, label: string) => (
    <button className={m.pref === p ? "on" : ""} aria-pressed={m.pref === p} onClick={() => m.set(p)}>
      {label}
    </button>
  );
  return (
    <SetRow
      title="Motion"
      note={`Panes fly into their workspace's folder when minimized and back out when shown; dialogs, menus and toasts ease in and out. Reduce keeps only short fades. macOS Reduce motion is ${m.osReduce ? "on" : "off"}.`}
    >
      <span className="seg">
        {opt("os", "Follow macOS")}
        {opt("reduce", "Reduce")}
        {opt("full", "Full")}
      </span>
    </SetRow>
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
  const [section, setSection] = useState<SettingsSection>(() => jump?.section ?? savedSection(readPref<unknown>("mb.setSection", "general")));
  useEffect(() => {
    if (jump) setSection(jump.section);
  }, [jump]);
  useEffect(() => {
    writePref("mb.setSection", section);
  }, [section]);
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
    const r = await settled(window.mb.updateCheck());
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
    void runCheck("the agents, hooks, repo folders and Azure DevOps", window.mb.setupStatus()).then(setStatus);
  };
  const loadConnectors = () => runCheck("the Azure CLI and debrief MCP servers", window.mb.connectorsStatus()).then(setConn);
  const retryConnectors = () => {
    setConn(null);
    void loadConnectors();
  };
  const loadSettings = () => {
    setLoadError("");
    void settled<Settings | { error: string }>(window.mb.getSettings()).then((r) => (isErr(r) ? setLoadError(r.error) : setS(r)));
  };
  useEffect(() => {
    loadSettings();
    void settled<string | { error: string }>(window.mb.appVersion()).then((v) =>
      isErr(v) ? console.error("[mockingbird] couldn't read the app version:", v.error) : setVersion(v)
    );
    void settled(window.mb.adoConfigGet()).then((r: any) => {
      if (isErr(r)) setAdoNote({ ok: false, msg: `Couldn't read your Azure DevOps config: ${r.error}` });
      else setAdoCfg(r);
    });
    loadStatus();
    void loadConnectors();
  }, []);
  if (!s)
    return (
      <div className="settings-page">
        {loadError && (
          <div className="err">
            Couldn't read settings: {loadError} <button className="link" onClick={loadSettings}>Retry</button>
          </div>
        )}
      </div>
    );

  // every change saves immediately — there is no Save button to forget. Only the
  // patch is sent: the store merges it, so settings written elsewhere since this
  // view loaded (update folder, presets, per-group message modes) are kept
  const upd = async (patch: Partial<Settings>): Promise<boolean> => {
    setS((cur) => cur && { ...cur, ...patch });
    const r = await settled(window.mb.setSettings(patch));
    setSaveState(isErr(r) ? { ok: false, msg: `Couldn't save: ${r.error}` } : { ok: true, msg: "Saved" });
    if (patch.repoRoots || patch.claudeBin || patch.codexBin) loadStatus();
    return !isErr(r);
  };
  /** A path from the system picker; null when it was cancelled, or failed (said beside the section list). */
  const pick = async (opts: { file?: boolean; defaultPath?: string }): Promise<string | null> => {
    const p: string | null | { error: string } = await settled(window.mb.pickPath(opts));
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
    try {
      const r = await settled(window.mb.adoConfigSet(adoCfg));
      if (isErr(r)) return setAdoNote({ ok: false, msg: `Couldn't save: ${r.error}` });
      const me = await settled(window.mb.adoMe());
      setAdoNote(isErr(me) ? { ok: false, msg: me.error } : { ok: true, msg: `Connected as ${me.display}` });
      loadStatus();
    } finally {
      setConnecting(false);
    }
  };
  const st = status && !isErr(status) ? status : null;
  /**
   * A row's note on the setup check, in a section whose CheckFailed notice says why the check failed:
   * the row then reads a dim "—" rather than repeating the error.
   */
  const statusNote = (done: (s: SetupStatus) => string) => (isErr(status) ? <Unknown /> : checkNote(status, done));
  const agentLine = (a: (s: SetupStatus) => AgentCheck) =>
    statusNote((s) => {
      const c = a(s);
      return !c.found ? "not installed" : `${c.version ?? ""}${c.signedIn === true ? " · signed in" : c.signedIn === false ? " · not signed in" : ""}`;
    });

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
            <MotionRow />
            <SetRow title="Tabs" note="Turned-off tabs leave the top bar and the command palette. A notification or search result can still open one; WorkTracker debriefs and Council discussions keep running.">
              <span className="tab-toggles">
                {OPTIONAL_TABS.map((t) => {
                  const hidden = s.hiddenTabs ?? [];
                  const on = !hidden.includes(t);
                  return (
                    <label key={t} className="tab-toggle">
                      {TAB_LABELS[t]}
                      <Toggle
                        label={`Show ${TAB_LABELS[t]}`}
                        on={on}
                        onChange={(v) => {
                          const next = v ? hidden.filter((x) => x !== t) : [...hidden, t];
                          upd({ hiddenTabs: next });
                          onHiddenTabs(next);
                        }}
                      />
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
            <SetRow title="Setup wizard" note="Agents, status hooks, repo folders, Azure DevOps">
              <button className="outline" onClick={onSetup}>Run setup</button>
            </SetRow>
          </>
        )}

        {section === "notifications" && (
          <>
            <h2>Notifications</h2>
            <SetRow title="Desktop notifications" note="When a session needs you, or finishes its turn. A session can be muted from its row in the sidebar (or ⌘K).">
              <Toggle label="Notifications" on={s.notifications} onChange={(v) => upd({ notifications: v })} />
            </SetRow>
            {s.notifications && (
              <SetRow title="When a session finishes" note="Off: only sessions that need you notify">
                <Toggle label="Notify when a session finishes" on={s.notifyFinished !== false} onChange={(v) => upd({ notifyFinished: v })} />
              </SetRow>
            )}
            <SetRow title="Quiet hours" note="No session notifications or phone alerts between these times (the Dock badge and menu bar still count)">
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
            <PhoneAlertsSection settings={s} onChange={upd} />
          </>
        )}

        {section === "agents" && (
          <>
            <h2>Agents</h2>
            <CheckFailed what="the agents and status hooks" check={status} onRetry={loadStatus} />
            <SetRow title="Claude Code" note={agentLine((x) => x.claude)}>
              <button
                className="outline"
                disabled={updating !== null}
                onClick={async () => {
                  setUpdating("claude");
                  const r = await settled(window.mb.agentUpdate("claude"));
                  setUpdating(null);
                  setAgentNote(isErr(r) ? `Claude Code update failed: ${r.error}` : `Claude Code: ${r} — restart sessions to use it`);
                  loadStatus();
                }}
              >
                {updating === "claude" ? "Updating…" : "Update"}
              </button>
            </SetRow>
            <SetRow title="Codex" note={agentLine((x) => x.codex)}>
              <button
                className="outline"
                disabled={updating !== null || (st !== null && !st.codex.found)}
                onClick={async () => {
                  setUpdating("codex");
                  const r = await settled(window.mb.agentUpdate("codex"));
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
              note={statusNote(({ hooks }) =>
                hooks.codex === false
                  ? "Codex hooks missing — Codex panes won't show working / waiting / idle"
                  : hooks.claude
                    ? `Installed for Claude Code${hooks.codex ? " and Codex (Codex asks you to trust them once: /hooks)" : ""}`
                    : "Not installed — panes won't show working / waiting / idle"
              )}
            >
              {st && (!st.hooks.claude || st.hooks.codex === false) ? (
                <button
                  className="outline"
                  onClick={async () => {
                    const r = await settled(window.mb.installHooks());
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

        {section === "assistant" && (
          <>
            <h2>Assistant</h2>
            <p className="set-lede">Ask it about your sessions, or for a change to them, in its tab on the rail (⇧⌘A) or from ⌘K. Each question runs Claude Code once, on this Mac.</p>
            <SetRow title="Model" note="Sonnet is faster, and the default; Opus is smarter, and slower. The next question runs on it.">
              <span className="seg">
                {ASSISTANT_MODELS.map((m) => (
                  <button key={m.id} className={assistantModelOf(s) === m.id ? "on" : ""} aria-pressed={assistantModelOf(s) === m.id} title={`${m.label}: ${m.note}`} onClick={() => upd({ assistantModel: m.id })}>
                    {m.label}
                  </button>
                ))}
              </span>
            </SetRow>
          </>
        )}

        {section === "repos" && (
          <>
            <h2>Repos</h2>
            <p className="set-lede">New Session lists the git repos under these folders.</p>
            <CheckFailed what="the repo folders" check={status} onRetry={loadStatus} />
            {s.repoRoots.map((r) => {
              const found = st?.repoRoots.find((x) => x.path === r);
              return (
                <SetRow
                  key={r}
                  title={r}
                  note={isErr(status) ? <Unknown /> : !found ? "scanning…" : !found.exists ? "folder not found" : plural(found.repos, "repo")}
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
              note={checkNote(status, ({ ado }) => (ado.connected ? `Connected as ${ado.display} · ${ado.detail}` : ado.detail))}
            >
              {isErr(status) && (
                <button className="outline" onClick={loadStatus}>
                  Retry
                </button>
              )}
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
                <input type="text" placeholder="e.g. https://dev.azure.com/YourOrg" value={adoCfg.orgUrl} onChange={(e) => setAdoCfg({ ...adoCfg, orgUrl: e.target.value })} />
                <label>Project</label>
                <input type="text" placeholder="e.g. YourProject" value={adoCfg.project} onChange={(e) => setAdoCfg({ ...adoCfg, project: e.target.value })} />
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

        {section === "team" && <TeamSection settings={s} onChange={upd} />}

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
              note={checkNote(conn, (c) =>
                c.az ? "Found — your token is passed to debrief sessions, so az boards / az repos work without az login" : "Not installed — debriefs still get the ticket snapshot"
              )}
            >
              {isErr(conn) && (
                <button className="outline" onClick={retryConnectors}>
                  Retry
                </button>
              )}
            </SetRow>
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
                      const r = await settled(window.mb.mcpRemove(n));
                      setMcpErr(isErr(r) ? `Couldn't remove ${n}: ${r.error}` : "");
                      loadConnectors();
                    }}
                  >
                    ✕
                  </button>
                </SetRow>
              ))}
            <div className="set-inline">
              <input type="text" style={{ flex: 1 }} placeholder="e.g. azure-devops" value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
              <input type="text" style={{ flex: 2.2 }} placeholder="e.g. npx -y @azure-devops/mcp YourOrg" value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} />
              <button
                className="outline"
                disabled={!mcpName.trim() || !mcpCmd.trim()}
                onClick={async () => {
                  const r = await settled(window.mb.mcpAdd(mcpName.trim(), mcpCmd.trim()));
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

/** A check that failed, said once above the rows it feeds (which read <Unknown />), with its Retry. */
function CheckFailed({ what, check, onRetry }: { what: string; check: Check<unknown>; onRetry: () => void }) {
  if (!isErr(check)) return null;
  return (
    <div className="set-check-failed" role="alert">
      <span className="msg">
        Couldn't check {what}: {check.error}
      </span>
      <button className="outline" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** A row's value while the check above it has failed. */
function Unknown() {
  return (
    <span className="set-unknown" title="Couldn't check — see above">
      —
    </span>
  );
}

/** Where in-app updates build from: the user's clone, found automatically or chosen. */
function UpdateSourceRow({ onUpdate }: { onUpdate: () => void }) {
  const [src, setSrc] = useState<{ configured: string | null; found: string | null; problem?: string } | null>(null);
  const load = () => settled(window.mb.updateSource()).then((r: any) => setSrc(isErr(r) ? { configured: null, found: null, problem: r.error } : r));
  useEffect(() => {
    load();
  }, []);
  const [error, setError] = useState("");
  const choose = async (dir: string | null) => {
    const r = await settled(window.mb.setSettings({ updateSource: dir }));
    if (isErr(r)) return setError(`Couldn't save the folder: ${r.error}`);
    setError("");
    load();
  };
  const browse = async () => {
    const d: string | null | { error: string } = await settled(window.mb.pickPath({ defaultPath: src?.found ?? undefined }));
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
      <button
        className="outline"
        disabled={!src?.found}
        data-tip={src?.found ? "Pull and build this clone, then restart into it" : "No clone to build from yet"}
        onClick={onUpdate}
      >
        Build from…
      </button>
    </SetRow>
  );
}
