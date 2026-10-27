import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { alertText } from "../src/shared/phoneAlerts";

// Settings → Notifications → Phone alerts in the UI preview, in real headless Chrome: local only (CI runners
// have no desktop); the script passes a mock keychain. Nothing is sent or read: ?phone= (src/preview/stub.ts)
// says what the main process reports, and window.__mbCalls what the window asked it for.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

/**
 * Open the preview at `query`, wait for `ready` (a selector), run `steps` (an async function body with `$`
 * for querySelector, `sleep`, `type` for a text field and `calls()` for window.__mbCalls) once, and return what it returns.
 */
async function drive<T>(query: string, ready: string, steps: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const read = `(() => {
    const w = window;
    if (!w.__phoneRun) {
      if (!document.querySelector(${JSON.stringify(ready)})) return null;
      const $ = (s) => document.querySelector(s);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = () => w.__mbCalls.map((c) => ({ fn: c.fn, args: c.args }));
      const type = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
      w.__phoneRun = (async () => { ${steps} })().then((v) => (w.__phoneOut = JSON.stringify(v ?? null)), (e) => (w.__phoneOut = JSON.stringify({ failed: String(e && e.stack || e) })));
    }
    return w.__phoneOut ?? null;
  })()`;
  const out: string = await pageResult({ size: "1400x1000", query: `motion=off&${query}`, outDir: path.join(tempDir("phone"), "out"), read });
  return JSON.parse(out);
}

describe.skipIf(!local)("phone alerts in Settings", () => {
  it("shows the alert exactly as it's sent, and a reply and what it does once replies work", async () => {
    const r = await drive<{ bubbles: string[]; what: string; note: string }>("section=notifications&phone=replies", ".phone-preview .bubble", `
      await sleep(300);
      return {
        bubbles: [...document.querySelectorAll(".phone-preview .bubble")].map((b) => b.textContent),
        what: $(".phone-preview .phone-what").textContent,
        note: [...document.querySelectorAll(".set-row")].find((r) => r.textContent.startsWith("Replies from your phone")).textContent,
      };`);
    expect(r.bubbles).toEqual([alertText([{ kind: "permission", title: "Donor export", where: "#5110", tool: "Bash", code: "K4" }]), "K4 1", "Mockingbird: done — allow once in “Donor export”."]);
    expect(r.what).toMatch(/^Allows that one prompt once/);
    expect(r.note).toMatch(/while an alert waits for a reply \(1 now\)\. Turn this off to stop; you can then remove Full Disk Access/);
  }, 120_000);

  it("says what Full Disk Access exposes before replies turn on, and turns them on only when asked to", async () => {
    const r = await drive<{ dialog: string; savedBefore: boolean; savedAfter: unknown; opened: unknown; dialogAfter: boolean }>("section=notifications&phone=on", '[aria-label="Replies from your phone"]', `
      $('[aria-label="Replies from your phone"]').click();
      await sleep(200);
      const dialog = $(".phone-fda").textContent;
      const savedBefore = calls().some((c) => c.fn === "setSettings" && c.args[0].phoneAlerts && c.args[0].phoneAlerts.replies);
      [...document.querySelectorAll(".phone-fda button")].find((b) => b.textContent.startsWith("Turn on")).click();
      await sleep(300);
      return {
        dialog,
        savedBefore,
        savedAfter: calls().filter((c) => c.fn === "setSettings").map((c) => c.args[0].phoneAlerts && c.args[0].phoneAlerts.replies),
        opened: calls().filter((c) => c.fn === "phoneOpenPrivacy").map((c) => c.args[0]),
        dialogAfter: !!$(".phone-fda"),
      };`);
    expect(r.dialog).toContain("every file on this Mac");
    expect(r.dialog).toContain("and so can everything it runs: the agents, terminals and commands in its panes");
    expect(r.dialog).toContain("only your conversation with yourself");
    expect(r.savedBefore).toBe(false);
    expect(r.savedAfter).toEqual([true]);
    expect(r.opened).toEqual(["fullDiskAccess"]);
    expect(r.dialogAfter).toBe(false);
  }, 120_000);

  it("won't save a handle Messages couldn't tell is yours, and says why", async () => {
    const r = await drive<{ hint: string; invalid: string | null; saved: unknown[] }>("section=notifications&phone=on", "input.phone-handle", `
      const input = $("input.phone-handle");
      type(input, "555 123 4567");
      await sleep(50);
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      input.blur();
      await sleep(200);
      const hint = [...document.querySelectorAll(".set-row")].find((r) => r.textContent.startsWith("Your iMessage")).querySelector(".phone-bad").textContent;
      const invalid = input.getAttribute("aria-invalid");
      type(input, "+1 (555) 123-4567");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(200);
      return { hint, invalid, saved: calls().filter((c) => c.fn === "setSettings").map((c) => c.args[0].phoneAlerts.handle) };`);
    expect(r.hint).toMatch(/with its country code/);
    expect(r.invalid).toBe("true");
    expect(r.saved).toEqual(["+15551234567"]);
  }, 120_000);

  it("says plainly when macOS refuses, with the way to fix it", async () => {
    const r = await drive<{ problems: string[]; buttons: string[] }>("section=notifications&phone=nofda", ".phone-problem", `
      await sleep(200);
      return {
        problems: [...document.querySelectorAll(".phone-problem > span")].map((p) => p.textContent),
        buttons: [...document.querySelectorAll(".phone-problem button")].map((b) => b.textContent),
      };`);
    expect(r.problems).toEqual([expect.stringMatching(/grant it Full Disk Access/)]);
    expect(r.buttons).toEqual(["Open Full Disk Access", "Check again"]);
    const d = await drive<{ problems: string[]; buttons: string[] }>("section=notifications&phone=denied", ".phone-problem", `
      return {
        problems: [...document.querySelectorAll(".phone-problem > span")].map((p) => p.textContent),
        buttons: [...document.querySelectorAll(".phone-problem button")].map((b) => b.textContent),
      };`);
    expect(d.problems).toEqual([expect.stringMatching(/wasn't sent: Mockingbird isn't allowed to control Messages/)]);
    expect(d.buttons).toEqual(["Open Automation settings"]);
  }, 120_000);

  it("shows in the pane what a reply did, until dismissed", async () => {
    const r = await drive<{ note: string; dismissed: unknown[]; after: boolean }>("shown=s1,s2&phone=replies", ".phone-note", `
      const note = $(".phone-note .reason").textContent;
      $(".phone-note button").click();
      await sleep(300);
      return { note, dismissed: calls().filter((c) => c.fn === "clearPhoneNote").map((c) => c.args[0]), after: !!$(".phone-note") };`);
    expect(r.note).toMatch(/^Answered from your phone: allow once · /);
    expect(r.dismissed).toEqual(["s1"]);
    expect(r.after).toBe(false);
  }, 120_000);
});
