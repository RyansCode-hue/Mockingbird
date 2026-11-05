import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamChat, forgetViewsWith } from "../src/main/team/chat";

const told = vi.fn(async (_rooms: string[]): Promise<void> => undefined);
beforeEach(() => {
  told.mockClear();
  told.mockImplementation(async () => undefined);
  (globalThis as unknown as { window: unknown }).window = { mb: { teamChatViewing: told } };
});
/** The registry as a page loaded afresh has it. */
const freshPage = async () => {
  vi.resetModules();
  return import("../src/renderer/team/chatViewing");
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the room chats on screen", () => {
  it("count each view on its own: one going leaves the room viewed while another shows it", async () => {
    const { chatViewing, viewedRooms } = await import("../src/renderer/team/chatViewing");
    const [a, b, c] = [Symbol("a"), Symbol("b"), Symbol("c")];
    chatViewing(a, "R1");
    chatViewing(b, "R1");
    chatViewing(c, "R2");
    expect(viewedRooms()).toEqual(["R1", "R2"]);
    chatViewing(a, null);
    expect(viewedRooms()).toEqual(["R1", "R2"]);
    // a view no longer seen (off screen, zoomed out) stops counting, as one closed does
    chatViewing(b, null);
    expect(viewedRooms()).toEqual(["R2"]);
    chatViewing(c, null);
    expect(viewedRooms()).toEqual([]);
    expect(told.mock.calls.map((c) => c[0])).toEqual([["R1"], ["R1", "R2"], ["R2"], []]);
  });

  it("tell main the first time a page says anything, even that nothing's on screen", async () => {
    const { chatViewing } = await freshPage();
    chatViewing(Symbol("a"), null);
    expect(told.mock.calls).toEqual([[[]]]);
    await settle();
    chatViewing(Symbol("b"), null);
    expect(told.mock.calls).toHaveLength(1);
  });

  it("tell main again after a report it didn't take: an { error } answer or a rejection", async () => {
    const { chatViewing } = await freshPage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // a handler that throws answers { error } (handlers.ts guarded); the IPC itself failing rejects
    told.mockImplementationOnce((async () => ({ error: "setViewing broke" })) as unknown as typeof told);
    chatViewing(Symbol("a"), "R1");
    await settle();
    expect(warn).toHaveBeenCalledOnce();
    chatViewing(Symbol("b"), "R1");
    expect(told.mock.calls.map((c) => c[0])).toEqual([["R1"], ["R1"]]);
    told.mockImplementationOnce(async () => {
      throw new Error("no main");
    });
    chatViewing(Symbol("c"), "R2");
    await settle();
    expect(warn).toHaveBeenCalledTimes(2);
    chatViewing(Symbol("d"), "R2");
    expect(told.mock.calls.map((c) => c[0])).toEqual([["R1"], ["R1"], ["R1", "R2"], ["R1", "R2"]]);
    warn.mockRestore();
  });

  it("tell main the whole set again as the page starts and each time the window gets focus", async () => {
    const page = Object.assign(new EventTarget(), { mb: { teamChatViewing: told } });
    (globalThis as unknown as { window: unknown }).window = page;
    const { chatViewing } = await freshPage();
    await settle();
    expect(told.mock.calls).toEqual([[[]]]);
    chatViewing(Symbol("chat"), "R1");
    page.dispatchEvent(new Event("focus"));
    page.dispatchEvent(new Event("focus"));
    expect(told.mock.calls.map((c) => c[0])).toEqual([[], ["R1"], ["R1"], ["R1"]]);
  });

  it("leave main holding nothing across a reload, so mentions in a room no longer shown notify", async () => {
    // main's chat, told by the page through IPC, and the app window's page events
    const chat = new TeamChat({} as never);
    const page = new EventEmitter();
    forgetViewsWith(page as never, () => chat.setViewing(null));
    told.mockImplementation(async (rooms: string[]) => chat.setViewing(rooms));
    const viewed = () => [...(chat as unknown as { viewing: Set<string> }).viewing];
    const first = await freshPage();
    first.chatViewing(Symbol("chat"), "R1");
    await settle();
    expect(viewed()).toEqual(["R1"]);
    // a navigation that never replaces the page (cancelled, refused) leaves it: the page wouldn't say it again
    page.emit("did-start-loading");
    expect(viewed()).toEqual(["R1"]);
    // the page reloads: main forgets, and the new page's first word (nothing on screen) still reaches it
    page.emit("did-navigate");
    expect(viewed()).toEqual([]);
    chat.setViewing(["R1"]);
    const second = await freshPage();
    second.chatViewing(Symbol("chat"), null);
    await settle();
    expect(viewed()).toEqual([]);
    // the renderer going, and the window closing, forget as well
    for (const event of ["render-process-gone", "destroyed"]) {
      chat.setViewing(["R1"]);
      page.emit(event);
      expect(viewed()).toEqual([]);
    }
  });
});

describe("the app window's page", () => {
  // the Electron entry can't load under Vitest, so its wiring is read from its source
  it("has main forget what it said was on screen (index.ts): forgetViewsWith on its WebContents, before it loads", () => {
    const src = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const createWindow = src.slice(src.indexOf("function createWindow("), src.indexOf("win.loadFile("));
    expect(createWindow).toMatch(/forgetViewsWith\(win\.webContents, \(\) => teamRoom\.chat\.setViewing\(null\)\);/);
  });
});
