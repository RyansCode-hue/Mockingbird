import { afterEach, describe, expect, it, vi } from "vitest";
import capture from "./fixtures/codex-folder-notice-0.156.1.json";
import {
  CodexFolderNotice,
  FOLDER_NOTICE_RETRY_MS,
  FOLDER_NOTICE_SETTLE_MS,
  FOLDER_NOTICE_STALL_MS,
  FOLDER_NOTICE_WAIT_MS,
  MAX_PRESSES,
  frameText,
  isOpenRestrictedNotice,
} from "../src/main/codexFolderNotice";

const END = "\x1b[?2026l";
/** The synchronized frames a capture draws, each with its end marker. */
const framesOf = (raw: string) => raw.split(END).slice(0, -1).map((f) => f + END);
/** Codex 0.156.1's own folder notice frame, as it drew it. */
const NOTICE = framesOf(capture.fresh.beforeEnter).find((f) => isOpenRestrictedNotice(frameText(f)))!;
/** What it draws before the notice: its header and composer, which say nothing yet. */
const BEFORE_NOTICE = capture.fresh.beforeEnter.slice(0, capture.fresh.beforeEnter.indexOf(NOTICE));
const HIGHLIGHTED = "› 1. Open restricted";
/** The notice frame with its choices redrawn: the highlight moved to Quit. */
const quitHighlighted = NOTICE.replace(HIGHLIGHTED, "  1. Open restricted").replace("  2. Quit", "› 2. Quit");
/** Rows 9 and 10 alone redrawn, Quit highlighted: what a moved highlight draws, with no headline. */
const HIGHLIGHT_MOVED = "\x1b[?2026h\x1b[9;1H  1. Open restricted\x1b[10;1H› 2. Quit\x1b[?2026l";
/** A row redrawn over the notice that is neither a folder question nor Codex's composer. */
const OTHER_ROW = "\x1b[?2026h\x1b[5;1H  (loading)\x1b[?2026l";
/** A frame that draws nothing: a cursor moved. */
const CURSOR = "\x1b[?2026h\x1b[9;3H\x1b[?25h\x1b[?2026l";
/** Codex's header redrawn after the notice, before its composer. */
const HEADER = "\x1b[?2026h\x1b[1;1H\x1b[J\x1b[1;1H╭──╮\x1b[2;1H│ >_ OpenAI Codex (v0.156.1) │\x1b[?2026l";
const COMPOSER = "\x1b[?2026h\x1b[9;1H› Ask Codex to do anything\x1b[?2026l";

function watcher(o: { waitMs?: number } = {}) {
  const events: string[] = [];
  const n = new CodexFolderNotice({
    press: () => events.push("Enter"),
    answered: (press) => events.push(`answered ${press}`),
    asking: (why) => events.push(`asking: ${why}`),
    cleared: (by) => events.push(by === "drawn" ? "cleared" : `cleared (${by})`),
    ...o,
  });
  /** Output in chunks of `size`, so frames and escapes split anywhere. */
  const feed = (raw: string, size = 97) => {
    for (let i = 0; i < raw.length; i += size) n.output(raw.slice(i, i + size));
  };
  return { n, events, feed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex's folder notice, answered for a room launch", () => {
  it("reads Codex 0.156.1's own notice as exactly the one to answer, and nothing else it draws", () => {
    expect(frameText(NOTICE)).toContain("Folder access /Users/me/Code/app Config, hooks, and exec policies from untrusted folders stay disabled.");
    const notices = (raw: string) => framesOf(raw).filter((f) => isOpenRestrictedNotice(frameText(f))).length;
    for (const c of [capture.fresh, capture.resume]) expect([notices(c.beforeEnter), notices(c.afterEnter)]).toEqual([1, 0]);
  });

  it.each([
    ["a fresh launch", capture.fresh],
    ["a resume", capture.resume],
  ])("presses Enter once on %s's notice, only after its pane has been still, and holds until Codex draws its composer", (_, c) => {
    for (const size of [1, 7, 97, 1 << 20]) {
      vi.useFakeTimers();
      const { n, events, feed } = watcher();
      feed(c.beforeEnter, size);
      expect(n.holding()).toBe(true);
      // Codex discards what arrives as the notice is drawn
      vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS - 1);
      expect(events).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(events).toEqual(["Enter", "answered 1"]);
      expect(n.holding()).toBe(true);
      feed(c.afterEnter, size);
      expect(events).toEqual(["Enter", "answered 1", "cleared"]);
      expect(n.holding()).toBe(false);
      vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS * 2);
      expect(events).toHaveLength(3);
      vi.useRealTimers();
    }
  });

  it("doesn't take the composer Codex draws before its notice for the notice's end", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE);
    expect(frameText(BEFORE_NOTICE)).toContain("› Ask Codex to do anything");
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS - 1);
    expect(n.holding()).toBe(true);
    expect(events).toEqual([]);
  });

  it("waits for quiet again whenever the pane draws, even a frame with nothing in it", () => {
    vi.useFakeTimers();
    const { events, feed } = watcher();
    feed(BEFORE_NOTICE + NOTICE);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS - 50);
      feed(CURSOR);
    }
    expect(events).toEqual([]);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS);
    expect(events).toEqual(["Enter", "answered 1"]);
  });

  it("presses again only while nothing is drawn after an Enter and the notice is still up, at most three times, then tells the user once", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE + NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS);
    vi.advanceTimersByTime(FOLDER_NOTICE_RETRY_MS);
    // the notice drawn again (a focus change) is still the notice: the wait starts over
    feed(NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_RETRY_MS - 1);
    expect(events).toEqual(["Enter", "answered 1", "Enter", "answered 2"]);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(FOLDER_NOTICE_RETRY_MS);
    expect(events).toEqual(["Enter", "answered 1", "Enter", "answered 2", "Enter", "answered 3", `asking: its Codex didn't take Mockingbird's Enter on its folder notice (${MAX_PRESSES} tries)`]);
    vi.advanceTimersByTime(FOLDER_NOTICE_STALL_MS * 4);
    feed(NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_STALL_MS);
    expect(events.filter((e) => e === "Enter")).toHaveLength(MAX_PRESSES);
    expect(events.filter((e) => e.startsWith("asking"))).toHaveLength(1);
    // the user answers it: Codex opens, and the hold ends
    expect(n.holding()).toBe(true);
    feed(HEADER + COMPOSER);
    expect(events.at(-1)).toBe("cleared");
    expect(n.holding()).toBe(false);
  });

  it("presses nothing more once Codex draws anything but the notice after an Enter, and tells the user once if its composer never comes", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE + NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS);
    feed(HEADER);
    vi.advanceTimersByTime(FOLDER_NOTICE_STALL_MS - FOLDER_NOTICE_SETTLE_MS);
    expect(events).toEqual(["Enter", "answered 1"]);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS);
    expect(events).toEqual(["Enter", "answered 1", "asking: its Codex didn't open its folder after Mockingbird answered its folder notice"]);
    vi.advanceTimersByTime(FOLDER_NOTICE_STALL_MS * 4);
    expect(events).toHaveLength(3);
    expect(n.holding()).toBe(true);
    feed(COMPOSER);
    expect(n.holding()).toBe(false);
  });

  it.each([
    ["Quit highlighted", quitHighlighted],
    ["both choices marked", NOTICE.replace("  2. Quit", "\u203a 2. Quit")],
    ["Quit not among them", NOTICE.replace("  2. Quit", "  2. Open with full access")],
    ["no choice highlighted", NOTICE.replace(HIGHLIGHTED, "  1. Open restricted")],
    ["another headline", NOTICE.replace("Folder access", "Folder settings")],
    ["a trust question beside it", NOTICE.replace("Folder access", "Folder access \u00b7 Trust this folder?")],
    ["other rules for untrusted folders", NOTICE.replace("stay disabled.", "are enabled.")],
    ["a third choice", NOTICE.replace("  2. Quit", "  2. Quit\x1b[11;1H  3. Trust this folder")],
    ["Codex's trust prompt", NOTICE.replace("Folder access", "Trust this folder?").replace("Open restricted", "Trust and continue")],
    ["other wording", NOTICE.replace("Opening will not change saved trust.", "Opening will trust this folder.")],
    ["another key to answer it", NOTICE.replace("continue", "trust")],
  ])("never answers a folder question with %s: it's left to the user, who is told once", (_, frame) => {
    vi.useFakeTimers();
    expect(isOpenRestrictedNotice(frameText(frame))).toBe(false);
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE + frame);
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS * 2);
    feed(frame);
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS);
    expect(events).toEqual(["asking: its Codex is asking a folder question Mockingbird doesn't answer for it"]);
    expect(n.holding()).toBe(true);
  });

  it("doesn't press a notice whose highlight moved before its pane was still: it's left to the user, told at once", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE + NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS - 1);
    feed(HIGHLIGHT_MOVED);
    expect(events).toEqual(["asking: its Codex is asking a folder question Mockingbird doesn't answer for it"]);
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS * 2);
    expect(events).toHaveLength(1);
    expect(n.holding()).toBe(true);
  });

  it("doesn't press a notice something else was drawn over, and tells the user once if Codex doesn't open", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE + NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS - 1);
    feed(OTHER_ROW);
    vi.advanceTimersByTime(FOLDER_NOTICE_STALL_MS - FOLDER_NOTICE_SETTLE_MS);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS);
    expect(events).toEqual(["asking: its Codex's folder notice changed before Mockingbird answered it"]);
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS * 2);
    expect(events).toHaveLength(1);
    expect(n.holding()).toBe(true);
  });

  it("stops holding when no notice comes within its wait, and then reads nothing", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher({ waitMs: 5_000 });
    feed(BEFORE_NOTICE);
    vi.advanceTimersByTime(4_999);
    expect(n.holding()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["cleared (waited)"]);
    feed(NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_STALL_MS);
    expect(events).toEqual(["cleared (waited)"]);
  });

  it("holds past its wait once the notice is up, answered or not", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher({ waitMs: 1_000 });
    feed(BEFORE_NOTICE + NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS - 1);
    feed(OTHER_ROW);
    vi.advanceTimersByTime(5_000);
    expect(n.holding()).toBe(true);
    expect(events).toEqual([]);
  });

  it("ends its hold on its Codex's hooks once the notice was drawn (Codex fires none before it's answered), not before", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE);
    n.hookEvent();
    expect(n.holding()).toBe(true);
    feed(NOTICE);
    n.hookEvent();
    expect(events).toEqual(["cleared (hook)"]);
    vi.advanceTimersByTime(FOLDER_NOTICE_STALL_MS * 2);
    expect(events).toEqual(["cleared (hook)"]);
  });

  it("presses nothing once its pane has ended", () => {
    vi.useFakeTimers();
    const { n, events, feed } = watcher();
    feed(BEFORE_NOTICE + NOTICE);
    n.stop();
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS * 2);
    feed(NOTICE);
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS);
    expect(events).toEqual([]);
    expect(n.holding()).toBe(false);
  });
});
