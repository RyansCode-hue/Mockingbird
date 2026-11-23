import { readRelaunchChange } from "./agents";
import type { SessionManager } from "./sessions";
import type { WireService } from "./wires";
import { isObj } from "../shared/landscape";
import { isPermissionMode, type PermissionMode } from "../shared/permissionModes";
import { insertDefaults } from "../shared/pipelineEdit";
import { AGENT_KINDS, AGENT_NAME, topOfKey, type AgentKind, type InsertStepRequest, type ModelCatalog, type ModelChange, type ModelSet, type SessionInfo, type StepEdit, type StepInserted } from "../shared/types";
import { wiresInOrder } from "../shared/wires";

export interface PipelineEditDeps {
  sessions: Pick<SessionManager, "list" | "resumable" | "planned" | "editPlanned" | "setClosedModel" | "relaunchWith" | "planStep">;
  wires: Pick<WireService, "get" | "add" | "repoint" | "unrepoint">;
  /** Let a step this made go again, with its wires (sessions:kill with forget): an insert whose wires were refused. */
  forget(id: string): void;
  /** The models and efforts this Mac's agents offer (models:catalog); null when they can't be read. */
  catalog(): Promise<ModelCatalog | null>;
  log(context: string, err: unknown): void;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const quoted = (s: SessionInfo) => `“${s.ticketTitle ?? s.title}”`;

/**
 * Why `agent` can't run `model` and `effort` (each left out when it isn't being set), or null: the shape a launch takes
 * (readRelaunchChange, as start_session and a restart with changes check it), then what this Mac's agent offers, as a
 * plan's steps are checked. A model or effort named while the catalog can't be read is refused, never guessed at.
 */
export function modelRefusal(agent: AgentKind, model: string | null | undefined, effort: string | null | undefined, catalog: ModelCatalog | null): string | null {
  try {
    readRelaunchChange({ ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }, agent);
  } catch (err) {
    return errText(err);
  }
  const name = AGENT_NAME[agent];
  const offered = catalog?.[agent];
  if (model) {
    if (!offered) return `The models this Mac's ${name} offers can't be read now: leave the model out for its default.`;
    if (!offered.models.some((m) => m.id === model)) return `${name} on this Mac doesn't offer “${model}”: pick one it lists, or leave the model out for its default.`;
  }
  if (effort) {
    if (!offered) return `The efforts this Mac's ${name} takes can't be read now: leave the effort out for its default.`;
    if (!offered.efforts.includes(effort)) return `${name} takes no “${effort}” effort: ${offered.efforts.join(", ")}.`;
  }
  return null;
}

const EDIT_KEYS = ["title", "agent", "model", "effort", "permissionMode", "prompt"] as const;

/** `raw` as a StepEdit, or throws saying what's wrong with its shape. What it names is checked against the step next. */
export function readStepEdit(raw: unknown): StepEdit {
  if (!isObj(raw)) throw new Error("A step's edit is its title, agent, model, effort, permission mode and prompt");
  const extra = Object.keys(raw).find((k) => !(EDIT_KEYS as readonly string[]).includes(k));
  if (extra) throw new Error(`A step has no ${JSON.stringify(extra)} to edit: its title, agent, model, effort, permission mode and prompt are`);
  const out: StepEdit = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string") throw new Error("A step's title is text");
    out.title = raw.title;
  }
  if (raw.agent !== undefined) {
    if (!AGENT_KINDS.includes(raw.agent as AgentKind)) throw new Error(`There's no agent ${JSON.stringify(raw.agent)}: a step runs Claude or Codex`);
    out.agent = raw.agent as AgentKind;
  }
  for (const k of ["model", "effort"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") throw new Error(`A step's ${k} is a name, or null for its agent's default`);
    out[k] = typeof v === "string" && !v.trim() ? null : (v as string | null);
  }
  if (raw.permissionMode !== undefined) {
    if (raw.permissionMode !== null && !isPermissionMode(raw.permissionMode)) throw new Error(`“${String(raw.permissionMode).slice(0, 40)}” isn't a permission mode`);
    out.permissionMode = raw.permissionMode as PermissionMode | null;
  }
  if (raw.prompt !== undefined) {
    if (raw.prompt !== null && typeof raw.prompt !== "string") throw new Error("A step's prompt is text");
    out.prompt = raw.prompt as string | null;
  }
  return out;
}

/** `raw` as a ModelChange naming a model, an effort or both, or throws. */
export function readModelChange(raw: unknown): ModelChange {
  if (!isObj(raw) || (raw.model === undefined && raw.effort === undefined)) throw new Error("Say the model, the effort or both: null for its agent's default");
  const out: ModelChange = {};
  for (const k of ["model", "effort"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") throw new Error(`A ${k} is a name, or null for its agent's default`);
    out[k] = typeof v === "string" && !v.trim() ? null : (v as string | null);
  }
  return out;
}

/**
 * Editing a pipeline once it's laid out (docs/landscape-wires.md): a not-started step's spec, any session's model, and
 * a step put in between two. Main's logic, which a window's dialogs and the Assistant's tools both call, each change
 * checked here and again by SessionManager and WireService as they make it.
 */
export class PipelineEdits {
  constructor(private readonly d: PipelineEditDeps) {}

  /**
   * Change not-started step `idRaw`'s title, agent, model, effort, permission mode or prompt (`raw`, a StepEdit), checked
   * as a session's start checks them, then saved in its record (SessionManager.editPlanned). A model or effort is
   * checked against what its agent (the new one, when that changes) offers on this Mac; an agent changed with a model
   * that agent doesn't offer is refused, rather than its model dropped unasked.
   */
  async editStep(idRaw: unknown, raw: unknown): Promise<SessionInfo> {
    const id = String(idRaw ?? "");
    const edit = readStepEdit(raw);
    const rec = this.d.sessions.planned().find((s) => s.id === id);
    if (!rec) return this.d.sessions.editPlanned(id, edit); // says why: started, starting, a teammate's, or none
    const agent = edit.agent ?? rec.agent ?? "claude";
    const newAgent = agent !== (rec.agent ?? "claude");
    const model = edit.model !== undefined ? edit.model : newAgent ? (rec.model ?? null) : undefined;
    const effort = edit.effort !== undefined ? edit.effort : newAgent ? (rec.effort ?? null) : undefined;
    if (model !== undefined || effort !== undefined) {
      const why = modelRefusal(agent, model, effort, await this.d.catalog());
      if (why) throw new Error(newAgent && edit.model === undefined && model ? `${why} (it ran ${rec.model} on ${AGENT_NAME[rec.agent ?? "claude"]}: say its model for ${AGENT_NAME[agent]}, or null)` : why);
    }
    return this.d.sessions.editPlanned(id, edit);
  }

  /**
   * Session `idRaw`'s model and effort (`raw`, a ModelChange), wherever it is:
   * - open: restarted in place with them (relaunchWith), its conversation resumed and its id, wires, place and area kept;
   *   the window asks before this for a working one;
   * - not started: its step's spec edited (editStep);
   * - closed: kept on its record, for its Reopen, Resume or Start fresh to run.
   * Each checked against what its agent offers on this Mac (modelRefusal) before anything changes. `restart: false`
   * refuses an open one instead, decided as it acts, so a session reopened while the check ran isn't restarted.
   */
  async setModel(idRaw: unknown, raw: unknown, o: { restart?: boolean } = {}): Promise<ModelSet> {
    const id = String(idRaw ?? "");
    const change = readModelChange(raw);
    const planned = this.d.sessions.planned().find((s) => s.id === id);
    if (planned) return { info: await this.editStep(id, change), did: "edited" };
    const open = this.d.sessions.list().find((s) => s.id === id);
    const closed = open ? undefined : this.d.sessions.resumable().find((s) => s.id === id);
    const s = open ?? closed;
    if (!s) throw new Error(`This Mac has no session "${id}"`);
    if (s.shell) throw new Error(`${quoted(s)} is a terminal: it has no agent to run a model`);
    const why = modelRefusal(s.agent ?? "claude", change.model, change.effort, await this.d.catalog());
    if (why) throw new Error(why);
    // read again after the catalog's await: a closed session may have been reopened meanwhile
    if (this.d.sessions.list().some((x) => x.id === id)) {
      if (o.restart === false) throw new Error(`${quoted(s)} is running: changing its model restarts it`);
      return { info: await this.d.sessions.relaunchWith(id, change), did: "restarted" };
    }
    return { info: this.d.sessions.setClosedModel(id, change), did: "stored" };
  }

  /**
   * Insert a not-started step (InsertStepRequest): between `after` and `before` their handoff A→B becomes A→new→B, the
   * wire into B keeping its id and settings (WireService.repoint) and A→new a plain handoff; after `after` alone it
   * follows it (A→new); ahead of `before` alone it leads into it (new→B). What the spec leaves out its neighbours give
   * (insertDefaults). It goes in its neighbour's area, on its ticket, and in a worktree of its own when that one works in
   * one. Checked whole before it's made; should a wire then be refused, the step goes again and the wire into B moves
   * back, and the refusal is thrown.
   */
  async insertStep(raw: unknown): Promise<StepInserted> {
    if (!isObj(raw)) throw new Error("Say the step to insert, and after or ahead of which session");
    const req = raw as Partial<InsertStepRequest>;
    const all = [...this.d.sessions.list(), ...this.d.sessions.resumable(), ...this.d.sessions.planned()];
    const find = (v: unknown, what: string): SessionInfo | null => {
      if (v === undefined || v === null || v === "") return null;
      const s = all.find((x) => x.id === v);
      if (!s) throw new Error(`This Mac has no session "${String(v)}" to put a step ${what}`);
      if (s.shell) throw new Error(`${quoted(s)} is a terminal: a step goes ${what} an agent`);
      return s;
    };
    const a = find(req.after, "after");
    const b = find(req.before, "ahead of");
    if (!a && !b) throw new Error("Say where the step goes: after a session, ahead of one, or between two");
    if (a && b && a.id === b.id) throw new Error("A step goes between two sessions, not one");
    const state = this.d.wires.get();
    if (!state.book) throw new Error(state.refused ?? "Wires can't be read right now.");
    const between = a && b ? wiresInOrder(state.book.links).find(([, w]) => w.type === "handoff" && w.from === a.id && w.to === b.id) : undefined;
    if (a && b && !between) throw new Error(`There's no handoff from ${quoted(a)} to ${quoted(b)} to put a step in`);

    const defaults = insertDefaults(a, b);
    const edit = readStepEdit({
      title: req.title,
      agent: req.agent ?? defaults.agent,
      ...(req.model !== undefined ? { model: req.model } : { model: req.agent && req.agent !== defaults.agent ? null : defaults.model }),
      ...(req.effort !== undefined ? { effort: req.effort } : { effort: req.agent && req.agent !== defaults.agent ? null : defaults.effort }),
      ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
    });
    const agent = edit.agent!;
    // what it takes from its neighbour runs there already; what the spec names is checked as any start's is
    const named = { model: req.model !== undefined ? edit.model : undefined, effort: req.effort !== undefined ? edit.effort : undefined };
    if (named.model || named.effort) {
      const why = modelRefusal(agent, named.model || undefined, named.effort || undefined, await this.d.catalog());
      if (why) throw new Error(why);
    }
    const next = (a ?? b)!;
    const worktree = next.planned ? next.planned.worktree : !!next.repoPath && next.cwd !== next.repoPath;
    const group = next.taskGroup ? topOfKey(next.taskGroup) : null;
    const info = this.d.sessions.planStep({
      title: edit.title ?? "",
      agent,
      ...(edit.model ? { model: edit.model } : {}),
      ...(edit.effort ? { effort: edit.effort } : {}),
      repoPath: next.repoPath,
      worktree,
      ...(next.planned?.base ? { base: next.planned.base } : {}),
      taskGroup: group,
      ...(next.ticketId ? { ticketId: next.ticketId } : {}),
      ...(edit.prompt?.trim() ? { prompt: edit.prompt } : {}),
    });
    const made: string[] = [];
    let moved: string | null = null;
    const takeBack = (refused: string): never => {
      const left: string[] = [];
      if (moved) {
        const r = this.d.wires.unrepoint(moved);
        if ("refused" in r) left.push(`the wire into ${quoted(b!)} stays on it (${r.refused}): move it back from its Settings`);
      }
      try {
        this.d.forget(info.id);
      } catch (err) {
        this.d.log(`pipeline: inserted step ${info.id} wasn't wired, and couldn't be forgotten`, err);
        left.push(`${quoted(info)} stays with no wires (${errText(err)}): forget it from its menu`);
      }
      throw new Error(`${refused}${left.length ? ` And ${left.join("; ")}.` : ""}`);
    };
    if (between) {
      const r = this.d.wires.repoint(between[0], { from: info.id });
      if ("refused" in r) takeBack(`${quoted(info)} couldn't hand off to ${quoted(b!)}: ${r.refused}`);
      moved = between[0];
      made.push(between[0]);
    }
    if (a) {
      const r = this.d.wires.add(a.id, info.id, "handoff");
      if ("refused" in r) takeBack(`${quoted(a)} couldn't hand off to ${quoted(info)}: ${r.refused}`);
      else made.unshift(r.id!);
    } else if (b) {
      const r = this.d.wires.add(info.id, b.id, "handoff");
      if ("refused" in r) takeBack(`${quoted(info)} couldn't hand off to ${quoted(b)}: ${r.refused}`);
      else made.push(r.id!);
    }
    return { info, wires: made, note: null };
  }
}
