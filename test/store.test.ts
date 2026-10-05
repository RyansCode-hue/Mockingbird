import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { Store, appendLogLine, writeFileAtomic } from "../src/main/store";
import { tempDir } from "./helpers";
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

describe("the app's logs", () => {
  it("roll over to <file>.1 past their size cap, keeping the newest lines", () => {
    const file = path.join(tempDir("logs"), "main.log");
    appendLogLine(file, "first", 10);
    appendLogLine(file, "second line", 10);
    expect(fs.readFileSync(file, "utf8")).toBe("first\nsecond line\n");
    appendLogLine(file, "third", 10); // the file is past 10 bytes now
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("first\nsecond line\n");
    expect(fs.readFileSync(file, "utf8")).toBe("third\n");
  });
});

describe("writeFileAtomic", () => {
  it("replaces the file whole and leaves no temporary file behind", () => {
    const file = path.join(tempDir("atomic"), "config.json");
    fs.writeFileSync(file, '{"old": true}');
    writeFileAtomic(file, '{"new": true}');
    expect(fs.readFileSync(file, "utf8")).toBe('{"new": true}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });
});
