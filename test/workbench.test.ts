import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch, rankMatches } from "../src/renderer/fuzzy";
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

describe("command palette matching", () => {
  const actions = ["Open control room", "New session", "Undo a turn of api — put its files back", "Settings"];
  it("keeps every row, in order, until something is typed", () => {
    expect(rankMatches("", actions, (a) => [a])).toEqual(actions);
  });
  it("ranks a match at word starts above one spread through the label", () => {
    expect(rankMatches("ns", actions, (a) => [a])[0]).toBe("New session");
    expect(rankMatches("zzz", actions, (a) => [a])).toEqual([]);
  });
  it("matches a session by any of its texts, its branch included", () => {
    const sessions = [
      { title: "API tests", branch: "5101-orgDropdowns" },
      { title: "Crashed session", branch: null },
    ];
    expect(rankMatches("dropdown", sessions, (s) => [s.title, s.branch]).map((s) => s.title)).toEqual(["API tests"]);
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

describe("file type badges", () => {
  it("labels a file by its name or extension, and leaves unknown types plain", async () => {
    const { fileBadge } = await import("../src/renderer/fileIcons");
    expect(fileBadge("src/app.tsx")?.label).toBe("TSX");
    expect(fileBadge("api/views.py")?.label).toBe("PY");
    expect(fileBadge("Dockerfile")?.label).toBe("DK");
    expect(fileBadge("package.json")?.label).toBe("NPM");
    expect(fileBadge("config/.env.local")?.label).toBe("ENV");
    expect(fileBadge("LICENSE")).toBeNull();
    expect(fileBadge("notes.weird")).toBeNull();
  });
  it("agrees with the editor about a file's language", async () => {
    const { fileBadge } = await import("../src/renderer/fileIcons");
    expect(fileBadge("Pages/Index.cshtml")?.label).toBe(fileBadge("index.html")?.label);
    expect(fileBadge("api/Api.csproj")?.label).toBe(fileBadge("pom.xml")?.label);
    expect(fileBadge("deploy/app.cfg")?.label).toBe("INI");
    expect(fileBadge("icons/logo.svg")?.label).toBe("SVG");
  });
  it("reads an extension the way path.extname does", async () => {
    const { extensionOf } = await import("../src/shared/fileTypes");
    expect(extensionOf("src/App.TSX")).toBe("tsx");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("config/.eslintrc.json")).toBe("json");
  });
});

describe("commit graph lanes", () => {
  const rows = async (commits: { sha: string; parents: string[] }[]) => (await import("../src/renderer/graphLayout")).layoutGraph(commits);

  it("keeps a straight history in one lane", async () => {
    const r = await rows([{ sha: "c", parents: ["b"] }, { sha: "b", parents: ["a"] }, { sha: "a", parents: [] }]);
    expect(r.map((x) => x.lane)).toEqual([0, 0, 0]);
    expect(r[2].after).toEqual([]);
  });

  it("opens a lane for a merge's second parent and closes it where the branches meet", async () => {
    // m merges f into d; f and d both come from a
    const r = await rows([
      { sha: "m", parents: ["d", "f"] },
      { sha: "f", parents: ["a"] },
      { sha: "d", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(r[0]).toMatchObject({ lane: 0, after: ["d", "f"] });
    expect(r[1]).toMatchObject({ lane: 1, after: ["d", "a"] });
    // d's parent a is already awaited in lane 1, so d joins it there rather than doubling it
    expect(r[2]).toMatchObject({ lane: 0, after: [null, "a"] });
    expect(r[3].lane).toBe(1);
  });

  it("puts a second branch tip in its own lane", async () => {
    const r = await rows([{ sha: "x", parents: ["a"] }, { sha: "y", parents: ["a"] }, { sha: "a", parents: [] }]);
    expect(r.map((x) => x.lane)).toEqual([0, 1, 0]);
  });
});

describe("saving edited text the way the file was", () => {
  it("keeps a byte-order mark and Windows line endings", async () => {
    const { splitBom, lineBreakOf, toFileText } = await import("../src/shared/editorText");
    const original = "﻿using System;\r\nclass A {}\r\n";
    const { bom, text } = splitBom(original);
    expect(bom).toBe(true);
    expect(lineBreakOf(text)).toBe("\r\n");
    const edited = text.replace(/\r\n/g, "\n").replace("class A {}", "class B {}");
    expect(toFileText(edited, "\r\n", true)).toBe("﻿using System;\r\nclass B {}\r\n");
    expect(lineBreakOf("a\nb\nc\r\n")).toBe("\n");
    expect(toFileText("a\nb\n", "\n", false)).toBe("a\nb\n");
  });

  it("indents the way the file already does", async () => {
    const { guessIndent } = await import("../src/shared/editorText");
    expect(guessIndent("def a():\n    return 1\n")).toBe("    ");
    expect(guessIndent("{\n  a: 1,\n  b: {\n    c: 2\n  }\n}\n")).toBe("  ");
    expect(guessIndent("func a() {\n\treturn\n}\n")).toBe("\t");
  });
});

describe("the editor's languages", () => {
  it("has a language for the repos' file types and none for plain text", async () => {
    const { languageExtension } = await import("../src/renderer/CodeEditor");
    for (const f of ["a.ts", "b.tsx", "c.py", "d.cs", "e.razor", "f.json", "g.yml", "h.sql", "Dockerfile", ".env.local", "i.go", "j.csproj", "k.md"]) {
      expect(languageExtension(f), f).not.toBeNull();
    }
    expect(languageExtension("notes.txt")).toBeNull();
  });
});

describe("git errors in Source Control", () => {
  it("count as fixed once there's nothing left to pull, push or commit", async () => {
    const { failureResolved } = await import("../src/renderer/SourceControl");
    const st = (o: object) => ({ behind: 0, ahead: 0, published: true, staged: [], conflicted: [], ...o });
    expect(failureResolved("pull", st({ behind: 3 }))).toBe(false);
    expect(failureResolved("pull", st({}))).toBe(true);
    expect(failureResolved("pull", st({ conflicted: [{ path: "a", status: "C" }] }))).toBe(false); // a merge left conflicts
    expect(failureResolved("push", st({ ahead: 1 }))).toBe(false);
    expect(failureResolved("push", st({ published: false }))).toBe(false);
    expect(failureResolved("push", st({}))).toBe(true);
    expect(failureResolved("commit", st({ staged: [{ path: "a", status: "M" }] }))).toBe(false);
    expect(failureResolved("fetch", st({}))).toBe(false); // nothing to tell from status: dismiss it by hand
  });
});

describe("a pane's share of the limit", () => {
  it("keeps a decimal when small, instead of rounding to 0%", async () => {
    const { formatShare } = await import("../src/shared/types");
    expect([23.6, 7.78, 0.22, 0.04, 0].map(formatShare)).toEqual(["24%", "7.8%", "0.2%", "<0.1%", "0%"]);
  });
});
