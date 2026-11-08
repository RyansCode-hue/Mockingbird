import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The status bar while following a teammate, in the UI preview in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?statusAudit (src/preview/stub.ts) follows Nick from ⌘K with the notes
// ?statusNotes gives the bar, and measures how much of each shows; nothing real runs.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Note = { shown: number | null; whole: boolean | null; cut: boolean; onHover: boolean };
/** The read error and the update's outcome when there (px shown, cut, whole on hover), the update link, the hooks warning, the usage meter (px, and each of its parts as it shows), and Following's parts. */
type Measured = { notes: Note[]; link: boolean | null; hooks: boolean | null; usage: number | null; meter: { text: string; seen: "whole" | "cut" | "dropped" }[]; stop: boolean | null; words: string | null; cut: boolean; title: string | null; parts: string[]; width: number };

async function audit(size: string, notes: "all" | "few"): Promise<{ before: Measured; following: Measured; waiting: Measured; stopped: boolean; error?: string }> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size,
    query: `motion=off&statusNotes=${notes}&statusAudit`,
    outDir: path.join(tempDir("statusbar"), "out"),
    read: `document.getElementById("mb-status-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error("the preview didn't finish its status-bar audit");
  return JSON.parse(json);
}

describe.skipIf(!local)("the status bar while following a teammate", () => {
  for (const size of ["900x700", "1024x700", "1400x900"]) {
    it(`at ${size}, always shows Stop, the update link and the hooks warning whole; the notes' words give way with their whole on hover`, async () => {
      for (const notes of ["all", "few"] as const) {
        const a = await audit(size, notes);
        expect(a.error).toBeUndefined();
        const say = (m: Measured) => `${size}, ${notes} notes: ${JSON.stringify(m)}`;
        expect(a.before.notes.length, say(a.before)).toBe(notes === "all" ? 2 : 0);
        for (const m of [a.before, a.following, a.waiting]) {
          expect([m.link, m.hooks], say(m)).toEqual([true, true]);
          // each note whole, or cut down no further than its least, its words in full on hover
          for (const n of m.notes) expect(n.whole || (n.cut && (n.shown ?? 0) >= 60 && n.onHover), say(m)).toBe(true);
          expect(m.usage ?? 0, say(m)).toBeGreaterThanOrEqual(40);
          // the meter's parts are whole or gone, never cut into; it always says something; today's word and number go together
          expect(m.meter.filter((p) => p.seen === "cut"), say(m)).toEqual([]);
          expect(m.meter.filter((p) => p.seen === "whole").length, say(m)).toBeGreaterThan(0);
          const today = m.meter.findIndex((p) => p.text === "today");
          if (today >= 0) expect(m.meter[today + 1].seen, say(m)).toBe(m.meter[today].seen);
        }
        for (const m of [a.following, a.waiting]) {
          expect(m.stop, say(m)).toBe(true);
          // cut or not, its full words are on hover
          expect(m.title, say(m)).toMatch(new RegExp(`^${m.words}\\. Your grid mirrors what Nick Smith shows`));
        }
        expect(a.following.words).toBe("Following Nick");
        expect(a.waiting.words).toBe("Following Nick — waiting for a shared session");
        expect(a.stopped).toBe(true);
      }
    }, 240_000);
  }
});
