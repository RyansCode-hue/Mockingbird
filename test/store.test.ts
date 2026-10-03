import { describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { OPTIONAL_TABS } from "../src/shared/types";

describe("hidden tabs", () => {
  it("are saved with the settings and come back after a restart", () => {
    const a = new Store();
    a.setSettings({ hiddenTabs: ["dashboard", "collaborate"] });
    expect(new Store().settings.hiddenTabs).toEqual(["dashboard", "collaborate"]);
  });

  it("can't include Sessions or Settings", () => {
    expect(OPTIONAL_TABS).toEqual(["dashboard", "worktracker", "collaborate"]);
  });
});
