import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { dataPump, replay, type CachedTerm } from "../src/renderer/cachedTerm";

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
