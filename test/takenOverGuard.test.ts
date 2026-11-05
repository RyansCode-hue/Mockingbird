import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { UNTAKEN_CALLS } from "../src/main/takenOverGuard";

describe("the calls a copy a teammate took over refuses (main)", () => {
  // the Electron entry can't load under Vitest, so its wiring is read from its source; the guard's own behaviour, on
  // a taken-over copy, a copy from a refused take-over and a session no one took, is in teamTakeover.test.ts
  it("each looks its session up through the guard, named as the guard knows it, before doing anything", () => {
    const src = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    for (const call of Object.keys(UNTAKEN_CALLS)) {
      const at = src.indexOf(`handle("${call}", `);
      expect(at, call).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf("\n});", at));
      const first = body.split("\n").find((l) => /(^|\W)(untakenS|s)essionOf\(/.test(l));
      expect(first, call).toBe(`  const s = untakenSessionOf(String(id), "${call}");`);
    }
    expect(src).toMatch(/function untakenSessionOf\(id: string, call: UntakenCall\): SessionInfo \{\n {2}const s = sessionOf\(id\);\n {2}refuseTakenOver\(s\.id, call, takeover \? \(sid, doing\) => takeover!\.takenOverRefusal\(sid, doing\) : null\);/);
  });
});
