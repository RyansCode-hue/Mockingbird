import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { PHONE_DEFAULTS } from "../src/shared/phoneAlerts";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";
import { keysOfTier, PHONE_ROWS, SETTING_KEYS, SETTINGS_TABLE, settingTools } from "../src/main/assistant/tools/settings";
import type { AssistantTool, ToolResult } from "../src/main/assistant/registry";
import { harness } from "./assistantHarness";

/** The Assistant's settings tools (tools/settings.ts) over settings the test holds, changed as main's changeSettings merges a patch. */
function world(over: Partial<Settings> = {}) {
  let s: Settings = structuredClone({ ...DEFAULT_SETTINGS, phoneAlerts: { ...PHONE_DEFAULTS, handle: "+15551234567" }, ...over });
  const patches: Partial<Settings>[] = [];
  const tools = settingTools({
    settings: () => s,
    changeSettings: (p) => {
      patches.push(structuredClone(p));
      s = { ...s, ...structuredClone(p) };
    },
  });
  const tool = (name: string): AssistantTool => tools.find((t) => t.name === name)!;
  return { now: () => s, set: (p: Partial<Settings>) => void (s = { ...s, ...p }), patches, tool, tools };
}

async function go(w: ReturnType<typeof world>, args: Record<string, unknown>): Promise<ToolResult> {
  const t = w.tool("set_setting");
  const why = await t.check!(args);
  if (why) throw new Error(`refused: ${why}`);
  return t.run(args);
}

/** The keys of the Settings interface, as src/shared/types.ts declares them. */
function settingsInterfaceKeys(): string[] {
  const src = fs.readFileSync(path.join(__dirname, "../src/shared/types.ts"), "utf8");
  const body = /export interface Settings \{([\s\S]*?)\n\}/.exec(src)?.[1];
  if (!body) throw new Error("src/shared/types.ts has no Settings interface");
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
}

describe("the Assistant's settings table", () => {
  it("classifies every setting: each key of Settings has a row, and each part of phone alerts", () => {
    const keys = settingsInterfaceKeys();
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) expect(SETTINGS_TABLE, `Settings.${k} has no row in SETTINGS_TABLE`).toHaveProperty([k]);
    // and no row names a setting that isn't there
    const tops = SETTING_KEYS.filter((k) => !k.includes("."));
    expect(tops.sort()).toEqual([...keys].sort());
    for (const part of Object.keys(PHONE_DEFAULTS)) expect(SETTINGS_TABLE).toHaveProperty([PHONE_ROWS[part as keyof typeof PHONE_ROWS]]);
    expect(SETTING_KEYS.filter((k) => k.startsWith("phoneAlerts.")).sort()).toEqual(Object.values(PHONE_ROWS).filter((k) => k !== "phoneAlerts").sort());
  });

  it("gives each tier what it needs: direct and confirm rows read and change, read rows only read, never rows neither", () => {
    for (const key of SETTING_KEYS) {
      const row = SETTINGS_TABLE[key];
      if (row.tier === "direct" || row.tier === "confirm") expect([key, !!row.get, !!row.put]).toEqual([key, true, true]);
      if (row.tier === "read") expect([key, !!row.get, !!row.put]).toEqual([key, true, false]);
      if (row.tier === "never") expect([key, !!row.get, !!row.put, !!row.why]).toEqual([key, false, false, true]);
      if (row.tier === "confirm") expect([key, !!row.why]).toEqual([key, true]);
    }
  });

  it("puts what changes what agents may do, what runs as the user or reaches past this Mac on a card, and keeps credentials out of reach", () => {
    expect(keysOfTier("direct").sort()).toEqual(["assistantModel", "hiddenTabs", "notifications", "notifyFinished", "phoneAlerts", "phoneAlerts.finished", "phoneAlerts.idleMinutes", "quietHours"]);
    expect(keysOfTier("confirm").sort()).toEqual([
      "agentMessagesByGroup",
      "agentMessagesSubmit",
      "claudeBin",
      "codexBin",
      "debriefs",
      "phoneAlerts.replies",
      "repoRoots",
      "roomSessionsInline",
      "signalingUrl",
      "teamName",
      "updateSource",
    ]);
    expect(keysOfTier("read").sort()).toEqual(["pipelineTemplates", "presets", "roomsUnsandboxed", "setupDone"]);
    expect(keysOfTier("never").sort()).toEqual(["phoneAlerts.handle", "workTrackerPath"]);
    expect(["claudeBin", "codexBin", "updateSource", "signalingUrl"].every((k) => SETTINGS_TABLE[k as keyof typeof SETTINGS_TABLE].danger)).toBe(true);
  });
});

describe("the Assistant's settings tools", () => {
  it("fix their tiers: get_settings a read, set_setting direct and rule-able, change_setting a card no rule takes", () => {
    const w = world();
    expect(w.tools.map((t) => [t.name, t.tier, !!t.rule])).toEqual([
      ["get_settings", "read", false],
      ["set_setting", "direct", true],
      ["change_setting", "confirm", false],
    ]);
    // each schema names only its own tier's settings
    expect(w.tool("set_setting").inputSchema.properties!.setting.enum).toEqual(keysOfTier("direct"));
    expect(w.tool("change_setting").inputSchema.properties!.setting.enum).toEqual(keysOfTier("confirm"));
  });

  it("get_settings shows each setting with how it changes, never a credentials path or the phone handle", async () => {
    const w = world({ workTrackerPath: "/Users/me/secret-place/WorkTracker", quietHours: { enabled: true, from: "22:00", to: "07:00" } });
    const text = (await w.tool("get_settings").run({})).text;
    expect(text).not.toContain("secret-place");
    expect(text).not.toContain("5551234567");
    const out = JSON.parse(text);
    expect(out.settings.notifications).toMatchObject({ value: true, changes: "set_setting" });
    expect(out.settings.quietHours.value).toEqual({ enabled: true, from: "22:00", to: "07:00" });
    expect(out.settings.phoneAlerts).toMatchObject({ value: false, setUp: true, changes: "set_setting" });
    expect(out.settings.claudeBin).toMatchObject({ value: "claude", changes: "change_setting", why: expect.stringContaining("runs this program") });
    expect(out.settings.presets).toMatchObject({ changes: "read only" });
    expect(Object.keys(out.notShown).sort()).toEqual(["phoneAlerts.handle", "workTrackerPath"]);
    expect(out.settings).not.toHaveProperty("workTrackerPath");
    expect(out.settings).not.toHaveProperty(["phoneAlerts.handle"]);
  });

  it("set_setting turns a setting on and off, with an Undo that lapses once it's changed again", async () => {
    const w = world();
    expect(await w.tool("set_setting").check!({ setting: "notifications", on: true })).toBe("Notifications are on already");
    const r = await go(w, { setting: "notifications", on: false });
    expect(r.text).toBe("Turned notifications off.");
    expect(w.now().notifications).toBe(false);
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Put notifications back on");
    expect(w.now().notifications).toBe(true);
    const f = await go(w, { setting: "notifyFinished", on: false });
    w.set({ notifyFinished: true });
    expect(f.stillUndoable!()).toBe(false);
    expect(() => f.undo!()).toThrow("changed again");
  });

  it("sets quiet hours, asking for their times the first time, and Undo turns new ones back off", async () => {
    const w = world();
    expect(await w.tool("set_setting").check!({ setting: "quietHours", on: true })).toContain("Say when quiet hours start and end");
    expect(await w.tool("set_setting").check!({ setting: "notifications", on: false, from: "22:00" })).toBe("from and to are quiet hours' times only");
    const r = await go(w, { setting: "quietHours", on: true, from: "22:00", to: "07:00" });
    expect(w.now().quietHours).toEqual({ enabled: true, from: "22:00", to: "07:00" });
    await r.undo!();
    expect(w.now().quietHours).toEqual({ enabled: false, from: "22:00", to: "07:00" });
    const on = await go(w, { setting: "quietHours", on: true });
    expect(on.text).toBe("Turned quiet hours on, 22:00 to 07:00.");
  });

  it("sets the rest of the direct ones by value, each checked, and puts each back", async () => {
    const w = world();
    const tabs = await go(w, { setting: "hiddenTabs", value: ["collaborate", "dashboard"] });
    expect(w.now().hiddenTabs).toEqual(["dashboard", "collaborate"]);
    expect(await tabs.undo!()).toBe("Put the hidden tabs back to none");
    expect(await w.tool("set_setting").check!({ setting: "hiddenTabs", value: ["settings"] })).toContain("a list of dashboard, worktracker, collaborate");
    await go(w, { setting: "assistantModel", value: "opus" });
    expect(w.now().assistantModel).toBe("opus");
    expect(await w.tool("set_setting").check!({ setting: "assistantModel", value: "haiku" })).toContain("sonnet or opus");
    const idle = await go(w, { setting: "phoneAlerts.idleMinutes", value: 30 });
    // only the part changes: the handle and the rest stay as they are
    expect(w.now().phoneAlerts).toEqual({ ...PHONE_DEFAULTS, handle: "+15551234567", idleMinutes: 30 });
    await idle.undo!();
    expect(w.now().phoneAlerts!.idleMinutes).toBe(10);
    expect(await w.tool("set_setting").check!({ setting: "phoneAlerts.idleMinutes", value: 7 })).toContain("one of 5, 10, 15, 30, 60");
  });

  it("turns phone alerts on only once they're set up", async () => {
    const w = world({ phoneAlerts: { ...PHONE_DEFAULTS, handle: "" } });
    expect(await w.tool("set_setting").check!({ setting: "phoneAlerts", on: true })).toContain("Phone alerts aren't set up");
    const v = world();
    const r = await go(v, { setting: "phoneAlerts", on: true });
    expect(v.patches).toEqual([{ phoneAlerts: { ...PHONE_DEFAULTS, handle: "+15551234567", enabled: true } }]);
    await r.undo!();
    expect(v.now().phoneAlerts!.enabled).toBe(false);
  });

  it("holds each tier to its tool: set_setting refuses what's a card's or never changed, change_setting what's set at once", async () => {
    const w = world();
    const set = w.tool("set_setting");
    expect(await set.check!({ setting: "claudeBin", value: "/tmp/evil" })).toContain("change_setting puts it on a card");
    expect(await set.check!({ setting: "agentMessagesSubmit", on: true })).toContain("change_setting puts it on a card");
    expect(await set.check!({ setting: "workTrackerPath", value: "/x" })).toContain("never read or changed by the Assistant");
    expect(await set.check!({ setting: "phoneAlerts.handle", value: "me@example.com" })).toContain("never read or changed");
    expect(await set.check!({ setting: "presets", value: [] })).toContain("isn't changed here");
    expect(await set.check!({ setting: "__proto__", on: true })).toContain("There's no setting");
    expect(() => set.run({ setting: "claudeBin", value: "/tmp/evil" })).toThrow("change_setting");
    const change = w.tool("change_setting");
    expect(await change.check!({ setting: "notifications", value: false })).toContain("changed at once with set_setting");
    expect(await change.check!({ setting: "workTrackerPath", value: "/x" })).toContain("never read or changed");
    expect(w.patches).toEqual([]);

    // and the service refuses them before the tools see them: each schema names only its own
    const h = harness(w.tools);
    const answers: unknown[] = [];
    await h.turn("change things", async (call) => {
      answers.push(await call("set_setting", { setting: "claudeBin", value: "/tmp/evil" }));
      answers.push(await call("change_setting", { setting: "workTrackerPath", value: "/x" }));
      return "No.";
    });
    expect(answers).toEqual([{ error: expect.stringContaining("must be one of") }, { error: expect.stringContaining("must be one of") }]);
    expect(w.patches).toEqual([]);
  });

  it("change_setting puts a card up and changes nothing until Do it; the card expires when the setting changes meanwhile", async () => {
    const w = world();
    const h = harness(w.tools);
    const t = await h.turn("use my other claude", async (call) => (await call("change_setting", { setting: "claudeBin", value: "/opt/claude/bin/claude" }), "Card up."));
    const card = await h.card(t.steps[0].cardId!);
    expect(card).toMatchObject({ title: "Change the Claude Code program", detail: expect.stringContaining("From “claude” to “/opt/claude/bin/claude”"), danger: true, state: "open" });
    expect(card.detail).toContain("Every Claude session from now on runs this program, as you");
    expect(w.patches).toEqual([]);
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "done", result: "Changed the Claude Code program to “/opt/claude/bin/claude”." });
    expect(w.now().claudeBin).toBe("/opt/claude/bin/claude");

    const t2 = await h.turn("send agents' messages at once", async (call) => (await call("change_setting", { setting: "agentMessagesSubmit", value: false }), "Card up."));
    const c2 = await h.card(t2.steps[0].cardId!);
    w.set({ agentMessagesSubmit: false });
    h.svc.stateChanged();
    expect((await h.card(c2.id)).state).toBe("expired");
    expect(w.now().agentMessagesSubmit).toBe(false);
  });

  it("change_setting checks each value's form, and shows a long one whole on its card", async () => {
    const w = world();
    const change = w.tool("change_setting");
    expect(await change.check!({ setting: "signalingUrl", value: "http://example.invalid" })).toContain("an https address");
    expect(await change.check!({ setting: "repoRoots", value: ["Code"] })).toContain("a path from / or ~/");
    expect(await change.check!({ setting: "teamName", value: "Ryan\nNick" })).toContain("one line");
    expect(await change.check!({ setting: "agentMessagesByGroup", value: { atticus: "always" } })).toContain('"send" or "prompt"');
    expect(await change.check!({ setting: "debriefs", value: { morning: "9am" } })).toContain("HH:MM");
    const roots = ["~/Code", "~/Personal Projects", "~/Work/clients/a-very-long-folder-name-to-make-it-long"];
    const card = await change.card!({ setting: "repoRoots", value: roots });
    expect(card.body).toBe(JSON.stringify(roots, null, 2));
    expect(card.detail).toContain("to the value below");
  });

  it("a standing rule's set_setting from before still runs with the same arguments", async () => {
    const w = world();
    const h = harness(w.tools);
    const r = await h.svc.runAction({ tool: "set_setting", args: { setting: "notifications", on: false }, label: "Turn notifications off" }, "evenings");
    expect(r).toMatchObject({ ok: true, text: "Turned notifications off." });
    expect(w.now().notifications).toBe(false);
    expect((await h.svc.runAction({ tool: "change_setting", args: { setting: "teamName", value: "x" }, label: "x" })).text).toContain("can't be a standing rule's action");
  });
});
