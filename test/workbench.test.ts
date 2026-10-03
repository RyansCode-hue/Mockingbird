import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../src/renderer/fuzzy";
import { EMPTY_EDITOR, closeTab, openTab, tabKey, MAX_TABS, type OpenFile } from "../src/renderer/editorTabs";

const file = (path: string, extra: Partial<OpenFile> = {}): OpenFile => ({ sessionId: "s", root: "/r", path, mode: "file", ...extra });

describe("quick open matching", () => {
  it("matches letters in order, and ranks a match in the file name first", () => {
    const paths = ["src/renderer/FilePanel.tsx", "src/main/files.ts", "docs/filing/plan.md", "src/renderer/main.tsx"];
    expect(fuzzyFilter("fp", paths).map((m) => m.path)[0]).toBe("src/renderer/FilePanel.tsx");
    expect(fuzzyFilter("files", paths).map((m) => m.path)[0]).toBe("src/main/files.ts");
    expect(fuzzyFilter("zzz", paths)).toEqual([]);
  });

  it("finds a match even when jumping to word starts would strand later letters", () => {
    expect(fuzzyMatch("ba", "xbxa_b")).not.toBeNull();
  });

  it("matches across folders when the name alone doesn't", () => {
    const m = fuzzyMatch("rmain", "src/renderer/main.tsx")!;
    expect(m).not.toBeNull();
    expect(m.positions.map((i) => "src/renderer/main.tsx"[i]).join("")).toBe("rmain");
  });

  it("ignores spaces and case", () => {
    expect(fuzzyMatch("File Panel", "src/FilePanel.tsx")).not.toBeNull();
  });
});

describe("editor tabs", () => {
  it("opens a file once, and activates it when opened again", () => {
    let s = openTab(EMPTY_EDITOR, file("a.ts"));
    s = openTab(s, file("b.ts"));
    s = openTab(s, file("a.ts"));
    expect(s.tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
    expect(s.active).toBe(tabKey(file("a.ts")));
  });

  it("gives every file its own tab", () => {
    let s = openTab(EMPTY_EDITOR, file("a.ts"));
    s = openTab(s, file("b.ts"));
    s = openTab(s, file("c.ts"));
    expect(s.tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(s.active).toBe(tabKey(file("c.ts")));
  });

  it("keeps a staged diff and the working-tree diff of a file as separate tabs", () => {
    let s = openTab(EMPTY_EDITOR, file("a.ts", { mode: "diff", source: { kind: "scm", staged: true, untracked: false } }));
    s = openTab(s, file("a.ts", { mode: "diff", source: { kind: "scm", staged: false, untracked: false } }));
    expect(s.tabs).toHaveLength(2);
  });

  it("closes the oldest tab past the limit, and activates the neighbor of a closed active tab", () => {
    let s = EMPTY_EDITOR;
    for (let i = 0; i <= MAX_TABS; i++) s = openTab(s, file(`f${i}.ts`));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.tabs[0].path).toBe("f1.ts");
    s = openTab(s, file("f5.ts"));
    s = closeTab(s, tabKey(file("f5.ts")));
    expect(s.active).toBe(tabKey(file("f6.ts")));
    s = closeTab(s, tabKey(file(`f${MAX_TABS}.ts`)));
    expect(s.tabs).toHaveLength(MAX_TABS - 2);
  });
});

describe("search result marks", () => {
  it("marks every literal occurrence, honoring case", async () => {
    const { matchRanges } = await import("../src/renderer/SearchView");
    expect(matchRanges("Foo foo FOO", "foo", { regex: false, matchCase: false })).toEqual([[0, 3], [4, 7], [8, 11]]);
    expect(matchRanges("Foo foo FOO", "foo", { regex: false, matchCase: true })).toEqual([[4, 7]]);
  });
  it("marks regex matches, and nothing for a pattern JavaScript can't read", async () => {
    const { matchRanges } = await import("../src/renderer/SearchView");
    expect(matchRanges("a1 b22", "[0-9]+", { regex: true, matchCase: false })).toEqual([[1, 2], [4, 6]]);
    expect(matchRanges("abc", "x*", { regex: true, matchCase: false })).toEqual([]);
    expect(matchRanges("abc", "(", { regex: true, matchCase: false })).toEqual([]);
  });
});

describe("go to file:line", () => {
  it("splits a trailing :line off the query", async () => {
    const { parseGoTo } = await import("../src/renderer/QuickOpen");
    expect(parseGoTo("app.ts:42")).toEqual({ query: "app.ts", line: 42 });
    expect(parseGoTo(" app.ts ")).toEqual({ query: "app.ts", line: null });
    expect(parseGoTo("a:b")).toEqual({ query: "a:b", line: null });
  });
});

describe("result lines in a narrow side bar", () => {
  it("cuts the start of a line so its first match shows, shifting the marks", async () => {
    const { aroundMatch } = await import("../src/renderer/SearchView");
    const text = "export const filler1 = 1; // donor line 1";
    const r = aroundMatch(text, [[29, 34]]);
    expect(r.text.startsWith("…")).toBe(true);
    const [a, b] = r.ranges[0];
    expect(r.text.slice(a, b)).toBe("donor");
    expect(aroundMatch("a donor", [[2, 7]]).text).toBe("a donor");
  });
});
