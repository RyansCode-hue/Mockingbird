import React, { useEffect, useState } from "react";
import type { AgentKind, CollabParticipant, CollabParticipantSpec, CollabRoom, RepoEntry } from "../shared/types";
import { ChevronIcon, DockerIcon, ReadIcon, RunIcon } from "./Icons";
import { Pick, Select } from "./Menu";
import { ACCESS_LEVELS, CUSTOM_MODEL as CUSTOM, accessFlags, accessOf, hasAccess, isErr, moveSeat, presetOptions, specsOf, toggleAccess, type Access, type Catalog } from "./collabView";
import { beginDrag, cue, dragging, overTarget, placeBeside, samePlace, sideOf, useDrag, type Side } from "./drag";

type Call = (what: string, fn: () => Promise<unknown>) => Promise<unknown>;

/**
 * The room's models, edited in place: each card opens to its model, effort and
 * access. Every change applies from that model's next turn — there's no Save.
 * Effort and access keep a model's conversation; switching to another model
 * seats a new one, which reads the whole discussion first.
 */
export function ModelsSection({ room, catalog, call }: { room: CollabRoom; catalog: Catalog; call: Call }) {
  const seated = room.participants.filter((p) => !p.removed);
  const specs = specsOf(room.participants);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const drag = useDrag();
  const keys = seated.map((p) => p.key);
  /** Speaking order with `src` moved beside `target`. */
  const reordered = (src: string, target: string, side: Side) => {
    const order = placeBeside(keys, src, target, side);
    return order.map((k) => specs.find((s) => s.key === k)!);
  };

  const apply = async (next: CollabParticipantSpec[]) => {
    const r = await call("models", () => window.mb.collabParticipants(room.id, next));
    return isErr(r) ? null : (r as CollabRoom);
  };
  const update = (key: string, patch: Partial<CollabParticipantSpec>) => apply(specs.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const switchModel = async (p: CollabParticipant, m: { agent: AgentKind; model: string; label: string }) => {
    if (m.agent === p.agent && m.model === p.model) return;
    if (!window.confirm(`Switch ${p.label} to ${m.label}? It starts a fresh conversation and reads the whole discussion first.`)) return;
    const r = await apply(specs.map((s) => (s.key === p.key ? { label: m.label, agent: m.agent, model: m.model, effort: null, ...accessFlags(accessOf(p)) } : s)));
    const joined = r?.participants.find((x) => !x.removed && !specs.some((s) => s.key === x.key));
    if (joined) setOpenKey(joined.key);
  };

  const add = async () => {
    const choices = [...(catalog.defaults ?? []), ...catalog.presets];
    const m = choices.find((x) => !seated.some((p) => p.agent === x.agent && p.model === x.model)) ?? choices[0];
    if (!m) return;
    const r = await apply([...specs, { label: m.label, agent: m.agent, model: m.model, effort: null, ...accessFlags(room.repoPath ? "read" : "none") }]);
    const joined = r?.participants.find((x) => !x.removed && !specs.some((s) => s.key === x.key));
    if (joined) setOpenKey(joined.key);
  };

  const remove = (p: CollabParticipant) => {
    if (!window.confirm(`Remove ${p.label} from the room? Its past messages stay.`)) return;
    apply(specs.filter((s) => s.key !== p.key));
  };

  return (
    <section className="ins-models">
      <div className="ins-head">
        Models
        <RepoSelect
          value={room.repoPath ?? ""}
          onChange={(v) => call("repo", () => window.mb.collabRepo(room.id, v || null))}
        />
      </div>
      {seated.map((p, i) => {
        const open = openKey === p.key;
        const access = accessOf(p);
        return (
          <div
            key={p.key}
            className={`ins-card c-${p.color} ${open ? "open" : ""} ${room.speaking === p.key ? "speaking" : ""} ${dragging("text/mb-seat") === p.key ? "dragging" : ""}`}
            data-drop={cue(drag, `seat:${p.key}`)}
            onDragOver={(e) => {
              const src = dragging("text/mb-seat");
              const side = sideOf(e, e.currentTarget, "y");
              const from = seated.find((x) => x.key === src);
              overTarget(e, !from || src === p.key || samePlace(keys, from.key, p.key, side) ? null : { key: `seat:${p.key}`, side, outcome: `${from.label} speaks ${side} ${p.label}` });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const src = e.dataTransfer.getData("text/mb-seat");
              if (src && src !== p.key) apply(reordered(src, p.key, sideOf(e, e.currentTarget, "y")));
            }}
          >
            <div className="ins-card-row" onClick={() => setOpenKey(open ? null : p.key)} title={open ? "Close" : "Model, effort and access"}>
              <span
                className="ins-grip"
                draggable
                title="Drag to change the speaking order"
                onClick={(e) => e.stopPropagation()}
                onDragStart={(e) => beginDrag(e, "text/mb-seat", p.key, `Moving ${p.label}`)}
              >
                ⋮⋮
              </span>
              <span className={`seat-dot c-${p.color}`} />
              <span className="who">{p.label}</span>
              {p.effort && <span className="ins-eff">{p.effort}</span>}
              {!open && room.repoPath && (
                <span className="ins-perms">
                  {access === "none" ? (
                    <span className="off" title="Asks a model that reads the code">no code</span>
                  ) : (
                    <span title={ACCESS_LEVELS.find((a) => a.id === access)!.note}>{access === "read" ? "</>" : access === "run" ? "$_" : "docker"}</span>
                  )}
                </span>
              )}
              <span className="ins-chev">
                <ChevronIcon open={open} />
              </span>
            </div>
            {open && (
              <div className="ins-card-body">
                <label className="ins-field">
                  <span>Model</span>
                  <ModelSelect p={p} catalog={catalog} onPick={(m) => switchModel(p, m)} />
                </label>
                <label className="ins-field">
                  <span>Effort</span>
                  <Select
                    value={p.effort ?? ""}
                    options={[{ value: "", label: "default" }, ...catalog.efforts[p.agent].map((e) => ({ value: e, label: e }))]}
                    onChange={(v) => update(p.key, { effort: v || null })}
                  />
                </label>
                <div className="ins-field">
                  <span>Access</span>
                  <span className={`ins-chips ${room.repoPath ? "" : "off"}`}>
                    <button
                      className={`ins-chip ${access === "none" ? "on" : ""}`}
                      title="No code — asks a model that reads it"
                      disabled={!room.repoPath}
                      onClick={() => update(p.key, accessFlags("none"))}
                    >
                      none
                    </button>
                    {([
                      ["read", ReadIcon, "Reads the repository"],
                      ["run", RunIcon, "Runs tests and builds in a disposable test copy — turns on read"],
                      ["docker", DockerIcon, "Uses Docker, which reaches past the sandbox — turns on read and run"],
                    ] as const).map(([level, Ico, tip]) => (
                      <button
                        key={level}
                        className={`ins-chip ${hasAccess(access, level) ? "on" : ""}`}
                        title={tip}
                        disabled={!room.repoPath}
                        aria-pressed={hasAccess(access, level)}
                        onClick={() => update(p.key, accessFlags(toggleAccess(access, level)))}
                      >
                        <Ico />
                        {level}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="ins-note">
                  {room.repoPath ? ACCESS_LEVELS.find((a) => a.id === access)!.note : "Pick a repository above to give models code access"}
                </div>
                <div className="ins-card-foot">
                  <button className="icon" disabled={i === 0} title="Speak earlier" onClick={() => apply(moveSeat(specs, p.key, seated[i - 1].key))}>↑</button>
                  <button className="icon" disabled={i === seated.length - 1} title="Speak later" onClick={() => apply(moveSeat(specs, p.key, seated[i + 1].key))}>↓</button>
                  <span className="spacer" />
                  <button className="link danger" disabled={seated.length <= 1} title={seated.length <= 1 ? "A room needs at least one model" : undefined} onClick={() => remove(p)}>
                    Remove from room
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <button className="ins-add" onClick={add}>+ Add model</button>
      {room.speaking && <div className="ins-note">{room.participants.find((p) => p.key === room.speaking)?.label} is taking its turn…</div>}
    </section>
  );
}

/** A preset, or any Claude/Codex model id typed in. */
function ModelSelect({ p, catalog, onPick }: { p: CollabParticipant; catalog: Catalog; onPick: (m: { agent: AgentKind; model: string; label: string }) => void }) {
  const preset = catalog.presets.find((m) => m.agent === p.agent && m.model === p.model);
  const [custom, setCustom] = useState<{ agent: AgentKind; model: string } | null>(preset ? null : { agent: p.agent, model: p.model });
  return (
    <span className="ins-model-pick">
      <Select
        value={custom ? CUSTOM : preset?.key ?? CUSTOM}
        placeholder={p.label}
        options={presetOptions(catalog, CUSTOM)}
        onChange={(v) => {
          const m = catalog.presets.find((x) => x.key === v);
          if (m) {
            setCustom(null);
            onPick(m);
          } else setCustom({ agent: p.agent, model: "" });
        }}
      />
      {custom && (
        <span className="ins-custom">
          <Select
            className="ins-agent"
            value={custom.agent}
            options={[{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }]}
            onChange={(v) => setCustom({ ...custom, agent: v as AgentKind })}
          />
          <input
            type="text"
            placeholder={custom.agent === "codex" ? "gpt-6-astra-mini" : "claude-sonnet-5"}
            value={custom.model}
            onChange={(e) => setCustom({ ...custom, model: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && custom.model.trim() && onPick({ agent: custom.agent, model: custom.model.trim(), label: custom.model.trim() })}
          />
          <button
            className="outline"
            disabled={!custom.model.trim()}
            onClick={() => onPick({ agent: custom.agent, model: custom.model.trim(), label: custom.model.trim() })}
          >
            Use
          </button>
        </span>
      )}
    </span>
  );
}

/** The room's repository, or none — readers read it, runners copy it, an approved plan is implemented in it. */
function RepoSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    window.mb.listRepos().then((r: RepoEntry[] | { error: string }) => (isErr(r) ? setError(r.error) : setRepos(r)));
  }, []);
  return (
    <Pick className="ins-repo" value={value} title={error ? `Couldn't list repos: ${error}` : value || "No repository — models discuss without code"} onChange={(e) => onChange(e.target.value)}>
      <option value="">No repository</option>
      {value && !repos.some((r) => r.path === value) && <option value={value}>{value.split("/").pop()}</option>}
      {repos.map((r) => (
        <option key={r.path} value={r.path}>{r.name}</option>
      ))}
    </Pick>
  );
}
