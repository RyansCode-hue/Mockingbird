/**
 * The rooms whose chat is on screen, by view. Every room chat view says whether it's seen (the room view, a docked
 * Chat window, a placed one on screen in the live band); main hears the union, and doesn't notify mentions in those
 * rooms while the window has focus. A view going away takes only its own room with it.
 */
const views = new Map<symbol, string>();
let told = "";

export function chatViewing(view: symbol, roomId: string | null): void {
  if (roomId) views.set(view, roomId);
  else views.delete(view);
  const rooms = viewedRooms();
  const key = rooms.join("\n");
  if (key === told) return;
  told = key;
  Promise.resolve(window.mb.teamChatViewing(rooms)).catch((err: unknown) => console.warn("[mockingbird] couldn't tell main which room chats are on screen", err));
}

/** The rooms viewed now, sorted. */
export const viewedRooms = (): string[] => [...new Set(views.values())].sort();
