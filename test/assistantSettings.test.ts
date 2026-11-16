import { describe, expect, it } from "vitest";
import type { AssistantSettingChange, AssistantSettings } from "../src/main/assistant/deps";
import { SETTING_KEYS, settingTools } from "../src/main/assistant/tools/settings";
import type { AssistantTool, ToolResult } from "../src/main/assistant/registry";
import { harness } from "./assistantHarness";

/** The Assistant's settings tools (tools/settings.ts) over settings the test holds. */
function world(over: Partial<AssistantSettings> = {}) {
  const s: AssistantSettings = { notifications: true, notifyFinished: true, quietHours: null, phoneAlerts: { setUp: true, enabled: false }, ...over };
  const changes: AssistantSettingChange[] = [];
  const tools = settingTools({
    settingsSeen: () => structuredClone(s),
    changeSetting: (c) => {
      changes.push(c);
      if (c.key === "quietHours") s.quietHours = { ...c.value };
      else if (c.key === "phoneAlerts") s.phoneAlerts.enabled = c.on;
      else s[c.key] = c.on;
    },
  });
  const tool = (name: string): AssistantTool => tools.find((t) => t.name === name)!;
  return { s, changes, tool, tools };
}

async function go(w: ReturnType<typeof world>, args: Record<string, unknown>): Promise<ToolResult> {
  const t = w.tool("set_setting");
  const why = await t.check!(args);
  if (why) throw new Error(`refused: ${why}`);
  return t.run(args);
}

describe("the Assistant's settings tools", () => {
  it("fix their tiers: get_settings a read, set_setting direct and rule-able", () => {
    const w = world();
    expect(w.tools.map((t) => [t.name, t.tier, !!t.rule])).toEqual([
      ["get_settings", "read", false],
      ["set_setting", "direct", true],
    ]);
  });

  it("get_settings gives only the allowlisted settings, and whether phone alerts are set up, never a handle", async () => {
    const w = world({ quietHours: { enabled: true, from: "22:00", to: "07:00" } });
    expect(JSON.parse((await w.tool("get_settings").run({})).text)).toEqual({
      notifications: true,
      notifyFinished: true,
      quietHours: { enabled: true, from: "22:00", to: "07:00" },
      phoneAlerts: { setUp: true, enabled: false },
    });
  });

  it("refuses every setting outside the allowlist, by its check and by its run, changing nothing", async () => {
    const w = world();
    expect(SETTING_KEYS).toEqual(["notifications", "notifyFinished", "quietHours", "phoneAlerts"]);
    const set = w.tool("set_setting");
    for (const key of ["claudeBin", "repoRoots", "signalingUrl", "roomsUnsandboxed", "phoneAlerts.handle", "__proto__"]) {
      expect(await set.check!({ setting: key, on: true })).toContain("Only notifications, notifyFinished, quietHours, phoneAlerts can be changed here");
      expect(() => set.run({ setting: key, on: true })).toThrow("Only notifications");
    }
    // and the service refuses it before the tool sees it: the schema names the same four
    const h = harness(w.tools);
    let answer: unknown;
    await h.turn("set claude's path", async (call) => ((answer = await call("set_setting", { setting: "claudeBin", on: true })), "No."));
    expect(answer).toEqual({ error: expect.stringContaining('must be one of "notifications", "notifyFinished", "quietHours", "phoneAlerts"') });
    expect(w.changes).toEqual([]);
  });

  it("turns notifications and finished alerts on and off, with an Undo that lapses once it's changed again", async () => {
    const w = world();
    expect(await w.tool("set_setting").check!({ setting: "notifications", on: true })).toBe("Notifications are on already");
    const r = await go(w, { setting: "notifications", on: false });
    expect(r.text).toBe("Turned notifications off.");
    expect(w.s.notifications).toBe(false);
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Put notifications back on");
    expect(w.s.notifications).toBe(true);
    const f = await go(w, { setting: "notifyFinished", on: false });
    w.s.notifyFinished = true;
    expect(f.stillUndoable!()).toBe(false);
    expect(() => f.undo!()).toThrow("changed again");
  });

  it("sets quiet hours, asking for their times the first time, and Undo turns new ones back off", async () => {
    const w = world();
    expect(await w.tool("set_setting").check!({ setting: "quietHours", on: true })).toContain("Say when quiet hours start and end");
    expect(await w.tool("set_setting").check!({ setting: "notifications", on: false, from: "22:00" })).toBe("from and to are quiet hours' times only");
    const r = await go(w, { setting: "quietHours", on: true, from: "22:00", to: "07:00" });
    expect(w.s.quietHours).toEqual({ enabled: true, from: "22:00", to: "07:00" });
    await r.undo!();
    expect(w.s.quietHours).toEqual({ enabled: false, from: "22:00", to: "07:00" });
    const on = await go(w, { setting: "quietHours", on: true });
    expect(on.text).toBe("Turned quiet hours on, 22:00 to 07:00.");
  });

  it("turns phone alerts on or off only once they're set up", async () => {
    const w = world({ phoneAlerts: { setUp: false, enabled: false } });
    expect(await w.tool("set_setting").check!({ setting: "phoneAlerts", on: true })).toContain("Phone alerts aren't set up");
    const v = world();
    const r = await go(v, { setting: "phoneAlerts", on: true });
    expect(v.changes).toEqual([{ key: "phoneAlerts", on: true }]);
    await r.undo!();
    expect(v.s.phoneAlerts.enabled).toBe(false);
  });
});
