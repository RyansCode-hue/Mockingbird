import { afterEach, describe, expect, it, vi } from "vitest";

// xterm's fit addon looks for a browser global as it loads
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import { Terminal } from "@xterm/xterm";
import { dataPump, makeTerm, replay, termLinkHandler, type CachedTerm } from "../src/renderer/cachedTerm";

const parsed = (term: Terminal) => new Promise<void>((r) => term.write("", r));
const screen = (term: Terminal) => {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out.filter(Boolean);
};

function setup() {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 10 });
  const e: CachedTerm = { term, replayed: false, ready: false };
  const entries = new Map([["s1", e]]);
  let push!: (id: string, data: string) => void;
  dataPump((cb) => (push = cb), entries, (x, d) => x.term.write(d))();
  const sent: string[] = [];
  term.onData((d) => e.ready && sent.push(d)); // the pane's only path to the pty waits for ready
  let answer!: (buf: string) => void;
  const saved = new Promise<string>((r) => (answer = r));
  return { term, e, push, sent, answer, saved };
}

describe("cached terminal replay", () => {
  it("drops output already in the saved buffer and keeps output that arrives while the replay parses", async () => {
    const { term, e, push, answer, saved } = setup();
    const done = replay(e, saved, () => true);
    push("s1", "inside the buffer\r\n"); // arrived before the buffer reply: it's in it
    answer("history\r\ninside the buffer\r\n");
    await done;
    expect(e.replayed).toBe(true);
    expect(e.ready).toBe(false); // xterm hasn't parsed the replay yet
    push("s1", "live\r\n");
    await parsed(term);
    expect(e.ready).toBe(true);
    expect(screen(term)).toEqual(["history", "inside the buffer", "live"]);
  });

  it("doesn't forward xterm's answers to queries in the replayed history", async () => {
    const { term, e, sent, answer, saved } = setup();
    const done = replay(e, saved, () => true);
    answer("prompt\x1b[c\x1b[6n");
    await done;
    await parsed(term);
    expect(sent).toEqual([]);
    term.write("\x1b[6n"); // a live query is answered
    await parsed(term);
    expect(sent).toHaveLength(1);
  });

  it("writes nothing into a terminal disposed while the replay was in flight", async () => {
    const { term, e, answer, saved } = setup();
    const done = replay(e, saved, () => false);
    answer("history");
    await done;
    await parsed(term);
    expect(e.replayed).toBe(false);
    expect(screen(term)).toEqual([]);
  });

  it("still follows live output when the saved buffer can't be read, and says so", async () => {
    const { term, e, push } = setup();
    await replay(e, Promise.reject(new Error("gone")), () => true);
    push("s1", "live\r\n");
    await parsed(term);
    expect(e.ready).toBe(true);
    expect(screen(term)).toEqual(["[earlier output couldn't be loaded: gone]", "live"]);
  });
});

describe("links in terminal output", () => {
  afterEach(() => vi.unstubAllGlobals());

  function browser(answer: boolean) {
    const opened: string[] = [];
    const asked: string[] = [];
    const alerts: string[] = [];
    vi.stubGlobal("window", { mb: { openExternal: async (url: string) => void opened.push(url) } });
    vi.stubGlobal("confirm", (msg: string) => (asked.push(msg), answer));
    vi.stubGlobal("alert", (msg: string) => void alerts.push(msg));
    return { opened, asked, alerts };
  }
  const click = async (url: string) => {
    termLinkHandler.activate(new Event("click") as MouseEvent, url, { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } });
    await new Promise((r) => setTimeout(r, 0));
  };

  it("open in the browser, never the app, once the real address has been shown and agreed to", async () => {
    const yes = browser(true);
    await click("https://evil.example/login");
    expect(yes.asked).toEqual([expect.stringContaining("https://evil.example/login")]);
    expect(yes.opened).toEqual(["https://evil.example/login"]);
    const no = browser(false);
    await click("https://evil.example/login");
    expect(no.opened).toEqual([]);
  });

  it("go nowhere unless they're https, and say so", async () => {
    const b = browser(true);
    for (const url of ["http://evil.example", "file:///etc/passwd", "javascript:alert(1)"]) await click(url);
    expect(b.asked).toEqual([]);
    expect(b.opened).toEqual([]);
    expect(b.alerts).toHaveLength(3);
    expect(b.alerts[0]).toMatch(/Only https links open in the browser/);
  });

  it("is every app terminal's handler", () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(makeTerm({}).term.options.linkHandler).toBe(termLinkHandler);
  });
});
