import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { buildCatalog, claudeAccountModels, codexModelsFromCache, collabModels, parseClaudeHelp } from "../src/main/models";

const HELP = `
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name for this session
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session
`;
const CODEX = {
  models: [
    { slug: "gpt-6-sol", display_name: "GPT-6-Sol", description: "Workhorse.", priority: 3, visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier.", priority: 2, visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] },
    { slug: "codex-auto-review", display_name: "Auto Review", priority: 40, visibility: "hide" },
  ],
};

describe("reading models from the CLIs", () => {
  it("takes Claude's aliases and effort levels from its --help", () => {
    expect(parseClaudeHelp(HELP)).toEqual({ aliases: ["fable", "opus", "sonnet"], efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(parseClaudeHelp("usage: nothing useful")).toEqual({ aliases: [], efforts: [] });
  });
  it("names the extra models the account offers by their version, marking 1M-context ones", () => {
    expect(claudeAccountModels({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", label: "Fable", description: "Fable 5.1 · Most capable" }] })).toEqual([
      { id: "claude-fable-5-1[1m]", label: "Fable 5.1 · 1M context", description: "Most capable", group: "Your account" },
    ]);
    expect(claudeAccountModels(null)).toEqual([]);
  });
  it("lists Codex's models in its order, without hidden ones, each with its reasoning levels", () => {
    expect(codexModelsFromCache(CODEX).map((m) => [m.id, m.efforts, m.defaultEffort])).toEqual([
      ["gpt-6-astra", ["low", "max"], "low"],
      ["gpt-6-sol", ["low", "ultra"], "medium"],
    ]);
  });
  it("puts it together with recently used models, and keeps going when a source is missing", () => {
    const home = fs.mkdtempSync(path.join(os.homedir(), "models-"));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify(CODEX));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", description: "Fable 5.1 · x" }] }));
    const c = buildCatalog({ claudeHelp: HELP, recent: { claude: ["claude-fable-5-1", "claude-opus-5-5"], codex: ["gpt-6-astra", "gpt-old"] }, home });
    expect(c.claude.models.map((m) => `${m.group}:${m.id}`)).toEqual([
      "Latest:fable", "Latest:opus", "Latest:sonnet", "Latest:haiku",
      "Your account:claude-fable-5-1[1m]",
      "Recently used:claude-opus-5-5", // claude-fable-5-1 is already there as its 1M variant
    ]);
    expect(c.codex.models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-old"]);
    expect(c.codex.efforts).toEqual(["low", "max", "ultra"]);
    const bare = buildCatalog({ claudeHelp: null, recent: { claude: [], codex: [] }, home: fs.mkdtempSync(path.join(os.homedir(), "none-")) });
    expect(bare).toEqual({ claude: { models: [], efforts: ["low", "medium", "high", "xhigh", "max"] }, codex: { models: [], efforts: ["low", "medium", "high", "xhigh"] } });
  });
  it("leaves out a cache it can't parse, and says so", () => {
    const home = fs.mkdtempSync(path.join(os.homedir(), "models-"));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), "{ half-written");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(buildCatalog({ claudeHelp: null, recent: { claude: [], codex: [] }, home }).codex.models).toEqual([]);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/models_cache\.json/);
    } finally {
      warn.mockRestore();
    }
  });
  it("seats a new Collaborate room with Codex's top model and the latest Opus and Fable", () => {
    const home = fs.mkdtempSync(path.join(os.homedir(), "models-"));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify(CODEX));
    const { presets, defaults } = collabModels(buildCatalog({ claudeHelp: HELP, recent: { claude: [], codex: [] }, home }));
    expect(defaults.map((d) => [d.agent, d.model, d.label])).toEqual([
      ["codex", "gpt-6-astra", "GPT-6-Astra"],
      ["claude", "opus", "Claude Opus"],
      ["claude", "fable", "Claude Fable"],
    ]);
    expect(presets.map((p) => p.key)).toContain("claude:sonnet");
  });
});
