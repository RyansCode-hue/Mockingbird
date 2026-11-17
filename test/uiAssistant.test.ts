import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { askPlace, cardState, nextChange, undoLive } from "../src/renderer/assistantModel";
import type { AssistantCard, AssistantStep, AssistantView } from "../src/shared/assistant";

// The app Assistant's window side (docs/assistant.md → The sheet and ⌘K) in the UI preview, in real headless Chrome:
// local only (CI runners have no desktop); the script passes a mock keychain. src/preview/assistantStub.ts stands in for
// main: ?assistant=open opens the sheet on its fixtures (a done direct step st1 with a live Undo, an undone st2 and a
// failed st3; card c1 running; open cards c2 (its prompt's pane lines), c3 (danger), c4 (blocked) and c6 (a message,
// whole, with its warnings); c5 settled; rule1 on, rule2 paused, each with its actions spelled out; a run).
// window.__mbCalls is what the window asked main for.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

/**
 * Open the preview at `query`, wait for `ready` (a selector), run `steps` (an async function body) once, and return
 * what it returns. In `steps`: `$`/`$$` query the page, `sleep`, `until(fn, ms)` polls, `calls()` is window.__mbCalls,
 * `asked(mark)` the Assistant calls since call `mark` (its view reads left out), `rows()` the palette's rows ("ASK" for
 * Ask Assistant, "*" on the selected one), `typeQ(text)` types into the palette, `openPalette()` presses ⌘K.
 *
 * For the keyboard: `press(...keys)` presses for real (scripts/ui-preview.mjs's window.__mbKeys), `click(el)` presses
 * the mouse on an element's middle, `where()` names what has the keyboard ("term:<id>" for a session's terminal,
 * "holder" for keyArm's, else tag.class), `termIn(id)` waits for session `id`'s terminal to have it, `typed(mark)` is
 * what reached a session's pty since call `mark` ("<id>:<data>"), `swallowed` the keys the holder swallowed.
 */
async function drive<T>(query: string, ready: string, steps: string, { size = "1400x900", motion = "off" } = {}): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const read = `(() => {
    const w = window;
    if (!w.__asRun) {
      if (!document.querySelector(${JSON.stringify(ready)})) return null;
      const $ = (s) => document.querySelector(s);
      const $$ = (s) => [...document.querySelectorAll(s)];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, ms = 4000) => {
        for (let i = 0; i < ms / 50; i++) {
          if (fn()) return true;
          await sleep(50);
        }
        return !!fn();
      };
      const calls = () => w.__mbCalls.map((c) => ({ fn: c.fn, args: c.args }));
      const asked = (mark) => w.__mbCalls.slice(mark).filter((c) => c.fn.startsWith("assistant") && c.fn !== "assistantView").map((c) => [c.fn, ...c.args]);
      const press = async (...ks) => {
        const done = (w.__mbKeysDone || 0) + ks.length;
        (w.__mbKeys ||= []).push(...ks);
        for (let i = 0; i < 200 && (w.__mbKeysDone || 0) < done; i++) await sleep(25);
      };
      const click = (el) => {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = el.getBoundingClientRect();
        return press({ mouse: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickCount: 1 } });
      };
      const where = () => {
        const a = document.activeElement;
        if (!a || a === document.body) return "body";
        if (a.classList.contains("mb-keys-nowhere")) return "holder";
        if (a.closest(".xterm")) return "term:" + (a.closest(".ls-node")?.dataset.front ?? "?");
        return a.tagName.toLowerCase() + "." + [...a.classList].join(".");
      };
      const termIn = async (id, ms = 4000) => {
        for (let i = 0; i < ms / 50 && where() !== "term:" + id; i++) await sleep(50);
        return where();
      };
      const typed = (mark) => w.__mbCalls.slice(mark).filter((c) => c.fn === "sessionWrite").map((c) => c.args[0] + ":" + c.args[1]);
      const swallowed = [];
      document.addEventListener("mb-keys-swallowed", (e) => swallowed.push(e.detail));
      const rows = () => $$(".palette .results .row").map((r) => (r.classList.contains("ask") ? "ASK" : r.querySelector(".lab").textContent) + (r.classList.contains("sel") ? "*" : ""));
      const openPalette = async () => {
        await press({ key: "k", meta: true });
        await until(() => !!$(".palette input"), 2000);
      };
      const typeQ = async (text) => {
        const input = $(".palette input");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(150);
      };
      w.__asRun = (async () => { ${steps} })().then((v) => (w.__asOut = JSON.stringify(v ?? null)), (e) => (w.__asOut = JSON.stringify({ failed: String(e && e.stack || e) })));
    }
    return w.__asOut ?? null;
  })()`;
  const out: string = await pageResult({ size, query: `motion=${motion}&${query}`, outDir: path.join(tempDir("assistant"), "out"), read });
  const parsed = JSON.parse(out);
  if (parsed && typeof parsed === "object" && "failed" in parsed) throw new Error(`the page's steps failed: ${parsed.failed}`);
  return parsed;
}

describe("the Assistant's window-side rules", () => {
  it("places ⌘K's Ask row: nowhere for nothing, first for no match or a sentence, last otherwise and for a row's own words", () => {
    expect(askPlace("   ", ["Landscape"])).toBe("none");
    expect(askPlace("zzqx", [])).toBe("first");
    expect(askPlace("landscape", ["Landscape"])).toBe("last");
    expect(askPlace("restart api fix", ["Restart all agent sessions"])).toBe("first");
    expect(askPlace("restart  api\tfix", ["Restart all agent sessions"])).toBe("first");
    expect(askPlace("api fix", ["API: last org per user"])).toBe("last");
    expect(askPlace("go to 5110", ["Go to 5110 — its area on the landscape"])).toBe("last");
    expect(askPlace("Go to 5102", ["Go to #5102 Pathways quick view freezes — its area on the landscape"])).toBe("last");
    expect(askPlace("go to 51", ["Go to #5102 Pathways quick view freezes — its area on the landscape"])).toBe("last");
    expect(askPlace("Toggle  the log panel", ["Toggle the log panel"])).toBe("last");
    // a sentence is a question even when each word is in some row: no one row holds them all
    expect(askPlace("restart api-fix in plan mode", ["Restart all agent sessions", "API: last org per user", "Go to #5102 — its area on the landscape"])).toBe("first");
    expect(askPlace("what's waiting on me?", ["Next waiting session"])).toBe("first");
  });

  const step = (over: Partial<AssistantStep>): AssistantStep => ({ id: "s", tool: "move", tier: "direct", label: "Moved", state: "done", ...over });
  const card = (over: Partial<AssistantCard>): AssistantCard => ({ id: "c", turnId: "t", tool: "restart", title: "Restart", detail: "", warnings: [], state: "open", expiresAt: 2_000, ...over });

  it("offers Undo only on a direct step that's done, while its window is open", () => {
    expect(undoLive(step({ undoUntil: 1_001 }), 1_000)).toBe(true);
    expect(undoLive(step({ undoUntil: 1_000 }), 1_000)).toBe(false);
    expect(undoLive(step({}), 1_000)).toBe(false);
    expect(undoLive(step({ undoUntil: 5_000, state: "undone" }), 1_000)).toBe(false);
    expect(undoLive(step({ undoUntil: 5_000, tier: "confirm" }), 1_000)).toBe(false);
  });

  it("shows an open card past its time as expired, and wakes the sheet at the next Undo or card to run out", () => {
    expect(cardState(card({}), 1_999)).toBe("open");
    expect(cardState(card({}), 2_000)).toBe("expired");
    expect(cardState(card({ state: "done" }), 9_000)).toBe("done");
    const view: AssistantView = {
      turns: [{ id: "t", at: 0, text: "x", state: "done", steps: [step({ undoUntil: 3_000 }), step({ undoUntil: 500 })] }],
      cards: [card({}), card({ state: "done", expiresAt: 1_500 })],
      rules: [],
      runs: [{ id: "r", ruleId: "q", at: 0, ok: true, text: "", steps: [step({ undoUntil: 2_500 })] }],
      busy: false,
    };
    expect(nextChange(view, 1_000)).toBe(2_000);
    expect(nextChange(view, 2_000)).toBe(2_500);
    expect(nextChange(view, 3_000)).toBe(null);
  });
});

describe.skipIf(!local)("⌘K's Ask Assistant row", () => {
  it("joins once something is typed: first and selected when nothing matches or it reads as a sentence, last otherwise, and last for a row's own words", async () => {
    const r = await drive<Record<string, string[]>>(
      "",
      ".ls-viewport",
      `
      await sleep(400);
      await openPalette();
      const empty = rows().filter((x) => x.startsWith("ASK"));
      await typeQ("landscape");
      const one = rows();
      await typeQ("zzqx");
      const none = rows();
      await typeQ("what is waiting on me");
      const sentence = rows();
      await typeQ("Toggle the log panel");
      const literal = rows();
      return { empty, one, none, sentence, literal };`
    );
    expect(r.empty).toEqual([]);
    expect(r.one.length).toBeGreaterThan(1);
    expect(r.one[0]).toMatch(/\*$/);
    expect(r.one.at(-1)).toBe("ASK");
    expect(r.none).toEqual(["ASK*"]);
    expect(r.sentence[0]).toBe("ASK*");
    expect(r.literal[0]).toMatch(/^Toggle the log panel.*\*$/);
    expect(r.literal.at(-1)).toBe("ASK");
  }, 120_000);

  it("asks with ⌘⏎ even when the row is last, and with ⏎ when it's selected: the palette closes, the sheet opens and the turn goes queued, thinking, answered", async () => {
    const r = await drive<{ cmdEnter: unknown[]; palette: boolean; sheet: boolean; states: string[]; waits: string[]; reply: string; enter: unknown[]; you: string; html: boolean }>(
      "assistantMs=500",
      ".ls-viewport",
      `
      await sleep(400);
      await openPalette();
      await typeQ("landscape");
      const mark = calls().length;
      await press({ key: "Enter", meta: true });
      const cmdEnter = asked(mark);
      await until(() => !!$(".as-sheet"), 2000);
      const states = [];
      const waits = [];
      for (let i = 0; i < 120; i++) {
        const t = $('.as-turn[data-turn^="ask"]');
        const s = t?.dataset.state;
        if (s && states[states.length - 1] !== s) {
          states.push(s);
          waits.push(t.querySelector(".as-wait")?.textContent ?? "");
        }
        if (s === "done") break;
        await sleep(40);
      }
      const palette = !!$(".palette");
      const sheet = !!$(".as-sheet");
      const reply = $('.as-turn[data-turn="ask1"] .as-reply')?.textContent ?? "";
      // ⏎ on the row when it's first: words with markup in them stay text, in the question and in the reply
      await openPalette();
      await typeQ("what is <b>waiting</b> on me");
      const mark2 = calls().length;
      await press({ key: "Enter" });
      const enter = asked(mark2);
      await until(() => $('.as-turn[data-turn="ask2"]')?.dataset.state === "done", 4000);
      const t2 = $('.as-turn[data-turn="ask2"]');
      return { cmdEnter, palette, sheet, states, waits, reply, enter, you: t2?.querySelector(".as-you")?.textContent ?? "", html: !!t2?.querySelector("b") };`
    );
    expect(r.cmdEnter).toEqual([["assistantAsk", "landscape"]]);
    expect(r.palette).toBe(false);
    expect(r.sheet).toBe(true);
    expect(r.states).toEqual(["queued", "thinking", "done"]);
    expect(r.waits[0]).toMatch(/Waiting for the question before it/);
    expect(r.waits[1]).toMatch(/Thinking/);
    expect(r.reply).toContain('"landscape"');
    expect(r.enter).toEqual([["assistantAsk", "what is <b>waiting</b> on me"]]);
    expect(r.you).toBe("what is <b>waiting</b> on me");
    expect(r.html).toBe(false);
  }, 120_000);

  it("opens the landscape and the sheet when asked from another tab", async () => {
    const r = await drive<{ tab: string | null; sheet: boolean }>(
      "tab=dashboard",
      ".topbar",
      `
      await sleep(600);
      await openPalette();
      await typeQ("what is waiting on me");
      await press({ key: "Enter" });
      await until(() => !!$(".as-sheet"), 3000);
      return { tab: $(".tabs .tab.on")?.textContent ?? null, sheet: !!$(".as-sheet") };`
    );
    expect(r).toEqual({ tab: "Landscape", sheet: true });
  }, 120_000);

  it("shows main's { error } answer in the sheet", async () => {
    const r = await drive<{ text: string; said: string; role: string | null }>(
      "assistantAsk=error",
      ".ls-viewport",
      `
      await sleep(400);
      await openPalette();
      await typeQ("what is waiting on me");
      await press({ key: "Enter" });
      await until(() => !!$(".as-turn[data-failure] .as-reply.error"), 3000);
      const said = $(".as-turn[data-failure] .as-reply.error");
      return { text: $(".as-turn[data-failure] .as-you")?.textContent ?? "", said: said?.textContent ?? "", role: said?.getAttribute("role") ?? null };`
    );
    expect(r.text).toBe("what is waiting on me");
    expect(r.said).toBe("Couldn't ask: The Assistant couldn't start a turn: claude exited with code 1");
    expect(r.role).toBe("alert");
  }, 120_000);

  it("is dimmed with the reason when asking can't work on this Mac, and neither ⏎ nor ⌘⏎ asks", async () => {
    const r = await drive<{ banner: string; row: string[]; off: boolean; state: string; asked: unknown[]; palette: boolean }>(
      "assistant=unavailable",
      ".as-sheet",
      `
      await sleep(300);
      const banner = $(".as-unavail")?.textContent ?? "";
      await openPalette();
      await typeQ("what is waiting on me");
      const row = rows();
      const ask = $(".palette .row.ask");
      const mark = calls().length;
      await press({ key: "Enter" });
      await press({ key: "Enter", meta: true });
      await sleep(300);
      return { banner, row, off: ask.classList.contains("off"), state: ask.querySelector(".state")?.textContent ?? "", asked: asked(mark), palette: !!$(".palette") };`
    );
    expect(r.banner).toBe("Can't ask on this Mac: Claude Code isn't installed: the Assistant runs its turns on it");
    expect(r.row).toEqual(["ASK*"]);
    expect(r.off).toBe(true);
    expect(r.state).toBe("Claude Code isn't installed: the Assistant runs its turns on it");
    expect(r.asked).toEqual([]);
    expect(r.palette).toBe(true);
  }, 120_000);
});

describe.skipIf(!local)("the Assistant's sheet", () => {
  it("shows each state: steps, cards, rules, rule runs and the hint", async () => {
    const r = await drive<Record<string, unknown>>(
      "assistant=open&assistantRules",
      ".as-sheet .as-card",
      `
      await sleep(300);
      const stateOf = (el) => (el.className.match(/\\bst-(\\w+)/) || [])[1] ?? null;
      const steps = $$(".as-step").map((s) => [s.dataset.step, stateOf(s), !!s.querySelector(".as-undo"), s.querySelector(".as-step-err, .as-step-res")?.textContent ?? null]);
      const cards = $$('.as-card[data-state="open"]').map((c) => ({
        id: c.dataset.card,
        title: c.querySelector(".as-card-t").textContent,
        danger: c.classList.contains("danger"),
        warnings: [...c.querySelectorAll(".as-card-warn li")].map((li) => li.textContent),
        blocked: c.querySelector(".as-card-blocked")?.textContent ?? null,
        buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
      }));
      const reply = $('.as-turn[data-turn="t1"] .as-reply');
      const rules = $$(".as-rule").map((x) => ({ id: x.dataset.rule, on: x.querySelector('[role="switch"]').getAttribute("aria-checked"), paused: x.querySelector(".as-rule-paused")?.textContent ?? null, last: x.querySelector(".as-rule-last")?.textContent ?? null }));
      const payload = (p) => {
        const s = getComputedStyle(p);
        return { text: p.textContent, tag: p.tagName, elements: p.children.length, mono: s.fontFamily === getComputedStyle($(".as-run-at")).fontFamily, wrap: s.whiteSpace, scroll: s.overflowY };
      };
      const bodies = $$('.as-card[data-state="open"] .as-payload').map((p) => [p.closest(".as-card").dataset.card, payload(p)]);
      const ruleActs = $$(".as-rule").map((x) => [x.dataset.rule, [...x.querySelectorAll(".as-act")].map((a) => [a.querySelector(".as-act-l").textContent, a.querySelector(".as-payload")?.textContent ?? null])]);
      return {
        bodies,
        ruleActs,
        turns: $$(".as-turn").map((t) => [t.dataset.turn, t.dataset.state]),
        you: $('.as-turn[data-turn="t1"] .as-you').textContent,
        reply: { text: reply.textContent, strong: reply.querySelector("strong")?.textContent, code: reply.querySelector("code")?.textContent, em: reply.querySelector("em")?.textContent },
        steps,
        cards,
        dangerRed: getComputedStyle($('[data-card="c3"] .as-card-t')).color === getComputedStyle($('[data-card="c3"] .as-do')).color,
        rulesHead: $(".as-rules-h").textContent,
        rules,
        runs: $$(".as-run").map((x) => [x.dataset.run, x.querySelector(".as-run-t").textContent, x.querySelector(".as-run-rule")?.textContent]),
        hint: $(".as-hint").textContent,
        head: [$(".as-head-t").textContent, ...$$(".as-head button").map((b) => b.getAttribute("aria-label") ?? b.textContent)],
      };`
    );
    expect(r.turns).toEqual([
      ["t1", "done"],
      ["t2", "done"],
    ]);
    expect(r.you).toBe("put the atticus workspaces together, rename api to api-fix and make codex-review large");
    expect(r.reply).toEqual({ text: "Moved 3 workspaces to atticus and renamed api. I couldn't size codex-review: it's in a stack.", strong: "3", code: "atticus", em: "api" });
    expect(r.steps).toEqual([
      ["st1", "done", true, null],
      ["st2", "undone", false, null],
      ["st3", "failed", false, "It's in a stack: size the stack instead"],
      ["st4", "running", false, null],
      ["st8", "done", false, "Done: its terminal ended"],
      ["rs1", "done", false, null],
    ]);
    expect(r.cards).toEqual([
      { id: "c2", title: "Allow the prompt of “API: last org per user” · s2 · 5101/api, once", danger: false, warnings: [], blocked: null, buttons: ["Do it", "Cancel"] },
      { id: "c3", title: "Delete old-spike's worktree", danger: true, warnings: ["2 uncommitted changes would be lost", "1 commit isn't pushed"], blocked: null, buttons: ["Do it", "Cancel"] },
      { id: "c4", title: "Push 5101-orgDropdowns", danger: false, warnings: [], blocked: "Can't be done now: Nothing to push: it's up to date with origin", buttons: ["Do it", "Cancel"] },
      {
        id: "c6",
        title: "Send “API tests” · s3 · 5101/api a message",
        danger: false,
        warnings: ["“API tests” · s3 · 5101/api runs in Auto mode: its agent acts on this without asking you first", "It starts with “!”: Codex may run it as a shell command rather than read it"],
        blocked: null,
        buttons: ["Do it", "Cancel"],
      },
    ]);
    // a card's body: the text whole, as plain text (its markup-like words stay words) in a scrolling monospace block
    const block = { tag: "PRE", elements: 0, mono: true, wrap: "pre-wrap", scroll: "auto" };
    expect(r.bodies).toEqual([
      ["c2", { ...block, text: expect.stringMatching(/^ Bash command\n\n {3}npm test -- --run src\/orgs\n[^]*3\. No, and tell Claude what to do differently \(esc\)$/) }],
      ["c6", { ...block, text: "!npm run lint -- --fix && git add -A\n\nThen rerun the org dropdown tests and tell me which still fail in <OrgDropdown />." }],
    ]);
    // the Rules list spells out each action as main gave it, the text it types whole
    expect(r.ruleActs).toEqual([
      [
        "rule1",
        [
          ["Have the other agent review the branch of “#5101 — Org dropdowns remember the last org” · s1 · 5101, in its folder, and report back to it", null],
          ["Type this into the prompt of “API tests” · s3 · 5101/api and send it", "The review is up: read its notes, fix what it found, and run the org dropdown tests again."],
        ],
      ],
      ["rule2", [["Text me: “Check what's waiting”", null]]],
    ]);
    expect(r.dangerRed).toBe(true);
    expect(r.rulesHead).toBe("Rules· 1 on · 1 paused");
    expect(r.rules).toEqual([
      { id: "rule1", on: "true", paused: null, last: expect.stringMatching(/^Ran 20 minutes ago: Started codex-review$|^Ran .*: Started codex-review$/) },
      { id: "rule2", on: "false", paused: "Paused: 3 runs failed in a row: Messages isn't allowed to send", last: expect.stringMatching(/^Failed .*: Messages isn't allowed to send$/) },
    ]);
    expect(r.runs).toEqual([["run1", "Started review · tests finished", "When tests finishes, start the review"]]);
    expect(r.hint).toBe("⌘K to ask more");
    expect(r.head).toEqual(["Assistant", "Clear", "Close the Assistant"]);
  }, 120_000);

  it("shows nothing yet as a quiet hint, not an empty box", async () => {
    const r = await drive<{ quiet: string; turns: number; rulesHead: string }>(
      "assistant=empty",
      ".as-sheet .as-quiet",
      `
      await sleep(300);
      return { quiet: $(".as-body .as-quiet").textContent, turns: $$(".as-turn").length, rulesHead: $(".as-rules-h").textContent };`
    );
    expect(r.quiet).toMatch(/^Ask in ⌘K/);
    expect(r.turns).toBe(0);
    expect(r.rulesHead).toBe("Rules· none");
  }, 120_000);

  it("says when the rules file couldn't be read and where it was kept, with Rules folded too", async () => {
    const r = await drive<{ text: string; role: string | null; folded: string | null; rules: number }>(
      "assistant=open&assistantRulesProblem",
      ".as-sheet .as-rules-problem",
      `
      await sleep(300);
      const p = $(".as-rules .as-rules-problem");
      return { text: p.textContent, role: p.getAttribute("role"), folded: $(".as-rules-h").getAttribute("aria-expanded"), rules: $$(".as-rule").length };`
    );
    expect(r.text).toMatch(/^Your rules file couldn't be read: it isn't valid JSON .* It's kept as ~\/\.mockingbird\/assistant-rules\.json\.corrupt-\d+\./);
    expect(r.role).toBe("alert");
    expect(r.folded).toBe("false");
    expect(r.rules).toBe(0);
  }, 120_000);

  it("says on a rule when its being off couldn't be saved, and holds only until Mockingbird quits", async () => {
    const r = await drive<{ on: string | null; unsaved: string | null; others: number }>(
      "assistant=open&assistantRules&assistantRulesUnsaved",
      '.as-sheet [data-rule="rule1"]',
      `
      await sleep(300);
      const rule = $('[data-rule="rule1"]');
      return { on: rule.querySelector('[role="switch"]').getAttribute("aria-checked"), unsaved: rule.querySelector(".as-rule-unsaved")?.textContent ?? null, others: $$('[data-rule="rule2"] .as-rule-unsaved').length };`
    );
    expect(r).toEqual({ on: "false", unsaved: "Off only until Mockingbird quits: it couldn't be saved (the rules file can't be saved over)", others: 0 });
  }, 120_000);

  it("calls main for Undo, Do it, Cancel, the rule switches, Remove and Clear; Do it and Cancel are off while one runs, and an { error } shows on its card", async () => {
    const r = await drive<Record<string, unknown>>(
      "assistant=open&assistantRules&assistantMs=600",
      ".as-sheet .as-card",
      `
      await sleep(300);
      const mark = calls().length;
      await click($('[data-step="st1"] .as-undo'));
      await until(() => !$('[data-step="st1"] .as-undo'), 2000);
      const undone = $('[data-step="st1"]').className;
      await click($('[data-card="c2"] .as-do'));
      await sleep(60);
      const during = { doIt: $('[data-card="c2"] .as-do')?.getAttribute("aria-disabled"), cancel: $('[data-card="c2"] .as-cancel')?.getAttribute("aria-disabled"), label: $('[data-card="c2"] .as-do')?.textContent };
      // pressed again while it runs: nothing more is asked
      await click($('[data-card="c2"] .as-do'));
      await until(() => !$('[data-card="c2"][data-state="open"]'), 3000);
      await until(() => $('[data-step="st5"]')?.classList.contains("st-done"), 3000);
      const c2 = { step: $('[data-step="st5"]').className, res: $('[data-step="st5"] .as-step-res')?.textContent };
      await click($('[data-card="c3"] .as-cancel'));
      await until(() => !$('[data-card="c3"][data-state="open"]'), 3000);
      const c3 = $('[data-step="st6"]').className;
      await click($('[data-card="c4"] .as-do'));
      await until(() => !!$('[data-card="c4"] .as-card-err'), 3000);
      const c4 = { open: !!$('[data-card="c4"][data-state="open"]'), err: $('[data-card="c4"] .as-card-err')?.textContent };
      await click($('[data-rule="rule1"] [role="switch"]'));
      await until(() => $('[data-rule="rule1"] [role="switch"]')?.getAttribute("aria-checked") === "false", 2000);
      await click($('[data-rule="rule2"] [role="switch"]'));
      await until(() => $('[data-rule="rule2"] [role="switch"]')?.getAttribute("aria-checked") === "true", 2000);
      const rule2 = { paused: !!$('[data-rule="rule2"] .as-rule-paused'), head: $(".as-rules-h").textContent };
      await click($('[data-rule="rule1"] .as-remove'));
      await until(() => !$('[data-rule="rule1"]'), 2000);
      await click($(".as-head .as-hbtn:not(.icon)"));
      await until(() => !$(".as-turn"), 2000);
      const afterClear = { turns: $$(".as-turn").length, cards: $$(".as-sec .as-card").map((c) => c.dataset.card) };
      return { asked: asked(mark), undone, during, c2, c3, c4, rule2, afterClear };`
    );
    expect(r.asked).toEqual([
      ["assistantUndo", "st1"],
      ["assistantConfirm", "c2"],
      ["assistantCancel", "c3"],
      ["assistantConfirm", "c4"],
      ["assistantRuleOn", "rule1", false],
      ["assistantRuleOn", "rule2", true],
      ["assistantRuleRemove", "rule1"],
      ["assistantClear"],
    ]);
    expect(r.undone).toContain("st-undone");
    expect(r.during).toEqual({ doIt: "true", cancel: "true", label: "Doing it…" });
    expect(r.c2).toEqual({ step: expect.stringContaining("st-done"), res: "Done (in the preview nothing ran)" });
    expect(r.c3).toContain("st-cancelled");
    expect(r.c4).toEqual({ open: true, err: "Nothing to push: it's up to date with origin" });
    expect(r.rule2).toEqual({ paused: false, head: "Rules· 1 on" });
    // a fresh thread: the cards still open stay
    expect(r.afterClear).toEqual({ turns: 0, cards: ["c4", "c6"] });
  }, 120_000);

  it("hides a step's Undo once its window has closed, without anything else changing", async () => {
    const r = await drive<{ before: boolean; after: boolean; until: number; goneAt: number; step: string }>(
      "assistant=open&assistantUndoMs=5000",
      ".as-sheet .as-card",
      `
      const before = !!$('[data-step="st1"] .as-undo');
      const view = await w.mb.assistantView();
      const until = view.turns[0].steps[0].undoUntil;
      let goneAt = 0;
      for (let i = 0; i < 200 && !goneAt; i++) {
        if (!$('[data-step="st1"] .as-undo')) goneAt = Date.now();
        else await sleep(50);
      }
      return { before, after: !!$('[data-step="st1"] .as-undo'), until, goneAt, step: $('[data-step="st1"]').className };`
    );
    expect(r.before).toBe(true);
    expect(r.after).toBe(false);
    expect(r.goneAt).toBeGreaterThanOrEqual(r.until);
    expect(r.goneAt - r.until).toBeLessThan(1000);
    expect(r.step).toContain("st-done");
  }, 120_000);

  it("goes to a session when main asks, and opens again on openSheet after ×", async () => {
    const r = await drive<{ selected: string | null; closed: boolean; reopened: boolean; gone: string }>(
      "assistant=open",
      ".as-sheet .as-card",
      `
      await sleep(300);
      w.__mbEmit("onAssistantWindow", { kind: "focus", sessionId: "s5" });
      await until(() => $(".ls-node.selected")?.dataset.front === "s5", 3000);
      const selected = $(".ls-node.selected")?.dataset.front ?? null;
      await click($(".as-hbtn.icon"));
      await sleep(200);
      const closed = !$(".as-sheet");
      w.__mbEmit("onAssistantWindow", { kind: "openSheet" });
      await until(() => !!$(".as-sheet"), 2000);
      const reopened = !!$(".as-sheet");
      w.__mbEmit("onAssistantWindow", { kind: "focus", sessionId: "nope" });
      await sleep(300);
      return { selected, closed, reopened, gone: [...document.querySelectorAll(".ls-note")].map((n) => n.textContent).join(" | ") };`
    );
    expect(r.selected).toBe("s5");
    expect(r.closed).toBe(true);
    expect(r.reopened).toBe(true);
    expect(r.gone).toContain("The Assistant asked to go to a session that isn't here any more");
  }, 120_000);
});

describe.skipIf(!local)("the Assistant's sheet and the keyboard", () => {
  it("leaves the keyboard in the session's terminal whatever is clicked on it, and Esc still reaches the terminal", async () => {
    const r = await drive<{ start: string; out: { name: string; at?: string; typed?: string[]; missing?: boolean }[]; esc: string[]; sheet: boolean; swallowed: string[] }>(
      "lsFocus=s2&assistant=open&assistantRules&assistantMs=200",
      '.ls-focus .ls-tab[data-sid="s2"]',
      `
      await until(() => !!$(".as-sheet .as-card"), 4000);
      const start = await termIn("s2");
      const out = [];
      const clickAndType = async (name, el) => {
        if (!el) return void out.push({ name, missing: true });
        await click(el);
        await sleep(300);
        const at = where();
        const mark = w.__mbCalls.length;
        await press({ key: "x" });
        await sleep(150);
        out.push({ name, at, typed: typed(mark) });
      };
      await clickAndType("undo", $('[data-step="st1"] .as-undo'));
      await clickAndType("doIt", $('[data-card="c2"] .as-do'));
      await clickAndType("cancel", $('[data-card="c3"] .as-cancel'));
      await clickAndType("blocked", $('[data-card="c4"] .as-do'));
      await clickAndType("ruleSwitch", $('[data-rule="rule1"] [role="switch"]'));
      await clickAndType("remove", $('[data-rule="rule2"] .as-remove'));
      await clickAndType("rulesFold", $(".as-rules-h"));
      await clickAndType("words", $('.as-turn[data-turn="t1"] .as-reply'));
      await clickAndType("payload", $('[data-card="c6"] .as-payload'));
      await clickAndType("background", $(".as-hint"));
      await clickAndType("clear", $(".as-head .as-hbtn:not(.icon)"));
      const mark = w.__mbCalls.length;
      await press({ key: "Escape" });
      await sleep(200);
      const esc = typed(mark);
      const sheet = !!$(".as-sheet");
      await clickAndType("close", $(".as-hbtn.icon"));
      return { start, out, esc, sheet, swallowed };`,
      { size: "1600x900" }
    );
    expect(r.start).toBe("term:s2");
    const names = ["undo", "doIt", "cancel", "blocked", "ruleSwitch", "remove", "rulesFold", "words", "payload", "background", "clear", "close"];
    expect(r.out).toEqual(names.map((name) => ({ name, at: "term:s2", typed: ["s2:x"] })));
    expect(r.esc).toEqual(["s2:\u001b"]);
    expect(r.sheet).toBe(true);
    expect(r.swallowed).toEqual([]);
  }, 180_000);

  it("keeps the landscape armed when it had the keyboard, arms it from nowhere, and leaves the landscape's Esc to it", async () => {
    const r = await drive<{ armedAt: string; armedKeys: boolean; nowhereAt: string; nowhereKeys: boolean; selected: number; afterEsc: number; sheet: boolean; swallowed: string[] }>(
      "assistant=open",
      ".as-sheet .as-card",
      `
      await sleep(400);
      const vp = $(".ls-viewport");
      const box = vp.getBoundingClientRect();
      // a press on the bare landscape arms it
      await press({ mouse: { x: Math.round(box.left + 20), y: Math.round(box.bottom - 80), clickCount: 1 } });
      await sleep(200);
      await click($('[data-step="st1"] .as-undo'));
      await sleep(300);
      const armedAt = where();
      await press({ key: "?", shift: true });
      await until(() => !!$(".ls-keys"), 1500);
      const armedKeys = !!$(".ls-keys");
      await press({ key: "Escape" });
      await until(() => !$(".ls-keys"), 1500);
      // from nowhere: the press gives the landscape the keyboard, armed
      document.activeElement?.blur();
      await sleep(100);
      await click($('[data-rule="rule1"] [role="switch"]') ?? $(".as-rules-h"));
      await sleep(300);
      const nowhereAt = where();
      await press({ key: "?", shift: true });
      await until(() => !!$(".ls-keys"), 1500);
      const nowhereKeys = !!$(".ls-keys");
      await press({ key: "Escape" });
      await until(() => !$(".ls-keys"), 1500);
      // a workspace selected, then a press on the sheet: Esc is still the landscape's, and lets the selection go
      await click($('.ls-node[data-front="s1"]'));
      await sleep(300);
      const selected = $$(".ls-node.selected").length;
      await click($(".as-hint"));
      await sleep(200);
      await press({ key: "Escape" });
      await sleep(300);
      return { armedAt, armedKeys, nowhereAt, nowhereKeys, selected, afterEsc: $$(".ls-node.selected").length, sheet: !!$(".as-sheet"), swallowed };`
    );
    expect(r.armedAt).toMatch(/^div\.ls-viewport/);
    expect(r.armedKeys).toBe(true);
    expect(r.nowhereAt).toMatch(/^div\.ls-viewport/);
    expect(r.nowhereKeys).toBe(true);
    expect(r.selected).toBe(1);
    expect(r.afterEsc).toBe(0);
    expect(r.sheet).toBe(true);
    expect(r.swallowed).toEqual([]);
  }, 120_000);
});

describe.skipIf(!local)("the Assistant's sheet, looked at", () => {
  /** The sheet's colors against the theme's tokens, and the contrast of its text on what it sits on. */
  const look = `
      await sleep(300);
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const token = (name) => {
        probe.style.color = "var(" + name + ")";
        return getComputedStyle(probe).color;
      };
      const rgb = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (c) => {
        const [r, g, b] = rgb(c).map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      // what the text sits on: its translucent fills laid over the first opaque background under them
      const parse = (c) => {
        const n = (c.match(/[\\d.]+/g) || []).map(Number);
        return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n.length > 3 ? n[3] : 1 };
      };
      const bgOf = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
          const c = parse(getComputedStyle(e).backgroundColor);
          if (c.a <= 0) continue;
          layers.push(c);
          if (c.a >= 1) break;
        }
        let base = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : parse(getComputedStyle(document.body).backgroundColor);
        for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a), a: 1 };
        return "rgb(" + base.r + ", " + base.g + ", " + base.b + ")";
      };
      const texts = [
        ".as-head-t", '.as-turn[data-turn="t1"] .as-reply', '[data-step="st2"] .as-step-l', '[data-step="st8"] .as-step-res', '[data-card="c2"] .as-card-d', '[data-card="c3"] .as-card-t', '[data-card="c4"] .as-card-blocked',
        '[data-card="c6"] .as-payload', '[data-rule="rule1"] .as-act-l', '[data-rule="rule1"] .as-payload', ".as-run-at", ".as-rules-n", ".as-hint", ".as-sec-h",
      ];
      const low = texts.map((s) => [s, ratio(getComputedStyle($(s)).color, bgOf($(s)))]).filter(([, r]) => r < 4.5).map(([s, r]) => s + " " + r.toFixed(2));
      const sheet = $(".as-sheet");
      return {
        theme: document.documentElement.dataset.theme ?? "dark",
        bg: getComputedStyle(sheet).backgroundColor === token("--bg-sidebar"),
        title: getComputedStyle($(".as-head-t")).color === token("--text-1"),
        danger: getComputedStyle($('[data-card="c3"] .as-card-t')).color === token("--red"),
        sheetBg: getComputedStyle(sheet).backgroundColor,
        low,
      };`;

  it("follows the dark and the light theme's tokens, every line of text at 4.5:1 or more on what it sits on", async () => {
    const dark = await drive<{ theme: string; bg: boolean; title: boolean; danger: boolean; sheetBg: string; low: string[] }>("assistant=open&assistantRules", ".as-sheet .as-card", look);
    const light = await drive<{ theme: string; bg: boolean; title: boolean; danger: boolean; sheetBg: string; low: string[] }>("assistant=open&assistantRules&theme=light", ".as-sheet .as-card", look);
    expect(dark).toMatchObject({ theme: "dark", bg: true, title: true, danger: true, low: [] });
    expect(light).toMatchObject({ theme: "light", bg: true, title: true, danger: true, low: [] });
    expect(light.sheetBg).not.toBe(dark.sheetBg);
  }, 180_000);

  it("comes in and goes out with motion on, leaving nothing behind once its animations end", async () => {
    const r = await drive<{ opened: { opacity: string; transform: string; running: number }; ghost: boolean; after: { sheets: number; ghosts: number } }>(
      "assistant=open",
      ".as-sheet",
      `
      await sleep(50);
      for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().activeDuration)) a.finish();
      const sheet = $(".as-sheet");
      const opened = { opacity: getComputedStyle(sheet).opacity, transform: getComputedStyle(sheet).transform, running: sheet.getAnimations().filter((a) => a.playState === "running").length };
      await click($(".as-hbtn.icon"));
      const ghost = !!$(".as-sheet.mb-ghost");
      for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().activeDuration)) a.finish();
      await sleep(100);
      return { opened, ghost, after: { sheets: $$(".as-sheet").length, ghosts: $$(".mb-ghost").length } };`,
      { motion: "full" }
    );
    expect(r.opened).toEqual({ opacity: "1", transform: "none", running: 0 });
    expect(r.ghost).toBe(true);
    expect(r.after).toEqual({ sheets: 0, ghosts: 0 });
  }, 120_000);
});
