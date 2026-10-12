import { readFileSync } from "fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView, inlineSegments, markdownBlocks } from "../src/renderer/team/markdownView";
import { artifactCompletions, artifactMeta, mentionLabel, parseCsv, parseLines, repoDefaultName, transferLine } from "../src/renderer/team/artifactModel";
import { artifactRef, type ArtifactSummary } from "../src/shared/team/artifacts";

const ME = "me";
const now = Date.parse("2026-10-12T15:00:00");
const min = 60_000;
const summary = (over: Partial<ArtifactSummary>): ArtifactSummary => ({
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  kind: "file",
  name: "x",
  addedBy: "nick",
  addedByName: "Nick",
  addedAt: now - 120 * min,
  agentsBlocked: null,
  ...over,
});

describe("room notes and markdown files", () => {
  it("are read as blocks: headings, paragraphs, lists, quotes, code, rules and tables", () => {
    const md = [
      "# Last-org spec ##",
      "",
      "Store the choice **per user**.",
      "Second line.",
      "",
      "- one",
      "  - nested",
      "- [x] done",
      "3. three",
      "",
      "> quoted",
      "> > deeper",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "---",
      "| Col | Right |",
      "| :-- | ---: |",
      "| a | b |",
      "Title",
      "===",
      "```",
      "never closed",
    ].join("\n");
    expect(markdownBlocks(md)).toEqual([
      { t: "h", level: 1, text: "Last-org spec" },
      { t: "p", text: "Store the choice **per user**.\nSecond line." },
      {
        t: "list",
        items: [
          { depth: 0, marker: "•", text: "one", task: null },
          { depth: 1, marker: "•", text: "nested", task: null },
          { depth: 0, marker: "•", text: "done", task: true },
          { depth: 0, marker: "3.", text: "three", task: null },
        ],
      },
      { t: "quote", blocks: [{ t: "p", text: "quoted" }, { t: "quote", blocks: [{ t: "p", text: "deeper" }] }] },
      { t: "code", lang: "ts", text: "const a = 1;" },
      { t: "rule" },
      { t: "table", head: ["Col", "Right"], align: ["left", "right"], rows: [["a", "b"]] },
      { t: "h", level: 1, text: "Title" },
      { t: "code", lang: "", text: "never closed" },
    ]);
    // a ticket number isn't a heading
    expect(markdownBlocks("#5110 is done")).toEqual([{ t: "p", text: "#5110 is done" }]);
  });

  it("render as elements: HTML, scripts, images and non-https links stay text", () => {
    const md = [
      "<script>alert(1)</script>",
      "",
      "<img src=x onerror=alert(1)>",
      "",
      "[click](javascript:alert(1)) and [plain](http://example.com)",
      "",
      "![tracker](https://evil.example/t.png)",
      "",
      "[the PR](https://github.com/acme/backoffice/pull/45)",
      "",
      "| <b>x</b> |",
      "| --- |",
      "| [y](javascript:void(0)) |",
    ].join("\n");
    const html = renderToStaticMarkup(createElement(MarkdownView, { text: md }));
    expect(html).not.toMatch(/<script|<img|<b>|javascript:alert\(1\)"|href="javascript|href="http:/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("[click](javascript:alert(1))");
    expect(html).toContain("![tracker](https://evil.example/t.png)");
    expect(html).toContain('href="https://github.com/acme/backoffice/pull/45"');
    expect(html).toContain(">the PR</a>");
  });

  it("read links, images and references in inline text", () => {
    const ref = artifactRef("AAAAAAAAAAAAAAAAAAAAAA", "spec");
    expect(inlineSegments(`see [docs](https://x.io/a) ![i](https://x.io/i.png) \`[c](https://x.io)\` ${ref}`)).toEqual([
      { t: "text", s: "see " },
      { t: "mdlink", label: "docs", url: "https://x.io/a" },
      { t: "text", s: " ![i](https://x.io/i.png) " },
      { t: "code", s: "[c](https://x.io)" },
      { t: "text", s: " " },
      { t: "artifact", id: "AAAAAAAAAAAAAAAAAAAAAA", name: "spec" },
    ]);
    // a line too long to parse safely is shown as it is
    const long = "*a ".repeat(3000);
    expect(inlineSegments(`**b**\n${long}`)).toEqual([{ t: "bold", s: "b" }, { t: "text", s: `\n${long}` }]);
  });
});

describe("the window's content security policy", () => {
  it("shows images only from this app and the blob: URLs the viewer makes — nothing remote, no data: URLs", () => {
    const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
    const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    expect(directives["img-src"]).toEqual(["'self'", "blob:"]);
    expect(directives["default-src"]).toEqual(["'self'"]);
  });
});

describe("a CSV artifact", () => {
  it("is read into cells: quoted commas, line breaks and quotes; CRLF; a BOM; blank lines skipped", () => {
    expect(parseCsv('﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\n\r\nplain,\n').rows).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["plain", ""],
    ]);
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("stops at its row and column limits, and says so", () => {
    const t = parseCsv("a,b,c\n1,2,3\n4,5,6\n", 2, 2);
    expect(t).toEqual({ rows: [["a", "b"], ["1", "2"]], moreRows: true, moreCols: true });
    expect(parseCsv("a,b\n1,2\n", 2, 2)).toEqual({ rows: [["a", "b"], ["1", "2"]], moreRows: false, moreCols: false });
  });
});

describe("the Team tab's artifact rows", () => {
  it("say what each artifact is in one line", () => {
    expect(artifactMeta(summary({ size: 2.4 * 1024 * 1024 }), ME, now)).toBe("2.4 MB · Nick · 2h ago");
    expect(artifactMeta(summary({ size: 300, addedBy: ME }), ME, now)).toBe("300 bytes · you · 2h ago");
    expect(artifactMeta(summary({ kind: "note" }), ME, now)).toBe("Note · Nick · 2h ago");
    expect(artifactMeta(summary({ kind: "note", updatedByName: "Sam", updatedAt: now - 5 * min }), ME, now)).toBe("Note · edited by Sam · 5m ago");
    expect(artifactMeta(summary({ kind: "repo", path: "src/x.ts", lines: [12, 40], commit: "abc1234def".padEnd(40, "0") }), ME, now)).toBe("src/x.ts:12–40 @ abc1234");
    expect(artifactMeta(summary({ kind: "link", url: "https://dev.azure.com/a", host: "dev.azure.com", label: "ADO #5110" }), ME, now)).toBe("dev.azure.com · ADO #5110");
  });

  it("show a file's transfer, and what a click can do about it", () => {
    expect(transferLine({ size: 1000, local: { state: "downloading", received: 400, from: "Nick" } })).toEqual({ text: "downloading 40% from Nick", pct: 40 });
    expect(transferLine({ local: { state: "failed", problem: "Nick's Mockingbird needs an update to share files" } })?.action).toBe("Retry");
    expect(transferLine({ local: { state: "on-demand" } })?.action).toBe("Download");
    expect(transferLine({ local: { state: "present", view: "image", mime: "image/png" } })).toBeNull();
  });
});

describe("naming artifacts in the composer", () => {
  const items = [
    { id: "1", name: "API spec", addedAt: 1 },
    { id: "2", name: "dropdown.png", addedAt: 3 },
    { id: "3", name: "Spec review notes", addedAt: 2 },
    { id: "4", name: "old-spec.md", addedAt: 4 },
  ];
  it("completes # with names starting with what's typed, then words in them, then anything holding it", () => {
    expect(artifactCompletions("spec", items).map((i) => i.id)).toEqual(["3", "4", "1"]);
    expect(artifactCompletions("view", items).map((i) => i.id)).toEqual(["3"]);
    expect(artifactCompletions("ropd", items).map((i) => i.id)).toEqual(["2"]);
    expect(artifactCompletions("", items).map((i) => i.id)).toEqual(["4", "2", "3", "1"]);
    // nothing matches a ticket number, so Enter still sends
    expect(artifactCompletions("5110", items)).toEqual([]);
  });

  it("inserts a label the reference syntax can hold", () => {
    expect(mentionLabel("a [b] (c)\nd")).toBe("a b c d");
    expect(mentionLabel("x".repeat(100))).toBe("x".repeat(80));
  });
});

describe("the repo file form", () => {
  it("reads one line or a range", () => {
    expect(parseLines("")).toEqual({ lines: null });
    expect(parseLines("12")).toEqual({ lines: [12, 12] });
    expect(parseLines("12–40")).toEqual({ lines: [12, 40] });
    expect(parseLines(" 12 - 40 ")).toEqual({ lines: [12, 40] });
    expect(parseLines("40-12")).toHaveProperty("error");
    expect(parseLines("0")).toHaveProperty("error");
    expect(parseLines("twelve")).toHaveProperty("error");
    expect(repoDefaultName("src/org/Dropdown.tsx", [12, 40])).toBe("Dropdown.tsx:12–40");
    expect(repoDefaultName("src/org/Dropdown.tsx", null)).toBe("Dropdown.tsx");
  });
});
