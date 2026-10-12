import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_REFS, artifactRef, encodeArtifactPicks, linkLabel, parseArtifactRefs, safeArtifactFileName } from "../src/shared/team/artifacts";

const id = (n: number) => `a${String(n).padStart(21, "0")}`;

describe("artifacts named in chat", () => {
  it("are written as #[name](artifact:id), the name stripped of the syntax's own characters", () => {
    expect(artifactRef(id(1), "API spec")).toBe(`#[API spec](artifact:${id(1)})`);
    expect(artifactRef(id(1), "a [b] (c)\nd")).toBe(`#[a b c d](artifact:${id(1)})`);
    expect(artifactRef(id(1), "  ")).toBe(`#[artifact](artifact:${id(1)})`);
    expect(artifactRef(id(1), "x".repeat(200))).toBe(`#[${"x".repeat(80)}](artifact:${id(1)})`);
  });

  it("are read from a message in order, each once, never from code, up to the limit", () => {
    const text = `see ${artifactRef(id(1), "spec")} and ${artifactRef(id(2), "mock")}, again ${artifactRef(id(1), "spec")}; \`${artifactRef(id(3), "in code")}\`\n\`\`\`\n${artifactRef(id(4), "block")}\n\`\`\``;
    expect(parseArtifactRefs(text)).toEqual([id(1), id(2)]);
    const many = Array.from({ length: MAX_ARTIFACT_REFS + 5 }, (_, i) => artifactRef(id(i + 10), `n${i}`)).join(" ");
    expect(parseArtifactRefs(many)).toHaveLength(MAX_ARTIFACT_REFS);
    expect(parseArtifactRefs("#[spec](artifact:short)")).toEqual([]);
  });

  it("are completed from the composer's picks, or one exact name, and left as typed otherwise", () => {
    const items = [
      { id: id(1), name: "API spec" },
      { id: id(2), name: "Mock" },
      { id: id(3), name: "mock" },
    ];
    const picks = new Map([["the mock", id(2)]]);
    expect(encodeArtifactPicks("read #[api SPEC] and #[the mock]", picks, items)).toBe(`read ${artifactRef(id(1), "API spec")} and ${artifactRef(id(2), "Mock")}`);
    // two artifacts named "mock" (ignoring case), none named "nope": both stay as typed
    expect(encodeArtifactPicks("#[MOCK] #[nope]", new Map(), items)).toBe("#[MOCK] #[nope]");
    // a canonical reference is left alone
    const done = artifactRef(id(1), "API spec");
    expect(encodeArtifactPicks(done, new Map(), items)).toBe(done);
    // a pick for an artifact that's gone falls back to the name
    expect(encodeArtifactPicks("#[API spec]", new Map([["API spec", id(9)]]), items)).toBe(artifactRef(id(1), "API spec"));
  });
});

describe("an artifact's file name on disk", () => {
  it("never holds a path, a colon or a control character, and is never empty or a dot name", () => {
    expect(safeArtifactFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeArtifactFileName("a:b\u0000c.png")).toBe("a_b_c.png");
    for (const bad of ["", ".", "..", "   "]) expect(safeArtifactFileName(bad)).toBe("artifact");
  });

  it("keeps its extension, or takes the one given, within 120 characters", () => {
    expect(safeArtifactFileName(`${"x".repeat(300)}.png`)).toBe(`${"x".repeat(116)}.png`);
    expect(safeArtifactFileName("screenshot", "png")).toBe("screenshot.png");
    expect(safeArtifactFileName("notes.txt", ".md")).toBe("notes.md");
  });
});

describe("a link's label", () => {
  it("names Azure DevOps work items and pull requests, and GitHub's", () => {
    expect(linkLabel("https://dev.azure.com/org/proj/_workitems/edit/5110")).toEqual({ host: "dev.azure.com", label: "ADO #5110" });
    expect(linkLabel("https://dev.azure.com/org/proj/_git/backoffice/pullrequest/88")).toEqual({ host: "dev.azure.com", label: "PR #88" });
    expect(linkLabel("https://github.com/acme/app/pull/45")).toEqual({ host: "github.com", label: "PR #45" });
    expect(linkLabel("https://github.com/acme/app/issues/7")).toEqual({ host: "github.com", label: "Issue #7" });
    expect(linkLabel("https://example.com/x")).toEqual({ host: "example.com", label: null });
  });

  it("is none for anything but an https URL", () => {
    expect(linkLabel("http://example.com")).toBeNull();
    expect(linkLabel("javascript:alert(1)")).toBeNull();
    expect(linkLabel("not a url")).toBeNull();
  });
});
