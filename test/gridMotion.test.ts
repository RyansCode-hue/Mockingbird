import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { flyTarget, genieFlight, keepsItsSize, switchDir, type Rect } from "../src/renderer/gridMotion";
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

describe("a pane through a grid change", () => {
  const was: Rect = { x: 8, y: 8, w: 600, h: 400 };
  it("keeps its size when only its place changes, or nothing does", () => {
    expect(keepsItsSize(was, was)).toBe(true);
    expect(keepsItsSize(was, { ...was, x: 616, y: 416 })).toBe(true);
    expect(keepsItsSize(was, { ...was, w: 600.3 })).toBe(true); // subpixel layout rounding
  });
  it("doesn't when it's resized, or is new to the grid", () => {
    expect(keepsItsSize(was, { ...was, w: 1216 })).toBe(false);
    expect(keepsItsSize(was, { ...was, h: 820 })).toBe(false);
    expect(keepsItsSize(undefined, was)).toBe(false);
  });
});

describe("switching groups", () => {
  const order = ["5101", "5102", "ungrouped"];
  it("moves down to a group listed below, up to one above", () => {
    expect(switchDir(order, "5101", "5102")).toBe(1);
    expect(switchDir(order, "ungrouped", "5101")).toBe(-1);
    expect(switchDir(order, "5101", "a room's group")).toBe(1); // not in the list: down
  });
});

describe("where a minimized pane flies", () => {
  const list: Rect = { x: 50, y: 100, w: 250, h: 600 };
  const icon: Rect = { x: 80, y: 300, w: 13, h: 13 };
  const rail: Rect = { x: 12, y: 60, w: 20, h: 20 };
  it("to its folder when the folder is in view", () => {
    expect(flyTarget({ target: icon, list, listShown: true, rail })).toEqual({ to: icon, via: "target" });
  });
  it("to the list's edge on the folder's side when it's scrolled out of view", () => {
    expect(flyTarget({ target: { ...icon, y: 20 }, list, listShown: true, rail })).toEqual({ to: { ...icon, y: 100 }, via: "edge" });
    expect(flyTarget({ target: { ...icon, y: 900 }, list, listShown: true, rail })).toEqual({ to: { ...icon, y: 687 }, via: "edge" });
  });
  it("to the rail's Sessions icon with the side bar collapsed or on another view", () => {
    expect(flyTarget({ target: icon, list, listShown: false, rail })).toEqual({ to: rail, via: "rail" });
    expect(flyTarget({ target: null, list: null, listShown: false, rail })).toEqual({ to: rail, via: "rail" });
  });
  it("nowhere when the list shows but the target's folded away, or there's nothing to fly to", () => {
    expect(flyTarget({ target: null, list, listShown: true, rail })).toEqual({ to: null, via: "none" });
    expect(flyTarget({ target: null, list: null, listShown: false, rail: null })).toEqual({ to: null, via: "none" });
  });
});

describe("the genie flight", () => {
  const pane: Rect = { x: 400, y: 80, w: 600, h: 400 };
  const icon: Rect = { x: 80, y: 300, w: 13, h: 13 };
  const last = (f: Keyframe[]) => f[f.length - 1];
  it("starts at the pane and ends shrunk onto the icon, faded out", () => {
    const g = genieFlight(pane, icon, "in");
    expect(g.group.frames[0].transform).toBe("translate(400px, 80px)");
    expect(last(g.group.frames).transform).toBe("translate(80px, 80px)");
    expect(g.group.frames.every((f) => f.width === "600px" && f.height === "400px")).toBe(true);
    expect(last(g.pair.frames).transform).toBe(`translateY(220px) scale(${13 / 600}, ${13 / 400})`);
    expect(last(g.image.frames).opacity).toBe(0);
    // the side facing the icon pinches toward the icon's height in the pane (56%)
    expect(g.image.frames[1].clipPath).toBe("polygon(0 50.625%, 100% 0, 100% 100%, 0 62.625%)");
  });
  it("comes back out along the same path, reversed", () => {
    const into = genieFlight(pane, icon, "in");
    const out = genieFlight(pane, icon, "out");
    expect(out.group.frames.map((f) => f.transform)).toEqual(into.group.frames.map((f) => f.transform).reverse());
    expect(out.image.frames.map((f) => f.offset ?? null)).toEqual([null, 1 - 0.78, 1 - 0.4, null].map((o) => (o === null ? null : expect.closeTo(o, 6))));
    expect(out.pair.frames[0].transform).toBe(last(into.pair.frames).transform);
    expect(last(out.image.frames).opacity).toBe(1);
  });
});

describe("a workspace's folder", () => {
  it("is one back and one lid, the lid leaning open while its workspace is on screen", () => {
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
