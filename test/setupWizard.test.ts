import { describe, expect, it } from "vitest";
import { applySettings } from "../src/renderer/SetupWizard";
import type { Settings } from "../src/shared/types";

const settings = { repoRoots: ["/code"], setupDone: false } as unknown as Settings;

describe("saving a setup step's settings", () => {
  it("sends only the change, and shows it on top of the settings already read", async () => {
    let saved: Partial<Settings> | null = null;
    const r = await applySettings(settings, { setupDone: true }, { getSettings: async () => settings, setSettings: async (s) => ((saved = s), s) });
    expect(r).toEqual({ settings: { ...settings, setupDone: true } });
    expect(saved).toEqual({ setupDone: true }); // a whole copy would revert settings written since it was read
  });
  it("reads the settings first when none have arrived yet", async () => {
    const r = await applySettings(null, { setupDone: true }, { getSettings: async () => settings, setSettings: async (s) => s });
    expect(r).toEqual({ settings: { ...settings, setupDone: true } });
  });
  it("reports an { error } reply instead of carrying on", async () => {
    const r = await applySettings(settings, { setupDone: true }, { getSettings: async () => settings, setSettings: async () => ({ error: "disk full" }) });
    expect(r).toEqual({ error: "Couldn't save settings: disk full" });
  });
  it("reports a rejected save the same way", async () => {
    const r = await applySettings(settings, { setupDone: true }, { getSettings: async () => settings, setSettings: () => Promise.reject(new Error("EACCES")) });
    expect(r).toEqual({ error: "Couldn't save settings: EACCES" });
  });
  it("reports settings that couldn't be read", async () => {
    const r = await applySettings(null, { setupDone: true }, { getSettings: async () => ({ error: "unreadable" }), setSettings: async (s) => s });
    expect(r).toEqual({ error: "Couldn't read settings: unreadable" });
  });
});
