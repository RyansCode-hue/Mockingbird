import React, { useEffect, useState } from "react";
import type { AgentCheck, SetupStatus, Settings } from "../shared/types";

const STEPS = ["Agents", "Status hooks", "Repos", "Azure DevOps", "Done"] as const;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Settings with `patch` applied and saved, or why they weren't: an { error }
 * reply and a rejected call both come back as { error }. With no settings read
 * yet (Skip pressed before they arrived), they're read first.
 */
export async function applySettings(
  cur: Settings | null,
  patch: Partial<Settings>,
  mb: { getSettings: () => Promise<Settings | { error: string }>; setSettings: (s: Settings) => Promise<unknown> }
): Promise<{ settings: Settings } | { error: string }> {
  try {
    const base = cur ?? (await mb.getSettings());
    if ("error" in base) return { error: `Couldn't read settings: ${base.error}` };
    const next = { ...base, ...patch };
    const r = await mb.setSettings(next);
    if (r && typeof r === "object" && "error" in r) return { error: `Couldn't save settings: ${(r as { error: string }).error}` };
    return { settings: next };
  } catch (err) {
    return { error: `Couldn't save settings: ${messageOf(err)}` };
  }
}

function Check({ ok, warn }: { ok: boolean | null; warn?: boolean }) {
  return <span className={`sw-check ${ok ? "ok" : warn ? "warn" : "bad"}`}>{ok ? "✓" : warn ? "–" : "✕"}</span>;
}

function Cmd({ children }: { children: string }) {
  return (
    <code className="sw-cmd" title="Click to copy" onClick={() => navigator.clipboard.writeText(children)}>
      {children}
    </code>
  );
}

function AgentRow({ name, a, install, login, optional }: { name: string; a: AgentCheck; install: string; login: string; optional?: boolean }) {
  return (
    <div className="sw-item">
      <Check ok={a.found && a.signedIn === true} warn={optional && !a.found} />
      <div className="sw-body">
        <div className="sw-title">
          {name} {optional && <span className="wi-note">optional</span>}
        </div>
        {!a.found ? (
          <div className="sw-sub">
            Not installed. In Terminal: <Cmd>{install}</Cmd>
          </div>
        ) : a.signedIn === false ? (
          <div className="sw-sub">
            {a.version} — not signed in. In Terminal: <Cmd>{login}</Cmd>
          </div>
        ) : a.signedIn === null ? (
          <div className="sw-sub">{a.version} — couldn't check sign-in: {a.detail}</div>
        ) : (
          <div className="sw-sub">{a.version} · signed in</div>
        )}
      </div>
    </div>
  );
}

/**
 * First-run setup. Every step shows the machine's real state (re-checked on
 * demand), so a half-finished setup resumes where it stopped and a machine that
 * is already set up shows all green.
 */
export function SetupWizard({ onClose, onFinish }: { onClose: () => void; onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ado, setAdo] = useState({ orgUrl: "", project: "", patFile: "" });
  const [connecting, setConnecting] = useState(false);

  const recheck = async () => {
    setChecking(true);
    try {
      const r = await window.mb.setupStatus();
      if (r?.error) return setError(r.error);
      setError("");
      setSt(r);
    } catch (err) {
      setError(`Couldn't check this Mac: ${messageOf(err)}`);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    recheck();
    window.mb.getSettings().then(setSettings, (err: unknown) => setError(`Couldn't read settings: ${messageOf(err)}`));
    window.mb.adoConfigGet().then(
      (r: any) => {
        if (r?.error) setError(`Couldn't read your existing Azure DevOps config: ${r.error}`);
        else if (r) setAdo(r);
      },
      (err: unknown) => setError(`Couldn't read your existing Azure DevOps config: ${messageOf(err)}`)
    );
  }, []);

  /** Saves a settings change; false, with the reason shown, when it didn't save. */
  const saveSettings = async (patch: Partial<Settings>): Promise<boolean> => {
    const r = await applySettings(settings, patch, window.mb);
    if ("error" in r) {
      setError(r.error);
      return false;
    }
    setSettings(r.settings);
    await recheck();
    return true;
  };

  // the wizard stays open when setupDone didn't save, so the reason stays on screen
  const finish = async () => {
    if (await saveSettings({ setupDone: true })) onFinish();
  };
  const skip = async () => {
    if (await saveSettings({ setupDone: true })) onClose();
  };

  const installHooks = async () => {
    try {
      const r = await window.mb.installHooks();
      if (r?.error) return setError(r.error);
    } catch (err) {
      return setError(`Couldn't install the hooks: ${messageOf(err)}`);
    }
    await recheck();
  };

  /** The folder or file picker's choice; null when cancelled, or when it couldn't open (the reason is shown). */
  const pickPath = async (opts: { file?: boolean; defaultPath?: string }): Promise<string | null> => {
    try {
      return await window.mb.pickPath(opts);
    } catch (err) {
      setError(`Couldn't open the picker: ${messageOf(err)}`);
      return null;
    }
  };

  const addRoot = async () => {
    const p = await pickPath({ defaultPath: "~" });
    if (!p || !settings) return;
    if (!settings.repoRoots.includes(p)) await saveSettings({ repoRoots: [...settings.repoRoots, p] });
  };

  const connectAdo = async () => {
    setConnecting(true);
    try {
      const r = await window.mb.adoConfigSet(ado);
      if (r?.error) return setError(r.error);
      await recheck();
    } catch (err) {
      setError(`Couldn't connect: ${messageOf(err)}`);
    } finally {
      setConnecting(false);
    }
  };

  const pickWorkTracker = async () => {
    const p = await pickPath({ defaultPath: settings?.workTrackerPath });
    if (p) await saveSettings({ workTrackerPath: p });
  };
  const pickPat = async () => {
    const p = await pickPath({ file: true, defaultPath: settings?.workTrackerPath });
    if (p) setAdo((a) => ({ ...a, patFile: p }));
  };

  const agentsOk = !!st && st.claude.found && st.claude.signedIn === true;
  const reposFound = st?.repoRoots.reduce((n, r) => n + r.repos, 0) ?? 0;

  return (
    <div className="modal-back">
      <div className="modal setup-wiz" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sw-steps">
          {STEPS.map((s, i) => (
            <button key={s} className={`sw-step ${i === step ? "on" : ""} ${i < step ? "past" : ""}`} onClick={() => setStep(i)}>
              <span className="n">{i + 1}</span>
              {s}
            </button>
          ))}
        </div>

        {step === 0 && (
          <>
            <h3>Welcome to Mockingbird</h3>
            <div className="sub-h">
              Mockingbird runs coding agents side by side, one per branch or ticket. It drives the CLIs you already
              use — Claude Code, and optionally OpenAI's Codex with a ChatGPT subscription.
            </div>
            {!st ? (
              <div className="wi-note">checking this Mac…</div>
            ) : (
              <>
                <AgentRow name="Claude Code" a={st.claude} install="npm install -g @anthropic-ai/claude-code" login="claude auth login" />
                <AgentRow name="Codex" a={st.codex} install="npm install -g @openai/codex" login="codex login" optional />
              </>
            )}
          </>
        )}

        {step === 1 && st && (
          <>
            <h3>Status hooks</h3>
            <div className="sub-h">
              Hooks let each pane show whether its agent is working, idle, or waiting on you. They're added next to
              any hooks you already have; nothing of yours is replaced.
            </div>
            <div className="sw-item">
              <Check ok={st.hooks.claude} />
              <div className="sw-body">
                <div className="sw-title">Claude Code</div>
                <div className="sw-sub">~/.claude/settings.json</div>
              </div>
            </div>
            <div className="sw-item">
              <Check ok={st.hooks.codex === true} warn={st.hooks.codex === null} />
              <div className="sw-body">
                <div className="sw-title">Codex</div>
                <div className="sw-sub">
                  {st.hooks.codex === null
                    ? "Codex isn't set up on this Mac — skipped"
                    : "~/.codex/hooks.json · Codex asks you to trust new hooks once: type /hooks in a Codex pane and trust them"}
                </div>
              </div>
            </div>
            {!(st.hooks.claude && st.hooks.codex !== false) && (
              <div className="row" style={{ justifyContent: "flex-start" }}>
                <button className="outline strong" onClick={installHooks}>Install hooks</button>
              </div>
            )}
          </>
        )}

        {step === 2 && st && settings && (
          <>
            <h3>Where your repos live</h3>
            <div className="sub-h">
              New Session lists the git repos under these folders. Worktrees are created beside them in{" "}
              <code>worktrees/</code>.
            </div>
            {st.repoRoots.map((r) => (
              <div className="sw-item" key={r.path}>
                <Check ok={r.exists && r.repos > 0} warn={r.exists && r.repos === 0} />
                <div className="sw-body">
                  <div className="sw-title">{r.path}</div>
                  <div className="sw-sub">{r.exists ? `${r.repos} repo${r.repos === 1 ? "" : "s"}` : "folder not found"}</div>
                </div>
                <button
                  className="icon"
                  title="Remove this folder"
                  onClick={() => saveSettings({ repoRoots: settings.repoRoots.filter((x) => x !== r.path) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="row" style={{ justifyContent: "flex-start" }}>
              <button className="outline" onClick={addRoot}>Add folder…</button>
              <span className="wi-note">{reposFound} repos found</span>
            </div>
          </>
        )}

        {step === 3 && st && settings && (
          <>
            <h3>Azure DevOps <span className="wi-note">optional</span></h3>
            <div className="sub-h">
              Powers the Dashboard board, the ticket picker in New Session, and debrief snapshots. Create a personal
              access token in Azure DevOps (User settings → Personal access tokens, scope: Work Items read and write),
              save it to a file outside any git repo, and point Mockingbird at it. The token stays on this Mac.
            </div>
            <div className="sw-item">
              <Check ok={st.ado.connected} warn={!st.ado.connected} />
              <div className="sw-body">
                <div className="sw-title">{st.ado.connected ? `Connected as ${st.ado.display}` : "Not connected"}</div>
                <div className="sw-sub">{st.ado.detail}</div>
              </div>
            </div>
            <label>WorkTracker folder <span className="wi-note">holds config.json and debrief notes</span></label>
            <div className="path-row">
              <span className="p">{settings.workTrackerPath}</span>
              <button className="outline" onClick={pickWorkTracker}>Browse…</button>
            </div>
            <label>Organization URL</label>
            <input type="text" placeholder="https://dev.azure.com/YourOrg" value={ado.orgUrl} onChange={(e) => setAdo({ ...ado, orgUrl: e.target.value })} />
            <label>Project</label>
            <input type="text" placeholder="YourProject" value={ado.project} onChange={(e) => setAdo({ ...ado, project: e.target.value })} />
            <label>Token file</label>
            <div className="path-row">
              <span className="p">{ado.patFile || "none chosen"}</span>
              <button className="outline" onClick={pickPat}>Browse…</button>
            </div>
            <div className="row" style={{ justifyContent: "flex-start" }}>
              <button
                className="outline strong"
                disabled={connecting || !ado.orgUrl.trim() || !ado.project.trim() || !ado.patFile}
                onClick={connectAdo}
              >
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h3>You're set up</h3>
            <div className="sub-h">A few things worth knowing:</div>
            <div className="sw-tips">
              <div><span className="kbd">⌘N</span> new session — pick a repo, optionally a ticket; the branch and worktree are handled for you</div>
              <div><span className="kbd">⌘K</span> every command, and jump to any session</div>
              <div><span className="kbd">⌘B</span> file explorer and diffs for the focused session</div>
              <div><span className="kbd">⌘/</span> the full guide</div>
            </div>
            {st && !agentsOk && <div className="err">Claude Code isn't ready yet — see step 1. You can finish anyway and come back via ⌘K → Setup.</div>}
          </>
        )}

        {error && <div className="err">{error}</div>}

        <div className="row">
          <button className="outline foot-hint" onClick={skip}>Skip setup</button>
          <button className="outline" onClick={recheck} disabled={checking}>{checking ? "Checking…" : "Check again"}</button>
          {step > 0 && <button className="outline" onClick={() => setStep(step - 1)}>Back</button>}
          {step < STEPS.length - 1 ? (
            <button className="primary" onClick={() => setStep(step + 1)}>Next</button>
          ) : (
            <button className="primary" onClick={finish}>Start a session</button>
          )}
        </div>
      </div>
    </div>
  );
}
