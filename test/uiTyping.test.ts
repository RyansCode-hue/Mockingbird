import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Typing consent in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the script
// passes a mock keychain. The fixtures (src/preview/stub.ts): Nick may type in s1 for 12 more minutes; with
// ?typingAsk he asks to type in s8; Nick's own session is view-only here, and with ?typingRefused you just typed into it.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

const NICK_PANE = "r~0f1e2d3c4b5a~n1";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function dom(query: string, size = "1500x900"): Promise<string> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageDom } = await import("../scripts/ui-preview.mjs");
  return pageDom({ size, query, outDir: path.join(tempDir("typing"), "out") });
}

/** Run `read` in the page until it gives something other than null. */
async function result(query: string, read: string): Promise<string> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  return pageResult({ size: "1500x900", query, outDir: path.join(tempDir("typing"), "out"), read });
}

describe.skipIf(!local)("typing into teammates' sessions, in the window", () => {
  it("asks the owner on the pane, and shows who can type with a way to stop it", async () => {
    const html = await dom(`shown=s1,s8,${NICK_PANE}&typingAsk&typingRefused`);
    const t = text(html);
    expect(t).toContain("Nick wants to type in “Release notes for #5101” Allow for this session Allow for 15 min Deny");
    expect(html).toMatch(/class="chip typist"[^>]*>Nick can type · 12 min<button class="typist-x" aria-label="Stop Nick Smith typing">/);
    // the teammate's side: view-only, with Ask to type, and why the keys just typed didn't go
    expect(t).toContain("View only · Ask to type");
    expect(t).toContain("Nick Smith hasn't allowed typing Ask to type");
  }, 90_000);

  it("Allow for 15 min turns the ask into “Nick can type · 15 min”", async () => {
    const read = `(() => {
      const allow = [...document.querySelectorAll(".typing-ask button")].find((b) => b.textContent === "Allow for 15 min");
      if (!window.__asked) {
        if (!allow) return null;
        window.__asked = true;
        allow.click();
        return null;
      }
      const chips = [...document.querySelectorAll(".chip.typist")].map((c) => c.textContent);
      return chips.length === 2 && !document.querySelector(".typing-ask") ? JSON.stringify(chips) : null;
    })()`;
    expect(JSON.parse(await result(`shown=s1,s8&typingAsk`, read)).sort()).toEqual(["Nick can type · 12 min✕", "Nick can type · 15 min✕"]);
  }, 90_000);

  it("✕ takes typing back", async () => {
    const read = `(() => {
      const x = document.querySelector(".chip.typist .typist-x");
      if (!window.__stopped) {
        if (!x) return null;
        window.__stopped = true;
        x.click();
        return null;
      }
      return document.querySelector(".chip.typist") ? null : "gone";
    })()`;
    expect(await result(`shown=s1`, read)).toBe("gone");
  }, 90_000);

  it("keeps the prompt's buttons inside a narrow pane", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageDom } = await import("../scripts/ui-preview.mjs");
    const html: string = await pageDom({ size: "900x700", query: `shown=s1,s8,s4,${NICK_PANE}&typingAsk&measure=${encodeURIComponent(".typing-ask button")}&measure=${encodeURIComponent(".pane")}`, outDir: path.join(tempDir("typing"), "out") });
    const boxes = JSON.parse(html.match(/<script type="application\/json" id="mb-measure">([\s\S]*?)<\/script>/)![1]);
    const buttons: { x: number; y: number; w: number; h: number }[] = boxes[".typing-ask button"];
    expect(buttons).toHaveLength(3);
    const panes: { x: number; y: number; w: number; h: number }[] = boxes[".pane"];
    for (const b of buttons) {
      expect(b.w).toBeGreaterThan(0);
      expect(panes.some((p) => b.x >= p.x && b.x + b.w <= p.x + p.w + 0.5 && b.y >= p.y && b.y + b.h <= p.y + p.h)).toBe(true);
    }
  }, 90_000);

  it("lists recent remote activity in Settings → Team", async () => {
    const t = text(await dom("section=team", "1100x2600"));
    expect(t).toContain("Recent remote activity");
    expect(t).toContain("You let Nick Smith type in “Org dropdowns remember the last org”");
    expect(t).toContain("Refused Nick Smith's typing in “API: last org per user” (2 writes, 2 bytes): its agent was asking for permission");
  }, 90_000);
});
