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

describe.skipIf(!local)("typing into teammates' sessions, in the window", () => {
  it("asks the owner on the workspace, and shows who can type with a way to stop it", async () => {
    const html = await dom(`${AT}&typingAsk&typingRefused`, SIZE);
    const t = text(html);
    expect(t).toContain("Nick wants to type in “Release notes for #5101” Allow for this session Allow for 15 min Deny");
    // docked as a strip over the top of s8's terminal (the first of its pane notes), never a modal
    expect(html).toMatch(/<div class="pane-notes"><div class="typing-strip"><div class="typing-ask" role="alert"/);
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
    expect(JSON.parse(await result(`${AT}&typingAsk`, read, SIZE)).sort()).toEqual(["Nick can type · 12 min✕", "Nick can type · 15 min✕"]);
  }, 90_000);

  it("takes Allow below 100%, where the terminal under the strip doesn't take the mouse", async () => {
    const read = `(() => {
      const allow = [...document.querySelectorAll(".typing-ask button")].find((b) => b.textContent === "Allow for 15 min");
      if (!window.__asked) {
        if (!allow || !document.querySelector(".ls-viewport.ls-mouse-off")) return null;
        window.__asked = true;
        allow.click();
        return null;
      }
      return document.querySelector(".typing-ask") ? null : JSON.stringify([...document.querySelectorAll(".chip.typist")].map((c) => c.textContent).sort());
    })()`;
    expect(JSON.parse(await result("lsCamera=0,0,0.8&typingAsk", read, SIZE))).toEqual(["Nick can type · 12 min✕", "Nick can type · 15 min✕"]);
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
describe.skipIf(!local)("a teammate's ask to type, at any zoom", () => {
  const ZOOMS = [0.11, 0.5, 1];
  const S8 = `document.querySelector('.ls-world [data-front="s8"]')`;
  const PCT = `document.querySelector(".ls-hud-btn.pct")?.textContent`;

  /** What `read` leaves in window.__t once the ask is gone, with the live state's answer and the calls that gave it. */
  const answered = `(window.__live ??= window.mb.teamLive().then((l) => (window.__t.live = { asks: (l.own.s8.typingAsks ?? []).length, typists: (l.own.s8.typists ?? []).map((g) => g.name) })), window.__t.live ? JSON.stringify({ ...window.__t, calls: window.__mbCalls.filter((c) => c.fn === "teamDecideTyping").map((c) => c.args) }) : null)`;

  for (const zoom of ZOOMS)
    it(`at ${zoom * 100}%: the notification brings it in at 100%, its strip in view, and Allow there answers it`, async () => {
      const read = `(() => {
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
          window.__t.at = { pct: ${PCT}, inView: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom };
          allow().click();
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
    it(`at ${zoom * 100}%: Needs you lists it with the prompts, and its Allow answers it as the strip's does`, async () => {
      const read = `(() => {
        if (!window.__t) {
          const btn = document.querySelector(".ny-btn");
          if (!btn || !${S8} || !${PCT}) return null;
          window.__t = { pct: ${PCT} };
          btn.click();
          return null;
        }
        if (!window.__t.item) {
          const item = document.querySelector(".ny-item.k-typing");
          if (!item) return null;
          window.__t.item = {
            text: item.querySelector(".ny-text").textContent,
            kind: item.querySelector(".ny-kind").textContent,
            acts: [...item.querySelectorAll("button")].map((b) => b.dataset.action),
            kinds: [...document.querySelectorAll(".ny-item")].map((i) => [...i.classList].find((c) => c.startsWith("k-")).slice(2)),
          };
          item.querySelector('[data-action="allow"]').click();
          return null;
        }
        if (document.querySelector(".ny-item.k-typing")) return null;
        return ${answered};
      })()`;
      const r = JSON.parse(await result(`motion=off&lsCamera=0,0,${zoom}&typingAsk`, read, SIZE));
      expect(r.pct).toBe(`${Math.round(zoom * 100)}%`);
      expect(r.item.text).toMatch(/^Nick wants to type in /);
      expect(r.item.kind).toMatch(/^Wants to type · /);
      expect(r.item.acts).toEqual(["allow", "deny", "go", "dismiss"]);
      // ranked with what holds someone up: no join request or finished session before it
      const at = r.item.kinds.indexOf("typing");
      expect(r.item.kinds.slice(0, at).every((k: string) => k === "permission" || k === "question" || k === "typing")).toBe(true);
      expect(r.live).toEqual({ asks: 0, typists: ["Nick Smith"] });
      expect(r.calls).toEqual([["s8", "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "session"]]);
    }, 90_000);

  it("Go there from Needs you, from a card, lands at 100% with the strip in view; Deny there says no", async () => {
    const read = `(() => {
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
        window.__t.at = { pct: ${PCT}, inView: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom, tray: !!document.querySelector(".ny-tray") };
        deny.click();
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
      const read = `(() => {
        window.__t ??= Date.now();
        if (Date.now() - window.__t < 2500) return null;
        return JSON.stringify(!!document.querySelector(".ls-peek"));
      })()`;
      expect(await result(`motion=off&lsCamera=0,0,${zoom}&typingAsk&lsPeek=s8`, read, SIZE)).toBe("false");
      expect(await result(`motion=off&lsCamera=0,0,${zoom}&typingAsk&lsPeek=s2`, read, SIZE)).toBe("true");
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
