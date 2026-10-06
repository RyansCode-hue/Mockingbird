import { useState } from "react";
import { AGENT_NAME, type SessionPreset } from "../shared/types";
import { RepoPick } from "./RepoPick";
import { baseName } from "../shared/paths";
import { Modal } from "./Modal";

const LAUNCH_LABEL: Record<SessionPreset["launch"], string> = { ...AGENT_NAME, shell: "Terminal" };

export const newPresetId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** One line saying what a preset starts, e.g. "Claude · backoffice · new branch review-{date} off dev · worktree". */
function presetSummary(p: SessionPreset): string {
  const repo = p.repoPath ? baseName(p.repoPath) : "home folder";
  const branch =
    p.branch.mode === "checkout"
      ? "as checked out"
      : p.branch.mode === "existing"
        ? `branch ${p.branch.name}`
        : `new branch ${p.branch.pattern}${p.branch.base ? ` off ${p.branch.base}` : ""}`;
  return [LAUNCH_LABEL[p.launch], repo, ...(p.repoPath ? [branch] : []), ...(p.useWorktree && p.branch.mode !== "checkout" ? ["worktree"] : []), ...(p.group ? [`group ${p.group}`] : [])].join(" · ");
}

/** Create or edit a preset. */
export function PresetEditor({ initial, onSave, onClose }: { initial: SessionPreset; onSave: (p: SessionPreset) => void; onClose: () => void }) {
  const [p, setP] = useState<SessionPreset>(initial);
  const [error, setError] = useState("");
  const set = (patch: Partial<SessionPreset>) => setP((x) => ({ ...x, ...patch }));
  const mode = p.branch.mode;
  const save = () => {
    if (!p.name.trim()) return setError("Give the preset a name");
    if (mode === "existing" && !(p.branch as { name: string }).name.trim()) return setError("Name the branch to open");
    if (mode === "new" && !(p.branch as { pattern: string }).pattern.trim()) return setError("Give the new branch a name pattern");
    onSave({ ...p, name: p.name.trim() });
  };
  return (
    <Modal className="modal" onClose={onClose}>
      <h3>{initial.name ? `Preset: ${initial.name}` : "New preset"}</h3>
      <div className="sub-h">A session setup you start in one click, from New session or ⌘K.</div>
      <label>Name</label>
      <input type="text" autoFocus value={p.name} placeholder="Review session on dev" onChange={(e) => set({ name: e.target.value })} />
      <label>Launch</label>
      <span className="seg" style={{ display: "inline-flex" }}>
        {(["claude", "codex", "shell"] as const).map((l) => (
          <button key={l} className={p.launch === l ? "on" : ""} onClick={() => set({ launch: l })}>
            {LAUNCH_LABEL[l]}
          </button>
        ))}
      </span>
      <label>Repo</label>
      <RepoPick none="No repo — the home folder" value={p.repoPath ?? ""} onChange={(v) => set({ repoPath: v || null, ...(v ? {} : { branch: { mode: "checkout" } }) })} />
      {p.repoPath && (
        <>
          <label>Branch</label>
          <span className="seg" style={{ display: "inline-flex" }}>
            <button className={mode === "checkout" ? "on" : ""} onClick={() => set({ branch: { mode: "checkout" } })}>As checked out</button>
            <button className={mode === "existing" ? "on" : ""} onClick={() => set({ branch: { mode: "existing", name: mode === "existing" ? p.branch.name : "dev" } })}>Existing branch</button>
            <button className={mode === "new" ? "on" : ""} onClick={() => set({ branch: { mode: "new", pattern: mode === "new" ? p.branch.pattern : "review-{date}", base: mode === "new" ? p.branch.base : "dev" } })}>New branch</button>
          </span>
          {p.branch.mode === "existing" && (
            <input type="text" style={{ marginTop: 8 }} value={p.branch.name} placeholder="dev" onChange={(e) => set({ branch: { mode: "existing", name: e.target.value } })} />
          )}
          {p.branch.mode === "new" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                type="text"
                value={p.branch.pattern}
                placeholder="review-{date}"
                title="{date} becomes YYYYMMDD and {time} HHMM; a name already taken gets -2, -3…"
                onChange={(e) => set({ branch: { ...(p.branch as { mode: "new"; pattern: string; base?: string }), pattern: e.target.value } })}
              />
              <input
                type="text"
                style={{ maxWidth: 140 }}
                value={p.branch.base ?? ""}
                placeholder="off origin/…"
                title="The branch it's cut from (fetched first)"
                onChange={(e) => set({ branch: { ...(p.branch as { mode: "new"; pattern: string; base?: string }), base: e.target.value } })}
              />
            </div>
          )}
          {mode !== "checkout" && (
            <label className="check-line" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11, display: "flex" }}>
              <input type="checkbox" checked={p.useWorktree} onChange={(e) => set({ useWorktree: e.target.checked })} />
              In an isolated worktree (leaves the repo's own checkout alone)
            </label>
          )}
        </>
      )}
      <label>Group <span className="wi-note">optional — "5038" or "5038/backend"</span></label>
      <input type="text" value={p.group ?? ""} onChange={(e) => set({ group: e.target.value })} />
      <label>{p.launch === "shell" ? "Command to run" : "Kickoff prompt"} <span className="wi-note">optional</span></label>
      <textarea
        value={p.kickoff ?? ""}
        onChange={(e) => set({ kickoff: e.target.value })}
        placeholder={p.launch === "shell" ? "npm test -- --watch" : "Review the latest changes on this branch for bugs and missing tests."}
        style={{ minHeight: 90 }}
      />
      {p.launch !== "shell" && (
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Model <span className="wi-note">optional</span></label>
            <input type="text" value={p.model ?? ""} placeholder="Default" onChange={(e) => set({ model: e.target.value })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>Effort <span className="wi-note">optional</span></label>
            <input type="text" value={p.effort ?? ""} placeholder="Default" onChange={(e) => set({ effort: e.target.value })} />
          </div>
        </div>
      )}
      {error && <div className="err">{error}</div>}
      <div className="row">
        <span className="foot-hint pl-dim">{presetSummary(p)}</span>
        <button className="outline" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save}>Save preset</button>
      </div>
    </Modal>
  );
}

/** Settings → Presets: the saved setups, to start, edit or delete. */
export function PresetsSection({ presets, onChange, onStart }: { presets: SessionPreset[]; onChange: (next: SessionPreset[]) => void; onStart: (p: SessionPreset) => void }) {
  const [editing, setEditing] = useState<SessionPreset | null>(null);
  const blank = (): SessionPreset => ({ id: newPresetId(), name: "", launch: "claude", repoPath: null, branch: { mode: "checkout" }, useWorktree: true });
  return (
    <>
      <h2>Presets</h2>
      <p className="set-lede">One-click session setups — a repo, a branch scheme and what to tell the session first. Start them from New session or ⌘K.</p>
      {presets.length === 0 && <div className="fp-note">No presets yet.</div>}
      {presets.map((p) => (
        <div key={p.id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">{p.name}</div>
            <div className="set-row-note">{presetSummary(p)}</div>
          </div>
          <div className="set-row-ctl">
            <button className="outline" onClick={() => onStart(p)}>Start</button>
            <button className="outline" onClick={() => setEditing(p)}>Edit</button>
            <button className="danger" title="Delete preset" onClick={() => onChange(presets.filter((x) => x.id !== p.id))}>✕</button>
          </div>
        </div>
      ))}
      <div className="set-actions">
        <button className="outline" onClick={() => setEditing(blank())}>New preset…</button>
      </div>
      {editing && (
        <PresetEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(p) => {
            onChange(presets.some((x) => x.id === p.id) ? presets.map((x) => (x.id === p.id ? p : x)) : [...presets, p]);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
