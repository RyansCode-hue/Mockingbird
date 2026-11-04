import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionBar, LabelledButton, menuHeading, menuKey, nextItem, openMenu, pickActions, placeMenu, tidyMenu, type Action, type MenuEntry } from "../src/renderer/ContextMenu";

const act = (key: string, over: Partial<Action> = {}): Action => ({ key, label: key, onPick: vi.fn(), ...over });

describe("a right-click menu", () => {
  const items: MenuEntry[] = [act("show"), "-", act("takeover", { disabled: true }), act("notify"), act("pin"), "-", act("close", { danger: true })];

  it("opens at the point on its first row that can be picked", () => {
    expect(openMenu({ x: 10, y: 20 }, items)).toEqual({ at: { x: 10, y: 20 }, items, active: 0 });
    expect(openMenu({ x: 0, y: 0 }, ["-", act("a", { disabled: true }), act("b")])?.active).toBe(2);
  });
  it("doesn't open when nothing in it can be picked", () => {
    expect(openMenu({ x: 0, y: 0 }, [])).toBeNull();
    expect(openMenu({ x: 0, y: 0 }, ["-", act("a", { disabled: true })])).toBeNull();
  });
  it("moves with the arrow keys past separators and disabled rows, wrapping at the ends", () => {
    let st = openMenu({ x: 0, y: 0 }, items)!;
    st = menuKey(st, "ArrowDown").state!;
    expect(st.active).toBe(3); // over the separator and the disabled Take over
    st = menuKey(st, "ArrowUp").state!;
    expect(st.active).toBe(0);
    st = menuKey(st, "ArrowUp").state!;
    expect(st.active).toBe(6); // wraps to Close
    expect(menuKey(st, "Home").state!.active).toBe(0);
    expect(menuKey(st, "End").state!.active).toBe(6);
    expect(nextItem(items, 6, 1)).toBe(0);
  });
  it("closes on Esc and on Tab without running anything", () => {
    const st = openMenu({ x: 0, y: 0 }, items)!;
    for (const key of ["Escape", "Tab"]) {
      const r = menuKey(st, key);
      expect(r).toMatchObject({ state: null, handled: true });
      expect(r.picked).toBeUndefined();
    }
    for (const it of items) if (it !== "-") expect(it.onPick).not.toHaveBeenCalled();
  });
  it("runs the row the keyboard is on with Enter or Space, and closes", () => {
    const notify = act("notify");
    const pin = act("pin");
    let st = openMenu({ x: 0, y: 0 }, [notify, pin])!;
    st = menuKey(st, "ArrowDown").state!;
    const r = menuKey(st, "Enter");
    expect(r.state).toBeNull();
    r.picked?.onPick();
    expect(pin.onPick).toHaveBeenCalledOnce();
    expect(notify.onPick).not.toHaveBeenCalled();
    expect(menuKey(openMenu({ x: 0, y: 0 }, [notify])!, " ").picked).toBe(notify);
  });
  it("leaves other keys to the page", () => {
    const st = openMenu({ x: 0, y: 0 }, items)!;
    expect(menuKey(st, "a")).toEqual({ state: st, handled: false });
  });
});

describe("where a right-click menu opens", () => {
  const view = { width: 1000, height: 800 };
  const size = { width: 200, height: 300 };
  it("opens down and right of the pointer when it fits", () => {
    expect(placeMenu({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100, maxHeight: 784 });
  });
  it("flips left and up near the window's right and bottom edges", () => {
    expect(placeMenu({ x: 950, y: 700 }, size, view)).toMatchObject({ left: 750, top: 400 });
  });
  it("never goes past an edge, and a menu taller than the window scrolls", () => {
    const p = placeMenu({ x: 5, y: 790 }, { width: 200, height: 2000 }, view);
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(784);
    expect(placeMenu({ x: 2000, y: 100 }, size, view).left).toBe(1000 - 8 - 200);
  });
});

describe("an element's actions", () => {
  it("are shown as buttons by key, in the order asked for", () => {
    const all: MenuEntry[] = [act("show"), "-", act("notify"), act("pin"), act("close")];
    expect(pickActions(all, ["pin", "takeover", "notify"]).map((a) => a.key)).toEqual(["pin", "notify"]);
  });
  it("leave no separator at a menu's ends or two together when a set comes out empty", () => {
    expect(tidyMenu(["-", act("a"), null, "-", false, "-", act("b"), "-", undefined]).map((e) => (e === "-" ? "-" : e.key))).toEqual(["a", "-", "b"]);
    expect(tidyMenu(["-", "-"])).toEqual([]);
  });
  it("drop a heading whose rows all came out empty, and one left at the end", () => {
    const h = (label: string) => menuHeading(label);
    const tidy = tidyMenu([h("Session"), act("rename"), "-", h("Tools"), null, "-", h("Terminal"), act("repaint"), "-", h("Room")]);
    expect(tidy.map((e) => (e === "-" ? "-" : e.heading ? `# ${e.label}` : e.key))).toEqual(["# Session", "rename", "-", "# Terminal", "repaint"]);
  });
  it("never land the keyboard on a heading", () => {
    const items: MenuEntry[] = [menuHeading("Tools"), act("files", { kbd: "⇧⌘E" }), "-", menuHeading("Terminal"), act("repaint")];
    const st = openMenu({ x: 0, y: 0 }, items)!;
    expect(st.active).toBe(1);
    expect(menuKey(st, "ArrowDown").state!.active).toBe(4);
    expect(menuKey(menuKey(st, "ArrowDown").state!, "ArrowDown").state!.active).toBe(1);
    expect(menuKey(st, "Home").state!.active).toBe(1);
    expect(openMenu({ x: 0, y: 0 }, [menuHeading("Tools")])).toBeNull();
  });
  it("show a word under every icon, and More for the rest", () => {
    const html = renderToStaticMarkup(React.createElement(ActionBar, { actions: [act("pin", { label: "Pinned", pressed: true, title: "Unpin" })], more: [act("close", { label: "Close" })] }));
    expect(html).toContain('<span class="lbtn-t">Pinned</span>');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="Unpin"');
    expect(html).toContain('<span class="lbtn-t">More</span>');
    expect(renderToStaticMarkup(React.createElement(LabelledButton, { action: act("takeover", { label: "Take over", primary: true }) }))).toMatch(/class="lbtn primary[^"]*"[^>]*data-action="takeover"/);
  });
});
