import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { capitalize, type AgentKind, type CollabModel, type ModelCatalog, type ModelChoice } from "../shared/types";

/**
 * The models each CLI can run, read from what the CLIs themselves know, so a
 * new model shows up without a Mockingbird release:
 *  - Claude Code: the aliases its --help names (each always means the latest
 *    model of that line), its effort levels, and the extra models your
 *    account offers (~/.claude.json's model options cache);
 *  - Codex: the model list it caches from OpenAI (~/.codex/models_cache.json),
 *    with each model's description and reasoning levels;
 *  - both: the models your recent conversations actually used.
 * Every source is optional; what can't be read is left out, never guessed.
 */

// Lines Claude Code's --help doesn't spell out but accepts the same way
const CLAUDE_ALIASES_ALWAYS = ["haiku"];
const CLAUDE_EFFORTS_FALLBACK = ["low", "medium", "high", "xhigh", "max"];

/** Aliases ('fable', 'opus', …) and effort levels from `claude --help`. */
export function parseClaudeHelp(help: string): { aliases: string[]; efforts: string[] } {
  const flat = help.replace(/\s+/g, " ");
  const model = /--model <model> (.*?)(?= --[a-z])/.exec(flat)?.[1] ?? "";
  const aliases = [...model.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  const effort = /--effort <level> [^(]*\(([^)]*)\)/.exec(flat)?.[1];
  const efforts = effort ? effort.split(",").map((e) => e.trim()).filter((e) => /^[a-z]+$/.test(e)) : [];
  return { aliases, efforts };
}

/** The extra models Claude Code offers this account (the /model picker's additions). */
export function claudeAccountModels(claudeJson: any): ModelChoice[] {
  const opts = Array.isArray(claudeJson?.additionalModelOptionsCache) ? claudeJson.additionalModelOptionsCache : [];
  return opts
    .filter((o: any) => typeof o?.value === "string" && o.value)
    .map((o: any) => {
      const desc = typeof o.description === "string" ? o.description : "";
      // "Fable 5.1 · Most capable for…": the part before the dot names the version
      const name = desc.split(" · ")[0] || o.label || o.value;
      const long = /\[1m\]$/.test(o.value) ? " · 1M context" : "";
      return { id: o.value, label: `${name}${long}`, description: desc.split(" · ").slice(1).join(" · ") || undefined, group: "Your account" };
    });
}

/** Codex's cached model list: the listed ones, in its order, with their reasoning levels. */
export function codexModelsFromCache(cache: any): ModelChoice[] {
  const models = Array.isArray(cache?.models) ? cache.models : [];
  return models
    .filter((m: any) => m?.slug && m.visibility !== "hide")
    .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m: any) => ({
      id: String(m.slug),
      label: String(m.display_name ?? m.slug),
      description: m.description ? String(m.description) : undefined,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l: any) => String(l.effort)).filter(Boolean) : undefined,
      defaultEffort: m.default_reasoning_level ? String(m.default_reasoning_level) : undefined,
      group: "Codex models",
    }));
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // not there, or the CLI hasn't written it yet
  }
}

/**
 * Put the catalog together. `help` is `claude --help`'s output (null when
 * Claude Code isn't installed); `recent` is the models recent conversations used.
 */
export function buildCatalog(opts: { claudeHelp: string | null; recent: Record<AgentKind, string[]>; home?: string }): ModelCatalog {
  const home = opts.home ?? os.homedir();
  const help = opts.claudeHelp ? parseClaudeHelp(opts.claudeHelp) : { aliases: [], efforts: [] };
  const aliases = [...new Set([...help.aliases, ...(help.aliases.length ? CLAUDE_ALIASES_ALWAYS : [])])];
  const claude: ModelChoice[] = [
    ...aliases.map((a) => ({ id: a, label: `${capitalize(a)} (latest)`, group: "Latest" })),
    ...claudeAccountModels(readJson(path.join(home, ".claude.json"))),
  ];
  const codex = codexModelsFromCache(readJson(path.join(home, ".codex", "models_cache.json")));
  const add = (list: ModelChoice[], ids: string[]) => {
    for (const id of ids) if (!list.some((m) => m.id === id || m.id.replace(/\[1m\]$/, "") === id)) list.push({ id, label: id, group: "Recently used" });
  };
  add(claude, opts.recent.claude);
  add(codex, opts.recent.codex);
  const codexEfforts = [...new Set(codex.flatMap((m) => m.efforts ?? []))];
  return {
    claude: { models: claude, efforts: help.efforts.length ? help.efforts : CLAUDE_EFFORTS_FALLBACK },
    codex: { models: codex, efforts: codexEfforts.length ? codexEfforts : ["low", "medium", "high", "xhigh"] },
  };
}

/** A model as a Collaborate seat: its speaker name says which family it is. */
function seatOf(agent: AgentKind, m: ModelChoice): CollabModel {
  const name = m.group === "Latest" ? capitalize(m.id) : m.label;
  const label = agent === "claude" && !/^claude/i.test(name) && m.group !== "Recently used" ? `Claude ${name}` : name;
  return { key: `${agent}:${m.id}`, label, agent, model: m.id };
}

/**
 * Collaborate's model choices from the catalog, and the seats a new room starts
 * with: Codex's top model, the latest Opus and the latest Fable — by alias, so
 * a new release is picked up without changing anything here.
 */
export function collabModels(c: ModelCatalog): { presets: CollabModel[]; defaults: CollabModel[] } {
  const presets = [...c.codex.models.map((m) => seatOf("codex", m)), ...c.claude.models.map((m) => seatOf("claude", m))];
  const pick = (agent: AgentKind, id?: string) => presets.find((p) => p.agent === agent && (id ? p.model === id : true));
  const defaults = [pick("codex"), pick("claude", "opus"), pick("claude", "fable")].filter((p): p is CollabModel => !!p);
  return { presets, defaults };
}
