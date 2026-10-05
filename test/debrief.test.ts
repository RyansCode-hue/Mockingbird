import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSessionDigest } from "../src/main/debrief";
import { localDay } from "../src/shared/types";
import { tempDir } from "./helpers";

const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("dated files", () => {
  it("are named by the local day, not the UTC one", () => {
    process.env.TZ = "America/Chicago";
    const evening = new Date("2026-03-10T20:30:00-05:00"); // already Mar 11 in UTC
    expect(localDay(evening)).toBe("2026-03-10");
    expect(localDay(new Date(2026, 0, 9))).toBe("2026-01-09");
  });

  it("an evening wrap-up's session digest goes in today's file", () => {
    process.env.TZ = "America/Chicago";
    const wt = tempDir("wt");
    const sessions = { digest: () => [] } as any;
    const store = { settings: { workTrackerPath: wt } } as any;
    const file = writeSessionDigest(sessions, store, new Date("2026-03-10T20:30:00-05:00"));
    expect(path.basename(file)).toBe("2026-03-10.md");
    expect(fs.readFileSync(file, "utf8")).toContain("# Mockingbird session digest — 2026-03-10");
  });
});
