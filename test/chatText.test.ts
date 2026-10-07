import { describe, expect, it } from "vitest";
import { chatSegments } from "../src/renderer/team/chatText";

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
    expect(segs.map((s) => s.s).join("")).toBe("@Nick and @assistant, ping @ryan. Mail nick@example.com or @nobody");
  });

  it("finds https links without their trailing punctuation", () => {
    expect(chatSegments("see https://example.com/a?b=1.", members, "Ryan")).toEqual([
      { t: "text", s: "see " },
      { t: "link", s: "https://example.com/a?b=1" },
      { t: "text", s: "." },
    ]);
    expect(chatSegments("not http://example.com", members, "Ryan")).toEqual([{ t: "text", s: "not http://example.com" }]);
  });
});
