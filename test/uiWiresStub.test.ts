import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The UI preview's wires (src/preview/stub.ts), called in real headless Chrome through window.mb as the renderer will,
// against main's rules: local only (CI runners have no desktop); the script passes a mock keychain.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function probe(): Promise<Record<string, any>> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  // polled until it answers: the stub's window.mb may not be there on the first poll
  const read = `(() => {
    if (!window.mb?.wiresGet) return null;
    window.__wireProbe ??= (async () => {
      const mb = window.mb;
      const changes = [];
      mb.onWiresChanged((c) => changes.push(c));
      const out = { empty: await mb.wiresGet() };
      const made = await mb.wiresAdd("s1", "s3", "handoff");
      out.made = made;
      out.afterAdd = changes.length;
      out.noop = await mb.wiresSet(made.id, { gate: "ask" });
      out.afterNoop = changes.length;
      out.set = await mb.wiresSet(made.id, { gate: "automatic" });
      out.afterSet = changes.length;
      out.rekeyMissing = await mb.wiresRekey("s1", "nope");
      out.rekeyTerminal = await mb.wiresRekey("s1", "s4");
      out.rekeyItself = await mb.wiresRekey("s1", "s3");
      out.rekeyNothing = await mb.wiresRekey("s7", "s5");
      out.afterNothing = changes.length;
      out.rekeyed = await mb.wiresRekey("s1", "s8");
      out.afterRekey = changes.length;
      out.removed = await mb.wiresRemove(made.id);
      out.restored = await mb.wiresRestore(made.id);
      out.again = await mb.wiresRestore(made.id);
      await mb.killSession("s3", false);
      out.afterClose = changes.length;
      out.closedBook = await mb.wiresGet();
      await mb.killSession("s8", true);
      out.afterForget = changes.length;
      out.forgotBook = await mb.wiresGet();
      out.last = changes.at(-1);
      window.__wireResult = JSON.stringify(out);
    })();
    return window.__wireResult ?? null;
  })()`;
  const json: string | null = await pageResult({ size: "1400x900", outDir: path.join(tempDir("wires-ui"), "out"), read });
  if (!json) throw new Error("the preview didn't answer wires:get");
  return JSON.parse(json);
}

describe.skipIf(!local)("the UI preview's wires", () => {
  it("go by main's rules: a change counted only when the book changes, rekey's checks, restore's, and Forget dropping them", async () => {
    const r = await probe();
    expect(r.empty).toMatchObject({ book: { links: {}, notes: {} }, refused: null, wiresRev: 0, problems: [] });
    expect(r.made.state.book.links[r.made.id]).toMatchObject({ from: "s1", to: "s3", type: "handoff", gate: "ask" });
    expect([r.made.state.wiresRev, r.afterAdd]).toEqual([1, 1]);
    // a setting that changes nothing isn't a change
    expect([r.noop.state.wiresRev, r.afterNoop]).toEqual([1, 1]);
    expect([r.set.state.wiresRev, r.afterSet]).toEqual([2, 2]);
    expect(r.rekeyMissing).toEqual({ refused: 'This Mac has no session "nope".' });
    expect(r.rekeyTerminal.refused).toMatch(/isn't the same kind of workspace/);
    expect(r.rekeyItself.refused).toMatch(/to itself/);
    expect([r.rekeyNothing.state.wiresRev, r.afterNothing]).toEqual([2, 2]);
    expect(r.rekeyed.state.book.links[r.made.id]).toMatchObject({ from: "s8", to: "s3" });
    expect(r.afterRekey).toBe(3);
    expect(r.restored.state.book.links[r.made.id]).toMatchObject({ from: "s8", to: "s3", gate: "automatic" });
    expect(r.again).toEqual({ refused: "That wire can't be restored any more." });
    // closing keeps a wire, its end closed; forgetting takes it, naming it to the windows
    expect(r.afterClose).toBe(r.afterRekey + 2);
    expect(Object.keys(r.closedBook.book.links)).toEqual([r.made.id]);
    expect(r.afterForget).toBe(r.afterClose + 1);
    expect(r.forgotBook.book.links).toEqual({});
    expect(r.last.dropped.map((d: { id: string }) => d.id)).toEqual([r.made.id]);
  });
});
