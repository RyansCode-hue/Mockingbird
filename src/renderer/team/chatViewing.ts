import { isErr } from "../../shared/types";

/**
 * The rooms whose chat is on screen, by view. Every room chat view says whether it's seen (the room view, a docked
 * Chat window, a placed one on screen in the live band); main hears the union, and doesn't notify mentions in those
 * rooms while the window has focus. A view going away takes only its own room with it.
 */
const views = new Map<symbol, string>();
/**
 * The last report sent (rooms, one a line), taken or on its way; null before this page has sent any, so its first
 * always goes, and after one main didn't take, so the next goes again.
 */
let sentKey: string | null = null;
let sent = 0;

/** Tell main the rooms viewed now: when they changed since the last report, or `always`. */
function report(always: boolean): void {
  const rooms = viewedRooms();
  const key = rooms.join("\n");
  if (key === sentKey && !always) return;
  sentKey = key;
  const n = ++sent;
  const failed = (why: unknown) => {
    console.warn("[mockingbird] couldn't tell main which room chats are on screen", why);
    if (n === sent) sentKey = null;
  };
  // a handler that throws answers { error } (handlers.ts guarded), not a rejection
  Promise.resolve(window.mb.teamChatViewing(rooms)).then((r: unknown) => isErr(r) && failed(r.error), failed);
}

export function chatViewing(view: symbol, roomId: string | null): void {
  if (roomId) views.set(view, roomId);
  else views.delete(view);
  report(false);
}

/** The rooms viewed now, sorted. */
export const viewedRooms = (): string[] => [...new Set(views.values())].sort();

/**
 * The whole set, sent again as the page starts and each time the window gets focus: main forgets it when a page
 * replaces this one (forgetViewsWith), and a set it lost any other way is back as soon as it counts (a chat on screen
 * holds back its room's mentions only while the window has focus).
 */
export function reportViewing(): void {
  report(true);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // once the modules have run: window.mb is the preload's in the app, the stub's in the preview
  queueMicrotask(reportViewing);
  window.addEventListener("focus", reportViewing);
}
