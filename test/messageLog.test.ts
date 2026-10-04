import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { MessageLog } from "../src/main/messageLog";
import { tempDir } from "./helpers";

const msg = (i: number) => ({ at: i, from: "a", fromTitle: "A", to: "b", toTitle: "B", text: `m${i}`, outcome: "delivered" });

describe("the agent message log", () => {
  it("keeps the last 300 across restarts", () => {
    const f = path.join(tempDir("log"), "messages.json");
    const log = new MessageLog(f);
    for (let i = 0; i < 305; i++) log.add(msg(i));
    const again = new MessageLog(f).list();
    expect(again).toHaveLength(300);
    expect(again[0].text).toBe("m5");
    expect(again.at(-1)!.text).toBe("m304");
  });
  it("keeps an unreadable file aside instead of overwriting it", () => {
    const f = path.join(tempDir("log"), "messages.json");
    fs.writeFileSync(f, "{oops");
    expect(new MessageLog(f).list()).toEqual([]);
    expect(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith("messages.json.corrupt-"))).toBe(true);
  });
});
