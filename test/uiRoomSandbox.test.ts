import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The room sandbox switch in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the script
// passes a mock keychain. ?roomSandbox (src/preview/stub.ts): 5101's sandbox is switched off on this Mac (=on: back on
// since); s8 started with it off, s1 and s2 in it, and s5 left a room whose sandbox it started in. window.__mbCalls is
// what the window asked main for.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

const ROOM_5101 = "R5101aaaaaaaaaaaaaaaaa";

/**
 * Open the preview at `query`, wait for `ready` (a selector), run `steps` (an async function body with `$` for
 * querySelector, `sleep`, `calls()` for window.__mbCalls and `chips(id)` for the header chips of session `id`'s
 * workspace, as [tag, class, text, title]) once, and return what it returns.
 */
async function drive<T>(query: string, ready: string, steps: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const read = `(() => {
    const w = window;
    if (!w.__sbRun) {
      if (!document.querySelector(${JSON.stringify(ready)})) return null;
      const $ = (s) => document.querySelector(s);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = () => w.__mbCalls.map((c) => ({ fn: c.fn, args: c.args }));
      const chips = (id) => [...document.querySelectorAll('[data-front="' + id + '"] .ls-chips .chip')].map((c) => [c.tagName.toLowerCase(), c.className, c.textContent, c.title]);
      w.__sbRun = (async () => { ${steps} })().then((v) => (w.__sbOut = JSON.stringify(v ?? null)), (e) => (w.__sbOut = JSON.stringify({ failed: String(e && e.stack || e) })));
    }
    return w.__sbOut ?? null;
  })()`;
  const out: string = await pageResult({ size: "1600x900", query: `motion=off&${query}`, outDir: path.join(tempDir("roomSandbox"), "out"), read });
  return JSON.parse(out);
}

type Chip = [tag: string, cls: string, text: string, title: string];
const sandboxChips = (chips: Chip[]) => chips.filter((c) => /room sandbox/.test(c[2]));

describe.skipIf(!local)("the room sandbox switch, in the window", () => {
  it("is on for each room in Settings → Team; off asks first, saying what it opens; back on doesn't ask", async () => {
    const SWITCH = `[aria-label^="Sandbox this room's sessions: #5101"]`;
    const r = await drive<{ before: string | null; dialog: string; savedOnAsk: unknown[]; afterCancel: string | null; saved: unknown[]; after: string | null; note: string; askedAgain: boolean }>(
      "section=team",
      SWITCH,
      `
      const saves = () => calls().filter((c) => c.fn === "setSettings" && "roomsUnsandboxed" in c.args[0]).map((c) => c.args[0].roomsUnsandboxed);
      const before = $(${JSON.stringify(SWITCH)}).getAttribute("aria-checked");
      $(${JSON.stringify(SWITCH)}).click();
      await sleep(200);
      const dialog = $(".modal.team-dlg").textContent;
      const savedOnAsk = saves();
      [...document.querySelectorAll(".modal.team-dlg button")].find((b) => b.textContent === "Cancel").click();
      await sleep(200);
      const afterCancel = $(".modal.team-dlg") ? "open" : $(${JSON.stringify(SWITCH)}).getAttribute("aria-checked");
      $(${JSON.stringify(SWITCH)}).click();
      await sleep(200);
      [...document.querySelectorAll(".modal.team-dlg button")].find((b) => b.textContent === "Turn the sandbox off").click();
      await sleep(200);
      const after = $(${JSON.stringify(SWITCH)}).getAttribute("aria-checked");
      const note = $(${JSON.stringify(SWITCH)}).closest(".set-row").textContent;
      $(${JSON.stringify(SWITCH)}).click();
      await sleep(200);
      return { before, dialog, savedOnAsk, afterCancel, saved: saves(), after, note, askedAgain: !!$(".modal.team-dlg") };`
    );
    expect(r.before).toBe("true");
    expect(r.dialog).toContain("Run sessions without the sandbox in #5101");
    expect(r.dialog).toContain("On this Mac only, as its sessions start or restart.");
    expect(r.dialog).toContain("your git and GitHub credentials, your MCP servers (Slack…), ~/.claude, Docker and your caches");
    expect(r.dialog).toContain("So does anyone you let type into them, and anything a teammate's agent sends them.");
    expect(r.dialog).toContain("Teammates' Macs decide for themselves");
    // nothing is saved until it's confirmed, and Cancel leaves it on
    expect(r.savedOnAsk).toEqual([]);
    expect(r.afterCancel).toBe("true");
    expect(r.after).toBe("false");
    expect(r.note).toContain("Off on this Mac: its Claude and Codex sessions run like your own");
    // turned back on, it's saved at once
    expect(r.askedAgain).toBe(false);
    expect(r.saved).toEqual([[ROOM_5101], []]);
  }, 120_000);

  /** Session `id`'s header chips, with it in focus (its header at full width), under `query`. */
  const chipsOf = (id: string, query: string) => drive<Chip[]>(`${query}&lsFocus=${id}`, `[data-front="${id}"] .ls-chips`, `await sleep(300); return chips(${JSON.stringify(id)});`);

  it("says on a session started without the room's sandbox that it runs without it, and offers the restart on one that keeps a sandbox it no longer needs, in the room or out of it", async () => {
    expect(sandboxChips(await chipsOf("s8", "roomSandbox"))).toEqual([
      ["span", "chip warn", "no room sandbox", expect.stringContaining("Its room's sandbox is off on this Mac (Settings → Team), so this session runs with your credentials, MCP servers and home folder")],
    ]);
    expect(sandboxChips(await chipsOf("s1", "roomSandbox"))).toEqual([["button", "chip", "room sandbox on · restart", expect.stringContaining("its room's sandbox is switched off on this Mac now")]]);
    const r = await drive<{ s5: Chip[]; restarts: unknown[]; after: Chip[] }>(
      "roomSandbox&lsFocus=s5",
      '[data-front="s5"] .ls-chips',
      `
      await sleep(300);
      const s5 = chips("s5");
      [...document.querySelectorAll('[data-front="s5"] .ls-chips button.chip')].find((b) => b.textContent === "room sandbox on · restart").click();
      for (let i = 0; i < 30 && chips("s5").some((c) => /room sandbox/.test(c[2])); i++) await sleep(100);
      return { s5, restarts: calls().filter((c) => c.fn === "sessionRestart").map((c) => c.args[0]), after: chips("s5") };`
    );
    expect(sandboxChips(r.s5)).toEqual([["button", "chip", "room sandbox on · restart", expect.stringContaining("it has left its team room since")]]);
    expect(r.restarts).toEqual(["s5"]);
    // restarted, it starts outside the room, with nothing kept
    expect(sandboxChips(r.after)).toEqual([]);
  }, 180_000);

  it("offers the restart on a session started without the sandbox once its room's sandbox is back on", async () => {
    expect(sandboxChips(await chipsOf("s8", "roomSandbox=on"))).toEqual([["button", "chip warn", "no room sandbox · restart", expect.stringContaining("nothing crosses the room's line for it")]]);
    expect(sandboxChips(await chipsOf("s1", "roomSandbox=on"))).toEqual([]);
  }, 180_000);

  it("takes a room's workspace out of the room from its menu's Move to area…: Remove from group leaves it loose, with no other area needed", async () => {
    const r = await drive<{ dialog: string; moves: unknown[] }>(
      "lsFocus=s8",
      '[data-front="s8"] .ls-chips',
      `
      await sleep(300);
      const title = $('[data-front="s8"] .ls-title');
      const at = title.getBoundingClientRect();
      title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.left + 5, clientY: at.top + 5 }));
      for (let i = 0; i < 20 && ![...document.querySelectorAll("[role=menuitem]")].some((b) => b.textContent.startsWith("Move to area…")); i++) await sleep(100);
      const item = [...document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent.startsWith("Move to area…"));
      if (!item) return { dialog: "no Move to area… in its menu: " + [...document.querySelectorAll("[role=menuitem]")].map((b) => b.textContent).join(" | "), moves: [] };
      item.click();
      for (let i = 0; i < 20 && !$(".modal.close-dlg"); i++) await sleep(100);
      const dlg = $(".modal.close-dlg");
      if (!dlg) return { dialog: "no dialog", moves: [] };
      const dialog = dlg.textContent;
      [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Remove from group").click();
      await sleep(200);
      return { dialog, moves: calls().filter((c) => c.fn === "setGroup").map((c) => c.args) };`
    );
    expect(r.dialog).toMatch(/^Move Release notes for #5101.*Group5101.*Remove from group/);
    expect(r.moves).toEqual([["s8", null]]);
  }, 120_000);
});
