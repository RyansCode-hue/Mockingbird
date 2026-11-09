import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import pkg from "../package.json";

// Layout, measured in the UI preview in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. Each check renders a screen with ?measure=<selector> and reads the boxes back.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Box = { x: number; y: number; w: number; h: number; text: string };

async function render(size: string, query: string, measure: string[] = []): Promise<{ html: string; boxes: Record<string, Box[]> }> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageDom } = await import("../scripts/ui-preview.mjs");
  const q = [query, ...measure.map((m) => `measure=${encodeURIComponent(m)}`)].filter(Boolean).join("&");
  const html: string = await pageDom({ size, query: q, outDir: path.join(tempDir("layout"), "out") });
  const json = html.match(/<script type="application\/json" id="mb-measure">([\s\S]*?)<\/script>/)?.[1];
  return { html, boxes: json ? JSON.parse(json) : {} };
}

const shown = (b: Box) => b.w > 0 && b.h > 0;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
/** Every pair of a box in `over` and one in `under` that overlap, by their text. */
const collisions = (over: Box[], under: Box[]) =>
  over.filter(shown).flatMap((a) => under.filter(shown).filter((b) => overlaps(a, b)).map((b) => `${a.text || "(actions)"} × ${b.text}`));

describe.skipIf(!local)("the interface's layout", () => {
  // ?paneControls shows every row's actions at once, as a hover shows one row's
  const rowParts = [".sess-item .sr-acts", ".sess-item .nm", ".sess-item .name > .br", ".sess-item .name button:not(.lbtn)"];
  for (const size of ["1500x900", "1000x700"]) {
    for (const [where, query] of [
      ["a room in the Team view", "view=room&paneControls"],
      ["the grid's Sessions view", "labs=off&paneControls"],
      ["a room in the grid's Team view", "labs=off&view=room&paneControls"],
    ] as const) {
      it(`keeps a row's actions on its title line, clear of its name and the lines and buttons under it: ${where}, ${size}`, async () => {
        const { boxes } = await render(size, query, rowParts);
        const [acts, names, lines, buttons] = rowParts.map((s) => boxes[s] ?? []);
        expect(acts.filter(shown).length).toBeGreaterThan(3);
        expect(lines.filter(shown).length).toBeGreaterThan(3);
        expect(collisions(acts, [...names, ...lines, ...buttons])).toEqual([]);
        // on the title line: level with a name
        for (const a of acts.filter(shown)) expect(names.some((n) => Math.abs(n.y + n.h / 2 - (a.y + a.h / 2)) < 4)).toBe(true);
      }, 90_000);
    }

      it(`keeps an area tree row's name clear of what's beside it, all inside the side bar: ${size}`, async () => {
        const parts = [".sidebar", ".area-tree .lt-t", ".area-tree .lt-tag", ".area-tree .lt-badge", ".area-tree .lt-chev"];
        const { boxes } = await render(size, "", parts);
        const [[side], names, ...beside] = parts.map((s) => boxes[s] ?? []);
        expect(names.filter(shown).length).toBeGreaterThan(5);
        expect(collisions(names, beside.flat())).toEqual([]);
        for (const b of [...names, ...beside.flat()].filter(shown)) expect(b.x + b.w, b.text).toBeLessThanOrEqual(side.x + side.w + 0.5);
      }, 90_000);
  }

  const councilControls = [".collab-inspector-wrap", ".collab-head .seg", ".collab-panel-toggle", ".collab-controls button", ".collab-bar textarea"];
  for (const size of ["1000x700", "760x700"]) {
    it(`keeps a council's Thread/Rounds switch, details toggle, composer, Run and Send clear of its inspector at ${size}`, async () => {
      const { boxes } = await render(size, "tab=collaborate", councilControls);
      const [inspector, ...controls] = councilControls.map((s) => boxes[s] ?? []);
      expect(inspector.filter(shown)).toHaveLength(1);
      expect(controls.flat().filter(shown).length).toBeGreaterThan(5);
      expect(collisions(inspector, controls.flat())).toEqual([]);
    }, 90_000);
  }

  it("fills the CLAUDE.md editor from the fixture, and shows a read that failed outright", async () => {
    const parts = [".control .editor .path", ".control .editor .err-inline"];
    const ok = await render("1200x800", "section=control", parts);
    expect(ok.boxes[parts[0]].map((b) => b.text)).toEqual(["/Users/you/.claude/CLAUDE.md"]);
    expect(ok.boxes[parts[1]]).toEqual([]);
    const failed = await render("1200x800", "section=control&claudeMd=error", parts);
    expect(failed.boxes[parts[1]][0]?.text).toMatch(/^Couldn't read ~\/\.claude\/CLAUDE\.md: .*EACCES/);
  }, 120_000);

  it("says a failed Settings check once per section, with one Retry, and never leaves a row checking", async () => {
    const parts = [".set-row .set-row-note", ".set-row .set-row-ctl button", ".set-check-failed .msg", ".set-check-failed button"];
    const ok = await render("1200x800", "section=agents", parts);
    expect(ok.boxes[parts[0]].map((b) => b.text)).toContain("2.1.290 · signed in");
    expect(ok.boxes[parts[1]].map((b) => b.text)).not.toContain("Retry");
    expect(ok.boxes[parts[2]]).toEqual([]);
    // a rejected call (no handler) and an { error } answer; `quiet` is how many rows the section's notice speaks for
    const noHandler = /No handler registered for 'setup:status'/;
    const timedOut = /the login shell timed out/;
    for (const [query, failure, quiet] of [
      ["section=agents&checks=error", noHandler, 3],
      ["section=agents&checks=reply", timedOut, 3],
      ["section=repos&checks=reply", timedOut, 2],
      ["section=ado&checks=error", noHandler, 0],
      ["section=debriefs&checks=reply", timedOut, 0],
    ] as const) {
      const { boxes } = await render("1200x800", query, parts);
      const [notes, rowButtons, notice, noticeButtons] = parts.map((p) => boxes[p].map((b) => b.text));
      const said = [...notes, ...notice];
      expect(said.filter((t) => failure.test(t)), `${query}: ${said.join(" | ")}`).toHaveLength(1);
      expect(said.filter((t) => t.startsWith("Couldn't check")), query).toHaveLength(1);
      expect(notes.filter((n) => n === "checking…" || n === "scanning…"), query).toEqual([]);
      expect([...rowButtons, ...noticeButtons].filter((t) => t === "Retry"), query).toHaveLength(1);
      // several rows on one check: the notice says it and those rows read "—"; a single row says it itself
      expect(notice, query).toHaveLength(quiet ? 1 : 0);
      expect(notes.filter((n) => n === "—"), query).toHaveLength(quiet);
    }
  }, 240_000);

  it("keeps the status bar's restart button whole in a narrow window", async () => {
    const { boxes } = await render("1000x700", "", [".statusbar .sb-update"]);
    const [pill] = boxes[".statusbar .sb-update"] ?? [];
    expect(pill?.text).toBe("↻ Restart 1");
    expect(pill.w).toBeGreaterThan(60);
  }, 90_000);

  it("keeps a tall dialog's title and closing buttons in the window: the House board at 1000×700", async () => {
    const parts = [".house-modal > .house-head", ".house-modal > .row:last-child"];
    const { boxes } = await render("1000x700", "house=1", parts);
    const [head, foot] = parts.map((s) => boxes[s]?.[0]);
    expect(head && shown(head)).toBe(true);
    expect(foot && shown(foot)).toBe(true);
    expect(head.y).toBeGreaterThanOrEqual(0);
    expect(foot.y + foot.h).toBeLessThanOrEqual(700);
  }, 90_000);

  for (const [where, query] of [["the Team view", "view=room&chat=R5101aaaaaaaaaaaaaaaaa"], ["the grid's Team view", "labs=off&view=room"]]) {
    it(`keeps the room composer's # completion inside the sidebar: ${where}`, async () => {
      const parts = [".sidebar", ".rc-suggest", ".rc-sug"];
      const { boxes } = await render("1500x900", `${query}&composer=%23spec`, parts);
      const [side] = boxes[".sidebar"];
      const [pop] = boxes[".rc-suggest"] ?? [];
      expect(pop && shown(pop)).toBe(true);
      expect(pop.x + pop.w).toBeLessThanOrEqual(side.x + side.w);
      for (const row of boxes[".rc-sug"]) expect(row.x + row.w).toBeLessThanOrEqual(pop.x + pop.w);
    }, 90_000);
  }

  it("shows the version being built", async () => {
    const { html } = await render("1200x800", "");
    expect(html).toContain(`v${pkg.version}`);
  }, 90_000);
});
