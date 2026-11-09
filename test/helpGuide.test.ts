import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpGuide } from "../src/renderer/HelpGuide";

const text = renderToStaticMarkup(createElement(HelpGuide))
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

describe("the guide (⌘/)", () => {
  it("names only controls the interface has: the landscape's menus and keys, not the removed ⤷ dialog or the grid's", () => {
    expect(text).not.toContain("⤷");
    expect(text).not.toContain("⛶");
    expect(text).toContain("Move to area…");
    // a double-click on the landscape focuses; renaming is the ⋯'s
    expect(text).toContain("Rename…");
    expect(text).not.toMatch(/double-click (a|any) name/i);
    expect(text).toContain("Settings → Control room");
    // the grid's arranging and pane numbers went with it
    expect(text).not.toMatch(/\bgrid\b|⌘⌃|⌘1–9|Previous/);
    for (const key of ["⌘\\", "⌘G", "⌘0 ⌘1", "N ⇧N"]) expect(text).toContain(key);
  });

  it("has a word on every tab and the team features", () => {
    for (const what of ["Dashboard", "WorkTracker", "Council", "Team rooms", "Take over", "Board", "builder token"]) expect(text).toContain(what);
  });
});
