import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";

// xterm's fit addon looks for a browser global as it loads
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import { Terminal } from "@xterm/xterm";
import {
  BAND_CARDS,
  BAND_LIVE,
  BAND_SLACK,
  ON_SCREEN_MARGIN,
  PEEK_EDGE,
  PEEK_SHARE,
  attaches,
  bandOf,
  keysOnScreen,
  nextBand,
  onScreen,
  peekBox,
  takesKeys,
  type Band,
} from "../src/renderer/landscapeModel";
import { lastMeaningfulLine } from "../src/shared/terminalText";
import { tailLines } from "../src/renderer/cachedTerm";

describe("the zoom bands", () => {
  it("are live from 75%, read-only from 35%, and cards below, at their edges exactly", () => {
    expect([BAND_LIVE, BAND_CARDS]).toEqual([0.75, 0.35]);
    expect(bandOf(2)).toBe("live");
    expect(bandOf(0.75)).toBe("live");
    expect(bandOf(0.7499)).toBe("readonly");
    expect(bandOf(0.35)).toBe("readonly");
    expect(bandOf(0.3499)).toBe("cards");
    expect(bandOf(0.1)).toBe("cards");
    // only live takes keys; only cards attach no terminal
    expect((["live", "readonly", "cards"] as Band[]).map((b) => [takesKeys(b), attaches(b)])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
  });

  it("enter a band at its own edge, coming from nowhere or zooming in", () => {
    for (const z of [0.1, 0.3, 0.35, 0.5, 0.75, 1, 2]) expect(nextBand(z, null)).toBe(bandOf(z));
    expect(nextBand(0.35, "cards")).toBe("readonly");
    expect(nextBand(0.75, "readonly")).toBe("live");
    expect(nextBand(0.75, "cards")).toBe("live");
    expect(nextBand(0.749, "readonly")).toBe("readonly");
  });

  it("keep a band zooming out until the zoom is BAND_SLACK past its edge, so a pinch resting on one doesn't flip it", () => {
    const below = (edge: number) => edge * (1 - BAND_SLACK);
    expect(nextBand(0.74, "live")).toBe("live");
    expect(nextBand(below(BAND_LIVE), "live")).toBe("live");
    expect(nextBand(below(BAND_LIVE) - 1e-6, "live")).toBe("readonly");
    expect(nextBand(0.345, "readonly")).toBe("readonly");
    expect(nextBand(below(BAND_CARDS) - 1e-6, "readonly")).toBe("cards");
    // far past both edges at once: straight to cards
    expect(nextBand(0.2, "live")).toBe("cards");
    // a pinch going back and forth across 75% by less than the slack stays live, and once read-only stays so
    let b: Band = "live";
    for (const z of [0.76, 0.74, 0.73, 0.745, 0.74]) b = nextBand(z, b);
    expect(b).toBe("live");
    for (const z of [0.7, 0.74, 0.72, 0.749]) b = nextBand(z, b);
    expect(b).toBe("readonly");
  });
});

describe("what's on screen", () => {
  const vp = { w: 1000, h: 600 };
  const cam = { x: 0, y: 0, zoom: 1 };
  it("counts a workspace partly in view, or within the margin past the viewport's edges", () => {
    expect(ON_SCREEN_MARGIN).toBe(0.25);
    // in view, and partly in view
    expect(onScreen(cam, vp, { x: 100, y: 100, w: 200, h: 200 })).toBe(true);
    expect(onScreen(cam, vp, { x: -150, y: 100, w: 200, h: 200 })).toBe(true);
    // a quarter of the viewport past its right edge: 250 px at 100%
    expect(onScreen(cam, vp, { x: 1240, y: 0, w: 100, h: 100 })).toBe(true);
    expect(onScreen(cam, vp, { x: 1250, y: 0, w: 100, h: 100 })).toBe(false);
    // and past its top: 150 px
    expect(onScreen(cam, vp, { x: 0, y: -240, w: 100, h: 100 })).toBe(true);
    expect(onScreen(cam, vp, { x: 0, y: -250, w: 100, h: 100 })).toBe(false);
    expect(onScreen(cam, vp, { x: 1250, y: 0, w: 100, h: 100 }, 0.3)).toBe(true);
    expect(onScreen(cam, vp, { x: 1001, y: 0, w: 100, h: 100 }, 0)).toBe(false);
  });

  it("measures the margin on screen: zoomed out, the same share of the viewport covers more of the landscape", () => {
    const half = { x: 0, y: 0, zoom: 0.5 };
    // the viewport shows 2000 × 1200 of the landscape at 50%, and the margin is 500 more on the right
    expect(onScreen(half, vp, { x: 2490, y: 0, w: 10, h: 10 })).toBe(true);
    expect(onScreen(half, vp, { x: 2500, y: 0, w: 10, h: 10 })).toBe(false);
    // panned: what was on screen at the origin is off it
    expect(onScreen({ x: 5000, y: 0, zoom: 1 }, vp, { x: 100, y: 100, w: 200, h: 200 })).toBe(false);
  });

  it("lists the keys on screen in layout order", () => {
    const tiles = [
      { key: "a", rect: { x: 0, y: 0, w: 100, h: 100 } },
      { key: "far", rect: { x: 9000, y: 0, w: 100, h: 100 } },
      { key: "b", rect: { x: 1100, y: 0, w: 100, h: 100 } },
    ];
    expect(keysOnScreen(tiles, cam, vp)).toEqual(["a", "b"]);
    expect(keysOnScreen(tiles, { x: 8500, y: 0, zoom: 1 }, vp)).toEqual(["far"]);
  });
});

describe("a workspace's peek", () => {
  const vp = { w: 1100, h: 760 };
  it("is the workspace's size at 100%, made smaller to fit its share of the viewport, centred on it on screen", () => {
    const r = { x: 2000, y: 1000, w: 1072, h: 928 };
    // the workspace's centre near the viewport's: (550, 380) on screen
    const cam = { x: 703, y: 197, zoom: 0.3 };
    const box = peekBox(cam, vp, r);
    const k = Math.min((vp.w * PEEK_SHARE.w) / r.w, (vp.h * PEEK_SHARE.h) / r.h);
    expect([box.w, box.h]).toEqual([Math.round(r.w * k), Math.round(r.h * k)]);
    // the same shape as the workspace: its terminal is scaled, never given other cols or rows
    expect(box.w / box.h).toBeCloseTo(r.w / r.h, 2);
    const centre = { x: (r.x + r.w / 2 - cam.x) * cam.zoom, y: (r.y + r.h / 2 - cam.y) * cam.zoom };
    expect(Math.abs(box.x + box.w / 2 - centre.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.h / 2 - centre.y)).toBeLessThanOrEqual(1);
  });

  it("never grows a small workspace past 100%, and stays inside the viewport near its edges", () => {
    const small = peekBox({ x: 0, y: 0, zoom: 0.2 }, vp, { x: 0, y: 0, w: 400, h: 300 });
    expect([small.w, small.h]).toEqual([400, 300]);
    expect([small.x, small.y]).toEqual([PEEK_EDGE, PEEK_EDGE]);
    const corner = peekBox({ x: 0, y: 0, zoom: 0.25 }, vp, { x: 4300, y: 3000, w: 1072, h: 928 });
    expect(corner.x + corner.w).toBeLessThanOrEqual(vp.w - PEEK_EDGE);
    expect(corner.y + corner.h).toBeLessThanOrEqual(vp.h - PEEK_EDGE);
  });
});

describe("a card's last meaningful line", () => {
  it("passes over blank lines and spinner-only lines to the newest with words in it", () => {
    expect(lastMeaningfulLine(["⏺ Updated the dropdown.", "", "   ", "✻", "⠋ ", "· ✢ ✳", "", "|"])).toBe("⏺ Updated the dropdown.");
    // a spinner line with words is the agent saying what it's doing
    expect(lastMeaningfulLine(["⏺ Read(src/a.ts)", "✻ Writing the API change… (42s · esc to interrupt)", ""])).toBe("✻ Writing the API change… (42s · esc to interrupt)");
    expect(lastMeaningfulLine(["", "  ", "✶"])).toBeNull();
    expect(lastMeaningfulLine([])).toBeNull();
  });

  it("passes over rules and empty boxes, and trims a box's sides off the line it picks", () => {
    expect(lastMeaningfulLine(["Tests  9 passed (9)", "────────────", "╭──────────╮", "│          │", "╰──────────╯"])).toBe("Tests  9 passed (9)");
    expect(lastMeaningfulLine(["│ Done: 3 files changed │", "╰──────────────╯"])).toBe("Done: 3 files changed");
  });

  it("leaves an agent's own frame out: its prompt box or the rules around its input, and the hints under them", () => {
    const claude = ["⏺ The tag list re-renders on every keystroke.", "", "────────────────────────────", "> make it faster", "────────────────────────────", "  ⏵⏵ accept edits on (shift+tab to cycle)"];
    expect(lastMeaningfulLine(claude, { agent: "claude" })).toBe("⏺ The tag list re-renders on every keystroke.");
    const boxed = ["⏺ Added Donor and Gift.", "╭──────────────────────────╮", "│ > half-typed prompt      │", "╰──────────────────────────╯", "  ? for shortcuts"];
    expect(lastMeaningfulLine(boxed, { agent: "claude" })).toBe("⏺ Added Donor and Gift.");
    // a terminal's output is all its own: the same lines read as they are
    expect(lastMeaningfulLine(boxed)).toBe("? for shortcuts");
    expect(lastMeaningfulLine(["• Added tests/api/test_last_org.py (4 tests)", "• All passing", "", "› "], { agent: "codex" })).toBe("• All passing");
  });

  it("leaves Codex's composer out by its prompt mark: a half-typed draft, the placeholder, any height of draft, and the footer", () => {
    const footer = "  100% context left · ? for shortcuts";
    expect(lastMeaningfulLine(["• Added 3 tests for 404 and 403", "", "› fix the te", "", footer], { agent: "codex" })).toBe("• Added 3 tests for 404 and 403");
    expect(lastMeaningfulLine(["• All passing", "", "› Ask Codex to do anything", "", "  gpt-5 high · ~/backoffice"], { agent: "codex" })).toBe("• All passing");
    const tall = ["• Done: the export skips archived donors", "", "› first line of a long draft", ...Array.from({ length: 20 }, (_, i) => `  more of the draft, line ${i + 2}`), "", footer];
    expect(lastMeaningfulLine(tall, { agent: "codex" })).toBe("• Done: the export skips archived donors");
    // the transcript marks your own messages with it too: the lowest is the composer
    expect(lastMeaningfulLine(["› How do I add the keys?", "", "• Run the script", "", "› ", "", footer], { agent: "codex" })).toBe("• Run the script");
  });

  it("leaves Claude Code's input out however many lines the draft takes, and the status pinned over it full screen", () => {
    const rule = "─".repeat(60);
    const tall = ["⏺ Wrote the migration.", "", rule, "❯ first line of a long draft", ...Array.from({ length: 20 }, (_, i) => `  more of the draft, line ${i + 2}`), rule, "  ? for shortcuts"];
    expect(lastMeaningfulLine(tall, { agent: "claude" })).toBe("⏺ Wrote the migration.");
    const full = ["⏺ Wrote the migration.", "", "", `${" ".repeat(42)}● high · /effort`, rule, "❯ ", rule, "  ⏸ manual mode on · ? for shortcuts"];
    expect(lastMeaningfulLine(full, { agent: "claude" })).toBe("⏺ Wrote the migration.");
  });

  it("reads the real agents' screens, inline and full screen, to their last line of output", async () => {
    const cases = [
      ["codex-inline-60", "codex", 60, 40, "- second bullet"],
      ["claude-inline-60", "claude", 60, 50, "/private/tmp/somewhere/really/long/for/this/example"],
      ["claude-inline-100", "claude", 100, 50, "npm run build -- --mode production --out-dir /private/tmp/somewhere/really/long/for/this/example"],
      ["claude-full-60", "claude", 60, 60, "/private/tmp/somewhere/really/long/for/this/example"],
    ] as const;
    for (const [name, agent, cols, rows, want] of cases) {
      const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 1000 });
      await new Promise<void>((r) => term.write(fs.readFileSync(path.join(__dirname, "fixtures", "agentWraps", `${name}.txt`), "utf8"), r));
      expect(lastMeaningfulLine(tailLines(term), { agent }), name).toBe(want);
      term.dispose();
    }
  });

  it("reads a terminal's buffer with a row wrapped onto the next joined to it", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 6, scrollback: 100 });
    await new Promise<void>((r) => term.write("first line\r\n" + "x".repeat(25) + " end\r\n\r\n✻\r\n", r));
    const lines = tailLines(term);
    expect(lines.filter(Boolean)).toEqual(["first line", "x".repeat(25) + " end", "✻"]);
    expect(lastMeaningfulLine(lines, { agent: "claude" })).toBe("x".repeat(25) + " end");
    // the last `max` lines only
    expect(tailLines(term, 2)).toHaveLength(2);
    term.dispose();
  });
});
