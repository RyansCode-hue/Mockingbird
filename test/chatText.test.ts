import { describe, expect, it } from "vitest";
import { chatSegments } from "../src/renderer/team/chatText";
import { artifactRef } from "../src/shared/team/artifacts";

const members = [{ name: "Nick Smith" }, { name: "Ryan" }];

describe("chat text", () => {
  it("renders light markdown as segments, never HTML", () => {
    expect(chatSegments("run **npm test** in `api/` then *rebase*", members, "Ryan")).toEqual([
      { t: "text", s: "run " },
      { t: "bold", s: "npm test" },
      { t: "text", s: " in " },
      { t: "code", s: "api/" },
      { t: "text", s: " then " },
      { t: "em", s: "rebase" },
    ]);
    expect(chatSegments("<img src=x onerror=alert(1)>", members, "Ryan")).toEqual([{ t: "text", s: "<img src=x onerror=alert(1)>" }]);
  });

  it("keeps code blocks whole, with nothing parsed inside", () => {
    expect(chatSegments("try:\n```ts\nconst a = `@Nick` **x**;\n```\ndone", members, "Ryan")).toEqual([
      { t: "text", s: "try:\n" },
      { t: "block", s: "const a = `@Nick` **x**;" },
      { t: "text", s: "\ndone" },
    ]);
  });

  it("marks mentions of members, the assistant and you; leaves unknown handles and emails as text", () => {
    const segs = chatSegments("@Nick and @assistant, ping @ryan. Mail nick@example.com or @nobody", members, "Ryan");
    expect(segs.filter((s) => s.t === "mention")).toEqual([
      { t: "mention", s: "@Nick", me: false, assistant: false },
      { t: "mention", s: "@assistant", me: false, assistant: true },
      { t: "mention", s: "@ryan", me: true, assistant: false },
    ]);
    expect(segs.map((s) => ("s" in s ? s.s : "")).join("")).toBe("@Nick and @assistant, ping @ryan. Mail nick@example.com or @nobody");
  });

  it("finds https links without their trailing punctuation", () => {
    expect(chatSegments("see https://example.com/a?b=1.", members, "Ryan")).toEqual([
      { t: "text", s: "see " },
      { t: "link", s: "https://example.com/a?b=1" },
      { t: "text", s: "." },
    ]);
    expect(chatSegments("not http://example.com", members, "Ryan")).toEqual([{ t: "text", s: "not http://example.com" }]);
  });

  it("finds room artifacts named as #[name](artifact:id), whatever their name holds", () => {
    const spec = "AAAAAAAAAAAAAAAAAAAAAA";
    const shot = "BBBBBBBBBBBBBBBBBBBBB_";
    expect(chatSegments(`read ${artifactRef(spec, "API spec")} first`, members, "Ryan")).toEqual([
      { t: "text", s: "read " },
      { t: "artifact", id: spec, name: "API spec" },
      { t: "text", s: " first" },
    ]);
    // a name with markdown, a link or a handle in it is still just the reference's label
    expect(chatSegments(`${artifactRef(shot, "**v2** @Nick https://x.io")}.`, members, "Ryan")).toEqual([
      { t: "artifact", id: shot, name: "**v2** @Nick https://x.io" },
      { t: "text", s: "." },
    ]);
    // an id of the wrong shape isn't a reference
    expect(chatSegments("#[spec](artifact:short)", members, "Ryan")).toEqual([{ t: "text", s: "#[spec](artifact:short)" }]);
    // inside code it's code
    const ref = artifactRef(spec, "spec");
    expect(chatSegments(`\`${ref}\` and ${ref}\n\`\`\`\n${ref}\n\`\`\``, members, "Ryan")).toEqual([
      { t: "code", s: ref },
      { t: "text", s: " and " },
      { t: "artifact", id: spec, name: "spec" },
      { t: "text", s: "\n" },
      { t: "block", s: ref },
    ]);
  });
});
