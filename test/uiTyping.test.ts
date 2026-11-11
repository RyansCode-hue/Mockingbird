import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { presetSize } from "../src/shared/landscape";

// Typing consent in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the script
// passes a mock keychain. The fixtures (src/preview/stub.ts): Nick may type in s1 for 12 more minutes; with
// ?typingAsk he asks to type in s8; Nick's own session is view-only here, and with ?typingRefused you just typed into it.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

const NICK_PANE = "r~0f1e2d3c4b5a~n1";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function dom(query: string, size: string): Promise<string> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageDom } = await import("../scripts/ui-preview.mjs");
  return pageDom({ size, query, outDir: path.join(tempDir("typing"), "out") });
}

/** Run `read` in the page until it gives something other than null. */
async function result(query: string, read: string, size: string): Promise<string> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  return pageResult({ size, query, outDir: path.join(tempDir("typing"), "out"), read });
}

// At 100%, where a workspace's body takes the mouse, in a window big enough for s1, s8 and Nick's session.
const SIZE = "3200x2400";
const AT = "lsCamera=0,0,1";

/**
 * In the page: `pressSettled(el, key)`, a real press at `el`'s middle once `key` has been seen there 600 ms (the strip
 * takes no click on an ask that just arrived or moved, nor a click made by code); whether it was asked for.
 */
const PRESS_SETTLED = `
  const pressSettled = (el, key) => {
    const seen = (window.__seen ??= {});
    seen[key] ??= Date.now();
    if (Date.now() - seen[key] < 600) return false;
    const r = el.getBoundingClientRect();
    (window.__mbKeys ??= []).push({ mouse: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickCount: 1 } });
    return true;
  };`;

describe.skipIf(!local)("typing into teammates' sessions, in the window", () => {
  it("asks the owner on the workspace, and shows who can type with a way to stop it", async () => {
    const html = await dom(`${AT}&typingAsk&typingRefused`, SIZE);
    const t = text(html);
    expect(t).toContain("Nick wants to type in “Release notes for #5101” Allow for this session Allow for 15 min Deny");
    // docked as a strip over the top of s8's terminal (the first of its pane notes), never a modal
    expect(html).toMatch(/<div class="pane-notes"><div class="typing-strip"><div class="typing-ask" data-ask="[^"]+" role="alert"/);
    expect(html).not.toMatch(/class="modal/);
    expect(html).toMatch(/class="chip typist"[^>]*>Nick can type · 12 min<button class="typist-x" aria-label="Stop Nick Smith typing">/);
    // s1, which Nick may type into, is outlined; s8, where he only asks, and his own session here aren't
    const panes = JSON.parse(await result(`${AT}&typingAsk&typingRefused`, `(() => {
      const ids = ["s1", "s8", ${JSON.stringify(NICK_PANE)}];
      const pane = (id) => document.querySelector(\`.ls-world [data-front="\${CSS.escape(id)}"] .pane\`);
      return ids.every(pane) && document.querySelector(".typing-ask") ? JSON.stringify(ids.map((id) => pane(id).classList.contains("typing-on"))) : null;
    })()`, SIZE));
    expect(panes).toEqual([true, false, false]);
    // the teammate's side: view-only, with Ask to type, and why the keys just typed didn't go
    expect(t).toContain("View only · Ask to type");
    expect(t).toContain("Nick Smith hasn't allowed typing Ask to type");
  }, 90_000);

  it("Allow for 15 min turns the ask into “Nick can type · 15 min”", async () => {
    const read = `(() => { ${PRESS_SETTLED}
      const allow = [...document.querySelectorAll(".typing-ask button")].find((b) => b.textContent === "Allow for 15 min");
      if (!window.__asked) {
        if (!allow || !pressSettled(allow, "allow")) return null;
        window.__asked = true;
        return null;
      }
      const chips = [...document.querySelectorAll(".chip.typist")].map((c) => c.textContent);
      return chips.length === 2 && !document.querySelector(".typing-ask") ? JSON.stringify(chips) : null;
    })()`;
    expect(JSON.parse(await result(`${AT}&typingAsk`, read, SIZE)).sort()).toEqual(["Nick can type · 12 min✕", "Nick can type · 15 min✕"]);
  }, 90_000);

  it("takes Allow below 100%, where the terminal under the strip doesn't take the mouse", async () => {
    const read = `(() => { ${PRESS_SETTLED}
      const allow = [...document.querySelectorAll(".typing-ask button")].find((b) => b.textContent === "Allow for 15 min");
      if (!window.__asked) {
        if (!allow || !document.querySelector(".ls-viewport.ls-mouse-off") || !pressSettled(allow, "allow")) return null;
        window.__asked = true;
        return null;
      }
      return document.querySelector(".typing-ask") ? null : JSON.stringify([...document.querySelectorAll(".chip.typist")].map((c) => c.textContent).sort());
    })()`;
    expect(JSON.parse(await result("lsCamera=0,0,0.8&typingAsk", read, SIZE))).toEqual(["Nick can type · 12 min✕", "Nick can type · 15 min✕"]);
  }, 90_000);

  // The strip's buttons are the landscape's (keyArm.ts): a press on one takes no keyboard. A terminal being typed in
  // keeps it, and the landscape the user pressed keeps it armed, so what's typed next goes where it was going.
  for (const from of ["terminal", "landscape"] as const)
    it(`leaves the keyboard ${from === "terminal" ? "in another session's terminal being typed in" : "on the landscape, armed"} when Allow is pressed on the strip below 100%`, async () => {
      const read = `(() => {
        const t = (window.__t ??= { step: 0 });
        const vp = document.querySelector(".ls-viewport");
        const centre = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
        const push = (k) => (window.__mbKeys ??= []).push(k);
        const allow = () => [...document.querySelectorAll('.ls-world [data-front="s8"] .typing-ask button')].find((b) => b.textContent === "Allow for 15 min");
        const writes = () => window.__mbCalls.filter((c) => c.fn === "sessionWrite").map((c) => c.args[0]);
        const keyboard = () => { const a = document.activeElement; return a === vp ? "landscape" : a?.closest(".xterm") ? "terminal:" + (a.closest(".ls-node")?.dataset.front ?? "?") : (a?.tagName ?? null); };
        // a press on the landscape between its workspaces
        const bare = () => {
          const r = vp.getBoundingClientRect();
          for (let y = r.top + 80; y < r.bottom - 80; y += 40)
            for (let x = r.left + 40; x < r.right - 300; x += 40) {
              const el = document.elementFromPoint(x, y);
              if (el && vp.contains(el) && !el.closest(".ls-node, .ls-area, .ls-window, .ls-acard, .ls-hud, .ls-banners, .ls-minimap, .ls-selbar, .ls-switcher, .ls-note, .ls-ghost, button")) return { x, y };
            }
          return null;
        };
        if (t.step === 0) {
          if (!allow() || !vp?.classList.contains("ls-mouse-off")) return null;
          if (${from === "terminal"}) window.__mbEmit("onUiCommand", "focus-session", "s1");
          else push({ mouse: { ...bare(), clickCount: 1 } });
          t.step = 1;
          return null;
        }
        if (t.step === 1) {
          t.before = keyboard();
          push({ mouse: { ...centre(allow()), clickCount: 1 } });
          t.step = 2;
          return null;
        }
        if (t.step === 2) {
          if (document.querySelector(".typing-ask")) return null;
          t.after = keyboard();
          t.mark = writes().length;
          push({ key: "?" });
          t.step = 3;
          t.at = Date.now();
          return null;
        }
        if (Date.now() - t.at < 600) return null;
        return JSON.stringify({ before: t.before, after: t.after, pct: document.querySelector(".ls-hud-btn.pct")?.textContent, sheet: !!document.querySelector(".ls-keys"), wrote: writes().slice(t.mark), answered: window.__mbCalls.filter((c) => c.fn === "teamDecideTyping").map((c) => c.args[2]) });
      })()`;
      const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.8&typingAsk", read, SIZE));
      const at = from === "terminal" ? "terminal:s1" : "landscape";
      expect(r).toEqual({ before: at, after: at, pct: "80%", sheet: from === "landscape", wrote: from === "terminal" ? ["s1"] : [], answered: ["minutes"] });
    }, 90_000);

  it("takes no click on an ask that arrived under the pointer a moment ago, and answers one aimed at it after", async () => {
    // where s8's strip puts Allow for this session (?typingAsk's ask, taken back first), then a new ask with the press
    // straight after it, as a click aimed at the workspace lands as the ask arrives
    const read = `(() => { ${PRESS_SETTLED}
      const t = (window.__t ??= { step: 0 });
      const calls = () => window.__mbCalls.filter((c) => c.fn === "teamDecideTyping").map((c) => c.args[2]);
      const allow = () => [...document.querySelectorAll('.ls-world [data-front="s8"] .typing-ask button')].find((b) => b.textContent === "Allow for this session");
      if (t.step === 0) {
        if (!allow() || !document.querySelector(".ls-viewport.ls-mouse-off")) return null;
        const r = allow().getBoundingClientRect();
        t.at = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        t.step = 1;
        void window.mb.teamDecideTyping("s8", "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "deny").then(() => (t.step = 2));
        return null;
      }
      if (t.step === 1) return null;
      if (t.step === 2) {
        if (allow()) return null;
        t.mark = calls().length;
        window.__mbAskToType("s8");
        (window.__mbKeys ??= []).push({ mouse: { ...t.at, clickCount: 1 } });
        t.step = 3;
        t.asked = Date.now();
        return null;
      }
      if (t.step === 3) {
        if (Date.now() - t.asked < 900) return null;
        t.early = { calls: calls().slice(t.mark), strip: !!allow() };
        t.step = 4;
        return null;
      }
      if (t.step === 4) {
        if (!allow() || !pressSettled(allow(), "allow")) return null;
        t.step = 5;
        return null;
      }
      if (allow()) return null;
      return JSON.stringify({ early: t.early, after: calls().slice(t.mark) });
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.8&typingAsk", read, SIZE));
    expect(r.early).toEqual({ calls: [], strip: true });
    expect(r.after).toEqual(["session"]);
  }, 90_000);

  it("answers from the keyboard only with Deny: Allow's buttons are no Tab stops and take no key, Deny takes Enter", async () => {
    const read = `(() => {
      const t = (window.__t ??= { step: 0 });
      const btns = () => [...document.querySelectorAll(".typing-ask button")];
      const calls = () => window.__mbCalls.filter((c) => c.fn === "teamDecideTyping").map((c) => c.args[2]);
      if (t.step === 0) {
        if (btns().length !== 3) return null;
        t.tabIndex = btns().map((b) => b.tabIndex);
        t.labels = btns().map((b) => b.getAttribute("aria-label"));
        btns()[0].focus();
        (window.__mbKeys ??= []).push({ key: "Enter" }, { key: "Space" });
        t.step = 1;
        t.at = Date.now();
        return null;
      }
      if (t.step === 1) {
        if (Date.now() - t.at < 1000) return null;
        t.afterAllow = { calls: calls(), strip: btns().length };
        btns()[2].focus();
        (window.__mbKeys ??= []).push({ key: "Enter" });
        t.step = 2;
        t.at = Date.now();
        return null;
      }
      if (btns().length || Date.now() - t.at < 600) return null;
      return JSON.stringify({ tabIndex: t.tabIndex, labels: t.labels, afterAllow: t.afterAllow, calls: calls() });
    })()`;
    expect(JSON.parse(await result(`motion=off&${AT}&typingAsk`, read, SIZE))).toEqual({
      tabIndex: [-1, -1, 0],
      labels: ["Allow Nick Smith to type in “Release notes for #5101” for this session", "Allow Nick Smith to type in “Release notes for #5101” for 15 min", "Deny Nick Smith typing in “Release notes for #5101”"],
      afterAllow: { calls: [], strip: 3 },
      calls: ["deny"],
    });
  }, 90_000);

  it("takes no click on a strip the camera has just carried under the pointer, and shows it: the button off until one would count", async () => {
    const read = `(() => { ${PRESS_SETTLED}
      const t = (window.__t ??= { step: 0 });
      const calls = () => window.__mbCalls.filter((c) => c.fn === "teamDecideTyping").map((c) => c.args[2]);
      const allow = () => [...document.querySelectorAll('.ls-world [data-front="s8"] .typing-ask button')].find((b) => b.textContent === "Allow for 15 min");
      if (t.step === 0) {
        // the ask long settled; then a small pan, and a press at once where Allow is
        if (!allow()) return null;
        t.seen ??= Date.now();
        if (Date.now() - t.seen < 1200) return null;
        const r = allow().getBoundingClientRect();
        const at = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        (window.__mbKeys ??= []).push({ wheel: { ...at, dx: 0, dy: 4 } }, { pause: 60 }, { mouse: { ...at, clickCount: 1 } });
        t.step = 1;
        t.at = Date.now();
        return null;
      }
      if (t.step === 1) {
        // the press went at the start of this look
        t.off ??= allow()?.disabled ?? null;
        if (Date.now() - t.at < 1000) return null;
        t.early = { calls: calls(), strip: !!allow(), off: t.off, offAfter: allow()?.disabled ?? null };
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        if (!allow() || !pressSettled(allow(), "still")) return null;
        t.step = 3;
        return null;
      }
      if (allow()) return null;
      return JSON.stringify({ early: t.early, after: calls() });
    })()`;
    expect(JSON.parse(await result("motion=off&lsCamera=0,0,0.8&typingAsk", read, SIZE))).toEqual({ early: { calls: [], strip: true, off: true, offAfter: false }, after: ["minutes"] });
  }, 90_000);

  it("shows the strip over the terminal: no re-fit, no pty resize", async () => {
    // runs once in the page (Runtime.evaluate doesn't await): it leaves its answer in window.__done
    const read = `(window.__audit ??= (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await wait(50); return f(); };
      const term = await until(() => window.__mbTerms?.get("s8")?.term?.rows && window.__mbTerms.get("s8").term);
      const holder = term.element.closest(".term-holder");
      await wait(500); // the first fit settles
      const before = { cols: term.cols, rows: term.rows, h: holder.getBoundingClientRect().height };
      const calls = window.__mbCalls.length;
      const state = await window.mb.teamLive();
      state.own.s8.typingAsks = [{ member: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", name: "Nick Smith", at: Date.now() }];
      window.__mbEmit("onTeamLive", state);
      const strip = await until(() => document.querySelector(".typing-strip"));
      await wait(500); // a re-fit would have happened by now
      const resizes = window.__mbCalls.slice(calls).filter((c) => c.fn === "sessionResize" && c.args[0] === "s8");
      const sb = strip.getBoundingClientRect(), h = holder.getBoundingClientRect(), head = term.element.closest(".term-area").getBoundingClientRect(); // the top of the terminal, under the header (and its rail)
      window.__done = JSON.stringify({
        before, after: { cols: term.cols, rows: term.rows, h: h.height }, resizes: resizes.length,
        docked: Math.abs(sb.top - head.top) < 1.5, overTerminal: sb.top < h.bottom && sb.bottom > h.top, fullWidth: sb.width >= h.width - 4,
      });
    })().catch((e) => (window.__done = JSON.stringify({ error: String(e) }))), window.__done ?? null)`;
    const r = JSON.parse(await result(AT, read, SIZE));
    expect(r.after).toEqual({ cols: r.before.cols, rows: r.before.rows, h: r.before.h });
    expect(r.resizes).toBe(0);
    expect(r).toMatchObject({ docked: true, overTerminal: true, fullWidth: true });
  }, 90_000);

  it("says why on the chip when ✕ can't take typing back, the chip kept", async () => {
    const read = `(() => {
      const chip = document.querySelector('.ls-world [data-front="s1"] .chip.typist');
      if (!window.__t) {
        if (!chip) return null;
        window.__t = true;
        chip.querySelector(".typist-x").click();
        return null;
      }
      const err = chip?.querySelector(".typist-err");
      return err ? JSON.stringify({ err: err.textContent, chip: chip.textContent.startsWith("Nick can type") }) : null;
    })()`;
    expect(JSON.parse(await result(`${AT}&typingRevokeFails`, read, SIZE))).toEqual({ err: "· couldn't stop it: That session isn't shared in a room any more", chip: true });
  }, 90_000);

  it("✕ takes typing back, and the outline goes with it", async () => {
    const read = `(() => {
      const x = document.querySelector(".chip.typist .typist-x");
      if (!window.__stopped) {
        if (!x) return null;
        window.__stopped = true;
        x.click();
        return null;
      }
      return document.querySelector(".chip.typist") ? null : document.querySelector(".pane.typing-on") ? "outlined still" : "gone";
    })()`;
    expect(await result(AT, read, SIZE)).toBe("gone");
  }, 90_000);

  it("keeps the prompt's buttons inside its workspace in a small window", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageDom } = await import("../scripts/ui-preview.mjs");
    const html: string = await pageDom({ size: "900x700", query: `lsCamera=1000,1500,1&typingAsk&measure=${encodeURIComponent(".typing-ask button")}&measure=${encodeURIComponent(".pane")}`, outDir: path.join(tempDir("typing"), "out") });
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

/** Nick's ask to type in s8 (?typingAsk), from wherever the view is: a card at 11%, read-only at 50%, live at 100%. */
describe.skipIf(!local)("a teammate's ask answered from Needs you, with real presses", () => {
  const NICK = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  // the driver presses what the page pushes onto window.__mbKeys at the start of its next look, about 250 ms on: what
  // a look finds under the pointer is what the press just before it hit
  const common = `
    const t = (window.__t ??= { step: 0 });
    const calls = () => window.__mbCalls.filter((c) => c.fn === "teamDecideTyping").map((c) => c.args);
    const centre = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    const press = (p, clickCount = 1) => (window.__mbKeys ??= []).push({ mouse: { ...p, clickCount } });
    const key = (k) => (window.__mbKeys ??= []).push({ key: k });
    const row = (sid) => document.querySelector('.ny-item[data-item^="type:' + sid + ':"]');
    const under = (p) => { const el = document.elementFromPoint(p.x, p.y); return (el?.closest(".ny-item")?.dataset.item.split(":").slice(0, 2).join(":") ?? "?") + " / " + (el?.closest("button")?.dataset.action ?? "?"); };
    const typing = () => [...document.querySelectorAll(".ny-item.k-typing")].map((i) => i.dataset.item.split(":")[1]);
    const open = () => {
      const btn = document.querySelector(".ny-btn");
      if (!btn || !document.querySelector(".ls-world .ls-node")) return false;
      btn.click();
      t.opened = Date.now();
      return true;
    };
  `;

  it("answers only the ask a double click's first press was on: the second, on the ask that slid up under it, does nothing", async () => {
    const read = `(() => { ${common}
      if (t.step === 0) return open() ? ((t.step = 1), null) : null;
      if (t.step === 1) {
        const allow = row("s8")?.querySelector('[data-action="allow"]');
        if (!allow || Date.now() - t.opened < 800) return null;
        t.below = row("s8").nextElementSibling?.dataset.item.split(":").slice(0, 2).join(":") ?? null;
        t.at = centre(allow);
        press(t.at, 1);
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        press(t.at, 2);
        t.step = 3;
        return null;
      }
      if (t.step === 3) {
        t.underSecond = under(t.at);
        t.step = 4;
        t.done = Date.now();
        return null;
      }
      if (Date.now() - t.done < 1200) return null;
      return JSON.stringify({ below: t.below, underSecond: t.underSecond, calls: calls(), typing: typing() });
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.5&typingAsk&typingAsk2", read, "1400x900"));
    // s2's ask was right below s8's, and slid up under the pointer before the second press
    expect(r.below).toBe("type:s2");
    expect(r.underSecond).toBe("type:s2 / allow");
    expect(r.calls).toEqual([["s8", NICK, "minutes"]]);
    expect(r.typing).toEqual(["s2"]);
  }, 90_000);

  it("takes a click aimed at the top row's Go there, when an ask arrives on top just before it lands, as that ask's Go there", async () => {
    const read = `(() => { ${common}
      if (t.step === 0) return open() ? ((t.step = 1), null) : null;
      if (t.step === 1) {
        const first = document.querySelector(".ny-item");
        if (!first || Date.now() - t.opened < 800) return null;
        t.aimed = first.dataset.item;
        t.at = centre(first.querySelector('[data-action="go"]'));
        window.__mbAskToType("s2");
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        if (!row("s2")) return null;
        t.top = document.querySelector(".ny-item").dataset.item.split(":").slice(0, 2).join(":");
        t.under = under(t.at);
        press(t.at, 1);
        t.step = 3;
        t.done = Date.now();
        return null;
      }
      if (Date.now() - t.done < 1200) return null;
      return JSON.stringify({ top: t.top, under: t.under, calls: calls(), tray: !!document.querySelector(".ny-tray") });
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.5", read, "1400x900"));
    expect(r.top).toBe("type:s2");
    expect(r.under).toBe("type:s2 / go");
    // it went there, which puts the tray away; nothing was allowed
    expect(r.tray).toBe(false);
    expect(r.calls).toEqual([]);
  }, 90_000);

  it("lets a click on an Allow that arrived under the pointer a moment ago do nothing", async () => {
    const read = `(() => { ${common}
      if (t.step === 0) return open() ? ((t.step = 1), null) : null;
      if (t.step === 1) {
        const first = document.querySelector(".ny-item");
        if (!first || Date.now() - t.opened < 800) return null;
        t.aimed = first.dataset.item.split(":").slice(0, 2).join(":");
        t.at = centre(first.querySelector('[data-action="allow"]'));
        // the new ask goes on top as the press is on its way: it lands within ANSWER_SETTLE_MS of the row arriving
        window.__mbAskToType("s2");
        press(t.at, 1);
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        t.under = under(t.at);
        t.step = 3;
        t.done = Date.now();
        return null;
      }
      if (Date.now() - t.done < 1200) return null;
      return JSON.stringify({ aimed: t.aimed, under: t.under, calls: calls(), typing: typing().sort() });
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.5&typingAsk", read, "1400x900"));
    expect(r.aimed).toBe("type:s8");
    expect(r.under).toBe("type:s2 / allow");
    expect(r.calls).toEqual([]);
    expect(r.typing).toEqual(["s2", "s8"]);
  }, 90_000);

  it("answers from the keyboard only with Deny: Tab passes Allow by, Enter or Space on it does nothing, and Enter on Deny denies", async () => {
    const read = `(() => { ${common}
      if (t.step === 0) return open() ? ((t.step = 1), (t.focus = []), null) : null;
      if (t.step === 1) {
        if (!row("s8") || Date.now() - t.opened < 800) return null;
        // each Tab while focus is still in the tray: past its last stop it would leave, and the tray with it
        if (t.tabbed) t.focus.push(document.activeElement?.dataset?.action ?? (document.activeElement?.closest(".ny-tray") ? "tray" : document.activeElement?.tagName));
        const stops = document.querySelectorAll(".ny-tray button:not([tabindex='-1']):not(:disabled)").length;
        t.tabbed = (t.tabbed ?? 0) + 1;
        if (t.tabbed < stops) {
          key("Tab");
          return null;
        }
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        if (!row("s8")) return JSON.stringify({ stuck: "the tray went", focus: t.focus });
        row("s8").querySelector('[data-action="allow"]').focus();
        t.focused = document.activeElement?.dataset?.action ?? null;
        key("Enter");
        t.step = 3;
        return null;
      }
      if (t.step === 3) {
        key("Space");
        t.step = 4;
        t.done = Date.now();
        return null;
      }
      if (t.step === 4) {
        if (Date.now() - t.done < 1000) return null;
        t.afterAllow = { calls: calls(), typing: typing() };
        const deny = row("s8").querySelector('[data-action="deny"]');
        t.denyLabel = deny.getAttribute("aria-label");
        deny.focus();
        key("Enter");
        t.step = 5;
        t.done = Date.now();
        return null;
      }
      if (row("s8") || Date.now() - t.done < 600) return null;
      return JSON.stringify({ focus: t.focus, focused: t.focused, afterAllow: t.afterAllow, denyLabel: t.denyLabel, calls: calls() });
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.5&typingAsk", read, "1400x900"));
    expect(r.focus.length).toBeGreaterThan(3);
    expect(r.focus).toContain("go");
    expect(r.focus).toContain("deny");
    expect(r.focus).not.toContain("allow");
    expect(r.focused).toBe("allow");
    expect(r.afterAllow).toEqual({ calls: [], typing: ["s8"] });
    expect(r.denyLabel).toMatch(/^Deny: Nick wants to type in /);
    expect(r.calls).toEqual([["s8", NICK, "deny"]]);
  }, 90_000);

  it("turns the row's buttons off from the click until main answers", async () => {
    const read = `(() => { ${common}
      if (t.step === 0) return open() ? ((t.step = 1), null) : null;
      if (t.step === 1) {
        if (!row("s8") || Date.now() - t.opened < 800) return null;
        t.deny = centre(row("s8").querySelector('[data-action="deny"]'));
        press(centre(row("s8").querySelector('[data-action="allow"]')), 1);
        t.step = 2;
        t.clicked = Date.now();
        return null;
      }
      if (t.step === 2) {
        // past the double click guard, main still answering (?typingAnswerMs): a click on its Deny
        if (Date.now() - t.clicked < 700) return null;
        t.off = [...row("s8").querySelectorAll("button")].map((b) => b.disabled);
        press(t.deny, 1);
        t.step = 3;
        return null;
      }
      if (row("s8")) return null;
      return JSON.stringify({ off: t.off, calls: calls() });
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.5&typingAsk&typingAnswerMs=1500", read, "1400x900"));
    expect(r.off).toEqual([true, true, true, true]);
    expect(r.calls).toEqual([["s8", NICK, "minutes"]]);
  }, 90_000);

  it("leaves the keyboard with the tray once an answer takes its row away, where N still steps", async () => {
    const read = `(() => { ${common}
      if (t.step === 0) return open() ? ((t.step = 1), null) : null;
      if (t.step === 1) {
        if (!row("s8") || Date.now() - t.opened < 800) return null;
        press(centre(row("s8").querySelector('[data-action="allow"]')), 1);
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        if (row("s8")) return null;
        t.keys = document.activeElement?.closest(".ny-tray") ? "tray" : (document.activeElement?.tagName ?? null);
        t.lit = document.querySelector(".ny-item.on")?.dataset.item ?? null;
        key("n");
        t.step = 3;
        t.done = Date.now();
        return null;
      }
      if (Date.now() - t.done < 1000) return null;
      return JSON.stringify({ keys: t.keys, lit: t.lit, litAfterN: document.querySelector(".ny-item.on")?.dataset.item ?? null, tray: !!document.querySelector(".ny-tray"), calls: calls() });
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.5&typingAsk", read, "1400x900"));
    expect(r.calls).toEqual([["s8", NICK, "minutes"]]);
    expect(r.keys).toBe("tray");
    expect(r.tray).toBe(true);
    expect(r.litAfterN).not.toBeNull();
    expect(r.litAfterN).not.toBe(r.lit);
  }, 90_000);

  it("enters no focus when a double click on Go there lands its second press on the workspace flying in, and y after reaches nothing", async () => {
    const read = `(() => { ${common}
      if (t.step === 0) return open() ? ((t.step = 1), null) : null;
      if (t.step === 1) {
        if (!row("s2") || Date.now() - t.opened < 800) return null;
        t.go = centre(row("s2").querySelector('[data-action="go"]'));
        t.mark = window.__mbCalls.length;
        press(t.go, 1);
        t.step = 2;
        return null;
      }
      if (t.step === 2) {
        // the first press went at the start of this look: the second, as the view flies in under it
        press(t.go, 2);
        t.step = 3;
        t.at = Date.now();
        return null;
      }
      if (t.step === 3) {
        if (Date.now() - t.at < 1200) return null;
        t.focus = !!document.querySelector(".ls-focus");
        key("y");
        t.step = 4;
        t.at = Date.now();
        return null;
      }
      if (Date.now() - t.at < 700) return null;
      return JSON.stringify({ focus: t.focus, writes: window.__mbCalls.slice(t.mark).filter((c) => c.fn === "sessionWrite").map((c) => c.args[0]), calls: calls() });
    })()`;
    const r = JSON.parse(await result("motion=full&typingAsk2&lsCamera=0,0,0.4", read, "1440x900"));
    expect(r).toEqual({ focus: false, writes: [], calls: [] });
  }, 90_000);
});

describe.skipIf(!local)("a teammate's ask to type, at any zoom", () => {
  const ZOOMS = [0.11, 0.5, 1];
  const S8 = `document.querySelector('.ls-world [data-front="s8"]')`;
  const PCT = `document.querySelector(".ls-hud-btn.pct")?.textContent`;

  /** What `read` leaves in window.__t once the ask is gone, with the live state's answer and the calls that gave it. */
  const answered = `(window.__live ??= window.mb.teamLive().then((l) => (window.__t.live = { asks: (l.own.s8.typingAsks ?? []).length, typists: (l.own.s8.typists ?? []).map((g) => g.name) })), window.__t.live ? JSON.stringify({ ...window.__t, calls: window.__mbCalls.filter((c) => c.fn === "teamDecideTyping").map((c) => c.args) }) : null)`;

  for (const zoom of ZOOMS)
    it(`at ${zoom * 100}%: the notification brings it in at 100%, its strip in view, and Allow there answers it`, async () => {
      const read = `(() => { ${PRESS_SETTLED}
        const allow = () => [...(${S8}?.querySelectorAll(".typing-ask button") ?? [])].find((b) => b.textContent === "Allow for this session");
        if (!window.__t) {
          if (!${S8} || !${PCT}) return null;
          window.__t = { before: ${PCT}, badge: ${S8}.querySelector(".ls-badge.b-ask")?.textContent ?? null, strip: !!${S8}.querySelector(".typing-ask") };
          window.__mbEmit("onUiCommand", "focus-session", "s8");
          return null;
        }
        if (!window.__t.at) {
          if (${PCT} !== "100%" || !allow()) return null;
          const r = allow().getBoundingClientRect(), v = document.querySelector(".ls-viewport").getBoundingClientRect();
          if (!pressSettled(allow(), "allow")) return null;
          window.__t.at = { pct: ${PCT}, inView: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom };
          return null;
        }
        if (${S8}?.querySelector(".typing-ask")) return null;
        return ${answered};
      })()`;
      const r = JSON.parse(await result(`motion=off&lsCamera=0,0,${zoom}&typingAsk`, read, SIZE));
      expect(r.before).toBe(`${Math.round(zoom * 100)}%`);
      // a card has no strip: its badge says so instead
      expect(r.badge).toBe(zoom < 0.35 ? "Nick asks to type" : null);
      expect(r.strip).toBe(zoom >= 0.35);
      expect(r.at).toEqual({ pct: "100%", inView: true });
      expect(r.live).toEqual({ asks: 0, typists: ["Nick Smith"] });
      expect(r.calls).toEqual([["s8", "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "session"]]);
    }, 90_000);

  for (const zoom of ZOOMS)
    it(`at ${zoom * 100}%: Needs you lists it with the prompts, Go there first, and a click on its Allow for 15 min answers it`, async () => {
      const read = `(() => {
        if (!window.__t) {
          const btn = document.querySelector(".ny-btn");
          if (!btn || !${S8} || !${PCT}) return null;
          window.__t = { pct: ${PCT}, opened: Date.now() };
          btn.click();
          return null;
        }
        if (!window.__t.item) {
          const item = document.querySelector(".ny-item.k-typing");
          if (!item || Date.now() - window.__t.opened < 800) return null;
          const btn = (a) => item.querySelector('[data-action="' + a + '"]');
          window.__t.item = {
            text: item.querySelector(".ny-text").textContent,
            kind: item.querySelector(".ny-kind").textContent,
            acts: [...item.querySelectorAll("button")].map((b) => b.dataset.action + ":" + b.textContent + ":" + b.className.trim()),
            kinds: [...document.querySelectorAll(".ny-item")].map((i) => [...i.classList].find((c) => c.startsWith("k-")).slice(2)),
          };
          const r = btn("allow").getBoundingClientRect();
          (window.__mbKeys ??= []).push({ mouse: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickCount: 1 } });
          return null;
        }
        if (document.querySelector(".ny-item.k-typing")) return null;
        return ${answered};
      })()`;
      const r = JSON.parse(await result(`motion=off&lsCamera=0,0,${zoom}&typingAsk`, read, SIZE));
      expect(r.pct).toBe(`${Math.round(zoom * 100)}%`);
      expect(r.item.text).toMatch(/^Nick wants to type in /);
      expect(r.item.kind).toMatch(/^Wants to type · /);
      // Go there is the row's main, filled button, as on every other row; the answers are outlined beside it
      expect(r.item.acts).toEqual(["go:Go there:ny-go fill", "allow:Allow for 15 min:ny-go ny-answer", "deny:Deny:ny-go ny-answer", "dismiss:Dismiss:ny-dismiss"]);
      // ranked with what holds someone up: no join request or finished session before it
      const at = r.item.kinds.indexOf("typing");
      expect(r.item.kinds.slice(0, at).every((k: string) => k === "permission" || k === "question" || k === "typing")).toBe(true);
      expect(r.live).toEqual({ asks: 0, typists: ["Nick Smith"] });
      expect(r.calls).toEqual([["s8", "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "minutes"]]);
    }, 90_000);

  for (const [preset, size] of [["L", "1600x1000"], ["M", "1180x800"]] as const)
    it(`brings all three of the strip's buttons into view from the notification, for ${preset} in a ${size} window`, async () => {
      const L = presetSize("agent", "L");
      const read = `(() => {
        const t = (window.__t ??= { step: 0 });
        const vp = document.querySelector(".ls-viewport");
        if (t.step === 0) {
          if (!${S8} || !${PCT} || !vp) return null;
          t.step = 0.5;
          if ("${preset}" === "M") t.step = 1;
          else
            void window.mb.landscapeGet().then((s) => window.mb.landscapeUpdate({ workspaces: { s8: { ...s.landscape.workspaces.s8, w: ${L.w}, h: ${L.h} } } })).then((r) => {
              t.patched = !r?.error;
              t.step = 1;
            });
          return null;
        }
        if (t.step === 1) {
          window.__mbEmit("onUiCommand", "focus-session", "s8");
          t.step = 2;
          t.at = Date.now();
          return null;
        }
        const btns = [...(${S8}?.querySelectorAll(".typing-ask button") ?? [])];
        if (${PCT} !== "100%" || btns.length !== 3 || Date.now() - t.at < 1200) return null;
        const v = vp.getBoundingClientRect();
        return JSON.stringify({
          w: Math.round(${S8}.getBoundingClientRect().width),
          wider: ${S8}.getBoundingClientRect().width > v.width,
          inView: btns.map((b) => { const r = b.getBoundingClientRect(); return b.textContent + ":" + (r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom); }),
        });
      })()`;
      const r = JSON.parse(await result(`motion=off&lsCamera=0,0,0.11&typingAsk`, read, size));
      // wider than the view, so it comes in from its left
      expect(r.wider).toBe(true);
      expect(r.inView).toEqual(["Allow for this session:true", "Allow for 15 min:true", "Deny:true"]);
    }, 90_000);

  it("Go there from Needs you, from a card, lands at 100% with the strip in view; Deny there says no", async () => {
    const read = `(() => { ${PRESS_SETTLED}
      if (!window.__t) {
        const btn = document.querySelector(".ny-btn");
        if (!btn || !${S8}) return null;
        window.__t = {};
        btn.click();
        return null;
      }
      if (!window.__t.went) {
        const go = document.querySelector('.ny-item.k-typing [data-action="go"]');
        if (!go) return null;
        window.__t.went = true;
        go.click();
        return null;
      }
      if (!window.__t.at) {
        const deny = [...(${S8}?.querySelectorAll(".typing-ask button") ?? [])].find((b) => b.textContent === "Deny");
        if (${PCT} !== "100%" || !deny) return null;
        const r = deny.getBoundingClientRect(), v = document.querySelector(".ls-viewport").getBoundingClientRect();
        if (!pressSettled(deny, "deny")) return null;
        window.__t.at = { pct: ${PCT}, inView: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom, tray: !!document.querySelector(".ny-tray") };
        return null;
      }
      if (${S8}?.querySelector(".typing-ask")) return null;
      return ${answered};
    })()`;
    const r = JSON.parse(await result("motion=off&lsCamera=0,0,0.11&typingAsk", read, SIZE));
    expect(r.at).toEqual({ pct: "100%", inView: true, tray: false });
    expect(r.live).toEqual({ asks: 0, typists: [] });
    expect(r.calls).toEqual([["s8", "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "deny"]]);
  }, 90_000);

  for (const zoom of [0.11, 0.5])
    it(`at ${zoom * 100}%: resting on the workspace opens no peek over the ask (one with no ask still peeks)`, async () => {
      // ever drawn, not only there at the end: one opened and put away straight after would pass
      const read = `(() => {
        window.__t ??= Date.now();
        if (Date.now() - window.__t < 2500) return null;
        return JSON.stringify(!!window.__mbPeekSeen);
      })()`;
      expect(await result(`motion=off&lsCamera=0,0,${zoom}&typingAsk&lsPeek=s8`, read, SIZE)).toBe("false");
      expect(await result(`motion=off&lsCamera=0,0,${zoom}&typingAsk&lsPeek=s2`, read, SIZE)).toBe("true");
    }, 90_000);

  it("marks a stack's tab behind the front one when a teammate asks to type in its session, on the workspace and on its card", async () => {
    const read = `(() => {
      if (!window.__t) {
        if (!document.querySelector('.ls-world [data-sid="s3"]')) return null;
        window.__t = true;
        window.__mbAskToType("s3");
        return null;
      }
      const tab = document.querySelector('.ls-world .ls-tab.ask[data-sid="s3"], .ls-world .ls-card-tab.ask[data-sid="s3"]');
      if (!tab) return null;
      return JSON.stringify({ kind: tab.className.trim(), title: tab.title, marked: [...document.querySelectorAll(".ls-world .ls-tab.ask, .ls-world .ls-card-tab.ask")].map((t) => t.dataset.sid) });
    })()`;
    const live = JSON.parse(await result("motion=off&lsCamera=0,0,0.5", read, "1400x900"));
    expect(live).toEqual({ kind: "ls-tab ask", title: "API tests — Nick asks to type: bring it to the front to answer, or answer in Needs you", marked: ["s3"] });
    const card = JSON.parse(await result("motion=off&lsCamera=0,0,0.2", read, "1400x900"));
    expect(card).toEqual({ kind: "ls-card-tab ask", title: "API tests — Nick asks to type", marked: ["s3"] });
  }, 90_000);

  it("puts away a peek kept open over the workspace once a teammate asks to type in it", async () => {
    const read = `(() => {
      if (!window.__t) {
        if (!document.querySelector(".ls-peek.pinned")) return null;
        window.__t = { pinned: true };
        void window.mb.teamLive().then((state) => {
          state.own.s8.typingAsks = [{ member: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", name: "Nick Smith", at: Date.now() }];
          window.__mbEmit("onTeamLive", state);
        });
        return null;
      }
      if (document.querySelector(".ls-peek")) return null;
      return JSON.stringify({ ...window.__t, strip: !!${S8}?.querySelector(".typing-ask") });
    })()`;
    expect(JSON.parse(await result("motion=off&lsCamera=0,0,0.5&lsPeek=s8,pin", read, SIZE))).toEqual({ pinned: true, strip: true });
  }, 90_000);
});
