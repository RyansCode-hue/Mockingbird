import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// A pane whose agent quit into a terminal, in the UI preview, in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?agentQuit (src/preview/stub.ts): s5's Claude has quit (/exit), so s5
// is a terminal in its folder; without it, /exit sent to an agent pane quits it there and then, as main's does.
// window.__mbCalls is what the window asked main for.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

/**
 * Open the preview at `query`, wait for `ready` (a selector), run `steps` (an async function body with `$` for
 * querySelector, `sleep`, `calls()` for window.__mbCalls and `pane(id)` for what session `id`'s focused workspace
 * shows) once, and return what it returns.
 */
async function drive<T>(query: string, ready: string, steps: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const read = `(() => {
    const w = window;
    if (!w.__qRun) {
      if (!document.querySelector(${JSON.stringify(ready)})) return null;
      const $ = (s) => document.querySelector(s);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = () => w.__mbCalls.map((c) => ({ fn: c.fn, args: c.args }));
      const pane = (id) => {
        const kind = $('[data-front="' + id + '"] .ls-kind');
        const note = $('[data-front="' + id + '"] .team-pane-note.agent-quit');
        return {
          kind: kind ? kind.textContent : null,
          note: note ? note.querySelector(".reason").textContent : null,
          button: note && note.querySelector("button") ? note.querySelector("button").textContent : null,
        };
      };
      w.__qRun = (async () => { ${steps} })().then((v) => (w.__qOut = JSON.stringify(v ?? null)), (e) => (w.__qOut = JSON.stringify({ failed: String(e && e.stack || e) })));
    }
    return w.__qOut ?? null;
  })()`;
  const out: string = await pageResult({ size: "1600x900", query: `motion=off&${query}`, outDir: path.join(tempDir("exitToTerminal"), "out"), read });
  return JSON.parse(out);
}

type Pane = { kind: string | null; note: string | null; button: string | null };

describe.skipIf(!local)("a pane whose agent quit into a terminal, in the window", () => {
  it("says so over its terminal, and Resume Claude makes it the Claude pane again", async () => {
    const r = await drive<{ before: Pane; resumes: unknown[]; others: string[]; after: Pane }>(
      "agentQuit&lsFocus=s5",
      '[data-front="s5"] .team-pane-note.agent-quit button',
      `
      await sleep(200);
      const before = pane("s5");
      $('[data-front="s5"] .team-pane-note.agent-quit button').click();
      for (let i = 0; i < 40 && pane("s5").note; i++) await sleep(100);
      return {
        before,
        resumes: calls().filter((c) => c.fn === "resumeAgent").map((c) => c.args),
        others: calls().filter((c) => c.fn === "resumeSession" || c.fn === "sessionRestart").map((c) => c.fn),
        after: pane("s5"),
      };`
    );
    expect(r.before).toEqual({ kind: "Terminal", note: "Claude exited · this is a terminal now", button: "Resume Claude" });
    expect(r.resumes).toEqual([["s5"]]);
    expect(r.others).toEqual([]);
    expect(r.after).toEqual({ kind: "Claude", note: null, button: null });
  });

  it("turns an agent pane into a terminal when its agent quits, in place", async () => {
    const r = await drive<{ before: Pane; after: Pane; buffer: string }>(
      "lsFocus=s5",
      '[data-front="s5"] .ls-kind',
      `
      await sleep(200);
      const before = pane("s5");
      await window.mb.sessionWrite("s5", "/exit\\r");
      for (let i = 0; i < 40 && !pane("s5").note; i++) await sleep(100);
      return { before, after: pane("s5"), buffer: await window.mb.sessionBuffer("s5") };`
    );
    expect(r.before).toEqual({ kind: "Claude", note: null, button: null });
    expect(r.after).toEqual({ kind: "Terminal", note: "Claude exited · this is a terminal now", button: "Resume Claude" });
    expect(r.buffer).toContain("Claude exited — this is now a terminal in ~/Code/worktrees/backoffice/5102-quickViewFreeze.");
  });
});
