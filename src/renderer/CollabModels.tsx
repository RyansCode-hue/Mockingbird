import React, { useState } from "react";
import { isErr, type AgentKind, type CollabParticipant, type CollabParticipantSpec, type CollabRoom } from "../shared/types";
import { ChevronIcon, DockerIcon, ReadIcon, RunIcon } from "./Icons";
import { Select } from "./Menu";
import { RepoPick } from "./RepoPick";
import {
  ACCESS_LEVELS,
  AGENT_OPTIONS,
  CUSTOM_MODEL as CUSTOM,
  accessFlags,
  accessOf,
  effortOptions,
  hasAccess,
  modelPlaceholder,
  moveSeat,
  presetOptions,
  specsOf,
  toggleAccess,
  unusedModel,
  type Catalog,
} from "./collabView";
import { beginDrag, cue, dragging, overTarget, placeBeside, samePlace, sideOf, useDrag, type Side } from "./drag";
import type { RunAction } from "./useAction";

const ACCESS_ICON = { read: ReadIcon, run: RunIcon, docker: DockerIcon } as const;

/**
 * The room's models, edited in place: each card opens to its model, effort and
 * access. Every change applies from that model's next turn — there's no Save.
 * Effort and access keep a model's conversation; switching to another model
 * seats a new one, which reads the whole discussion first.
 */
export function ModelsSection({ room, catalog, call }: { room: CollabRoom; catalog: Catalog; call: RunAction }) {
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
    // every model seated already: a second seat of the first one
    const m = unusedModel(catalog, seated) ?? catalog.defaults?.[0] ?? catalog.presets[0];
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
        <RepoPick
          className="ins-repo"
          none="No repository"
          title={room.repoPath || "No repository — models discuss without code"}
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
                  <ModelSelect value={p} catalog={catalog} onPick={(m) => switchModel(p, m)} />
                </label>
                <label className="ins-field">
                  <span>Effort</span>
                  <Select value={p.effort ?? ""} options={effortOptions(catalog, p.agent, "default")} onChange={(v) => update(p.key, { effort: v || null })} />
                </label>
                <div className="ins-field">
                  <span>Access</span>
                  <span className={`ins-chips ${room.repoPath ? "" : "off"}`}>
                    {ACCESS_LEVELS.map((a) => {
                      if (a.id === "none") {
                        return (
                          <button key={a.id} className={`ins-chip ${access === "none" ? "on" : ""}`} title={a.note} disabled={!room.repoPath} onClick={() => update(p.key, accessFlags("none"))}>
                            {a.label}
                          </button>
                        );
                      }
                      const level = a.id;
                      const Ico = ACCESS_ICON[level];
                      return (
                        <button
                          key={level}
                          className={`ins-chip ${hasAccess(access, level) ? "on" : ""}`}
                          title={a.note}
                          disabled={!room.repoPath}
                          aria-pressed={hasAccess(access, level)}
                          onClick={() => update(p.key, accessFlags(toggleAccess(access, level)))}
                        >
                          <Ico />
                          {a.label}
                        </button>
                      );
                    })}
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

type PickedModel = { agent: AgentKind; model: string; label: string };

/**
 * A preset, or any Claude/Codex model id typed in. `live` applies a typed id
 * as it's typed (a seat in a room not started yet); otherwise it applies on
 * Use or ↵, since switching a seated model starts it on a fresh conversation.
 */
export function ModelSelect({ value, catalog, onPick, live, title }: { value: PickedModel; catalog: Catalog; onPick: (m: PickedModel) => void; live?: boolean; title?: string }) {
  const preset = catalog.presets.find((m) => m.agent === value.agent && m.model === value.model);
  const [draft, setDraft] = useState<{ agent: AgentKind; model: string } | null>(preset ? null : { agent: value.agent, model: value.model });
  const custom = live ? (preset ? null : { agent: value.agent, model: value.model }) : draft;
  const edit = (next: { agent: AgentKind; model: string }) => (live ? onPick({ ...next, label: next.model }) : setDraft(next));
  const use = () => custom?.model.trim() && onPick({ agent: custom.agent, model: custom.model.trim(), label: custom.model.trim() });
  return (
    <span className="ins-model-pick">
      <Select
        value={custom ? CUSTOM : preset?.key ?? CUSTOM}
        placeholder={value.label || "Choose a model"}
        title={title}
        options={presetOptions(catalog, CUSTOM)}
        onChange={(v) => {
          const m = catalog.presets.find((x) => x.key === v);
          if (m) {
            setDraft(null);
            onPick({ agent: m.agent, model: m.model, label: m.label });
          } else edit({ agent: value.agent, model: "" });
        }}
      />
      {custom && (
        <span className="ins-custom">
          <Select className="ins-agent" value={custom.agent} options={AGENT_OPTIONS} onChange={(v) => edit({ ...custom, agent: v as AgentKind })} />
          <input
            type="text"
            placeholder={modelPlaceholder(custom.agent)}
            value={custom.model}
            onChange={(e) => edit({ ...custom, model: e.target.value })}
            onKeyDown={(e) => !live && e.key === "Enter" && use()}
          />
          {!live && (
            <button className="outline" disabled={!custom.model.trim()} onClick={use}>
              Use
            </button>
          )}
        </span>
      )}
    </span>
  );
}
