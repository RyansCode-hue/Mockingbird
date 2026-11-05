import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The status bar while following a teammate, in the UI preview in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?statusAudit (src/preview/stub.ts) follows Nick from ⌘K with the notes
// ?statusNotes gives the bar, and measures how much of each shows; nothing real runs.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

/** How much of each note shows (px: the read error and the update's outcome when there, the update link, the hooks warning), and Following's parts. */
type Measured = { notes: (number | null)[]; stop: boolean | null; words: string | null; cut: boolean; title: string | null; parts: string[]; width: number };

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
  for (const size of ["900x700", "1024x700"]) {
    it(`at ${size}, never takes a note's room: each shows as much as before following, its words and the hints giving way first`, async () => {
      for (const notes of ["all", "few"] as const) {
        const a = await audit(size, notes);
        expect(a.error).toBeUndefined();
        const say = (m: Measured) => `${size}, ${notes} notes: ${JSON.stringify(m)}`;
        expect(a.before.notes.length, say(a.before)).toBe(notes === "all" ? 4 : 2);
        // all four notes are wider than the room 900 or 1024 px leaves them with nothing followed; the link and the hooks fit
        expect(a.before.notes.every((n) => (notes === "all" ? n !== null : n !== null && n > 0)), say(a.before)).toBe(true);
        for (const m of [a.following, a.waiting]) {
          expect(m.notes, say(m)).toEqual(a.before.notes);
          // cut or not, its full words are on hover
          expect(m.title, say(m)).toMatch(new RegExp(`^${m.words}\\. Your grid mirrors what Nick Smith shows`));
        }
        expect(a.following.words).toBe("Following Nick");
        expect(a.waiting.words).toBe("Following Nick — waiting for a shared session");
        // with the link and the hooks only, at 1024 px there's room for Stop beside them
        if (notes === "few" && size === "1024x700") for (const m of [a.following, a.waiting]) expect(m.stop, say(m)).toBe(true);
        expect(a.stopped).toBe(true);
      }
    }, 180_000);
  }
});
