import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SETTLED_MS, StatusDot, popsOnChange } from "../src/renderer/StatusDot";
import { FolderIcon } from "../src/renderer/Icons";

describe("a session's status changing", () => {
  it("is emphasised only on arriving at waiting, from a state that had settled", () => {
    expect(popsOnChange("working", "waiting", 5000)).toBe(true);
    expect(popsOnChange("idle", "waiting", SETTLED_MS)).toBe(true);
    expect(popsOnChange("working", "waiting", SETTLED_MS - 1)).toBe(false); // flapping
    expect(popsOnChange("waiting", "waiting", 5000)).toBe(false); // a re-render, not a change
    for (const next of ["working", "idle", "dead"] as const) expect(popsOnChange("waiting", next, 5000)).toBe(false);
  });
  it("draws the same dot as before", () => {
    expect(renderToStaticMarkup(React.createElement(StatusDot, { status: "waiting", className: "sm" }))).toBe('<span class="dot sm waiting"></span>');
    expect(renderToStaticMarkup(React.createElement(StatusDot, { status: "idle" }))).toBe('<span class="dot idle"></span>');
  });
});

describe("a stack's folder", () => {
  it("is one back and one lid, the lid leaning open while its rows show", () => {
    const open = renderToStaticMarkup(React.createElement(FolderIcon, { open: true }));
    const closed = renderToStaticMarkup(React.createElement(FolderIcon, { open: false }));
    expect(open).toContain('class="ico folder open"');
    expect(closed).toContain('class="ico folder"');
    for (const svg of [open, closed]) {
      expect(svg.match(/class="back"/g)).toHaveLength(1);
      expect(svg.match(/class="lid"/g)).toHaveLength(1);
    }
    // the same paths either way: only the lid's transform (styles.css) tells them apart, so it can swing
    expect(open.replace(" open", "")).toBe(closed);
  });
});
