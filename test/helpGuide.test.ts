import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpGuide } from "../src/renderer/HelpGuide";

const text = renderToStaticMarkup(createElement(HelpGuide))
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

describe("the guide (⌘/)", () => {
  it("names only controls the interface has: rows' buttons and menus, not the removed ⤷ dialog", () => {
    expect(text).not.toContain("⤷");
    expect(text).not.toContain("⛶");
    expect(text).toContain("Move to group…");
    expect(text).toContain("Settings → Control room");
  });

  it("has a word on every tab and the team features", () => {
    for (const what of ["Dashboard", "WorkTracker", "Council", "Team rooms", "Take over", "Board", "builder token"]) expect(text).toContain(what);
  });
});
